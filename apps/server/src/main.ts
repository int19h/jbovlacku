import { BROWSER_HEADERS } from "./security.ts";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { FileCheckpointStore } from "./checkpoint.ts";
import { sendResponseBody } from "./response.ts";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import {
  initializeCore,
  coreCheckpointVersion,
} from "../../../packages/core/src/index.ts";
import { DictionaryService } from "../../../packages/service/src/service.ts";
import { lockDataDirectory } from "../../../packages/importer/src/load-lock.ts";
import {
  checkLoadedView,
  readLoadedView,
  stateTraversalLimit,
} from "../../../packages/importer/src/load-config.ts";
import {
  durableDirectory,
  FileObjectStore,
  SqliteCoordinator,
  SqliteIndexStore,
} from "./storage.ts";
const directory = resolve(process.env.JVC_DATA_DIR ?? "data/node");
async function initializeService() {
  await durableDirectory(directory);
  const release = await lockDataDirectory(directory, "node-server");
  let index: SqliteIndexStore | undefined;
  let coordinator: SqliteCoordinator | undefined;
  try {
    const coreBytes = await readFile(
      new URL(
        "../../../packages/core/generated/jvc_runtime_bg.wasm",
        import.meta.url,
      ),
    );
    await initializeCore(coreBytes);
    const coreVersion = `${createHash("sha256").update(coreBytes).digest("hex")}:${coreCheckpointVersion()}:service-checkpoint-v1`;
    index = new SqliteIndexStore(join(directory, "indexes.sqlite"), true);
    coordinator = new SqliteCoordinator(
      join(directory, "coordinator.sqlite"),
      Number(process.env.JVC_SNAPSHOT_LIMIT ?? 16),
    );
    const objects = new FileObjectStore(join(directory, "objects"));
    const loadedView = await readLoadedView(directory);
    if (loadedView) await checkLoadedView(loadedView, coordinator, objects);
    const traversal = stateTraversalLimit(
      process.env.JVC_STATE_TRAVERSAL_LIMIT ??
        loadedView?.state_traversal_limit,
    );
    const service = new DictionaryService(objects, coordinator, {
      index,
      checkpoints: new FileCheckpointStore(
        join(directory, "evaluation-cache"),
        coordinator,
      ),
      coreVersion,
      asyncMaterialization: true,
      reportError:
        process.env.JVC_LOG_ERRORS === "enabled"
          ? (error) =>
              console.error(
                JSON.stringify({
                  event: "service_failure",
                  error: String(error),
                }),
              )
          : undefined,
      serverId: process.env.JVC_SERVER_ID ?? "local-node",
      selectedView: process.env.JVC_VIEW ?? loadedView?.view,
      stateLimits:
        traversal === undefined
          ? undefined
          : {
              events: 200_000,
              traversal,
              claim_depth: 1024,
            },
      allowPrototypeBatch: process.env.JVC_PROTOTYPE_BATCH === "enabled",
      policyUrl:
        process.env.JVC_POLICY_URL ??
        "https://example.invalid/jbovlacku-prototype-policy",
      publicOrigin: process.env.JVC_PUBLIC_ORIGIN,
      corsOrigins: (process.env.JVC_CORS_ORIGINS ?? "")
        .split(",")
        .filter(Boolean),
    });
    await service.initialize();
    return { service, index, coordinator, release };
  } catch (error) {
    coordinator?.close();
    index?.close();
    await release();
    throw error;
  }
}
const { service, index, coordinator, release } = await initializeService();
const assets = resolve(process.env.JVC_ASSETS_DIR ?? "apps/web/dist");
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};
const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(
      incoming.url ?? "/",
      `http://${incoming.headers.host ?? "localhost"}`,
    );
    if (!url.pathname.startsWith("/api/")) {
      for (const [name, value] of Object.entries(BROWSER_HEADERS))
        outgoing.setHeader(name, value);
      let path = resolve(assets, `.${decodeURIComponent(url.pathname)}`);
      if (!path.startsWith(assets + "/") && path !== assets) {
        outgoing.writeHead(403);
        outgoing.end();
        return;
      }
      try {
        if ((await stat(path)).isDirectory()) path = join(path, "index.html");
      } catch {
        path = join(assets, "index.html");
      }
      try {
        const bytes = await readFile(path);
        outgoing.writeHead(200, {
          "content-type": mime[extname(path)] ?? "application/octet-stream",
        });
        outgoing.end(bytes);
      } catch {
        outgoing.writeHead(404);
        outgoing.end("Browser assets are not built.");
      }
      return;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (value !== undefined)
        headers.set(key, Array.isArray(value) ? value.join(",") : value);
    }
    const init: RequestInit & { duplex?: string } = {
      method: incoming.method,
      headers,
    };
    let abandoned = false;
    if (incoming.method !== "GET" && incoming.method !== "HEAD") {
      const source = (
        Readable.toWeb(incoming, {
          strategy: { highWaterMark: 65536, size: (chunk) => chunk.length },
        }) as ReadableStream<Uint8Array>
      ).getReader();
      init.body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const value = await source.read();
          if (abandoned) return;
          if (value.done) controller.close();
          else controller.enqueue(value.value);
        },
        cancel() {
          abandoned = true;
          incoming.pause();
        },
      });
      init.duplex = "half";
    }
    const response = await service.fetch(new Request(url, init));
    if (abandoned) response.headers.set("connection", "close");
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) await sendResponseBody(response.body, outgoing);
    outgoing.end(() => {
      if (abandoned) incoming.destroy();
    });
  } catch (error) {
    console.error(
      JSON.stringify({ code: "request_failed", message: String(error) }),
    );
    if (!outgoing.headersSent) outgoing.writeHead(503);
    outgoing.end();
  }
});
let closing: Promise<void> | undefined;
function closeService(): Promise<void> {
  return (closing ??= (async () => {
    try {
      await service.flushMaterialization();
    } finally {
      try {
        coordinator.close();
      } finally {
        try {
          index.close();
        } finally {
          await release();
        }
      }
    }
  })());
}
server.once("error", async (error) => {
  console.error(String(error));
  try {
    await closeService();
  } catch (failure) {
    console.error(String(failure));
  }
  process.exitCode = 1;
});
server.listen(
  Number(process.env.PORT ?? 8789),
  process.env.HOST ?? "127.0.0.1",
  () =>
    console.log(
      JSON.stringify({
        event: "listening",
        address: server.address(),
        data: directory,
      }),
    ),
);

for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () =>
    server.close(async () => {
      try {
        await closeService();
        process.exit(0);
      } catch (error) {
        console.error(String(error));
        process.exit(1);
      }
    }),
  );
