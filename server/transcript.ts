import type { ChatBlock, ChatMessage } from "../shared/api.ts";

type Part = { type: string; [key: string]: unknown };
type AnyMessage = {
  role: string;
  content?: unknown;
  toolCallId?: string;
  isError?: boolean;
  errorMessage?: string;
};

const MAX_RESULT = 20000;

/** Flatten a Pi tool result ({content:[{type:"text"}]}) or raw value to display text. */
export function toolResultText(result: unknown): string {
  const content =
    result && typeof result === "object" && "content" in result
      ? (result as { content: unknown }).content
      : result;
  let text: string;
  if (Array.isArray(content))
    text = content
      .map((p: Part) =>
        p?.type === "text" ? String(p.text) : p?.type ? `[${p.type}]` : "",
      )
      .join("\n");
  else if (typeof content === "string") text = content;
  else text = JSON.stringify(content ?? null, null, 2);
  return text.length > MAX_RESULT
    ? `${text.slice(0, MAX_RESULT)}\n… (${text.length - MAX_RESULT} more characters)`
    : text;
}

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((p: Part) => (p?.type === "text" ? String(p.text) : "[image]"))
      .join("\n");
  return "";
}

/**
 * Convert Pi agent messages to UI messages. Consecutive assistant and
 * tool-result messages from one run are merged into a single assistant turn so
 * the UI shows thinking → tool → text in order.
 */
export function toChatMessages(messages: readonly unknown[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const tools = new Map<string, Extract<ChatBlock, { type: "tool" }>>();
  const assistant = () => {
    let last = out.at(-1);
    if (!last || last.role !== "assistant") {
      last = { role: "assistant", blocks: [] };
      out.push(last);
    }
    return last;
  };
  for (const raw of messages) {
    const message = raw as AnyMessage;
    if (message.role === "user") {
      out.push({
        role: "user",
        blocks: [{ type: "text", text: userText(message.content) }],
      });
    } else if (message.role === "assistant") {
      const turn = assistant();
      for (const part of (message.content as Part[]) || []) {
        if (part.type === "text" && String(part.text).trim())
          turn.blocks.push({ type: "text", text: String(part.text) });
        else if (part.type === "thinking" && String(part.thinking).trim())
          turn.blocks.push({ type: "thinking", text: String(part.thinking) });
        else if (part.type === "toolCall") {
          const block = {
            type: "tool" as const,
            id: String(part.id),
            name: String(part.name),
            args: part.arguments,
            done: false,
          };
          tools.set(block.id, block);
          turn.blocks.push(block);
        }
      }
      if (message.errorMessage)
        turn.blocks.push({ type: "error", text: message.errorMessage });
    } else if (message.role === "toolResult") {
      const block = tools.get(String(message.toolCallId));
      if (block) {
        block.result = toolResultText(message);
        block.error = !!message.isError;
        block.done = true;
      }
    }
  }
  return out;
}

export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || "New chat";
}
