import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  initializeCore,
  createEvent,
  identityFromSeed,
  wordId,
  utf8,
  evaluateSession,
  canonicalize,
} from "../../core/src/index.ts";
import { DictionaryService } from "../src/service.ts";
import {
  emptyState,
  type State,
  type Snapshot,
  type ObjectStore,
} from "../src/storage.ts";
import type {
  CheckpointBinding,
  CheckpointStore,
  ServiceCheckpoint,
} from "../src/checkpoint.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);
const seed = new Uint8Array(32).fill(61);
const word = { language: "jbo" as const, spelling: "klama" };
const request = (path: string) => new Request("http://localhost/api/v1" + path);
const read = async (service: DictionaryService, path: string) => {
  const response = await service.fetch(request(path));
  assert.equal(response.status, 200, await response.clone().text());
  return response.json() as Promise<any>;
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class MemoryCoordinator {
  state = emptyState();
  snapshots = new Map<string, Snapshot>();
  async load() {
    return this.state;
  }
  async loadMetadata() {
    const {
      revision,
      position,
      snapshot,
      materialized_position,
      materialized_snapshot,
    } = this.state;
    return {
      revision,
      position,
      snapshot,
      materialized_position,
      materialized_snapshot,
    };
  }
  async getSnapshot(id: string) {
    return this.snapshots.get(id) ?? null;
  }
  async compareAndSwap(revision: number, state: State, snapshot?: Snapshot) {
    if (this.state.revision !== revision) return false;
    this.state = state;
    if (snapshot) this.snapshots.set(snapshot.snapshot, snapshot);
    return true;
  }
  async markMaterialized(snapshot: string, position: number) {
    if (this.state.snapshot !== snapshot || this.state.position !== position)
      return false;
    this.state = {
      ...this.state,
      revision: this.state.revision + 1,
      materialized_snapshot: snapshot,
      materialized_position: position,
    };
    return true;
  }
}
class MemoryCheckpoints implements CheckpointStore {
  saved?: { binding: CheckpointBinding; payload: ServiceCheckpoint };
  loads: CheckpointBinding[] = [];
  async load(binding: CheckpointBinding) {
    this.loads.push(binding);
    return this.saved &&
      JSON.stringify(this.saved.binding) === JSON.stringify(binding)
      ? structuredClone(this.saved.payload)
      : null;
  }
  async save(binding: CheckpointBinding, payload: ServiceCheckpoint) {
    this.saved = structuredClone({ binding, payload });
  }
}
async function fixture(checkpoints?: MemoryCheckpoints) {
  const bytes = new Map<string, Uint8Array>();
  const reads: string[] = [];
  const objects: ObjectStore = {
    async get(hash) {
      reads.push(hash);
      return bytes.get(hash)?.slice() ?? null;
    },
    async put(hash, value) {
      bytes.set(hash, value.slice());
    },
  };
  const coordinator = new MemoryCoordinator();
  const options = {
    serverId: "async-test",
    policyUrl: "https://example.invalid/policy",
    asyncMaterialization: true,
    checkpoints,
    coreVersion: "test-artifact:1",
  };
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
      glosses: [{ language: "en", text: "go", sense: null }],
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
      name: "Materialization fixture",
      description: [],
      roots: [
        {
          identity: identityFromSeed(seed),
          q: { numerator: 1, denominator: 1 },
        },
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
  const profile = createEvent(
    seed,
    [],
    "3".repeat(32),
    { kind: "identity.profile" },
    { name: "Test author", bio: [], links: [] },
  );
  const configured = { ...options, selectedView: view.envelope.id };
  const service = new DictionaryService(objects, coordinator, configured);
  await service.initialize();
  const records = [definition, view, profile];
  await service.admitMany(
    records.map((record) => utf8(JSON.stringify(record))),
  );
  await service.flushMaterialization();
  return {
    service,
    objects,
    coordinator,
    options: configured,
    definition,
    view,
    profile,
    records,
    reads,
  };
}
function judgment(
  target: string,
  nonce: string,
  previous: string[],
  value: string,
) {
  return createEvent(
    seed,
    previous,
    nonce.repeat(32),
    { kind: "judgment.set", target, value },
    null,
  );
}

test("background writes keep complete reads and cursors until the latest snapshot publishes", async () => {
  const { service, coordinator, definition, profile, view, records } =
    await fixture();
  const initial = await read(service, "/manifest");
  const gate = deferred();
  const entered = deferred();
  const original = (service as any).computeEvaluation.bind(service);
  let held = false;
  (service as any).computeEvaluation = async (...args: any[]) => {
    if (!held) {
      held = true;
      entered.resolve();
      await gate.promise;
    }
    return original(...args);
  };
  const writes = [];
  let previous = profile.envelope.id;
  for (const [index, value] of ["bless", "curse", "bless"].entries()) {
    const entry = judgment(
      definition.envelope.id,
      String(index + 4),
      [previous],
      value,
    );
    previous = entry.envelope.id;
    writes.push(entry);
    const result = await service.admitMany([utf8(JSON.stringify(entry))]);
    assert.equal(result.receipts[0].admission, "accepted");
    assert.equal(result.receipts[0].interpretation, "unavailable");
    assert.equal(result.receipts[0].snapshot, null);
    assert.equal(result.receipts[0].body_status, "none");
    assert.deepEqual(result.receipts[0].reasons, [
      "index_lag",
      "evaluation_pending",
    ]);
  }
  await entered.promise;
  const paths = [
    "/words/" + wordId(word),
    "/search?q=go&language=en",
    "/identities/" + identityFromSeed(seed),
    "/account-control?origin=https://example.invalid&account=1",
    "/manifest",
  ];
  for (const path of paths) {
    const response = await read(service, path);
    assert.equal(response.snapshot, initial.snapshot);
    if (path !== "/manifest") assert.equal(response.view, view.envelope.id);
    else {
      assert.equal(response.accepted_cursor, "async-test.6");
      assert.equal(response.materialized_cursor, "async-test.3");
    }
  }
  assert.equal(
    (await read(service, "/inventory?kind=events")).snapshot,
    coordinator.state.snapshot,
  );
  const oldReceipt = await read(service, "/receipts/" + profile.envelope.id);
  assert.equal(oldReceipt.snapshot, initial.snapshot);
  assert.equal(oldReceipt.body_status, "present");
  gate.resolve();
  await service.flushMaterialization();
  const latest = await read(service, "/manifest");
  assert.equal(latest.snapshot, coordinator.state.snapshot);
  assert.equal(latest.materialized_cursor, "async-test.6");
  assert.equal(
    (await read(service, "/receipts/" + previous)).snapshot,
    latest.snapshot,
  );
  assert.equal(
    (
      await read(
        service,
        "/words/" + wordId(word) + "?snapshot=" + initial.snapshot,
      )
    ).snapshot,
    initial.snapshot,
  );
  const all = [...records, ...writes];
  const full = evaluateSession({
    events: all.map((record) =>
      canonicalize(utf8(JSON.stringify(record.envelope))),
    ),
    bodies: Object.fromEntries(
      all
        .filter((record) => record.body !== null)
        .map((record) => [
          record.envelope.id,
          canonicalize(utf8(JSON.stringify(record.body))),
        ]),
    ),
    selected_view: view.envelope.id,
    import_selections: {},
  });
  try {
    assert.deepEqual(
      (service as any).sessions.get(latest.snapshot + "|" + view.envelope.id)
        .state,
      full.state,
    );
  } finally {
    full.free();
  }
});

test("a failed background job keeps the old snapshot and a read retries it", async () => {
  const { service, objects, definition, profile } = await fixture();
  const initial = await read(service, "/manifest");
  const entry = judgment(
    definition.envelope.id,
    "4",
    [profile.envelope.id],
    "bless",
  );
  const get = objects.get.bind(objects);
  let fail = true;
  objects.get = async (hash) => {
    if (fail && hash !== definition.envelope.header.content?.hash)
      throw new Error("Injected background failure.");
    return get(hash);
  };
  await service.admitMany([utf8(JSON.stringify(entry))]);
  await assert.rejects(
    service.flushMaterialization(),
    /Injected background failure/,
  );
  fail = false;
  const gate = deferred();
  const original = (service as any).computeEvaluation.bind(service);
  (service as any).computeEvaluation = async (...args: any[]) => {
    await gate.promise;
    return original(...args);
  };
  assert.equal(
    (await read(service, "/words/" + wordId(word))).snapshot,
    initial.snapshot,
  );
  gate.resolve();
  await service.flushMaterialization();
  assert.notEqual(
    (await read(service, "/manifest")).snapshot,
    initial.snapshot,
  );
});

test("a late-body receipt does not name an older snapshot with a different body mapping", async () => {
  const { service, profile } = await fixture();
  const late = createEvent(
    seed,
    [profile.envelope.id],
    "8".repeat(32),
    { kind: "identity.profile" },
    { name: "Late profile", bio: [], links: [] },
  );
  await service.admitMany([utf8(JSON.stringify({ ...late, body: null }))]);
  await service.flushMaterialization();
  const missing = await read(service, "/receipts/" + late.envelope.id);
  assert.equal(missing.body_status, "missing");
  const gate = deferred();
  const original = (service as any).computeEvaluation.bind(service);
  (service as any).computeEvaluation = async (...args: any[]) => {
    await gate.promise;
    return original(...args);
  };
  const delivered = await service.admitMany([utf8(JSON.stringify(late))]);
  assert.equal(delivered.receipts[0].admission, "duplicate");
  assert.equal(delivered.receipts[0].cursor, missing.cursor);
  assert.equal(delivered.receipts[0].body_status, "present");
  assert.equal(delivered.receipts[0].snapshot, null);
  assert.equal(
    (await read(service, "/receipts/" + late.envelope.id)).snapshot,
    null,
  );
  gate.resolve();
  await service.flushMaterialization();
  assert.notEqual(
    (await read(service, "/receipts/" + late.envelope.id)).snapshot,
    missing.snapshot,
  );
});

test("a stale receipt retry selects the latest accepted snapshot", async () => {
  const { service, coordinator, profile, definition } = await fixture();
  service.options.asyncMaterialization = false;
  const first = judgment(
    definition.envelope.id,
    "4",
    [profile.envelope.id],
    "bless",
  );
  const firstResult = await service.admitMany([utf8(JSON.stringify(first))]);
  const stale = (await coordinator.getSnapshot(firstResult.snapshot))!;
  const second = judgment(
    definition.envelope.id,
    "5",
    [first.envelope.id],
    "curse",
  );
  const latest = await service.admitMany([utf8(JSON.stringify(second))]);
  service.options.asyncMaterialization = true;
  (service as any).backgroundError = new Error("Failed latest job.");
  const queued: string[] = [];
  const packages = (service as any).packages.bind(service);
  (service as any).packages = (snapshot: Snapshot) => {
    queued.push(snapshot.snapshot);
    return packages(snapshot);
  };
  await (service as any).receipt(first.envelope.id, "duplicate", stale, 4);
  await service.flushMaterialization();
  assert.equal(queued[0], latest.snapshot);
  assert.equal((await read(service, "/manifest")).snapshot, latest.snapshot);
});

test("historical package completion cannot regress a newer materialized index", async () => {
  const { service, objects, coordinator, options, definition, profile } =
    await fixture();
  service.options.asyncMaterialization = false;
  const first = judgment(
    definition.envelope.id,
    "4",
    [profile.envelope.id],
    "bless",
  );
  const earlier = await service.admitMany([utf8(JSON.stringify(first))]);
  const second = judgment(
    definition.envelope.id,
    "5",
    [first.envelope.id],
    "curse",
  );
  const later = await service.admitMany([utf8(JSON.stringify(second))]);
  const published: string[] = [];
  let current = "";
  const index = {
    async replace(snapshot: string) {
      published.push(snapshot);
    },
    async publish(snapshot: string) {
      current = snapshot;
    },
  };
  const separate: any = new DictionaryService(objects, coordinator, {
    ...options,
    asyncMaterialization: false,
    index,
  });
  const gate = deferred();
  const original = separate.computeEvaluation.bind(separate);
  separate.computeEvaluation = async (snapshot: Snapshot, ...args: any[]) => {
    if (snapshot.snapshot === earlier.snapshot) await gate.promise;
    return original(snapshot, ...args);
  };
  const old = separate.packages(
    await coordinator.getSnapshot(earlier.snapshot),
  );
  await separate.packages(await coordinator.getSnapshot(later.snapshot));
  assert.equal(current, later.snapshot);
  gate.resolve();
  await old;
  assert.equal(current, later.snapshot);
  assert.equal(coordinator.state.materialized_snapshot, later.snapshot);
  assert.ok(!published.includes(earlier.snapshot));
});

test("fallback publication rechecks the snapshot after loading full state", async () => {
  const { service, objects, coordinator, options, definition, profile } =
    await fixture();
  const completed = coordinator.state.materialized_snapshot;
  service.options.asyncMaterialization = false;
  const first = judgment(
    definition.envelope.id,
    "4",
    [profile.envelope.id],
    "bless",
  );
  const earlier = await service.admitMany([utf8(JSON.stringify(first))]);
  const captured = await coordinator.loadMetadata();
  const second = judgment(
    definition.envelope.id,
    "5",
    [first.envelope.id],
    "curse",
  );
  await service.admitMany([utf8(JSON.stringify(second))]);
  let metadataReads = 0;
  const fallback = {
    load: coordinator.load.bind(coordinator),
    loadMetadata: async () =>
      ++metadataReads <= 2 ? captured : coordinator.loadMetadata(),
    getSnapshot: coordinator.getSnapshot.bind(coordinator),
    compareAndSwap: coordinator.compareAndSwap.bind(coordinator),
  };
  let indexSnapshot = completed;
  const index = {
    async replace() {},
    async publish(snapshot: string) {
      indexSnapshot = snapshot;
    },
  };
  const separate: any = new DictionaryService(objects, fallback, {
    ...options,
    asyncMaterialization: false,
    index,
  });
  await separate.packages(await coordinator.getSnapshot(earlier.snapshot));
  assert.equal(coordinator.state.materialized_snapshot, completed);
  assert.equal(coordinator.state.materialized_position, 3);
  assert.equal(indexSnapshot, completed);
  assert.equal(separate.completed, undefined);
});

test("a host checkpoint restores complete reads without rereading original publications", async () => {
  const checkpoints = new MemoryCheckpoints();
  const { service, objects, coordinator, options, definition, reads } =
    await fixture(checkpoints);
  const before = await read(service, "/words/" + wordId(word));
  assert.ok(checkpoints.saved);
  reads.length = 0;
  const restarted = new DictionaryService(objects, coordinator, options);
  await restarted.initialize();
  assert.deepEqual(await read(restarted, "/words/" + wordId(word)), before);
  assert.ok(!reads.includes(definition.envelope.header.content!.hash));
  assert.equal(checkpoints.loads.at(-1)?.snapshot, before.snapshot);
  assert.equal(checkpoints.loads.at(-1)?.core_version, options.coreVersion);
});

test("restart keeps an older complete checkpoint while accepted writes wait", async () => {
  const checkpoints = new MemoryCheckpoints();
  const { service, objects, coordinator, options, definition, profile } =
    await fixture(checkpoints);
  const old = await read(service, "/manifest");
  service.options.asyncMaterialization = false;
  const entry = judgment(
    definition.envelope.id,
    "4",
    [profile.envelope.id],
    "bless",
  );
  const accepted = await service.admitMany([utf8(JSON.stringify(entry))]);
  const restarted: any = new DictionaryService(objects, coordinator, {
    ...options,
    asyncMaterialization: true,
  });
  const gate = deferred();
  const original = restarted.computeEvaluation.bind(restarted);
  restarted.computeEvaluation = async (...args: any[]) => {
    await gate.promise;
    return original(...args);
  };
  await restarted.initialize();
  const manifest = await read(restarted, "/manifest");
  assert.equal(manifest.snapshot, old.snapshot);
  assert.equal(manifest.accepted_cursor, "async-test.4");
  assert.equal(manifest.materialized_cursor, "async-test.3");
  assert.equal(
    (await read(restarted, "/words/" + wordId(word))).snapshot,
    old.snapshot,
  );
  gate.resolve();
  await restarted.flushMaterialization();
  assert.equal(
    (await read(restarted, "/manifest")).snapshot,
    accepted.snapshot,
  );
  assert.equal(checkpoints.saved?.binding.snapshot, accepted.snapshot);
});

test("checkpoint startup restores index metadata and rejects publication failure", async () => {
  const checkpoints = new MemoryCheckpoints();
  const { objects, coordinator, options } = await fixture(checkpoints);
  let staged = "";
  let published = "";
  const index = {
    async replace() {},
    async restore(snapshot: string, entries: unknown[]) {
      assert.ok(entries.length);
      staged = snapshot;
    },
    async publish(snapshot: string) {
      assert.equal(staged, snapshot);
      published = snapshot;
    },
  };
  const restarted = new DictionaryService(objects, coordinator, {
    ...options,
    index,
  });
  await restarted.initialize();
  assert.equal(published, checkpoints.saved?.binding.snapshot);
  const failed = new DictionaryService(objects, coordinator, {
    ...options,
    index: {
      ...index,
      async publish() {
        throw new Error("Index publication failed.");
      },
    },
  });
  await assert.rejects(failed.initialize(), /Index publication failed/);
  assert.equal(
    (await failed.fetch(new Request("http://localhost/api/health/ready")))
      .status,
    503,
  );
});

test("checkpoint writes capture only the latest pending session and share unchanged package records", async () => {
  const checkpoints = new MemoryCheckpoints();
  const { service, definition, profile, coordinator } =
    await fixture(checkpoints);
  const initialRecords = (service as any).packageRecords.get(
    coordinator.state.snapshot,
  );
  const gate = deferred();
  const entered = deferred();
  const save = checkpoints.save.bind(checkpoints);
  let saves = 0;
  checkpoints.save = async (binding, payload) => {
    if (++saves === 1) {
      entered.resolve();
      await gate.promise;
    }
    await save(binding, payload);
  };
  const captured: string[] = [];
  const capture = (service as any).saveCheckpoint.bind(service);
  (service as any).saveCheckpoint = (
    snapshot: Snapshot,
    position: number,
    packages: unknown,
  ) => {
    const session = (service as any).sessions.get(
      snapshot.snapshot + "|" + service.options.selectedView,
    );
    const exportCheckpoint = session.checkpoint.bind(session);
    session.checkpoint = (binding: string) => {
      captured.push(snapshot.snapshot);
      return exportCheckpoint(binding);
    };
    return capture(snapshot, position, packages);
  };
  const snapshots: string[] = [];
  let previous = profile.envelope.id;
  for (const [index, value] of ["bless", "curse", "bless"].entries()) {
    const entry = judgment(
      definition.envelope.id,
      String(index + 4),
      [previous],
      value,
    );
    previous = entry.envelope.id;
    await service.admitMany([utf8(JSON.stringify(entry))]);
    while ((service as any).background) await (service as any).background;
    snapshots.push(coordinator.state.snapshot!);
    assert.equal(
      (service as any).packageRecords.get(coordinator.state.snapshot),
      initialRecords,
    );
  }
  await entered.promise;
  assert.deepEqual(captured, [snapshots[0]]);
  gate.resolve();
  await service.flushMaterialization();
  assert.deepEqual(captured, [snapshots[0], snapshots[2]]);
  assert.equal(checkpoints.saved?.binding.snapshot, snapshots[2]);
  assert.equal(saves, 2);
});

test(
  "checkpoint completion reschedules a descriptor queued before its finalizer",
  { timeout: 2000 },
  async () => {
    const checkpoints = new MemoryCheckpoints();
    const { service, coordinator } = await fixture(checkpoints);
    const gate = deferred();
    const second = deferred();
    let saves = 0;
    checkpoints.save = () => {
      if (++saves === 1) return gate.promise;
      second.resolve();
      return Promise.resolve();
    };
    const snapshot = await coordinator.getSnapshot(coordinator.state.snapshot!);
    const packages = await (service as any).packageCache.get(
      snapshot!.snapshot,
    );
    (service as any).saveCheckpoint(
      snapshot,
      coordinator.state.position,
      packages,
    );
    gate.resolve();
    queueMicrotask(() =>
      (service as any).saveCheckpoint(
        snapshot,
        coordinator.state.position,
        packages,
      ),
    );
    await second.promise;
    await service.flushMaterialization();
    assert.equal(saves, 2);
  },
);

test(
  "a failed latest checkpoint save stops without repeating the export",
  { timeout: 2000 },
  async () => {
    const checkpoints = new MemoryCheckpoints();
    const { service, coordinator } = await fixture(checkpoints);
    let saves = 0;
    checkpoints.save = async () => {
      saves++;
      throw new Error("Checkpoint save failed.");
    };
    const snapshot = await coordinator.getSnapshot(coordinator.state.snapshot!);
    const packages = await (service as any).packageCache.get(
      snapshot!.snapshot,
    );
    (service as any).saveCheckpoint(
      snapshot,
      coordinator.state.position,
      packages,
    );
    await service.flushMaterialization();
    assert.equal(saves, 1);
    assert.equal((service as any).checkpointJob, undefined);
    assert.equal((service as any).pendingCheckpoint, undefined);
  },
);

test("damaged or mismatched checkpoint data falls back to original records", async () => {
  const checkpoints = new MemoryCheckpoints();
  const { objects, coordinator, options, definition, reads } =
    await fixture(checkpoints);
  const saved = structuredClone(checkpoints.saved!);
  for (const field of ["schema", "view", "limits", "core_version"] as const) {
    checkpoints.saved = structuredClone(saved);
    (checkpoints.saved.binding as any)[field] = "mismatch";
    reads.length = 0;
    const restarted = new DictionaryService(objects, coordinator, options);
    await restarted.initialize();
    await restarted.flushMaterialization();
    assert.ok(reads.includes(definition.envelope.header.content!.hash), field);
  }
  checkpoints.saved = structuredClone(saved);
  checkpoints.saved.payload.core = utf8("damaged");
  reads.length = 0;
  const restarted = new DictionaryService(objects, coordinator, options);
  await restarted.initialize();
  await restarted.flushMaterialization();
  assert.ok(reads.includes(definition.envelope.header.content!.hash));
});
