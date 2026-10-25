import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

test('HTTP conversation creation and settings persist without changing root', { timeout: 20000 }, async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-server-'));
  const gateway = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'gpt-5.5' }, { id: 'gpt-4.1' }] }));
  });
  const gatewayPort = await listen(gateway);
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const origin = 'http://127.0.0.1:' + port;
  let child;
  let errors = '';
  async function start() {
    child = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: String(port), AGENT_ORIGIN: origin,
      AGENT_STATE_DIR: stateDir, LLM_MODEL: 'gpt-5.5', LLM_BASE_URL: 'http://127.0.0.1:' + gatewayPort + '/v1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', data => { errors += data; });
    const lines = createInterface({ input: child.stdout });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => reject(new Error('Server exited: ' + code + '\n' + errors)));
      lines.on('line', line => { if (JSON.parse(line).event === 'ready') resolve(); });
    });
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    assert.equal((await exited)[0], 0, errors);
  }
  t.after(async () => {
    await stop();
    await new Promise(resolve => gateway.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  });
  async function api(path, body, status = 200) {
    const response = await fetch(origin + path, body === undefined ? {} : { method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  await start();
  const root = await api('/api/state');
  assert.equal(root.models.length, 2);
  assert.equal(root.conversations.length, 1);
  const separate = await api('/api/conversations', { modelId: 'gpt-4.1', effort: 'off' }, 201);
  assert.notEqual(separate.conversationId, root.conversationId);
  const path = '/api/state?conversationId=' + encodeURIComponent(separate.conversationId);
  const state = await api(path);
  assert.equal(state.model.modelId, 'gpt-4.1');
  assert.equal(state.effort, 'off');
  assert.deepEqual(state.entries, []);
  await api('/api/settings', { conversationId: separate.conversationId, modelId: 'gpt-5.5', effort: 'high' });
  await api('/api/settings', { conversationId: separate.conversationId, modelId: 'gpt-4.1', effort: 'high' }, 400);
  await api('/api/conversations', { modelId: 'unknown', effort: 'high' }, 400);
  await api('/api/state?conversationId=missing', undefined, 404);
  for (const path of ['/api/input', '/api/stop', '/api/settings']) await api(path, { conversationId: 'missing' }, 404);
  const denied = await fetch(origin + '/api/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 403);
  await stop();
  await start();
  const reopened = await api(path);
  assert.equal(reopened.effort, 'high');
  assert.equal(reopened.model.modelId, 'gpt-5.5');
  assert.equal(reopened.conversations.length, 2);
  const original = await api('/api/state');
  assert.equal(original.conversationId, root.conversationId);
  assert.equal(original.effort, 'medium');
});
