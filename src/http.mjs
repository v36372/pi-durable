export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function authorize(request, origin) {
  if (request.headers.host !== new URL(origin).host) throw new HttpError(403, 'Unrecognized host');
  if (request.headers.origin && request.headers.origin !== origin) throw new HttpError(403, 'Cross-origin request denied');
  // Links and login redirects can navigate across sites. Only the chat document gets this exception.
  const pageNavigation = request.method === 'GET' && new URL(request.url, origin).pathname === '/' &&
    request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document';
  if (request.headers['sec-fetch-site'] === 'cross-site' && !pageNavigation) throw new HttpError(403, 'Cross-site request denied');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (request.headers.origin !== origin) throw new HttpError(403, 'Origin required');
    if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new HttpError(415, 'JSON required');
  }
}

export async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) throw new HttpError(413, 'Request exceeds 64 KiB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}

export function submissionInput(body) {
  if (!body || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 32000 ||
      typeof body.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(body.requestId)) throw new HttpError(400, 'Provide text and a request ID');
  return { type: 'input', content: body.text, requestId: body.requestId };
}
