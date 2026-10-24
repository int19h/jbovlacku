import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import {
  createEvent,
  initializeCore,
  utf8,
  hostRecordVersion,
} from "../../core/src/index.ts";

/** Exercise the real adapter class with local SQLite and platform binding doubles. */
test("Worker admission persists compact rows across object restart and never rechecks original records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jvc-worker-verified-"));
  let database: DatabaseSync | undefined;
  try {
    const output = join(directory, "worker.mjs");
    await build({
      entryPoints: ["apps/worker/src/index.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      outfile: output,
      loader: { ".wasm": "binary" },
      plugins: [
        {
          name: "local-durable-object-base",
          setup(builder) {
            builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
              path: "base",
              namespace: "local-do",
            }));
            builder.onLoad({ filter: /.*/, namespace: "local-do" }, () => ({
              contents:
                "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
              loader: "js",
            }));
          },
        },
      ],
    });
    const { AdmissionCoordinator } = await import(pathToFileURL(output).href);
    await initializeCore(
      await readFile(
        new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
      ),
    );
    const objects = new Map<string, Uint8Array>();
    const env = {
      SERVER_ID: "worker-verified",
      SELECTED_VIEW: "",
      JVC_AI_ENABLED: "disabled",
      INDEX: {},
      OBJECTS: {
        async get(hash: string) {
          const bytes = objects.get(hash);
          return bytes
            ? {
                async arrayBuffer() {
                  return bytes.slice().buffer;
                },
              }
            : null;
        },
        async put(hash: string, bytes: Uint8Array) {
          objects.set(hash, bytes.slice());
        },
      },
    };
    const open = () => {
      database = new DatabaseSync(join(directory, "durable-object.sqlite"));
      const current = database;
      const ctx = {
        storage: {
          sql: {
            exec(sql: string, ...bindings: (string | number)[]) {
              const statement = current.prepare(sql);
              const values = statement.columns().length
                ? statement.all(...bindings)
                : (statement.run(...bindings), []);
              return { toArray: () => values };
            },
          },
          transactionSync<T>(operation: () => T) {
            current.exec("BEGIN IMMEDIATE");
            try {
              const value = operation();
              current.exec("COMMIT");
              return value;
            } catch (error) {
              current.exec("ROLLBACK");
              throw error;
            }
          },
        },
        waitUntil() {},
      };
      const coordinator = new AdmissionCoordinator(ctx, env);
      // Search-index publication is independent of the coordinator forwarding contract.
      coordinator.service.options.index = undefined;
      return coordinator;
    };
    const record = createEvent(
      new Uint8Array(32).fill(93),
      [],
      "1".repeat(32),
      { kind: "identity.profile" },
      { name: "Worker private record", bio: [], links: [] },
    );
    const first = open();
    const response = await first.fetch(
      new Request("http://localhost/api/v1/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(record),
      }),
    );
    assert.equal(response.status, 201, await response.clone().text());
    const state = await first.load();
    const event = state.events[record.envelope.id];
    const binding = {
      id: record.envelope.id,
      envelope_hash: event.envelope_hash,
      body_hash: event.body_hash,
      version: hostRecordVersion(),
    };
    assert.ok(await first.getVerifiedRecord(binding));
    assert.equal(
      database!.prepare("SELECT COUNT(*) AS n FROM verified_records").get()!.n,
      1,
    );
    database!.exec(
      "CREATE TRIGGER reject_compact BEFORE INSERT ON verified_records BEGIN SELECT RAISE(ABORT,'Worker compact transaction failure'); END",
    );
    const rejected = createEvent(
      new Uint8Array(32).fill(93),
      [],
      "2".repeat(32),
      { kind: "identity.merge" },
      null,
    );
    await assert.rejects(
      first.service.admitMany([utf8(JSON.stringify(rejected))]),
      /Worker compact transaction failure/,
    );
    assert.equal((await first.load()).events[rejected.envelope.id], undefined);
    database!.exec("DROP TRIGGER reject_compact");
    database!.close();
    const restarted = open();
    assert.ok(await restarted.getVerifiedRecord(binding));
    // A fallback to original byte parsing or verification cannot pass this gate.
    const get = env.OBJECTS.get;
    env.OBJECTS.get = async (hash) => {
      if (hash === event.envelope_hash || hash === event.body_hash)
        throw new Error("Worker repeated an original record read.");
      return get(hash);
    };
    const newRecord = createEvent(
      new Uint8Array(32).fill(93),
      [record.envelope.id],
      "3".repeat(32),
      { kind: "identity.merge" },
      null,
    );
    const admission = await restarted.fetch(
      new Request("http://localhost/api/v1/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(newRecord),
      }),
    );
    assert.equal(admission.status, 201, await admission.clone().text());
    const receipt = await restarted.fetch(
      new Request("http://localhost/api/v1/receipts/" + record.envelope.id),
    );
    assert.equal(receipt.status, 200, await receipt.clone().text());
    const restored = await receipt.json();
    assert.equal(restored.body_status, "present");
    assert.equal(restored.interpretation, "effective");
    await restarted.saveVerifiedRecords([
      await restarted.getVerifiedRecord(binding),
    ]);
    assert.equal(
      database!.prepare("SELECT COUNT(*) AS n FROM verified_records").get()!.n,
      2,
    );
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
