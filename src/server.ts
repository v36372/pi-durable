import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { stripTypeScriptTypes } from 'node:module';
import type { State, Responses } from './protocol.ts';
import { openAgent, context } from './agent.ts';
import { gatewayModels } from './models.ts';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';
import { authorize, readJson, submissionInput, agentSettings, conversationTarget, HttpError } from './http.ts';
import { assets, uiVersion } from './web.ts';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = process.env.AGENT_STATE_DIR ?? join(homedir(), '.local/state/durable-agent');
const port = Number(process.env.PORT ?? 8787);
const origin = process.env.AGENT_ORIGIN ?? 'http://127.0.0.1:' + port;
let closing = false;
const models = await gatewayModels(process.env.LLM_BASE_URL, process.env.LLM_MODEL);
const choices = models.getModels().map(model => ({ provider: model.provider, modelId: model.id, efforts: getSupportedThinkingLevels(model) }));

const agent = await openAgent({ workspace, stateDir,
  models, modelId: process.env.LLM_MODEL,
  onRestart: () => shutdown(),
});

const web = join(workspace, 'web');

const server = createServer(async (request, response) => {
  const send = (status: number, body: string | State | Responses[keyof Responses] | { error: string }, type = 'application/json') => {
    response.writeHead(status, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
    response.end(type === 'application/json' ? JSON.stringify(body) : String(body));
  };

  try {
    authorize(request, origin);

    if (closing) throw new HttpError(503, 'Agent will resume shortly');
    const url = new URL(request.url ?? '/', origin);
    const path = url.pathname;
    const asset = assets.get(path);

    if (request.method === 'GET' && asset) {
      const [file, type] = asset;
      const source = await readFile(join(web, file), 'utf8');
      const content = file.endsWith('.ts') ? stripTypeScriptTypes(source) : source;

      return send(200, path === '/' ? content.replace('__UI_VERSION__', await uiVersion(web, content)) : content, type);
    }

    if (request.method === 'GET' && path === '/api/state') {
      const session = agent.conversation(url.searchParams.get('conversationId') ?? undefined);

      if (!session) throw new HttpError(404, 'Conversation not found');
      const resolved = await session.conversation.agent(context);
      const view = session.view;
      // SAFETY: these named documents come from Pi Durable's committed conversation view.
      const live = view.docs['pi.live'] as State['live'];
      // SAFETY: Pi Durable owns the pi.inbox document schema and writes every committed value.
      const inbox = view.docs['pi.inbox'] as State['inbox'];

      return send(200, { conversationId: session.conversation.id, conversations: agent.listConversations(), workspace, stateDir, pid: process.pid,
        model: resolved.model, effort: resolved.thinkingLevel, models: choices,
        tools: resolved.tools.map(tool => ({ name: tool.name, description: tool.description })),
        extensions: agent.registry.snapshot().installed().map(extension => extension.name),
        extensionError: agent.extensionError, uiVersion: await uiVersion(web),
        entries: view.entries.slice(-200), hiddenEntries: Math.max(0, view.entries.length - 200),
        live, inbox, reports: agent.reports,
        inspection: await agent.harness.inspect(context),
      });
    }

    if (request.method === 'POST') {
      const body = await readJson(request);

      if (path === '/api/conversations') {
        const conversation = await agent.createConversation(agentSettings(body, choices));

        return send(201, { conversationId: conversation.id });
      }

      if (['/api/input', '/api/stop', '/api/settings'].includes(path)) {
        const session = agent.conversation(conversationTarget(body));

        if (!session) throw new HttpError(404, 'Conversation not found');

        if (path === '/api/input') {
          const submission = await session.conversation.submit(submissionInput(body), context);

          return send(202, { id: submission.id });
        }

        if (path === '/api/settings') {
          await session.conversation.configure(agentSettings(body, choices), context);
        } else await session.conversation.abort(context);

        return send(200, { ok: true });
      }
    }

    throw new HttpError(404, 'Not found');
  } catch (error) {
    if (!(error instanceof HttpError)) console.error(error);
    send(error instanceof HttpError ? error.status : 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.requestTimeout = 30000;

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ event: 'ready', origin, port, workspace, stateDir, pid: process.pid }));
  agent.harness.resume();
});

server.on('error', error => { console.error(error); process.exit(1); });

async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  const deadline = setTimeout(() => process.exit(1), 15000);

  try { await agent.close(); clearTimeout(deadline); process.exit(0); }
  catch (error) { console.error(error); process.exit(1); }
}

process.on('SIGTERM', shutdown);

process.on('SIGINT', shutdown);

agent.harness.closed.then(end => { if (end.reason === 'failed') shutdown(); });
