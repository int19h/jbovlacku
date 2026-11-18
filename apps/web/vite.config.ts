import { defineConfig, searchForWorkspaceRoot, type Plugin } from "vite";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const generated = fileURLToPath(
  new URL("../../packages/core/generated", import.meta.url),
);
const testRoot =
  process.env.JVC_PLAYWRIGHT_RUN_ROOT ?? process.env.JVC_TEST_ROOT;
const testPlugins: Plugin[] = process.env.JVC_PLAYWRIGHT_RUN_ROOT
  ? [
      {
        name: "test-firefox-no-revalidate",
        configureServer(server) {
          server.middlewares.use((req, _res, next) => {
            const agent = req.headers["user-agent"];
            if (typeof agent === "string" && agent.includes("Firefox/"))
              delete req.headers["if-none-match"];
            next();
          });
        },
      },
    ]
  : [];
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  cacheDir: testRoot
    ? resolve(testRoot, "vite-cache")
    : fileURLToPath(new URL("../../.cache/vite", import.meta.url)),
  plugins: testPlugins,
  build: { outDir: "dist", emptyOutDir: true },
  optimizeDeps: { include: ["jose"] },
  server: {
    fs: {
      allow: [
        searchForWorkspaceRoot(
          fileURLToPath(new URL("../..", import.meta.url)),
        ),
        ...(existsSync(generated) ? [realpathSync(generated)] : []),
      ],
    },
    host: "127.0.0.1",
    port: Number(process.env.JVC_WEB_PORT ?? 5177),
    strictPort: true,
    proxy: {
      "/api": process.env.JVC_WEB_API_TARGET ?? "http://127.0.0.1:8789",
    },
  },
});
