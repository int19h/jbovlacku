import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const apiPort = process.env.JVC_TEST_API_PORT ?? "8797";
const webPort = process.env.JVC_WEB_PORT ?? "5177";
// The fixture server's readiness listener. It answers 200 only after every
// fixture record is admitted and the fixture file is written.
const readyPort = process.env.JVC_READY_PORT ?? String(Number(apiPort) + 1000);
import { rmSync } from "node:fs";
const testRoot = resolve(process.env.JVC_TEST_ROOT ?? tmpdir(), "browser-run");
// The runner process clears the previous run. Worker processes reuse the same paths.
if (process.env.TEST_WORKER_INDEX === undefined)
  rmSync(testRoot, { recursive: true, force: true });
process.env.JVC_FIXTURE_FILE = resolve(testRoot, "fixture.json");
export default defineConfig({
  testDir: "./test",
  testMatch: /.*\.test\.ts/,
  timeout: 90000,
  expect: { timeout: 10000 },
  workers: 1,
  reporter: "list",
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
      command: "npm run dev:web",
      url: `http://127.0.0.1:${webPort}`,
      env: {
        JVC_WEB_API_TARGET: `http://127.0.0.1:${apiPort}`,
        JVC_WEB_PORT: webPort,
      },
      reuseExistingServer: false,
    },
  ],
});
