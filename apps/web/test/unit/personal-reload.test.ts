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
    view,
    events,
    bodies: [bodyHash],
    selections: [],
  };
}

class RecordingWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: WorkerRequest[] = [];
  events = 0;
  failAdvance = false;
  crashAdvance = false;
  holdAdvance: Promise<void> | null = null;
  advanceStarted: (() => void) | null = null;
  terminateCalls = 0;

  postMessage(message: WorkerRequest) {
    this.messages.push(structuredClone(message));
    if (message.type === "load") this.events = message.input.events.length;
    if (message.type === "advance") this.events += message.input.events.length;
    queueMicrotask(async () => {
      if (message.type === "advance" && this.holdAdvance) {
        const held = this.holdAdvance;
        this.holdAdvance = null;
        this.advanceStarted?.();
        await held;
      }
      if (message.type === "advance" && this.failAdvance) {
        this.failAdvance = false;
        this.onmessage?.({
          data: { type: "error", id: message.id, message: "advance failed" },
        } as MessageEvent);
        return;
      }
      if (message.type === "advance" && this.crashAdvance) {
        this.crashAdvance = false;
        this.crash("The advance worker crashed.");
        return;
      }
      if (message.type === "actors") {
        this.onmessage?.({
          data: { type: "actors", id: message.id, actors: {} },
        } as MessageEvent);
        return;
      }
      if (message.type === "load" || message.type === "advance") {
        this.onmessage?.({
          data: {
            type: "loaded",
            id: message.id,
            session: message.session,
            available: true,
            reasons: [],
            events: this.events,
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
};

function harness(): Harness {
  let currentInventory = inventory([view, other], snapshot("a"));
  let currentOverlay = emptyOverlay();
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
  const store = {
    get: async (name: string, id: string) => {
      if (name === "inventory" && id === "latest") return currentInventory;
      if (name === "records") return records.get(id);
      if (name === "selections") return selections.get(id);
      throw new Error(`Unexpected read: ${name}/${id}`);
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
    },
    setOverlay: (value) => {
      currentOverlay = value;
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
  const message = h.worker.messages.at(-1);
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
    ["actors", "load", "actors", "advance"],
  );
  const first = h.worker.messages[1];
  const advance = h.worker.messages[3];
  assert.equal(first.type, "load");
  assert.equal(advance.type, "advance");
  if (first.type !== "load" || advance.type !== "advance") return;
  assert.equal(advance.base, first.session);
  assert.deepEqual(advance.input.events, [envelope(added)]);
  assert.deepEqual(advance.input.bodies, {});
  assert.equal(advance.input.selected_view, view);
  assert.equal(
    (advance.input.overlay as { version: number } | undefined)?.version,
    2,
  );
  h.calculator.cancel();
});

test("a new ID that sorts between loaded IDs advances with only that envelope", async () => {
  const h = harness();
  const inserted = "jve1:" + "d".repeat(64);
  await h.calculator.ensure();
  putEmptyRecord(h, inserted);
  h.setInventory(inventory([view, inserted, other], snapshot("b")));
  const ready = await h.calculator.ensure();
  assert.equal(ready.state, "ready");
  const advance = h.worker.messages.at(-1);
  assert.equal(advance?.type, "advance");
  if (advance?.type === "advance")
    assert.deepEqual(advance.input.events, [envelope(inserted)]);
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
  const advance = h.worker.messages.at(-1);
  assert.equal(advance?.type, "advance");
  if (advance?.type === "advance")
    assert.deepEqual(advance.input.events, [
      envelope(before),
      envelope(middle),
      envelope(added),
    ]);
  h.calculator.cancel();
});

test("a new ID combined with a removal uses a full load", async () => {
  const h = harness();
  const inserted = "jve1:" + "d".repeat(64);
  await h.calculator.ensure();
  putEmptyRecord(h, inserted);
  h.setInventory(inventory([view, inserted], snapshot("b")));
  await h.calculator.ensure();
  assert.deepEqual(lastLoad(h).input.events, [
    envelope(view),
    envelope(inserted),
  ]);
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
  assert.deepEqual(replaced.input.events, [envelope(view), envelope(added)]);
  h.calculator.cancel();
});

test("an overlay change alone uses a full load without invalidation", async () => {
  const h = harness();
  await h.calculator.ensure();
  h.setOverlay(privateOverlay());
  await h.calculator.ensure();
  const loaded = lastLoad(h);
  assert.equal(
    (loaded.input.overlay as { blocked: unknown[] } | undefined)?.blocked
      .length,
    1,
  );
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
  assert.equal(lastLoad(h).input.selected_view, nextView);
  h.calculator.cancel();
});

test("a mode change alone uses a full load", async () => {
  const h = harness();
  await h.calculator.ensure({ mode: "personal" });
  await h.calculator.ensure({ mode: "site" });
  assert.equal(lastLoad(h).input.overlay, undefined);
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
  assert.deepEqual(lastLoad(h).input.import_selections, {
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
  assert.equal(
    lastLoad(h).input.bodies[other],
    JSON.stringify({ changed: true }),
  );
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
  assert.equal(lastLoad(h).input.events.length, 3);
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
    ["load"],
  );
  assert.equal(lastLoad(h).input.events.length, 3);
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
    ["load"],
  );
  assert.equal(lastLoad(h).input.events.length, 2);
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
  assert.equal(lastLoad(h).input.events.length, 3);
  h.calculator.cancel();
});
