/** Small local HTTP adapter for tests. It uses the product service. */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { initializeCore, coreCheckpointVersion } from "../../packages/core/src/index.ts";
import { DictionaryService } from "../../packages/service/src/service.ts";
import { FileObjectStore, SqliteCoordinator, SqliteIndexStore } from "../../apps/server/src/storage.ts";
import { NodeEvaluationRuntime } from "../../apps/server/src/evaluation.ts";
import { FileCheckpointStore } from "../../apps/server/src/checkpoint.ts";
import { readLoadedView, checkLoadedView, stateTraversalLimit } from "../../packages/importer/src/load-config.ts";
import { lockDataDirectory } from "../../packages/importer/src/load-lock.ts";
export interface ServerOptions { marker?: boolean; selectedView?: string }
/**
 * A server for synthetic activity must hold a disposable copy.
 * A fresh empty directory gets a marker. A directory that already
 * holds data and has no marker is refused at startup.
 */
export async function startServer(directory: string, port: number, selectedView?: string, options: ServerOptions = {}) {
  await mkdir(directory, { recursive: true });
  const markerPath = join(directory, "disposable.json");
  if (options.marker !== false) {
    const hasData = existsSync(join(directory, "coordinator.sqlite")) || existsSync(join(directory, "objects"));
    if (hasData && !existsSync(markerPath))
      throw new Error("refused: data directory has no disposable marker; mark a disposable copy before it is served");
    if (!existsSync(markerPath))
      await writeFile(markerPath, JSON.stringify({ disposable: true, created_at: new Date().toISOString() }) + "\n");
  }
  // The standalone server holds one lock for the whole data directory.
  const release = await lockDataDirectory(directory, "node-server");
  let coordinator: SqliteCoordinator | undefined;
  let index: SqliteIndexStore | undefined;
  let evaluationRuntime: NodeEvaluationRuntime | undefined;
  try {
    const coreBytes = await readFile(new URL("../../packages/core/generated/jvc_runtime_bg.wasm", import.meta.url));
    await initializeCore(coreBytes);
    // A loaded-view file that exists must be valid. Reading it needs
    // the core. A bad file refuses startup. It never falls back to
    // the light server.
    let loadedView;
    if (existsSync(join(directory, "loaded-view.json")))
      loadedView = await readLoadedView(directory);
    coordinator = new SqliteCoordinator(join(directory, "coordinator.sqlite"), 16);
    const objects = new FileObjectStore(join(directory, "objects"));
    if (loadedView) await checkLoadedView(loadedView, coordinator, objects);
    // A copied snapshot carries a loaded view. Serve it with the same
    // evaluation runtime, index and checkpoint wiring as the standalone
    // server, so word and search reads can evaluate a large inventory.
    // Empty test folders keep the light synchronous wiring.
    const rich = loadedView !== undefined;
    evaluationRuntime = rich ? new NodeEvaluationRuntime(coreBytes) : undefined;
    index = rich ? new SqliteIndexStore(join(directory, "indexes.sqlite"), true) : undefined;
    const traversal = rich ? stateTraversalLimit(loadedView?.state_traversal_limit) : undefined;
    const service = new DictionaryService(objects, coordinator, {
      serverId: "synthetic-test", policyUrl: "https://example.invalid/policy",
      selectedView: selectedView ?? options.selectedView ?? loadedView?.view,
      ...(rich ? {
        index, evaluationRuntime, asyncMaterialization: true,
        checkpoints: new FileCheckpointStore(join(directory, "evaluation-cache"), coordinator),
        coreVersion: `${createHash("sha256").update(coreBytes).digest("hex")}:${coreCheckpointVersion()}:service-checkpoint-v1`,
        stateLimits: traversal === undefined ? undefined : { events: 200_000, traversal, claim_depth: 1024 },
      } : {}),
    });
    if (rich) await service.initialize();
    const http = createServer(async (req, res) => {
      if (options.marker !== false && req.method === "GET" && req.url === "/synthetic-disposable") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ disposable: true }));
        return;
      }
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      const request = new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers: req.headers as HeadersInit, body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : body });
      const response = await service.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>((r) => http.listen(port, "127.0.0.1", r));
    let closed = false;
    const close = async () => {
      if (closed) return; closed = true;
      try {
        // The standalone shutdown order: stop accepting, flush
        // materialization, save evaluation state, then close storage
        // and release the data lock.
        await new Promise<void>((r) => http.close(() => r()));
        if (rich) {
          await service.flushMaterialization();
          await service.prepareEvaluationShutdown();
        }
        await evaluationRuntime?.close();
        index?.close();
        coordinator?.close();
      } finally { await release(); }
    };
    return { http, service, coordinator, close };
  } catch (error) {
    try { await evaluationRuntime?.close(); } catch {}
    try { index?.close(); } catch {}
    try { coordinator?.close(); } catch {}
    await release().catch(() => {});
    throw error;
  }
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2], port = Number(process.argv[3] ?? 8795);
  const s = await startServer(dir, port, process.argv[4]);
  console.log(`listening ${port}`);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await s.close(); process.exit(0); };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
}
