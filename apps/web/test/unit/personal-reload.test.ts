import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import type { LocalStore, Overlay } from "../../src/data/store.ts";
import type { SnapshotInventory } from "../../src/data/records.ts";
import type { WorkerRequest } from "../../src/workers/evaluate.ts";

(globalThis as { location?: unknown }).location = {
  origin: "http://peer.test",
  host: "peer.test",
};
(globalThis as { window?: unknown }).window = globalThis;
const core = await import("../../../../packages/core/src/browser.ts");
const { xorProjectionHashes } =
  await import("../../src/data/projection-meta.ts");
const { PersonalCalculator } = await import("../../src/data/personal.ts");
const { hashInventoryIds, hashLogicalInventory, syncRecords } =
  await import("../../src/data/records.ts");
const { emptyOverlay } = await import("../../src/data/store.ts");

const view = "jve1:" + "c".repeat(64);
const bodyHash = "sha256:" + "d".repeat(64);
const other = "jvr1:" + "e".repeat(64);
const added = "jvr1:" + "f".repeat(64);
const snapshot = (letter: string) => "sha256:" + letter.repeat(64);

function envelope(id: string) {
  return JSON.stringify({ id, header: { content: null } });
}

function inventory(events: string[], id: string): SnapshotInventory {
  return {
    snapshot: id,
    logical_inventory: id,
    events_digest: id,
    view,
    events,
    bodies: [bodyHash],
    unretained_bodies: [],
    selections: [],
  };
}

const BASE_DIGEST = "sha256:" + "0".repeat(64);
let currentProjectionDigest = BASE_DIGEST;
function advanceDigest(ids: string[]) {
  const delta = core.createProjectionDigest();
  for (const id of ids) delta.update(id, new Uint8Array([1]));
  return xorProjectionHashes(currentProjectionDigest, delta.finish());
}

class RecordingWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: WorkerRequest[] = [];
  events = 0;
  failAdvance = false;
  crashAdvance = false;
  fatalActors = false;
  fatalAdvance = false;
  fatalRank = false;
  rankError = false;
  holdAdvance: Promise<void> | null = null;
  holdRank: Promise<void> | null = null;
  advanceStarted: (() => void) | null = null;
  rankStarted: (() => void) | null = null;
  terminateCalls = 0;
  selectedView = view;

  postMessage(message: WorkerRequest) {
    this.messages.push(structuredClone(message));
    if (message.type === "load") {
      this.events = message.source.count;
      this.selectedView = message.options.selected_view;
    }
    if (message.type === "advance") {
      this.events += message.input.events.length + (message.rows?.length ?? 0);
      this.selectedView = message.input.selected_view;
    }
    queueMicrotask(async () => {
      if (message.type === "advance" && this.holdAdvance) {
        const held = this.holdAdvance;
        this.holdAdvance = null;
        this.advanceStarted?.();
        await held;
      }
      if (message.type === "rank" && this.holdRank) {
        const held = this.holdRank;
        this.rankStarted?.();
        await held;
      }
      if (message.type === "load" && this.fatalActors) {
        this.fatalActors = false;
        this.onmessage?.({
          data: {
            type: "error",
            id: message.id,
            message: "WebAssembly trap",
            session_valid: true,
            fatal: true,
          },
        } as MessageEvent);
        return;
      }
      if (message.type === "advance" && this.fatalAdvance) {
        this.fatalAdvance = false;
        this.onmessage?.({
          data: {
            type: "error",
            id: message.id,
            message: "WebAssembly trap",
            session_valid: true,
            fatal: true,
          },
        } as MessageEvent);
        return;
      }
      if (message.type === "advance" && this.failAdvance) {
        this.failAdvance = false;
        this.onmessage?.({
          data: {
            type: "error",
            id: message.id,
            message: "advance failed",
            session_valid: false,
          },
        } as MessageEvent);
        return;
      }
      if (message.type === "advance" && this.crashAdvance) {
        this.crashAdvance = false;
        this.crash("The advance worker crashed.");
        return;
      }
      if (message.type === "rank" && this.fatalRank) {
        this.fatalRank = false;
        this.onmessage?.({
          data: {
            type: "error",
            id: message.id,
            message: "WebAssembly trap",
            session_valid: true,
            fatal: true,
          },
        } as MessageEvent);
        return;
      }
      if (message.type === "rank" && this.rankError) {
        this.rankError = false;
        this.onmessage?.({
          data: {
            type: "error",
            id: message.id,
            message: "view calculation profile is unsupported",
            session_valid: true,
          },
        } as MessageEvent);
        return;
      }
      if (message.type === "rank") {
        this.onmessage?.({
          data: {
            type: "ranked",
            id: message.id,
            session: message.session,
            result: {
              calculation: null,
              scores: [],
              layers: [],
              unavailable_scores: [],
            },
          },
        } as MessageEvent);
        return;
      }
      if (
        message.type === "load" ||
        message.type === "advance" ||
        message.type === "overlay"
      ) {
        this.onmessage?.({
          data: {
            type: "loaded",
            id: message.id,
            session: message.session,
            available: true,
            reasons: [],
            selected_view: this.selectedView,
            events: this.events,
            actors: {},
            projection_digest:
              message.type === "load" ? currentProjectionDigest : undefined,
          },
        } as MessageEvent);
      }
    });
  }

  crash(message = "The evaluation worker crashed.") {
    this.onerror?.({ message } as ErrorEvent);
  }

  terminate() {
    this.terminateCalls++;
  }
}

type Harness = {
  calculator: InstanceType<typeof PersonalCalculator>;
  workers: RecordingWorker[];
  readonly worker: RecordingWorker;
  records: Map<string, unknown>;
  selections: Map<string, string>;
  setInventory: (value: SnapshotInventory) => void;
  setOverlay: (value: Overlay) => void;
  setProjectionProducer: (value: string) => void;
};

function harness(): Harness {
  currentProjectionDigest = BASE_DIGEST;
  let currentInventory = inventory([view, other], snapshot("a"));
  let currentOverlay = emptyOverlay();
  let projectionProducer = core.projectionBuildIdentity();
  const records = new Map<string, unknown>([
    [
      view,
      {
        id: view,
        envelope: envelope(view),
        body: JSON.stringify({ roots: [] }),
        bodyStatus: "present",
        bodyHash,
      },
    ],
    [
      other,
      {
        id: other,
        envelope: envelope(other),
        body: null,
        bodyStatus: "none",
        bodyHash: null,
      },
    ],
  ]);
  const selections = new Map<string, string>();
  const inventories = new Map<string, SnapshotInventory>([
    [currentInventory.snapshot, currentInventory],
  ]);
  const store = {
    get: async (name: string, id: string) => {
      if (name === "inventory" && id === "latest") return currentInventory;
      if (name === "inventory") return inventories.get(id);
      if (name === "records") return records.get(id);
      if (name === "projections")
        return records.has(id) ? new Uint8Array([1]) : undefined;
      if (name === "meta" && id === "projection:producer")
        return projectionProducer;
      if (name === "selections") return selections.get(id);
      throw new Error(`Unexpected read: ${name}/${id}`);
    },
    readProjectionAdvance: async (ids: string[]) => {
      currentProjectionDigest = advanceDigest(ids);
      return {
        producer: projectionProducer,
        digest: currentProjectionDigest,
        rows: new Map(ids.map((id) => [id, new Uint8Array([1])])),
      };
    },
    keys: async (name: string) => {
      if (name === "selections") return [...selections.keys()];
      return [];
    },
    put: async (name: string, id: string, value: unknown) => {
      if (name === "inventory" && id === "latest")
        currentInventory = value as SnapshotInventory;
      if (name === "inventory") inventories.set(id, value as SnapshotInventory);
      else if (name === "records") records.set(id, value);
      else if (name === "selections") selections.set(id, value as string);
    },
    overlay: async () => currentOverlay,
  } as unknown as LocalStore;
  const workers: RecordingWorker[] = [];
  (globalThis as { Worker?: unknown }).Worker = class {
    constructor() {
      const worker = new RecordingWorker();
      workers.push(worker);
      return worker;
    }
  };
  return {
    calculator: new PersonalCalculator(store, async () => ({ identity: null })),
    workers,
    get worker() {
      return workers.at(-1)!;
    },
    records,
    selections,
    setInventory: (value) => {
      currentInventory = value;
      inventories.set(value.snapshot, value);
    },
    setOverlay: (value) => {
      currentOverlay = value;
    },
    setProjectionProducer: (value) => {
      projectionProducer = value;
    },
  };
}

