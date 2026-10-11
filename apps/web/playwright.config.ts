import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
export default defineConfig({
  testDir: "./test",
  timeout: 60000,
  workers: 1,
  reporter: "list",
  outputDir: "./test-results",
  use: {
    baseURL: "http://127.0.0.1:5177",
    browserName: "chromium",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node --import tsx apps/web/test/server-fixture.ts",
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      url: "http://127.0.0.1:8797/api/v1/capabilities",
      env: {
        PORT: "8797",
        HOST: "127.0.0.1",
        JVC_DATA_DIR: resolve(
          process.env.JVC_TEST_ROOT ?? tmpdir(),
          `service-${process.pid}`,
        ),
        JVC_SERVER_ID: "browser-test",
        JVC_PUBLIC_ORIGIN: "http://127.0.0.1:5177",
      },
      reuseExistingServer: false,
    },
    {
      command: "npm run dev:web",
      url: "http://127.0.0.1:5177",
      env: { JVC_WEB_API_TARGET: "http://127.0.0.1:8797" },
      reuseExistingServer: false,
    },
  ],
});
