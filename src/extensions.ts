import { watch } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createRegistry, type Registry, type Extension, type ToolRegistration } from '@earendil-works/pi-durable';

function isExtension(value: unknown): value is Extension {
  return value !== null && typeof value === 'object' && 'name' in value &&
    typeof value.name === 'string' && Boolean(value.name.trim()) &&
    (!('tools' in value) || value.tools === undefined || Array.isArray(value.tools));
}

function isTool(value: unknown): value is ToolRegistration {
  return value !== null && typeof value === 'object' && 'name' in value &&
    typeof value.name === 'string' && /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(value.name) &&
    'description' in value && typeof value.description === 'string' &&
    'parameters' in value && value.parameters !== null && typeof value.parameters === 'object' &&
    'type' in value.parameters && value.parameters.type === 'object' &&
    'execute' in value && typeof value.execute === 'function';
}

const entryFile = (file: string) => /\.(ts|mjs)$/.test(file);

export async function watchExtensions(registry: Registry, directory: string, onStatus: (error?: Error) => void) {
  const reload = extensionLoader(registry, directory);
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = Promise.resolve();

  const refresh = () => {
    if (closed) return pending;
    pending = reload().then(() => onStatus(), onStatus);

    return pending;
  };

  const watcher = watch(directory, { persistent: false }, (_event, file) => {
    if (file && !entryFile(file)) return;
    clearTimeout(timer);
    timer = setTimeout(refresh, 150);
  });

  watcher.on('error', onStatus);
  await refresh();

  return {
    refresh,
    async close() { closed = true; watcher.close(); clearTimeout(timer); await pending; },
  };
}

export function extensionLoader(registry: Registry, directory: string) {
  const base = registry.snapshot().installed();
  let current = new Map<string, { hash: string; extension: Extension }>();
  let pending = Promise.resolve();

  async function load() {
    const staged = new Map<string, { hash: string; extension: Extension }>();
    const validation = createRegistry();

    for (const extension of base) validation.install(extension);
    const names = new Set(base.map(extension => extension.name));
    const tools = new Set(base.flatMap(extension => (extension.tools ?? []).map(tool => tool.name)));

    for (const file of (await readdir(directory)).filter(entryFile).sort()) {
      try {
        const path = join(directory, file);
        const hash = createHash('sha256').update(await readFile(path)).digest('hex');
        // shortcut: cache-bust entry modules only, restart after changes to imported helper modules.
        const cached = current.get(file);

        const extension = cached?.hash === hash ? cached.extension :
          (await import(pathToFileURL(path).href + '?v=' + hash)).default;

        if (!isExtension(extension)) throw new Error('Export a named extension as default');

        if (names.has(extension.name)) throw new Error('Duplicate or reserved extension name: ' + extension.name);
        names.add(extension.name);

        for (const tool of extension.tools ?? []) {
          if (!isTool(tool)) {
            throw new Error('Each tool needs a valid name, description, object schema, and execute function');
          }

          if (tools.has(tool.name)) throw new Error('Duplicate or reserved tool: ' + tool.name);
          tools.add(tool.name);
        }

        validation.install(extension);
        staged.set(file, { hash, extension });
      } catch (cause) { throw new Error(file + ': ' + (cause instanceof Error ? cause.message : String(cause)), { cause }); }
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
    pending = result.then(() => {}, () => {});

    return result;
  };
}