function putEmptyRecord(h: Harness, id: string) {
  h.records.set(id, {
    id,
    envelope: envelope(id),
    body: null,
    bodyStatus: "none",
    bodyHash: null,
  });
}

function appendRecord(h: Harness) {
  putEmptyRecord(h, added);
  h.setInventory(inventory([view, other, added], snapshot("b")));
}

function serveRefresh(h: Harness, eventIds: string[]) {
  const hash = (value: unknown) =>
    core.contentHash(
      core.utf8(core.canonicalize(core.utf8(JSON.stringify(value)))),
    );
  const bodies = [bodyHash];
  const manifest = {
    events: {
      count: eventIds.length,
      hash: core.contentHash(
        core.utf8(
          eventIds
            .map(
              (id) =>
                (h.records.get(id) as { envelope: string }).envelope + "\n",
            )
            .join(""),
        ),
      ),
    },
    bodies: { count: bodies.length, hash: hash(bodies) },
    import_selections: { count: 0, hash: hash([]) },
  };
  const snapshot = hash(manifest);
  const logicalInventory = hash({
    events: eventIds,
    bodies,
    import_selections: [],
  });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      "http://peer.test",
    );
    let value: unknown;
    if (url.pathname.endsWith("/manifest"))
      value = {
        snapshot,
        logical_inventory: logicalInventory,
        manifest,
        packages: [],
        view,
      };
    else if (url.pathname.endsWith("/inventory")) {
      const kind = url.searchParams.get("kind")!;
      value = {
        snapshot,
        kind,
        ids: {
          events: eventIds,
          bodies,
          import_selections: [],
        }[kind],
        next: null,
      };
    } else throw new Error(`Unexpected refresh read: ${url.pathname}`);
    return new Response(JSON.stringify(value), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function privateOverlay(): Overlay {
  return {
    ...emptyOverlay(),
    blocked: [
      {
        identity: "ed25519:" + "1".repeat(64),
        scope: { kind: "*", word: "*", language: "*" },
      },
    ],
  };
}

function lastLoad(h: Harness) {
  const message = h.worker.messages.findLast(
    (message) => message.type === "load",
  );
  assert.equal(message?.type, "load");
  return message as Extract<WorkerRequest, { type: "load" }>;
}

before(async () => {
  await core.initializeCore(
    await readFile(
      new URL(
        "../../../../packages/core/generated/jvc_runtime_bg.wasm",
        import.meta.url,
      ),
    ),
  );
});

after(() => {
  delete (globalThis as { Worker?: unknown }).Worker;
});

test("a pure snapshot append advances with only the new record", async () => {
  const h = harness();
  assert.equal((await h.calculator.ensure()).state, "ready");
  appendRecord(h);
  const ready = await h.calculator.ensure();
  assert.equal(ready.state, "ready");
  assert.equal(ready.events, 3);
  assert.deepEqual(
    h.worker.messages.map((message) => message.type),
    ["load", "overlay", "advance", "overlay"],
  );
  const first = h.worker.messages[0];
  const advance = h.worker.messages[2];
  assert.equal(first.type, "load");
  assert.equal(advance.type, "advance");
  if (first.type !== "load" || advance.type !== "advance") return;
  assert.equal(advance.base, h.worker.messages[1].session);
  assert.deepEqual(advance.input.events, []);
  assert.deepEqual(
    advance.rows?.map((row) => row.id),
    [added],
  );
  assert.deepEqual(advance.input.bodies, {});
  assert.equal(advance.input.selected_view, view);
  assert.equal(
    (advance.input.overlay as { version: number } | undefined)?.version,
    2,
  );
  h.calculator.cancel();
});

test("rows from another build use a full load instead of advance", async () => {
  const h = harness();
  await h.calculator.ensure();
  appendRecord(h);
  h.setProjectionProducer("another-build");
  const ready = await h.calculator.ensure();
  assert.equal(ready.state, "ready");
  assert.deepEqual(
    h.worker.messages.map((message) => message.type),
    ["load", "overlay", "load", "overlay"],
  );
  h.calculator.cancel();
});

test("a new record with a retained body advances with that body", async () => {
  const h = harness();
  await h.calculator.ensure();
  const addedBodyHash = "sha256:" + "9".repeat(64);
  const body = JSON.stringify({ retained: true });
  h.records.set(added, {
    id: added,
    envelope: envelope(added),
    body,
    bodyStatus: "present",
    bodyHash: addedBodyHash,
  });
  h.setInventory({
    ...inventory([view, other, added], snapshot("b")),
    bodies: [addedBodyHash, bodyHash],
  });
  assert.equal((await h.calculator.ensure()).state, "ready");
  assert.deepEqual(
    h.worker.messages.map((message) => message.type),
    ["load", "overlay", "advance", "overlay"],
  );
  const advance = h.worker.messages[2];
  assert.equal(advance.type, "advance");
  if (advance.type === "advance") {
    assert.deepEqual(advance.input.bodies, {});
    assert.deepEqual(
      advance.rows?.map((row) => row.id),
      [added],
    );
  }
  h.calculator.cancel();
});

async function assertBodyAdvanceFallsBack(
  h: Harness,
  previousUnretained: string[] | undefined,
  addedHasBody: boolean,
) {
  await h.calculator.ensure();
  const addedBodyHash = "sha256:" + "9".repeat(64);
  h.records.set(added, {
    id: added,
    envelope: envelope(added),
    body: addedHasBody ? JSON.stringify({ retained: true }) : null,
    bodyStatus: addedHasBody ? "present" : "none",
    bodyHash: addedHasBody ? addedBodyHash : null,
  });
  h.setInventory({
    ...inventory([view, other], snapshot("a")),
    unretained_bodies: previousUnretained,
  });
  h.setInventory({
    ...inventory([view, other, added], snapshot("b")),
    bodies: [addedBodyHash, bodyHash],
  });
  assert.equal((await h.calculator.ensure()).state, "ready");
  assert.deepEqual(
    h.worker.messages.map((message) => message.type),
    ["load", "overlay", "load", "overlay"],
  );
  assert.equal(lastLoad(h).source.count, 3);
  h.calculator.cancel();
}

test("a body advance without previous body metadata uses a full load", async () => {
  const h = harness();
  await assertBodyAdvanceFallsBack(h, undefined, true);
});

test("a new body shared with an earlier unretained record uses a full load", async () => {
  const h = harness();
  await assertBodyAdvanceFallsBack(h, ["sha256:" + "9".repeat(64)], true);
});

test("a retained body that no added record carries uses a full load", async () => {
  const h = harness();
  await assertBodyAdvanceFallsBack(h, [], false);
});

function appendBodyRecord(h: Harness) {
  const hash = "sha256:" + "9".repeat(64);
  h.records.set(added, {
    id: added,
    envelope: envelope(added),
    body: JSON.stringify({ retained: true }),
    bodyStatus: "present",
    bodyHash: hash,
  });
  h.setInventory({
    ...inventory([view, other, added], snapshot("b")),
    bodies: [hash, bodyHash],
  });
}

const unsortedInventoryCases: [string, (h: Harness) => void][] = [
  [
    "current event list",
    (h) => {
      appendRecord(h);
      h.setInventory(inventory([view, added, other], snapshot("b")));
    },
  ],
  [
    "current body list",
    (h) => {
      appendBodyRecord(h);
      h.setInventory({
        ...inventory([view, other, added], snapshot("b")),
        bodies: [bodyHash, "sha256:" + "9".repeat(64)],
      });
    },
  ],
  [
    "previous event list",
    (h) => {
      h.setInventory(inventory([other, view], snapshot("a")));
      appendRecord(h);
    },
  ],
  [
    "previous body list",
    (h) => {
      const earlierHash = "sha256:" + "7".repeat(64);
      h.setInventory({
        ...inventory([view, other], snapshot("a")),
        bodies: [bodyHash, earlierHash],
      });
      appendBodyRecord(h);
      h.setInventory({
        ...inventory([view, other, added], snapshot("b")),
        bodies: [earlierHash, "sha256:" + "9".repeat(64), bodyHash],
      });
    },
  ],
  [
    "previous unretained body list",
    (h) => {
      h.setInventory({
        ...inventory([view, other], snapshot("a")),
        unretained_bodies: [bodyHash, "sha256:" + "7".repeat(64)],
      });
      appendBodyRecord(h);
    },
  ],
];
for (const [name, change] of unsortedInventoryCases) {
  test(`an unsorted ${name} uses a full load`, async () => {
    const h = harness();
    await h.calculator.ensure();
    change(h);
    assert.equal((await h.calculator.ensure()).state, "ready");
    assert.deepEqual(
      h.worker.messages.map((message) => message.type),
      ["load", "overlay", "load", "overlay"],
    );
    assert.equal(lastLoad(h).source.count, 3);
    h.calculator.cancel();
  });
}

test("a new ID that sorts between loaded IDs advances with only that envelope", async () => {
  const h = harness();
  const inserted = "jve1:" + "d".repeat(64);
  await h.calculator.ensure();
  putEmptyRecord(h, inserted);
  h.setInventory(inventory([view, inserted, other], snapshot("b")));
  const ready = await h.calculator.ensure();
  assert.equal(ready.state, "ready");
  const advance = h.worker.messages.findLast(
    (message) => message.type === "advance",
  );
  assert.equal(advance?.type, "advance");
  if (advance?.type === "advance") {
    assert.deepEqual(advance.input.events, []);
    assert.deepEqual(
      advance.rows?.map((row) => row.id),
      [inserted],
    );
  }
  h.calculator.cancel();
});

test("several new IDs at different positions advance in inventory order", async () => {
  const h = harness();
  const before = "jve1:" + "a".repeat(64);
  const middle = "jve1:" + "d".repeat(64);
  await h.calculator.ensure();
  for (const id of [before, middle, added]) putEmptyRecord(h, id);
  h.setInventory(
    inventory([before, view, middle, other, added], snapshot("b")),
  );
  await h.calculator.ensure();
  const advance = h.worker.messages.findLast(
    (message) => message.type === "advance",
  );
  assert.equal(advance?.type, "advance");
  if (advance?.type === "advance") {
    assert.deepEqual(advance.input.events, []);
    assert.deepEqual(
      advance.rows?.map((row) => row.id),
      [before, middle, added],
    );
  }
  h.calculator.cancel();
});

test("a new ID combined with a removal uses a full load", async () => {
  const h = harness();
  const inserted = "jve1:" + "d".repeat(64);
  await h.calculator.ensure();
  putEmptyRecord(h, inserted);
  h.setInventory(inventory([view, inserted], snapshot("b")));
  await h.calculator.ensure();
  assert.equal(lastLoad(h).source.count, 2);
  assert.equal(lastLoad(h).source.snapshot, snapshot("b"));
  h.calculator.cancel();
});

test("a non-append snapshot uses a full load", async () => {
  const h = harness();
  await h.calculator.ensure();
  appendRecord(h);
  await h.calculator.ensure();
  h.setInventory(inventory([view, added], snapshot("c")));
  await h.calculator.ensure();
  const replaced = lastLoad(h);
  assert.equal(replaced.source.count, 2);
  assert.equal(replaced.source.snapshot, snapshot("c"));
  h.calculator.cancel();
});

test("an overlay change alone keeps the graph without invalidation", async () => {
  const h = harness();
  await h.calculator.ensure();
  h.setOverlay(privateOverlay());
  await h.calculator.ensure();
  assert.deepEqual(
    h.worker.messages.map((message) => message.type),
    ["load", "overlay", "overlay"],
  );
  const loaded = h.worker.messages.at(-1);
  assert.equal(loaded?.type, "overlay");
  if (loaded?.type === "overlay")
    assert.equal((loaded.overlay as { blocked: unknown[] }).blocked.length, 1);
  h.calculator.cancel();
});

test("a view change alone uses a full load", async () => {
  const h = harness();
  const nextView = "jve1:" + "a".repeat(64);
  const nextBodyHash = "sha256:" + "b".repeat(64);
  h.records.set(nextView, {
    id: nextView,
    envelope: envelope(nextView),
    body: JSON.stringify({ roots: [] }),
    bodyStatus: "present",
    bodyHash: nextBodyHash,
  });
  await h.calculator.ensure();
  h.setInventory({
    ...inventory([view, other, nextView], snapshot("b")),
    view: nextView,
    bodies: [bodyHash, nextBodyHash],
  });
  await h.calculator.ensure();
  assert.equal(lastLoad(h).options.selected_view, nextView);
  h.calculator.cancel();
});

test("a mode change alone applies a new overlay without a full load", async () => {
  const h = harness();
  await h.calculator.ensure({ mode: "personal" });
  await h.calculator.ensure({ mode: "site" });
  assert.deepEqual(
    h.worker.messages.map((message) => message.type),
    ["load", "overlay", "overlay"],
  );
  const changed = h.worker.messages.at(-1);
  assert.equal(changed?.type, "overlay");
  if (changed?.type === "overlay") assert.equal(changed.overlay, null);
  h.calculator.cancel();
});

test("an import selection change alone uses a full load without reading selections on the page", async () => {
  const h = harness();
  const selection = "sha256:" + "9".repeat(64);
  h.selections.set(selection, JSON.stringify([other]));
  await h.calculator.ensure();
  appendRecord(h);
  h.setInventory({
    ...inventory([view, other, added], snapshot("b")),
    selections: [selection],
  });
  await h.calculator.ensure();
  assert.deepEqual(
    h.worker.messages.map((message) => message.type),
    ["load", "overlay", "load", "overlay"],
  );
  assert.equal(lastLoad(h).source.snapshot, snapshot("b"));
  assert.equal(lastLoad(h).options.import_selections, undefined);
  h.calculator.cancel();
});

test("a changed body on an earlier event uses a full load", async () => {
  const h = harness();
  const changedHash = "sha256:" + "8".repeat(64);
  await h.calculator.ensure();
  appendRecord(h);
  h.records.set(other, {
    id: other,
    envelope: envelope(other),
    body: JSON.stringify({ changed: true }),
    bodyStatus: "present",
    bodyHash: changedHash,
  });
  h.setInventory({
    ...inventory([view, other, added], snapshot("b")),
    bodies: [bodyHash, changedHash],
  });
  await h.calculator.ensure();
  assert.equal(lastLoad(h).source.count, 3);
  assert.equal(lastLoad(h).source.snapshot, snapshot("b"));
  h.calculator.cancel();
});

test("a failed advance retries with one full load on a replacement worker", async () => {
  const h = harness();
  await h.calculator.ensure();
  appendRecord(h);
  const failed = h.worker;
  failed.failAdvance = true;
  const ready = await h.calculator.ensure();
  assert.equal(ready.state, "ready");
  assert.equal(h.workers.length, 2);
  assert.equal(failed.terminateCalls, 1);
  assert.equal(lastLoad(h).source.count, 3);
  h.calculator.cancel();
});

test("a crash during advance retries on a replacement worker in the same run", async () => {
  const h = harness();
  await h.calculator.ensure();
  appendRecord(h);
  const failed = h.worker;
  failed.crashAdvance = true;
  const ready = await h.calculator.ensure();
  assert.equal(ready.state, "ready");
  assert.equal(h.workers.length, 2);
  assert.equal(failed.terminateCalls, 1);
  assert.deepEqual(
    h.worker.messages.map((message) => message.type),
    ["load", "overlay"],
  );
  assert.equal(lastLoad(h).source.count, 3);
  h.calculator.cancel();
});

test("a crash while idle clears ready state and the next calculation replaces the worker", async () => {
  const h = harness();
  await h.calculator.ensure();
  const failed = h.worker;
  failed.crash();
  assert.equal(failed.terminateCalls, 1);
  assert.equal(h.calculator.status.state, "idle");
  const ready = await h.calculator.ensure();
  assert.equal(ready.state, "ready");
  assert.equal(h.workers.length, 2);
  assert.deepEqual(
    h.worker.messages.map((message) => message.type),
    ["load", "overlay"],
  );
  assert.equal(lastLoad(h).source.count, 2);
  h.calculator.cancel();
});

test("invalidation during an advance makes the next calculation use a full load", async () => {
  const h = harness();
  await h.calculator.ensure();
  appendRecord(h);
  let release = () => {};
  h.worker.holdAdvance = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    h.worker.advanceStarted = resolve;
  });
  const interrupted = h.calculator.ensure();
  await started;
  h.calculator.invalidate();
  release();
  assert.equal((await interrupted).state, "ready");
  const ready = await h.calculator.ensure();
  assert.equal(ready.state, "ready");
  assert.equal(lastLoad(h).source.count, 3);
  h.calculator.cancel();
});

