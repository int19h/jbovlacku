import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteIndexStore } from "../../../apps/server/src/storage.ts";
import {
  initializeCore,
  createEvent,
  identityFromSeed,
  wordId,
  utf8,
  evaluateSession,
  canonicalize,
  restoreHostEvaluationSession,
  createEvaluationSession,
} from "../../core/src/index.ts";
import { DictionaryService } from "../src/service.ts";
import type {
  EvaluationBuilder,
  EvaluationSession,
} from "../src/evaluation.ts";
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
async function fixture(
  checkpoints?: MemoryCheckpoints,
  checkpointIntervalMs: number | null = 0,
  includeSelectedView = true,
) {
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
    ...(checkpointIntervalMs === null ? {} : { checkpointIntervalMs }),
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
  const configured = {
    ...options,
    selectedView: includeSelectedView ? view.envelope.id : undefined,
  };
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

test("accepted lifecycle history stays readable while evaluation is held open", async () => {
  const { service, coordinator, profile } = await fixture();
  const completed = coordinator.state.snapshot!;
  const successorSeed = new Uint8Array(32).fill(62);
  const identity = identityFromSeed(seed);
  const successor = identityFromSeed(successorSeed);
  const transfer = createEvent(
    seed,
    [profile.envelope.id],
    "4".repeat(32),
    { kind: "identity.transfer", successor },
    null,
  );
  const compromise = createEvent(
    seed,
    [profile.envelope.id],
    "5".repeat(32),
    { kind: "identity.compromise", safe: [profile.envelope.id] },
    null,
  );
  const acceptance = createEvent(
    successorSeed,
    [],
    "6".repeat(32),
    { kind: "identity.accept", transfer: transfer.envelope.id },
    null,
  );
  const gate = deferred();
  const entered = deferred();
  const internals = service as any;
  const compute = internals.computeEvaluation.bind(service);
  let computations = 0;
  internals.computeEvaluation = async (...args: any[]) => {
    computations++;
    entered.resolve();
    await gate.promise;
    return compute(...args);
  };
  try {
    const accepted = await service.admitMany(
      [transfer, compromise, acceptance].map((record) =>
        utf8(JSON.stringify(record)),
      ),
    );
    await entered.promise;
    assert.notEqual(accepted.snapshot, completed);
    assert.equal(coordinator.state.materialized_snapshot, completed);
    assert.equal((await read(service, "/manifest")).snapshot, completed);
    const ordinary = await read(service, `/identities/${identity}/activity`);
    assert.equal(ordinary.snapshot, completed);
    assert.equal(ordinary.history, undefined);
    const heads = await read(service, `/identity-heads/${identity}`);
    assert.equal(heads.snapshot, accepted.snapshot);
    const raw = await Promise.race([
      read(
        service,
        `/identities/${identity}/activity?accepted=1&snapshot=${heads.snapshot}&limit=1`,
      ),
      new Promise<never>((_, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Accepted history waited for evaluation.")),
          1000,
        );
        timeout.unref();
      }),
    ]);
    assert.equal(raw.history, "accepted");
    assert.equal(raw.snapshot, accepted.snapshot);
    assert.equal(raw.view, undefined);
    assert.equal(
      (
        await read(
          service,
          `/identities/${identity}/activity?accepted=1&snapshot=${heads.snapshot}&view=invalid`,
        )
      ).history,
      "accepted",
    );
    for (const path of [
      `/identities/${identity}/activity?accepted=0`,
      `/identities/${identity}/activity?accepted=`,
      `/identities/${identity}?accepted=1`,
    ])
      assert.equal((await service.fetch(request(path))).status, 400);
    const items = [...raw.items];
    let after = raw.next;
    while (after) {
      const page = await read(
        service,
        `/identities/${identity}/activity?accepted=1&snapshot=${heads.snapshot}&limit=1&after=${after}`,
      );
      assert.equal(page.snapshot, accepted.snapshot);
      items.push(...page.items);
      after = page.next;
    }
    for (const event of [transfer, compromise]) {
      assert.ok(items.some((item) => item.id === event.envelope.id));
      assert.deepEqual(
        await read(
          service,
          `/events/${event.envelope.id}?snapshot=${heads.snapshot}`,
        ),
        event.envelope,
      );
    }
    assert.ok(items.every((item) => item.interpretation === "unavailable"));
    const successorHistory = await read(
      service,
      `/identities/${successor}/activity?accepted=1&snapshot=${heads.snapshot}`,
    );
    assert.deepEqual(
      successorHistory.items.map((item: any) => item.id),
      [acceptance.envelope.id],
    );
    assert.equal(computations, 1, "raw reads must not start evaluation work");
    assert.equal(coordinator.state.materialized_snapshot, completed);
  } finally {
    gate.resolve();
    await service.flushMaterialization();
  }
});

test("publication releases the superseded configured runtime and keeps cached results", async () => {
  const { service, coordinator, definition, profile } = await fixture();
  service.options.evaluationRuntime = {
    create: createEvaluationSession,
    restore: restoreHostEvaluationSession,
  };
  const oldKey =
    coordinator.state.snapshot + "|" + service.options.selectedView;
  const old = (service as any).sessions.get(oldKey);
  let released = false;
  const free = old.free.bind(old);
  old.free = () => {
    released = true;
    free();
  };
  await service.admitMany([
    utf8(
      JSON.stringify(
        judgment(definition.envelope.id, "4", [profile.envelope.id], "bless"),
      ),
    ),
  ]);
  await service.flushMaterialization();
  assert.equal(released, true);
  assert.equal((service as any).sessions.has(oldKey), false);
  assert.equal((service as any).evaluationCache.has(oldKey), true);
  assert.equal((service as any).packageCache.has(oldKey.split("|")[0]), true);
  assert.equal((service as any).retiredSessions.has(oldKey), true);
});

for (const selected of [true, false])
  test(`publication retry rebuilds a retired result with selected view ${selected}`, async () => {
    const checkpoints = new MemoryCheckpoints();
    const { service, coordinator, definition, profile } = await fixture(
      checkpoints,
      0,
      selected,
    );
    service.options.evaluationRuntime = {
      create: createEvaluationSession,
      restore: restoreHostEvaluationSession,
    };
    const internals = service as any;
    const previous = coordinator.state.snapshot!;
    const mark = coordinator.markMaterialized.bind(coordinator);
    coordinator.markMaterialized = async () => {
      throw new Error("Synthetic publication failure.");
    };
    await service.admitMany([
      utf8(
        JSON.stringify(
          judgment(definition.envelope.id, "4", [profile.envelope.id], "bless"),
        ),
      ),
    ]);
    await assert.rejects(
      service.flushMaterialization(),
      /Synthetic publication failure/,
    );
    const current = coordinator.state.snapshot!;
    const key =
      current +
      "|" +
      (service.options.selectedView ?? "jve1:" + "0".repeat(64));
    assert.equal(coordinator.state.materialized_snapshot, previous);
    assert.equal(internals.sessions.has(key), true);
    internals.retireSupersededSessions();
    assert.equal(internals.retiredSessions.has(key), true);
    assert.equal(internals.sessions.has(key), false);
    assert.equal(internals.evaluationCache.has(key), true);
    coordinator.markMaterialized = mark;
    await internals.packages(await coordinator.getSnapshot(current));
    await (service as any).flushCheckpoints();
    assert.equal(coordinator.state.materialized_snapshot, current);
    assert.equal(internals.sessions.has(key), true);
    assert.equal(internals.retiredSessions.has(key), false);
    assert.equal(checkpoints.saved?.binding.snapshot, current);
    if (selected) {
      const detail = await read(service, "/words/" + wordId(word));
      assert.ok(detail.scores.length);
    }
    assert.equal(internals.sessionRepairs.size, 0);
  });

