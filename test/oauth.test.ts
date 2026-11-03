import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createApp } from "../server/index.js";
import { readConfig } from "../server/config.js";
import { ConnectorStore, validateConnector } from "../server/connectors.ts";

const listen = (server: http.Server, port = 0) =>
  new Promise<number>((r) =>
    server.listen(port, "127.0.0.1", () => r((server.address() as any).port)),
  );
const close = (server: http.Server) =>
  new Promise<void>((r) => server.close(() => r()));
const waitFor = async (check: () => Promise<boolean>) => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw Error("Timed out");
};
test(
  "remote MCP OAuth DCR, PKCE callback, saved tokens and tools via panel API",
  { timeout: 15000 },
  async () => {
    let root = "";
    let redirect = "";
    let state = "";
    let sawPkce = false;
    let sawToken = false;
    const remote = http.createServer(async (req, res) => {
      const url = new URL(req.url!, root);
      const json = (status: number, body: any, headers = {}) => {
        res.writeHead(status, {
          "Content-Type": "application/json",
          ...headers,
        });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/.well-known/oauth-protected-resource")
        return json(200, {
          resource: root + "/mcp",
          authorization_servers: [root],
        });
      if (url.pathname === "/.well-known/oauth-authorization-server")
        return json(200, {
          issuer: root,
          authorization_endpoint: root + "/authorize",
          token_endpoint: root + "/token",
          registration_endpoint: root + "/register",
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      let raw = "";
      for await (const chunk of req) raw += chunk;
      if (url.pathname === "/register") {
        const body = JSON.parse(raw);
        redirect = body.redirect_uris[0];
        return json(201, {
          ...body,
          client_id: "mock-client",
          token_endpoint_auth_method: "none",
        });
      }
      if (url.pathname === "/token") {
        const body = new URLSearchParams(raw);
        sawToken = body.has("code_verifier");
        return json(200, {
          access_token: "mock-access",
          refresh_token: "mock-refresh",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      if (url.pathname === "/mcp") {
        if (req.headers.authorization !== "Bearer mock-access")
          return json(
            401,
            {},
            {
              "WWW-Authenticate": `Bearer resource_metadata="${root}/.well-known/oauth-protected-resource"`,
            },
          );
        if (req.method === "GET") {
          res.writeHead(405);
          return res.end();
        }
        if (req.method === "DELETE") {
          res.writeHead(200);
          return res.end();
        }
        const msg = JSON.parse(raw);
        if (!("id" in msg)) {
          res.writeHead(202);
          return res.end();
        }
        const result =
          msg.method === "initialize"
            ? {
                protocolVersion: msg.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "OAuth mock", version: "1" },
              }
            : msg.method === "tools/list"
              ? {
                  tools: [
                    {
                      name: "read_notes",
                      description: "Read notes",
                      inputSchema: { type: "object", properties: {} },
                      annotations: { readOnlyHint: true },
                    },
                  ],
                }
              : {};
        return json(200, { jsonrpc: "2.0", id: msg.id, result });
      }
      return json(404, {});
    });
    root = `http://127.0.0.1:${await listen(remote)}`;
    const dir = await mkdtemp(path.join(tmpdir(), "flashlet-oauth-"));
    const store = new ConnectorStore(dir);
    await store.load();
    store.entries = [validateConnector({ name: "oauth", url: root + "/mcp" })];
    const localPort = await new Promise<number>((r) => {
      const s = http.createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as any).port;
        s.close(() => r(p));
      });
    });
    const workbench = createApp({
      ...readConfig({ PORT: String(localPort) }),
      connectors: store,
    });
    const local = http.createServer(workbench.app);
    await listen(local, localPort);
    const call = async (url: string, body?: any) => {
      const r = await fetch(
        `http://127.0.0.1:${localPort}/api/connectors${url}`,
        {
          method: body ? "POST" : "GET",
          headers: {
            "Content-Type": "application/json",
            "X-Flashlet-Client": "workbench",
          },
          body: body ? JSON.stringify(body) : undefined,
        },
      );
      return r.json() as any;
    };
    try {
      await call("/oauth/login", {});
      let auth: any;
      await waitFor(async () => {
        auth = await call("");
        if (!auth.busy) throw Error(JSON.stringify(auth));
        return !!auth.url;
      });
      const authorization = new URL(auth.url);
      state = authorization.searchParams.get("state")!;
      sawPkce =
        authorization.searchParams.get("code_challenge_method") === "S256";
      assert.ok(sawPkce);
      const callback = new URL(redirect);
      callback.searchParams.set("code", "mock-code");
      callback.searchParams.set("state", state);
      await fetch(callback);
      await waitFor(async () => {
        auth = await call("");
        return !auth.busy;
      });
      assert.ok(sawToken);
      assert.ok(
        auth.notifications.some((m: string) => m.includes("Signed in")),
      );
      assert.ok(
        auth.tools.some((t: any) => t.name === "mcp__oauth__read_notes"),
      );
      const tokens = await readFile(path.join(dir, "mcp-auth.json"), "utf8");
      assert.ok(tokens.includes("mock-refresh"));
      assert.ok(!JSON.stringify(auth).includes("mock-access"));
    } finally {
      await workbench.close();
      await close(local);
      await close(remote);
      await rm(dir, { recursive: true, force: true });
    }
  },
);
