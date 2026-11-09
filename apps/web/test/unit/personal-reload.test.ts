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

  postMessage(message: WorkerRequest) {
    this.messages.push(structuredClone(message));
    if (message.type === "load") this.events = message.input.events.length;
    if (message.type === "advance") this.events += message.input.events.length;
    queueMicrotask(() => {
      if (message.type === "advance" && this.failAdvance) {
        this.failAdvance = false;
        this.onmessage?.({
          data: { type: "error", id: message.id, message: "advance failed" },
        } as MessageEvent);
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

  terminate() {}
}

type Harness = {
  calculator: InstanceType<typeof PersonalCalculator>;
  worker: RecordingWorker;
  records: Map<string, unknown>;
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
  const store = {
    get: async (name: string, id: string) => {
      if (name === "inventory" && id === "latest") return currentInventory;
      if (name === "records") return records.get(id);
      throw new Error(`Unexpected read: ${name}/${id}`);
    },
    overlay: async () => currentOverlay,
  } as unknown as LocalStore;
  const worker = new RecordingWorker();
  (globalThis as { Worker?: unknown }).Worker = class {
    constructor() {
      return worker;
    }
  };
  return {
    calculator: new PersonalCalculator(store, async () => ({ identity: null })),
    worker,
    records,
    setInventory: (value) => {
      currentInventory = value;
    },
    setOverlay: (value) => {
      currentOverlay = value;
    },
  };
}

function appendRecord(h: Harness) {
  h.records.set(added, {
    id: added,
    envelope: envelope(added),
    body: null,
    bodyStatus: "none",
    bodyHash: null,
  });
  h.setInventory(inventory([view, other, added], snapshot("b")));
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
  h.calculator.cancel();
});

test("a non-append snapshot and an overlay change use a full load", async () => {
  const h = harness();
  await h.calculator.ensure();
  appendRecord(h);
  await h.calculator.ensure();
  h.setInventory(inventory([view, added], snapshot("c")));
  await h.calculator.ensure();
  assert.equal(h.worker.messages.at(-1)?.type, "load");
  const replaced = h.worker.messages.at(-1);
  assert.equal(replaced?.type, "load");
  if (replaced?.type === "load")
    assert.deepEqual(replaced.input.events, [envelope(view), envelope(added)]);

  h.setOverlay({
    ...emptyOverlay(),
    blocked: [
      {
        identity: "ed25519:" + "1".repeat(64),
        scope: { kind: "*", word: "*", language: "*" },
      },
    ],
  });
  h.calculator.invalidate();
  await h.calculator.ensure();
  assert.equal(h.worker.messages.at(-1)?.type, "load");
  h.calculator.cancel();
});

test("sent records are cleared when an advance fails", async () => {
  const h = harness();
  await h.calculator.ensure();
  appendRecord(h);
  h.worker.failAdvance = true;
  assert.equal((await h.calculator.ensure()).state, "failed");
  const retry = await h.calculator.ensure();
  assert.equal(retry.state, "ready");
  assert.equal(h.worker.messages.at(-1)?.type, "load");
  const loaded = h.worker.messages.at(-1);
  assert.equal(loaded?.type, "load");
  if (loaded?.type === "load") assert.equal(loaded.input.events.length, 3);
  h.calculator.cancel();
});
