import {
  readSemanticRecord,
  backfillSemanticRecords,
  semanticRecordStatistics,
} from "../src/semantic/storage.ts";
import type {
  CheckpointBinding,
  CheckpointStore,
  ServiceCheckpoint,
} from "../src/checkpoint.ts";
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteCoordinator } from "../../../apps/server/src/storage.ts";
import { DictionaryService } from "../src/service.ts";
import {
  backfillVerifiedRecords,
  compactRecord,
  readVerifiedRecord,
  verifiedRecordStatistics,
} from "../src/verified-records.ts";
import {
  canonicalize,
  identityFromSeed,
  wordId,
  restoreHostEvaluationSession,
  evaluateSession,
  createEvent,
  createEvaluationSession,
  evaluate,
  initializeCore,
  utf8,
  hostRecordVersion,
  semanticProjectionVersion,
  extractHostVerifiedRecord,
  prepareAdmission,
} from "../../core/src/index.ts";
import type { ObjectStore } from "../src/storage.ts";
import { createQwenProfile } from "../src/semantic/profile.ts";
import { semanticDocument } from "../src/semantic/records.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);
const seed = new Uint8Array(32).fill(91);
const options = {
  serverId: "verified-test",
  policyUrl: "https://example.invalid/policy",
};
const zeroView = "jve1:" + "0".repeat(64);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "jvc-verified-"));
  const path = join(directory, "coordinator.sqlite");
  const coordinator = new SqliteCoordinator(path);
  const bytes = new Map<string, Uint8Array>();
  const reads: string[] = [];
  const objects: ObjectStore = {
    async get(hash) {
      reads.push(hash);
      return bytes.get(hash) ?? null;
    },
    async put(hash, value) {
      bytes.set(hash, value.slice());
    },
  };
  const service = new DictionaryService(objects, coordinator, options);
  return { directory, path, coordinator, objects, bytes, reads, service };
}

