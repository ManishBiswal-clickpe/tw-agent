import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import type {
  McpServerConfig,
  ExtensionFactory,
  McpServerEntry,
} from "@earendil-works/pi-coding-agent";

export type Connector = {
  name: string;
  preset: "gmail" | "notion" | "custom";
  config: McpServerConfig;
  readOnly: boolean;
};
export const presets = {
  gmail: {
    url: "https://gmailmcp.googleapis.com/mcp/v1",
    note: "Official Google Gmail MCP may require Developer Preview access and your own OAuth client. Use Custom MCP for an existing Gmail server. Gmail send/draft enabled by default; permission switch available.",
  },
  notion: {
    url: "https://mcp.notion.com/mcp",
    note: "Sign in to select your Notion workspace.",
  },
};
export function dataDirectory(env = process.env) {
  return path.resolve(
    env.FLASHLET_DATA_DIR || path.join(homedir(), ".flashlet"),
  );
}
function text(value: unknown, max = 2048): string {
  if (typeof value !== "string" || value.length > max || /[\r\n\0]/.test(value))
    throw new Error("Invalid text field");
  return value;
}
export function validateConnector(body: any): Connector {
  if (!body || typeof body !== "object") throw new Error("Invalid connector");
  const name = text(body.name, 64);
  if (!/^[a-zA-Z0-9_-]+$/.test(name))
    throw new Error(
      "Use letters, numbers, hyphens or underscores for the name",
    );
  const preset = body.preset || "custom";
  if (!["gmail", "notion", "custom"].includes(preset))
    throw new Error("Unknown preset");
  const config: any = { exposure: "deferred", enabled: body.enabled !== false };
  if (body.command) {
    if (preset === "notion") throw new Error("Notion preset uses remote HTTP");
    config.command = text(body.command);
    if (!Array.isArray(body.args || []))
      throw new Error("args must be an array");
    config.args = (body.args || []).map((v: unknown) => text(v));
    config.env = {};
    for (const [key, value] of Object.entries(body.env || {})) {
      if (!/^[A-Z_][A-Z0-9_]*$/i.test(key))
        throw new Error("Invalid environment key");
      const v = text(value, 8192);
      if (v.startsWith("!"))
        throw new Error("Command interpolation is disabled");
      config.env[key] = v;
    }
  } else {
    const url = new URL(
      body.url
        ? text(body.url)
        : presets[preset as keyof typeof presets]?.url || "",
    );
    if (
      url.username ||
      url.password ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        ))
    )
      throw new Error("Use HTTPS, or HTTP on loopback only");
    config.url = url.href;
    config.headers = {};
    for (const [key, value] of Object.entries(body.headers || {})) {
      if (!/^[\w-]+$/.test(key)) throw new Error("Invalid header name");
      const v = text(value, 8192);
      if (v.startsWith("!"))
        throw new Error("Command interpolation is disabled");
      config.headers[key] = v;
    }
    if (body.token)
      config.headers.Authorization = `Bearer ${text(body.token, 8192)}`;
    if (!config.headers.Authorization) {
      config.oauth = {};
      if (body.clientId) config.oauth.clientId = text(body.clientId);
      if (body.clientSecret) {
        config.oauth.clientSecret = text(body.clientSecret, 8192);
        if (config.oauth.clientSecret.startsWith("!"))
          throw new Error("Command interpolation is disabled");
      }
      if (body.callbackPort) {
        if (
          !Number.isInteger(body.callbackPort) ||
          body.callbackPort < 1024 ||
          body.callbackPort > 65535
        )
          throw new Error("Invalid callback port");
        config.oauth.callbackPort = body.callbackPort;
      }
      if (body.scope) config.oauth.scope = text(body.scope);
      if (preset === "gmail" && !body.scope && config.url === presets.gmail.url)
        config.oauth.scope =
          body.readOnly === true
            ? "https://www.googleapis.com/auth/gmail.readonly"
            : "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose";
    }
  }
  return {
    name,
    preset,
    config,
    readOnly:
      body.readOnly === undefined
        ? preset !== "gmail"
        : body.readOnly !== false,
  };
}
export class ConnectorStore {
  entries: Connector[] = [];
  constructor(readonly dir: string) {}
  async load() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      this.entries = JSON.parse(
        await readFile(path.join(this.dir, "connectors.json"), "utf8"),
      );
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  async save() {
    const file = path.join(this.dir, "connectors.json");
    await writeFile(file + ".tmp", JSON.stringify(this.entries, null, 2), {
      mode: 0o600,
    });
    await rename(file + ".tmp", file);
  }
  publicList() {
    return this.entries.map((e) => ({
      name: e.name,
      preset: e.preset,
      readOnly: e.readOnly,
      enabled: e.config.enabled !== false,
      transport: "url" in e.config ? "http" : "stdio",
      target:
        "url" in e.config ? new URL(e.config.url).origin : e.config.command,
    }));
  }
  loaded() {
    return {
      servers: this.entries.map((e) => ({
        name: e.name,
        config: e.config,
        source: path.join(this.dir, "connectors.json"),
        scope: "global" as const,
      })),
      errors: [],
    };
  }
  async patch(entry: McpServerEntry, patch: object) {
    const found = this.entries.find((e) => e.name === entry.name);
    if (found) {
      Object.assign(found.config, patch);
      await this.save();
    }
  }
}
const gmailReads = new Set([
  "get_thread",
  "list_drafts",
  "list_labels",
  "search_threads",
]);
export function mayCallMcp(
  toolName: string,
  annotations: { readOnlyHint?: boolean } | undefined,
  entries: Connector[],
  allowWrites: boolean,
) {
  if (!toolName.startsWith("mcp__")) return true;
  const connector = entries.find((e) =>
    toolName.startsWith(`mcp__${e.name.replaceAll("-", "_")}__`),
  );
  if (!connector || connector.config.enabled === false) return false;
  const tool = toolName.slice(
    `mcp__${connector.name.replaceAll("-", "_")}__`.length,
  );
  if (connector.preset === "gmail") {
    if (!connector.readOnly) return true;
    if (
      /(^|_)(send|create|draft|delete|trash|modify|label|unlabel|update|archive)(_|$)/.test(
        tool,
      ) &&
      !tool.startsWith("list_")
    )
      return false;
    return (
      gmailReads.has(tool) ||
      gmailReads.has(tool.replace(/^gmail_/, "")) ||
      annotations?.readOnlyHint === true
    );
  }
  return (
    annotations?.readOnlyHint === true || (allowWrites && !connector.readOnly)
  );
}
export function permissionExtension(
  store: ConnectorStore,
  allowWrites: boolean,
): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      const info = pi
        .getAllTools()
        .find((tool) => tool.name === event.toolName);
      if (
        !mayCallMcp(
          event.toolName,
          info?.annotations,
          store.entries,
          allowWrites,
        )
      )
        return {
          block: true,
          reason:
            "Connector policy blocked this tool. This connector is restricted. Enable its write permission (and FLASHLET_ALLOW_WRITES=true for non-Gmail connectors) to allow mutations.",
        };
    });
  };
}
