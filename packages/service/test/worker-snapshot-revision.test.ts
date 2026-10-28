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
  wordId,
  identityFromSeed,
} from "../../core/src/index.ts";

/** Exercise the real adapter class with local SQLite and platform binding doubles. */
test("Worker restart restores snapshot revision order before unpinned current reads", async (t) => {
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
    const seed = new Uint8Array(32).fill(61);
    const word = { language: "jbo" as const, spelling: "klama" };
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
        glosses: [],
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
    const body = {
      name: "Configured view",
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
    const view = createEvent(
      seed,
      [],
      "2".repeat(32),
      { kind: "view.publish", parents: [] },
      body,
    );
    const alternate = createEvent(
      seed,
      [],
      "a".repeat(32),
      { kind: "view.publish", parents: [] },
      { ...body, name: "Alternate view" },
    );
    env.SELECTED_VIEW = view.envelope.id;
    const first = open();
    const read = async (adapter: any, path: string) => {
      const response = await adapter.fetch(
        new Request("http://localhost/api/v1" + path),
      );
      const text = await response.text();
      assert.equal(response.status, 200, text);
      return JSON.parse(text);
    };
    const admission = await first.fetch(
      new Request("http://localhost/api/v1/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(definition),
      }),
    );
    assert.equal(admission.status, 201, await admission.text());
    await first.service.admitMany(
      [view, alternate].map((r) => utf8(JSON.stringify(r))),
    );
    const path = "/words/" + wordId(word);
    let historical = "",
      current = "";
    for (let i = 0; i < 16; i++) {
      const late = createEvent(
        seed,
        [],
        (20 + i).toString(16).padStart(32, "0"),
        { kind: "identity.profile" },
        { name: `Late ${i}`, bio: [], links: [] },
      );
      await first.service.admitMany([
        utf8(JSON.stringify({ ...late, body: null })),
      ]);
      historical = (await read(first, path)).snapshot;
      const position = (await first.load()).position;
      await first.service.admitMany([utf8(JSON.stringify(late))]);
      current = (await read(first, path)).snapshot;
      assert.equal((await first.load()).position, position);
      if (historical > current) break;
    }
    assert.ok(
      historical > current,
      "fixture must select a historical hash above the current hash",
    );
    await first.service.prepareEvaluationShutdown();
    database!.close();
    const restarted = open();
    assert.equal(
      (await read(restarted, path + "?snapshot=" + current)).snapshot,
      current,
    );
    assert.equal(
      (await read(restarted, path + "?snapshot=" + historical)).snapshot,
      historical,
    );
    t.diagnostic(
      JSON.stringify({
        historical,
        current,
        wrapperGetter: typeof restarted.getSnapshotRevision,
        sqlHistorical:
          await restarted.coordinator.getSnapshotRevision(historical),
        sqlCurrent: await restarted.coordinator.getSnapshotRevision(current),
        remembered: [...restarted.service.snapshotRevisions],
        entries: [...restarted.service.evaluationCache.keys()],
        completed: restarted.service.completed.snapshot.snapshot,
      }),
    );
    assert.deepEqual([...restarted.service.inFlightEvaluations], []);
    assert.deepEqual([...restarted.service.inFlightPackages], []);
    assert.deepEqual([...restarted.service.sessionUses], []);
    const response = await restarted.fetch(
      new Request(
        "http://localhost/api/v1" +
          path +
          "?snapshot=" +
          current +
          "&view=" +
          alternate.envelope.id,
      ),
    );
    const responseBody = await response.text();
    t.diagnostic(`Alternate response: ${response.status}`);
    assert.equal(response.status, 200, responseBody);
    const historicalRevision = await restarted.getSnapshotRevision(historical);
    const currentRevision = await restarted.getSnapshotRevision(current);
    assert.ok(historicalRevision < currentRevision);
    assert.equal(
      restarted.service.snapshotRevisions.get(historical),
      historicalRevision,
    );
    assert.equal(
      restarted.service.snapshotRevisions.get(current),
      currentRevision,
    );
    assert.equal(
      restarted.service.evaluationCache.has(
        historical + "|" + view.envelope.id,
      ),
      false,
    );
    assert.equal(
      restarted.service.evaluationCache.has(current + "|" + view.envelope.id),
      true,
    );
    await restarted.service.prepareEvaluationShutdown();
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