test("cancel during an advance terminates the worker and an explicit refresh reloads", async () => {
  const h = harness();
  const otherEvent = "jve1:" + "e".repeat(64);
  const addedEvent = "jve1:" + "f".repeat(64);
  putEmptyRecord(h, otherEvent);
  putEmptyRecord(h, addedEvent);
  h.setInventory(inventory([view, otherEvent], snapshot("a")));
  await h.calculator.ensure();
  h.setInventory(inventory([view, otherEvent, addedEvent], snapshot("b")));
  let release = () => {};
  const failed = h.worker;
  failed.holdAdvance = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    failed.advanceStarted = resolve;
  });
  const interrupted = h.calculator.ensure();
  await started;
  h.calculator.cancel();
  release();
  const cancelled = await interrupted;
  assert.equal(cancelled.state, "failed");
  if (cancelled.state === "failed") assert.equal(cancelled.kind, "cancelled");
  assert.equal(failed.terminateCalls, 1);
  assert.equal((await h.calculator.ensure()).state, "failed");
  assert.equal(h.workers.length, 1);
  const originalFetch = globalThis.fetch;
  try {
    serveRefresh(h, [view, otherEvent, addedEvent]);
    const ready = await h.calculator.ensure({ refresh: true });
    assert.equal(ready.state, "ready", JSON.stringify(ready));
    assert.equal(h.workers.length, 2);
    assert.deepEqual(
      h.worker.messages.map((message) => message.type),
      ["load", "overlay"],
    );
    assert.equal(lastLoad(h).source.count, 3);
  } finally {
    globalThis.fetch = originalFetch;
    h.calculator.cancel();
  }
});

