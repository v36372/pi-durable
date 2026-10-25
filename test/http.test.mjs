import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { authorize, readJson, submissionInput } from '../src/http.mjs';
const origin = 'https://agent.exe.xyz';
const request = (headers = {}, method = 'POST') => ({ method, headers: { host: 'agent.exe.xyz', origin, 'content-type': 'application/json', ...headers } });
test('HTTP rejects cross-origin writes, host spoofing, and non-JSON input', () => {
  assert.doesNotThrow(() => authorize(request(), origin));
  for (const headers of [{ origin: 'https://evil.test' }, { origin: undefined }, { host: 'evil.test' }, { 'content-type': 'text/plain' }, { 'sec-fetch-site': 'cross-site' }]) assert.throws(() => authorize(request(headers), origin));
  assert.throws(() => authorize(request({ origin: 'https://evil.test' }, 'GET'), origin));
});
test('body and submission validation enforce limits', async () => {
  assert.deepEqual(await readJson(Readable.from([Buffer.from('{"ok":true}')])), { ok: true });
  await assert.rejects(readJson(Readable.from([Buffer.alloc(65537)])), /64 KiB/);
  await assert.rejects(readJson(Readable.from([Buffer.from('bad')])), /Invalid JSON/);
  assert.equal(submissionInput({ text: 'hi', requestId: 'request-1' }).requestId, 'request-1');
  for (const body of [null, {}, { text: '', requestId: 'x' }, { text: 'hi', requestId: {} }, { text: 'x'.repeat(32001), requestId: 'x' }]) assert.throws(() => submissionInput(body));
});
