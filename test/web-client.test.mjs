import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const script = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function element() {
  return { value: '', disabled: false, textContent: '', listeners: {}, dataset: {}, classList: { add() {} },
    scrollHeight: 0, scrollTop: 0, clientHeight: 0, append() {}, replaceChildren() {}, querySelectorAll: () => [],
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
