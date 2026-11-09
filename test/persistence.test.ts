import http from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../server/index.ts";
import { readConfig } from "../server/config.ts";
import { startMockModel } from "./mock-model.ts";

async function boot(dataDir: string, baseUrl: string) {
  const config = {
    ...readConfig({ FLASHLET_MODEL_BASE_URL: baseUrl, FLASHLET_THINKING: "high" }),
    dataDir,
  };
  const workbench = createApp(config);
  const server = await new Promise<http.Server>((resolve) => {
    const s = workbench.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  config.port = (server.address() as import("node:net").AddressInfo).port;
  const base = `http://127.0.0.1:${config.port}`;
  const request = (url: string, options: RequestInit = {}) =>
    fetch(base + url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "X-Flashlet-Client": "workbench",
        ...options.headers,
      },
    });
  return {
    request,
    async close() {
      await workbench.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("folders and chats persist across restart; thinking is streamed and saved", async () => {
  const mock = await startMockModel();
  const dataDir = await mkdtemp(path.join(tmpdir(), "flashlet-data-"));
  const folderDir = await mkdtemp(path.join(tmpdir(), "flashlet-folder-"));
  let app = await boot(dataDir, mock.url);
  try {
    // Folder validation and creation
    assert.equal(
      (await app.request("/api/folders", { method: "POST", body: '{"path":"relative"}' })).status,
      400,
    );
    const folder = await (
      await app.request("/api/folders", {
        method: "POST",
        body: JSON.stringify({ path: folderDir, name: "Lab 3" }),
      })
    ).json();
    assert.equal(folder.name, "Lab 3");

    // Chat in that folder with a thinking + tool run
    const { id } = await (
      await app.request(`/api/folders/${folder.id}/chats`, { method: "POST", body: "{}" })
    ).json();
    const prompt = await app.request(`/api/sessions/${id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "think, then inspect the package" }),
    });
    assert.equal(prompt.status, 202);
    const { after } = await prompt.json();
    const reader = (await app.request(`/api/sessions/${id}/events?after=${after}`)).body!.getReader();
    let events = "";
    const decoder = new TextDecoder();
    while (!events.includes("event: run_end")) {
      const { value, done } = await reader.read();
      if (done) break;
      events += decoder.decode(value);
    }
    await reader.cancel();
    assert.match(events, /event: run_start/);
    assert.match(events, /event: thinking/);
    assert.match(events, /event: tool_start/);

    const chats = (await (await app.request(`/api/folders/${folder.id}/chats`)).json()).chats;
    assert.equal(chats[0].id, id);
    assert.equal(chats[0].title, "think, then inspect the package");

    // Restart: folder and chat come back from disk without starting an agent
    await app.close();
    app = await boot(dataDir, mock.url);
    const folders = (await (await app.request("/api/folders")).json()).folders;
    assert.ok(folders.some((f: { id: string }) => f.id === folder.id));
    const transcript = await (await app.request(`/api/sessions/${id}`)).json();
    assert.equal(transcript.folderId, folder.id);
    assert.equal(transcript.busy, false);
    const assistant = transcript.messages.find((m: { role: string }) => m.role === "assistant");
    const kinds = assistant.blocks.map((b: { type: string }) => b.type);
    assert.deepEqual(kinds.slice(0, 2), ["thinking", "tool"]);
    assert.ok(kinds.includes("text"));
    assert.equal(assistant.blocks[1].done, true);

    // A saved chat can be continued after restart
    const again = await app.request(`/api/sessions/${id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "thanks" }),
    });
    assert.equal(again.status, 202);
    await new Promise((r) => setTimeout(r, 300));

    // Deleting removes the file
    assert.equal((await app.request(`/api/sessions/${id}`, { method: "DELETE" })).status, 204);
    assert.equal((await app.request(`/api/sessions/${id}`)).status, 404);
    const files = await readdir(path.join(dataDir, "chats", folder.id)).catch(() => []);
    assert.equal(files.filter((f) => f.endsWith(".jsonl")).length, 0);

    // Removing a folder only hides it
    assert.equal((await app.request(`/api/folders/${folder.id}`, { method: "DELETE" })).status, 204);
    assert.equal((await app.request("/api/folders/default", { method: "DELETE" })).status, 400);
  } finally {
    await app.close();
    await mock.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(folderDir, { recursive: true, force: true });
  }
});