test("pinned previous-snapshot reads reuse cached results while another write completes", async () => {
  const { service, coordinator, definition, profile } = await fixture();
  const internals = service as any;
  const historical = coordinator.state.snapshot!;
  const oldKey = historical + "|" + service.options.selectedView;
  let live = 0;
  let peak = 0;
  let creates = 0;
  let forks = 0;
  function allocate() {
    live++;
    peak = Math.max(peak, live);
    let released = false;
    return () => {
      if (!released) live--;
      released = true;
    };
  }
  function trackSession(
    session: EvaluationSession,
    release: () => void,
  ): EvaluationSession {
    return {
      state: session.state,
      isAvailable: () => session.isAvailable?.() !== false,
      rankWord: (...args) => session.rankWord(...args),
      checkpoint: (binding, resultsOnly) =>
        session.checkpoint(binding, resultsOnly),
      async fork(options) {
        forks++;
        return trackBuilder(await session.fork(options));
      },
      free() {
        session.free();
        release();
      },
    };
  }
  function trackBuilder(builder: EvaluationBuilder): EvaluationBuilder {
    const release = allocate();
    let finished = false;
    return {
      addRecord: (...args) => builder.addRecord(...args),
      addHostVerifiedRecord: (record) => builder.addHostVerifiedRecord(record),
      removeRecord: (id) => builder.removeRecord(id),
      async finish() {
        const session = await builder.finish();
        finished = true;
        return trackSession(session, release);
      },
      free() {
        builder.free();
        if (!finished) release();
      },
    };
  }
  internals.sessions.set(
    oldKey,
    trackSession(internals.sessions.get(oldKey), allocate()),
  );
  service.options.evaluationRuntime = {
    create(options) {
      creates++;
      return trackBuilder(createEvaluationSession(options));
    },
    restore() {
      throw new Error("Unexpected checkpoint restore.");
    },
  };
  const first = judgment(
    definition.envelope.id,
    "4",
    [profile.envelope.id],
    "bless",
  );
  await service.admitMany([utf8(JSON.stringify(first))]);
  await service.flushMaterialization();
  const previous = coordinator.state.snapshot!;
  const beforeReads = { creates, forks };
  const evaluations: string[] = [];
  const readGate = deferred();
  const rebuildGate = deferred();
  const entered = deferred();
  const compute = internals.computeEvaluation.bind(service);
  const evaluate = internals.evaluation.bind(service);
  const packages = internals.packages.bind(service);
  let pinnedEvaluations = 0;
  internals.computeEvaluation = async (snapshot: Snapshot, ...args: any[]) => {
    evaluations.push(snapshot.snapshot);
    // Keep an unintended historical rebuild in flight during the next write.
    if (snapshot.snapshot === historical) await rebuildGate.promise;
    return compute(snapshot, ...args);
  };
  internals.evaluation = (snapshot: Snapshot, ...args: any[]) => {
    if (snapshot.snapshot === historical && ++pinnedEvaluations === 2)
      entered.resolve();
    return evaluate(snapshot, ...args);
  };
  internals.packages = async (snapshot: Snapshot) => {
    const result = packages(snapshot);
    // Cached reads keep their results while the next write evicts this entry.
    if (snapshot.snapshot === historical) await readGate.promise;
    return result;
  };
  const reading = [
    read(service, "/search?q=klama&language=en&snapshot=" + historical),
    read(service, "/words/" + wordId(word) + "?snapshot=" + historical),
  ];
  try {
    await entered.promise;
    const second = judgment(
      definition.envelope.id,
      "5",
      [first.envelope.id],
      "curse",
    );
    await service.admitMany([utf8(JSON.stringify(second))]);
    await service.flushMaterialization();
    const latest = coordinator.state.snapshot!;
    assert.equal(coordinator.state.materialized_snapshot, latest);
    assert.deepEqual(evaluations, [latest]);
    assert.deepEqual(
      { creates, forks },
      {
        creates: beforeReads.creates,
        forks: beforeReads.forks + 1,
      },
    );
    assert.equal(internals.sessionRepairs.size, 0);
    assert.equal(internals.evaluationCache.has(oldKey), false);
    assert.equal(internals.packageCache.has(historical), false);
    assert.equal(internals.retiredSessions.has(oldKey), false);
    assert.ok(
      internals.retiredSessions.has(
        previous + "|" + service.options.selectedView,
      ),
    );
    assert.equal(internals.evaluationCache.size, 2);
    assert.equal(internals.packageCache.size, 2);
    assert.equal(internals.retiredSessions.size, 1);
    assert.equal(live, 1);
    assert.equal(peak, 2);
    readGate.resolve();
    const [search, detail] = await Promise.all(reading);
    assert.equal(search.snapshot, historical);
    assert.ok(search.hits.some((hit: any) => hit.word_id === wordId(word)));
    assert.equal(detail.snapshot, historical);
    assert.ok(detail.definitions.includes(definition.envelope.id));
    assert.deepEqual(detail.scores, []);
    assert.deepEqual(detail.unavailable_scores, [definition.envelope.id]);
    assert.deepEqual(evaluations, [latest]);
    assert.deepEqual(
      { creates, forks },
      {
        creates: beforeReads.creates,
        forks: beforeReads.forks + 1,
      },
    );
  } finally {
    readGate.resolve();
    rebuildGate.resolve();
    await Promise.allSettled(reading);
    await service.flushMaterialization().catch(() => {});
  }
});

test("publication keeps an active ranking runtime until that read finishes", async () => {
  const { service, coordinator, definition, profile } = await fixture();
  service.options.evaluationRuntime = {
    create: createEvaluationSession,
    restore: restoreHostEvaluationSession,
  };
  const oldKey =
    coordinator.state.snapshot + "|" + service.options.selectedView;
  const old = (service as any).sessions.get(oldKey);
  const entered = deferred();
  const gate = deferred();
  const rank = old.rankWord.bind(old);
  old.rankWord = async (...args: any[]) => {
    entered.resolve();
    await gate.promise;
    return rank(...args);
  };
  let released = false;
  const free = old.free.bind(old);
  old.free = () => {
    released = true;
    free();
  };
  const reading = read(service, "/words/" + wordId(word));
  await entered.promise;
  try {
    await service.admitMany([
      utf8(
        JSON.stringify(
          judgment(definition.envelope.id, "4", [profile.envelope.id], "bless"),
        ),
      ),
    ]);
    await service.flushMaterialization();
    assert.equal(released, false);
  } finally {
    gate.resolve();
  }
  assert.ok((await reading).definitions.includes(definition.envelope.id));
  assert.equal(released, true);
});