test("an inventory change during an advance starts the next delta from the completed inventory", async () => {
  const h = harness();
  const later = "jvr1:" + "g".repeat(64);
  await h.calculator.ensure();
  appendRecord(h);
  let release = () => {};
  h.worker.holdAdvance = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    h.worker.advanceStarted = resolve;
  });
  const pending = h.calculator.ensure();
  await started;
  putEmptyRecord(h, later);
  h.setInventory(inventory([view, other, added, later], snapshot("c")));
  release();
  const first = await pending;
  assert.equal(first.state, "ready");
  if (first.state === "ready") {
    assert.equal(first.snapshot, snapshot("b"));
    assert.equal(first.events, 3);
  }
  const ready = await h.calculator.ensure();
  assert.equal(ready.state, "ready");
  const advance = h.worker.messages.findLast(
    (message) => message.type === "advance",
  );
  assert.equal(advance?.type, "advance");
  if (advance?.type === "advance") {
    assert.deepEqual(advance.input.events, []);
    assert.deepEqual(
      advance.rows?.map((row) => row.id),
      [later],
    );
  }
  assert.equal(h.workers.length, 1);
  h.calculator.cancel();
});

test("an earlier body that becomes absent uses a full load", async () => {
  const h = harness();
  const earlierHash = "sha256:" + "7".repeat(64);
  h.records.set(other, {
    id: other,
    envelope: envelope(other),
    body: JSON.stringify({ present: true }),
    bodyStatus: "present",
    bodyHash: earlierHash,
  });
  h.setInventory({
    ...inventory([view, other], snapshot("a")),
    bodies: [bodyHash, earlierHash],
  });
  await h.calculator.ensure();
  h.records.set(other, {
    id: other,
    envelope: envelope(other),
    body: null,
    bodyStatus: "none",
    bodyHash: null,
  });
  h.setInventory(inventory([view, other], snapshot("b")));
  const ready = await h.calculator.ensure();
  assert.equal(ready.state, "ready");
  assert.equal(lastLoad(h).source.count, 2);
  assert.equal(lastLoad(h).source.snapshot, snapshot("b"));
  assert.equal(
    h.worker.messages.filter((message) => message.type === "advance").length,
    0,
  );
  h.calculator.cancel();
});

test("a reorder-only snapshot uses a full load", async () => {
  const h = harness();
  await h.calculator.ensure();
  h.setInventory(inventory([other, view], snapshot("b")));
  const ready = await h.calculator.ensure();
  assert.equal(ready.state, "ready");
  assert.equal(lastLoad(h).source.count, 2);
  assert.equal(lastLoad(h).source.snapshot, snapshot("b"));
  assert.deepEqual(
    h.worker.messages.map((message) => message.type),
    ["load", "overlay", "load", "overlay"],
  );
  h.calculator.cancel();
});

test("a ranking error keeps the worker and loaded session for the next rank", async () => {
  const h = harness();
  await h.calculator.ensure();
  h.worker.rankError = true;
  await assert.rejects(
    h.calculator.rankWord("jvw1:" + "a".repeat(64)),
    /unsupported_calculation|unsupported/,
  );
  const ranking = await h.calculator.rankWord("jvw1:" + "b".repeat(64));
  assert.deepEqual(ranking.scores, []);
  assert.equal(h.workers.length, 1);
  assert.equal(h.worker.terminateCalls, 0);
  assert.deepEqual(
    h.worker.messages.map((message) => message.type),
    ["load", "overlay", "rank", "rank"],
  );
  h.calculator.cancel();
});

test("two rankings in flight both reject when the worker is retired", async () => {
  const h = harness();
  await h.calculator.ensure();
  h.worker.holdRank = new Promise<void>(() => {});
  let started = 0;
  const bothStarted = new Promise<void>((resolve) => {
    h.worker.rankStarted = () => {
      started++;
      if (started === 2) resolve();
    };
  });
  const first = h.calculator.rankWord("jvw1:" + "a".repeat(64));
  const second = h.calculator.rankWord("jvw1:" + "b".repeat(64));
  await bothStarted;
  h.worker.crash();
  const results = await Promise.allSettled([first, second]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["rejected", "rejected"],
  );
  assert.equal(h.worker.terminateCalls, 1);
  h.calculator.cancel();
});

test("a calculation waiting behind a retired worker settles through a replacement", async () => {
  const h = harness();
  await h.calculator.ensure();
  appendRecord(h);
  h.worker.holdAdvance = new Promise<void>(() => {});
  const started = new Promise<void>((resolve) => {
    h.worker.advanceStarted = resolve;
  });
  const pending = h.calculator.ensure();
  await started;
  h.worker.crash();
  const ready = await pending;
  assert.equal(ready.state, "ready");
  assert.equal(h.workers.length, 2);
  assert.equal(lastLoad(h).source.count, 3);
  h.calculator.cancel();
});

test("a fatal actors error retires the worker and the next calculation uses a replacement", async () => {
  const h = harness();
  await h.calculator.ensure();
  const failed = h.worker;
  failed.fatalActors = true;
  h.setInventory(inventory([view, other], snapshot("b")));
  assert.equal((await h.calculator.ensure()).state, "failed");
  assert.equal(failed.terminateCalls, 1);
  const ready = await h.calculator.ensure();
  assert.equal(ready.state, "ready");
  assert.equal(h.workers.length, 2);
  assert.deepEqual(
    h.worker.messages.map((message) => message.type),
    ["load", "overlay"],
  );
  h.calculator.cancel();
});

