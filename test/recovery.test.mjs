import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const fixture = new URL('./fixtures/recovery.mjs', import.meta.url);
function child(workspace, phase) {
  const process = fork(fixture, [workspace, phase], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  process.stderr.on('data', data => { if (!String(data).includes('ExperimentalWarning') && !String(data).includes('--trace-warnings')) console.error(String(data)); });
  return process;
}
for (const replay of ['safe', 'unsafe']) test('SIGKILL recovery honors ' + replay + ' replay and never repeats settled tools', { timeout: 20000 }, async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-crash-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(join(workspace, 'extensions'));
  await writeFile(join(workspace, 'AGENTS.md'), 'Test recovery.');
  await writeFile(join(workspace, 'extensions', 'recovery.mjs'), `
    import { appendFile, readFile } from 'node:fs/promises';
    const workspace = ${JSON.stringify(workspace)};
    const text = value => ({ output:[{type:'text',text:value}] });
    export default { name:'recovery', tools:[
      { name:'settled', description:'Settled effect', parameters:{type:'object',properties:{}},
        execute: async () => { await appendFile(workspace+'/settled', 'x'); return text('settled'); } },
      { name:'interrupted', description:'Interrupted effect', replay:'${replay}', parameters:{type:'object',properties:{}},
        execute: async () => {
          await appendFile(workspace+'/attempts','x');
          if ((await readFile(workspace+'/attempts','utf8')).length === 1) {
            process.send({ interrupted: true });
            await new Promise(() => {});
          }
          return text('resumed');
        } },
    ]};
  `);
  const first = child(workspace, 'start');
  t.after(() => first.kill('SIGKILL'));
  const [signal] = await once(first, 'message');
  assert.equal(signal.interrupted, true);
  const died = once(first, 'exit');
  first.kill('SIGKILL');
  assert.deepEqual(await died, [null, 'SIGKILL']);
  const second = child(workspace, 'resume');
  t.after(() => second.kill('SIGKILL'));
  const exited = once(second, 'exit');
  const [result] = await once(second, 'message');
  assert.equal(result.result.status, 'done');
  assert.equal((await exited)[0], 0);
  assert.equal(await readFile(join(workspace, 'settled'), 'utf8'), 'x');
  assert.equal(await readFile(join(workspace, 'attempts'), 'utf8'), replay === 'safe' ? 'xx' : 'x');
  const tool = result.entries.flatMap(entry => entry.model ?? []).find(message => message.role === 'toolResult' && message.toolName === 'interrupted');
  assert.equal(Boolean(tool.isError), replay === 'unsafe');
});
