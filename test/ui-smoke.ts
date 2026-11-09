// Browser smoke test for the React workbench against the deterministic mock model.
// Covers: folders, chats, thinking, tools, persistence across reload, stop, mobile.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { createApp } from "../server/index.ts";
import { readConfig } from "../server/config.ts";
import { startMockModel } from "./mock-model.ts";

await mkdir("test-results", { recursive: true });
const dataDir = await mkdtemp(path.join(tmpdir(), "flashlet-ui-data-"));
const extraFolder = await mkdtemp(path.join(tmpdir(), "flashlet-ui-folder-"));
const mock = await startMockModel();
const config = {
  ...readConfig({
    PORT: "3210",
    FLASHLET_WORKSPACE: process.cwd(),
    FLASHLET_MODEL_BASE_URL: mock.url,
    FLASHLET_THINKING: "high",
  }),
  dataDir,
};
const workbench = createApp(config);
const server = workbench.app.listen(3210, "127.0.0.1");
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto("http://127.0.0.1:3210");
  await page.locator(".welcome").waitFor();
  await page.locator(".tree-row", { hasText: "package.json" }).waitFor();
  await page.screenshot({ path: "test-results/desktop-welcome.png" });

  // File preview
  await page.locator(".tree-row", { hasText: "package.json" }).click();
  await page.locator(".preview .code-view").filter({ hasText: "flashlet" }).waitFor();

  // New chat: thinking + tool + answer
  await page.getByLabel("Message").fill("think, then inspect the package");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/f\/default\/c\//);
  await page.getByText("Ready for your next step.").waitFor();
  await page.locator(".thinking").waitFor();
  await page.locator(".tool", { hasText: "read" }).waitFor();
  await page.locator(".send.stop").waitFor({ state: "detached" });
  await page.screenshot({ path: "test-results/desktop-chat.png" });

  // Persistence: reload restores the same chat from disk
  const chatUrl = page.url();
  await page.reload();
  await page.getByText("Ready for your next step.").waitFor();
  await page.locator(".thinking").waitFor();
  if (page.url() !== chatUrl) throw Error("Reload changed the chat URL");
  if (!(await page.locator(".chat-row.active").count()))
    throw Error("Saved chat missing from sidebar");

  // Changes tab
  await page.getByRole("tab", { name: "Changes" }).click();
  await page.locator(".diff").filter({ hasText: "Tracked changes" }).waitFor();

  // Add a folder, start a chat there, stop a slow run
  await page.locator('button[title="Add folder"]').click();
  await page.getByLabel("Absolute path").fill(extraFolder);
  await page.locator(".modal button[type=submit]").click();
  await page.locator(".folder-name", { hasText: path.basename(extraFolder) }).waitFor();
  await page.getByLabel("Message").fill("slow request");
  await page.keyboard.press("Enter");
  await page.locator(".send.stop").click();
  await page.locator(".send.stop").waitFor({ state: "detached" });

  // Mobile: sidebar opens as a drawer
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("Open sidebar").click();
  await page.locator(".nav-open .sidebar").waitFor();
  await page.screenshot({ path: "test-results/mobile-sidebar.png" });

  if (errors.length) throw Error(errors.join("\n"));
  console.log(
    "Folders, chats, thinking, tools, persistence across reload, diff, stop and mobile layout verified",
  );
} finally {
  await browser.close();
  await workbench.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await mock.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(extraFolder, { recursive: true, force: true });
}
