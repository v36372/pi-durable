import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const script = stripTypeScriptTypes(await readFile(new URL('../web/app.ts', import.meta.url), 'utf8'));

function storage() {
  const values = new Map<string, string>();

  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

type TestEvent = { preventDefault(): void };

class TestElement {
  tagName: string;
  value = '';
  disabled = false;
  open = false;
  hidden = false;
  focused = false;
  start = 1;
  className = '';
  href = '';
  rel = '';
  children: (string | TestElement)[] = [];
  listeners: Record<string, (event?: TestEvent) => Promise<void> | void> = {};
  dataset: Record<string, string> = {};
  parentElement?: TestElement;
  scrollHeight = 0;
  scrollTop = 0;
  clientHeight = 0;

  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); }

  get textContent(): string { return this.children.map(child => child instanceof TestElement ? child.textContent : child).join(''); }
  set textContent(value: string) { this.children = [String(value ?? '')]; }

  append(...children: (string | TestElement)[]) {
    for (const child of children) {
      if (child instanceof TestElement) child.parentElement = this;
      this.children.push(child);
    }
  }

  replaceChildren(...children: (string | TestElement)[]) { this.children = []; this.append(...children); }

  querySelectorAll(selector: string): TestElement[] {
    const matches = (child: TestElement) => selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1))
      : child.tagName === selector.split('[')[0].toUpperCase() && (!selector.includes('[open]') || child.open);

    return this.children.values().filter(child => child instanceof TestElement).flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]).toArray();
  }

  querySelector(selector: string) {
    const found = this.querySelectorAll(selector)[0];
    assert.ok(found, 'Missing test element: ' + selector);

    return found;
  }

  focus() { this.focused = true; }

  addEventListener(name: string, callback: (event: TestEvent) => Promise<void> | void) {
    this.listeners[name] = (event = { preventDefault() {} }) => callback(event);
  }
}

const element = (tag = 'div') => new TestElement(tag);

function parse(text: string | null | undefined) {
  assert.ok(text);

  return JSON.parse(text);
}

type TestBlock = { type?: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: { path?: string; command?: string } };

type TestMessage = { role: string; content: string | TestBlock[]; toolCallId?: string; toolName?: string; isError?: boolean };

type TestState = {
  entries: { id: number; model: TestMessage[] }[];
  live: { run?: Record<string, never>; tools?: { callId: string; name: string; status: string; output: string }[] };
  tools: { name: string }[];
  extensions: string[];
  uiVersion: string;
  conversationId?: string | number;
  conversations?: { id: string | number; title: string }[];
  models?: { provider?: string; modelId: string; efforts: string[] }[];
  model: { modelId: string };
  effort: string;
};

type RequestOptions = { method?: string; body?: string };

type Reply = { ok: boolean; json(): Promise<TestState | { id: number } | { conversationId: string | number }> };

type TestDocument = {
  activeElement?: TestElement;
  getElementById(name: string): TestElement;
  querySelector(): { content: string };
  createElement: typeof element;
  createDocumentFragment: typeof element;
};

function client({ sessionStorage = storage(), localStorage = storage(), version = 'one' } = {}) {
  const nodes = new Map<string, TestElement>();

  const get = (name: string) => {
    let node = nodes.get(name);

    if (!node) { node = element(); nodes.set(name, node); }

    return node;
  };

  const state: TestState = { entries: [], live: {}, tools: [], extensions: [], uiVersion: version, model: { modelId: '' }, effort: '' };
  const calls: { path: string; options: RequestOptions }[] = [];
  let reloads = 0;

  const document: TestDocument = {
    getElementById: get, querySelector: () => ({ content: version }), createElement: element, createDocumentFragment: element,
  };

  const globals = { document,
    sessionStorage, localStorage, crypto: { randomUUID: () => 'test-request-id' }, setTimeout() {},
    location: { reload: () => reloads++ },
    fetch: async (path: string, options: RequestOptions = {}): Promise<Reply> => { calls.push({ path, options });

 return { ok: true, json: async () => state }; },
  };

  runInNewContext(script, globals);
  // SAFETY: the evaluated app.ts declares poll, render, and prose in this VM context.
  const context = globals as typeof globals & { poll(): Promise<void>; render(state: TestState): void; prose(text: string): TestElement };

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
  assert.equal(parse(second.localStorage.getItem('durable-agent.pending')).requestId, 'original-id');
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
  const reply = Promise.withResolvers<Reply>();
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
      { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'src/agent.ts' } }] }] },
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
  assert.match(calls[0].textContent, /src\/agent.ts.*Done.*Input.*Outputsource/s);
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

