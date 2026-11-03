import type { Express } from "express";
import { ConnectorStore, validateConnector, presets } from "./connectors.ts";
export function connectorApi(
  app: Express,
  store: ConnectorStore,
  config: any,
  factory: any,
) {
  let agent: any;
  let busy = false;
  let state: any = { notifications: [], url: null, pendingInput: false };
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
          input: (_title: string, _placeholder: string, opts: any) =>
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
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    } finally {
      busy = false;
    }
  });
  app.delete("/api/connectors/:name", async (req, res) => {
    if (busy)
      return res.status(409).json({ error: "Wait for sign-in to finish" });
    const name = String(req.params.name);
    if (!store.entries.some((e) => e.name === name))
      return res.status(404).json({ error: "Unknown connector" });
    busy = true;
    try {
      // Sign out first so removed OAuth credentials do not linger.
      const a = await getAgent();
      await a.session.prompt(`/mcp logout ${name}`);
      store.entries = store.entries.filter((e) => e.name !== name);
      await store.save();
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
      !store.entries.some((e) => e.name === name) ||
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
      const entry = store.entries.find((e) => e.name === name)!;
      entry.readOnly = !entry.readOnly;
      await store.save();
      return res.json({
        note: "Permission updated. Gmail writes follow this switch; other writes also require FLASHLET_ALLOW_WRITES=true.",
      });
    }
    if (action === "toggle") {
      const entry = store.entries.find((e) => e.name === name)!;
      entry.config.enabled = entry.config.enabled === false;
      await store.save();
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
        .filter((t: any) => t.name.startsWith("mcp__"))
        .map((t: any) => ({
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
