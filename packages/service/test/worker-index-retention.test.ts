import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { before, test } from "node:test";
import { D1IndexStore } from "../../../apps/worker/src/index-store.ts";
import { SqliteCoordinator } from "../../../apps/server/src/storage.ts";
import {
  initializeCore,
  createEvent,
  utf8,
  wordId,
} from "../../core/src/index.ts";
import type { SearchEntry } from "../src/packages.ts";
import { DictionaryService } from "../src/service.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);

const hash = (n: number) => "sha256:" + n.toString(16).padStart(64, "0");
const entries = (count = 100): SearchEntry[] =>
  Array.from({ length: count }, (_, n) => ({
    event: "jve1:" + n.toString(16).padStart(64, "0"),
    word: { language: "jbo", spelling: "klama" },
    language: "en",
    glosses: [],
    plain_text: `synthetic definition ${n}`,
    classification: { kind: "gismu", selmaho: [] },
    body: hash(100),
  }));

/** Run the real D1 SQL in local SQLite. Each batch has D1 rollback semantics. */
function fixture(staged = true) {
  const database = new DatabaseSync(":memory:");
  let fail: ((sql: string, values: SQLInputValue[]) => boolean) | undefined;
  const prepare = (sql: string) => {
    let values: SQLInputValue[] = [];
    return {
      bind(...input: SQLInputValue[]) {
        values = input;
        return this;
      },
      async first(column?: string) {
        const row = database.prepare(sql).get(...values);
        return row ? (column ? row[column] : row) : null;
      },
      async run() {
        if (fail?.(sql, values)) throw new Error("injected D1 write failure");
        database.prepare(sql).run(...values);
        return { success: true };
      },
    };
  };
  const binding = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const makeIndex = () =>
    new D1IndexStore(binding as unknown as D1Database, staged);
  const index = makeIndex();
  return {
    database,
    index,
    makeIndex,
    fail(operation?: typeof fail) {
      fail = operation;
    },
    count(table = "search_entries") {
      return Number(
        database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,
      );
    },
    current() {
      return database
        .prepare("SELECT snapshot FROM search_current WHERE id=1")
        .get()?.snapshot;
    },
    async publish(snapshot: string, required: string[] = []) {
      await index.publish!(snapshot, required);
    },
    close() {
      database.close();
    },
  };
}

test("D1 publication bounds the 40-copy audit fixture to current and rollback generations", async () => {
  const f = fixture();
  try {
    const rows = entries();
    for (let n = 1; n <= 40; n++) {
      await f.index.replace(hash(n), rows);
      await f.publish(hash(n));
      assert.equal(f.count(), Math.min(n, 2) * 100);
      assert.equal(f.count("search_snapshots"), Math.min(n, 2));
    }
    assert.equal(f.current(), hash(40));
    assert.equal(f.count("search_aliases"), 0);
  } finally {
    f.close();
  }
});

test("D1 unchanged publications share one copy and prune obsolete aliases", async () => {
  const f = fixture();
  try {
    await f.index.replace(hash(1), entries());
    await f.publish(hash(1));
    for (let n = 2; n <= 40; n++) {
      assert.equal(await f.index.reuse(hash(n - 1), hash(n)), true);
      await f.publish(hash(n));
      assert.equal(f.count(), 100);
      assert.ok(f.count("search_aliases") <= 2);
      assert.ok(f.count("search_snapshots") <= 3);
    }
    await f.index.replace(hash(41), entries(2));
    await f.publish(hash(41));
    assert.equal(f.count(), 102);
    await f.publish(hash(41));
    assert.equal(f.count(), 2);
    assert.equal(f.count("search_snapshots"), 1);
    assert.equal(f.count("search_aliases"), 0);
    assert.equal(await f.index.reuse(hash(1), hash(42)), false);
    assert.equal(f.current(), hash(41));
  } finally {
    f.close();
  }
});

