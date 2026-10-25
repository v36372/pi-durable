import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const script = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function element(tag = 'div') {
  return { tagName: tag.toUpperCase(), value: '', disabled: false, open: false, children: [], listeners: {}, dataset: {},
    scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    get textContent() { return this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); },
    set textContent(value) { this.children = [String(value ?? '')]; },
    append(...children) { for (const child of children) { if (typeof child !== 'string') child.parentElement = this; this.children.push(child); } },
    replaceChildren(...children) { this.children = []; this.append(...children); },
    querySelectorAll(selector) {
      const matches = child => selector.startsWith('.') ? child.className?.split(' ').includes(selector.slice(1))
        : child.tagName === selector.split('[')[0].toUpperCase() && (!selector.includes('[open]') || child.open);
      return this.children.filter(child => typeof child !== 'string').flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0]; },
    focus() { this.focused = true; },
    addEventListener(name, callback) { this.listeners[name] = callback; } };
}
function client({ sessionStorage = storage(), localStorage = storage(), version = 'one' } = {}) {
  const nodes = new Map();
  const get = name => {
    if (!nodes.has(name)) nodes.set(name, element());
    return nodes.get(name);
  };
  const state = { entries: [], live: {}, tools: [], extensions: [], uiVersion: version };
  const calls = [];
  let reloads = 0;
  const context = { document: { getElementById: get, querySelector: () => ({ content: version }), createElement: element, createDocumentFragment: element },
    sessionStorage, localStorage, crypto: { randomUUID: () => 'test-request-id' }, setTimeout() {},
    location: { reload: () => reloads++ },
    fetch: async (path, options) => { calls.push({ path, options }); return { ok: true, json: async () => state }; },
  };
  runInNewContext(script, context);
  return { context, get, state, calls, sessionStorage, localStorage, reloads: () => reloads };
}

test('automatic UI refresh preserves drafts and unacknowledged request IDs without resubmission', async () => {
  const first = client();
  await first.context.poll();
  first.get('prompt').value = 'unsent draft';
  first.localStorage.setItem('durable-agent.pending', JSON.stringify({ text: 'uncertain input', requestId: 'original-id' }));
  first.state.uiVersion = 'two';
  await first.context.poll();
  assert.equal(first.reloads(), 1);
  const second = client({ ...first, version: 'two' });
  await second.context.poll();
  assert.equal(second.get('prompt').value, 'unsent draft');
  assert.equal(JSON.parse(second.localStorage.getItem('durable-agent.pending')).requestId, 'original-id');
  assert.equal(second.reloads(), 0);
  assert.ok([...first.calls, ...second.calls].every(call => call.options.method !== 'POST'));
});

test('a new UI version refreshes before an old document reaches the new renderer', async () => {
  const page = client();
  await page.context.poll();
  page.state.uiVersion = 'two';
  page.context.render = () => { throw new Error('Old markup lacks new elements'); };
  await page.context.poll();
  assert.equal(page.reloads(), 1);
});

test('UI refresh waits for a submit response and preserves a new draft typed meanwhile', async () => {
  const page = client();
  await page.context.poll();
  const reply = Promise.withResolvers();
  const get = page.context.fetch;
  page.context.fetch = (path, options) => options?.method === 'POST' ? reply.promise : get(path, options);
  page.get('prompt').value = 'send this';
  const submit = page.get('composer').listeners.submit({ preventDefault() {} });
  page.state.uiVersion = 'two';
  await page.context.poll();
  assert.equal(page.reloads(), 0);
  page.get('prompt').value = 'next draft';
  reply.resolve({ ok: true, json: async () => ({ id: 1 }) });
  await submit;
  await page.context.poll();
  assert.equal(page.reloads(), 1);
  assert.equal(page.sessionStorage.getItem('durable-agent.draft'), 'next draft');
  assert.equal(page.localStorage.getItem('durable-agent.pending'), null);
});

