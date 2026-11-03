export interface ToolActivity {
  id: string;
  name: string;
  args?: unknown;
  result?: unknown;
  done: boolean;
  error?: boolean;
}
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  tools: ToolActivity[];
}
export interface Task {
  id: string;
  title: string;
  messages: ChatMessage[];
  busy: boolean;
  stream?: EventSource;
  failed?: boolean;
}
export interface PublicConfig {
  modelId: string;
  endpoint: string;
  workspace: string;
  allowWrites: boolean;
  modelApi: string;
}
export interface FileEntry {
  name: string;
  path: string;
  directory: boolean;
}
export interface TaskEvents {
  run_start: Record<string, never>;
  delta: { text: string };
  tool_start: { id: string; name: string; args: unknown };
  tool_end: { id: string; name: string; error: boolean; result: unknown };
  run_error: { message: string };
  run_end: Record<string, never>;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
