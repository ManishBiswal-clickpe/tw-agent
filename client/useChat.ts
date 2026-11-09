import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChatBlock, ChatMessage, StreamEvents } from "../shared/api.ts";
import { post, queries } from "./api.ts";

export interface LiveMessage extends ChatMessage {
  pending?: boolean;
}

type Handler<K extends keyof StreamEvents> = (data: StreamEvents[K]) => void;

/** Append streamed text to the last block of the same kind, or start a new one. */
function appendText(
  messages: LiveMessage[],
  kind: "text" | "thinking",
  text: string,
): LiveMessage[] {
  const next = messages.slice();
  let last = next.at(-1);
  if (!last || last.role !== "assistant") {
    last = { role: "assistant", blocks: [] };
    next.push(last);
  } else next[next.length - 1] = last = { ...last, blocks: last.blocks.slice() };
  const block = last.blocks.at(-1);
  if (block?.type === kind)
    last.blocks[last.blocks.length - 1] = { ...block, text: block.text + text };
  else last.blocks.push({ type: kind, text });
  return next;
}

function updateAssistant(
  messages: LiveMessage[],
  fn: (blocks: ChatBlock[]) => ChatBlock[],
): LiveMessage[] {
  const next = messages.slice();
  const last = next.at(-1);
  if (!last || last.role !== "assistant")
    next.push({ role: "assistant", blocks: fn([]) });
  else next[next.length - 1] = { ...last, blocks: fn(last.blocks.slice()) };
  return next;
}

/**
 * Chat state = saved transcript + replayed/live SSE events. The stream is only
 * opened while a run is active, so viewing an old chat never starts an agent.
 */
export function useChat(chatId: string) {
  const client = useQueryClient();
  const transcript = useQuery(queries.transcript(chatId));
  const [messages, setMessages] = useState<LiveMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [thinkingStart, setThinkingStart] = useState<number | null>(null);
  const source = useRef<EventSource | null>(null);

  const close = useCallback(() => {
    source.current?.close();
    source.current = null;
  }, []);

  const refreshSide = useCallback(() => {
    for (const key of ["chats", "files", "diff", "file"])
      void client.invalidateQueries({ queryKey: [key] });
  }, [client]);

  const listen = useCallback(
    (after: number) => {
      close();
      const es = new EventSource(
        `/api/sessions/${encodeURIComponent(chatId)}/events?after=${after}`,
      );
      source.current = es;
      const on = <K extends keyof StreamEvents>(type: K, fn: Handler<K>) =>
        es.addEventListener(type, (event) =>
          fn(JSON.parse((event as MessageEvent).data)),
        );
      on("run_start", ({ text }) => {
        setBusy(true);
        setError("");
        setMessages((prev) => {
          const last = prev.at(-1);
          const base =
            last?.role === "user" && last.pending ? prev.slice(0, -1) : prev;
          return [
            ...base,
            { role: "user", blocks: [{ type: "text", text }] },
            { role: "assistant", blocks: [] },
          ];
        });
        void client.invalidateQueries({ queryKey: ["chats"] });
      });
      on("thinking", ({ text }) => {
        setThinkingStart((t) => t ?? Date.now());
        setMessages((prev) => appendText(prev, "thinking", text));
      });
      on("delta", ({ text }) =>
        setMessages((prev) => appendText(prev, "text", text)),
      );
      on("tool_start", ({ id, name, args }) =>
        setMessages((prev) =>
          updateAssistant(prev, (blocks) => [
            ...blocks,
            { type: "tool", id, name, args, done: false },
          ]),
        ),
      );
      on("tool_end", ({ id, error, result }) => {
        setMessages((prev) =>
          updateAssistant(prev, (blocks) =>
            blocks.map((b) =>
              b.type === "tool" && b.id === id
                ? { ...b, done: true, error, result }
                : b,
            ),
          ),
        );
        refreshSide();
      });
      on("run_error", ({ message }) =>
        setMessages((prev) =>
          updateAssistant(prev, (blocks) => [
            ...blocks,
            { type: "error", text: message },
          ]),
        ),
      );
      on("run_end", () => {
        setBusy(false);
        setThinkingStart(null);
        close();
        refreshSide();
      });
      es.onerror = () => {
        // EventSource retries on its own with Last-Event-ID; give up if the
        // session is gone (server restart drops in-flight runs).
        if (es.readyState === EventSource.CLOSED) {
          setBusy(false);
          setError("Lost connection to the agent. Reload to see the saved chat.");
        }
      };
    },
    [chatId, client, close, refreshSide],
  );

  useEffect(() => {
    const data = transcript.data;
    if (!data) return;
    setMessages(data.messages);
    setBusy(data.busy);
    setError("");
    if (data.busy) listen(data.after);
    return close;
  }, [transcript.data, listen, close]);

  const send = useCallback(
    async (text: string) => {
      setError("");
      setBusy(true);
      setMessages((prev) => [
        ...prev,
        { role: "user", blocks: [{ type: "text", text }], pending: true },
      ]);
      try {
        const { after } = await post<{ after: number }>(
          `/api/sessions/${encodeURIComponent(chatId)}/prompt`,
          { text },
        );
        listen(after);
      } catch (err) {
        setBusy(false);
        setMessages((prev) => prev.filter((m) => !m.pending));
        setError(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [chatId, listen],
  );

  const stop = useCallback(async () => {
    try {
      await post(`/api/sessions/${encodeURIComponent(chatId)}/abort`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [chatId]);

  return {
    transcript,
    messages,
    busy,
    error,
    thinkingStart,
    send,
    stop,
  };
}
