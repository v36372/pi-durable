import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assets, uiVersion } from '../src/web.ts';

test('UI version tracks HTML, JavaScript, and CSS without false changes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-ui-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  for (const [file] of assets.values()) await writeFile(join(directory, file), 'original');
  let version = await uiVersion(directory);
  assert.equal(await uiVersion(directory), version);

  for (const [file] of assets.values()) {
    await writeFile(join(directory, file), 'changed');
    const next = await uiVersion(directory);
    assert.notEqual(next, version);
    version = next;
  }

  await writeFile(join(directory, 'index.html'), 'changed during request');
  assert.equal(await uiVersion(directory, 'changed'), version);
  await rm(join(directory, 'app.ts'));
  await assert.rejects(uiVersion(directory), /ENOENT/);
});
