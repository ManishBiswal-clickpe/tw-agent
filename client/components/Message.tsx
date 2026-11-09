import { memo, useEffect, useState } from "react";
import type { ChatBlock } from "../../shared/api.ts";
import type { LiveMessage } from "../useChat.ts";
import { Markdown } from "./Markdown.tsx";
import { Icon } from "./Icon.tsx";

function ThinkingBlock({
  text,
  live,
  started,
}: {
  text: string;
  live: boolean;
  started: number | null;
}) {
  const [open, setOpen] = useState(live);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (live) setOpen(true);
  }, [live]);
  useEffect(() => {
    if (!live || !started) return;
    const tick = () => setElapsed(Math.round((Date.now() - started) / 1000));
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [live, started]);
  const words = text.trim().split(/\s+/).length;
  return (
    <div className={`thinking ${live ? "live" : ""} ${open ? "open" : ""}`}>
      <button
        type="button"
        className="thinking-head"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <Icon name="spark" />
        <span>
          {live ? "Thinking" : "Thought process"}
          {live && <span className="dots" aria-hidden="true" />}
        </span>
        <small>
          {live && started ? `${elapsed}s · ` : ""}
          {words} words
        </small>
        <Icon name={open ? "chevron-up" : "chevron-down"} />
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  );
}

function argSummary(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const pick =
    a.command ?? a.path ?? a.pattern ?? a.query ?? a.file ?? a.url ?? "";
  const text = typeof pick === "string" ? pick : JSON.stringify(pick);
  return text.length > 90 ? `${text.slice(0, 87)}…` : text;
}

const toolIcon: Record<string, string> = {
  bash: "terminal",
  read: "file",
  write: "edit",
  edit: "edit",
  ls: "folder",
  find: "search",
  grep: "search",
};

function ToolBlock({ block }: { block: Extract<ChatBlock, { type: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const summary = argSummary(block.name, block.args);
  const state = !block.done ? "running" : block.error ? "failed" : "done";
  return (
    <div className={`tool ${state}`}>
      <button
        type="button"
        className="tool-head"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <Icon name={toolIcon[block.name] || "tool"} />
        <strong>{block.name}</strong>
        <code>{summary}</code>
        <span className={`tool-state ${state}`}>
          {state === "running" ? <span className="spinner" /> : null}
          {state}
        </span>
        <Icon name={open ? "chevron-up" : "chevron-down"} />
      </button>
      {open && (
        <div className="tool-body">
          <div className="tool-label">Input</div>
          <pre>{JSON.stringify(block.args ?? {}, null, 2)}</pre>
          {block.done && (
            <>
              <div className="tool-label">{block.error ? "Error" : "Output"}</div>
              <pre>{block.result || "(no output)"}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export const Message = memo(function Message({
  message,
  live,
  thinkingStart,
}: {
  message: LiveMessage;
  live: boolean;
  thinkingStart: number | null;
}) {
  if (message.role === "user") {
    const text = message.blocks
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
    return (
      <article className={`msg user ${message.pending ? "pending" : ""}`}>
        <div className="bubble">{text}</div>
      </article>
    );
  }
  const lastIndex = message.blocks.length - 1;
  return (
    <article className="msg assistant">
      <div className="avatar" aria-hidden="true">
        f<span>·</span>
      </div>
      <div className="assistant-body">
        {message.blocks.map((block, i) => {
          if (block.type === "thinking")
            return (
              <ThinkingBlock
                key={i}
                text={block.text}
                live={live && i === lastIndex}
                started={thinkingStart}
              />
            );
          if (block.type === "tool") return <ToolBlock key={block.id} block={block} />;
          if (block.type === "error")
            return (
              <div key={i} className="run-error">
                <Icon name="alert" /> {block.text}
              </div>
            );
          return <Markdown key={i} text={block.text} />;
        })}
        {live && !message.blocks.length && (
          <div className="working">
            <span className="spinner" /> Working…
          </div>
        )}
      </div>
    </article>
  );
});
