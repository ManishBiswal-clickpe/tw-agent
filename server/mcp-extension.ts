import { createMcpExtension } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { ConnectorStore } from "./connectors.ts";

// pi@1.4.0 defaults MCP auth/log storage to global ~/.pi even for isolated SDK sessions.
// These two classes are not re-exported at the root. Resolve relative to the installed,
// exactly pinned SDK instead of hardcoding a node_modules directory. Integration-tested.
export async function mcpExtension(
  store: ConnectorStore,
  ui?: { openUrl(url: string): void },
) {
  const root = path.dirname(
    fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
  );
  const { McpOAuthCredentialStore } = await import(
    pathToFileURL(path.join(root, "extensions/mcp/oauth.js")).href
  );
  const { FileAuthStorageBackend } = await import(
    pathToFileURL(path.join(root, "core/auth-storage.js")).href
  );
  const credentials = new McpOAuthCredentialStore(
    new FileAuthStorageBackend(path.join(store.dir, "mcp-auth.json")),
    store.dir,
  );
  return createMcpExtension({
    credentials,
    logPath: path.join(store.dir, "mcp.log"),
    loadConfig: () => store.loaded(),
    openUrl: (url) => ui?.openUrl(url),
    updateConfig: (entry, patch) => {
      void store.patch(entry, patch);
    },
  });
}
