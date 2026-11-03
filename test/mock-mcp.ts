import readline from "node:readline";
const tools = [
  {
    name: "search_threads",
    description: "Read mock mail",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create_draft",
    description: "Write mock mail",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: false },
  },
  {
    name: "unknown",
    description: "Unknown permissions",
    inputSchema: { type: "object", properties: {} },
  },
];
for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (!("id" in m)) continue;
  const result =
    m.method === "initialize"
      ? {
          protocolVersion: m.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "mock", version: "1" },
        }
      : m.method === "tools/list"
        ? { tools }
        : m.method === "tools/call"
          ? { content: [{ type: "text", text: "mock result" }] }
          : {};
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\n",
  );
}
