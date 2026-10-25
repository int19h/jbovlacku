import { defineConfig, searchForWorkspaceRoot } from "vite";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
const generated = fileURLToPath(
  new URL("../../packages/core/generated", import.meta.url),
);
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  cacheDir: fileURLToPath(new URL("../../.cache/vite", import.meta.url)),
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
