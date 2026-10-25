import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRegistry, type ToolRegistration } from '@earendil-works/pi-durable';
import { watchExtensions } from '../src/extensions.ts';

type EchoTool = ToolRegistration & { execute(): Promise<{ output: [{ type: 'text'; text: string }] }> };

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;

  while (!check()) {
    assert.ok(Date.now() < deadline, 'Watcher update timed out');
    await delay(20);
  }
}

test('file saves reload automatically, invalid saves retain old code, and close stops the watcher', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-watch-'));
  const registry = createRegistry<EchoTool>();
  const statuses: (Error | undefined)[] = [];
  const watcher = await watchExtensions(registry, directory, error => statuses.push(error));
  const file = join(directory, 'echo.ts');
  const source = (value: string) => `export default {name:'echo', tools:[{name:'echo', description:'Echo', parameters:{type:'object',properties:{}}, execute:async()=>({output:[{type:'text',text:'${value}'}]})}]};`;
  const current = () => registry.snapshot().extension('echo');

  try {
    await writeFile(file, source('one'));
    await until(() => Boolean(current()));
    const first = current();
    await writeFile(file + '.tmp', source('two'));
    await rename(file + '.tmp', file);
    await until(() => current() !== first);
    const second = current();
    assert.ok(second?.tools);
    assert.equal((await second.tools[0].execute()).output[0].text, 'two');
    await writeFile(file, 'invalid syntax !!!');
    await until(() => statuses.at(-1) instanceof Error);
    assert.equal(current(), second);
    await writeFile(file, source('three'));
    await until(() => current() !== second && statuses.at(-1) === undefined);
    const third = current();
    assert.ok(third?.tools);
    assert.equal((await third.tools[0].execute()).output[0].text, 'three');
    await rm(file);
    await until(() => current() === undefined);
    await watcher.close();
    await writeFile(file, source('closed'));
    await delay(300);
    assert.equal(current(), undefined);
  } finally { await watcher.close(); await rm(directory, { recursive: true, force: true }); }
});
