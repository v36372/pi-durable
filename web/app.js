const $ = id => document.getElementById(id);
const messages = $('messages');
const uiVersion = document.querySelector('meta[name="ui-version"]').content;
let previous = '';
let previousMeta = '';
let online = false;
let pending;
try { pending = JSON.parse(localStorage.getItem('durable-agent.pending') ?? 'null'); } catch { pending = null; }
if (pending) { $('prompt').value = pending.text; $('notice').textContent = 'An unacknowledged message remains. Send retries its original request ID.'; }
try {
  const draft = sessionStorage.getItem('durable-agent.draft');
  if (draft !== null) { $('prompt').value = draft; sessionStorage.removeItem('durable-agent.draft'); }
} catch { /* Leave the page usable when browser storage is disabled. */ }

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
// shortcut: common Markdown only, use a parser if tables or nested lists become necessary.
function inline(parent, text) {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[([^\[\]]+)\]\((https?:\/\/[^\s)]+)\))/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(text.slice(offset, match.index));
    const token = match[0];
    const element = token.startsWith('`') ? node('code', token.slice(1, -1))
      : token.startsWith('**') ? node('strong', token.slice(2, -2)) : node('a', match[2]);
    if (element.tagName === 'A') { element.href = match[3]; element.target = '_blank'; element.rel = 'noopener noreferrer'; }
    parent.append(element);
    offset = match.index + token.length;
  }
  parent.append(text.slice(offset));
}
function prose(text) {
  const root = node('div', undefined, 'prose');
  let paragraph, list, code;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) {
      if (code) code = undefined;
      else {
        const block = node('figure', undefined, 'code');
        code = node('pre', '');
        block.append(node('figcaption', line.slice(3).trim() || 'code'), code);
        root.append(block);
      }
      paragraph = list = undefined;
    } else if (code) code.textContent += line + '\n';
    else if (!line.trim()) paragraph = list = undefined;
    else if (/^#{1,6} /.test(line)) {
      const heading = node('h3');
      inline(heading, line.replace(/^#{1,6} /, ''));
      root.append(heading);
      paragraph = list = undefined;
    } else if (/^\s*(?:[-*]|\d+\.) /.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      if (!list || list.tagName !== (ordered ? 'OL' : 'UL')) {
        list = node(ordered ? 'ol' : 'ul');
        if (ordered) list.start = Number(line.match(/\d+/)[0]);
        root.append(list);
      }
      const item = node('li');
      inline(item, line.replace(/^\s*(?:[-*]|\d+\.) /, ''));
      list.append(item);
      paragraph = undefined;
    } else {
      if (!paragraph) { paragraph = node('p'); root.append(paragraph); }
      else paragraph.append('\n');
      inline(paragraph, line);
      list = undefined;
    }
  }
  return root;
}
const blocks = message => typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? [];
const outputText = message => blocks(message).map(item => item.text ?? '[image]').join('\n');
function toolView(call, result, live, busy) {
  const failed = result?.isError || live?.summary?.isError;
  const status = failed ? 'Failed' : result || live?.summary ? 'Done' : live?.status === 'running' ? 'Active' : busy ? 'Pending' : 'No result';
  const row = node('details', undefined, 'tool');
  row.dataset.key = 'tool-' + call.id;
  row.dataset.state = failed ? 'failed' : ['Active', 'Pending'].includes(status) ? 'active' : 'done';
  const summary = node('summary');
  const target = call.arguments?.path ?? call.arguments?.command ?? call.arguments?.query;
  const label = call.name + (typeof target === 'string' ? ' · ' + target.split('\n')[0] : '');
  const title = node('span', label, 'tool-label');
  title.title = label;
  summary.append(title, node('span', status, 'tool-state'));
  row.append(summary);
  if (call.arguments) row.append(node('h3', 'Input'), node('pre', JSON.stringify(call.arguments, null, 2)));
  const output = result ? outputText(result) : live?.output ?? live?.summary?.error;
  if (output !== undefined) row.append(node('h3', failed ? 'Error' : 'Output'), node('pre', output));
  return row;
}
function render(state) {
  online = true;
  const busy = Boolean(state.live?.run);
  $('status').textContent = busy ? 'Active' : 'Ready';
  $('status').dataset.state = busy ? 'active' : 'ready';
  $('stop').disabled = !busy;
  $('stop').hidden = !busy;
  const content = JSON.stringify([state.entries, state.live, state.inbox, state.hiddenEntries]);
  if (content !== previous) {
    previous = content;
    const bottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100;
    const expanded = new Set([...messages.querySelectorAll('details[open]')].map(item => item.dataset.key));
    const focus = document.activeElement?.tagName === 'SUMMARY' ? document.activeElement.parentElement.dataset.key : undefined;
    const transcript = state.entries.flatMap(entry => entry.model ?? []);
    const results = new Map(transcript.filter(message => message.role === 'toolResult').map(message => [message.toolCallId, message]));
    const liveTools = [...(state.live?.tools ?? []), ...(state.live?.nestedTools ?? [])];
    const slots = new Map(liveTools.map(tool => [tool.callId, tool]));
    const seen = new Set();
    const fragment = document.createDocumentFragment();
    let work;
    const addWork = (row, name) => {
      if (!work) {
        const group = node('details', undefined, 'work');
        group.dataset.key = 'work-' + row.dataset.key;
        const summary = node('summary');
        const body = node('div', undefined, 'work-body');
        group.append(summary, body);
        fragment.append(group);
        work = { group, summary, body, names: new Set(), count: 0, failed: 0 };
      }
      work.body.append(row);
      if (name) { work.names.add(name); work.count++; }
      if (row.dataset.state === 'failed') { work.failed++; work.group.dataset.state = 'failed'; }
      else if (row.dataset.state === 'active' && !work.failed) work.group.dataset.state = 'active';
      work.summary.textContent = work.count ? work.count + (work.count === 1 ? ' action' : ' actions') +
        (work.failed ? ' · ' + work.failed + ' failed' : '') + ' · ' + [...work.names].slice(0, 3).join(', ') : 'Thought process';
    };
    const addCall = call => {
      if (seen.has(call.id)) return;
      seen.add(call.id);
      addWork(toolView(call, results.get(call.id), slots.get(call.id), busy), call.name);
    };
    const addMessage = (message, key) => {
      if (message.role === 'toolResult') {
        if (!seen.has(message.toolCallId)) addCall({ id: message.toolCallId, name: message.toolName });
        return;
      }
      if (!['user', 'assistant'].includes(message.role)) return;
      for (const [index, item] of blocks(message).entries()) {
        if (item.type === 'text' && item.text.trim()) {
          work = undefined;
          const user = message.role === 'user';
          const article = node('article', undefined, 'message' + (user ? ' user' : ''));
          article.append(node('h2', user ? 'YOU' : 'AGENT'), user ? node('div', item.text, 'text') : prose(item.text));
          fragment.append(article);
        } else if (item.type === 'thinking' && item.thinking) {
          const row = node('details', undefined, 'tool');
          row.dataset.key = key + '-thought-' + index;
          row.append(node('summary', 'Thought process'), node('pre', item.thinking));
          addWork(row);
        } else if (item.type === 'toolCall') addCall(item);
        else if (item.type === 'image') fragment.append(node('p', 'Image attachment', 'hint'));
      }
      if (message.errorMessage) fragment.append(node('p', message.errorMessage, 'error'));
    };
    if (!transcript.some(message => message.role === 'user')) {
      const empty = node('div', undefined, 'empty');
      empty.append(node('h2', 'What do you want to change?'), node('p', 'Inspect the code. Add a tool. Build something.'));
      fragment.append(empty);
    }
    if (state.hiddenEntries) fragment.append(node('p', state.hiddenEntries + ' earlier entries omitted. SQLite retains the transcript.', 'event'));
    for (const entry of state.entries) {
      for (const [index, message] of (entry.model ?? []).entries()) addMessage(message, entry.id + '-' + index);
      if (entry.kind === 'pi.compaction') { work = undefined; fragment.append(node('p', 'Context compacted. Earlier entries remain in SQLite.', 'event')); }
    }
    if (state.live?.generation?.message) addMessage(state.live.generation.message, 'partial');
    for (const tool of liveTools) if (!seen.has(tool.callId)) addCall({ id: tool.callId, name: tool.name, arguments: tool.arguments });
    if (state.live?.generation?.retry) fragment.append(node('p', 'Model retry: ' + state.live.generation.retry.error, 'error'));
    if (busy) fragment.append(node('p', state.live?.generation?.retry ? 'Retry scheduled' : 'Agent active', 'activity'));
    messages.replaceChildren(fragment);
    for (const element of messages.querySelectorAll('details')) {
      element.open = expanded.has(element.dataset.key);
      if (focus && element.dataset.key === focus) element.querySelector('summary').focus({ preventScroll: true });
    }
    if (bottom) messages.scrollTop = messages.scrollHeight;
  }
  const metadata = JSON.stringify([state.pid, state.model, state.tools, state.extensions]);
  if (metadata !== previousMeta) {
    previousMeta = metadata;
    $('model').textContent = state.model?.modelId ?? '';
    $('runtime').replaceChildren();
    for (const [label, value] of Object.entries({ Model: state.model?.modelId, Process: state.pid, Workspace: state.workspace, State: state.stateDir })) $('runtime').append(node('dt', label), node('dd', value));
    $('tools').textContent = state.tools.map(tool => tool.name).join(' · ');
    $('tool-count').textContent = state.tools.length;
    $('extensions').textContent = state.extensions.join(' · ');
  }
  $('extension-status').textContent = state.extensionError ?? '';
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
  try {
    const state = await api('/api/state');
    if (state.uiVersion && state.uiVersion !== uiVersion && !$('send').disabled) {
      try {
        sessionStorage.setItem('durable-agent.draft', $('prompt').value);
        location.reload();
        return;
      } catch { $('notice').textContent = 'UI changed. Browser storage is unavailable. Save your draft before you refresh.'; }
    }
    render(state);
  }
  catch (error) { online = false; $('status').textContent = 'Offline'; $('status').dataset.state = 'offline'; }
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
    if ($('prompt').value.trim() === text) $('prompt').value = '';
    $('notice').textContent = '';
    messages.scrollTop = messages.scrollHeight;
  } catch (error) { $('notice').textContent = error.message + '. Send retries this request.'; }
  finally { $('send').disabled = false; }
});
$('prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('send').disabled) $('composer').requestSubmit(); }
});
$('session').addEventListener('keydown', event => {
  if (event.key === 'Escape') { $('session').open = false; $('session').querySelector('summary').focus(); }
});
$('stop').addEventListener('click', async () => {
  $('stop').disabled = true;
  try { await api('/api/stop', {}); $('notice').textContent = 'Run stopped.'; }
  catch (error) { $('notice').textContent = error.message; }
  finally { $('stop').disabled = false; }
});
poll();
