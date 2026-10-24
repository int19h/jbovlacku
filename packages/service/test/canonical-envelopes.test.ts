import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteCoordinator } from "../../../apps/server/src/storage.ts";
import { canonicalStoredEnvelope, DictionaryService } from "../src/service.ts";
import {
  canonicalize,
  createEvent,
  initializeCore,
  prepareAdmission,
  signHeader,
  utf8,
} from "../../core/src/index.ts";
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
const seed = new Uint8Array(32).fill(94);
test("private event fields reproduce exact canonical envelopes without another signature or hash check", async () => {
  const records = [
    createEvent(seed, [], "1".repeat(32), { kind: "identity.merge" }, null),
    {
      envelope: signHeader(seed, {
        ...createEvent(
          seed,
          [],
          "2".repeat(32),
          { kind: "identity.merge" },
          null,
        ).envelope.header,
        action: {
          kind: "future.unknown",
          "😀": { "𐀀": 9007199254740991, é: -9007199254740991, zero: -0 },
        },
      }),
      body: null,
    },
    createEvent(
      seed,
      [],
      "3".repeat(32),
      { kind: "identity.profile" },
      { name: "😀 café", bio: [], links: [] },
    ),
  ];
  const variants = JSON.parse(
    await readFile(
      new URL("./fixtures/signature-variants.json", import.meta.url),
      "utf8",
    ),
  );
  for (const record of [...records, ...variants]) {
    const prepared = prepareAdmission(utf8(JSON.stringify(record)));
    assert.equal(
      canonicalStoredEnvelope(prepared.id, {
        header: prepared.header,
        signature: prepared.signature_bytes,
      }),
      prepared.envelope,
    );
    assert.equal(
      btoa(String.fromCharCode(...prepared.signature_bytes)),
      record.envelope.signature,
    );
  }
});
for (const checkpoint of [false, true])
  test(`first admission after ${checkpoint ? "checkpoint restore" : "cold restart"} reads no retained envelope objects`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "jvc-envelope-restart-"));
    const path = join(directory, "coordinator.sqlite");
    let coordinator = new SqliteCoordinator(path);
    const objects = new Map<string, Uint8Array>();
    const reads: string[] = [];
    const store = {
      async get(hash: string) {
        reads.push(hash);
        return objects.get(hash) ?? null;
      },
      async put(hash: string, bytes: Uint8Array) {
        objects.set(hash, bytes.slice());
      },
    };
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
    const options = {
      serverId: "envelope-restart",
      policyUrl: "https://example.invalid",
      asyncMaterialization: true,
      coreVersion: "fixed",
      checkpoints: checkpoint ? checkpoints : undefined,
      checkpointIntervalMs: 0,
    };
    try {
      const initial = new DictionaryService(store, coordinator, options);
      const records = Array.from({ length: 16 }, (_, n) =>
        createEvent(
          seed,
          [],
          n.toString(16).padStart(32, "0"),
          { kind: "identity.merge" },
          null,
        ),
      );
      await initial.admitMany(
        records.map((record) => utf8(JSON.stringify(record))),
      );
      await initial.flushMaterialization();
      if (checkpoint) assert.ok(saved);
      coordinator.close();
      coordinator = new SqliteCoordinator(path);
      const restarted = new DictionaryService(store, coordinator, options);
      await restarted.initialize();
      await restarted.flushMaterialization();
      reads.length = 0;
      const next = createEvent(
        seed,
        records.map((record) => record.envelope.id).sort(),
        "f".repeat(32),
        { kind: "identity.merge" },
        null,
      );
      const response = await restarted.admit(utf8(JSON.stringify(next)));
      assert.equal(response.status, 201);
      await restarted.flushMaterialization();
      assert.deepEqual(reads, []);
      const state = await coordinator.load();
      const snapshot = await coordinator.getSnapshot(state.snapshot!);
      const lines = Object.entries(snapshot!.events)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, event]) => canonicalStoredEnvelope(id, event) + "\n")
        .join("");
      const expected = records
        .concat(next)
        .map((record) => [
          record.envelope.id,
          canonicalize(utf8(JSON.stringify(record.envelope))),
        ])
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, envelope]) => envelope + "\n")
        .join("");
      assert.equal(lines, expected);
    } finally {
      coordinator.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
