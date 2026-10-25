import type { Message, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import type { ToolSlot, NestedToolSlot } from '@earendil-works/pi-durable';
import type { State, Responses } from '../src/protocol.ts';

type Controls = {
  prompt: HTMLTextAreaElement;
  composer: HTMLFormElement;
  send: HTMLButtonElement;
  stop: HTMLButtonElement;
  'new-conversation': HTMLButtonElement;
  conversation: HTMLSelectElement;
  model: HTMLSelectElement;
  effort: HTMLSelectElement;
  session: HTMLDetailsElement;
  messages: HTMLDivElement;
  notice: HTMLParagraphElement;
  status: HTMLSpanElement;
  runtime: HTMLDListElement;
  tools: HTMLDivElement;
  extensions: HTMLDivElement;
  'extension-status': HTMLParagraphElement;
  'tool-count': HTMLSpanElement;
  diagnostics: HTMLPreElement;
};

function $<K extends keyof Controls>(id: K): Controls[K] {
  const element = document.getElementById(id);

  if (!element) throw new Error('Missing control: ' + id);

  // SAFETY: index.html defines each ID with the element type in Controls.
  return element as Controls[K];
}

type Pending = { text: string; requestId: string; conversationId?: string | number };

function isPending(value: unknown): value is Pending {
  return value !== null && typeof value === 'object' &&
    'text' in value && typeof value.text === 'string' &&
    'requestId' in value && typeof value.requestId === 'string' &&
    (!('conversationId' in value) || typeof value.conversationId === 'string' || typeof value.conversationId === 'number');
}

const messages = $('messages');
const uiVersion = document.querySelector<HTMLMetaElement>('meta[name="ui-version"]')?.content;
let previous = '';
let previousMeta = '';
let online = false;
let conversationId: string | undefined;
let currentState: State | undefined;
let changing = false;
let changingSettings = false;
let previousConversations = '';
let pending: Pending | null = null;

try {
  const stored = JSON.parse(localStorage.getItem('durable-agent.pending') ?? 'null');

  if (isPending(stored)) pending = stored;
} catch { pending = null; }

if (pending) { $('prompt').value = pending.text; $('notice').textContent = 'An unacknowledged message remains. Send retries its original request ID.'; }

try {
  conversationId = pending?.conversationId !== undefined ? String(pending.conversationId) : sessionStorage.getItem('durable-agent.conversation') ?? undefined;
  const draft = sessionStorage.getItem('durable-agent.draft');

  if (draft !== null) { $('prompt').value = draft; sessionStorage.removeItem('durable-agent.draft'); }
} catch { /* Leave the page usable when browser storage is disabled. */ }

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string | number, className?: string) {
  const element = document.createElement(tag);

  if (text !== undefined) element.textContent = String(text);

  if (className) element.className = className;

  return element;
}

// shortcut: common Markdown only, use a parser if tables or nested lists become necessary.
function inline(parent: HTMLElement, text: string) {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[([^[\]]+)\]\((https?:\/\/[^\s)]+)\))/g;
  let offset = 0;

  for (const match of text.matchAll(pattern)) {
    parent.append(text.slice(offset, match.index));
    const token = match[0];

    const element = token.startsWith('`') ? node('code', token.slice(1, -1))
      : token.startsWith('**') ? node('strong', token.slice(2, -2)) :
        Object.assign(node('a', match[2]), { href: match[3], target: '_blank', rel: 'noopener noreferrer' });

    parent.append(element);
    offset = match.index + token.length;
  }

  parent.append(text.slice(offset));
}

