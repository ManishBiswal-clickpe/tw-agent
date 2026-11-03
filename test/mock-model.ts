// Deterministic OpenAI-compatible test fixture. No model weights or cloud calls.
import http from "node:http";
export async function startMockModel(port = 0) {
  const requests: {
    model: string;
    messages: { role: string; content: unknown }[];
  }[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const last = body.messages.at(-1);
    const text =
      typeof last?.content === "string"
        ? last.content
        : JSON.stringify(last?.content);
    if (text?.includes("slow"))
      await new Promise((resolve) => setTimeout(resolve, 2000));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    function chunk(delta: unknown, finish_reason: string | null = null) {
      res.write(
        `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    }
    chunk({ role: "assistant" });
    if (
      !body.messages.some((m: { role: string }) => m.role === "tool") &&
      text?.includes("codemode check")
    ) {
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_codemode",
            type: "function",
            function: {
              name: "codemode",
              arguments: JSON.stringify({
                code: "const read=await tools.mcp__test__search_threads({});let blocked=false;try{await tools.mcp__test__create_draft({})}catch{blocked=true;}return {read,blocked};",
              }),
            },
          },
        ],
      });
      chunk({}, "tool_calls");
    } else if (
      !body.messages.some((m: { role: string }) => m.role === "tool") &&
      text?.includes("inspect")
    ) {
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_read",
            type: "function",
            function: {
              name: "read",
              arguments: JSON.stringify({ path: "package.json" }),
            },
          },
        ],
      });
      chunk({}, "tool_calls");
    } else {
      for (const word of [
        "I inspected the workspace.\n\n",
        "This is a local browser workbench powered by the Pi SDK.\n\n",
        '```js\nconst next = "build something useful";\n```\n',
        "Ready for your next step.",
      ])
        chunk({ content: word });
      chunk({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  return {
    server,
    requests,
    url: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
