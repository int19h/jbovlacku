/** Small local HTTP adapter for tests. It uses the product service. */
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { initializeCore } from "../../packages/core/src/index.ts";
import { DictionaryService } from "../../packages/service/src/service.ts";
import { FileObjectStore, SqliteCoordinator } from "../../apps/server/src/storage.ts";
export async function startServer(directory: string, port: number, selectedView?: string) {
  await mkdir(directory, { recursive: true });
  await initializeCore(await readFile(new URL("../../packages/core/generated/jvc_runtime_bg.wasm", import.meta.url)));
  const coordinator = new SqliteCoordinator(join(directory, "coordinator.sqlite"), 16);
  const service = new DictionaryService(new FileObjectStore(join(directory, "objects")), coordinator, { serverId: "synthetic-test", policyUrl: "https://example.invalid/policy", selectedView });
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const request = new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers: req.headers as HeadersInit, body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : body });
    const response = await service.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((r) => http.listen(port, "127.0.0.1", r));
  return { http, service, coordinator, close: async () => { await new Promise<void>((r) => http.close(() => r())); coordinator.close(); } };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2], port = Number(process.argv[3] ?? 8795);
  const s = await startServer(dir, port, process.argv[4]);
  console.log(`listening ${port}`);
  process.on("SIGTERM", async () => { await s.close(); process.exit(0); });
}
