export interface ConnectorSummary {
  name: string;
  preset: "gmail" | "notion" | "custom";
  readOnly: boolean;
  enabled: boolean;
  transport: "http" | "stdio";
  target: string;
}
export interface ConnectorState {
  notifications: string[];
  url: string | null;
  pendingInput: boolean;
  tools?: { name: string; readOnly: boolean }[];
}
export interface ConnectorPanelResponse extends ConnectorState {
  connectors: ConnectorSummary[];
  presets: Record<string, { url: string; note: string }>;
  busy: boolean;
}
export interface MutationResult {
  note?: string;
  saved?: boolean;
  removed?: boolean;
  started?: boolean;
  accepted?: boolean;
  cancelled?: boolean;
}

export interface McpConfigView {
  scope: "global" | "project";
  path: string;
  trusted: boolean;
  json: string;
  revision: string;
}

/** One rendered piece of an assistant turn, in stream order. */
export type ChatBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      args?: unknown;
      result?: string;
      error?: boolean;
      done: boolean;
    }
  | { type: "error"; text: string };
export interface ChatMessage {
  role: "user" | "assistant";
  blocks: ChatBlock[];
}
export interface FolderView {
  id: string;
  name: string;
  path: string;
  builtin?: boolean;
}
export interface ChatSummary {
  id: string;
  folderId: string;
  title: string;
  modified: number;
  messageCount: number;
  busy: boolean;
}
export interface Transcript {
  id: string;
  folderId: string;
  title: string;
  busy: boolean;
  thinking: string;
  messages: ChatMessage[];
  /** Replay stream events with id greater than this to catch up. */
  after: number;
}
export interface PublicConfig {
  modelId: string;
  endpoint: string;
  workspace: string;
  allowWrites: boolean;
  modelApi: string;
  thinking: string;
  persistent: boolean;
}
/** Server-sent events on /api/sessions/:id/events. */
export interface StreamEvents {
  run_start: { text: string };
  thinking: { text: string };
  delta: { text: string };
  tool_start: { id: string; name: string; args: unknown };
  tool_end: { id: string; name: string; error: boolean; result: string };
  run_error: { message: string };
  run_end: Record<string, never>;
}
