import { readFileSync, lstatSync } from "node:fs";
import {
  ProjectTrustStore,
  type LoadedMcpConfig,
  type McpServerConfig,
} from "@earendil-works/pi-coding-agent";
import { readFile, mkdir, writeFile, rename, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
export type ConfigScope = "global" | "project";
export interface McpDocument {
  mcpServers: Record<string, unknown>;
  autoEnableCodemode?: boolean;
}
const MASK = "__FLASHLET_SECRET_UNCHANGED__";
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function mapSecrets(
  doc: McpDocument,
  transform: (value: string) => string,
): McpDocument {
  const result = structuredClone(doc);
  for (const raw of Object.values(result.mcpServers)) {
    if (!object(raw)) continue;
    if (typeof raw.url === "string") {
      try {
        const u = new URL(raw.url);
        if (u.username || u.password || u.search) raw.url = transform(raw.url);
      } catch {
        /* validator handles malformed URLs */
      }
    }
    for (const field of ["headers", "env"])
      if (object(raw[field]))
        for (const [k, v] of Object.entries(raw[field]))
          if (typeof v === "string") raw[field][k] = transform(v);
    if (object(raw.oauth) && typeof raw.oauth.clientSecret === "string")
      raw.oauth.clientSecret = transform(raw.oauth.clientSecret);
    // Command arguments may embed tokens. Mask all arguments unless they are env references.
    if (Array.isArray(raw.args))
      raw.args = raw.args.map((v) =>
        typeof v === "string" ? transform(v) : v,
      );
  }
  return result;
}
function restoreMasked(incoming: unknown, original: unknown): unknown {
  if (incoming === MASK) {
    if (original === undefined)
      throw Error("A masked value has no saved original");
    return original;
  }
  if (Array.isArray(incoming))
    return incoming.map((v, i) =>
      restoreMasked(v, Array.isArray(original) ? original[i] : undefined),
    );
  if (object(incoming))
    return Object.fromEntries(
      Object.entries(incoming).map(([k, v]) => [
        k,
        restoreMasked(v, object(original) ? original[k] : undefined),
      ]),
    );
  return incoming;
}
export class McpConfigFiles {
  readonly trust: ProjectTrustStore;
  private loadNative!: (options: {
    agentDir: string;
    cwd: string;
    projectTrusted: boolean;
  }) => LoadedMcpConfig;
  private validateNative!: (
    name: string,
    raw: unknown,
  ) => McpServerConfig | string;
  constructor(
    readonly dir: string,
    readonly workspace: string,
  ) {
    this.trust = new ProjectTrustStore(dir);
  }
  async initialize() {
    const root = path.dirname(
      fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
    );
    const loader = await import(
      pathToFileURL(path.join(root, "extensions/mcp/config.js")).href
    );
    const validator = await import(
      pathToFileURL(path.join(root, "core/mcp-servers.js")).href
    );
    this.loadNative = loader.loadMcpConfig;
    this.validateNative = validator.validateMcpServerConfig;
  }
  path(scope: ConfigScope) {
    return scope === "global"
      ? path.join(this.dir, "mcp.json")
      : path.join(this.workspace, ".pi", "mcp.json");
  }
  trusted() {
    return this.trust.get(this.workspace) === true;
  }
  loaded(): LoadedMcpConfig {
    try {
      for (const scope of this.trusted()
        ? (["global", "project"] as const)
        : (["global"] as const)) {
        const file = this.path(scope);
        try {
          if (
            lstatSync(path.dirname(file)).isSymbolicLink() ||
            lstatSync(file).isSymbolicLink()
          )
            throw Error("Config symlinks are not allowed");
          this.validate(this.parse(readFileSync(file, "utf8")), scope);
        } catch (e) {
          if (!(e instanceof Error && "code" in e && e.code === "ENOENT"))
            throw e;
        }
      }
      return this.loadNative({
        agentDir: this.dir,
        cwd: this.workspace,
        projectTrusted: this.trusted(),
      });
    } catch (e) {
      return {
        servers: [],
        errors: [e instanceof Error ? e.message : "Invalid MCP config"],
      };
    }
  }
  async safePath(scope: ConfigScope) {
    const file = this.path(scope),
      parent = path.dirname(file);
    // A repository-controlled .pi symlink must not redirect editor reads/writes outside the workspace.
    try {
      const info = await lstat(parent);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw Error("Config directory cannot be a symlink");
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
    }
    try {
      if ((await lstat(file)).isSymbolicLink())
        throw Error("Config file cannot be a symlink");
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
    }
    return file;
  }
  async read(scope: ConfigScope): Promise<McpDocument> {
    const file = await this.safePath(scope);
    try {
      return this.parse(await readFile(file, "utf8"));
    } catch (e) {
      if (e instanceof Error && "code" in e && e.code === "ENOENT")
        return { mcpServers: {} };
      throw e;
    }
  }
  parse(text: string): McpDocument {
    if (text.length > 100000) throw Error("mcp.json must be under 100 KB");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new SyntaxError("Invalid JSON in mcp.json");
    }
    if (!object(parsed) || !object(parsed.mcpServers))
      throw Error("Expected an object with mcpServers");
    return parsed as unknown as McpDocument;
  }
  async view(scope: ConfigScope) {
    const document = await this.read(scope);
    const json = JSON.stringify(
      mapSecrets(document, (v) =>
        /^(Bearer )?\$\{[A-Z_][A-Z0-9_]*\}$/.test(v) ? v : MASK,
      ),
      null,
      2,
    );
    return {
      scope,
      path: this.path(scope),
      trusted: this.trusted(),
      json,
      revision: this.revision(document),
    };
  }
  revision(doc: McpDocument) {
    return createHash("sha256").update(JSON.stringify(doc)).digest("hex");
  }
  validate(doc: McpDocument, scope: ConfigScope) {
    const names = new Set<string>();
    if (
      doc.autoEnableCodemode !== undefined &&
      typeof doc.autoEnableCodemode !== "boolean"
    )
      throw Error("autoEnableCodemode must be boolean");
    for (const [name, raw] of Object.entries(doc.mcpServers)) {
      if (
        !/^[a-zA-Z0-9_-]+$/.test(name) ||
        ["__proto__", "constructor", "prototype"].includes(name) ||
        names.has(name.replaceAll("-", "_"))
      )
        throw Error("Invalid or colliding server name");
      names.add(name.replaceAll("-", "_"));
      if (!object(raw)) throw Error(`Invalid config for ${name}`);
      const override =
        scope === "project" && !raw.command && !raw.url && !raw.type;
      if (override) {
        if (
          Object.keys(raw).some(
            (k) => !["enabled", "exposure", "toolExposure"].includes(k),
          )
        )
          throw Error(
            "Project overrides only allow enabled, exposure, toolExposure",
          );
      }
      const checked = this.validateNative(
        name,
        override ? { url: "https://placeholder.invalid/mcp", ...raw } : raw,
      );
      if (typeof checked === "string") throw Error(`${name}: ${checked}`);
      if (raw.auth)
        throw Error(
          "Provider credential forwarding is disabled; use MCP OAuth or explicit environment headers",
        );
      mapSecrets({ mcpServers: { [name]: raw } }, (v) => {
        if (v.startsWith("!")) throw Error("Command interpolation is disabled");
        return v;
      });
      if ("url" in checked) {
        const u = new URL(checked.url);
        if (u.username || u.password || u.search || u.hash)
          throw Error(
            "MCP URLs must not contain credentials, query or fragment",
          );
        if (
          u.protocol !== "https:" &&
          !(
            u.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
          )
        )
          throw Error("Use HTTPS or loopback HTTP");
      }
      // Project files can be committed: secret-bearing fields must reference environment variables.
      if (scope === "project") {
        for (const field of ["headers", "env"])
          if (object(raw[field]))
            for (const value of Object.values(raw[field]))
              if (typeof value === "string" && !value.includes("${"))
                throw Error(
                  "Use environment references for project headers/env; keep literals in global config",
                );
        if (
          object(raw.oauth) &&
          raw.oauth.clientSecret &&
          !String(raw.oauth.clientSecret).includes("${")
        )
          throw Error("Project client secrets must use environment references");
      }
    }
  }
  async write(scope: ConfigScope, doc: McpDocument) {
    this.validate(doc, scope);
    const file = await this.safePath(scope);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = file + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(doc, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, file);
  }
  async saveEditor(scope: ConfigScope, json: string, revision: string) {
    const original = await this.read(scope);
    if (this.revision(original) !== revision)
      throw Error("Config changed. Reload before saving.");
    const doc = restoreMasked(this.parse(json), original) as McpDocument;
    await this.write(scope, doc);
  }
}
