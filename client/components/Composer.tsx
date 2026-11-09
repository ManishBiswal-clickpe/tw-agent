import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.tsx";

export const THINKING_OPTIONS = [
  ["off", "Thinking off"],
  ["low", "Think: low"],
  ["medium", "Think: medium"],
  ["high", "Think: high"],
] as const;

export function Composer({
  busy,
  folderName,
  thinking,
  onThinking,
  onSend,
  onStop,
  autoFocus,
  initial = "",
}: {
  busy: boolean;
  folderName: string;
  thinking: string;
  onThinking: (level: string) => void;
  onSend: (text: string) => Promise<unknown> | void;
  onStop: () => void;
  autoFocus?: boolean;
  initial?: string;
}) {
  const [text, setText] = useState(initial);
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setText(initial), [initial]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);
  useEffect(() => {
    if (autoFocus && !busy) ref.current?.focus();
  }, [autoFocus, busy]);
  async function submit() {
    const value = text.trim();
    if (!value || busy || sending) return;
    setSending(true);
    try {
      await onSend(value);
      setText("");
    } catch {
      /* error shown by the page; keep the draft */
    } finally {
      setSending(false);
    }
  }
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea
        ref={ref}
        rows={1}
        maxLength={16000}
        value={text}
        placeholder="Ask a question, explain a concept, solve an exercise…"
        aria-label="Message"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="composer-bar">
        <span className="pill" title="Folder this chat runs in">
          <Icon name="folder" size={13} /> {folderName}
        </span>
        <select
          className="pill select"
          value={thinking}
          onChange={(e) => onThinking(e.target.value)}
          aria-label="Thinking level"
        >
          {THINKING_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <span className="hint">Enter to send · Shift+Enter for a new line</span>
        {busy ? (
          <button type="button" className="send stop" onClick={onStop} aria-label="Stop">
            <Icon name="stop" />
          </button>
        ) : (
          <button
            type="submit"
            className="send"
            disabled={!text.trim() || sending}
            aria-label="Send"
          >
            <Icon name="send" />
          </button>
        )}
      </div>
    </form>
  );
}