test("completed reads survive worker death while a pinned replacement restores", async () => {
  const checkpoints = new MemoryCheckpoints();
  const { service, coordinator, definition, view } = await fixture(checkpoints);
  const key = coordinator.state.snapshot + "|" + view.envelope.id;
  const dead = (service as any).sessions.get(key);
  dead.isAvailable = () => false;
  dead.rankWord = () => {
    throw new Error("The worker stopped.");
  };
  const gate = deferred();
  let restores = 0;
  let cold = 0;
  service.options.evaluationRuntime = {
    async restore(bytes, binding, records) {
      restores++;
      await gate.promise;
      return restoreHostEvaluationSession(bytes, binding, records);
    },
    create() {
      cold++;
      throw new Error("Unexpected cold evaluation.");
    },
  };
  try {
    const result = await Promise.race([
      read(service, "/words/" + wordId(word)),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Completed read waited for recovery.")),
          300,
        ),
      ),
    ]);
    assert.ok(result.definitions.includes(definition.envelope.id));
    assert.deepEqual(result.scores, []);
    const receipt = await read(service, "/receipts/" + definition.envelope.id);
    assert.equal(receipt.snapshot, coordinator.state.snapshot);
    assert.equal(receipt.interpretation, "effective");
    assert.equal(restores, 1);
    assert.equal(cold, 0);
  } finally {
    gate.resolve();
    await Promise.allSettled([
      ...((service as any).sessionRepairs?.values() ?? []),
    ]);
  }
  assert.equal(
    (service as any).sessions.get(key).isAvailable?.() !== false,
    true,
  );
  assert.ok((await read(service, "/words/" + wordId(word))).scores.length > 0);
});

test("an old worker repair cannot retire a newer snapshot during publication", async () => {
  const checkpoints = new MemoryCheckpoints();
  const { service, coordinator, definition, profile } =
    await fixture(checkpoints);
  const oldKey =
    coordinator.state.snapshot + "|" + service.options.selectedView;
  const old = (service as any).sessions.get(oldKey);
  old.isAvailable = () => false;
  const repairGate = deferred();
  const publishGate = deferred();
  const publishing = deferred();
  service.options.evaluationRuntime = {
    create: createEvaluationSession,
    async restore(bytes, binding, records) {
      await repairGate.promise;
      return restoreHostEvaluationSession(bytes, binding, records);
    },
  };
  service.options.index = {
    async replace() {
      publishing.resolve();
      await publishGate.promise;
    },
    async publish() {},
  } as any;
  await read(service, "/receipts/" + definition.envelope.id);
  try {
    await service.admitMany([
      utf8(
        JSON.stringify(
          judgment(definition.envelope.id, "4", [profile.envelope.id], "bless"),
        ),
      ),
    ]);
    await publishing.promise;
    const latest =
      coordinator.state.snapshot + "|" + service.options.selectedView;
    assert.ok((service as any).sessions.has(latest));
    repairGate.resolve();
    await Promise.all((service as any).sessionRepairs.values());
    publishGate.resolve();
    await service.flushMaterialization();
    assert.ok(
      (service as any).sessions.has(latest),
      "The newly completed worker must remain live.",
    );
    assert.ok((service as any).evaluationCache.has(latest));
    assert.ok((service as any).packageCache.has(coordinator.state.snapshot));
  } finally {
    repairGate.resolve();
    publishGate.resolve();
    await service.flushMaterialization();
  }
});

test("flush exports the pending completed checkpoint before waiting for a rebuild", async () => {
  const checkpoints = new MemoryCheckpoints();
  const { service, coordinator, definition, profile } = await fixture(
    checkpoints,
    60000,
  );
  await service.admitMany([
    utf8(
      JSON.stringify(
        judgment(definition.envelope.id, "4", [profile.envelope.id], "bless"),
      ),
    ),
  ]);
  while ((service as any).background) await (service as any).background;
  const latest = coordinator.state.snapshot;
  const gate = deferred();
  const saved = deferred();
  const save = checkpoints.save.bind(checkpoints);
  checkpoints.save = async (binding, payload) => {
    await save(binding, payload);
    saved.resolve();
  };
  (service as any).background = gate.promise.finally(() => {
    (service as any).background = undefined;
  });
  const flushing = service.flushMaterialization();
  try {
    await Promise.race([
      saved.promise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Checkpoint waited for the rebuild.")),
          300,
        ),
      ),
    ]);
    assert.equal(checkpoints.saved!.binding.snapshot, latest);
  } finally {
    gate.resolve();
    await flushing;
  }
});

test("a forced checkpoint flush retries one failed export from a live session", async () => {
  const checkpoints = new MemoryCheckpoints();
  const { service, coordinator } = await fixture(checkpoints, 60000);
  const snapshot = await coordinator.getSnapshot(coordinator.state.snapshot!);
  const key = snapshot!.snapshot + "|" + service.options.selectedView;
  const session = (service as any).sessions.get(key);
  const checkpoint = session.checkpoint.bind(session);
  let attempts = 0;
  session.checkpoint = (binding: string, resultsOnly?: boolean) => {
    if (++attempts === 1)
      throw new Error("Transient checkpoint export failure.");
    return checkpoint(binding, resultsOnly);
  };
  const packages = await (service as any).packageCache.get(snapshot!.snapshot);
  (service as any).saveCheckpoint(
    snapshot,
    coordinator.state.position,
    packages,
  );
  await service.prepareEvaluationShutdown();
  assert.equal(attempts, 2);
  assert.equal(checkpoints.saved!.binding.snapshot, snapshot!.snapshot);
  assert.equal((service as any).pendingCheckpoint, undefined);
});

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

