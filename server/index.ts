import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { THINKING_LEVELS, type AppConfig, type AgentFactory, type AgentHandle } from "./types.ts";
import { SessionManager, buildSessionContext } from "@earendil-works/pi-coding-agent";
import { rm } from "node:fs/promises";
import { FolderStore, type Folder } from "./folders.ts";
import { toChatMessages, toolResultText, titleFrom } from "./transcript.ts";
import type { ChatSummary, Transcript } from "../shared/api.ts";
interface SessionEntry {
  id: string;
  folderId: string;
  title: string;
  busy: boolean;
  /** Event seq before the current run's run_start. */
  runStart: number;
  /** Agent message count before the current run. */
  runMessages: number;
  clients: Set<Response>;
  history: { id: number; type: string; data: unknown }[];
  seq: number;
  lastUsed: number;
  agent: AgentHandle | null;
  unsubscribe?: () => void;
}
declare global {
  namespace Express {
    interface Request {
      flashlet: SessionEntry;
    }
  }
}
import { McpConfigFiles } from "./mcp-config.ts";
import { ConnectorStore, dataDirectory } from "./connectors.ts";
import { connectorApi } from "./connector-api.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readConfig } from "./config.ts";
import { createLocalAgent } from "./agent.ts";
import { listFiles, previewFile, workspaceDiff } from "./files.ts";

