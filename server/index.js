import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readConfig } from "./config.js";
import { createLocalAgent } from "./agent.js";
import { listFiles, previewFile, workspaceDiff } from "./files.js";

export function createApp(config, agentFactory = createLocalAgent) {
  const app = express();
  const sessions = new Map();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    // Loopback bind + Host and Origin checks prevent LAN exposure and DNS rebinding.
    const host = req.get("host");
    const expected = new Set([
      `127.0.0.1:${config.port}`,
      `localhost:${config.port}`,
    ]);
    if (!expected.has(host))
      return res
        .status(403)
        .json({ error: "Use the localhost address printed by the server." });
    if (req.get("origin") && req.get("origin") !== `http://${host}`)
      return res
        .status(403)
        .json({ error: "Cross-origin requests are not allowed" });
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.get("x-flashlet-client") !== "workbench"
    )
      return res.status(403).json({ error: "Missing client header" });
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
    });
    next();
  });
  app.use(express.json({ limit: "32kb" }));
  app.get("/api/config", (_req, res) =>
    res.json({
      modelId: config.modelId,
      endpoint: config.baseUrl,
      workspace: path.basename(config.workspace),
      allowWrites: config.allowWrites,
    }),
  );
  app.get("/api/files", async (req, res) => {
    try {
      res.json({
        files: await listFiles(config.workspace, req.query.path || ""),
      });
    } catch {
      res.status(400).json({ error: "Cannot open this directory" });
    }
  });
  app.get("/api/file", async (req, res) => {
    try {
      res.json(await previewFile(config.workspace, req.query.path));
    } catch {
      res
        .status(400)
        .json({
          error:
            "Cannot preview this file. It may be excluded, binary, outside the workspace, or over 200 KB.",
        });
    }
  });
  app.get("/api/diff", async (_req, res) =>
    res.json(await workspaceDiff(config.workspace)),
  );
  app.post("/api/sessions", async (_req, res, next) => {
    if (sessions.size >= 8)
      return res
        .status(429)
        .json({
          error:
            "Eight sessions are open. Close a session or restart the server.",
        });
    // Reserve the slot before async initialization to bound concurrent creates.
    const id = randomUUID();
    const entry = {
      id,
      busy: false,
      clients: new Set(),
      history: [],
      seq: 0,
      lastUsed: Date.now(),
      agent: null,
    };
    sessions.set(id, entry);
    try {
      entry.agent = await agentFactory(config);
      entry.unsubscribe = entry.agent.session.subscribe((event) => {
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        )
          emit(entry, "delta", { text: event.assistantMessageEvent.delta });
        if (event.type === "tool_execution_start")
          emit(entry, "tool_start", {
            id: event.toolCallId,
            name: event.toolName,
            args: event.args,
          });
        if (event.type === "tool_execution_end")
          emit(entry, "tool_end", {
            id: event.toolCallId,
            name: event.toolName,
            error: event.isError,
            result: event.result,
          });
        if (
          event.type === "message_end" &&
          event.message.role === "assistant" &&
          event.message.errorMessage
        )
          emit(entry, "run_error", { message: event.message.errorMessage });
      });
      res.status(201).json({ id });
    } catch (error) {
      sessions.delete(id);
      next(error);
    }
  });
  function emit(entry, type, data) {
    const item = { id: ++entry.seq, type, data };
    entry.history.push(item);
    if (entry.history.length > 2000) entry.history.shift();
    const frame = `id: ${item.id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of entry.clients)
      if (!client.write(frame)) {
        client.end();
        entry.clients.delete(client);
      }
  }
  app.use("/api/sessions/:id", (req, res, next) => {
    const entry = sessions.get(req.params.id);
    if (!entry?.agent)
      return res
        .status(404)
        .json({ error: "Session unavailable. Start a new task." });
    entry.lastUsed = Date.now();
    req.flashlet = entry;
    next();
  });
  app.get("/api/sessions/:id/events", (req, res) => {
    const entry = req.flashlet;
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const last = Number(req.get("last-event-id") || 0);
    for (const event of entry.history)
      if (event.id > last)
        res.write(
          `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
        );
    entry.clients.add(res);
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
    req.on("close", () => {
      clearInterval(heartbeat);
      entry.clients.delete(res);
    });
  });
  app.post("/api/sessions/:id/prompt", (req, res) => {
    const entry = req.flashlet;
    const text = req.body.text;
    if (typeof text !== "string" || !text.trim() || text.length > 16000)
      return res
        .status(400)
        .json({ error: "Enter a prompt under 16,000 characters" });
    if (entry.busy)
      return res.status(409).json({ error: "This task is still running" });
    entry.busy = true;
    emit(entry, "run_start", {});
    res.status(202).json({ accepted: true });
    entry.agent.session
      .prompt(text.trim())
      .catch((error) => emit(entry, "run_error", { message: error.message }))
      .finally(() => {
        entry.busy = false;
        entry.lastUsed = Date.now();
        emit(entry, "run_end", {});
      });
  });
  app.post("/api/sessions/:id/abort", async (req, res) => {
    await req.flashlet.agent.session.abort();
    res.json({ stopped: true });
  });
  async function remove(entry) {
    entry.unsubscribe?.();
    for (const client of entry.clients) client.end();
    entry.clients.clear();
    await entry.agent?.dispose();
    sessions.delete(entry.id);
  }
  app.delete("/api/sessions/:id", async (req, res) => {
    await remove(req.flashlet);
    res.status(204).end();
  });
  const sweep = setInterval(() => {
    for (const entry of sessions.values())
      if (
        entry.agent &&
        !entry.busy &&
        !entry.clients.size &&
        Date.now() - entry.lastUsed > 3600000
      )
        void remove(entry);
  }, 60000);
  sweep.unref();
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));
  app.use((error, _req, res, _next) => {
    if (!res.headersSent)
      res
        .status(error.status || 500)
        .json({
          error:
            error.status === 400
              ? "Invalid request body"
              : "Request failed. Check the model endpoint and server configuration.",
        });
  });
  return {
    app,
    async close() {
      clearInterval(sweep);
      await Promise.all([...sessions.values()].map(remove));
    },
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const config = readConfig();
  const { app, close } = createApp(config);
  const server = app.listen(config.port, "127.0.0.1", () =>
    console.log(
      `Flashlet workbench: http://127.0.0.1:${config.port}\nWorkspace: ${config.workspace}\nTools: ${config.allowWrites ? "write + shell enabled (not sandboxed)" : "read-only (not sandboxed)"}`,
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      await close();
      server.close(() => process.exit(0));
    });
}
