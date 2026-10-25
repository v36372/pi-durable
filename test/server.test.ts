import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type { JsonValue } from '@earendil-works/chord';
import { Script } from 'node:vm';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  // SAFETY: listen uses a TCP address, not a named pipe, and the listening event confirms the bind.
  return (server.address() as AddressInfo).port;
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
  let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  let errors = '';

  async function start() {
    const running = spawn(process.execPath, ['src/server.ts'], { env: { ...process.env, PORT: String(port), AGENT_ORIGIN: origin,
      AGENT_STATE_DIR: stateDir, LLM_MODEL: 'gpt-5.5', LLM_BASE_URL: 'http://127.0.0.1:' + gatewayPort + '/v1' }, stdio: ['ignore', 'pipe', 'pipe'] });

    child = running;
    running.stderr.on('data', data => { errors += data; });
    const lines = createInterface({ input: running.stdout });
    await new Promise<void>((resolve, reject) => {
      running.once('error', reject);
      running.once('exit', code => reject(new Error('Server exited: ' + code + '\n' + errors)));
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

  async function api(path: string, body?: JsonValue, status = 200) {
    const response = await fetch(origin + path, body === undefined ? {} : { method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));

    return result;
  }

  await start();
  const script = await (await fetch(origin + '/app.js')).text();
  assert.doesNotThrow(() => new Script(script));
  assert.match(script, /function render/);
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

  for (const path of ['/api/input', '/api/stop', '/api/settings']) await api(path, { conversationId: 999999 }, 404);
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
