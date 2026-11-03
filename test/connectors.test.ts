import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ConnectorStore,
  validateConnector,
  mayCallMcp,
} from "../server/connectors.ts";
import { createLocalAgent } from "../server/agent.js";
import { readConfig } from "../server/config.js";

test("validation keeps secrets private, rejects executable interpolation and unsafe URLs", async () => {
  for (const body of [
    { name: "x", url: "file:///etc" },
    { name: "x", url: "http://remote.test/mcp" },
    { name: "x", url: "https://user:pass@remote.test" },
    {
      name: "x",
      url: "https://safe.test",
      headers: { Authorization: "!echo evil" },
    },
    { name: "x", command: "node", env: { TOKEN: "!echo evil" } },
  ])
    assert.throws(() => validateConnector(body));
  const dir = await mkdtemp(path.join(tmpdir(), "flashlet-test-"));
  try {
    const store = new ConnectorStore(dir);
    await store.load();
    store.entries = [
      validateConnector({
        name: "gmail",
        preset: "gmail",
        token: "test-secret",
        readOnly: false,
      }),
    ];
    await store.save();
    assert.equal(
      (await stat(path.join(dir, "connectors.json"))).mode & 0o777,
      0o600,
    );
    assert.ok(!JSON.stringify(store.publicList()).includes("test-secret"));
    assert.equal(store.entries[0].readOnly, false);
    store.entries[0].readOnly = true;
    const writableGmail = validateConnector({
      name: "personal-gmail",
      preset: "gmail",
      command: process.execPath,
      args: [],
    });
    assert.equal(writableGmail.readOnly, false);
    assert.equal(
      mayCallMcp(
        "mcp__personal_gmail__send_email",
        undefined,
        [writableGmail],
        false,
      ),
      true,
    );
    writableGmail.readOnly = true;
    assert.equal(
      mayCallMcp(
        "mcp__personal_gmail__send_email",
        undefined,
        [writableGmail],
        true,
      ),
      false,
    );
    const entry = store.entries[0];
    assert.equal(
      mayCallMcp("mcp__gmail__search_threads", undefined, [entry], false),
      true,
    );
    assert.equal(
      mayCallMcp(
        "mcp__gmail__create_draft",
        { readOnlyHint: true },
        [entry],
        true,
      ),
      false,
    );
    assert.equal(
      mayCallMcp("mcp__missing__read", { readOnlyHint: true }, [entry], true),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("real Pi MCP extension discovers stdio tools and gate blocks unknown/write tools", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "flashlet-mcp-"));
  let agent: Awaited<ReturnType<typeof createLocalAgent>> | undefined;
  try {
    const store = new ConnectorStore(dir);
    await store.load();
    store.entries = [
      validateConnector({
        name: "test",
        command: process.execPath,
        args: [path.resolve("test/mock-mcp.mjs")],
      }),
    ];
    const config: any = { ...readConfig(), connectors: store };
    agent = await createLocalAgent(config);
    await agent.session.prompt("/mcp reconnect test");
    const tools = agent.session
      .getAllTools()
      .filter((t: any) => t.name.startsWith("mcp__"));
    assert.equal(tools.length, 3);
    assert.ok(agent.session.getActiveToolNames().includes("tool_search"));
    for (const tool of tools)
      assert.equal(
        mayCallMcp(tool.name, tool.annotations, store.entries, false),
        tool.name.endsWith("search_threads"),
      );
    assert.ok(tools.some((t: any) => t.annotations?.readOnlyHint === true));
    const blocked = await agent.session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolName: "mcp__test__create_draft",
      toolCallId: "check",
      input: {},
    } as any);
    assert.equal(blocked?.block, true);
    const allowed = await agent.session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolName: "mcp__test__search_threads",
      toolCallId: "check",
      input: {},
    } as any);
    assert.notEqual(allowed?.block, true);
  } finally {
    await agent?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