test("receipts use a completed evaluation while a later write is still pending", async () => {
  const { service, coordinator, definition, profile } = await fixture();
  const first = judgment(
    definition.envelope.id,
    "4",
    [profile.envelope.id],
    "bless",
  );
  await service.admitMany([utf8(JSON.stringify(first))]);
  await service.flushMaterialization();
  const evaluated = await read(service, "/receipts/" + first.envelope.id);
  const definitionReceipt = await read(
    service,
    "/receipts/" + definition.envelope.id,
  );
  const gate = deferred();
  const entered = deferred();
  const compute = (service as any).computeEvaluation.bind(service);
  (service as any).computeEvaluation = async (...args: any[]) => {
    entered.resolve();
    await gate.promise;
    return compute(...args);
  };
  try {
    const second = judgment(
      definition.envelope.id,
      "5",
      [first.envelope.id],
      "curse",
    );
    await service.admitMany([utf8(JSON.stringify(second))]);
    await entered.promise;
    assert.notEqual(coordinator.state.snapshot, evaluated.snapshot);
    // The browser's receipt wait can finish without waiting for host-wide idle.
    const available = await read(service, "/receipts/" + first.envelope.id);
    assert.deepEqual(available, evaluated);
    assert.ok(available.snapshot);
    assert.ok(!available.reasons.includes("index_lag"));
    assert.ok(!available.reasons.includes("evaluation_pending"));
    assert.deepEqual(
      await read(service, "/receipts/" + definition.envelope.id),
      definitionReceipt,
    );
    const pending = await read(service, "/receipts/" + second.envelope.id);
    assert.equal(pending.snapshot, null);
    assert.equal(pending.interpretation, "unavailable");
    assert.deepEqual(pending.reasons, ["index_lag", "evaluation_pending"]);
    const key = evaluated.snapshot + "|" + service.options.selectedView;
    const sessions = (service as any).sessions;
    const session = sessions.get(key);
    const receipts = { ...session.state.receipts };
    delete receipts[first.envelope.id];
    sessions.set(key, { ...session, state: { ...session.state, receipts } });
    const cached = (service as any).evaluationCache.get(key);
    (service as any).evaluationCache.set(
      key,
      Promise.resolve({ ...session.state, receipts }),
    );
    try {
      const missingDerived = await read(
        service,
        "/receipts/" + first.envelope.id,
      );
      assert.equal(missingDerived.snapshot, evaluated.snapshot);
      assert.deepEqual(missingDerived.reasons, ["evaluation_unavailable"]);
    } finally {
      sessions.set(key, session);
      (service as any).evaluationCache.set(key, cached);
    }
  } finally {
    gate.resolve();
    await service.flushMaterialization();
  }
});

test("an idle completed event-limit evaluation reports unavailable interpretation without lag", async () => {
  const { service, coordinator, definition, profile } = await fixture();
  service.options.stateLimits = { events: 2, traversal: 1000, claim_depth: 8 };
  const entry = judgment(
    definition.envelope.id,
    "4",
    [profile.envelope.id],
    "bless",
  );
  await service.admitMany([utf8(JSON.stringify(entry))]);
  await service.flushMaterialization();
  assert.equal(
    coordinator.state.snapshot,
    coordinator.state.materialized_snapshot,
  );
  assert.equal((service as any).background, undefined);
  for (const id of [entry.envelope.id, definition.envelope.id]) {
    const asyncReceipt = await read(service, "/receipts/" + id);
    assert.equal(
      asyncReceipt.snapshot,
      coordinator.state.materialized_snapshot,
    );
    assert.equal(asyncReceipt.interpretation, "unavailable");
    assert.deepEqual(asyncReceipt.reasons, ["evaluation_unavailable"]);
    service.options.asyncMaterialization = false;
    try {
      assert.deepEqual(await read(service, "/receipts/" + id), asyncReceipt);
    } finally {
      service.options.asyncMaterialization = true;
    }
  }
});

test("a receipt keeps completed state while a missing session rebuilds", async () => {
  const { service, coordinator, definition } = await fixture();
  const expected = await read(service, "/receipts/" + definition.envelope.id);
  const key = coordinator.state.snapshot + "|" + service.options.selectedView;
  const internals = service as any;
  internals.sessions.get(key).free();
  internals.sessions.delete(key);
  // The settled state answers while the runtime rebuild runs separately.
  assert.ok(internals.evaluationCache.has(key));
  const compute = internals.computeEvaluation.bind(service);
  let evaluations = 0;
  internals.computeEvaluation = (...args: any[]) => {
    evaluations++;
    return compute(...args);
  };
  const receipt = await read(service, "/receipts/" + definition.envelope.id);
  assert.deepEqual(receipt, expected);
  assert.equal(evaluations, 1);
  await Promise.all(internals.sessionRepairs.values());
  assert.ok(internals.sessions.has(key));
  assert.ok(internals.evaluationCache.size <= 2);
});

test("package publication keeps its session until a third evaluation can use a free slot", async () => {
  const checkpoints = new MemoryCheckpoints();
  const { service, objects, coordinator, definition, profile } =
    await fixture(checkpoints);
  const historical = coordinator.state.snapshot!;
  const first = judgment(
    definition.envelope.id,
    "4",
    [profile.envelope.id],
    "bless",
  );
  await service.admitMany([utf8(JSON.stringify(first))]);
  await service.flushMaterialization();
  const gate = deferred();
  const entered = deferred();
  const put = objects.put.bind(objects);
  const complete = coordinator.state.materialized_snapshot;
  objects.put = async (hash, bytes) => {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (value.parts && value.snapshot !== complete) {
      entered.resolve();
      await gate.promise;
    }
    await put(hash, bytes);
  };
  try {
    const second = judgment(
      definition.envelope.id,
      "5",
      [first.envelope.id],
      "curse",
    );
    await service.admitMany([utf8(JSON.stringify(second))]);
    await entered.promise;
    const latest = coordinator.state.snapshot!;
    const key = latest + "|" + service.options.selectedView;
    const internals = service as any;
    assert.ok(internals.inFlightPackages.has(latest));
    assert.equal(internals.inFlightEvaluations.has(key), false);
    const third = await service.fetch(
      request("/words/" + wordId(word) + "?snapshot=" + historical),
    );
    assert.equal(third.status, 503);
    assert.equal(((await third.json()) as any).code, "resource_unavailable");
    assert.ok(internals.sessions.has(key));
    assert.equal(internals.evaluationCache.size, 2);
    gate.resolve();
    await service.flushMaterialization();
    assert.equal(coordinator.state.materialized_snapshot, latest);
    assert.equal(checkpoints.saved!.binding.snapshot, latest);
    // These receipt fields end the browser wait before it asks for the word.
    for (const id of [second.envelope.id, definition.envelope.id]) {
      const receipt = await read(service, "/receipts/" + id);
      assert.equal(receipt.snapshot, latest);
      assert.equal(receipt.interpretation, "effective");
      assert.deepEqual(receipt.reasons, []);
    }
    assert.equal(
      (
        await read(
          service,
          "/words/" + wordId(word) + "?snapshot=" + historical,
        )
      ).snapshot,
      historical,
    );
    assert.ok(internals.evaluationCache.size <= 2);
  } finally {
    gate.resolve();
    objects.put = put;
    await service.flushMaterialization();
  }
});

