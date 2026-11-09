import type {
  AgentSession,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { ConnectorStore } from "./connectors.ts";
export interface ConnectorUI {
  openUrl(url: string): void;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  input(
    title: string,
    placeholder?: string,
    options?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
}
export interface AppConfig {
  port: number;
  workspace: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
  contextWindow: number;
  maxTokens: number;
  allowWrites: boolean;
  modelApi: "openai-completions" | "openai-responses";
  authHeader: "bearer" | "api-key";
  apiVersion?: string;
  /** off | minimal | low | medium | high | xhigh. Non-off requests visible reasoning. */
  thinking: ThinkingSetting;
  /** Directory for folders.json and persisted chats. Unset = in-memory only (tests). */
  dataDir?: string;
  connectors?: ConnectorStore;
  connectorUi?: ConnectorUI;
}
export interface AgentHandle {
  session: AgentSession;
  dispose(): Promise<void>;
}
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export type ThinkingSetting = (typeof THINKING_LEVELS)[number];
export interface AgentOptions {
  /** Working directory for tools. Defaults to config.workspace. */
  cwd?: string;
  /** Persisted chat directory. Unset = in-memory session. */
  sessionDir?: string;
  /** Existing session file to resume. */
  sessionFile?: string;
}
export type AgentFactory = (
  config: AppConfig,
  options?: AgentOptions,
) => Promise<AgentHandle>;
