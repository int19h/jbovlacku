import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeCore, utf8 } from "../packages/core/src/index.ts";
import { DictionaryService } from "../packages/service/src/service.ts";
import {
  FileObjectStore,
  SqliteCoordinator,
} from "../apps/server/src/storage.ts";
import type { Snapshot, State } from "../packages/service/src/storage.ts";

assert(
  process.env.JVC_ADAPTER_CARRIER &&
    process.env.JVC_ADAPTER_SELECTION &&
    process.env.JVC_ADAPTER_VIEW,
  "Set the signed corpus, selection, and view paths.",
);
const directory = await mkdtemp(join(tmpdir(), "jvc-io-"));
const runtime = (await initializeCore(
  await readFile(
    new URL("../packages/core/generated/jvc_runtime_bg.wasm", import.meta.url),
  ),
)) as { memory: WebAssembly.Memory };
const objects = new FileObjectStore(join(directory, "objects"));
const rows = new SqliteCoordinator(join(directory, "coordinator.sqlite"), 3);
let counts = { logical_get: 0, logical_put: 0, r2_get: 0, r2_put: 0 };
const memory: unknown[] = [];
const sample = (phase: string) =>
  memory.push({
    phase,
    wasm_linear_bytes: runtime.memory.buffer.byteLength,
    ...process.memoryUsage(),
  });
const coordinator = {
  load: rows.load.bind(rows),
  getSnapshot: rows.getSnapshot.bind(rows),
  async compareAndSwap(revision: number, state: State, snapshot?: Snapshot) {
    if (snapshot) sample("before_wrapper_cache");
    const committed = await rows.compareAndSwap(revision, state, snapshot);
    if (snapshot) sample("after_wrapper_cache");
    return committed;
  },
};
const counted = {
  async get(hash: string) {
    counts.logical_get++;
    counts.r2_get++;
    return objects.get(hash);
  },
  async put(hash: string, bytes: Uint8Array) {
    counts.logical_put++;
    counts.r2_get++;
    const old = await objects.get(hash);
    if (old) {
      assert(Buffer.from(old).equals(bytes));
      return;
    }
    counts.r2_put++;
    await objects.put(hash, bytes);
  },
};
try {
  const carriers = (await readFile(process.env.JVC_ADAPTER_CARRIER, "utf8"))
    .trimEnd()
    .split("\n")
    .map(utf8);
  const service = new DictionaryService(counted, coordinator, {
    serverId: "measurement",
    policyUrl: "https://example.invalid/policy",
    selectedView: process.env.JVC_ADAPTER_VIEW,
  });
  sample("before_batch");
  const started = performance.now();
  const batch = await service.admitMany(carriers);
  const batchCounts = {
    ...counts,
    operations: counts.r2_get + counts.r2_put,
    milliseconds: performance.now() - started,
  };
  sample("after_batch");
  const selection = await service.fetch(
    new Request("http://localhost/api/v1/import-selections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await readFile(process.env.JVC_ADAPTER_SELECTION),
    }),
  );
  assert.equal(selection.status, 201);
  sample("after_selection");
  counts = { logical_get: 0, logical_put: 0, r2_get: 0, r2_put: 0 };
  const cold = new DictionaryService(counted, coordinator, {
    serverId: "measurement",
    policyUrl: "https://example.invalid/policy",
    selectedView: process.env.JVC_ADAPTER_VIEW,
  });
  const searchStarted = performance.now();
  const search = await cold.fetch(
    new Request("http://localhost/api/v1/search?q=klama&language=en"),
  );
  assert.equal(search.status, 200, await search.clone().text());
  const searchCounts = {
    ...counts,
    operations: counts.r2_get + counts.r2_put,
    milliseconds: performance.now() - searchStarted,
  };
  sample("after_cold_search");
  const report = {
    events: carriers.length,
    batch_snapshot: batch.snapshot,
    batch: batchCounts,
    cold_search: searchCounts,
    memory,
  };
  if (process.env.JVC_IO_REPORT)
    await writeFile(
      process.env.JVC_IO_REPORT,
      JSON.stringify(report, null, 2) + "\n",
    );
  console.log(JSON.stringify(report));
} finally {
  rows.close();
  await rm(directory, { recursive: true, force: true });
}
