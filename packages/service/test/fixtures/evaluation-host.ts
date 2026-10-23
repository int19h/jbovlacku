import { parentPort, workerData, Worker } from "node:worker_threads";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import {
  initializeCore,
  createEvent,
  identityFromSeed,
  utf8,
  wordId,
} from "../../../core/src/index.ts";
import { DictionaryService } from "../../src/service.ts";
import { emptyState, type State, type Snapshot } from "../../src/storage.ts";

const gate = new Int32Array(workerData.gate);
const wasm = await readFile(
  new URL("../../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
);
await initializeCore(wasm);
let runtime: any;
if (!workerData.inline) {
  const { NodeEvaluationRuntime } =
    await import("../../../../apps/server/src/evaluation.ts");
  runtime = new NodeEvaluationRuntime(wasm, {
    workerFactory: (data: any) =>
      new Worker(new URL("./slow-evaluation-worker.ts", import.meta.url), {
        execArgv: ["--experimental-transform-types"],
        workerData: { ...data, entry: "test", gate: workerData.gate },
      }),
  });
}
let state = emptyState();
const snapshots = new Map<string, Snapshot>();
const bytes = new Map<string, Uint8Array>();
const coordinator = {
  async load() {
    return state;
  },
  async getSnapshot(id: string) {
    return snapshots.get(id) ?? null;
  },
  async compareAndSwap(revision: number, next: State, snapshot?: Snapshot) {
    if (state.revision !== revision) return false;
    state = next;
    if (snapshot) snapshots.set(snapshot.snapshot, snapshot);
    return true;
  },
};
const seed = new Uint8Array(32).fill(78);
const word = { language: "jbo" as const, spelling: "klama" };
const definition = createEvent(
  seed,
  [],
  "1".repeat(32),
  {
    kind: "definition.publish",
    word: wordId(word),
    language: "en",
    parents: [],
    origin: "native",
  },
  {
    word,
    language: "en",
    text: [["go"]],
    frame: null,
    operands: [],
    glosses: [],
    notes: [],
    etymology: { text: [], formation: null, compound: null },
    examples: [],
    classification: { kind: "gismu", selmaho: [] },
    labels: [],
    sources: [],
    legacy: null,
    license: {
      expression: "CC0-1.0",
      url: "https://creativecommons.org/publicdomain/zero/1.0/",
      attribution: "",
    },
  },
);
const view = createEvent(
  seed,
  [],
  "2".repeat(32),
  { kind: "view.publish", parents: [] },
  {
    name: "Thread fixture",
    description: [],
    roots: [
      { identity: identityFromSeed(seed), q: { numerator: 1, denominator: 1 } },
    ],
    rafsi_threshold: { numerator: 1, denominator: 1 },
    H: { numerator: 3, denominator: 1 },
    alpha: { numerator: 1, denominator: 2 },
    excluded: [],
    calculation: "simple-routes-bounds-v1",
    work: 1000,
    import_sets: [],
    account_witnesses: [],
    account_authority: false,
    notes: [],
  },
);
const service = new DictionaryService(
  {
    async get(hash) {
      return bytes.get(hash)?.slice() ?? null;
    },
    async put(hash, value) {
      bytes.set(hash, value.slice());
    },
  },
  coordinator,
  {
    serverId: "thread-test",
    policyUrl: "https://example.invalid/policy",
    selectedView: view.envelope.id,
    asyncMaterialization: true,
    evaluationRuntime: runtime,
  } as any,
);
await service.admitMany(
  [definition, view].map((record) => utf8(JSON.stringify(record))),
);
await service.flushMaterialization();
const old = state.snapshot;
if (workerData.inline) {
  const compute = (service as any).computeEvaluation.bind(service);
  (service as any).computeEvaluation = async (...args: any[]) => {
    const result = await compute(...args);
    Atomics.store(gate, 0, 1);
    Atomics.wait(gate, 1, 0, 10000);
    return result;
  };
}
const server = createServer(async (request, response) => {
  try {
    const result = await service.fetch(
      new Request("http://localhost" + request.url),
    );
    response.writeHead(result.status);
    response.end(await result.text());
  } catch (error) {
    response.writeHead(500);
    response.end(String(error));
  }
});
server.listen(0, "127.0.0.1", () => {
  Atomics.store(gate, 2, 1);
  parentPort!.postMessage({
    type: "ready",
    port: (server.address() as any).port,
    old,
    word: wordId(word),
  });
});
parentPort!.on("message", async (message) => {
  if (message === "write") {
    const record = createEvent(
      seed,
      [],
      "3".repeat(32),
      { kind: "judgment.set", target: definition.envelope.id, value: "bless" },
      null,
    );
    await service.admitMany([utf8(JSON.stringify(record))]);
    await service.flushMaterialization();
    parentPort!.postMessage({
      type: "published",
      snapshot: state.snapshot,
      receipt: await (
        await service.fetch(
          new Request("http://localhost/api/v1/receipts/" + record.envelope.id),
        )
      ).json(),
    });
  }
});