test("a public clear pins both configured slots until publication and then releases an alternate reader", async () => {
  const { service, coordinator, view, profile } = await fixture();
  service.options.evaluationRuntime = {
    create: createEvaluationSession,
    restore: restoreHostEvaluationSession,
  };
  const alternate = createEvent(
    seed,
    [],
    "a".repeat(32),
    { kind: "view.publish", parents: [] },
    {
      ...(view.body as Record<string, unknown>),
      name: "Alternate view",
      calculation: "simple-routes-shun-v1",
    },
  );
  const subject = identityFromSeed(new Uint8Array(32).fill(62));
  const shun = createEvent(
    seed,
    [profile.envelope.id],
    "b".repeat(32),
    {
      kind: "trust.set",
      subject,
      scope: { kind: "*", word: "*", language: "*" },
      value: "shun",
    },
    null,
  );
  await service.admitMany(
    [alternate, shun].map((record) => utf8(JSON.stringify(record))),
  );
  await service.flushMaterialization();
  const before = coordinator.state.snapshot!;
  const configuredKey = before + "|" + service.options.selectedView;
  const alternatePath =
    "/words/" + wordId(word) + "?view=" + alternate.envelope.id;
  assert.equal((await read(service, alternatePath)).snapshot, before);
  const internals = service as any;
  assert.equal(internals.evaluationCache.size, 2);
  const entered = deferred();
  const gate = deferred();
  service.options.index = {
    async replace() {},
    async publish(snapshot) {
      if (snapshot !== before) {
        entered.resolve();
        await gate.promise;
      }
    },
  };
  const clear = createEvent(
    seed,
    [shun.envelope.id],
    "c".repeat(32),
    { ...shun.envelope.header.action, value: "clear" },
    null,
  );
  try {
    await service.admitMany([utf8(JSON.stringify(clear))]);
    await entered.promise;
    const pending = coordinator.state.snapshot!;
    const pendingKey = pending + "|" + service.options.selectedView;
    assert.deepEqual(
      [...internals.evaluationCache.keys()],
      [configuredKey, pendingKey],
    );
    assert.deepEqual([...internals.inFlightEvaluations], []);
    assert.deepEqual([...internals.sessionUses], []);
    assert.deepEqual([...internals.inFlightPackages], [pending]);
    assert.deepEqual([...internals.sessionRepairs], []);
    assert.equal((await read(service, "/manifest")).snapshot, before);
    assert.equal(
      (await read(service, "/words/" + wordId(word))).snapshot,
      before,
    );
    const receipt = await read(service, "/receipts/" + clear.envelope.id);
    assert.equal(receipt.snapshot, null);
    assert.deepEqual(receipt.reasons, ["index_lag", "evaluation_pending"]);
    const busy = await service.fetch(request(alternatePath));
    assert.equal(busy.status, 503);
    assert.equal(
      ((await busy.json()) as any).message,
      "Configured view evaluations occupy the available cache slots.",
    );
    assert.equal(internals.sessions.size, 2);
    gate.resolve();
    await service.flushMaterialization();
    assert.equal(
      (await read(service, "/receipts/" + clear.envelope.id)).snapshot,
      pending,
    );
    assert.deepEqual([...internals.inFlightPackages], []);
    assert.deepEqual([...internals.inFlightEvaluations], []);
    assert.deepEqual([...internals.sessionUses], []);
    assert.equal(internals.sessions.has(configuredKey), false);
    assert.equal((await read(service, alternatePath)).snapshot, pending);
    assert.equal(internals.evaluationCache.has(configuredKey), false);
    assert.equal(internals.evaluationCache.size, 2);
    assert.equal(internals.sessions.size, 2);
  } finally {
    gate.resolve();
    await service.flushMaterialization();
  }
});

test("a failed publication releases its configured protection for a retained alternate view", async () => {
  const { service, coordinator, view, definition, profile } = await fixture();
  const alternate = createEvent(
    seed,
    [],
    "a".repeat(32),
    { kind: "view.publish", parents: [] },
    {
      ...(view.body as Record<string, unknown>),
      name: "Alternate view",
      calculation: "simple-routes-shun-v1",
    },
  );
  await service.admitMany([utf8(JSON.stringify(alternate))]);
  await service.flushMaterialization();
  const before = coordinator.state.snapshot!;
  service.options.index = {
    async replace() {},
    async publish(snapshot) {
      if (snapshot !== before) throw new Error("Publication failed.");
    },
  };
  const next = judgment(
    definition.envelope.id,
    "b",
    [profile.envelope.id],
    "bless",
  );
  await service.admitMany([utf8(JSON.stringify(next))]);
  await assert.rejects(service.flushMaterialization(), /Publication failed/);
  const internals = service as any;
  assert.equal(coordinator.state.materialized_snapshot, before);
  assert.equal(internals.evaluationCache.size, 2);
  assert.deepEqual([...internals.inFlightEvaluations], []);
  assert.deepEqual([...internals.inFlightPackages], []);
  assert.deepEqual([...internals.sessionUses], []);
  const failedKey =
    coordinator.state.snapshot + "|" + service.options.selectedView;
  assert.deepEqual([...internals.failedPackageEvaluations], [failedKey]);
  const pinned = "?snapshot=" + before;
  assert.equal(
    (await read(service, "/words/" + wordId(word) + pinned)).snapshot,
    before,
  );
  const alternatePath =
    "/words/" + wordId(word) + pinned + "&view=" + alternate.envelope.id;
  const session = internals.sessions.get(failedKey);
  const lease = deferred();
  const ranking = internals.useSession(failedKey, async () => {
    await lease.promise;
    return session.rankWord(wordId(word));
  });
  try {
    const busy = await service.fetch(request(alternatePath));
    assert.equal(busy.status, 503);
    assert.equal(internals.sessions.get(failedKey), session);
    assert.equal(internals.sessionUses.get(failedKey), 1);
  } finally {
    lease.resolve();
    await ranking;
  }
  assert.equal((await read(service, alternatePath)).snapshot, before);
  assert.equal(internals.evaluationCache.has(failedKey), false);
  assert.equal(internals.sessions.has(failedKey), false);
  assert.equal(internals.failedPackageEvaluations.size, 0);
  // Failed later admissions do not retain markers for evicted evaluations.
  let previous = next.envelope.id;
  for (const nonce of ["c", "d", "e"]) {
    const later = judgment(definition.envelope.id, nonce, [previous], "curse");
    await service.admitMany([utf8(JSON.stringify(later))]);
    await assert.rejects(service.flushMaterialization(), /Publication failed/);
    assert.deepEqual(
      [...internals.failedPackageEvaluations],
      [coordinator.state.snapshot + "|" + service.options.selectedView],
    );
    assert.equal(internals.evaluationCache.size, 2);
    previous = later.envelope.id;
  }
  const latest = coordinator.state.snapshot!;
  const latestKey = latest + "|" + service.options.selectedView;
  const entered = deferred();
  const gate = deferred();
  service.options.index.publish = async () => {
    entered.resolve();
    await gate.promise;
  };
  const rebuilding = internals.packages(await coordinator.getSnapshot(latest));
  try {
    await entered.promise;
    assert.equal(internals.failedPackageEvaluations.size, 0);
    assert.equal(internals.inFlightPackages.has(latest), true);
    assert.equal((await service.fetch(request(alternatePath))).status, 503);
    assert.equal(internals.evaluationCache.has(latestKey), true);
    assert.equal(
      (await read(service, "/words/" + wordId(word) + pinned)).snapshot,
      before,
    );
  } finally {
    gate.resolve();
    await rebuilding;
  }
  assert.equal(coordinator.state.materialized_snapshot, latest);
  assert.equal((await read(service, "/receipts/" + previous)).snapshot, latest);
  assert.equal(internals.failedPackageEvaluations.size, 0);
  assert.deepEqual([...internals.sessionUses], []);
  assert.equal(internals.evaluationCache.size, 2);
});

