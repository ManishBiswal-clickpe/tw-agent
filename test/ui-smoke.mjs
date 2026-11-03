import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { createApp } from "../server/index.js";
import { readConfig } from "../server/config.js";
import { startMockModel } from "./mock-model.js";
await mkdir("test-results", { recursive: true });
const mock = await startMockModel();
const config = readConfig({
  PORT: "3210",
  FLASHLET_WORKSPACE: process.cwd(),
  FLASHLET_MODEL_BASE_URL: mock.url,
});
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
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto("http://127.0.0.1:3210");
  await page.getByText("package.json", { exact: true }).waitFor();
  await page.screenshot({
    path: "test-results/desktop-welcome.png",
    fullPage: true,
  });
  await page.getByText("package.json", { exact: true }).click();
  await page.locator("#file-content").filter({ hasText: "flashlet" }).waitFor();
  await page
    .getByLabel("Message your local agent")
    .fill("inspect the package and explain this project");
  await page.getByLabel("Send message").click();
  await page.getByText("Ready for your next step.", { exact: false }).waitFor();
  await page.locator("#stop").waitFor({ state: "hidden" });
  await page.screenshot({
    path: "test-results/desktop-running.png",
    fullPage: true,
  });
  await page.getByRole("tab", { name: "Changes" }).click();
  await page
    .locator("#diff-note")
    .filter({ hasText: "Tracked changes" })
    .waitFor();
  await page.getByRole("button", { name: "New task" }).click();
  await page.getByLabel("Message your local agent").fill("slow request");
  await page.getByLabel("Send message").click();
  await page.locator("#stop").click();
  await page.locator("#stop").waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#mobile-new").click();
  await page.locator("#prompt").waitFor();
  await page.locator("#mobile-tasks").selectOption({ index: 1 });
  await page.screenshot({
    path: "test-results/mobile-task.png",
    fullPage: true,
  });
  await page.reload();
  await page.locator("#welcome").waitFor();
  await page.screenshot({
    path: "test-results/mobile-welcome.png",
    fullPage: true,
  });
  await page.locator("#prompt").fill("<img src=x onerror=alert(1)>");
  await page.locator("#send").click();
  await page.getByText("Ready for your next step.", { exact: false }).waitFor();
  if (await page.locator("#messages img").count())
    throw new Error("Unsafe HTML rendering");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  console.log(
    JSON.stringify({
      errors,
      overflow,
      modelRequests: mock.requests.length,
      screenshots: 3,
    }),
  );
  if (errors.length || overflow) throw new Error("UI verification failed");
} finally {
  await browser.close();
  await workbench.close();
  await new Promise((r) => server.close(r));
  await mock.close();
}