test("D1 publication keeps required staged generations across restart and removes abandoned rows", async () => {
  const f = fixture();
  try {
    for (let n = 1; n <= 4; n++) await f.index.replace(hash(n), entries(1));
    await f.publish(hash(1), [hash(2), hash(3)]);
    assert.equal(f.count(), 3);
    const reopened = f.makeIndex();
    await reopened.publish!(hash(2), [hash(3)]);
    assert.equal(f.count(), 3);
    await reopened.publish!(hash(3));
    assert.equal(f.count(), 2);
    await reopened.publish!(hash(3));
    assert.equal(f.count(), 1);
    assert.equal(await reopened.reuse(hash(4), hash(5)), false);
  } finally {
    f.close();
  }
});

test("D1 cleanup failure rolls back deletions, aliases, markers, and the current pointer", async () => {
  const f = fixture();
  try {
    await f.index.replace(hash(1), entries(1));
    await f.publish(hash(1));
    await f.index.reuse(hash(1), hash(2));
    await f.publish(hash(2));
    await f.index.replace(hash(3), entries(1));
    await f.publish(hash(3));
    await f.index.replace(hash(4), entries(1));
    f.fail((sql) => sql.startsWith("DELETE FROM search_aliases WHERE NOT"));
    await assert.rejects(f.publish(hash(4)), /injected D1 write failure/);
    assert.equal(f.current(), hash(3));
    assert.equal(f.count(), 3);
    assert.equal(f.count("search_snapshots"), 4);
    assert.equal(f.count("search_aliases"), 1);
    f.fail();
    await f.publish(hash(4));
    assert.equal(f.current(), hash(4));
    assert.equal(f.count(), 2);
    assert.equal(f.count("search_aliases"), 0);
    await assert.rejects(f.publish(hash(999)), /NOT NULL constraint failed/);
    assert.equal(f.current(), hash(4));
    assert.equal(f.count(), 2);
    await f.publish(hash(3), [hash(4)]);
    assert.equal(f.current(), hash(3));
    assert.equal(f.count(), 2);
  } finally {
    f.close();
  }
});

test("D1 failed chunk writes leave the complete current snapshot intact, including same-snapshot rebuilds", async () => {
  const f = fixture();
  try {
    const rows = entries(201);
    await f.index.replace(hash(1), rows);
    await f.publish(hash(1));
    f.fail(
      (sql, values) =>
        sql.startsWith("INSERT INTO search_entries VALUES") &&
        values[1] === rows[100].event,
    );
    await assert.rejects(
      f.index.replace(
        hash(1),
        rows.map((row) => ({ ...row, plain_text: "changed" })),
      ),
      /injected D1 write failure/,
    );
    assert.equal(f.current(), hash(1));
    assert.equal(f.count(), 201);
    assert.equal(
      JSON.parse(
        String(
          f.database.prepare("SELECT value FROM search_entries LIMIT 1").get()!
            .value,
        ),
      ).plain_text,
      rows[0].plain_text,
    );
    assert.equal(f.count("search_snapshots"), 1);
    f.fail();
    await f.index.replace(hash(2), entries(1));
    await f.publish(hash(2));
    assert.equal(f.count(), 202);
  } finally {
    f.close();
  }
});

test("D1 empty generations can be reused and missing bases can be restored", async () => {
  const f = fixture();
  try {
    await f.index.replace(hash(1), []);
    await f.publish(hash(1));
    const index = f.makeIndex();
    assert.equal(await index.reuse(hash(1), hash(2)), true);
    await index.publish!(hash(2));
    assert.equal(f.count(), 0);
    await index.restore(hash(1), entries(1));
    await index.publish!(hash(1));
    assert.equal(f.count(), 1);
    assert.equal(f.current(), hash(1));
    await index.restore(hash(999), []);
    await index.publish!(hash(999));
    assert.equal(f.current(), hash(999));
  } finally {
    f.close();
  }
});