test("a rebuilt historical configured view does not protect an idle slot from the current alternate view", async () => {
  const { service, coordinator, view, definition, profile } = await fixture();
  const alternate = createEvent(
    seed,
    [],
    "a".repeat(32),
    { kind: "view.publish", parents: [] },
    {
      ...(view.body as Record<string, unknown>),
      name: "Alternate view",
      calculation: "simple-routes-shun-v1",
    },
  );
  await service.admitMany([utf8(JSON.stringify(alternate))]);
  await service.flushMaterialization();
  const before = coordinator.state.snapshot!;
  const next = judgment(
    definition.envelope.id,
    "b",
    [profile.envelope.id],
    "bless",
  );
  await service.admitMany([utf8(JSON.stringify(next))]);
  await service.flushMaterialization();
  const latest = coordinator.state.snapshot!;
  const alternatePath =
    "/words/" + wordId(word) + "?view=" + alternate.envelope.id;
  await read(service, alternatePath);
  assert.equal(
    (await read(service, "/words/" + wordId(word) + "?snapshot=" + before))
      .snapshot,
    before,
  );
  const internals = service as any;
  assert.deepEqual([...internals.inFlightEvaluations], []);
  assert.deepEqual([...internals.inFlightPackages], []);
  assert.deepEqual([...internals.sessionUses], []);
  assert.equal(internals.evaluationCache.size, 2);
  const historicalKey = before + "|" + service.options.selectedView;
  const session = internals.sessions.get(historicalKey);
  const rank = session.rankWord.bind(session);
  const entered = deferred();
  const gate = deferred();
  session.rankWord = async (...args: any[]) => {
    entered.resolve();
    await gate.promise;
    return rank(...args);
  };
  const reading = read(
    service,
    "/words/" + wordId(word) + "?snapshot=" + before,
  );
  try {
    await entered.promise;
    assert.equal((await service.fetch(request(alternatePath))).status, 503);
    assert.equal(internals.sessions.get(historicalKey), session);
    assert.equal(internals.sessionUses.get(historicalKey), 1);
  } finally {
    gate.resolve();
    assert.equal((await reading).snapshot, before);
  }
  assert.equal((await read(service, alternatePath)).snapshot, latest);
  assert.equal(
    internals.evaluationCache.has(latest + "|" + service.options.selectedView),
    true,
  );
  assert.deepEqual([...internals.sessionUses], []);
});

test("an alternate reader keeps its lease while a write waits and releases it for later materialization", async () => {
  const { service, coordinator, view, definition, profile } = await fixture();
  const alternate = createEvent(
    seed,
    [],
    "a".repeat(32),
    { kind: "view.publish", parents: [] },
    {
      ...(view.body as Record<string, unknown>),
      name: "Alternate view",
      calculation: "simple-routes-shun-v1",
    },
  );
  await service.admitMany([utf8(JSON.stringify(alternate))]);
  await service.flushMaterialization();
  const before = coordinator.state.snapshot!;
  const alternatePath =
    "/words/" + wordId(word) + "?view=" + alternate.envelope.id;
  await read(service, alternatePath);
  const key = before + "|" + alternate.envelope.id;
  const internals = service as any;
  const session = internals.sessions.get(key);
  const rank = session.rankWord.bind(session);
  const gate = deferred();
  const entered = deferred();
  session.rankWord = async (...args: any[]) => {
    entered.resolve();
    await gate.promise;
    return rank(...args);
  };
  const reading = read(service, alternatePath);
  try {
    await entered.promise;
    const next = judgment(
      definition.envelope.id,
      "b",
      [profile.envelope.id],
      "bless",
    );
    await service.admitMany([utf8(JSON.stringify(next))]);
    await assert.rejects(
      service.flushMaterialization(),
      (error: any) => error.code === "resource_unavailable",
    );
    assert.equal(coordinator.state.materialized_snapshot, before);
    assert.equal(internals.sessionUses.get(key), 1);
    assert.equal(internals.sessions.get(key), session);
    assert.equal(internals.evaluationCache.size, 2);
    assert.deepEqual([...internals.inFlightPackages], []);
    assert.deepEqual([...internals.inFlightEvaluations], []);
    gate.resolve();
    assert.equal((await reading).snapshot, before);
    assert.deepEqual([...internals.sessionUses], []);
    // This ordinary receipt read resumes the saved accepted inventory.
    const receipt = await read(service, "/receipts/" + next.envelope.id);
    assert.equal(receipt.snapshot, null);
    await service.flushMaterialization();
    assert.equal(
      coordinator.state.materialized_snapshot,
      coordinator.state.snapshot,
    );
    assert.equal(
      (await read(service, alternatePath)).snapshot,
      coordinator.state.snapshot,
    );
    assert.equal(internals.evaluationCache.size, 2);
    assert.deepEqual([...internals.sessionUses], []);
  } finally {
    gate.resolve();
    await reading;
    await service.flushMaterialization().catch(() => {});
  }
});

test("an asynchronous historical ranking keeps its evaluation slot until the read settles", async () => {
  const { service, coordinator, definition, profile } = await fixture();
  const historical = coordinator.state.snapshot!;
  const first = judgment(
    definition.envelope.id,
    "4",
    [profile.envelope.id],
    "bless",
  );
  await service.admitMany([utf8(JSON.stringify(first))]);
  await service.flushMaterialization();
  const key = historical + "|" + service.options.selectedView;
  const internals = service as any;
  const session = internals.sessions.get(key);
  const rank = session.rankWord.bind(session);
  const gate = deferred();
  const entered = deferred();
  session.rankWord = async (...args: any[]) => {
    entered.resolve();
    await gate.promise;
    return rank(...args);
  };
  const reading = read(
    service,
    "/words/" + wordId(word) + "?snapshot=" + historical,
  );
  try {
    await entered.promise;
    const second = judgment(
      definition.envelope.id,
      "5",
      [first.envelope.id],
      "curse",
    );
    await service.admitMany([utf8(JSON.stringify(second))]);
    while (internals.background) await internals.background;
    assert.ok(internals.sessions.has(key));
    assert.ok(internals.evaluationCache.size <= 2);
    assert.equal(coordinator.state.materialized_position, 4);
    gate.resolve();
    assert.equal((await reading).snapshot, historical);
    await read(service, "/words/" + wordId(word));
    await service.flushMaterialization();
    assert.equal(coordinator.state.materialized_position, 5);
  } finally {
    gate.resolve();
    await reading;
    await service.flushMaterialization().catch(() => {});
  }
});

