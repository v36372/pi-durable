import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRegistry, defineExtension, type ToolRegistration } from '@earendil-works/pi-durable';
import { extensionLoader } from '../src/extensions.ts';

type EchoTool = ToolRegistration & { execute(): Promise<{ output: [{ type: 'text'; text: string }] }> };

const source = (name: string, value: string) => `const text: string = '${value}'; export default {name: '${name}', tools: [{name:'echo', description:'Echo', parameters:{type:'object',properties:{}}, execute:async()=>({output:[{type:'text',text}]})}]};`;

test('extension reload replaces code, retains the live batch on error, and removes deleted files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-extensions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = createRegistry<EchoTool>();
  registry.install(defineExtension({ name: 'host' }));
  const reload = extensionLoader(registry, directory);
  const file = join(directory, 'echo.ts');
  await writeFile(file, source('echo-extension', 'one'));
  await reload();
  const first = registry.snapshot().extension('echo-extension');
  assert.ok(first?.tools);
  assert.equal((await first.tools[0].execute()).output[0].text, 'one');
  await writeFile(file, source('echo-extension', 'two'));
  await reload();
  const second = registry.snapshot().extension('echo-extension');
  assert.ok(second?.tools);
  assert.notEqual(second, first);
  assert.equal((await second.tools[0].execute()).output[0].text, 'two');
  await writeFile(join(directory, 'broken.ts'), 'invalid syntax !!!');
  await assert.rejects(reload(), /broken.ts/);
  assert.equal(registry.snapshot().extension('echo-extension'), second);
  await writeFile(join(directory, 'broken.ts'), source('host', 'bad'));
  await assert.rejects(reload(), /reserved extension/);
  await writeFile(join(directory, 'broken.ts'), "export default {name:'broken', tools:[{name:'oops'}]}");
  await assert.rejects(reload(), /execute function/);
  assert.equal(registry.snapshot().extension('echo-extension'), second);
  await rm(join(directory, 'broken.ts'));
  await rm(file);
  await reload();
  assert.equal(registry.snapshot().extension('echo-extension'), undefined);
  assert.ok(registry.snapshot().extension('host'));
  await writeFile(join(directory, 'legacy.mjs'), "export default {name:'legacy'}");
  await reload();
  assert.ok(registry.snapshot().extension('legacy'));
});
