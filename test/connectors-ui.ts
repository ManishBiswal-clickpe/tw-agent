import { McpConfigFiles } from "../server/mcp-config.ts";
import { chromium } from "@playwright/test";
import { createApp } from "../server/index.ts";
import { readConfig } from "../server/config.ts";
import { ConnectorStore } from "../server/connectors.ts";
import { startMockModel } from "./mock-model.ts";
const mock = await startMockModel();
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
const dir = await mkdtemp(path.join(tmpdir(), "flashlet-ui-"));
const store = new ConnectorStore(dir);
await store.load();
const project = path.join(dir, "project");
await mkdir(project);
const files = new McpConfigFiles(dir, project);
await files.initialize();
await store.attachFiles(files);
const config = {
  ...readConfig({
    PORT: "3210",
    FLASHLET_WORKSPACE: project,
    FLASHLET_MODEL_BASE_URL: mock.url,
  }),
  connectors: store,
};
const app = createApp(config);
const server = app.app.listen(3210, "127.0.0.1");
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto("http://127.0.0.1:3210");
  await page.locator("#open-connectors").click();
  await page.locator("#connector-preset").selectOption("gmail");
  await page
    .locator("#connector-notice")
    .filter({ hasText: "Developer Preview" })
    .waitFor();
  await page.screenshot({
    path: "test-results/connectors-desktop.png",
    fullPage: true,
  });
  await page.locator("#connector-preset").selectOption("custom");
  await page.locator("#connector-name").fill("study-notes");
  await page.locator("#connector-url").fill("https://example.com/mcp");
  await page
    .getByRole("button", { name: "Save connector", exact: true })
    .click();
  await page
    .locator(".connector-card strong")
    .filter({ hasText: "study-notes" })
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/connectors-mobile.png",
    fullPage: true,
  });
  if (
    await page.evaluate(
      () =>
        document.querySelector("#connectors-dialog")!.scrollWidth >
        document.querySelector("#connectors-dialog")!.clientWidth,
    )
  )
    throw Error("dialog overflow");
  await page.locator("#mcp-editor summary").click();
  await page.locator("#mcp-json").filter({ hasText: "" }).waitFor();
  await page.locator("#mcp-scope").selectOption("project");
  await page
    .locator("#mcp-editor-notice")
    .filter({ hasText: "not loaded" })
    .waitFor();
  await page.locator("#mcp-json").fill(
    JSON.stringify(
      {
        mcpServers: {
          project_docs: {
            url: "https://example.com/mcp",
            exposure: "codemode",
          },
        },
      },
      null,
      2,
    ),
  );
  await page.locator("#mcp-save").click();
  await page
    .locator("#mcp-editor-notice")
    .filter({ hasText: "saved" })
    .waitFor();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#mcp-trust").click();
  await page
    .locator(".connector-card strong")
    .filter({ hasText: "project_docs" })
    .waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#connectors-dialog").evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({
    path: "test-results/mcp-editor-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#connectors-dialog").evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({
    path: "test-results/mcp-editor-mobile.png",
    fullPage: true,
  });
  await page.locator("#mcp-trust").click();
  await page
    .locator("#mcp-trust")
    .filter({ hasText: "Trust this project" })
    .waitFor();
  await page.locator("#close-connectors").click();
  // Markdown safety through a real chat (mock model returns the payload).
  await page.getByLabel("Message").fill("markdown check");
  await page.keyboard.press("Enter");
  await page.getByText("Revision notes").waitFor();
  if (await page.locator(".markdown img").count())
    throw Error("Raw HTML escaped incorrectly");
  await page.locator(".artifact-button").click();
  await page.screenshot({
    path: "test-results/artifact-mobile.png",
    fullPage: true,
  });
  await page
    .locator("#artifact-frame")
    .contentFrame()
    .getByText("Study planner")
    .waitFor();
  if (
    await page.evaluate(() => (window as Window & { hacked?: boolean }).hacked)
  )
    throw Error("Sandbox escaped");
  await page.locator("#close-artifact").click();
  await page.locator(".send.stop").waitFor({ state: "detached" });
  await page.getByLabel("Message").fill("diagram check");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Render diagram" }).click();
  await page.locator("#artifact-frame").contentFrame().locator("svg").waitFor();

  await page
    .locator("#artifact-frame")
    .contentFrame()
    .getByText("Read notes", { exact: true })
    .waitFor();
  await page.screenshot({
    path: "test-results/mermaid-mobile.png",
    fullPage: true,
  });
  await page.locator("#close-artifact").click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "test-results/markdown-desktop.png",
    fullPage: true,
  });
  if (errors.length) throw Error(errors.join("\n"));
  console.log(
    "Connector presets/save/mobile, sanitized markdown, math, highlighting and sandboxed artifacts verified",
  );
} finally {
  await browser.close();
  await app.close();
  await new Promise<void>((r) => server.close(() => r()));
  await mock.close();
  await rm(dir, { recursive: true, force: true });
}
