import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const assets = new Map<string, readonly [string, string]>([['/', ['index.html', 'text/html']], ['/app.js', ['app.ts', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);

export async function uiVersion(directory: string, index?: string) {
  const hash = createHash('sha256');

  // Hash the exact HTML we serve, even if the file changes during this request.
  for (const [file] of assets.values()) hash.update(file).update('\0').update(
    file === 'index.html' && index !== undefined ? index : await readFile(join(directory, file)),
  );

  return hash.digest('hex');
}