test('new conversations and conversation switches preserve separate drafts', async () => {
  const page = client();
  const conversations = [{ id: 'root', title: 'Original' }, { id: 'second', title: 'New conversation' }];
  const models = [{ provider: 'exe', modelId: 'gpt-5.5', efforts: ['low', 'medium', 'high'] }];
  const state = (id: string) => ({ ...page.state, conversationId: id, conversations, models, model: { modelId: 'gpt-5.5' }, effort: 'medium' });
  page.context.fetch = async (path, options) => {
    page.calls.push({ path, options: options ?? {} });

    return { ok: true, json: async () => path === '/api/conversations' ? { conversationId: 'second' }
      : state(path.includes('second') ? 'second' : 'root') };
  };

  await page.context.poll();
  page.get('prompt').value = 'original draft';
  await page.get('new-conversation').listeners.click();
  assert.equal(page.sessionStorage.getItem('durable-agent.conversation'), 'second');
  assert.equal(page.get('prompt').value, '');
  const creation = page.calls.find(call => call.path === '/api/conversations');
  assert.ok(creation);
  assert.deepEqual(parse(creation.options.body), { modelId: 'gpt-5.5', effort: 'medium' });
  page.get('prompt').value = 'separate draft';
  page.get('conversation').value = 'root';
  await page.get('conversation').listeners.change();
  assert.equal(page.get('prompt').value, 'original draft');
  page.get('conversation').value = 'second';
  await page.get('conversation').listeners.change();
  assert.equal(page.get('prompt').value, 'separate draft');
  const reopened = client({ sessionStorage: page.sessionStorage });
  await reopened.context.poll();
  assert.ok(reopened.calls.some(call => call.path === '/api/state?conversationId=second'));
});

test('numeric conversation IDs survive browser storage, selector values, and polling', async () => {
  const sessionStorage = storage();
  sessionStorage.setItem('durable-agent.conversation', '2');
  const page = client({ sessionStorage });
  Object.assign(page.state, { conversationId: 2, conversations: [{ id: 1, title: 'Original' }, { id: 2, title: 'Separate' }] });
  await page.context.poll();
  await page.context.poll();
  assert.equal(page.get('conversation').value, '2');
  const option = page.get('conversation').children[1];
  assert.ok(option instanceof TestElement);
  assert.equal(option.value, '2');
  assert.match(page.get('conversation').textContent, /Separate · 2/);
  page.get('prompt').value = 'message';
  await page.get('composer').listeners.submit({ preventDefault() {} });
  const send = page.calls.find(call => call.path === '/api/input');
  assert.ok(send);
  assert.equal(parse(send.options.body).conversationId, '2');
  assert.ok(page.calls.filter(call => call.path.startsWith('/api/state')).every(call => call.path.endsWith('conversationId=2')));
});

test('model changes select a supported effort and target the current conversation', async () => {
  const page = client();
  Object.assign(page.state, { conversationId: 'second', effort: 'high', model: { modelId: 'gpt-5.5' }, models: [
    { modelId: 'gpt-5.5', efforts: ['medium', 'high'] }, { modelId: 'gpt-4.1', efforts: ['off'] },
  ] });
  const fetch = page.context.fetch;
  page.context.fetch = async (path, options) => {
    if (path === '/api/settings') {
      const body = parse(options?.body);
      page.state.model.modelId = body.modelId;
      page.state.effort = body.effort;
    }

    return fetch(path, options);
  };

  await page.context.poll();
  assert.equal(page.get('effort').value, 'high');
  page.get('model').value = 'gpt-4.1';
  await page.get('model').listeners.change();
  assert.equal(page.get('effort').value, 'off');
  assert.equal(page.get('effort').children.length, 1);
  const settings = page.calls.find(call => call.path === '/api/settings');
  assert.ok(settings);
  assert.deepEqual(parse(settings.options.body), { conversationId: 'second', modelId: 'gpt-4.1', effort: 'off' });
  await page.get('stop').listeners.click();
  assert.equal(parse(page.calls.find(call => call.path === '/api/stop')?.options.body).conversationId, 'second');
});

test('uncertain sends retain their conversation and request ID, even after edits', async () => {
  const page = client();
  page.state.conversationId = 'second';
  await page.context.poll();
  const fetch = page.context.fetch;
  page.context.fetch = async (path, options) => {
    if (path === '/api/input') { page.calls.push({ path, options: options ?? {} }); throw new Error('Connection lost'); }

    return fetch(path, options);
  };

  page.get('prompt').value = 'original message';
  await page.get('composer').listeners.submit({ preventDefault() {} });
  const pending = parse(page.localStorage.getItem('durable-agent.pending'));
  assert.equal(pending.conversationId, 'second');
  assert.equal(page.get('new-conversation').disabled, true);
  assert.equal(page.get('conversation').disabled, true);
  page.get('prompt').value = 'next draft';
  await page.get('composer').listeners.submit({ preventDefault() {} });
  const sends = page.calls.filter(call => call.path === '/api/input').map(call => parse(call.options.body));
  assert.deepEqual(sends, [pending, pending]);
  const reopened = client({ localStorage: page.localStorage });
  await reopened.context.poll();
  assert.equal(reopened.calls[0].path, '/api/state?conversationId=second');
});

test('a stale poll cannot replace another conversation after a switch', async () => {
  const page = client();
  page.state.conversationId = 'root';
  await page.context.poll();
  const reply = Promise.withResolvers<Reply>();
  const fetch = page.context.fetch;
  page.context.fetch = path => path === '/api/state?conversationId=root' ? reply.promise : fetch(path);
  const stale = page.context.poll();
  page.state.conversationId = 'second';
  page.get('conversation').value = 'second';
  await page.get('conversation').listeners.change();
  reply.resolve({ ok: true, json: async () => ({ ...page.state, conversationId: 'root', entries: [{ id: 1, model: [{ role: 'user', content: 'Wrong transcript' }] }] }) });
  await stale;
  assert.equal(page.get('conversation').value, 'second');
  assert.ok(!page.get('messages').textContent.includes('Wrong transcript'));
});
