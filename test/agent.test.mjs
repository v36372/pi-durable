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
    assert.deepEqual(names.sort(), ['read','write','edit','bash','reload_extensions','restart_agent'].sort());
    await agent.close();
    agent = await openAgent(options);
    assert.equal(agent.root.id, rootId);
    assert.equal((await agent.root.submit(input, context)).id, submission.id);
    assert.equal(faux.state.callCount, 2);
    assert.ok(agent.view.entries.some(entry => entry.model?.some(message => message.role === 'assistant')));
  } finally { await agent.close(); }
});
