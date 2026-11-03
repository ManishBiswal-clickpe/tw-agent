import http from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../server/index.js";
import { readConfig } from "../server/config.js";
import { previewFile, listFiles } from "../server/files.js";
import { startMockModel } from "./mock-model.js";

test("configuration validates endpoint and limits", () => {
  assert.throws(() => readConfig({ PORT: "-1" }));
  assert.throws(() => readConfig({ FLASHLET_MODEL_BASE_URL: "file:///etc" }));
  assert.throws(() =>
    readConfig({ FLASHLET_CONTEXT_WINDOW: "10", FLASHLET_MAX_TOKENS: "20" }),
  );
  assert.equal(readConfig({}).allowWrites, false);
});
test("file preview rejects traversal, secrets, binary and escaped symlinks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flashlet-files-"));
  try {
    await writeFile(path.join(root, "safe.txt"), "hello");
    await writeFile(path.join(root, ".env"), "secret");
    await writeFile(path.join(root, "binary"), "\0test");
    await symlink("/etc/passwd", path.join(root, "escape"));
    assert.equal((await previewFile(root, "safe.txt")).content, "hello");
    for (const file of [
      "../outside",
      "/etc/passwd",
      ".env",
      "escape",
      "binary",
    ])
      await assert.rejects(previewFile(root, file));
    assert.deepEqual(
      (await listFiles(root)).map((f) => f.name),
      ["binary", "safe.txt"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("real Pi SDK: session, SSE text, tool loop, busy rejection, abort, security and cleanup", async () => {
  const mock = await startMockModel();
  const config = readConfig({ FLASHLET_MODEL_BASE_URL: mock.url });
  const workbench = createApp(config);
  const server = await new Promise((resolve) => {
    const s = workbench.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  config.port = server.address().port;
  const base = `http://127.0.0.1:${config.port}`;
  const headers = {
    Host: `127.0.0.1:${config.port}`,
    "Content-Type": "application/json",
    "X-Flashlet-Client": "workbench",
  };
  const request = (url, options = {}) =>
    fetch(base + url, {
      ...options,
      headers: { ...headers, ...options.headers },
    });
  let reader;
  try {
    const badHost = await new Promise((resolve) => {
      http.get(
        base + "/api/config",
        { headers: { Host: "evil.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
    });
    assert.equal(badHost, 403);
    assert.equal(
      (
        await request("/api/sessions", {
          method: "POST",
          headers: { Origin: "https://evil.example" },
          body: "{}",
        })
      ).status,
      403,
    );
    const safe = await (await request("/api/config")).json();
    assert.equal(safe.apiKey, undefined);
    const { id } = await (
      await request("/api/sessions", { method: "POST", body: "{}" })
    ).json();
    assert.ok(id, "Session creation failed");
    const stream = await request(`/api/sessions/${id}/events`);
    reader = stream.body.getReader();
    assert.equal(
      (
        await request(`/api/sessions/${id}/prompt`, {
          method: "POST",
          body: JSON.stringify({ text: "inspect the package" }),
        })
      ).status,
      202,
    );
    let events = "";
    const decoder = new TextDecoder();
    while (!events.includes("event: run_end")) {
      const { value, done } = await reader.read();
      if (done) break;
      events += decoder.decode(value);
    }
    assert.match(events, /event: delta/);
    assert.match(events, /event: tool_start/);
    assert.match(events, /event: tool_end/);
    assert.doesNotMatch(events, /event: run_error/);
    assert.ok(
      mock.requests.some((r) => r.messages.some((m) => m.role === "tool")),
    );
    assert.equal(mock.requests[0].model, "local-model");
    assert.equal(
      (
        await request(`/api/sessions/${id}/prompt`, {
          method: "POST",
          body: '{"text":"slow"}',
        })
      ).status,
      202,
    );
    assert.equal(
      (
        await request(`/api/sessions/${id}/prompt`, {
          method: "POST",
          body: '{"text":"again"}',
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request(`/api/sessions/${id}/abort`, {
          method: "POST",
          body: "{}",
        })
      ).status,
      200,
    );
    await reader.cancel();
    reader = null;
    assert.equal(
      (await request(`/api/sessions/${id}`, { method: "DELETE" })).status,
      204,
    );
    assert.equal(
      (
        await request(`/api/sessions/${id}/prompt`, {
          method: "POST",
          body: '{"text":"gone"}',
        })
      ).status,
      404,
    );
  } finally {
    await reader?.cancel();
    await workbench.close();
    await new Promise((resolve) => server.close(resolve));
    await mock.close();
  }
});
