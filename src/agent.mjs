import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { Harness, createRegistry, defineExtension, defineTool, section, hook, ToolTask } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { watchExtensions } from './extensions.mjs';

export const context = BACKGROUND_CONTEXT;
const run = promisify(execFile);
const output = text => ({ output: [{ type: 'text', text }] });

export async function openAgent({ workspace, stateDir, models, modelId = 'gpt-5.5', provider = 'exe', onRestart = () => {} }) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(join(workspace, 'extensions'), { recursive: true });
  const registry = createRegistry();
  registry.install(CodingTools);
  let extensions;
  let extensionError;
  let restartCall;
  const reports = [];
  const report = (error, info = {}) => {
    reports.push({ time: new Date().toISOString(), type: info.type ?? 'host_error', message: String(error.message ?? error) });
    if (reports.length > 20) reports.shift();
    console.error(info.type ?? 'host_error', error);
  };
  registry.install(defineExtension({
    name: 'host',
    sections: [
      section('workspace', () => workspace),
      section('project', () => readFile(join(workspace, 'AGENTS.md'), 'utf8'), { tag: false }),
      section('extension_error', () => extensionError),
    ],
    hooks: [hook(ToolTask, { afterTool: async call => {
      // Publish edits before the next model request, not just after the watcher debounce.
      if (['write', 'edit', 'bash'].includes(call.name)) await extensions.refresh();
    } })],
    tools: [
      defineTool({ name: 'restart', description: 'Check source and tests, then restart this process after this tool result commits. The conversation resumes. Use after core edits, not extension-only edits.', parameters: Type.Object({}), replay: 'safe', callers: ['model'],
        execute: async (_args, api) => {
          await run('npm', ['run', 'check'], { cwd: workspace, timeout: 120000, maxBuffer: 1024 * 1024 });
          await run('npm', ['test'], { cwd: workspace, timeout: 120000, maxBuffer: 1024 * 1024 });
          restartCall = api.callId;
          return output('Checks passed. Restart requested. Continue from this conversation after restart.');
        } }),
    ],
  }));
  // A broken extension must not take the repair tools or chat offline.
  extensions = await watchExtensions(registry, join(workspace, 'extensions'), error => {
    extensionError = error ? 'Automatic extension reload failed. The prior registry remains active. ' + error.message : undefined;
    if (error) report(error, { type: 'extension_load' });
  });
  const database = await openNodeSqliteDatabase(join(stateDir, 'session.sqlite'));
  await database.exec('PRAGMA synchronous = FULL');
  const harness = await Harness.open(await SqliteStorage.open(database), {
    models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? workspace }),
    settings: { toolExecution: 'sequential', retry: { maxRetries: 2 }, stream: { timeoutMs: 180000 } },
    onReport: report,
  }, context);
  const defaults = { model: { provider, modelId }, cwd: workspace, thinkingLevel: 'medium' };
  const root = await harness.root(context, { agent: defaults });
  const conversations = new Map();
  async function track(conversation) {
    const watch = await conversation.watch(context);
    const session = { conversation, view: watch.value, watch };
    conversations.set(conversation.id, session);
    watch.start(value => {
      session.view = value;
      if (restartCall && value.entries.some(entry => entry.model?.some(message => message.role === 'toolResult' && message.toolCallId === restartCall))) {
        restartCall = undefined;
        // Do not await close inside a watch callback: close waits for watch delivery.
        setImmediate(onRestart);
      }
    });
    return conversation;
  }
  let cursor;
  do {
    const page = await harness.commit(tx => tx.scanConversations({}, 100, cursor), context);
    for (const record of page.items) if (!record.owner) await track(await harness.conversation(record.id, context));
    cursor = page.next;
  } while (cursor);
  return {
    harness, root, registry, reports,
    get extensionError() { return extensionError; },
    get view() { return conversations.get(root.id).view; },
    conversation(id = root.id) {
      return conversations.get(typeof id === 'string' && /^[1-9]\d*$/.test(id) ? Number(id) : id);
    },
    listConversations() {
      return [...conversations.values()].reverse().map(({ conversation, view }) => {
        const first = view.entries.flatMap(entry => entry.model ?? []).find(message => message.role === 'user');
        const text = typeof first?.content === 'string' ? first.content : first?.content?.find(block => block.type === 'text')?.text;
        return { id: conversation.id, title: text?.slice(0, 80) || 'New conversation', busy: Boolean(view.docs['pi.live']?.run) };
      });
    },
    async createConversation(settings = {}) {
      return track(await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { ...defaults, ...settings } }, context));
    },
    async close() {
      await extensions.close();
      await harness.close(context);
      await Promise.all([...conversations.values()].map(session => session.watch.stop()));
    },
  };
}
