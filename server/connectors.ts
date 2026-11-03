import type { McpConfigFiles } from "./mcp-config.ts";
import type { ConnectorSummary } from "../shared/api.ts";
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
export function validateConnector(input: unknown): Connector {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid connector");
  const body = input as Record<string, unknown>;
  const name = text(body.name, 64);
  if (
    !/^[a-zA-Z0-9_-]+$/.test(name) ||
    ["__proto__", "constructor", "prototype"].includes(name)
  )
    throw new Error(
      "Use letters, numbers, hyphens or underscores for the name",
    );
  const preset = text(body.preset || "custom") as Connector["preset"];
  if (!["gmail", "notion", "custom"].includes(preset))
    throw new Error("Unknown preset");
  let config: McpServerConfig;
  if (body.command) {
    if (preset === "notion") throw new Error("Notion preset uses remote HTTP");
    const local: Extract<McpServerConfig, { command: string }> = {
      exposure: "codemode",
      enabled: body.enabled !== false,
      command: text(body.command),
    };
    const args = body.args || [];
    if (!Array.isArray(args)) throw new Error("args must be an array");
    local.args = args.map((v: unknown) => text(v));
    local.env = {};
    for (const [key, value] of Object.entries(body.env || {})) {
      if (!/^[A-Z_][A-Z0-9_]*$/i.test(key))
        throw new Error("Invalid environment key");
      const v = text(value, 8192);
      if (v.startsWith("!"))
        throw new Error("Command interpolation is disabled");
      local.env[key] = v;
    }
    config = local;
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
    const remote: Extract<McpServerConfig, { url: string }> = {
      exposure: "codemode",
      enabled: body.enabled !== false,
      url: url.href,
      headers: {},
    };
    for (const [key, value] of Object.entries(body.headers || {})) {
      if (!/^[\w-]+$/.test(key)) throw new Error("Invalid header name");
      const v = text(value, 8192);
      if (v.startsWith("!"))
        throw new Error("Command interpolation is disabled");
      remote.headers![key] = v;
    }
    if (body.token)
      remote.headers!.Authorization = `Bearer ${text(body.token, 8192)}`;
    if (!remote.headers!.Authorization) {
      remote.oauth = {};
      if (body.clientId) remote.oauth.clientId = text(body.clientId);
      if (body.clientSecret) {
        remote.oauth.clientSecret = text(body.clientSecret, 8192);
        if (remote.oauth.clientSecret.startsWith("!"))
          throw new Error("Command interpolation is disabled");
      }
      if (body.callbackPort) {
        if (
          typeof body.callbackPort !== "number" ||
          !Number.isInteger(body.callbackPort) ||
          body.callbackPort < 1024 ||
          body.callbackPort > 65535
        )
          throw new Error("Invalid callback port");
        remote.oauth.callbackPort = body.callbackPort;
      }
      if (body.scope) remote.oauth.scope = text(body.scope);
      if (preset === "gmail" && !body.scope && remote.url === presets.gmail.url)
        remote.oauth.scope =
          body.readOnly === true
            ? "https://www.googleapis.com/auth/gmail.readonly"
            : "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose";
    }
    config = remote;
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
  files?: McpConfigFiles;
  policies: Record<string, { readOnly: boolean; preset: Connector["preset"] }> =
    {};
  async attachFiles(files: McpConfigFiles) {
    this.files = files;
    const global = await files.read("global");
    if (!Object.keys(global.mcpServers).length && this.entries.length)
      await this.syncGlobal();
    await this.refreshGlobal();
  }
  async refreshGlobal() {
    if (!this.files) return;
    const raw = await this.files.read("global");
    this.files.validate(raw, "global");
    this.entries = Object.entries(raw.mcpServers).map(([name, config]) => {
      const old = this.entries.find((e) => e.name === name);
      return {
        name,
        config: config as McpServerConfig,
        preset: old?.preset || "custom",
        readOnly: old?.readOnly ?? true,
      };
    });
  }
  async syncGlobal() {
    if (!this.files) return;
    const raw = await this.files.read("global");
    await this.files.write("global", {
      ...raw,
      mcpServers: Object.fromEntries(
        this.entries.map((e) => [e.name, e.config]),
      ),
    });
  }
  effectiveEntries(): Connector[] {
    if (!this.files) return this.entries;
    return this.files.loaded().servers.map((server) => {
      const metadata =
        this.policies[server.name] ||
        this.entries.find((e) => e.name === server.name);
      return {
        name: server.name,
        config: server.config,
        preset: metadata?.preset || "custom",
        readOnly: metadata?.readOnly ?? true,
      };
    });
  }
  constructor(readonly dir: string) {}
  async load() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      this.entries = JSON.parse(
        await readFile(path.join(this.dir, "connectors.json"), "utf8"),
      );
    } catch (e: unknown) {
      if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
    }
    try {
      this.policies = JSON.parse(
        await readFile(path.join(this.dir, "connector-policies.json"), "utf8"),
      );
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
    }
  }
  async save() {
    await this.syncGlobal();
    await writeFile(
      path.join(this.dir, "connector-policies.json"),
      JSON.stringify(this.policies),
      { mode: 0o600 },
    );
    const file = path.join(this.dir, "connectors.json");
    await writeFile(file + ".tmp", JSON.stringify(this.entries, null, 2), {
      mode: 0o600,
    });
    await rename(file + ".tmp", file);
  }
  async setReadOnly(name: string, readOnly: boolean) {
    const found = this.effectiveEntries().find((e) => e.name === name);
    if (!found) throw Error("Unknown connector");
    this.policies[name] = { readOnly, preset: found.preset };
    await writeFile(
      path.join(this.dir, "connector-policies.json"),
      JSON.stringify(this.policies),
      { mode: 0o600 },
    );
    const entry = this.entries.find((e) => e.name === name);
    if (entry) entry.readOnly = readOnly;
  }
  async setEnabled(name: string, enabled: boolean) {
    if (!this.files) {
      const found = this.entries.find((e) => e.name === name);
      if (found) found.config.enabled = enabled;
      await this.save();
      return;
    }
    const entry = this.files.loaded().servers.find((e) => e.name === name);
    if (!entry) throw Error("Unknown connector");
    const scope =
      entry.override || entry.scope === "project" ? "project" : "global";
    const doc = await this.files.read(scope);
    const existing = doc.mcpServers[name];
    doc.mcpServers[name] = {
      ...(existing && typeof existing === "object" ? existing : {}),
      enabled,
    };
    await this.files.write(scope, doc);
    await this.refreshGlobal();
  }
  async removeServer(name: string) {
    if (!this.files) {
      this.entries = this.entries.filter((e) => e.name !== name);
      await this.save();
      return;
    }
    const entry = this.files.loaded().servers.find((e) => e.name === name);
    if (!entry) throw Error("Unknown connector");
    const scope =
      entry.override || entry.scope === "project" ? "project" : "global";
    const doc = await this.files.read(scope);
    delete doc.mcpServers[name];
    await this.files.write(scope, doc);
    await this.refreshGlobal();
  }
  publicList(): ConnectorSummary[] {
    return this.effectiveEntries().map((e) => ({
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
    if (this.files) return this.files.loaded();
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
      if (
        [
          "read_mcp_resource",
          "list_mcp_resources",
          "list_mcp_resource_templates",
        ].includes(event.toolName)
      ) {
        const input = event.input as Record<string, unknown>;
        const server =
          typeof input.server === "string" ? input.server : undefined;
        if (
          !server ||
          !store
            .effectiveEntries()
            .some((e) => e.name === server && e.config.enabled !== false)
        )
          return {
            block: true,
            reason:
              "Select an enabled, trusted MCP server explicitly when accessing resources",
          };
      }
      const info = pi
        .getAllTools()
        .find((tool) => tool.name === event.toolName);
      if (
        !mayCallMcp(
          event.toolName,
          info?.annotations,
          store.effectiveEntries(),
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