test("an asynchronous removal error frees its acquired builder", async () => {
  const { service, coordinator, profile } = await fixture();
  const internals = service as any;
  const key = coordinator.state.snapshot + "|" + service.options.selectedView;
  const base = internals.sessions.get(key);
  const fork = base.fork;
  let freed = 0;
  base.fork = async () => ({
    removeRecord: async () => {
      throw new Error("Injected removal failure");
    },
    free: () => {
      freed++;
    },
  });
  const events = { ...coordinator.state.events };
  delete events[profile.envelope.id];
  try {
    const snapshot = await internals.buildSnapshot({
      ...coordinator.state,
      events,
    });
    await assert.rejects(
      internals.computeEvaluation(snapshot),
      /Injected removal failure/,
    );
    assert.equal(freed, 1);
  } finally {
    base.fork = fork;
  }
});

test("a fork retains package records after its source cache is pruned", async () => {
  const { service, coordinator, definition, profile } = await fixture();
  const internals = service as any;
  const snapshot = coordinator.state.snapshot!;
  const base = internals.sessions.get(
    snapshot + "|" + service.options.selectedView,
  );
  const fork = base.fork.bind(base);
  assert.equal(internals.packageRecords.get(snapshot).length, 1);
  base.fork = async (...args: any[]) => {
    const builder = fork(...args);
    // Model source cache eviction while the asynchronous worker fork returns.
    internals.packageCache.delete(snapshot);
    internals.packageRecords.delete(snapshot);
    return builder;
  };
  const entry = judgment(
    definition.envelope.id,
    "4",
    [profile.envelope.id],
    "bless",
  );
  await service.admitMany([utf8(JSON.stringify(entry))]);
  await service.flushMaterialization();
  const latest = coordinator.state.snapshot!;
  assert.equal(coordinator.state.materialized_snapshot, latest);
  assert.equal(internals.packageRecords.get(latest).length, 1);
  assert.equal(
    internals.packageRecords.get(latest)[0].id,
    definition.envelope.id,
  );
  const packages = await internals.packageCache.get(latest);
  assert.equal(packages.entries.length, 1);
  const result = await read(service, "/search?q=go&language=en");
  assert.equal(result.snapshot, latest);
  assert.equal(result.hits.length, 1);
});

test("a calculation-only base stays alive across an asynchronous fork", async () => {
  const { service, coordinator, definition, profile } = await fixture();
  const internals = service as any;
  const baseSnapshot = await coordinator.getSnapshot(
    coordinator.state.snapshot!,
  );
  const key = baseSnapshot!.snapshot + "|" + service.options.selectedView;
  const base = internals.sessions.get(key);
  const fork = base.fork.bind(base);
  const entered = deferred();
  const gate = deferred();
  internals.completed = undefined;
  base.fork = async (...args: any[]) => {
    entered.resolve();
    await gate.promise;
    return fork(...args);
  };
  try {
    const entry = judgment(
      definition.envelope.id,
      "4",
      [profile.envelope.id],
      "bless",
    );
    await service.admitMany([utf8(JSON.stringify(entry))]);
    await entered.promise;
    await assert.rejects(
      internals.evaluation(baseSnapshot, "jve1:" + "0".repeat(64)),
      (error: any) => error.code === "resource_unavailable",
    );
    assert.ok(internals.sessions.has(key));
    assert.equal(internals.evaluationCache.size, 2);
    gate.resolve();
    await service.flushMaterialization();
    assert.equal(
      coordinator.state.materialized_snapshot,
      coordinator.state.snapshot,
    );
    assert.equal(
      (await read(service, "/receipts/" + entry.envelope.id)).interpretation,
      "effective",
    );
    assert.equal(internals.sessionUses.size, 0);
  } finally {
    gate.resolve();
    await service.flushMaterialization().catch(() => {});
  }
});

