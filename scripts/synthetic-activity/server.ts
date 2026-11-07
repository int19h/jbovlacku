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
  // The marker's content decides, not only its presence. A file that
  // does not parse, or that does not say disposable: true, refuses
  // startup and never answers the marker endpoint.
  let markerValid = false;
  if (options.marker !== false) {
    const hasData = existsSync(join(directory, "coordinator.sqlite")) || existsSync(join(directory, "objects"));
    if (existsSync(markerPath)) {
      let parsed: any;
      try { parsed = JSON.parse(await readFile(markerPath, "utf8")); } catch { parsed = null; }
      if (parsed?.disposable !== true)
        throw new Error("refused: disposable.json does not say disposable: true; the copy is not marked disposable");
      markerValid = true;
    } else if (hasData) {
      throw new Error("refused: data directory has no disposable marker; mark a disposable copy before it is served");
    } else {
      await writeFile(markerPath, JSON.stringify({ disposable: true, created_at: new Date().toISOString() }) + "\n");
      markerValid = true;
    }
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
      try {
        if (markerValid && req.method === "GET" && req.url === "/synthetic-disposable") {
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
      } catch {
        // A client that disconnects during its request body must not
        // crash the adapter for every other client.
        if (!res.headersSent) { try { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ code: "internal_error", message: "Request failed." })); } catch {} }
        else { try { res.destroy(); } catch {} }
      }
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      http.once("error", rejectListen);
      http.listen(port, "127.0.0.1", () => { http.removeListener("error", rejectListen); resolveListen(); });
    });
    http.on("error", () => {});
    let closed = false;
    const close = async () => {
      if (closed) return; closed = true;
      // Attempt every step, in the standalone order: stop accepting,
      // flush materialization, save evaluation state, stop the
      // runtime, close the coordinator and then the index. The data
      // lock is released last, even when a step fails.
      let firstError: unknown;
      const step = async (fn: () => unknown) => { try { await fn(); } catch (e) { firstError ??= e; } };
      // Stop accepting, give in-flight work a bounded grace, then
      // close the remaining connections so close cannot hang.
      await step(() => Promise.race([
        new Promise<void>((r) => http.close(() => r())),
        new Promise<void>((r) => setTimeout(() => { try { http.closeAllConnections(); } catch {} r(); }, 10000)),
      ]));
      if (rich) {
        await step(() => service.flushMaterialization());
        await step(() => service.prepareEvaluationShutdown());
      }
      await step(() => evaluationRuntime?.close());
      await step(() => coordinator?.close());
      await step(() => index?.close());
      await step(() => release());
      if (firstError) throw firstError;
    };
    return { http, service, coordinator, close };
  } catch (error) {
    try { await evaluationRuntime?.close(); } catch {}
    try { coordinator?.close(); } catch {}
    try { index?.close(); } catch {}
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
