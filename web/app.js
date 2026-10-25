const $ = id => document.getElementById(id);
const messages = $('messages');
let previous = '';
let previousMeta = '';
let online = false;
let pending;
try { pending = JSON.parse(localStorage.getItem('durable-agent.pending') ?? 'null'); } catch { pending = null; }
if (pending) { $('prompt').value = pending.text; $('notice').textContent = 'An unacknowledged message remains. Send retries its original request ID.'; }

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function detail(title, text, key) {
  const element = node('details');
  element.dataset.key = key;
  element.append(node('summary', title), node('pre', text));
  return element;
}
function messageView(message, key) {
  const element = node('article', undefined, 'message ' + (message.role === 'user' ? 'user' : ''));
  if (message.role === 'toolResult') {
    element.append(detail((message.isError ? 'Error · ' : 'Result · ') + message.toolName,
      (message.content ?? []).map(item => item.text ?? '[image]').join('\n'), key));
    return element;
  }
  element.append(node('h3', message.role === 'user' ? 'You' : 'Agent'));
  const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? [];
  for (const [index, item] of content.entries()) {
    if (item.type === 'text') element.append(node('div', item.text, 'text'));
    if (item.type === 'thinking') element.append(detail('Reasoning', item.thinking, key + index));
    if (item.type === 'toolCall') element.append(detail('Call · ' + item.name, JSON.stringify(item.arguments, null, 2), key + index));
  }
  if (message.errorMessage) element.append(node('p', message.errorMessage, 'error'));
  return element;
}
function render(state) {
  online = true;
  const busy = Boolean(state.live?.run);
  $('status').textContent = busy ? 'Agent active' : 'Ready';
  $('stop').disabled = !busy;
  const content = JSON.stringify([state.entries, state.live, state.inbox]);
  if (content !== previous) {
    previous = content;
    const bottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100;
    const expanded = new Set([...messages.querySelectorAll('details[open]')].map(item => item.dataset.key));
    const fragment = document.createDocumentFragment();
    if (!state.entries.some(entry => entry.model?.some(message => message.role === 'user'))) fragment.append(node('p', 'Start with a small change. The agent can read its source, add a tool, and reload its extensions.', 'empty'));
    if (state.hiddenEntries) fragment.append(node('p', state.hiddenEntries + ' earlier active entries omitted from this view. SQLite retains the transcript.', 'hint'));
    for (const entry of state.entries) {
      for (const [index, message] of (entry.model ?? []).entries()) {
        if (['user', 'assistant', 'toolResult'].includes(message.role)) fragment.append(messageView(message, entry.id + '-' + index));
      }
      if (entry.kind === 'pi.compaction') fragment.append(node('p', 'Context compacted. Earlier entries remain in SQLite.', 'hint'));
    }
    if (state.live?.generation?.message) {
      const partial = messageView(state.live.generation.message, 'partial');
      partial.classList.add('live');
      fragment.append(partial);
    }
    for (const tool of [...(state.live?.tools ?? []), ...(state.live?.nestedTools ?? [])]) {
      if (tool.status !== 'done') fragment.append(detail(tool.status + ' · ' + tool.name, tool.output ?? '', 'live-' + tool.callId));
    }
    if (state.live?.generation?.retry) fragment.append(node('p', 'Model retry: ' + state.live.generation.retry.error, 'error'));
    messages.replaceChildren(fragment);
    for (const element of messages.querySelectorAll('details')) element.open = expanded.has(element.dataset.key);
    if (bottom) messages.scrollTop = messages.scrollHeight;
  }
  const metadata = JSON.stringify([state.pid, state.model, state.tools, state.extensions]);
  if (metadata !== previousMeta) {
    previousMeta = metadata;
    $('runtime').replaceChildren();
    for (const [label, value] of Object.entries({ Model: state.model?.modelId, Process: state.pid, Workspace: state.workspace, State: state.stateDir })) $('runtime').append(node('dt', label), node('dd', value));
    $('tools').replaceChildren(...state.tools.map(tool => { const item = node('div', tool.name); item.title = tool.description; return item; }));
    $('tool-count').textContent = state.tools.length;
    $('extensions').replaceChildren(...state.extensions.map(name => node('div', name)));
  }
  $('diagnostics').textContent = JSON.stringify({ reports: state.reports, inspection: state.inspection, inbox: state.inbox }, null, 2);
}
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) {
    let detail;
    try { detail = (await response.json()).error; } catch { detail = response.statusText; }
    throw new Error(detail || 'HTTP ' + response.status);
  }
  return response.json();
}
async function poll() {
  try { render(await api('/api/state')); }
  catch (error) { online = false; $('status').textContent = 'Disconnected · retry in 1 second'; }
  setTimeout(poll, 1000);
}
$('composer').addEventListener('submit', async event => {
  event.preventDefault();
  const text = $('prompt').value.trim();
  if (!text) return;
  if (!online) { $('notice').textContent = 'Wait for the connection. Your draft remains here.'; return; }
  if (!pending || pending.text !== text) pending = { text, requestId: crypto.randomUUID() };
  // Persist before POST so an uncertain response can retry without duplicate input.
  try { localStorage.setItem('durable-agent.pending', JSON.stringify(pending)); }
  catch { $('notice').textContent = 'Browser storage unavailable. Enable storage before you send.'; return; }
  $('send').disabled = true;
  try {
    await api('/api/input', pending);
    pending = null;
    localStorage.removeItem('durable-agent.pending');
    $('prompt').value = '';
    $('notice').textContent = 'Message saved.';
    messages.scrollTop = messages.scrollHeight;
  } catch (error) { $('notice').textContent = error.message + '. Send retries this request.'; }
  finally { $('send').disabled = false; }
});
$('prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('send').disabled) $('composer').requestSubmit(); }
});
for (const [id, path, done] of [['stop', '/api/stop', 'Run stopped.'], ['reload', '/api/reload', 'Extensions reloaded.']]) {
  $(id).addEventListener('click', async () => {
    $(id).disabled = true;
    try { await api(path, {}); $('notice').textContent = done; }
    catch (error) { $('notice').textContent = error.message; }
    finally { $(id).disabled = false; }
  });
}
poll();
