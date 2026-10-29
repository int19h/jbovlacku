import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const apiPort = process.env.JVC_TEST_API_PORT ?? "8797";
const webPort = process.env.JVC_WEB_PORT ?? "5177";
// The fixture server's readiness listener. It answers 200 only after every
// fixture record is admitted and the fixture file is written.
const readyPort = process.env.JVC_READY_PORT ?? String(Number(apiPort) + 1000);
import { mkdirSync, mkdtempSync } from "node:fs";
// The runner creates one directory. Workers inherit its exact path.
const parent = resolve(process.env.JVC_TEST_ROOT ?? tmpdir());
if (process.env.TEST_WORKER_INDEX === undefined) {
  mkdirSync(parent, { recursive: true });
  process.env.JVC_PLAYWRIGHT_RUN_ROOT = mkdtempSync(
    resolve(parent, "browser-run-"),
  );
}
const testRoot = process.env.JVC_PLAYWRIGHT_RUN_ROOT;
if (!testRoot) throw new Error("The Playwright worker has no run directory.");
process.env.JVC_FIXTURE_FILE = resolve(testRoot, "fixture.json");
export default defineConfig({
  testDir: "./test",
  testMatch: /.*\.test\.ts/,
  testIgnore: /\/unit\//,
  timeout: 90000,
  expect: { timeout: 10000 },
  workers: 1,
  reporter: "list",
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    {
      name: "firefox-editor",
      testMatch: /rich-editor(?:-r\d+)?\.test\.ts/,
      // Only this case requires Chromium's debugging protocol.
      grepInvert:
        /Chromium IME composition converts once and Backspace restores the token/,
      use: { browserName: "firefox" },
    },
    {
      name: "firefox-authoring",
      testMatch: /authoring\.test\.ts/,
      grep: /a first-time contributor writes a short literal definition|the full editor preserves every structured field/,
      use: { browserName: "firefox" },
    },
  ],
  outputDir: resolve(testRoot, "results"),
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    browserName: "chromium",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node --import tsx apps/web/test/server-fixture.ts",
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      url: `http://127.0.0.1:${readyPort}/ready`,
      env: {
        PORT: apiPort,
        JVC_READY_PORT: readyPort,
        HOST: "127.0.0.1",
        JVC_DATA_DIR: resolve(testRoot, "service"),
        JVC_SERVER_ID: "browser-test",
        JVC_PUBLIC_ORIGIN: `http://127.0.0.1:${webPort}`,
        JVC_FIXTURE: "seeded",
        JVC_FIXTURE_OUT: process.env.JVC_FIXTURE_FILE,
        JVC_FIXTURE_DELAY_MS: process.env.JVC_FIXTURE_DELAY_MS ?? "0",
      },
      reuseExistingServer: false,
      timeout: 120000,
    },
    {
      command: "npm run dev:web -- --configLoader runner",
      url: `http://127.0.0.1:${webPort}`,
      env: {
        JVC_WEB_API_TARGET: `http://127.0.0.1:${apiPort}`,
        JVC_WEB_PORT: webPort,
      },
      reuseExistingServer: false,
    },
  ],
});