test('work groups pair tool input and output, expose failures, and omit empty agent messages', async () => {
  const page = client();
  await page.context.poll();
  page.state.entries = [
    { id: 1, model: [{ role: 'user', content: 'Check the code' }] },
    { id: 2, model: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'Inspect first' },
      { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'src/agent.mjs' } }] }] },
    { id: 3, model: [{ role: 'toolResult', toolCallId: 'read-1', toolName: 'read', content: [{ text: 'source' }] }] },
    { id: 4, model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'bash-1', name: 'bash', arguments: { command: 'npm test' } }] }] },
    { id: 5, model: [{ role: 'toolResult', toolCallId: 'bash-1', toolName: 'bash', isError: true, content: [{ text: 'Test failed' }] }] },
    { id: 6, model: [{ role: 'assistant', content: 'One test needs a fix.' }] },
  ];
  page.context.render(page.state);
  const chat = page.get('messages');
  assert.equal(chat.querySelectorAll('article').length, 2);
  const groups = chat.querySelectorAll('.work');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].open, false);
  assert.match(groups[0].querySelector('summary').textContent, /2 actions · 1 failed/);
  const calls = chat.querySelectorAll('.tool').filter(row => row.dataset.key.startsWith('tool-'));
  assert.equal(calls.length, 2);
  assert.match(calls[0].textContent, /src\/agent.mjs.*Done.*Input.*Outputsource/s);
  assert.match(calls[1].textContent, /npm test.*Failed.*Test failed/s);
  assert.equal(page.get('stop').hidden, true);
});

test('live tools keep one row and preserve disclosure state and focus', async () => {
  const page = client();
  await page.context.poll();
  page.state.entries = [{ id: 1, model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'npm test' } }] }] }];
  page.state.live = { run: {}, tools: [{ callId: 'call-1', name: 'bash', status: 'running', output: 'Partial output' }] };
  page.context.render(page.state);
  const chat = page.get('messages');
  const row = chat.querySelector('.tool');
  assert.equal(chat.querySelectorAll('.tool').length, 1);
  assert.match(row.textContent, /Active.*Partial output/s);
  assert.equal(page.get('stop').hidden, false);
  row.open = chat.querySelector('.work').open = true;
  page.context.document.activeElement = row.querySelector('summary');
  page.state.entries.push({ id: 2, model: [{ role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: [{ text: 'All tests pass' }] }] });
  page.state.live = {};
  page.context.render(page.state);
  const updated = chat.querySelector('.tool');
  assert.equal(chat.querySelectorAll('.tool').length, 1);
  assert.equal(updated.open, true);
  assert.equal(chat.querySelector('.work').open, true);
  assert.equal(updated.querySelector('summary').focused, true);
  assert.match(updated.textContent, /Done.*All tests pass/s);
  page.state.entries.shift();
  page.context.render(page.state);
  assert.match(chat.querySelector('.tool').textContent, /Done.*All tests pass/s);
});

test('assistant Markdown uses safe DOM nodes for prose, code, lists, and HTTP links', async () => {
  const page = client();
  await page.context.poll();
  const rendered = page.context.prose('## Result\n\n**Bold** and `code`\n- first\n- second\n\n3. third\n\n[safe](https://example.com) [bad](javascript:alert(1)) <img src=x onerror=alert(1)>\n\n```js\n<script>**literal**</script>\n```');
  assert.equal(rendered.querySelector('h3').textContent, 'Result');
  assert.equal(rendered.querySelector('strong').textContent, 'Bold');
  assert.equal(rendered.querySelector('code').textContent, 'code');
  assert.equal(rendered.querySelectorAll('li').length, 3);
  assert.equal(rendered.querySelector('ol').start, 3);
  assert.equal(rendered.querySelectorAll('a').length, 1);
  assert.equal(rendered.querySelector('a').href, 'https://example.com');
  assert.equal(rendered.querySelector('a').rel, 'noopener noreferrer');
  assert.equal(rendered.querySelectorAll('img').length, 0);
  assert.equal(rendered.querySelectorAll('script').length, 0);
  assert.match(rendered.querySelector('pre').textContent, /<script>\*\*literal\*\*<\/script>/);
  assert.match(rendered.textContent, /javascript:alert/);
});

test('UI refresh stops rather than losing a draft when sessionStorage fails', async () => {
  const page = client();
  await page.context.poll();
  page.get('prompt').value = 'keep this';
  page.sessionStorage.setItem = () => { throw new Error('Storage blocked'); };
  page.state.uiVersion = 'two';
  await page.context.poll();
  assert.equal(page.reloads(), 0);
  assert.equal(page.get('prompt').value, 'keep this');
  assert.match(page.get('notice').textContent, /Save your draft/);
});
