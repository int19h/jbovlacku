import { defineConfig, searchForWorkspaceRoot } from "vite";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const testRoot =
  process.env.JVC_PLAYWRIGHT_RUN_ROOT ?? process.env.JVC_TEST_ROOT;
export default defineConfig({
  cacheDir: testRoot ? resolve(testRoot, "vite-cache") : undefined,
  root: fileURLToPath(new URL(".", import.meta.url)),
  build: { outDir: "dist", emptyOutDir: true },
  optimizeDeps: { include: ["jose"] },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.JVC_WEB_PORT ?? 5177),
    strictPort: true,
    fs: {
      allow: [
        searchForWorkspaceRoot(process.cwd()),
        realpathSync(
          fileURLToPath(
            new URL("../../packages/core/generated", import.meta.url),
          ),
        ),
      ],
    },
    proxy: {
      "/api": process.env.JVC_WEB_API_TARGET ?? "http://127.0.0.1:8789",
    },
  },
});