test("a fatal ranking error retires the worker and the next rank uses a replacement", async () => {
  const h = harness();
  await h.calculator.ensure();
  const failed = h.worker;
  failed.fatalRank = true;
  await assert.rejects(
    h.calculator.rankWord("jvw1:" + "a".repeat(64)),
    /WebAssembly trap/,
  );
  assert.equal(failed.terminateCalls, 1);
  const ranking = await h.calculator.rankWord("jvw1:" + "b".repeat(64));
  assert.deepEqual(ranking.scores, []);
  assert.equal(h.workers.length, 2);
  assert.deepEqual(
    h.worker.messages.map((message) => message.type),
    ["load", "overlay", "rank"],
  );
  h.calculator.cancel();
});

test("a fatal fork error retries the full load on a replacement worker", async () => {
  const h = harness();
  await h.calculator.ensure();
  appendRecord(h);
  const failed = h.worker;
  failed.fatalAdvance = true;
  const ready = await h.calculator.ensure();
  assert.equal(ready.state, "ready");
  assert.equal(h.workers.length, 2);
  assert.equal(failed.terminateCalls, 1);
  assert.deepEqual(
    h.worker.messages.map((message) => message.type),
    ["load", "overlay"],
  );
  assert.equal(lastLoad(h).source.count, 3);
  h.calculator.cancel();
});

test("the same key after an ordinary failure restores the ready session without a worker message", async () => {
  const h = harness();
  const first = await h.calculator.ensure();
  assert.equal(first.state, "ready");
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    const failed = await h.calculator.ensure({ refresh: true });
    assert.equal(failed.state, "failed");
    if (failed.state === "failed") assert.equal(failed.kind, "network");
    const worker = h.worker;
    const messages = worker.messages.length;
    const ready = await h.calculator.ensure();
    assert.deepEqual(ready, first);
    assert.equal(h.worker, worker);
    assert.equal(h.workers.length, 1);
    assert.equal(worker.messages.length, messages);
  } finally {
    globalThis.fetch = originalFetch;
    h.calculator.cancel();
  }
});

test("an empty delta under a different key uses a full load", async () => {
  const h = harness();
  await h.calculator.ensure();
  h.setInventory(inventory([view, other], snapshot("b")));
  const ready = await h.calculator.ensure();
  assert.equal(ready.state, "ready");
  assert.equal(lastLoad(h).source.count, 2);
  assert.deepEqual(
    h.worker.messages.map((message) => message.type),
    ["load", "overlay", "load", "overlay"],
  );
  h.calculator.cancel();
});

test("an advance uses incremental rows up to the core limit and a full load above it", async () => {
  const limit = core.maxIncrementalRecords();
  assert.equal(limit, 64);

  const within = harness();
  await within.calculator.ensure();
  const withinAdded = Array.from(
    { length: limit },
    (_, index) => `jvr1:f${index.toString(16).padStart(63, "0")}`,
  );
  for (const id of withinAdded) putEmptyRecord(within, id);
  within.setInventory(inventory([view, other, ...withinAdded], snapshot("b")));
  const withinReady = await within.calculator.ensure();
  assert.equal(withinReady.state, "ready");
  assert.equal(withinReady.events, 2 + limit);
  assert.deepEqual(
    within.worker.messages.map((message) => message.type),
    ["load", "overlay", "advance", "overlay"],
  );
  within.calculator.cancel();

  const above = harness();
  await above.calculator.ensure();
  const aboveAdded = Array.from(
    { length: limit + 1 },
    (_, index) => `jvr1:f${index.toString(16).padStart(63, "0")}`,
  );
  for (const id of aboveAdded) putEmptyRecord(above, id);
  above.setInventory(inventory([view, other, ...aboveAdded], snapshot("c")));
  const aboveReady = await above.calculator.ensure();
  assert.equal(aboveReady.state, "ready");
  assert.equal(aboveReady.events, 2 + limit + 1);
  assert.deepEqual(
    above.worker.messages.map((message) => message.type),
    ["load", "overlay", "load", "overlay"],
  );
  assert.equal(lastLoad(above).source.count, 2 + limit + 1);
  above.calculator.cancel();
});

test("streamed inventory digests equal canonical JSON digests across empty and multi-page inventories", () => {
  const oldHash = (value: unknown) =>
    core.contentHash(
      core.utf8(core.canonicalize(core.utf8(JSON.stringify(value)))),
    );
  const makeEvents = (count: number) =>
    Array.from(
      { length: count },
      (_, index) => `jve1:${index.toString(16).padStart(64, "0")}`,
    );
  const makeHashes = (count: number, prefix = "0") =>
    Array.from(
      { length: count },
      (_, index) => `sha256:${prefix}${index.toString(16).padStart(63, "0")}`,
    );

  const cases = [
    { events: [], bodies: [], import_selections: [] },
    {
      events: makeEvents(1),
      bodies: [],
      import_selections: [],
    },
    {
      events: [],
      bodies: makeHashes(1, "a"),
      import_selections: makeHashes(1, "b"),
    },
    {
      events: makeEvents(1000),
      bodies: makeHashes(1000, "c"),
      import_selections: [],
    },
    {
      events: makeEvents(2005),
      bodies: makeHashes(1001, "d"),
      import_selections: makeHashes(3, "e"),
    },
  ];

  for (const sample of cases) {
    for (const pageSize of [1, 3, 256, 1000]) {
      assert.equal(
        hashInventoryIds(sample.events, pageSize),
        oldHash(sample.events),
      );
      assert.equal(
        hashInventoryIds(sample.bodies, pageSize),
        oldHash(sample.bodies),
      );
      assert.equal(
        hashInventoryIds(sample.import_selections, pageSize),
        oldHash(sample.import_selections),
      );
      assert.equal(hashLogicalInventory(sample, pageSize), oldHash(sample));
    }
  }
});

test("prepareSelectionCanonical matches prepareSelection across canonical, whitespace, and invalid inputs", () => {
  const makeIds = (count: number) =>
    Array.from(
      { length: count },
      (_, index) => `jve1:${index.toString(16).padStart(64, "0")}`,
    );
  for (const ids of [[], makeIds(1), makeIds(25), makeIds(1005)]) {
    const canonicalBytes = core.utf8(JSON.stringify(ids));
    const expected = core.prepareSelection(canonicalBytes);
    const actualCanonical = core.prepareSelectionCanonical(canonicalBytes);
    assert.equal(actualCanonical.hash, expected.hash);
    assert.equal(actualCanonical.canonical, expected.canonical);

    const formattedBytes = core.utf8(
      `[\n  ${ids.map((id) => JSON.stringify(id)).join(" ,\n  ")}\n]`,
    );
    const actualFormatted = core.prepareSelectionCanonical(formattedBytes);
    assert.equal(actualFormatted.hash, expected.hash);
    assert.equal(actualFormatted.canonical, expected.canonical);
  }

  const twoIds = makeIds(2);
  const invalidInputs = [
    new Uint8Array(0),
    core.utf8("{}"),
    core.utf8("[1]"),
    core.utf8('["jve1:bad"]'),
    core.utf8(JSON.stringify([twoIds[1], twoIds[0]])),
    core.utf8(JSON.stringify([twoIds[0], twoIds[0]])),
    new Uint8Array(16 * 1024 * 1024 + 1),
  ];
  for (const invalid of invalidInputs) {
    let expectedError = "";
    let actualError = "";
    try {
      core.prepareSelection(invalid);
    } catch (error) {
      expectedError = String(error);
    }
    try {
      core.prepareSelectionCanonical(invalid);
    } catch (error) {
      actualError = String(error);
    }
    assert.notEqual(expectedError, "");
    assert.equal(actualError, expectedError);
  }
});

