import type { ConnectorState } from "../shared/api.ts";
import type { AppConfig, AgentFactory, AgentHandle } from "./types.ts";
import type { Express } from "express";
import { ConnectorStore, validateConnector, presets } from "./connectors.ts";
export function connectorApi(
  app: Express,
  store: ConnectorStore,
  config: AppConfig,
  factory: AgentFactory,
) {
  let agent: AgentHandle | undefined;
  let busy = false;
  let state: ConnectorState = {
    notifications: [],
    url: null,
    pendingInput: false,
  };
  let answer: ((value: string | undefined) => void) | undefined;
  const notify = (message: string) => {
    state.notifications.push(message);
    state.notifications = state.notifications.slice(-12);
  };
  async function getAgent() {
    if (!agent)
      agent = await factory({
        ...config,
        connectors: store,
        connectorUi: {
          notify,
          openUrl: (url: string) => {
            state.url = url;
          },
          input: (
            _title: string,
            _placeholder?: string,
            opts?: { signal?: AbortSignal },
          ) =>
            new Promise<string | undefined>((resolve) => {
              state.pendingInput = true;
              const done = (value?: string) => {
                clearTimeout(timeout);
                state.pendingInput = false;
                answer = undefined;
                resolve(value);
              };
              answer = done;
              const timeout = setTimeout(() => done(), 300000);
              timeout.unref();
              opts?.signal?.addEventListener(
                "abort",
                () => clearTimeout(timeout),
                { once: true },
              );
              opts?.signal?.addEventListener("abort", () => done(), {
                once: true,
              });
            }),
        },
      });
    return agent;
  }
  app.get("/api/mcp-config", async (req, res) => {
    if (!store.files)
      return res.status(503).json({ error: "Config editor unavailable" });
    try {
      res.json(
        await store.files.view(
          req.query.scope === "project" ? "project" : "global",
        ),
      );
    } catch (e) {
      res
        .status(400)
        .json({ error: e instanceof Error ? e.message : "Cannot read config" });
    }
  });
  app.put("/api/mcp-config", async (req, res) => {
    if (!store.files)
      return res.status(503).json({ error: "Config editor unavailable" });
    if (busy)
      return res
        .status(409)
        .json({ error: "Wait for connector operation to finish" });
    if (
      typeof req.body.json !== "string" ||
      typeof req.body.revision !== "string"
    )
      return res.status(400).json({ error: "Expected JSON text and revision" });
    busy = true;
    try {
      await store.files.saveEditor(
        req.body.scope === "project" ? "project" : "global",
        req.body.json,
        req.body.revision,
      );
      await store.refreshGlobal();
      await agent?.dispose();
      agent = undefined;
      res.json({
        note: "mcp.json saved. Start a new task to load changes; use Sign in / Status below to authenticate.",
      });
    } catch (e) {
      res
        .status(400)
        .json({ error: e instanceof Error ? e.message : "Invalid config" });
    } finally {
      busy = false;
    }
  });
  app.post("/api/mcp-trust", async (req, res) => {
    if (!store.files)
      return res.status(503).json({ error: "Config editor unavailable" });
    if (busy)
      return res
        .status(409)
        .json({ error: "Wait for connector operation to finish" });
    if (typeof req.body.trusted !== "boolean")
      return res.status(400).json({ error: "Expected trust decision" });
    if (req.body.trusted) {
      try {
        store.files.validate(await store.files.read("project"), "project");
      } catch (e) {
        return res.status(400).json({
          error: e instanceof Error ? e.message : "Invalid project config",
        });
      }
    }
    store.files.trust.set(config.workspace, req.body.trusted);
    await agent?.dispose();
    agent = undefined;
    res.json({
      note: req.body.trusted
        ? "Project trusted. Start a new task to load project MCP servers."
        : "Project untrusted. Close old tasks to drop cached connections.",
    });
  });
  app.get("/api/connectors", (_req, res) =>
    res.json({ connectors: store.publicList(), presets, ...state, busy }),
  );
  app.put("/api/connectors", async (req, res) => {
    if (busy)
      return res.status(409).json({ error: "Wait for sign-in to finish" });
    busy = true;
    try {
      const entry = validateConnector(req.body);
      if (
        store.entries.length >= 24 &&
        !store.entries.some((e) => e.name === entry.name)
      )
        throw new Error("Limit of 24 connectors reached");
      if (
        store.entries.some(
          (e) =>
            e.name !== entry.name &&
            e.name.replaceAll("-", "_") === entry.name.replaceAll("-", "_"),
        )
      )
        throw new Error("Connector name collides");
      delete store.policies[entry.name];
      store.entries = [
        ...store.entries.filter((e) => e.name !== entry.name),
        entry,
      ];
      await store.save();
      await agent?.dispose();
      agent = undefined;
      state = { notifications: [], url: null, pendingInput: false };
      res.json({
        saved: true,
        note: "Start a new task to use connector changes. Replacing a connector replaces its saved credentials/config fields.",
      });
    } catch (e: unknown) {
      res
        .status(400)
        .json({ error: e instanceof Error ? e.message : "Invalid connector" });
    } finally {
      busy = false;
    }
  });
  app.delete("/api/connectors/:name", async (req, res) => {
    if (busy)
      return res.status(409).json({ error: "Wait for sign-in to finish" });
    const name = String(req.params.name);
    if (!store.effectiveEntries().some((e) => e.name === name))
      return res.status(404).json({ error: "Unknown connector" });
    busy = true;
    try {
      // Sign out first so removed OAuth credentials do not linger.
      const a = await getAgent();
      await a.session.prompt(`/mcp logout ${name}`);
      await store.removeServer(name);
      await agent?.dispose();
      agent = undefined;
      res.json({
        removed: true,
        note: "Existing tasks retain their connector snapshot. Close them to revoke in-memory access.",
      });
    } finally {
      busy = false;
    }
  });
  app.post("/api/connectors/:name/:action", async (req, res) => {
    const name = String(req.params.name),
      action = String(req.params.action);
    if (
      !store.effectiveEntries().some((e) => e.name === name) ||
      ![
        "login",
        "logout",
        "reconnect",
        "status",
        "toggle",
        "permission",
      ].includes(action)
    )
      return res.status(400).json({ error: "Unknown connector action" });
    if (busy)
      return res
        .status(409)
        .json({ error: "Another connector operation is running" });
    if (action === "permission") {
      const entry = store.effectiveEntries().find((e) => e.name === name)!;
      await store.setReadOnly(name, !entry.readOnly);
      return res.json({
        note: "Permission updated. Non-Gmail writes also require FLASHLET_ALLOW_WRITES=true.",
      });
    }
    if (action === "toggle") {
      const entry = store.effectiveEntries().find((e) => e.name === name)!;
      await store.setEnabled(name, entry.config.enabled === false);
      await agent?.dispose();
      agent = undefined;
      return res.json({
        note: "Connector toggled. Start a new task to apply.",
      });
    }
    busy = true;
    state.url = null;
    state.notifications = [];
    res.status(202).json({ started: true });
    try {
      const a = await getAgent();
      await a.session.prompt(
        action === "status" ? "/mcp" : `/mcp ${action} ${name}`,
      );
      state.tools = a.session
        .getAllTools()
        .filter((t) => t.name.startsWith("mcp__"))
        .map((t) => ({
          name: t.name,
          readOnly: t.annotations?.readOnlyHint === true,
        }));
    } catch {
      notify(
        "Connector operation failed. Check your endpoint and OAuth configuration.",
      );
    } finally {
      busy = false;
      state.url = null;
    }
  });
  app.post("/api/connectors/cancel", (_req, res) => {
    answer?.(undefined);
    res.json({ cancelled: true });
  });
  app.post("/api/connectors/redirect", (req, res) => {
    if (
      !answer ||
      typeof req.body.url !== "string" ||
      req.body.url.length > 8192
    )
      return res.status(400).json({ error: "No sign-in awaiting a redirect" });
    answer(req.body.url);
    res.json({ accepted: true });
  });
  return async () => {
    answer?.(undefined);
    await agent?.dispose();
  };
}
