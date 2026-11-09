import { StrictMode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Link,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { ApiError, errorMessage, post, queries } from "./api.ts";
import { useChat } from "./useChat.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { Composer } from "./components/Composer.tsx";
import { Message } from "./components/Message.tsx";
import { ArtifactContext } from "./components/Markdown.tsx";
import { ArtifactModal } from "./components/Modal.tsx";
import { ConnectorsModal } from "./components/Connectors.tsx";
import { Icon } from "./components/Icon.tsx";

// ---------- shared state ----------
/** Prompt typed on a folder's home screen, sent once its new chat opens. */
const pendingPrompts = new Map<string, string>();

function useThinking() {
  const config = useQuery(queries.config());
  const [level, setLevel] = useState<string | null>(() =>
    localStorage.getItem("flashlet.thinking"),
  );
  const value = level ?? (config.data?.thinking === "off" ? "off" : config.data?.thinking) ?? "off";
  const normalized = ["off", "low", "medium", "high"].includes(value) ? value : "high";
  return [
    normalized,
    (next: string) => {
      localStorage.setItem("flashlet.thinking", next);
      setLevel(next);
    },
  ] as const;
}

function useFolder(folderId: string) {
  const folders = useQuery(queries.folders());
  return {
    folders,
    folder: folders.data?.find((f) => f.id === folderId),
  };
}

// ---------- layout ----------
function Layout() {
  const params = useParams({ strict: false }) as {
    folderId?: string;
    chatId?: string;
  };
  const folderId = params.folderId || "default";
  const config = useQuery(queries.config());
  const { folder } = useFolder(folderId);
  const [artifact, setArtifact] = useState<{ source: string; title: string } | null>(null);
  const [connectors, setConnectors] = useState(false);
  const [nav, setNav] = useState(false);
  const [inspector, setInspector] = useState(
    () => localStorage.getItem("flashlet.inspector") !== "closed",
  );
  const showArtifact = useCallback(
    (source: string, title: string) => setArtifact({ source, title }),
    [],
  );
  useEffect(() => {
    localStorage.setItem("flashlet.inspector", inspector ? "open" : "closed");
  }, [inspector]);
  return (
    <ArtifactContext.Provider value={showArtifact}>
      <div className={`app ${inspector ? "" : "no-inspector"} ${nav ? "nav-open" : ""}`}>
        <Sidebar
          folderId={folderId}
          chatId={params.chatId}
          onNavigate={() => setNav(false)}
        />
        <div className="scrim" onClick={() => setNav(false)} />
        <main className="main">
          <header className="topbar">
            <button
              type="button"
              className="icon-button mobile-only"
              onClick={() => setNav(true)}
              aria-label="Open sidebar"
            >
              <Icon name="menu" />
            </button>
            <div className="crumbs">
              <Link to="/f/$folderId" params={{ folderId }} className="crumb">
                <Icon name="folder" size={14} /> {folder?.name || "…"}
              </Link>
              <TitleCrumb chatId={params.chatId} />
            </div>
            <div className="topbar-actions">
              <span className={`badge ${config.data?.allowWrites ? "warn" : ""}`}>
                {config.data?.allowWrites ? "Write + shell" : "Read only"}
              </span>
              <button
                id="open-connectors"
                type="button"
                className="button ghost"
                onClick={() => setConnectors(true)}
              >
                <Icon name="plug" size={15} /> Connectors
              </button>
              <button
                type="button"
                className={`icon-button ${inspector ? "active" : ""}`}
                onClick={() => setInspector(!inspector)}
                title="Toggle workspace panel"
              >
                <Icon name="panel" />
              </button>
            </div>
          </header>
          <Outlet />
        </main>
        {inspector && <Inspector folderId={folderId} />}
      </div>
      {artifact && <ArtifactModal artifact={artifact} onClose={() => setArtifact(null)} />}
      {connectors && <ConnectorsModal onClose={() => setConnectors(false)} />}
    </ArtifactContext.Provider>
  );
}

function TitleCrumb({ chatId }: { chatId?: string }) {
  const transcript = useQuery({
    ...queries.transcript(chatId || ""),
    enabled: !!chatId,
  });
  const client = useQueryClient();
  const params = useParams({ strict: false }) as { folderId?: string };
  const chats = client.getQueryData<{ id: string; title: string }[]>([
    "chats",
    params.folderId || "default",
  ]);
  if (!chatId) return null;
  const title =
    chats?.find((c) => c.id === chatId)?.title || transcript.data?.title || "Chat";
  return (
    <>
      <span className="crumb-sep">/</span>
      <span className="crumb current">{title}</span>
    </>
  );
}

// ---------- folder home (new chat) ----------
const SUGGESTIONS = [
  {
    title: "Explain a concept",
    detail: "Recursion, pointers, complexity…",
    prompt: "Explain recursion with a small Python example and a diagram of the call stack.",
  },
  {
    title: "Solve an exercise",
    detail: "Write, run and test the code",
    prompt:
      "Look at the problems in this folder, pick one, write a solution, and run it against its tests.",
  },
  {
    title: "Review my code",
    detail: "Find bugs and suggest fixes",
    prompt: "Review the code in this folder for bugs and explain the most important fix. Do not modify files yet.",
  },
  {
    title: "Explore this folder",
    detail: "What is here and how it fits",
    prompt: "Explore this folder and summarise what it contains.",
  },
];

function FolderHome() {
  const { folderId } = useParams({ from: "/f/$folderId" });
  const { folder, folders } = useFolder(folderId);
  const navigate = useNavigate();
  const client = useQueryClient();
  const [thinking, setThinking] = useThinking();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  if (folders.isSuccess && !folder)
    return (
      <div className="center-state">
        <h2>Folder not found</h2>
        <Link to="/f/$folderId" params={{ folderId: "default" }} className="button primary">
          Back to workspace
        </Link>
      </div>
    );
  async function start(text: string) {
    setError("");
    try {
      const { id } = await post<{ id: string }>(
        `/api/folders/${encodeURIComponent(folderId)}/chats`,
      );
      pendingPrompts.set(id, text);
      void client.invalidateQueries({ queryKey: ["chats", folderId] });
      await navigate({
        to: "/f/$folderId/c/$chatId",
        params: { folderId, chatId: id },
      });
    } catch (e) {
      setError(errorMessage(e));
      throw e;
    }
  }
  return (
    <div className="chat-page">
      <div className="scroll">
        <div className="welcome">
          <div className="welcome-mark">
            flashlet<span>·</span>
          </div>
          <h1>What are we working on?</h1>
          <p className="muted">
            Chats in <strong>{folder?.name || "…"}</strong> run with{" "}
            <code>{folder?.path}</code> as the workspace.
          </p>
          <div className="suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s.title} type="button" onClick={() => setDraft(s.prompt)}>
                <strong>{s.title}</strong>
                <small>{s.detail}</small>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="composer-wrap">
        {error && <div className="notice error">{error}</div>}
        <Composer
          busy={false}
          folderName={folder?.name || ""}
          thinking={thinking}
          onThinking={setThinking}
          onSend={start}
          onStop={() => {}}
          autoFocus
          initial={draft}
        />
      </div>
    </div>
  );
}

// ---------- chat ----------
function ChatPage() {
  const { folderId, chatId } = useParams({ from: "/f/$folderId/c/$chatId" });
  const { folder } = useFolder(folderId);
  const navigate = useNavigate();
  const chat = useChat(chatId);
  const [thinking, setThinking] = useThinking();
  const applied = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    applied.current = chat.transcript.data?.thinking ?? null;
  }, [chat.transcript.data]);

  const send = useCallback(
    async (text: string) => {
      if (applied.current !== thinking) {
        await post(`/api/sessions/${encodeURIComponent(chatId)}/thinking`, {
          level: thinking,
        });
        applied.current = thinking;
      }
      stick.current = true;
      await chat.send(text);
    },
    [chat.send, chatId, thinking],
  );

  // Send the prompt typed on the folder home once this new chat is ready.
  useEffect(() => {
    const text = pendingPrompts.get(chatId);
    if (text && chat.transcript.isSuccess) {
      pendingPrompts.delete(chatId);
      void send(text).catch(() => {});
    }
  }, [chatId, chat.transcript.isSuccess, send]);

  // Follow the stream unless the user scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat.messages]);

  if (chat.transcript.error) {
    const missing =
      chat.transcript.error instanceof ApiError &&
      chat.transcript.error.status === 404;
    return (
      <div className="center-state">
        <h2>{missing ? "Chat not found" : "Could not load this chat"}</h2>
        <p className="muted">{errorMessage(chat.transcript.error)}</p>
        <button
          className="button primary"
          onClick={() => navigate({ to: "/f/$folderId", params: { folderId } })}
        >
          Start a new chat
        </button>
      </div>
    );
  }
  const lastIndex = chat.messages.length - 1;
  return (
    <div className="chat-page">
      <div
        className="scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="thread">
          {chat.transcript.isLoading && <div className="muted center">Loading chat…</div>}
          {chat.messages.map((message, i) => (
            <Message
              key={i}
              message={message}
              live={chat.busy && i === lastIndex}
              thinkingStart={chat.thinkingStart}
            />
          ))}
          {chat.transcript.isSuccess && !chat.messages.length && !chat.busy && (
            <div className="muted center">Send a message to start.</div>
          )}
        </div>
      </div>
      <div className="composer-wrap">
        {chat.error && <div className="notice error">{chat.error}</div>}
        <Composer
          busy={chat.busy}
          folderName={folder?.name || ""}
          thinking={thinking}
          onThinking={setThinking}
          onSend={send}
          onStop={chat.stop}
          autoFocus
        />
      </div>
    </div>
  );
}

// ---------- router ----------
const rootRoute = createRootRoute({ component: Layout });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/f/$folderId", params: { folderId: "default" } });
  },
});
const folderRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/f/$folderId",
  component: FolderHome,
});
const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/f/$folderId/c/$chatId",
  component: ChatPage,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, folderRoute, chatRoute]),
  defaultNotFoundComponent: () => (
    <div className="center-state">
      <h2>Page not found</h2>
      <Link to="/" className="button primary">
        Home
      </Link>
    </div>
  ),
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 5000 } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
