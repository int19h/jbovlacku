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

test("an import selection change alone uses a full load", async () => {
  const h = harness();
  const selection = "sha256:" + "9".repeat(64);
  h.selections.set(selection, JSON.stringify([other]));
  await h.calculator.ensure();
  h.setInventory({
    ...inventory([view, other], snapshot("b")),
    selections: [selection],
  });
  await h.calculator.ensure();
  assert.deepEqual(lastLoad(h).options.import_selections, {
    [selection]: [other],
  });
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