function prose(text: string) {
  const root = node('div', undefined, 'prose');
  let paragraph: HTMLParagraphElement | undefined;
  let list: HTMLUListElement | HTMLOListElement | undefined;
  let code: HTMLPreElement | undefined;

  for (const line of text.split('\n')) {
    if (line.startsWith('```')) {
      if (code) code = undefined;
      else {
        const block = node('figure', undefined, 'code');
        code = node('pre', '');
        block.append(node('figcaption', line.slice(3).trim() || 'code'), code);
        root.append(block);
      }

      paragraph = undefined;
      list = undefined;
    } else if (code) code.textContent += line + '\n';
    else if (!line.trim()) { paragraph = undefined; list = undefined; }
    else if (/^#{1,6} /.test(line)) {
      const heading = node('h3');
      inline(heading, line.replace(/^#{1,6} /, ''));
      root.append(heading);
      paragraph = undefined;
      list = undefined;
    } else if (/^\s*(?:[-*]|\d+\.) /.test(line)) {
      const ordered = /^\s*\d+\./.test(line);

      if (!list || list.tagName !== (ordered ? 'OL' : 'UL')) {
        list = node(ordered ? 'ol' : 'ul');

        if ('start' in list) list.start = Number(line.match(/\d+/)?.[0]);
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

const blocks = (message: Message) => Array.isArray(message.content) ? message.content : [{ type: 'text' as const, text: message.content }];
const outputText = (message: ToolResultMessage) => blocks(message).map(item => 'text' in item ? item.text : '[image]').join('\n');

type Call = Pick<ToolCall, 'id' | 'name'> & Partial<Pick<ToolCall, 'arguments'>>;

type LiveTool = ToolSlot & Partial<Pick<NestedToolSlot, 'arguments' | 'summary'>>;

function isString(value: unknown): value is string { return typeof value === 'string'; }

function toolView(call: Call, result: ToolResultMessage | undefined, live: LiveTool | undefined, busy: boolean) {
  const failed = result?.isError || live?.summary?.isError;
  const status = failed ? 'Failed' : result || live?.summary ? 'Done' : live?.status === 'running' ? 'Active' : busy ? 'Pending' : 'No result';
  const row = node('details', undefined, 'tool');
  row.dataset.key = 'tool-' + call.id;
  row.dataset.state = failed ? 'failed' : ['Active', 'Pending'].includes(status) ? 'active' : 'done';
  const summary = node('summary');
  const target = call.arguments?.path ?? call.arguments?.command ?? call.arguments?.query;
  const label = call.name + (isString(target) ? ' · ' + target.split('\n')[0] : '');
  const title = node('span', label, 'tool-label');
  title.title = label;
  summary.append(title, node('span', status, 'tool-state'));
  row.append(summary);

  if (call.arguments) row.append(node('h3', 'Input'), node('pre', JSON.stringify(call.arguments, null, 2)));
  const output = result ? outputText(result) : live?.output ?? live?.summary?.error;

  if (output !== undefined) row.append(node('h3', failed ? 'Error' : 'Output'), node('pre', output));

  return row;
}

function updateControls() {
  const locked = !online || changing || changingSettings || $('send').disabled;
  $('new-conversation').disabled = $('conversation').disabled = locked || Boolean(pending);
  $('model').disabled = $('effort').disabled = locked;
}

function efforts(modelId: string | undefined, preferred: string) {
  const levels = currentState?.models?.find(model => model.modelId === modelId)?.efforts ?? [];
  $('effort').replaceChildren(...levels.map(level => { const option = node('option', level); option.value = level;

 return option; }));
  $('effort').value = levels.find(level => level === preferred) ?? (levels.includes('medium') ? 'medium' : levels[0] ?? '');
}

function render(state: State) {
  currentState = state;

  if (state.conversationId !== undefined) conversationId = String(state.conversationId);

  if (pending && !pending.conversationId) pending.conversationId = conversationId;
  online = true;
  updateControls();
  const conversations = JSON.stringify([state.conversations, state.conversationId]);

  if (conversations !== previousConversations) {
    previousConversations = conversations;
    $('conversation').replaceChildren(...(state.conversations ?? []).map(conversation => {
      const option = node('option', (conversation.busy ? '● ' : '') + conversation.title + ' · ' + String(conversation.id));
      option.value = String(conversation.id);

      return option;
    }));
    $('conversation').value = state.conversationId === undefined ? '' : String(state.conversationId);
  }

  const busy = Boolean(state.live?.run);
  $('status').textContent = busy ? 'Active' : 'Ready';
  $('status').dataset.state = busy ? 'active' : 'ready';
  $('stop').disabled = !busy;
  $('stop').hidden = !busy;
  const content = JSON.stringify([state.conversationId, state.entries, state.live, state.inbox, state.hiddenEntries]);

  if (content !== previous) {
    previous = content;
    const bottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100;
    const expanded = new Set([...messages.querySelectorAll<HTMLDetailsElement>('details[open]')].map(item => item.dataset.key));
    const focus = document.activeElement?.tagName === 'SUMMARY' ? document.activeElement.parentElement?.dataset.key : undefined;
    const transcript = state.entries.flatMap(entry => entry.model ?? []);
    const results = new Map(transcript.filter(message => message.role === 'toolResult').map(message => [message.toolCallId, message]));
    const liveTools: LiveTool[] = [...(state.live?.tools ?? []), ...(state.live?.nestedTools ?? [])];
    const slots = new Map(liveTools.map(tool => [tool.callId, tool]));
    const seen = new Set();
    const fragment = document.createDocumentFragment();
    let work: { group: HTMLDetailsElement; summary: HTMLElement; body: HTMLDivElement; names: Set<string>; count: number; failed: number } | undefined;

    const addWork = (row: HTMLDetailsElement, name?: string) => {
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

    const addCall = (call: Call) => {
      if (seen.has(call.id)) return;
      seen.add(call.id);
      addWork(toolView(call, results.get(call.id), slots.get(call.id), busy), call.name);
    };

    const addMessage = (message: Message, key: string) => {
      if (message.role === 'toolResult') {
        if (!seen.has(message.toolCallId)) addCall({ id: message.toolCallId, name: message.toolName });

        return;
      }

      if (message.role !== 'user' && message.role !== 'assistant') return;

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

      if (message.role === 'assistant' && message.errorMessage) fragment.append(node('p', message.errorMessage, 'error'));
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

    for (const element of messages.querySelectorAll<HTMLDetailsElement>('details')) {
      element.open = expanded.has(element.dataset.key);

      if (focus && element.dataset.key === focus) element.querySelector('summary')?.focus({ preventScroll: true });
    }

    if (bottom) messages.scrollTop = messages.scrollHeight;
  }

  const metadata = JSON.stringify([state.pid, state.conversationId, state.model, state.effort, state.models, state.tools, state.extensions]);

  if (metadata !== previousMeta) {
    previousMeta = metadata;

    if (!changingSettings) {
      $('model').replaceChildren(...(state.models ?? []).map(model => { const option = node('option', model.modelId); option.value = model.modelId;

 return option; }));
      $('model').value = state.model?.modelId ?? '';
      efforts(state.model?.modelId, state.effort);
    }

    $('runtime').replaceChildren();

    for (const [label, value] of Object.entries({ Model: state.model?.modelId, Process: state.pid, Workspace: state.workspace, State: state.stateDir })) $('runtime').append(node('dt', label), node('dd', value));
    $('tools').textContent = state.tools.map(tool => tool.name).join(' · ');
    $('tool-count').textContent = String(state.tools.length);
    $('extensions').textContent = state.extensions.join(' · ');
  }

  $('extension-status').textContent = state.extensionError ?? '';
  $('diagnostics').textContent = JSON.stringify({ reports: state.reports, inspection: state.inspection, inbox: state.inbox }, null, 2);
}

type RequestBody = { conversationId?: string | number; modelId?: string; effort?: string; text?: string; requestId?: string };

async function api<P extends keyof Responses>(path: P, body?: RequestBody): Promise<Responses[P]> {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  if (!response.ok) {
    let detail;

    try { detail = (await response.json()).error; } catch { detail = response.statusText; }

    throw new Error(detail || 'HTTP ' + response.status);
  }

  return response.json();
}

async function refresh() {
  const requested = conversationId;

  try {
    const state = await api(`/api/state${requested ? '?conversationId=' + encodeURIComponent(requested) : ''}`);

    if (requested !== conversationId) return;

    if (state.uiVersion && state.uiVersion !== uiVersion && !$('send').disabled && !changing && !changingSettings) {
      try {
        sessionStorage.setItem('durable-agent.draft', $('prompt').value);
        location.reload();

        return;
      } catch { $('notice').textContent = 'UI changed. Browser storage is unavailable. Save your draft before you refresh.'; }
    }

    render(state);
  }
  catch {
    if (requested !== conversationId) return;
    online = false;
    $('status').textContent = 'Offline';
    $('status').dataset.state = 'offline';
    updateControls();
  }
}

async function poll() { await refresh(); setTimeout(poll, 1000); }

function selectConversation(id: string | number) {
  id = String(id);
  // Save both drafts before replacing the visible text or selected conversation.
  const draft = sessionStorage.getItem('durable-agent.draft.' + id) ?? '';
  sessionStorage.setItem('durable-agent.draft.' + conversationId, $('prompt').value);
  sessionStorage.setItem('durable-agent.conversation', id);
  conversationId = id;
  $('prompt').value = draft;
  online = false;
  previous = previousMeta = '';
  messages.replaceChildren();
  updateControls();
}

$('conversation').addEventListener('change', async () => {
  if (pending || changing || $('send').disabled) return;

  try { selectConversation($('conversation').value); await refresh(); }
  catch (error) { $('notice').textContent = String(error) + '. Conversation unchanged. Save your draft before you retry.'; }
});

$('new-conversation').addEventListener('click', async () => {
  if (pending || changing || $('send').disabled) return;
  changing = true;
  updateControls();

  try {
    const result = await api('/api/conversations', { modelId: $('model').value, effort: $('effort').value });
    selectConversation(result.conversationId);
    $('notice').textContent = '';
  } catch (error) { $('notice').textContent = String(error); }
  finally { changing = false; await refresh(); updateControls(); }
});

async function saveSettings() {
  changingSettings = true;
  updateControls();

  try {
    await api('/api/settings', { conversationId, modelId: $('model').value, effort: $('effort').value });
    $('notice').textContent = 'Model and effort apply to the next model request.';
  } catch (error) { $('notice').textContent = String(error); }
  finally { changingSettings = false; previousMeta = ''; await refresh(); updateControls(); }
}

$('model').addEventListener('change', () => { efforts($('model').value, $('effort').value);

 return saveSettings(); });

$('effort').addEventListener('change', saveSettings);

$('composer').addEventListener('submit', async event => {
  event.preventDefault();
  const text = $('prompt').value.trim();

  if (!text) return;

  if (!online || changing || changingSettings) { $('notice').textContent = 'Wait for the connection or settings response. Your draft remains here.';

 return; }

  if (!pending) pending = { text, requestId: crypto.randomUUID(), conversationId };

  // Persist before POST so an uncertain response can retry without duplicate input.
  try { localStorage.setItem('durable-agent.pending', JSON.stringify(pending)); }
  catch { $('notice').textContent = 'Browser storage unavailable. Enable storage before you send.';

 return; }

  $('send').disabled = true;
  updateControls();
  const sentText = pending.text;

  try {
    await api('/api/input', pending);
    pending = null;
    localStorage.removeItem('durable-agent.pending');

    if ($('prompt').value.trim() === sentText) $('prompt').value = '';
    $('notice').textContent = '';
    messages.scrollTop = messages.scrollHeight;
  } catch (error) { $('notice').textContent = String(error) + '. Send retries this request.'; }
  finally { $('send').disabled = false; updateControls(); }
});

$('prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault();

 if (!$('send').disabled) $('composer').requestSubmit(); }
});

$('session').addEventListener('keydown', event => {
  if (event.key === 'Escape') { $('session').open = false; $('session').querySelector('summary')?.focus(); }
});

$('stop').addEventListener('click', async () => {
  $('stop').disabled = true;
  const stoppedConversation = conversationId;

  try { await api('/api/stop', { conversationId: stoppedConversation });

 if (conversationId === stoppedConversation) $('notice').textContent = 'Run stopped.'; }
  catch (error) { $('notice').textContent = String(error); }
  finally { $('stop').disabled = false; }
});

poll();
