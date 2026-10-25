import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createRegistry } from '@earendil-works/pi-durable';

export function extensionLoader(registry, directory) {
  const base = registry.snapshot().installed();
  let current = new Map();
  let pending = Promise.resolve();
  async function load() {
    const staged = new Map();
    const validation = createRegistry();
    for (const extension of base) validation.install(extension);
    const names = new Set(base.map(extension => extension.name));
    const tools = new Set(base.flatMap(extension => (extension.tools ?? []).map(tool => tool.name)));
    for (const file of (await readdir(directory)).filter(file => file.endsWith('.mjs')).sort()) {
      try {
        const path = join(directory, file);
        const hash = createHash('sha256').update(await readFile(path)).digest('hex');
        // shortcut: cache-bust entry modules only, restart after changes to imported helper modules.
        const extension = current.get(file)?.hash === hash ? current.get(file).extension :
          (await import(pathToFileURL(path).href + '?v=' + hash)).default;
        if (!extension || typeof extension.name !== 'string' || !extension.name.trim()) throw new Error('Export a named extension as default');
        if (names.has(extension.name)) throw new Error('Duplicate or reserved extension name: ' + extension.name);
        names.add(extension.name);
        for (const tool of extension.tools ?? []) {
          if (!tool || typeof tool.name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(tool.name) ||
              typeof tool.description !== 'string' || tool.parameters?.type !== 'object' || typeof tool.execute !== 'function') {
            throw new Error('Each tool needs a valid name, description, object schema, and execute function');
          }
          if (tools.has(tool.name)) throw new Error('Duplicate or reserved tool: ' + tool.name);
          tools.add(tool.name);
        }
        validation.install(extension);
        staged.set(file, { hash, extension });
      } catch (error) { throw new Error(file + ': ' + error.message, { cause: error }); }
    }
    // Validate the entire batch before the first publication. No await during publication.
    for (const [file, item] of current) {
      if (staged.get(file)?.extension.name !== item.extension.name) registry.uninstall(item.extension);
    }
    for (const [file, item] of staged) {
      if (current.get(file)?.extension !== item.extension) registry.install(item.extension);
    }
    current = staged;
    return [...current].map(([file, item]) => ({ file, name: item.extension.name }));
  }
  return () => {
    const result = pending.then(load);
    pending = result.catch(() => {});
    return result;
  };
}
