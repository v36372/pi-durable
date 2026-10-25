import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { openAgent, context } from './agent.mjs';
import { gatewayModels } from './models.mjs';
import { authorize, readJson, submissionInput, HttpError } from './http.mjs';
import { assets, uiVersion } from './web.mjs';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = process.env.AGENT_STATE_DIR ?? join(homedir(), '.local/state/durable-agent');
const port = Number(process.env.PORT ?? 8787);
const origin = process.env.AGENT_ORIGIN ?? 'http://127.0.0.1:' + port;
let closing = false;
const agent = await openAgent({ workspace, stateDir,
  models: gatewayModels(process.env.LLM_BASE_URL, process.env.LLM_MODEL), modelId: process.env.LLM_MODEL,
  onRestart: () => shutdown(),
});
const web = join(workspace, 'web');
const server = createServer(async (request, response) => {
  const send = (status, body, type = 'application/json') => {
    response.writeHead(status, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
    response.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  try {
    authorize(request, origin);
    if (closing) throw new HttpError(503, 'Agent will resume shortly');
    const path = new URL(request.url, origin).pathname;
    if (request.method === 'GET' && assets.has(path)) {
      const [file, type] = assets.get(path);
      const content = await readFile(join(web, file), 'utf8');
      return send(200, path === '/' ? content.replace('__UI_VERSION__', await uiVersion(web, content)) : content, type);
    }
    if (request.method === 'GET' && path === '/api/state') {
      const resolved = await agent.root.agent(context);
      return send(200, { conversationId: agent.root.id, workspace, stateDir, pid: process.pid,
        model: resolved.model, tools: resolved.tools.map(tool => ({ name: tool.name, description: tool.description })),
        extensions: agent.registry.snapshot().installed().map(extension => extension.name),
        extensionError: agent.extensionError, uiVersion: await uiVersion(web),
        entries: agent.view.entries.slice(-200), hiddenEntries: Math.max(0, agent.view.entries.length - 200),
        live: agent.view.docs['pi.live'], inbox: agent.view.docs['pi.inbox'], reports: agent.reports,
        inspection: await agent.harness.inspect(context),
      });
    }
    if (request.method === 'POST') {
      const body = await readJson(request);
      if (path === '/api/input') {
        const submission = await agent.root.submit(submissionInput(body), context);
        return send(202, { id: submission.id });
      }
      if (path === '/api/stop') { await agent.root.abort(context); return send(200, { ok: true }); }
    }
    throw new HttpError(404, 'Not found');
  } catch (error) {
    if (!error.status) console.error(error);
    send(error.status ?? 500, { error: error.message });
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
