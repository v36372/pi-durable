import type { ModelRef, EntryRecord, LiveState, InboxState, HarnessInspection } from '@earendil-works/pi-durable';
import type { ModelChoice } from './models.ts';

export type State = {
  conversationId: number;
  conversations: { id: number; title: string; busy: boolean }[];
  workspace: string;
  stateDir: string;
  pid: number;
  model?: ModelRef;
  effort: string;
  models: ModelChoice[];
  tools: { name: string; description: string }[];
  extensions: string[];
  extensionError?: string;
  uiVersion: string;
  entries: readonly EntryRecord[];
  hiddenEntries: number;
  live?: LiveState;
  inbox?: InboxState;
  reports: { time: string; type: string; message: string }[];
  inspection: HarnessInspection;
};

export type Responses = {
  [path: `/api/state${string}`]: State;
  '/api/conversations': { conversationId: number };
  '/api/input': { id: number };
  '/api/settings': { ok: boolean };
  '/api/stop': { ok: boolean };
};
