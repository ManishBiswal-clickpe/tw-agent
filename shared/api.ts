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
