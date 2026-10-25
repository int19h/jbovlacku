import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteCoordinator } from "../../../apps/server/src/storage.ts";
import { SqlRowsCoordinator } from "../src/sql-coordinator.ts";
import { DictionaryService } from "../src/service.ts";
import {
  backfillVerifiedRecords,
  readVerifiedRecord,
} from "../src/verified-records.ts";
import {
  readSemanticRecord,
  backfillSemanticRecords,
  semanticRecordStatistics,
} from "../src/semantic/storage.ts";
import { createQwenProfile } from "../src/semantic/profile.ts";
import { semanticDocument } from "../src/semantic/records.ts";
import {
  initializeCore,
  createEvent,
  wordId,
  utf8,
  semanticProjectionVersion,
} from "../../core/src/index.ts";
import type { ObjectStore } from "../src/storage.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);
const publication = (nonce: string) => {
  const body = {
    word: { language: "jbo" as const, spelling: "broda" },
    language: "en",
    text: [["Test $x_{1}$ and unmatched $a+b."]],
    classification: { kind: "gismu" },
    license: { expression: "CC0-1.0" },
  };
  return createEvent(
    new Uint8Array(32).fill(75),
    [],
    nonce.repeat(32),
    {
      kind: "definition.publish",
      word: wordId(body.word),
      language: body.language,
      origin: "native",
      parents: [],
    },
    body,
  );
};

