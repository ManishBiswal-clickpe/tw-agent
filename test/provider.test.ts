import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { providerConfig } from "../server/provider.ts";
import { readConfig } from "../server/config.js";
import { createLocalAgent } from "../server/agent.js";

test("generic provider sends deployment, custom api-key and api-version on the wire", async () => {
  let captured: any;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    captured = { url: req.url, headers: req.headers, body: JSON.parse(raw) };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      "data: " +
        JSON.stringify({
          id: "test",
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "Transport works" },
              finish_reason: "stop",
            },
          ],
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  let agent: any;
  try {
    const config: any = readConfig({
      FLASHLET_MODEL_BASE_URL: `http://127.0.0.1:${port}/openai/v1`,
      FLASHLET_MODEL_ID: "my-deployment",
      FLASHLET_MODEL_API_KEY: "test-key",
      FLASHLET_MODEL_AUTH_HEADER: "api-key",
      FLASHLET_MODEL_API_VERSION: "test-version",
    });
    agent = await createLocalAgent(config);
    await agent.session.prompt("hello");
    assert.equal(
      captured.url,
      "/openai/v1/chat/completions?api-version=test-version",
    );
    assert.equal(captured.headers["api-key"], "test-key");
    assert.equal(captured.headers.authorization, undefined);
    assert.equal(captured.body.model, "my-deployment");
    assert.equal(agent.session.getLastAssistantText(), "Transport works");
  } finally {
    await agent?.dispose();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("generic Responses transport uses /responses and bearer authentication", async () => {
  let captured: any;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    captured = { url: req.url, headers: req.headers, body: JSON.parse(raw) };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const message = {
      id: "msg_test",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        { type: "output_text", text: "Responses works", annotations: [] },
      ],
    };
    const response = {
      id: "resp_test",
      object: "response",
      created_at: 1,
      model: "deployment",
      status: "completed",
      output: [message],
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    };
    for (const event of [
      {
        type: "response.created",
        response: { ...response, status: "in_progress", output: [] },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...message, status: "in_progress", content: [] },
      },
      {
        type: "response.content_part.added",
        output_index: 0,
        content_index: 0,
        item_id: "msg_test",
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        item_id: "msg_test",
        delta: "Responses works",
      },
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.completed", response },
    ])
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  let agent: any;
  try {
    agent = await createLocalAgent(
      readConfig({
        FLASHLET_MODEL_BASE_URL: `http://127.0.0.1:${(server.address() as any).port}/openai/v1`,
        FLASHLET_MODEL_ID: "deployment",
        FLASHLET_MODEL_API: "responses",
        FLASHLET_MODEL_API_KEY: "test-bearer",
      }),
    );
    await agent.session.prompt("hello");
    assert.equal(captured.url, "/openai/v1/responses");
    assert.equal(captured.headers.authorization, "Bearer test-bearer");
    assert.equal(captured.body.model, "deployment");
    assert.equal(agent.session.getLastAssistantText(), "Responses works");
  } finally {
    await agent?.dispose();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
