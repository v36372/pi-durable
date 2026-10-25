import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
for (const directory of ['src', 'web', 'scripts', 'extensions']) {
  for (const file of await readdir(directory)) {
    if (/\.(mjs|js)$/.test(file)) execFileSync(process.execPath, ['--check', join(directory, file)], { stdio: 'inherit' });
  }
}
console.log('Syntax checks passed.');