for (const backend of ["node", "worker-sql"] as const)
  test(`${backend}: semantic rows are atomic, independent, and absent from cold evaluation`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "semantic-store-"));
    const path = join(directory, "coordinator.sqlite");
    const database = new DatabaseSync(path);
    // The Worker passes the same synchronous SQL cursor and transactionSync shape.
    const workerStorage = {
      sql: {
        exec(sql: string, ...bindings: (string | number)[]) {
          const statement = database.prepare(sql);
          const rows = statement.columns().length
            ? (statement.all(...bindings) as Record<string, unknown>[])
            : (statement.run(...bindings), []);
          return { toArray: () => rows };
        },
      },
      transactionSync<T>(operation: () => T) {
        database.exec("BEGIN IMMEDIATE");
        try {
          const value = operation();
          database.exec("COMMIT");
          return value;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      },
    };
    const coordinator =
      backend === "node"
        ? new SqliteCoordinator(path)
        : new SqlRowsCoordinator({
            exec: (sql, ...bindings) =>
              workerStorage.sql.exec(sql, ...bindings).toArray(),
            transaction: (operation) =>
              workerStorage.transactionSync(operation),
          });
    const stored = new Map<string, Uint8Array>();
    const reads: string[] = [];
    const objects: ObjectStore = {
      async get(hash) {
        reads.push(hash);
        return stored.get(hash) ?? null;
      },
      async put(hash, bytes) {
        stored.set(hash, bytes.slice());
      },
    };
    const options = {
      serverId: "semantic-store-test",
      policyUrl: "https://example.invalid/policy",
    };
    const service = new DictionaryService(objects, coordinator, options);
    const count = (table: string) =>
      Number(database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
    try {
      const first = publication("1");
      await service.admitMany([utf8(JSON.stringify(first))]);
      const state = await coordinator.load();
      const id = first.envelope.id;
      const event = state.events[id];
      const verified = await readVerifiedRecord(
        coordinator,
        objects,
        id,
        event,
      );
      assert.ok(
        await coordinator.getSemanticRecord({
          id,
          envelope_hash: event.envelope_hash,
          body_hash: event.body_hash,
          version: semanticProjectionVersion(),
        }),
      );
      const semantic = await readSemanticRecord(
        coordinator,
        objects,
        id,
        event,
      );
      assert.equal("semantic" in JSON.parse(verified.compact), false);
      assert.ok(semanticDocument(createQwenProfile(), semantic));
      assert.equal(count("semantic_records"), 1);
      assert.equal(count("verified_records"), 1);
      database.exec(
        "CREATE TRIGGER reject_semantic_stage BEFORE INSERT ON semantic_record_staging BEGIN SELECT RAISE(ABORT,'Synthetic semantic staging failure'); END",
      );
      await assert.rejects(
        coordinator.stageVerifiedRecords(
          "atomic-stage",
          [verified],
          [semantic],
        ),
        /Synthetic semantic staging failure/,
      );
      assert.equal(count("verified_record_staging"), 0);
      assert.equal(count("semantic_record_staging"), 0);
      database.exec("DROP TRIGGER reject_semantic_stage");
      await coordinator.stageVerifiedRecords(
        "atomic-stage",
        [verified],
        [semantic],
      );
      assert.equal(count("verified_record_staging"), 1);
      assert.equal(count("semantic_record_staging"), 1);
      assert.equal(
        await coordinator.compareAndSwap(
          state.revision + 1,
          state,
          undefined,
          [],
          [],
          "atomic-stage",
        ),
        false,
      );
      assert.equal(count("verified_record_staging"), 1);
      assert.equal(count("semantic_record_staging"), 1);
      await coordinator.discardVerifiedRecordStage("atomic-stage");
      assert.equal(count("verified_record_staging"), 0);
      assert.equal(count("semantic_record_staging"), 0);
      database.exec(
        "CREATE TRIGGER reject_semantic BEFORE INSERT ON semantic_records BEGIN SELECT RAISE(ABORT,'Synthetic semantic failure'); END",
      );
      const second = publication("2");
      await assert.rejects(
        service.admitMany([utf8(JSON.stringify(second))]),
        /Synthetic semantic failure/,
      );
      assert.equal((await coordinator.load()).revision, state.revision);
      assert.equal(
        (await coordinator.load()).events[second.envelope.id],
        undefined,
      );
      assert.equal(count("verified_records"), 1);
      assert.equal(count("semantic_records"), 1);
      database.exec("DROP TRIGGER reject_semantic");

      database.exec(
        "UPDATE semantic_records SET projection='damaged semantic row'",
      );
      const getSemantic = coordinator.getSemanticRecord.bind(coordinator);
      coordinator.getSemanticRecord = async () => {
        throw new Error("Evaluation read semantic storage.");
      };
      const unavailable: ObjectStore = {
        async get() {
          throw new Error("Evaluation read originals.");
        },
        async put() {
          throw new Error("Unexpected write.");
        },
      };
      const snapshot = await coordinator.getSnapshot(state.snapshot!);
      const cold = new DictionaryService(unavailable, coordinator, {
        ...options,
        coreVersion: "new-core",
      });
      await (cold as any).evaluation(snapshot);
      assert.equal(await backfillVerifiedRecords(coordinator, unavailable), 0);
      assert.equal(semanticRecordStatistics(coordinator).decode_failed, 0);
      coordinator.getSemanticRecord = getSemantic;
      const warn = console.warn;
      console.warn = () => {};
      try {
        assert.equal(
          (await readSemanticRecord(coordinator, objects, id, event))
            .projection,
          semantic.projection,
        );
      } finally {
        console.warn = warn;
      }
      assert.equal(semanticRecordStatistics(coordinator).decode_failed, 1);
      assert.equal(
        (await readVerifiedRecord(coordinator, unavailable, id, event)).compact,
        verified.compact,
      );
      database.exec("UPDATE semantic_records SET version=0");
      assert.equal(await backfillVerifiedRecords(coordinator, unavailable), 0);
      assert.equal(await backfillSemanticRecords(coordinator, objects), 1);
      reads.length = 0;
      assert.equal(await backfillSemanticRecords(coordinator, objects), 0);
      assert.deepEqual(reads, []);

      const late = publication("3");
      await service.admitMany([utf8(JSON.stringify({ ...late, body: null }))]);
      // A shared body is already present, so this exact binding is ready at admission.
      const shared = (await coordinator.load()).events[late.envelope.id];
      assert.ok(
        semanticDocument(
          createQwenProfile(),
          await readSemanticRecord(
            coordinator,
            objects,
            late.envelope.id,
            shared,
          ),
        ),
      );
    } finally {
      if (coordinator instanceof SqliteCoordinator) coordinator.close();
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