test("admission stores compact rows atomically and late bodies keep historical mappings", async () => {
  const f = await fixture();
  try {
    const first = createEvent(
      seed,
      [],
      "1".repeat(32),
      { kind: "identity.profile" },
      { name: "First", bio: [], links: [] },
    );
    const second = createEvent(
      seed,
      [],
      "2".repeat(32),
      { kind: "identity.profile" },
      first.body,
    );
    await f.service.admitMany([
      utf8(JSON.stringify({ ...first, body: null })),
      utf8(JSON.stringify({ ...second, body: null })),
    ]);
    const missing = (await f.coordinator.load()).events[first.envelope.id];
    const old = await readVerifiedRecord(
      f.coordinator,
      f.objects,
      first.envelope.id,
      missing,
    );
    assert.equal(compactRecord(old).body_status, "missing");
    await f.service.admitMany([utf8(JSON.stringify(first))]);
    const state = await f.coordinator.load();
    for (const id of [first.envelope.id, second.envelope.id]) {
      const record = await readVerifiedRecord(
        f.coordinator,
        f.objects,
        id,
        state.events[id],
      );
      assert.equal(record.body_hash, first.envelope.header.content!.hash);
      assert.equal(compactRecord(record).body_status, "present");
    }
    assert.deepEqual(
      await readVerifiedRecord(
        f.coordinator,
        f.objects,
        first.envelope.id,
        missing,
      ),
      old,
    );
    const db = new DatabaseSync(f.path);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM verified_records").get()!.n,
      4,
    );
    const before = db
      .prepare("SELECT COUNT(*) AS n FROM verified_records")
      .get()!.n;
    db.exec(
      "CREATE TRIGGER reject_compact BEFORE INSERT ON verified_records BEGIN SELECT RAISE(ABORT,'Synthetic compact failure'); END",
    );
    const event = createEvent(
      seed,
      [],
      "3".repeat(32),
      { kind: "identity.merge" },
      null,
    );
    await assert.rejects(
      f.service.admitMany([utf8(JSON.stringify(event))]),
      /Synthetic compact failure/,
    );
    assert.equal(
      (await f.coordinator.load()).events[event.envelope.id],
      undefined,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM verified_records").get()!.n,
      before,
    );
    db.close();
  } finally {
    f.coordinator.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("restart evaluates stored compact records without reading original records", async () => {
  const f = await fixture();
  let reopened: SqliteCoordinator | undefined;
  try {
    const record = createEvent(
      seed,
      [],
      "4".repeat(32),
      { kind: "identity.profile" },
      { name: "Stored", bio: [], links: [] },
    );
    await f.service.admitMany([utf8(JSON.stringify(record))]);
    const snapshot = await f.coordinator.getSnapshot(
      (await f.coordinator.load()).snapshot!,
    );
    const expected = evaluate({
      events: [JSON.stringify(record.envelope)],
      bodies: {
        [record.envelope.id]: canonicalize(utf8(JSON.stringify(record.body))),
      },
      selected_view: zeroView,
      import_selections: {},
    });
    f.coordinator.close();
    reopened = new SqliteCoordinator(f.path);
    const unavailable: ObjectStore = {
      async get() {
        throw new Error("Original record read.");
      },
      async put() {
        throw new Error("Unexpected write.");
      },
    };
    let trusted = 0;
    let verifying = 0;
    const restarted = new DictionaryService(unavailable, reopened, {
      ...options,
      coreVersion: "changed-core",
      evaluationRuntime: {
        create(config) {
          const builder = createEvaluationSession(config);
          return {
            ...builder,
            addRecord() {
              verifying++;
              throw new Error("Repeated signature verification.");
            },
            addHostVerifiedRecord(bytes) {
              trusted++;
              return builder.addHostVerifiedRecord(bytes);
            },
          };
        },
        restore() {
          throw new Error("Unexpected checkpoint restore.");
        },
      },
    });
    assert.deepEqual(await (restarted as any).evaluation(snapshot), expected);
    assert.equal(trusted, 1);
    assert.equal(verifying, 0);
    assert.equal(await backfillVerifiedRecords(reopened, unavailable), 0);
    assert.deepEqual(verifiedRecordStatistics(reopened), {
      missing: 0,
      decode_failed: 0,
      backfilled: 0,
    });
  } finally {
    reopened?.close();
    f.coordinator.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("a changed extraction version backfills once by parsing private bytes", async () => {
  const f = await fixture();
  try {
    const record = createEvent(
      seed,
      [],
      "5".repeat(32),
      { kind: "identity.profile" },
      { name: "Backfill", bio: [], links: [] },
    );
    await f.service.admitMany([utf8(JSON.stringify(record))]);
    const state = await f.coordinator.load();
    const event = state.events[record.envelope.id];
    const db = new DatabaseSync(f.path);
    db.exec("UPDATE verified_records SET version=1");
    // The trusted migration does not inspect the old signature or canonical form.
    const admitted = JSON.parse(
      new TextDecoder().decode(f.bytes.get(event.envelope_hash)!),
    );
    admitted.signature = "invalid signature in private storage";
    f.bytes.set(event.envelope_hash, utf8(JSON.stringify(admitted, null, 2)));
    f.bytes.set(event.body_hash!, utf8(JSON.stringify(record.body, null, 2)));
    assert.equal(await backfillVerifiedRecords(f.coordinator, f.objects), 1);
    const compact = await readVerifiedRecord(
      f.coordinator,
      f.objects,
      record.envelope.id,
      event,
    );
    assert.equal(compact.version, hostRecordVersion());
    assert.equal(compactRecord(compact).body_status, "present");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM verified_records").get()!.n,
      2,
    );
    f.reads.length = 0;
    assert.equal(await backfillVerifiedRecords(f.coordinator, f.objects), 0);
    assert.deepEqual(f.reads, []);
    db.close();
  } finally {
    f.coordinator.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("ordinary evaluation rejects unknown host fields separately from invalid signatures", () => {
  const record = createEvent(
    seed,
    [],
    "6".repeat(32),
    { kind: "identity.merge" },
    null,
  );
  prepareAdmission(utf8(JSON.stringify(record)));
  const compact = extractHostVerifiedRecord(
    utf8(JSON.stringify(record.envelope)),
  );
  const forged = { ...record.envelope, signature: "invalid" };
  assert.throws(
    () =>
      evaluate({
        events: [JSON.stringify(record.envelope)],
        bodies: {},
        selected_view: zeroView,
        import_selections: {},
        host_records: [JSON.parse(compact)],
      } as any),
    /unknown field `host_records`/,
  );
  const builder = createEvaluationSession({
    selected_view: zeroView,
    import_selections: {},
  });
  try {
    assert.throws(() => builder.addRecord(utf8(JSON.stringify(forged))));
  } finally {
    builder.free();
  }
});

test("view and core changes and checkpoint failures reuse private records and preserve results", async () => {
  const f = await fixture();
  try {
    const definition = JSON.parse(
      await readFile(
        new URL(
          "../../../crates/jvc-core/tests/fixtures/definition.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const publication = createEvent(
      seed,
      [],
      "7".repeat(32),
      {
        kind: "definition.publish",
        word: wordId(definition.word),
        language: definition.language,
        parents: [],
        origin: "native",
      },
      definition,
    );
    const body = {
      name: "Stored view",
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
    };
    const first = createEvent(
      seed,
      [],
      "8".repeat(32),
      { kind: "view.publish", parents: [] },
      body,
    );
    const second = createEvent(
      seed,
      [],
      "9".repeat(32),
      { kind: "view.publish", parents: [] },
      {
        ...body,
        name: "Other stored view",
        H: { numerator: 4, denominator: 1 },
      },
    );
    const records = [publication, first, second];
    let saved:
      | { binding: CheckpointBinding; payload: ServiceCheckpoint }
      | undefined;
    const checkpoints: CheckpointStore = {
      async load(binding) {
        return saved &&
          JSON.stringify(binding) === JSON.stringify(saved.binding)
          ? structuredClone(saved.payload)
          : null;
      },
      async save(binding, payload) {
        saved = structuredClone({ binding, payload });
      },
    };
    const configured = {
      ...options,
      selectedView: first.envelope.id,
      asyncMaterialization: true,
      checkpoints,
      checkpointIntervalMs: 0,
      coreVersion: "core-v1",
    };
    const initial = new DictionaryService(f.objects, f.coordinator, configured);
    await initial.initialize();
    await initial.admitMany(
      records.map((record) => utf8(JSON.stringify(record))),
    );
    await initial.flushMaterialization();
    assert.ok(saved);
    assert.equal(
      "nodes" in JSON.parse(new TextDecoder().decode(saved!.payload.core)),
      false,
    );
    assert.equal("package_records" in saved!.payload, false);
    assert.equal("envelopes" in saved!.payload, false);
    const database = new DatabaseSync(f.path);
    const beforeRows = database
      .prepare("SELECT COUNT(*) AS n FROM verified_records")
      .get()!.n;
    const baseline = structuredClone(saved!);
    const snapshot = await f.coordinator.getSnapshot(
      (await f.coordinator.load()).snapshot!,
    );
    const unavailable: ObjectStore = {
      async get() {
        throw new Error("Original record read.");
      },
      async put() {},
    };
    for (const scenario of [
      "valid",
      "missing",
      "damaged",
      "incompatible",
      "view",
      "core",
    ] as const) {
      saved = scenario === "missing" ? undefined : structuredClone(baseline);
      if (scenario === "damaged")
        saved!.payload.core = utf8("broken result checkpoint");
      if (scenario === "incompatible") saved!.binding.schema = 2 as any;
      const selectedView =
        scenario === "view" ? second.envelope.id : first.envelope.id;
      let verifying = 0,
        trusted = 0,
        restores = 0;
      const restarted = new DictionaryService(unavailable, f.coordinator, {
        ...configured,
        selectedView,
        coreVersion: scenario === "core" ? "core-v2" : "core-v1",
        evaluationRuntime: {
          create(config) {
            const builder = createEvaluationSession(config);
            return {
              ...builder,
              addRecord() {
                verifying++;
                throw new Error("Repeated verification.");
              },
              addHostVerifiedRecord(record) {
                trusted++;
                return builder.addHostVerifiedRecord(record);
              },
            };
          },
          restore(bytes, binding, compact) {
            restores++;
            return restoreHostEvaluationSession(bytes, binding, compact);
          },
        },
      });
      await restarted.initialize();
      await restarted.flushMaterialization();
      const expected = evaluate({
        events: records.map((record) =>
          canonicalize(utf8(JSON.stringify(record.envelope))),
        ),
        bodies: Object.fromEntries(
          records.map((record) => [
            record.envelope.id,
            canonicalize(utf8(JSON.stringify(record.body))),
          ]),
        ),
        selected_view: selectedView,
        import_selections: {},
      });
      assert.deepEqual(
        await (restarted as any).evaluation(snapshot),
        expected,
        scenario,
      );
      const session = (restarted as any).sessions.get(
        snapshot!.snapshot + "|" + selectedView,
      );
      const original = evaluateSession({
        events: records.map((record) =>
          canonicalize(utf8(JSON.stringify(record.envelope))),
        ),
        bodies: Object.fromEntries(
          records.map((record) => [
            record.envelope.id,
            canonicalize(utf8(JSON.stringify(record.body))),
          ]),
        ),
        selected_view: selectedView,
        import_selections: {},
      });
      try {
        assert.deepEqual(
          await session.rankWord(wordId(definition.word)),
          original.rankWord(wordId(definition.word)),
          scenario,
        );
      } finally {
        original.free();
      }
      assert.equal(verifying, 0, scenario);
      assert.equal(
        database.prepare("SELECT COUNT(*) AS n FROM verified_records").get()!.n,
        beforeRows,
        scenario,
      );
      assert.deepEqual(verifiedRecordStatistics(f.coordinator), {
        missing: 0,
        decode_failed: 0,
        backfilled: 0,
      });
      if (scenario === "valid") {
        assert.equal(restores, 1);
        assert.equal(trusted, 0);
      } else assert.equal(trusted, records.length, scenario);
    }
  } finally {
    f.coordinator.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("admission persists final preferred-envelope and nonpreferred late-body bindings before evaluation", async () => {
  const variants = JSON.parse(
    await readFile(
      new URL("./fixtures/signature-variants.json", import.meta.url),
      "utf8",
    ),
  );
  const prepared = variants.map((record: unknown) =>
    prepareAdmission(utf8(JSON.stringify(record))),
  );
  const compare = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  };
  const ordered = variants
    .map((carrier: any, n: number) => ({ carrier, prepared: prepared[n] }))
    .sort((a: any, b: any) =>
      compare(a.prepared.signature_bytes, b.prepared.signature_bytes),
    );
  const [preferred, other] = ordered;
  assert.equal(preferred.prepared.id, other.prepared.id);
  assert.notEqual(
    preferred.prepared.envelope_hash,
    other.prepared.envelope_hash,
  );
  for (const scenario of ["preferred", "nonpreferred-body"]) {
    const f = await fixture();
    try {
      const service = new DictionaryService(f.objects, f.coordinator, {
        ...options,
        asyncMaterialization: true,
      });
      (service as any).queueMaterialization = () => {};
      // Both orders use genuine valid SSHSIG representations of the same header.
      const initial = scenario === "preferred" ? other : preferred;
      await service.admitMany([
        utf8(JSON.stringify({ ...initial.carrier, body: null })),
      ]);
      const late = scenario === "preferred" ? preferred : other;
      await service.admitMany([utf8(JSON.stringify(late.carrier))]);
      const state = await f.coordinator.load();
      const event = state.events[preferred.prepared.id];
      assert.equal(event.envelope_hash, preferred.prepared.envelope_hash);
      assert.equal(
        event.body_hash,
        preferred.carrier.envelope.header.content.hash,
      );
      const row = await f.coordinator.getVerifiedRecord({
        id: preferred.prepared.id,
        envelope_hash: event.envelope_hash,
        body_hash: event.body_hash,
        version: hostRecordVersion(),
      });
      assert.ok(
        row,
        scenario +
          " must commit the final compact binding without lazy backfill",
      );
      assert.equal(compactRecord(row).body_status, "present");
      assert.ok(
        await f.coordinator.getSemanticRecord({
          id: preferred.prepared.id,
          envelope_hash: event.envelope_hash,
          body_hash: event.body_hash,
          version: semanticProjectionVersion(),
        }),
        "Admission must commit the exact semantic binding too.",
      );
      assert.deepEqual(verifiedRecordStatistics(f.coordinator), {
        missing: 0,
        decode_failed: 0,
        backfilled: 0,
      });
      const { canonicalStoredEnvelope } = await import("../src/service.ts");
      assert.equal(
        canonicalStoredEnvelope(preferred.prepared.id, event),
        preferred.prepared.envelope,
      );
    } finally {
      f.coordinator.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});

test("malformed current-version rows report their event and repair once without cryptographic verification", async () => {
  const f = await fixture();
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message: string) => warnings.push(message);
  try {
    const record = createEvent(
      seed,
      [],
      "c".repeat(32),
      { kind: "identity.profile" },
      { name: "Repair fixture", bio: [], links: [] },
    );
    await f.service.admitMany([utf8(JSON.stringify(record))]);
    const event = (await f.coordinator.load()).events[record.envelope.id];
    const binding = {
      id: record.envelope.id,
      envelope_hash: event.envelope_hash,
      body_hash: event.body_hash,
      version: hostRecordVersion(),
    };
    const expected = await f.coordinator.getVerifiedRecord(binding);
    const database = new DatabaseSync(f.path);
    for (const invalid of [
      "broken JSON",
      JSON.stringify({ ...JSON.parse(expected!.compact), state: {} }),
      JSON.stringify({ ...JSON.parse(expected!.compact), id: "wrong-event" }),
    ]) {
      database.prepare("UPDATE verified_records SET compact=?").run(invalid);
      // Trusted original bytes need no valid signature or canonical formatting during repair.
      const envelope = JSON.parse(
        new TextDecoder().decode(f.bytes.get(event.envelope_hash)!),
      );
      envelope.signature = "already admitted";
      f.bytes.set(event.envelope_hash, utf8(JSON.stringify(envelope, null, 2)));
      const restored = await readVerifiedRecord(
        f.coordinator,
        f.objects,
        record.envelope.id,
        event,
      );
      assert.equal(restored.compact, expected!.compact);
      assert.equal(
        (await f.coordinator.getVerifiedRecord(binding))!.compact,
        expected!.compact,
      );
    }
    const snapshot = await f.coordinator.getSnapshot(
      (await f.coordinator.load()).snapshot!,
    );
    const expectedState = await (f.service as any).evaluation(snapshot);
    database
      .prepare("UPDATE verified_records SET compact=?")
      .run("damaged before cold evaluation");
    const cold = new DictionaryService(f.objects, f.coordinator, options);
    assert.deepEqual(await (cold as any).evaluation(snapshot), expectedState);
    assert.equal(
      (await f.coordinator.getVerifiedRecord(binding))!.compact,
      expected!.compact,
    );
    assert.equal(verifiedRecordStatistics(f.coordinator).decode_failed, 4);
    assert.equal(verifiedRecordStatistics(f.coordinator).backfilled, 4);
    assert.equal(verifiedRecordStatistics(f.coordinator).missing, 0);
    assert.equal(warnings.length, 4);
    for (const warning of warnings)
      assert.equal(JSON.parse(warning).id, record.envelope.id);
    f.reads.length = 0;
    await readVerifiedRecord(
      f.coordinator,
      f.objects,
      record.envelope.id,
      event,
    );
    assert.deepEqual(f.reads, []);
    database.close();
  } finally {
    console.warn = warn;
    f.coordinator.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("older definition rows backfill semantic evidence and defaults without changing signed bodies", async () => {
  const f = await fixture();
  try {
    const body = {
      word: { language: "jbo" as const, spelling: "broda" },
      language: "en",
      text: [["Sparse stored definition."]],
      classification: { kind: "gismu" },
      license: { expression: "CC0-1.0" },
    };
    const record = createEvent(
      seed,
      [],
      "e".repeat(32),
      {
        kind: "definition.publish",
        word: wordId(body.word),
        language: "en",
        parents: [],
        origin: "native",
      },
      body,
    );
    await f.service.admitMany([utf8(JSON.stringify(record))]);
    const event = (await f.coordinator.load()).events[record.envelope.id];
    const originalEnvelope = f.bytes.get(event.envelope_hash)!.slice();
    const originalBody = f.bytes.get(event.body_hash!)!.slice();
    const db = new DatabaseSync(f.path);
    const prior = JSON.parse(
      (await f.coordinator.getVerifiedRecord({
        id: record.envelope.id,
        envelope_hash: event.envelope_hash,
        body_hash: event.body_hash,
        version: hostRecordVersion(),
      }))!.compact,
    );
    const evidence = await readSemanticRecord(
      f.coordinator,
      f.objects,
      record.envelope.id,
      event,
    );
    prior.version = 3;
    prior.semantic = JSON.parse(evidence.projection).semantic;
    db.prepare("UPDATE verified_records SET version=3,compact=?").run(
      JSON.stringify(prior),
    );
    db.close();
    assert.equal(await backfillVerifiedRecords(f.coordinator, f.objects), 1);
    const compact = compactRecord(
      await readVerifiedRecord(
        f.coordinator,
        f.objects,
        record.envelope.id,
        event,
      ),
    );
    assert.equal(compact.version, hostRecordVersion());
    assert.equal(compact.body_status, "present");
    assert.deepEqual(compact.package!.body!.glosses, []);
    assert.deepEqual(compact.package!.body!.classification, {
      kind: "gismu",
      selmaho: [],
    });
    assert.deepEqual(compact.package!.body!.notes, []);
    assert.equal("semantic" in compact, false);
    const semantic = await readSemanticRecord(
      f.coordinator,
      f.objects,
      record.envelope.id,
      event,
    );
    assert.deepEqual(JSON.parse(semantic.projection).semantic.body, {
      ...body,
      classification: { kind: "gismu", selmaho: [] },
      frame: null,
      glosses: [],
      operands: [],
      notes: [],
      etymology: { text: [], formation: null, compound: null },
      examples: [],
      labels: [],
      sources: [],
      license: { expression: "CC0-1.0", url: null, attribution: "" },
      legacy: null,
    });
    assert.equal(compact.package!.body_hash, event.body_hash);
    assert.deepEqual(f.bytes.get(event.envelope_hash), originalEnvelope);
    assert.deepEqual(f.bytes.get(event.body_hash!), originalBody);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(originalBody)), body);
    f.reads.length = 0;
    assert.equal(await backfillVerifiedRecords(f.coordinator, f.objects), 0);
    assert.deepEqual(f.reads, []);
  } finally {
    f.coordinator.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("late definition bodies create semantic inputs only for the new exact body mapping", async () => {
  const f = await fixture();
  try {
    const profile = createQwenProfile();
    const body = {
      word: { language: "jbo" as const, spelling: "broda" },
      language: "en",
      text: [["Literal $x_{1}$ and unmatched $a+b."]],
      classification: { kind: "gismu" },
      license: { expression: "CC0-1.0" },
    };
    const publication = createEvent(
      seed,
      [],
      "f".repeat(32),
      {
        kind: "definition.publish",
        word: wordId(body.word),
        language: "en",
        parents: [],
        origin: "native",
      },
      body,
    );
    await f.service.admitMany([
      utf8(JSON.stringify({ ...publication, body: null })),
    ]);
    const id = publication.envelope.id;
    const missing = (await f.coordinator.load()).events[id];
    const before = await readSemanticRecord(
      f.coordinator,
      f.objects,
      id,
      missing,
    );
    assert.equal(semanticDocument(profile, before), null);
    await f.service.admitMany([utf8(JSON.stringify(publication))]);
    const present = (await f.coordinator.load()).events[id];
    const after = await readSemanticRecord(
      f.coordinator,
      f.objects,
      id,
      present,
    );
    const document = semanticDocument(profile, after)!;
    assert.equal(document.body, publication.envelope.header.content!.hash);
    assert.deepEqual(document.definition.text, body.text);
    assert.deepEqual(document.definition.frame, null);
    assert.equal(
      semanticDocument(
        profile,
        await readSemanticRecord(f.coordinator, f.objects, id, missing),
      ),
      null,
    );
    assert.notEqual(before.body_hash, after.body_hash);
    f.reads.length = 0;
    assert.equal(await backfillSemanticRecords(f.coordinator, f.objects), 0);
    assert.deepEqual(f.reads, []);
  } finally {
    f.coordinator.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("damaged current semantic projections repair once from private original bytes", async () => {
  const f = await fixture();
  const warn = console.warn;
  console.warn = () => {};
  try {
    const body = {
      word: { language: "jbo" as const, spelling: "broda" },
      language: "en",
      text: [["A sparse definition."]],
      classification: { kind: "gismu" },
      license: { expression: "CC0-1.0" },
    };
    const publication = createEvent(
      seed,
      [],
      "d".repeat(32),
      {
        kind: "definition.publish",
        word: wordId(body.word),
        language: "en",
        parents: [],
        origin: "native",
      },
      body,
    );
    await f.service.admitMany([utf8(JSON.stringify(publication))]);
    const id = publication.envelope.id;
    const event = (await f.coordinator.load()).events[id];
    const expected = await readSemanticRecord(
      f.coordinator,
      f.objects,
      id,
      event,
    );
    const db = new DatabaseSync(f.path);
    const mutations = [
      (value: any) => delete value.semantic,
      (value: any) => (value.semantic = "broken"),
      (value: any) => (value.semantic = null),
      (value: any) => (value.semantic.body = null),
      (value: any) => (value.semantic.body.glosses = null),
      (value: any) => (value.semantic.body.frame = { places: null }),
      (value: any) => (value.semantic.body_hash = "sha256:" + "0".repeat(64)),
      (value: any) => (value.semantic.unexpected = true),
    ];
    for (const mutate of mutations) {
      const compact = JSON.parse(expected.projection);
      mutate(compact);
      db.prepare("UPDATE semantic_records SET projection=?").run(
        JSON.stringify(compact),
      );
      const repaired = await readSemanticRecord(
        f.coordinator,
        f.objects,
        id,
        event,
      );
      assert.equal(repaired.projection, expected.projection);
      f.reads.length = 0;
      assert.deepEqual(
        await readSemanticRecord(f.coordinator, f.objects, id, event),
        expected,
      );
      assert.deepEqual(f.reads, []);
    }
    assert.equal(
      semanticRecordStatistics(f.coordinator).decode_failed,
      mutations.length,
    );
    assert.equal(
      semanticRecordStatistics(f.coordinator).backfilled,
      mutations.length,
    );
    db.close();
  } finally {
    console.warn = warn;
    f.coordinator.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
