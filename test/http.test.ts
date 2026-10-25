import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { authorize, readJson, submissionInput, agentSettings, HttpError } from '../src/http.ts';
import type { JsonValue } from '@earendil-works/chord';
import type { ModelChoice } from '../src/models.ts';

const origin = 'https://agent.exe.xyz';
const request = (headers = {}, method = 'POST') => ({ method, headers: { host: 'agent.exe.xyz', origin, 'content-type': 'application/json', ...headers } });

test('HTTP rejects cross-origin writes, host spoofing, and non-JSON input', () => {
  assert.doesNotThrow(() => authorize(request(), origin));

  for (const headers of [{ origin: 'https://evil.test' }, { origin: undefined }, { host: 'evil.test' }, { 'content-type': 'text/plain' }, { 'sec-fetch-site': 'cross-site' }]) assert.throws(() => authorize(request(headers), origin));
  assert.throws(() => authorize(request({ origin: 'https://evil.test' }, 'GET'), origin));
});

test('cross-site top-level page navigation works without exposing API routes', () => {
  const navigation = { method: 'GET', url: '/', headers: {
    host: 'agent.exe.xyz', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document',
  } };

  assert.doesNotThrow(() => authorize(navigation, origin));
  assert.doesNotThrow(() => authorize({ ...navigation, url: '/?from=login' }, origin));

  for (const change of [{ method: 'POST' }, { url: '/api/state' }, { url: '/app.js' }]) {
    assert.throws(() => authorize({ ...navigation, ...change }, origin));
  }

  for (const headers of [{ origin: 'https://evil.test' }, { host: 'evil.test' }, { 'sec-fetch-mode': 'cors' }, { 'sec-fetch-dest': 'iframe' }]) {
    assert.throws(() => authorize({ ...navigation, headers: { ...navigation.headers, ...headers } }, origin));
  }
});

test('model settings reject unknown models and unsupported effort levels', () => {
  const choices: ModelChoice[] = [{ provider: 'exe', modelId: 'gpt-4.1', efforts: ['off'] }];
  assert.deepEqual(agentSettings({ modelId: 'gpt-4.1', effort: 'off' }, choices), {
    model: { provider: 'exe', modelId: 'gpt-4.1' }, thinkingLevel: 'off',
  });
  const invalid: JsonValue[] = [null, {}, { modelId: 'unknown', effort: 'off' }, { modelId: 'gpt-4.1', effort: 'high' }];

  for (const body of invalid) {
    assert.throws(() => agentSettings(body, choices), error => error instanceof HttpError && error.status === 400);
  }
});

test('body and submission validation enforce limits', async () => {
  assert.deepEqual(await readJson(Readable.from([Buffer.from('{"ok":true}')])), { ok: true });
  await assert.rejects(readJson(Readable.from([Buffer.alloc(65537)])), /64 KiB/);
  await assert.rejects(readJson(Readable.from([Buffer.from('bad')])), /Invalid JSON/);
  assert.equal(submissionInput({ text: 'hi', requestId: 'request-1' }).requestId, 'request-1');
  const invalid: JsonValue[] = [null, {}, { text: '', requestId: 'x' }, { text: 'hi', requestId: {} }, { text: 'x'.repeat(32001), requestId: 'x' }];

  for (const body of invalid) assert.throws(() => submissionInput(body));
});
