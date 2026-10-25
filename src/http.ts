import type { IncomingMessage } from 'node:http';
import type { JsonValue } from '@earendil-works/chord';
import { Type } from '@earendil-works/pi-ai';
import { Check } from 'typebox/value';
import type { ModelChoice } from './models.ts';

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function authorize(request: Pick<IncomingMessage, 'method' | 'url' | 'headers'>, origin: string) {
  if (request.headers.host !== new URL(origin).host) throw new HttpError(403, 'Unrecognized host');

  if (request.headers.origin && request.headers.origin !== origin) throw new HttpError(403, 'Cross-origin request denied');

  // Links and login redirects can navigate across sites. Only the chat document gets this exception.
  const pageNavigation = request.method === 'GET' && new URL(request.url ?? '/', origin).pathname === '/' &&
    request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document';

  if (request.headers['sec-fetch-site'] === 'cross-site' && !pageNavigation) throw new HttpError(403, 'Cross-site request denied');

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (request.headers.origin !== origin) throw new HttpError(403, 'Origin required');

    if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new HttpError(415, 'JSON required');
  }
}

export async function readJson(request: AsyncIterable<Uint8Array>): Promise<JsonValue> {
  let size = 0;
  const chunks: Uint8Array[] = [];

  for await (const chunk of request) {
    size += chunk.length;

    if (size > 65536) throw new HttpError(413, 'Request exceeds 64 KiB');
    chunks.push(chunk);
  }

  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}

const Settings = Type.Object({ modelId: Type.String(), effort: Type.String() });

const Input = Type.Object({
  text: Type.String({ minLength: 1, maxLength: 32000, pattern: '\\S' }),
  requestId: Type.String({ pattern: '^[a-zA-Z0-9-]{1,100}$' }),
});

const Target = Type.Object({ conversationId: Type.Optional(Type.Union([
  Type.Integer({ minimum: 1 }), Type.String({ pattern: '^[1-9][0-9]*$' }),
])) });

export function conversationTarget(body: JsonValue) {
  if (!Check(Target, body)) throw new HttpError(400, 'Provide a conversation ID');

  return body.conversationId;
}

export function agentSettings(body: JsonValue, choices: readonly ModelChoice[]) {
  if (!Check(Settings, body)) throw new HttpError(400, 'Choose an available model and effort');
  const model = choices.find(model => model.modelId === body.modelId);
  const effort = model?.efforts.find(effort => effort === body.effort);

  if (!model || !effort) throw new HttpError(400, 'Choose an available model and effort');

  return { model: { provider: model.provider, modelId: model.modelId }, thinkingLevel: effort };
}

export function submissionInput(body: JsonValue) {
  if (!Check(Input, body)) throw new HttpError(400, 'Provide text and a request ID');

  return { type: 'input', content: body.text, requestId: body.requestId } as const;
}