export function createApp(
  config: AppConfig,
  agentFactory: AgentFactory = createLocalAgent,
) {
  const app = express();
  const sessions = new Map<string, SessionEntry>();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    // Loopback bind + Host and Origin checks prevent LAN exposure and DNS rebinding.
    const host = req.get("host");
    const expected = new Set([
      `127.0.0.1:${config.port}`,
      `localhost:${config.port}`,
    ]);
    if (!host || !expected.has(host))
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
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-src 'self' blob:; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
    });
    next();
  });
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "32kb" }));
  const closeConnectors = config.connectors
    ? connectorApi(app, config.connectors, config, agentFactory)
    : async () => {};
  const folders = new FolderStore(config.workspace, config.dataDir);
  const ready = folders.load();
  app.use("/api", async (_req, _res, next) => {
    await ready;
    next();
  });
  const pending = new Map<string, Promise<SessionEntry>>();
  const persistent = !!config.dataDir;

  app.get("/api/config", (_req, res) =>
    res.json({
      modelId: config.modelId,
      endpoint: config.baseUrl,
      modelApi: config.modelApi || "openai-completions",
      workspace: path.basename(config.workspace),
      allowWrites: config.allowWrites,
      thinking: config.thinking,
      persistent,
    }),
  );

  // ---------- folders ----------
  function folderParam(req: Request, res: Response): Folder | undefined {
    const raw = req.params.folderId ?? req.query.folder ?? "default";
    const folder = folders.get(String(raw));
    if (!folder) res.status(404).json({ error: "Folder not found" });
    return folder;
  }
  app.get("/api/folders", (_req, res) => res.json({ folders: folders.list() }));
  app.post("/api/folders", async (req, res) => {
    try {
      res.status(201).json(await folders.add(req.body?.path, req.body?.name));
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });
  app.patch("/api/folders/:folderId", async (req, res) => {
    try {
      res.json(await folders.rename(String(req.params.folderId), req.body?.name));
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });
  app.delete("/api/folders/:folderId", async (req, res) => {
    const id = String(req.params.folderId);
    if ([...sessions.values()].some((s) => s.folderId === id && s.busy))
      return res.status(409).json({ error: "A chat in this folder is running" });
    try {
      await folders.remove(id);
      for (const entry of [...sessions.values()])
        if (entry.folderId === id) await remove(entry);
      res.status(204).end();
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  // ---------- chats ----------
  app.get("/api/folders/:folderId/chats", async (req, res) => {
    const folder = folderParam(req, res);
    if (!folder) return;
    const chats = new Map<string, ChatSummary>();
    const dir = folders.sessionDir(folder);
    if (dir)
      for (const info of await SessionManager.list(folder.path, dir).catch(
        () => [],
      ))
        chats.set(info.id, {
          id: info.id,
          folderId: folder.id,
          title: info.name || titleFrom(info.firstMessage),
          modified: info.modified.getTime(),
          messageCount: info.messageCount,
          busy: false,
        });
    for (const entry of sessions.values())
      if (entry.folderId === folder.id) {
        const saved = chats.get(entry.id);
        chats.set(entry.id, {
          id: entry.id,
          folderId: folder.id,
          title: entry.title,
          modified: Math.max(entry.lastUsed, saved?.modified || 0),
          messageCount: entry.agent?.session.messages.length || 0,
          busy: entry.busy,
        });
      }
    res.json({
      chats: [...chats.values()].sort((a, b) => b.modified - a.modified),
    });
  });

  async function startSession(
    folder: Folder,
    sessionFile?: string,
  ): Promise<SessionEntry> {
    if (sessions.size >= 8) {
      // Persisted chats can be evicted and reopened later; in-memory ones cannot.
      const idle = [...sessions.values()]
        .filter((s) => !s.busy && !s.clients.size && persistent)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle)
        throw Object.assign(
          new Error(
            "Eight chats are active. Close a chat or restart the server.",
          ),
          { status: 429 },
        );
      await remove(idle, false);
    }
    const agent = await agentFactory(config, {
      cwd: folder.path,
      sessionDir: folders.sessionDir(folder),
      sessionFile,
    });
    const id = agent.session.sessionId;
    const messages = agent.session.messages;
    const firstUser = toChatMessages(messages).find((m) => m.role === "user");
    const entry: SessionEntry = {
      id,
      folderId: folder.id,
      title:
        agent.session.sessionManager.getSessionName() ||
        (firstUser?.blocks[0]?.type === "text"
          ? titleFrom(firstUser.blocks[0].text)
          : "New chat"),
      busy: false,
      clients: new Set(),
      history: [],
      seq: 0,
      runStart: 0,
      runMessages: 0,
      lastUsed: Date.now(),
      agent,
    };
    sessions.set(id, entry);
    entry.unsubscribe = agent.session.subscribe((event) => {
      if (event.type === "message_update") {
        const e = event.assistantMessageEvent;
        if (e.type === "text_delta") emit(entry, "delta", { text: e.delta });
        if (e.type === "thinking_delta")
          emit(entry, "thinking", { text: e.delta });
      }
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
          result: toolResultText(event.result),
        });
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.errorMessage
      )
        emit(entry, "run_error", { message: event.message.errorMessage });
    });
    return entry;
  }

  /** Find a saved chat file by id across folders. */
  function findSaved(id: string): { folder: Folder; file: string } | undefined {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return;
    for (const folder of folders.list()) {
      const dir = folders.sessionDir(folder);
      if (!dir) continue;
      const file = SessionManager.findById(folder.path, id, dir);
      if (file) return { folder, file };
    }
  }

  /** Live session, or reopen a saved chat on demand. */
  async function live(id: string): Promise<SessionEntry | undefined> {
    const entry = sessions.get(id);
    if (entry?.agent) return entry;
    if (pending.has(id)) return pending.get(id);
    const saved = findSaved(id);
    if (!saved) return;
    const opening = startSession(saved.folder, saved.file).finally(() =>
      pending.delete(id),
    );
    pending.set(id, opening);
    return opening;
  }

  async function createChat(folder: Folder, res: Response, next: NextFunction) {
    try {
      const entry = await startSession(folder);
      res.status(201).json({ id: entry.id, folderId: folder.id });
    } catch (error) {
      next(error);
    }
  }
  app.post("/api/folders/:folderId/chats", (req, res, next) => {
    const folder = folderParam(req, res);
    if (folder) void createChat(folder, res, next);
  });
  // Back-compat: a chat in the workspace folder.
  app.post("/api/sessions", (_req, res, next) =>
    void createChat(folders.get("default")!, res, next),
  );

  function emit(entry: SessionEntry, type: string, data: unknown) {
    const item = { id: ++entry.seq, type, data };
    entry.history.push(item);
    if (entry.history.length > 5000) entry.history.shift();
    const frame = `id: ${item.id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of entry.clients)
      if (!client.write(frame)) {
        client.end();
        entry.clients.delete(client);
      }
  }

  // Transcript: from the live agent, or straight from the saved file (no agent start).
  app.get("/api/sessions/:id", async (req, res) => {
    const id = String(req.params.id);
    const entry = sessions.get(id);
    if (entry?.agent) {
      const all = entry.agent.session.messages;
      // While running, send the transcript up to the run start and replay the
      // run's events, so a refresh mid-answer rebuilds the partial turn.
      const transcript: Transcript = {
        id,
        folderId: entry.folderId,
        title: entry.title,
        busy: entry.busy,
        thinking: entry.agent.session.thinkingLevel,
        messages: toChatMessages(
          entry.busy ? all.slice(0, entry.runMessages) : all,
        ),
        after: entry.busy ? entry.runStart : entry.seq,
      };
      return res.json(transcript);
    }
    const saved = findSaved(id);
    if (!saved)
      return res.status(404).json({ error: "Chat not found. Start a new one." });
    try {
      const manager = SessionManager.open(saved.file);
      const context = buildSessionContext(
        manager.getEntries(),
        manager.getLeafId(),
      );
      const messages = toChatMessages(context.messages);
      const first = messages.find((m) => m.role === "user")?.blocks[0];
      const transcript: Transcript = {
        id,
        folderId: saved.folder.id,
        title:
          manager.getSessionName() ||
          (first?.type === "text" ? titleFrom(first.text) : "New chat"),
        busy: false,
        thinking: config.thinking,
        messages,
        after: 0,
      };
      res.json(transcript);
    } catch {
      res.status(500).json({ error: "This chat file could not be read" });
    }
  });

  app.use("/api/sessions/:id", async (req, res, next) => {
    try {
      const entry = await live(String(req.params.id));
      if (!entry?.agent)
        return res
          .status(404)
          .json({ error: "Session unavailable. Start a new task." });
      entry.lastUsed = Date.now();
      req.flashlet = entry;
      next();
    } catch (error) {
      next(error);
    }
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
    const last = Number(req.get("last-event-id") || req.query.after || 0);
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
    if (entry.title === "New chat") entry.title = titleFrom(text);
    entry.runMessages = entry.agent!.session.messages.length;
    entry.runStart = entry.seq;
    emit(entry, "run_start", { text: text.trim() });
    res.status(202).json({ accepted: true, after: entry.runStart });
    entry
      .agent!.session.prompt(text.trim())
      .catch((error) => emit(entry, "run_error", { message: error.message }))
      .finally(() => {
        entry.busy = false;
        entry.lastUsed = Date.now();
        emit(entry, "run_end", {});
      });
  });
  app.post("/api/sessions/:id/thinking", (req, res) => {
    const level = req.body?.level;
    if (!THINKING_LEVELS.includes(level))
      return res.status(400).json({ error: "Unknown thinking level" });
    req.flashlet.agent!.session.setThinkingLevel(level);
    res.json({ thinking: req.flashlet.agent!.session.thinkingLevel });
  });
  app.post("/api/sessions/:id/abort", async (req, res) => {
    await req.flashlet.agent!.session.abort();
    res.json({ stopped: true });
  });
  async function remove(entry: SessionEntry, deleteFile = false) {
    const file = entry.agent?.session.sessionFile;
    entry.unsubscribe?.();
    for (const client of entry.clients) client.end();
    entry.clients.clear();
    await entry.agent?.dispose();
    sessions.delete(entry.id);
    if (deleteFile && file) await rm(file, { force: true });
  }
  // Deleting removes the chat and its saved file (if any).
  app.delete("/api/sessions/:id", async (req, res) => {
    const file = findSaved(String(req.params.id))?.file;
    await remove(req.flashlet, true);
    if (file) await rm(file, { force: true });
    res.status(204).end();
  });

  // ---------- files (scoped to a folder) ----------
  app.get("/api/files", async (req, res) => {
    const folder = folderParam(req, res);
    if (!folder) return;
    try {
      res.json({
        files: await listFiles(
          folder.path,
          typeof req.query.path === "string" ? req.query.path : "",
        ),
      });
    } catch {
      res.status(400).json({ error: "Cannot open this directory" });
    }
  });
  app.get("/api/file", async (req, res) => {
    const folder = folderParam(req, res);
    if (!folder) return;
    try {
      res.json(
        await previewFile(
          folder.path,
          typeof req.query.path === "string" ? req.query.path : "",
        ),
      );
    } catch {
      res.status(400).json({
        error:
          "Cannot preview this file. It may be excluded, binary, outside the workspace, or over 200 KB.",
      });
    }
  });
  app.get("/api/diff", async (req, res) => {
    const folder = folderParam(req, res);
    if (folder) res.json(await workspaceDiff(folder.path));
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
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));
  app.use(express.static(publicDir));
  // Client-side routes (/f/:folder/c/:chat) load the app shell.
  app.get(/^\/(?!api\/|assets\/).*/, (req, res, next) =>
    req.accepts("html") ? res.sendFile(path.join(publicDir, "index.html")) : next(),
  );
  app.use(
    (
      error: Error & { status?: number },
      _req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      if (!res.headersSent)
        res.status(error.status || 500).json({
          error:
            error.status === 400
              ? "Invalid request body"
              : error.status === 429
                ? error.message
                : "Request failed. Check the model endpoint and server configuration.",
        });
    },
  );
  return {
    app,
    async close() {
      clearInterval(sweep);
      await closeConnectors();
      await Promise.all([...sessions.values()].map((entry) => remove(entry)));
    },
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const config = readConfig();
  const store = new ConnectorStore(dataDirectory());
  await store.load();
  const files = new McpConfigFiles(store.dir, config.workspace);
  await files.initialize();
  await store.attachFiles(files);
  config.connectors = store;
  config.dataDir = store.dir;
  const { app, close } = createApp(config);
  const server = app.listen(config.port, "127.0.0.1", () =>
    console.log(
      `Flashlet workbench: http://127.0.0.1:${config.port}\nWorkspace: ${config.workspace}\nChats saved in: ${config.dataDir}/chats\nThinking: ${config.thinking}\nTools: ${config.allowWrites ? "write + shell enabled (not sandboxed)" : "read-only (not sandboxed)"}`,
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      await close();
      server.close(() => process.exit(0));
    });
}
