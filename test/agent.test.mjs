import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { openAgent, context } from '../src/agent.mjs';
import { gatewayModels } from '../src/models.mjs';

test('gateway uses the VM integration, not an external provider URL', async () => {
  const models = gatewayModels();
  const model = models.getModel('exe', 'gpt-5.5');
  assert.equal(model.baseUrl, 'https://llm.int.exe.xyz/v1');
  assert.equal((await models.getAuth(model)).auth.apiKey, 'implicit');
});

test('restart callback observes its committed tool result', { timeout: 15000 }, async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-restart-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, 'AGENTS.md'), 'Test restart.');
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: { check: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' } }));
  const faux = fauxProvider({ tokensPerSecond: 100000 });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('restart', {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage('After restart.'),
  ]);
  const restarted = Promise.withResolvers();
  const agent = await openAgent({ workspace, stateDir: join(workspace, 'state'), models, provider: 'faux', modelId: 'faux-1',
    onRestart: () => restarted.resolve(agent.view.entries.flatMap(entry => entry.model ?? []).find(message => message.toolName === 'restart')),
  });
  try {
    await agent.root.submit({ type: 'input', content: 'Restart once' }, context);
    const result = await restarted.promise;
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /Checks passed/);
  } finally { await agent.close(); }
});

test('an extension written by a tool is available to the very next model request', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-auto-extension-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, 'AGENTS.md'), 'Test automatic reload.');
  const faux = fauxProvider({ tokensPerSecond: 100000 });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('write', { path: 'extensions/probe.mjs', content:
      "export default {name:'probe',tools:[{name:'probe',description:'Probe',parameters:{type:'object',properties:{}},execute:async()=>({output:[{type:'text',text:'automatic'}]})}]}"
    }), { stopReason: 'toolUse' }),
    request => {
      assert.ok(request.messages.some(message => message.toolsAdded?.some(tool => tool.name === 'probe')));
      return fauxAssistantMessage(fauxToolCall('probe', {}), { stopReason: 'toolUse' });
    },
    fauxAssistantMessage('Done.'),
  ]);
  const agent = await openAgent({ workspace, stateDir: join(workspace, 'state'), models, provider: 'faux', modelId: 'faux-1' });
  try {
    const submission = await agent.root.submit({ type: 'input', content: 'Add and use a tool' }, context);
    const settled = await submission.wait(context);
    assert.equal(settled.status, 'done', JSON.stringify(settled));
    const result = agent.view.entries.flatMap(entry => entry.model ?? []).find(message => message.toolName === 'probe');
    assert.equal(result.isError, false);
    assert.equal(result.content[0].text, 'automatic');
  } finally { await agent.close(); }
});

test('coding tools work and SQLite reopens with request deduplication', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-tools-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, 'AGENTS.md'), 'Use the tools.');
  const faux = fauxProvider({ tokensPerSecond: 100000 });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('write', { path: 'proof.txt', content: 'saved' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Done.'),
  ]);
  const options = { workspace, stateDir: join(workspace, 'state'), models, provider: 'faux', modelId: 'faux-1' };
  let agent = await openAgent(options);
  try {
    const input = { type: 'input', content: 'Write proof.txt', requestId: 'same-input' };
    const submission = await agent.root.submit(input, context);
    assert.equal((await submission.wait(context)).status, 'done');
    assert.equal(await readFile(join(workspace, 'proof.txt'), 'utf8'), 'saved');
    const rootId = agent.root.id;
    const names = (await agent.root.agent(context)).tools.map(tool => tool.name);
    assert.deepEqual(names.sort(), ['read','write','edit','bash','restart'].sort());
    await agent.close();
    agent = await openAgent(options);
    assert.equal(agent.root.id, rootId);
    assert.equal((await agent.root.submit(input, context)).id, submission.id);
    assert.equal(faux.state.callCount, 2);
    assert.ok(agent.view.entries.some(entry => entry.model?.some(message => message.role === 'assistant')));
  } finally { await agent.close(); }
});