test("a write during cold evaluation replaces a missing staged index base", async () => {
  const { objects, coordinator, options, definition, profile } =
    await fixture();
  coordinator.state = {
    ...coordinator.state,
    materialized_snapshot: null,
    materialized_position: 0,
  };
  const directory = await mkdtemp(join(tmpdir(), "jvc-cold-index-"));
  const path = join(directory, "indexes.sqlite");
  const index = new SqliteIndexStore(path, true);
  const database = new DatabaseSync(path);
  const service = new DictionaryService(objects, coordinator, {
    ...options,
    index,
  });
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
  try {
    const base = coordinator.state.snapshot!;
    await service.initialize();
    await entered.promise;
    const entry = judgment(
      definition.envelope.id,
      "4",
      [profile.envelope.id],
      "bless",
    );
    await service.admitMany([utf8(JSON.stringify(entry))]);
    const latest = coordinator.state.snapshot!;
    assert.notEqual(latest, base);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS n FROM search_snapshots").get()!.n,
      0,
    );
    gate.resolve();
    // Check the reads even when flush fails, to expose the persistent 503.
    let failure: unknown;
    try {
      await service.flushMaterialization();
    } catch (error) {
      failure = error;
    }
    const words = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await service.fetch(request("/words/" + wordId(word)));
      words.push({
        status: response.status,
        body: (await response.json()) as any,
      });
    }
    assert.deepEqual(
      words.map((word) => word.status),
      [200, 200],
      String(failure),
    );
    for (const word of words) assert.equal(word.body.snapshot, latest);
    assert.equal(failure, undefined);
    for (const route of [
      "/manifest",
      "/search?q=go&language=en",
      "/identities/" + identityFromSeed(seed),
      "/account-control?origin=https://example.invalid&account=1",
    ])
      assert.equal((await read(service, route)).snapshot, latest);
    assert.equal(
      database.prepare("SELECT snapshot FROM search_current WHERE id=1").get()!
        .snapshot,
      latest,
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS n FROM search_snapshots WHERE snapshot=?")
        .get(base)!.n,
      0,
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS n FROM search_entries WHERE snapshot=?")
        .get(latest)!.n,
      1,
    );
  } finally {
    gate.resolve();
    await service.flushMaterialization().catch(() => {});
    database.close();
    index.close();
    await rm(directory, { recursive: true, force: true });
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
  const evaluate = (service as any).computeEvaluation.bind(service);
  let fail = true;
  (service as any).computeEvaluation = async (...args: any[]) => {
    if (fail) throw new Error("Injected background failure.");
    return evaluate(...args);
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

test("a failed rebased manifest write keeps the previous publication and can retry", async () => {
  const { service, objects, definition, profile } = await fixture();
  const initial = await read(service, "/manifest");
  const entry = judgment(
    definition.envelope.id,
    "4",
    [profile.envelope.id],
    "bless",
  );
  const put = objects.put.bind(objects);
  let fail = true;
  objects.put = async (hash, bytes) => {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (fail && value.parts && value.snapshot !== initial.snapshot)
      throw new Error("Manifest write failed.");
    await put(hash, bytes);
  };
  await service.admitMany([utf8(JSON.stringify(entry))]);
  await assert.rejects(service.flushMaterialization(), /Manifest write failed/);
  assert.equal((service as any).completed.snapshot.snapshot, initial.snapshot);
  fail = false;
  assert.equal((await read(service, "/manifest")).snapshot, initial.snapshot);
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
  const rollback = coordinator.state.materialized_snapshot!;
  const published: string[] = [];
  let current = "";
  const index = {
    async replace(snapshot: string) {
      published.push(snapshot);
    },
    async publish(snapshot: string, required?: readonly string[]) {
      assert.ok(required);
      assert.ok(required.includes(earlier.snapshot));
      assert.ok(required.includes(later.snapshot));
      assert.ok(required.includes(rollback));
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

test("package publication completes before checkpoint capture and flush cancels its timer", async () => {
  const checkpoints = new MemoryCheckpoints();
  const { service, coordinator, definition, profile } =
    await fixture(checkpoints);
  let exports = 0;
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
    session.checkpoint = (binding: string, resultsOnly?: boolean) => {
      exports++;
      return exportCheckpoint(binding);
    };
    return capture(snapshot, position, packages);
  };
  const entry = judgment(
    definition.envelope.id,
    "4",
    [profile.envelope.id],
    "bless",
  );
  await service.admitMany([utf8(JSON.stringify(entry))]);
  while ((service as any).background) await (service as any).background;
  assert.equal(exports, 0);
  assert.notEqual((service as any).checkpointTimer, undefined);
  const current = coordinator.state.materialized_snapshot;
  assert.equal(
    (await read(service, "/words/" + wordId(word))).snapshot,
    current,
  );
  await service.flushMaterialization();
  assert.equal(exports, 1);
  assert.equal(checkpoints.saved?.binding.snapshot, current);
  assert.equal((service as any).checkpointTimer, undefined);
  assert.equal((service as any).checkpointJob, undefined);
  assert.equal((service as any).pendingCheckpoint, undefined);
});

for (const interval of [null, 1000]) {
  test(`checkpoint captures are rate limited with ${interval === null ? "the default interval" : "a configured interval"} and flush keeps the newest session`, async () => {
    const checkpoints = new MemoryCheckpoints();
    const { service, coordinator, definition, profile } = await fixture(
      checkpoints,
      interval,
    );
    const initial = checkpoints.saved!.binding.snapshot;
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
      const checkpoint = session.checkpoint.bind(session);
      session.checkpoint = (binding: string, resultsOnly?: boolean) => {
        captured.push(snapshot.snapshot);
        return checkpoint(binding, resultsOnly);
      };
      return capture(snapshot, position, packages);
    };
    let saves = 0;
    const save = checkpoints.save.bind(checkpoints);
    checkpoints.save = async (binding, payload) => {
      saves++;
      await save(binding, payload);
    };
    let previous = profile.envelope.id;
    try {
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
        // Completions are farther apart than the existing 100 ms quiet period.
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.deepEqual(captured, []);
        assert.equal(saves, 0);
      }
      if (interval === null)
        assert.ok((service as any).checkpointDue - performance.now() > 59000);
      assert.equal((service as any).checkpointTimer.hasRef(), false);
      const latest = coordinator.state.snapshot!;
      assert.equal(checkpoints.saved!.binding.snapshot, initial);
      // Historical reads must not evict the latest pending capture's session.
      await read(service, "/words/" + wordId(word) + "?snapshot=" + initial);
      await service.flushMaterialization();
      assert.deepEqual(captured, [latest]);
      assert.equal(saves, 1);
      assert.equal(checkpoints.saved!.binding.snapshot, latest);
      assert.equal((service as any).checkpointTimer, undefined);
    } finally {
      await service.flushMaterialization();
    }
  });
}

test("automatic checkpoint failures consume the interval and a forced flush attempts only the newest snapshot", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const checkpoints = new MemoryCheckpoints();
  const { service, coordinator, definition, profile } = await fixture(
    checkpoints,
    500,
  );
  const initial = checkpoints.saved!.binding.snapshot;
  const attempts: string[] = [];
  const exports: string[] = [];
  const capture = (service as any).saveCheckpoint.bind(service);
  (service as any).saveCheckpoint = (
    snapshot: Snapshot,
    position: number,
    packages: unknown,
  ) => {
    const session = (service as any).sessions.get(
      snapshot.snapshot + "|" + service.options.selectedView,
    );
    const checkpoint = session.checkpoint.bind(session);
    session.checkpoint = (binding: string, resultsOnly?: boolean) => {
      exports.push(snapshot.snapshot);
      return checkpoint(binding, resultsOnly);
    };
    return capture(snapshot, position, packages);
  };
  checkpoints.save = async (binding) => {
    attempts.push(binding.snapshot);
    throw new Error("Automatic checkpoint save failed.");
  };
  try {
    const first = judgment(
      definition.envelope.id,
      "4",
      [profile.envelope.id],
      "bless",
    );
    await service.admitMany([utf8(JSON.stringify(first))]);
    while ((service as any).background) await (service as any).background;
    const firstSnapshot = coordinator.state.snapshot!;
    now += 600;
    t.mock.timers.tick(600);
    await (service as any).checkpointJob;
    assert.deepEqual(attempts, [firstSnapshot]);
    assert.deepEqual(exports, [firstSnapshot]);
    assert.equal((service as any).checkpointTimer, undefined);
    const second = judgment(
      definition.envelope.id,
      "5",
      [first.envelope.id],
      "curse",
    );
    await service.admitMany([utf8(JSON.stringify(second))]);
    while ((service as any).background) await (service as any).background;
    const latest = coordinator.state.snapshot!;
    now += 150;
    t.mock.timers.tick(150);
    assert.deepEqual(attempts, [firstSnapshot]);
    assert.deepEqual(exports, [firstSnapshot]);
    assert.equal(checkpoints.saved!.binding.snapshot, initial);
    await service.flushMaterialization();
    assert.deepEqual(attempts, [firstSnapshot, latest]);
    assert.deepEqual(exports, [firstSnapshot, latest]);
    assert.equal(checkpoints.saved!.binding.snapshot, initial);
    assert.equal((service as any).pendingCheckpoint, undefined);
    assert.equal((service as any).checkpointTimer, undefined);
    assert.equal((service as any).checkpointJob, undefined);
  } finally {
    await service.flushMaterialization();
  }
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
    session.checkpoint = (binding: string, resultsOnly?: boolean) => {
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
    if (index === 0) await entered.promise;
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
    const entered = deferred();
    let saves = 0;
    checkpoints.save = () => {
      if (++saves === 1) {
        entered.resolve();
        return gate.promise;
      }
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
    await entered.promise;
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

test("damaged or mismatched checkpoint data falls back to private compact records", async () => {
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
    assert.ok(!reads.includes(definition.envelope.header.content!.hash), field);
    assert.ok((await read(restarted, "/words/" + wordId(word))).scores.length);
  }
  checkpoints.saved = structuredClone(saved);
  checkpoints.saved.payload.core = utf8("damaged");
  reads.length = 0;
  const restarted = new DictionaryService(objects, coordinator, options);
  await restarted.initialize();
  await restarted.flushMaterialization();
  assert.ok(!reads.includes(definition.envelope.header.content!.hash));
});
