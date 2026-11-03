import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { McpConfigFiles } from "../server/mcp-config.ts";
import { ConnectorStore } from "../server/connectors.ts";

test("native global/project mcp.json trust, masking, validation, stale saves and overrides", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flashlet-config-"));
  const dir = path.join(root, "private"),
    workspace = path.join(root, "project");
  await mkdir(dir);
  await mkdir(workspace);
  try {
    const files = new McpConfigFiles(dir, workspace);
    await files.initialize();
    await files.write("global", {
      mcpServers: {
        notes: {
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer secret-value" },
          exposure: "codemode",
        },
      },
    });
    const view = await files.view("global");
    assert.ok(!view.json.includes("secret-value"));
    assert.ok(view.json.includes("__FLASHLET_SECRET_UNCHANGED__"));
    await files.saveEditor(
      "global",
      view.json.replace('"codemode"', '"direct"'),
      view.revision,
    );
    assert.ok(
      (await readFile(files.path("global"), "utf8")).includes("secret-value"),
    );
    await assert.rejects(
      files.saveEditor("global", view.json, view.revision),
      /changed/,
    );
    await files.write("project", {
      mcpServers: {
        notes: { enabled: false },
        course: {
          command: process.execPath,
          args: ["--version"],
          env: { TOKEN: "${COURSE_TOKEN}" },
        },
      },
    });
    assert.equal(files.loaded().servers.length, 1);
    files.trust.set(workspace, true);
    const loaded = files.loaded();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.servers.length, 2);
    assert.equal(
      loaded.servers.find((e) => e.name === "notes")?.config.enabled,
      false,
    );
    assert.throws(
      () =>
        files.validate(
          {
            mcpServers: {
              x: {
                url: "https://example.com",
                headers: { Authorization: "literal-secret" },
              },
            },
          },
          "project",
        ),
      /environment/,
    );
    assert.throws(
      () =>
        files.validate(
          {
            mcpServers: {
              x: { command: "node", env: { KEY: "!echo unsafe" } },
            },
          },
          "global",
        ),
      /interpolation/,
    );
    assert.throws(() => files.parse("{broken"), SyntaxError);
    const store = new ConnectorStore(dir);
    await store.load();
    await store.attachFiles(files);
    assert.equal(
      store.effectiveEntries().find((e) => e.name === "course")?.readOnly,
      true,
    );
    await store.setReadOnly("course", false);
    assert.equal(
      store.effectiveEntries().find((e) => e.name === "course")?.readOnly,
      false,
    );
    await store.setEnabled("course", false);
    assert.equal(
      store.effectiveEntries().find((e) => e.name === "course")?.config.enabled,
      false,
    );
    files.trust.set(workspace, false);
    assert.ok(!store.effectiveEntries().some((e) => e.name === "course"));
    await rm(path.join(workspace, ".pi"), { recursive: true });
    await symlink(dir, path.join(workspace, ".pi"));
    await assert.rejects(files.view("project"), /symlink/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
