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
  connectors?: ConnectorStore;
  connectorUi?: ConnectorUI;
}
export interface AgentHandle {
  session: AgentSession;
  dispose(): Promise<void>;
}
export type AgentFactory = (config: AppConfig) => Promise<AgentHandle>;
