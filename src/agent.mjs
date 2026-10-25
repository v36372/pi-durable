import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { Harness, createRegistry, defineExtension, defineTool, section } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { extensionLoader } from './extensions.mjs';

export const context = BACKGROUND_CONTEXT;
const run = promisify(execFile);
const output = text => ({ output: [{ type: 'text', text }] });

export async function openAgent({ workspace, stateDir, models, modelId = 'gpt-5.5', provider = 'exe', onRestart = () => {} }) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(join(workspace, 'extensions'), { recursive: true });
  const registry = createRegistry();
  registry.install(CodingTools);
  let reload;
  let restartCall;
  const reports = [];
  const report = (error, info = {}) => {
    reports.push({ time: new Date().toISOString(), type: info.type ?? 'host_error', message: String(error.message ?? error) });
    if (reports.length > 20) reports.shift();
    console.error(info.type ?? 'host_error', error);
  };
  registry.install(defineExtension({
    name: 'host',
    sections: [section('workspace', () => workspace), section('project', () => readFile(join(workspace, 'AGENTS.md'), 'utf8'), { tag: false })],
    tools: [
      defineTool({ name: 'reload_extensions', description: 'Validate and load extensions/*.mjs. A failed batch leaves the live registry unchanged.', parameters: Type.Object({}), replay: 'safe',
        execute: async () => output(JSON.stringify(await reload())) }),
      defineTool({ name: 'restart_agent', description: 'Check source and tests, then restart this process after this tool result commits. The conversation resumes. Use after core edits, not extension-only edits.', parameters: Type.Object({}), replay: 'safe', callers: ['model'],
        execute: async (_args, api) => {
          await run('npm', ['run', 'check'], { cwd: workspace, timeout: 120000, maxBuffer: 1024 * 1024 });
          await run('npm', ['test'], { cwd: workspace, timeout: 120000, maxBuffer: 1024 * 1024 });
          restartCall = api.callId;
          return output('Checks passed. Restart requested. Continue from this conversation after restart.');
        } }),
    ],
  }));
  reload = extensionLoader(registry, join(workspace, 'extensions'));
  // A broken extension must not take the repair tools or chat offline.
  try { await reload(); } catch (error) { report(error, { type: 'extension_load' }); }
  const database = await openNodeSqliteDatabase(join(stateDir, 'session.sqlite'));
  await database.exec('PRAGMA synchronous = FULL');
  const harness = await Harness.open(await SqliteStorage.open(database), {
    models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? workspace }),
    settings: { toolExecution: 'sequential', retry: { maxRetries: 2 }, stream: { timeoutMs: 180000 } },
    onReport: report,
  }, context);
  const root = await harness.root(context, { agent: { model: { provider, modelId }, cwd: workspace, thinkingLevel: 'medium' } });
  const watch = await root.watch(context);
  let view = watch.value;
  watch.start(value => {
    view = value;
    if (restartCall && value.entries.some(entry => entry.model?.some(message => message.role === 'toolResult' && message.toolCallId === restartCall))) {
      restartCall = undefined;
      // Do not await close inside a watch callback: close waits for watch delivery.
      setImmediate(onRestart);
    }
  });
  return {
    harness, root, registry, reload, reports,
    get view() { return view; },
    async close() { await harness.close(context); await watch.stop(); },
  };
}