test("syncRecords streams events_digest in bounded batches when the first record is missing and when resuming", async () => {
  const v8 = await import("node:v8");
  const vm = await import("node:vm");
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;

  const seed = new Uint8Array(32).fill(73);
  const items = Array.from({ length: 600 }, (_, index) =>
    core.createEvent(
      seed,
      [],
      String(index + 1).padStart(32, "0"),
      { kind: "identity.merge" },
      null,
    ),
  )
    .map((event) => ({ id: event.envelope.id, ...event }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const canon = (value: unknown) =>
    core.canonicalize(core.utf8(JSON.stringify(value)));
  const hash = (value: unknown) => core.contentHash(core.utf8(canon(value)));
  const events = items.map((item) => item.id);
  const bodies: string[] = [];
  const selectionIds = events.slice(0, 50);
  const selectionPrepared = core.prepareSelection(
    core.utf8(JSON.stringify(selectionIds)),
  );
  const selections = [selectionPrepared.hash];
  const declared = {
    events: {
      count: events.length,
      hash: core.contentHash(
        core.utf8(items.map((item) => canon(item.envelope) + "\n").join("")),
      ),
    },
    bodies: { count: 0, hash: hash(bodies) },
    import_selections: { count: 1, hash: hash(selections) },
  };
  const snap = hash(declared);
  const logical_inventory = hashLogicalInventory({
    events,
    bodies,
    import_selections: selections,
  });
  const storedById = new Map<
    string,
    {
      id: string;
      envelope: string;
      body: string | null;
      bodyStatus: "none";
      bodyHash: null;
    }
  >();
  for (const item of items) {
    storedById.set(item.id, {
      id: item.id,
      envelope: canon(item.envelope),
      body: null,
      bodyStatus: "none",
      bodyHash: null,
    });
  }

  const savedFetch = globalThis.fetch;
  const installFetch = (onRecordsRequest?: () => void) => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(
        String(input instanceof Request ? input.url : input),
        "http://peer.test",
      );
      let value: unknown;
      if (url.pathname.endsWith("/manifest")) {
        value = {
          snapshot: snap,
          logical_inventory,
          manifest: declared,
          view,
          accepted_cursor: "x.1",
          materialized_cursor: "x.1",
          packages: [],
        };
      } else if (url.pathname.endsWith("/inventory")) {
        const kind = url.searchParams.get("kind")!;
        const ids =
          kind === "events" ? events : kind === "bodies" ? bodies : selections;
        const after = url.searchParams.get("after");
        const start = after === null ? 0 : ids.indexOf(after) + 1;
        const limit = Number(url.searchParams.get("limit"));
        const pageIds = ids.slice(start, start + limit);
        value = {
          snapshot: snap,
          kind,
          ids: pageIds,
          next: start + limit < ids.length ? pageIds.at(-1) : null,
        };
      } else if (url.pathname.endsWith("/records")) {
        await new Promise((resolve) => setImmediate(resolve));
        onRecordsRequest?.();
        const after = url.searchParams.get("after");
        const start = after === null ? 0 : events.indexOf(after) + 1;
        const limit = Number(url.searchParams.get("limit"));
        const pageItems = items.slice(start, start + limit);
        value = {
          snapshot: snap,
          items: pageItems,
          next: start + limit < items.length ? pageItems.at(-1)!.id : null,
        };
      } else if (url.pathname.includes("/import-selections/")) {
        return new Response(selectionPrepared.canonical, {
          headers: { "content-type": "application/json" },
        });
      } else {
        value = { view };
      }
      return new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  };

  const makeStore = (initialIds: Iterable<string>) => {
    const recordsMap = new Map<string, any>();
    for (const id of initialIds) recordsMap.set(id, { ...storedById.get(id)! });
    const selectionsMap = new Map<string, string>();
    const inventoryMap = new Map<string, any>();
    const readBatchSizes: number[] = [];
    const writePageSizes: number[] = [];
    const postWriteReadBatchSizes: number[] = [];
    const liveRecords: WeakRef<object>[] = [];
    let writeOccurred = false;
    let seenMissingInInitialScan = false;
    let poisonAfterMissing = true;
    let maxReadBatch = 0;
    let maxWritePage = 0;
    let maxCombinedLive = 0;

    const countLive = () => {
      gc();
      return liveRecords.filter((ref) => ref.deref() !== undefined).length;
    };

    const resetTracking = (enablePoisonAfterMissing = true) => {
      readBatchSizes.length = 0;
      writePageSizes.length = 0;
      postWriteReadBatchSizes.length = 0;
      liveRecords.length = 0;
      writeOccurred = false;
      seenMissingInInitialScan = false;
      poisonAfterMissing = enablePoisonAfterMissing;
      maxReadBatch = 0;
      maxWritePage = 0;
      maxCombinedLive = 0;
    };

    const store = {
      async get(table: string, key: string) {
        if (table === "inventory") return inventoryMap.get(key);
        if (table === "records") return recordsMap.get(key);
        if (table === "selections") return selectionsMap.get(key);
        return undefined;
      },
      async put(table: string, key: string, value: any) {
        if (table === "inventory") inventoryMap.set(key, value);
        if (table === "records") recordsMap.set(key, value);
        if (table === "selections") selectionsMap.set(key, value);
      },
      async keys(table: string) {
        if (table === "selections") return [...selectionsMap.keys()];
        if (table === "records") return [...recordsMap.keys()];
        return [];
      },
      async readRecords(ids: string[]) {
        await new Promise((resolve) => setImmediate(resolve));
        maxReadBatch = Math.max(maxReadBatch, ids.length);
        maxCombinedLive = Math.max(maxCombinedLive, countLive());
        readBatchSizes.push(ids.length);
        if (writeOccurred) postWriteReadBatchSizes.push(ids.length);
        const batch = ids.map((id) => {
          const item = recordsMap.get(id);
          if (!item) {
            if (!writeOccurred) seenMissingInInitialScan = true;
            return undefined;
          }
          const envelope =
            !writeOccurred && poisonAfterMissing && seenMissingInInitialScan
              ? "x".repeat(item.envelope.length)
              : item.envelope;
          const clone = { ...item, envelope };
          liveRecords.push(new WeakRef(clone));
          return clone;
        });
        maxCombinedLive = Math.max(maxCombinedLive, countLive());
        return batch;
      },
      async putProjectedRecords(writes: { record: any; row: Uint8Array }[]) {
        for (const { record } of writes) liveRecords.push(new WeakRef(record));
        await new Promise((resolve) => setImmediate(resolve));
        writeOccurred = true;
        for (const { record } of writes)
          recordsMap.set(record.id, { ...record });
        writePageSizes.push(writes.length);
        maxWritePage = Math.max(maxWritePage, writes.length);
        maxCombinedLive = Math.max(maxCombinedLive, countLive());
      },
      async commitInventory(inv: SnapshotInventory) {
        inventoryMap.set(inv.snapshot, inv);
        inventoryMap.set("latest", inv);
      },
    } as unknown as LocalStore;

    return {
      store,
      readBatchSizes,
      writePageSizes,
      postWriteReadBatchSizes,
      countLive,
      resetTracking,
      getMaxReadBatch: () => maxReadBatch,
      getMaxWritePage: () => maxWritePage,
      getMaxCombinedLive: () => maxCombinedLive,
    };
  };

  try {
    // 1. First record missing (events[0]), every other record (events[1..599]) cached.
    let liveAtFirstFetch = -1;
    const firstMissing = makeStore(events.slice(1));
    installFetch(() => {
      if (liveAtFirstFetch < 0) liveAtFirstFetch = firstMissing.countLive();
    });
    const firstResult = await syncRecords(firstMissing.store);
    assert.equal(firstResult.events_digest, declared.events.hash);
    assert.equal(firstResult.events.length, 600);
    assert.ok(
      liveAtFirstFetch >= 0 && liveAtFirstFetch <= 1,
      `Expected no cached batch held across fetch, got ${liveAtFirstFetch}`,
    );
    assert.ok(
      firstMissing.readBatchSizes.every((size) => size <= 256),
      `Expected every read batch <= 256, got ${firstMissing.readBatchSizes.join(",")}`,
    );
    assert.deepEqual(firstMissing.postWriteReadBatchSizes, [256, 256, 87]);
    assert.ok(
      firstMissing.getMaxReadBatch() <= 256,
      `Expected read batch <= 256, got ${firstMissing.getMaxReadBatch()}`,
    );
    assert.ok(
      firstMissing.getMaxWritePage() <= 200,
      `Expected write page <= 200, got ${firstMissing.getMaxWritePage()}`,
    );
    assert.ok(
      firstMissing.getMaxCombinedLive() <= 200 + 256,
      `Expected combined live envelopes <= 456, got ${firstMissing.getMaxCombinedLive()}`,
    );

    // 2. Resumed sync: interrupted after committing the first page (0..199) with a later cached range (400..599).
    const resumed = makeStore(events.slice(400));
    installFetch();
    const abortController = new AbortController();
    await assert.rejects(
      syncRecords(resumed.store, {
        signal: abortController.signal,
        onProgress: (progress) => {
          if (progress.phase === "records" && progress.loaded === 400)
            abortController.abort(
              new Error("Interrupt after first missing page"),
            );
        },
      }),
      /Interrupt after first missing page/,
    );
    resumed.resetTracking(true);
    let liveAtResumeFetch = -1;
    installFetch(() => {
      if (liveAtResumeFetch < 0) liveAtResumeFetch = resumed.countLive();
    });
    const resumedResult = await syncRecords(resumed.store);
    assert.equal(resumedResult.events_digest, declared.events.hash);
    assert.equal(resumedResult.events.length, 600);
    assert.ok(
      liveAtResumeFetch >= 0 && liveAtResumeFetch <= 1,
      `Expected no cached batch held across resume fetch, got ${liveAtResumeFetch}`,
    );
    assert.ok(
      resumed.readBatchSizes.every((size) => size <= 256),
      `Expected every read batch <= 256, got ${resumed.readBatchSizes.join(",")}`,
    );
    assert.deepEqual(resumed.postWriteReadBatchSizes, [200]);
    assert.ok(
      resumed.getMaxReadBatch() <= 256,
      `Expected read batch <= 256, got ${resumed.getMaxReadBatch()}`,
    );
    assert.ok(
      resumed.getMaxWritePage() <= 200,
      `Expected write page <= 200, got ${resumed.getMaxWritePage()}`,
    );
    assert.ok(
      resumed.getMaxCombinedLive() <= 200 + 256,
      `Expected combined live envelopes <= 456, got ${resumed.getMaxCombinedLive()}`,
    );
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("inventory traversal stops immediately when the returned count exceeds the manifest count", async () => {
  const savedFetch = globalThis.fetch;
  let inventoryRequests = 0;
  let recordsRequests = 0;
  const idA = "jve1:" + "1".repeat(64);
  const idB = "jve1:" + "2".repeat(64);
  const idC = "jve1:" + "3".repeat(64);
  const snap = "sha256:" + "a".repeat(64);
  try {
    globalThis.fetch = (async (input: any) => {
      const url = new URL(
        typeof input === "string" ? input : input.url,
        "http://peer.test",
      );
      if (url.pathname.endsWith("/manifest")) {
        return new Response(
          JSON.stringify({
            snapshot: snap,
            logical_inventory: snap,
            manifest: {
              events: { count: 1, hash: snap },
              bodies: { count: 0, hash: snap },
              import_selections: { count: 0, hash: snap },
            },
            view,
            accepted_cursor: "x.1",
            materialized_cursor: "x.1",
            packages: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.pathname.endsWith("/inventory")) {
        inventoryRequests++;
        return new Response(
          JSON.stringify({
            snapshot: snap,
            kind: "events",
            ids: [idA, idB],
            next: idB,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.pathname.endsWith("/records")) {
        recordsRequests++;
      }
      return new Response(JSON.stringify({ view }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const store = {
      get: async () => undefined,
      put: async () => {},
      keys: async () => [],
    } as unknown as LocalStore;

    await assert.rejects(
      syncRecords(store),
      /The inventory does not match the manifest digests/,
    );
    assert.equal(inventoryRequests, 1);
    assert.equal(recordsRequests, 0);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("Wasm RuntimeError during sync and memory failure during evaluation produce physical-failure messages", async () => {
  const { isMemoryFailure, isStorageQuotaFailure } = await import(
    "../../src/data/records.ts"
  );
  const { RequestError, TransportError } = await import("../../src/data/api.ts");
  assert.equal(
    isMemoryFailure(new WebAssembly.RuntimeError("unreachable")),
    true,
  );
  assert.equal(
    isMemoryFailure(new RangeError("Array buffer allocation failed")),
    true,
  );
  assert.equal(isMemoryFailure(new RangeError("Invalid string length")), true);
  assert.equal(
    isMemoryFailure(new RangeError("Invalid time value")),
    false,
  );
  assert.equal(
    isMemoryFailure(
      new RequestError(502, "upstream_unreachable", "Upstream unreachable."),
    ),
    false,
  );
  assert.equal(
    isMemoryFailure(
      new TransportError("Peer out of memory while serving response.", "offline"),
    ),
    false,
  );
  assert.equal(
    isStorageQuotaFailure(
      new RequestError(507, "quota", "Upstream storage quota exceeded."),
    ),
    false,
  );
  assert.equal(
    isStorageQuotaFailure(
      new TransportError("Peer storage quota exceeded.", "offline"),
    ),
    false,
  );
  assert.equal(
    isStorageQuotaFailure(
      Object.assign(new Error("Quota exceeded."), { quota: true }),
    ),
    true,
  );

  const h = harness();
  const originalPostMessage = RecordingWorker.prototype.postMessage;
  let failLoadWithMemory = true;
  let failLoadWithStringLength = false;
  RecordingWorker.prototype.postMessage = function (message: WorkerRequest) {
    if (message.type === "load" && failLoadWithMemory) {
      failLoadWithMemory = false;
      queueMicrotask(() => {
        this.onmessage?.({
          data: {
            type: "error",
            id: message.id,
            message: "WebAssembly.RuntimeError: unreachable",
            session_valid: false,
            fatal: true,
            memory: true,
          },
        } as MessageEvent);
      });
      return;
    }
    if (message.type === "load" && failLoadWithStringLength) {
      failLoadWithStringLength = false;
      queueMicrotask(() => {
        this.onmessage?.({
          data: {
            type: "error",
            id: message.id,
            message: "Invalid string length",
            session_valid: false,
            fatal: true,
            memory: true,
          },
        } as MessageEvent);
      });
      return;
    }
    originalPostMessage.call(this, message);
  };
  try {
    const failed = await h.calculator.ensure();
    assert.equal(failed.state, "failed");
    if (failed.state === "failed") {
      assert.equal(failed.kind, "memory");
      assert.match(failed.message, /ran out of memory while evaluating records/);
    }

    failLoadWithStringLength = true;
    const stringLengthFailed = await h.calculator.ensure();
    assert.equal(stringLengthFailed.state, "failed");
    if (stringLengthFailed.state === "failed") {
      assert.equal(stringLengthFailed.kind, "memory");
      assert.match(
        stringLengthFailed.message,
        /ran out of memory while evaluating records/,
      );
    }
  } finally {
    RecordingWorker.prototype.postMessage = originalPostMessage;
    h.calculator.cancel();
  }
});

test("HTTP 502 with 'unreachable' in its message is classified as network, not memory", async () => {
  const savedFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: "upstream_unreachable",
          message: "Upstream server is unreachable.",
        }),
        { status: 502, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const h = harness();
    const status = await h.calculator.ensure({
      mode: "personal",
      refresh: true,
    });
    assert.equal(status.state, "failed");
    if (status.state === "failed") {
      assert.notEqual(status.kind, "memory");
      assert.match(status.message, /Upstream server is unreachable/);
    }
    h.calculator.cancel();
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("overlay setup or worker overlay failure after load keeps loadedKey, sent, and projectionDigest consistent", async () => {
  const selA = "sha256:" + "1".repeat(64);
  const selB = "sha256:" + "2".repeat(64);
  const added2 = "jvr1:" + "z".repeat(64);

  // Sub-case 1: overlayFor fails after fullLoad of S2 (with selB),
  // then S3 (with selA) runs. S3 must not advance from S2 while thinking S2 had selA.
  {
    const h = harness();
    h.selections.set(selA, JSON.stringify([other]));
    h.selections.set(selB, JSON.stringify([added]));
    h.records.set(added, {
      id: added,
      envelope: envelope(added),
      body: null,
      bodyStatus: "none",
      bodyHash: null,
    });
    h.records.set(added2, {
      id: added2,
      envelope: envelope(added2),
      body: null,
      bodyStatus: "none",
      bodyHash: null,
    });

    const inv1: SnapshotInventory = {
      ...inventory([view, other], snapshot("1")),
      selections: [selA],
    };
    const inv2: SnapshotInventory = {
      ...inventory([view, other, added], snapshot("2")),
      selections: [selB],
    };
    const inv3: SnapshotInventory = {
      ...inventory([view, other, added, added2], snapshot("3")),
      selections: [selA],
    };

    h.setInventory(inv1);
    const r1 = await h.calculator.ensure({ mode: "personal" });
    assert.equal(r1.state, "ready");

    h.setInventory(inv2);
    currentProjectionDigest = advanceDigest([added]);
    const origOverlayFor = (h.calculator as any).overlayFor.bind(h.calculator);
    let overlayCalls = 0;
    (h.calculator as any).overlayFor = async (...args: unknown[]) => {
      overlayCalls++;
      if (overlayCalls === 2) {
        throw new Error("Transient IDB error reading outbox");
      }
      return origOverlayFor(...args);
    };

    const r2 = await h.calculator.ensure({ mode: "personal" });
    assert.equal(r2.state, "failed");
    assert.equal((h.calculator as any).sent?.snapshot, inv2.snapshot);

    h.setInventory(inv3);
    currentProjectionDigest = advanceDigest([added2]);
    const beforeMessages = h.worker.messages.length;
    const r3 = await h.calculator.ensure({ mode: "personal" });
    assert.equal(r3.state, "ready");
    const run3Types = h.worker.messages
      .slice(beforeMessages)
      .map((m) => m.type);
    // Because S2 had selB and S3 has selA, Run 3 must do a full load, not an advance from S2.
    assert.ok(
      run3Types.includes("load") && !run3Types.includes("advance"),
      `Expected full load for S3 when selections differ from S2, got ${run3Types.join(",")}`,
    );
    h.calculator.cancel();
  }

  // Sub-case 2: overlayFor fails after fullLoad of S2,
  // then store rolls back to S1 and Run 3 runs on S1. Run 3 must not take sameBase on S2's session.
  {
    const h = harness();
    h.selections.set(selA, JSON.stringify([other]));
    h.selections.set(selB, JSON.stringify([added]));
    h.records.set(added, {
      id: added,
      envelope: envelope(added),
      body: null,
      bodyStatus: "none",
      bodyHash: null,
    });

    const inv1: SnapshotInventory = {
      ...inventory([view, other], snapshot("1")),
      selections: [selA],
    };
    const inv2: SnapshotInventory = {
      ...inventory([view, other, added], snapshot("2")),
      selections: [selB],
    };

    h.setInventory(inv1);
    const r1 = await h.calculator.ensure({ mode: "personal" });
    assert.equal(r1.state, "ready");
    if (r1.state === "ready") assert.equal(r1.events, 2);

    h.setInventory(inv2);
    currentProjectionDigest = advanceDigest([added]);
    const origOverlayFor = (h.calculator as any).overlayFor.bind(h.calculator);
    let overlayCalls = 0;
    (h.calculator as any).overlayFor = async (...args: unknown[]) => {
      overlayCalls++;
      if (overlayCalls === 2) {
        throw new Error("Transient IDB error reading outbox");
      }
      return origOverlayFor(...args);
    };

    const r2 = await h.calculator.ensure({ mode: "personal" });
    assert.equal(r2.state, "failed");

    // Roll back store to inv1 (2 events)
    h.setInventory(inv1);
    currentProjectionDigest = BASE_DIGEST;
    const r3 = await h.calculator.ensure({ mode: "personal" });
    assert.equal(r3.state, "ready");
    if (r3.state === "ready") {
      assert.equal(r3.snapshot, inv1.snapshot);
      assert.equal(r3.events, 2);
    }
    h.calculator.cancel();
  }

  // Sub-case 3: worker 'overlay' step failure clears loadedKey, sent, and projectionDigest.
  {
    const h = harness();
    const r1 = await h.calculator.ensure({ mode: "personal" });
    assert.equal(r1.state, "ready");
    const originalPostMessage = RecordingWorker.prototype.postMessage;
    let failWorkerOverlay = true;
    RecordingWorker.prototype.postMessage = function (message: WorkerRequest) {
      if (message.type === "overlay" && failWorkerOverlay) {
        failWorkerOverlay = false;
        queueMicrotask(() => {
          this.onmessage?.({
            data: {
              type: "error",
              id: message.id,
              message: "overlay failed",
              session_valid: false,
              fatal: false,
            },
          } as MessageEvent);
        });
        return;
      }
      originalPostMessage.call(this, message);
    };
    try {
      const r2 = await h.calculator.ensure({ mode: "site" });
      assert.equal(r2.state, "failed");
      assert.equal((h.calculator as any).loadedKey, null);
      assert.equal((h.calculator as any).sent, null);
      assert.equal((h.calculator as any).projectionDigest, null);
    } finally {
      RecordingWorker.prototype.postMessage = originalPostMessage;
      h.calculator.cancel();
    }
  }
});

test("commitInventory frees both ProjectionDigest allocations when IndexedDB reads fail", async () => {
  const { LocalStore } = await import("../../src/data/store.ts");
  const sampleDigest = core.createProjectionDigest();
  const proto = Object.getPrototypeOf(sampleDigest) as {
    free: () => void;
  };
  sampleDigest.free();

  const origFree = proto.free;
  let freeCalls = 0;
  proto.free = function (this: unknown) {
    freeCalls++;
    return origFree.call(this);
  };

  const makeReq = <T>(value: T, shouldFail = false) => {
    const req: {
      result?: T;
      error?: Error;
      onsuccess?: () => void;
      onerror?: () => void;
    } = {};
    queueMicrotask(() => {
      if (shouldFail) {
        req.error = new Error("IDB read failure");
        req.onerror?.();
      } else {
        req.result = value;
        req.onsuccess?.();
      }
    });
    return req;
  };

  try {
    // 1. Failure inside initial digest scan (hash === null)
    const inv1 = inventory([view], snapshot("1"));
    const fakeStore1 = Object.create(LocalStore.prototype) as LocalStore;
    (fakeStore1 as any).database = Promise.resolve({
      transaction: () => {
        const tx: any = {
          error: null,
          oncomplete: null,
          onabort: null,
          onerror: null,
          abort() {
            queueMicrotask(() => tx.onabort?.());
          },
          objectStore(name: string) {
            if (name === "inventory") {
              return { get: () => makeReq(undefined) };
            }
            if (name === "projections") {
              return {
                getAllKeys: () => makeReq([], true),
                getAll: () => makeReq([]),
              };
            }
            return {};
          },
        };
        return tx;
      },
    });
    await assert.rejects(
      () => fakeStore1.commitInventory(inv1),
      /IDB read failure/,
    );
    assert.equal(freeCalls, 1);

    // 2. Failure inside delta digest scan (previous && previous.snapshot !== inventory.snapshot)
    const inv2 = inventory([view, other], snapshot("2"));
    const fakeStore2 = Object.create(LocalStore.prototype) as LocalStore;
    (fakeStore2 as any).database = Promise.resolve({
      transaction: () => {
        const tx: any = {
          error: null,
          oncomplete: null,
          onabort: null,
          onerror: null,
          abort() {
            queueMicrotask(() => tx.onabort?.());
          },
          objectStore(name: string) {
            if (name === "inventory") {
              return { get: () => makeReq(inv1) };
            }
            if (name === "meta") {
              return {
                get: () =>
                  makeReq({
                    version: 1,
                    build: core.projectionBuildIdentity(),
                    events_digest: inv1.events_digest,
                    rows_hash: BASE_DIGEST,
                    count: 1,
                  }),
              };
            }
            if (name === "projections") {
              return {
                get: () => makeReq(undefined, true),
              };
            }
            return {};
          },
        };
        return tx;
      },
    });
    await assert.rejects(
      () => fakeStore2.commitInventory(inv2),
      /IDB read failure/,
    );
    assert.equal(freeCalls, 2);
  } finally {
    proto.free = origFree;
  }
});
