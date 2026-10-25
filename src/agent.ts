import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type, type Models } from '@earendil-works/pi-ai';
import type { AgentChange, Conversation, ConversationView, ConversationWatch, Cursor, ReportInfo, ToolExecutionResult } from '@earendil-works/pi-durable';
import { Harness, createRegistry, defineExtension, defineTool, section, hook, ToolTask } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { watchExtensions } from './extensions.ts';

export const context = BACKGROUND_CONTEXT;
const run = promisify(execFile);
const output = (text: string): ToolExecutionResult => ({ output: [{ type: 'text', text }] });

export type AgentOptions = {
  workspace: string;
  stateDir: string;
  models: Models;
  modelId?: string;
  provider?: string;
  onRestart?: () => void;
};

type Session = { conversation: Conversation; view: ConversationView; watch: ConversationWatch };

export async function openAgent({ workspace, stateDir, models, modelId = 'gpt-5.5', provider = 'exe', onRestart = () => {} }: AgentOptions) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(join(workspace, 'extensions'), { recursive: true });
  const registry = createRegistry();
  registry.install(CodingTools);
  let extensions: Awaited<ReturnType<typeof watchExtensions>>;
  let extensionError: string | undefined;
  let restartCall: string | undefined;
  const reports: { time: string; type: string; message: string }[] = [];

  const report = (cause: unknown, info?: Pick<ReportInfo, 'type'> | { type: 'extension_load' }) => {
    reports.push({ time: new Date().toISOString(), type: info?.type ?? 'host_error', message: cause instanceof Error ? cause.message : String(cause) });

    if (reports.length > 20) reports.shift();
    console.error(info?.type ?? 'host_error', cause);
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

  const defaults = { model: { provider, modelId }, cwd: workspace, thinkingLevel: 'medium' } satisfies AgentChange;
  const root = await harness.root(context, { agent: defaults });
  const conversations = new Map<string, Session>();

  async function track(conversation: Conversation) {
    const watch = await conversation.watch(context);
    const session = { conversation, view: watch.value, watch };
    conversations.set(String(conversation.id), session);
    watch.start(async value => {
      session.view = value;

      if (restartCall && value.entries.some(entry => entry.model?.some(message => message.role === 'toolResult' && message.toolCallId === restartCall))) {
        restartCall = undefined;
        // Do not await close inside a watch callback: close waits for watch delivery.
        setImmediate(onRestart);
      }
    });

    return conversation;
  }

  let cursor: Cursor | undefined;

  do {
    const page = await harness.commit(tx => tx.scanConversations({}, 100, cursor), context);

    for (const record of page.items) if (!record.owner) {
      const conversation = await harness.conversation(record.id, context);

      if (!conversation) throw new Error('Stored conversation disappeared: ' + record.id);
      await track(conversation);
    }

    cursor = page.next;
  } while (cursor);

  const rootSession = conversations.get(String(root.id));

  if (!rootSession) throw new Error('Root conversation not found');

  return {
    harness, root, registry, reports,
    get extensionError() { return extensionError; },
    get view() { return rootSession.view; },
    conversation(id: string | number = root.id) { return conversations.get(String(id)); },
    listConversations() {
      return [...conversations.values()].reverse().map(({ conversation, view }) => {
        const first = view.entries.flatMap(entry => entry.model ?? []).find(message => message.role === 'user');
        const text = Array.isArray(first?.content) ? first.content.find(block => block.type === 'text')?.text : first?.content;

        return { id: conversation.id, title: text?.slice(0, 80) || 'New conversation', busy: Boolean(view.docs['pi.live']?.run) };
      });
    },
    async createConversation(settings: AgentChange = {}) {
      return track(await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { ...defaults, ...settings } }, context));
    },
    async close() {
      await extensions.close();
      await harness.close(context);
      await Promise.all([...conversations.values()].map(session => session.watch.stop()));
    },
  };
}