test("D1 legacy indexes keep the published generation through migration and discard old copies", async () => {
  const f = fixture();
  try {
    f.database.exec(
      "CREATE TABLE search_entries(snapshot TEXT NOT NULL,event TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(snapshot,event)); CREATE TABLE search_current(id INTEGER PRIMARY KEY CHECK(id=1),snapshot TEXT NOT NULL)",
    );
    const row = entries(1)[0];
    for (let n = 1; n <= 40; n++)
      f.database
        .prepare("INSERT INTO search_entries VALUES(?,?,?)")
        .run(hash(n), row.event, JSON.stringify(row));
    f.database.prepare("INSERT INTO search_current VALUES(1,?)").run(hash(40));
    assert.equal(await f.index.reuse(hash(40), hash(41)), true);
    await f.publish(hash(41));
    assert.equal(f.current(), hash(41));
    assert.equal(f.count(), 1);
    assert.equal(f.count("search_snapshots"), 2);
  } finally {
    f.close();
  }
});

const request = (path: string) => new Request("http://localhost/api/v1" + path);

test("Worker service keeps one definition copy after public snapshot expiry and a failed publication", async () => {
  const f = fixture();
  const coordinator = new SqliteCoordinator(":memory:", 2);
  const memory = new Map<string, Uint8Array>();
  const objects = {
    async get(hash: string) {
      return memory.get(hash) ?? null;
    },
    async put(hash: string, bytes: Uint8Array) {
      memory.set(hash, bytes.slice());
    },
  };
  const service = new DictionaryService(objects, coordinator, {
    serverId: "worker-retention",
    policyUrl: "https://example.invalid/policy",
    index: f.index,
  });
  const seed = new Uint8Array(32).fill(77);
  const word = { language: "jbo" as const, spelling: "klama" };
  let event = createEvent(
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
      text: [["Synthetic audit definition."]],
      classification: { kind: "gismu", selmaho: [] },
      license: {
        expression: "CC0-1.0",
        url: "https://creativecommons.org/publicdomain/zero/1.0/",
        attribution: "",
      },
    },
  );
  let oldest = "";
  try {
    for (let n = 1; n <= 10; n++) {
      if (n > 1)
        event = createEvent(
          seed,
          [event.envelope.id],
          n.toString(16).padStart(32, "0"),
          { kind: "identity.merge" },
          null,
        );
      await service.admit(utf8(JSON.stringify(event)));
      const response = await service.fetch(request("/manifest"));
      assert.equal(response.status, 200);
      const manifest = (await response.json()) as { snapshot: string };
      if (n === 1) oldest = manifest.snapshot;
      assert.equal(f.current(), manifest.snapshot);
      assert.equal(f.count(), 1);
      assert.ok(f.count("search_aliases") <= 2);
      assert.ok(f.count("search_snapshots") <= 3);
    }
    assert.equal((await coordinator.load()).snapshots.length, 2);
    const expired = await service.fetch(
      request(`/inventory?kind=events&snapshot=${oldest}`),
    );
    assert.equal(expired.status, 410);
    assert.equal(
      ((await expired.json()) as { code: string }).code,
      "snapshot_expired",
    );
    const completed = f.current();
    event = createEvent(
      seed,
      [event.envelope.id],
      "b".repeat(32),
      { kind: "identity.merge" },
      null,
    );
    await service.admit(utf8(JSON.stringify(event)));
    let once = true;
    f.fail((sql) => {
      if (once && sql.startsWith("INSERT INTO search_current")) {
        once = false;
        return true;
      }
      return false;
    });
    assert.equal((await service.fetch(request("/manifest"))).status, 503);
    assert.equal(f.current(), completed);
    assert.equal((await coordinator.load()).materialized_snapshot, completed);
    f.fail();
    const retried = await service.fetch(request("/manifest"));
    assert.equal(retried.status, 200);
    const next = (await retried.json()) as { snapshot: string };
    assert.notEqual(next.snapshot, completed);
    assert.equal(f.current(), next.snapshot);
    assert.equal(f.count(), 1);
    assert.ok(f.count("search_aliases") <= 2);
    assert.ok(f.count("search_snapshots") <= 3);
  } finally {
    coordinator.close();
    f.close();
  }
});
