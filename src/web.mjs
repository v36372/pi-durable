import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const assets = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);

export async function uiVersion(directory, index) {
  const hash = createHash('sha256');
  // Hash the exact HTML we serve, even if the file changes during this request.
  for (const [file] of assets.values()) hash.update(file).update('\0').update(
    file === 'index.html' && index !== undefined ? index : await readFile(join(directory, file)),
  );
  return hash.digest('hex');
}
