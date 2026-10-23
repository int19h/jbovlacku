import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqlRowsCoordinator } from "../src/sql-coordinator.ts";
import {
  emptyState,
  type Snapshot,
  type State,
  type StoredEvent,
} from "../src/storage.ts";
import { SqliteIndexStore } from "../../../apps/server/src/storage.ts";
import { serializeSnapshotCache } from "../src/snapshot-cache.ts";

const hash = (n: number) => "sha256:" + n.toString(16).padStart(64, "0");
const event = (n: number, position = n): StoredEvent => ({
  envelope_hash: hash(n),
  body_hash: hash(100 + n),
  signature: [n],
  position,
  header: {
    version: 1,
    issuer: "test-key",
    previous: [],
    nonce: String(n),
    action: { kind: "definition.publish" },
    content: { hash: hash(100 + n), bytes: 1 },
  },
});
function snapshot(state: State, n: number): Snapshot {
  return {
    snapshot: hash(1000 + n),
    logical_inventory: hash(2000 + n),
    manifest: {
      version: 1,
      events: { count: Object.keys(state.events).length, hash: hash(1) },
      bodies: { count: 0, hash: hash(2) },
      import_selections: { count: 0, hash: hash(3) },
    },
    events: Object.fromEntries(
      Object.entries(state.events).map(([id, { position, ...value }]) => [
        id,
        value,
      ]),
    ),
    bodies: Object.values(state.events).flatMap((value) =>
      value.body_hash ? [value.body_hash] : [],
    ),
    import_selections: [...state.selections],
  };
}
async function fixture(retention = 3) {
  const root = process.env.JVC_TEST_ROOT ?? tmpdir();
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "storage-delta-"));
  const database = new DatabaseSync(join(directory, "coordinator.sqlite"));
  const statements: string[] = [];
  let failSave = false;
  const connection = {
    exec(
      sql: string,
      ...values: (string | number)[]
    ): Record<string, unknown>[] {
      statements.push(sql);
      if (failSave && sql.startsWith("UPDATE metadata"))
        throw new Error("injected save failure");
      const statement = database.prepare(sql);
      if (statement.columns().length)
        return statement.all(...values) as Record<string, unknown>[];
      statement.run(...values);
      return [];
    },
    transaction<T>(operation: () => T): T {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = operation();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const coordinator = new SqlRowsCoordinator(connection, retention);
  return {
    database,
    coordinator,
    statements,
    connection,
    directory,
    fail(value: boolean) {
      failSave = value;
    },
    async close() {
      database.close();
      await rm(directory, { recursive: true });
    },
  };
}
async function publish(
  coordinator: SqlRowsCoordinator,
  state: State,
  n: number,
  changedIds?: string[],
) {
  const wrapper = snapshot(state, n);
  const next = {
    ...state,
    revision: state.revision + 1,
    snapshot: wrapper.snapshot,
    snapshots: [...state.snapshots, wrapper.snapshot],
  };
  assert.equal(
    await coordinator.compareAndSwap(state.revision, next, wrapper, changedIds),
    true,
  );
  return { state: next, wrapper };
}

test("SQL saves only changed events and new receipts and retains exact historical variants", async () => {
  const f = await fixture();
  try {
    let state = await f.coordinator.load();
    state = {
      ...state,
      position: 2,
      events: { a: event(1), b: event(2) },
      journal: [
        { id: "a", position: 1 },
        { id: "b", position: 2 },
      ],
    };
    const first = await publish(f.coordinator, state, 1, ["a", "b"]);
    state = await f.coordinator.load();
    f.statements.length = 0;
    const secondState = {
      ...state,
      events: {
        ...state.events,
        a: {
          ...state.events.a,
          body_hash: null,
          envelope_hash: hash(700),
          signature: [7],
        },
      },
    };
    const second = await publish(f.coordinator, secondState, 2, ["a"]);
    assert.equal(
      f.statements.filter((sql) => sql.startsWith("INSERT INTO events")).length,
      1,
    );
    assert.equal(
      f.statements.filter((sql) =>
        sql.startsWith("INSERT OR IGNORE INTO receipts"),
      ).length,
      0,
    );
    assert.equal(
      f.statements.filter((sql) => sql === "SELECT id,value FROM events")
        .length,
      0,
    );
    assert.equal(
      f.statements.filter((sql) =>
        sql.startsWith("INSERT INTO snapshot_event_versions"),
      ).length,
      1,
    );
    assert.equal(
      (await f.coordinator.getSnapshot(first.wrapper.snapshot))!.events.a
        .body_hash,
      hash(101),
    );
    assert.deepEqual(
      (await f.coordinator.getSnapshot(second.wrapper.snapshot))!.events.a
        .signature,
      [7],
    );
    const reopened = new SqlRowsCoordinator(f.connection, 3);
    assert.deepEqual(
      await reopened.getSnapshot(first.wrapper.snapshot),
      first.wrapper,
    );
    assert.deepEqual(
      await reopened.getSnapshot(second.wrapper.snapshot),
      second.wrapper,
    );
    const cached = await reopened.getSnapshot(first.wrapper.snapshot);
    assert.equal(cached, await reopened.getSnapshot(first.wrapper.snapshot));
    assert.throws(() => {
      cached!.events.a.signature[0] = 99;
    }, TypeError);
    assert.equal(
      (await reopened.loadMetadata()).snapshot,
      second.wrapper.snapshot,
    );
    assert.equal("events" in (await reopened.loadMetadata()), false);
  } finally {
    await f.close();
  }
});

test("failed snapshot CAS and failed storage transactions publish no partial versions", async () => {
  const f = await fixture();
  try {
    const state = await f.coordinator.load();
    const next = {
      ...state,
      revision: 1,
      position: 1,
      events: { a: event(1) },
      journal: [{ id: "a", position: 1 }],
    };
    const wrapper = snapshot(next, 1);
    next.snapshot = wrapper.snapshot;
    assert.equal(
      await f.coordinator.compareAndSwap(99, next, wrapper, ["a"]),
      false,
    );
    assert.equal(await f.coordinator.getSnapshot(wrapper.snapshot), null);
    f.fail(true);
    await assert.rejects(
      f.coordinator.compareAndSwap(0, next, wrapper, ["a"]),
      /injected save failure/,
    );
    f.fail(false);
    assert.deepEqual(await f.coordinator.load(), emptyState());
    assert.equal(
      f.database
        .prepare("SELECT COUNT(*) AS n FROM snapshot_event_versions")
        .get()!.n,
      0,
    );
    assert.equal(await f.coordinator.getSnapshot(wrapper.snapshot), null);
    assert.equal(
      await f.coordinator.compareAndSwap(0, next, wrapper, ["a"]),
      true,
    );
    assert.equal(
      await f.coordinator.markMaterialized(wrapper.snapshot, 1),
      true,
    );
    assert.equal(await f.coordinator.markMaterialized(hash(999), 0), false);
  } finally {
    await f.close();
  }
});

test("snapshot retention refreshes an existing ID and prunes expired version ranges", async () => {
  const f = await fixture(2);
  try {
    let state: State = {
      ...(await f.coordinator.load()),
      position: 1,
      events: { a: event(1) },
      journal: [{ id: "a", position: 1 }],
    };
    const first = await publish(f.coordinator, state, 1, ["a"]);
    state = first.state;
    const second = await publish(f.coordinator, state, 2, []);
    state = second.state;
    const refresh = {
      ...state,
      revision: state.revision + 1,
      snapshot: first.wrapper.snapshot,
    };
    assert.equal(
      await f.coordinator.compareAndSwap(
        state.revision,
        refresh,
        first.wrapper,
        [],
      ),
      true,
    );
    state = {
      ...refresh,
      events: {
        a: { ...refresh.events.a, signature: [8], envelope_hash: hash(800) },
      },
    };
    const third = await publish(f.coordinator, state, 3, ["a"]);
    assert.equal(
      await f.coordinator.getSnapshot(second.wrapper.snapshot),
      null,
    );
    assert.deepEqual(
      await f.coordinator.getSnapshot(first.wrapper.snapshot),
      first.wrapper,
    );
    state = {
      ...third.state,
      events: {
        a: {
          ...third.state.events.a,
          signature: [9],
          envelope_hash: hash(900),
        },
      },
    };
    await publish(f.coordinator, state, 4, ["a"]);
    assert.equal(await f.coordinator.getSnapshot(first.wrapper.snapshot), null);
    assert.equal(
      f.database
        .prepare("SELECT COUNT(*) AS n FROM snapshot_event_versions")
        .get()!.n,
      2,
    );
  } finally {
    await f.close();
  }
});

test("legacy full snapshot wrappers remain readable beside normalized wrappers", async () => {
  const f = await fixture(2);
  try {
    let state: State = {
      ...emptyState(),
      position: 1,
      events: { a: event(1) },
      journal: [{ id: "a", position: 1 }],
    };
    const legacy = snapshot(state, 1);
    f.database
      .prepare("INSERT INTO cached_snapshots VALUES(?,?)")
      .run(legacy.snapshot, 1);
    f.database
      .prepare("INSERT INTO cached_snapshot_chunks VALUES(?,?,?)")
      .run(legacy.snapshot, 0, serializeSnapshotCache(legacy));
    state = { ...state, snapshot: legacy.snapshot, revision: 1 };
    f.database
      .prepare("INSERT INTO events VALUES(?,?)")
      .run("a", JSON.stringify(state.events.a));
    f.database.prepare("INSERT INTO receipts VALUES(?,?)").run(1, "a");
    const { events, journal, selections, snapshots, ...metadata } = state;
    f.database
      .prepare("UPDATE metadata SET revision=1,state=?")
      .run(JSON.stringify(metadata));
    assert.deepEqual(await f.coordinator.getSnapshot(legacy.snapshot), legacy);
    const next = await publish(
      f.coordinator,
      await f.coordinator.load(),
      2,
      [],
    );
    const reopened = new SqlRowsCoordinator(f.connection, 2);
    assert.deepEqual(await reopened.getSnapshot(legacy.snapshot), legacy);
    assert.deepEqual(
      await reopened.getSnapshot(next.wrapper.snapshot),
      next.wrapper,
    );
  } finally {
    await f.close();
  }
});

test("Node search reuse flattens aliases without copying unchanged entries", async () => {
  const f = await fixture();
  const path = join(f.directory, "index.sqlite");
  const index = new SqliteIndexStore(path);
  const database = new DatabaseSync(path);
  try {
    await index.replace(hash(1), [
      {
        event: "a",
        word: { language: "jbo", spelling: "klama" },
        language: "en",
        glosses: [],
        plain_text: "go",
        classification: {},
        body: hash(2),
      },
    ]);
    await index.reuse(hash(1), hash(3));
    await index.reuse(hash(3), hash(4));
    assert.equal(
      database.prepare("SELECT COUNT(*) AS n FROM search_entries").get()!.n,
      1,
    );
    assert.equal(
      database
        .prepare("SELECT source FROM search_aliases WHERE snapshot=?")
        .get(hash(4))!.source,
      hash(1),
    );
    assert.equal(
      database.prepare("SELECT snapshot FROM search_current").get()!.snapshot,
      hash(4),
    );
    await assert.rejects(
      index.reuse(hash(999), hash(1000)),
      /previous search index/,
    );
    assert.equal(
      database.prepare("SELECT snapshot FROM search_current").get()!.snapshot,
      hash(4),
    );
  } finally {
    database.close();
    index.close();
    await f.close();
  }
});

test("snapshot retention protects the last completed snapshot through an evaluation backlog", async () => {
  const f = await fixture(2);
  try {
    const initial = {
      ...(await f.coordinator.load()),
      position: 1,
      events: { a: event(1) },
      journal: [{ id: "a", position: 1 }],
    };
    const first = await publish(f.coordinator, initial, 1, ["a"]);
    assert.equal(
      await f.coordinator.markMaterialized(first.wrapper.snapshot, 1),
      true,
    );
    let state = await f.coordinator.load();
    let last = first.wrapper;
    for (let n = 2; n < 9; n++) {
      const next = {
        ...state,
        events: {
          ...state.events,
          a: {
            ...state.events.a,
            signature: [n],
            envelope_hash: hash(700 + n),
          },
        },
      };
      const published = await publish(f.coordinator, next, n, ["a"]);
      last = published.wrapper;
      state = await f.coordinator.load();
    }
    assert.deepEqual(
      await f.coordinator.getSnapshot(first.wrapper.snapshot),
      first.wrapper,
    );
    assert.equal(
      f.database.prepare("SELECT COUNT(*) AS n FROM cached_snapshots").get()!.n,
      3,
    );
    const reopened = new SqlRowsCoordinator(f.connection, 2);
    assert.deepEqual(
      await reopened.getSnapshot(first.wrapper.snapshot),
      first.wrapper,
    );
    assert.equal(
      await reopened.markMaterialized(last.snapshot, state.position),
      true,
    );
    assert.equal(await reopened.getSnapshot(first.wrapper.snapshot), null);
    assert.equal(
      f.database.prepare("SELECT COUNT(*) AS n FROM cached_snapshots").get()!.n,
      2,
    );
    assert.equal(
      f.database
        .prepare("SELECT COUNT(*) AS n FROM snapshot_event_versions")
        .get()!.n,
      2,
    );
  } finally {
    await f.close();
  }
});

test("Node staged search writes change the current marker only after publish", async () => {
  const f = await fixture();
  const path = join(f.directory, "index-staged.sqlite");
  const index = new SqliteIndexStore(path, true);
  const database = new DatabaseSync(path);
  try {
    await index.replace(hash(1), [
      {
        event: "a",
        word: { language: "jbo", spelling: "klama" },
        language: "en",
        glosses: [],
        plain_text: "go",
        classification: {},
        body: hash(2),
      },
    ]);
    assert.equal(
      database.prepare("SELECT snapshot FROM search_current").get(),
      undefined,
    );
    await index.publish!(hash(1));
    await index.reuse(hash(1), hash(3));
    assert.equal(
      database.prepare("SELECT snapshot FROM search_current").get()!.snapshot,
      hash(1),
    );
    await index.publish!(hash(3));
    assert.equal(
      database.prepare("SELECT snapshot FROM search_current").get()!.snapshot,
      hash(3),
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS n FROM search_entries").get()!.n,
      1,
    );
  } finally {
    database.close();
    index.close();
    await f.close();
  }
});

test("metadata publication does not promote an older coordinator event cache", async () => {
  const f = await fixture();
  try {
    const state = {
      ...(await f.coordinator.load()),
      position: 1,
      events: { a: event(1) },
      journal: [{ id: "a", position: 1 }],
    };
    const first = await publish(f.coordinator, state, 1, ["a"]);
    const other = new SqlRowsCoordinator(f.connection);
    const before = await other.load();
    const next = {
      ...before,
      position: 2,
      events: { ...before.events, b: event(2) },
      journal: [...before.journal, { id: "b", position: 2 }],
    };
    const second = await publish(other, next, 2, ["b"]);
    assert.equal(
      await f.coordinator.markMaterialized(second.wrapper.snapshot, 2),
      true,
    );
    assert.equal((await f.coordinator.load()).events.b.envelope_hash, hash(2));
    assert.equal(
      (await f.coordinator.getSnapshot(first.wrapper.snapshot))!.events.b,
      undefined,
    );
  } finally {
    await f.close();
  }
});

test("Node restore rebuilds missing, partial, and extra rows and preserves alias sources", async () => {
  const f = await fixture();
  const path = join(f.directory, "index-restore.sqlite");
  const index = new SqliteIndexStore(path, true);
  const database = new DatabaseSync(path);
  const entries = ["a", "b"].map((event) => ({
    event,
    word: { language: "jbo" as const, spelling: "klama" },
    language: "en",
    glosses: [],
    plain_text: "go",
    classification: {},
    body: hash(2),
  }));
  try {
    await assert.rejects(index.publish!(hash(1)), /generation is unavailable/);
    await index.restore(hash(1), entries);
    await index.publish!(hash(1));
    const count = (snapshot: string) =>
      database
        .prepare("SELECT COUNT(*) AS n FROM search_entries WHERE snapshot=?")
        .get(snapshot)!.n;
    assert.equal(count(hash(1)), 2);
    database
      .prepare("DELETE FROM search_entries WHERE snapshot=? AND event=?")
      .run(hash(1), "a");
    await index.restore(hash(1), entries);
    assert.equal(count(hash(1)), 2);
    database
      .prepare("INSERT INTO search_entries VALUES(?,?,?)")
      .run(hash(1), "extra", "{}");
    await index.restore(hash(1), entries);
    assert.equal(count(hash(1)), 2);
    assert.equal(
      database
        .prepare("SELECT event FROM search_entries WHERE event='extra'")
        .get(),
      undefined,
    );
    await index.reuse(hash(1), hash(3));
    await index.reuse(hash(3), hash(4));
    database
      .prepare("INSERT INTO search_entries VALUES(?,?,?)")
      .run(hash(1), "source-extra", "{}");
    await index.restore(hash(3), entries);
    assert.equal(count(hash(3)), 2);
    assert.equal(count(hash(1)), 3);
    assert.equal(
      database
        .prepare("SELECT source FROM search_aliases WHERE snapshot=?")
        .get(hash(3)),
      undefined,
    );
    assert.equal(
      database
        .prepare("SELECT source FROM search_aliases WHERE snapshot=?")
        .get(hash(4))!.source,
      hash(1),
    );
    await index.publish!(hash(3));
    assert.equal(
      database.prepare("SELECT snapshot FROM search_current").get()!.snapshot,
      hash(3),
    );
  } finally {
    database.close();
    index.close();
    await f.close();
  }
});

test("Node restore keeps legacy matching rows and records empty generations", async () => {
  const f = await fixture();
  const path = join(f.directory, "index-legacy-restore.sqlite");
  const index = new SqliteIndexStore(path, true);
  const database = new DatabaseSync(path);
  const entries = [
    {
      event: "a",
      word: { language: "jbo" as const, spelling: "klama" },
      language: "en",
      glosses: [],
      plain_text: "go",
      classification: {},
      body: hash(2),
    },
  ];
  try {
    await index.replace(hash(1), entries);
    database.exec(
      "DELETE FROM search_snapshots; CREATE TRIGGER no_rewrite BEFORE DELETE ON search_entries BEGIN SELECT RAISE(ABORT,'unchanged legacy rows must remain'); END",
    );
    await index.restore(hash(1), entries);
    await index.publish!(hash(1));
    assert.equal(
      database
        .prepare("SELECT entries FROM search_snapshots WHERE snapshot=?")
        .get(hash(1))!.entries,
      1,
    );
    database.exec("DROP TRIGGER no_rewrite");
    await index.restore(hash(3), []);
    await index.publish!(hash(3));
    await index.reuse(hash(3), hash(4));
    await index.publish!(hash(4));
    assert.equal(
      database
        .prepare("SELECT entries FROM search_snapshots WHERE snapshot=?")
        .get(hash(4))!.entries,
      0,
    );
    assert.equal(
      database.prepare("SELECT snapshot FROM search_current").get()!.snapshot,
      hash(4),
    );
  } finally {
    database.close();
    index.close();
    await f.close();
  }
});

test("lost snapshot wrappers rebuild their auxiliary frozen revision metadata", async () => {
  const f = await fixture();
  try {
    const initial = {
      ...(await f.coordinator.load()),
      position: 1,
      events: { a: event(1) },
      journal: [{ id: "a", position: 1 }],
    };
    const first = await publish(f.coordinator, initial, 1, ["a"]);
    f.database.exec(
      "DELETE FROM cached_snapshot_chunks; DELETE FROM cached_snapshots",
    );
    assert.equal(await f.coordinator.getSnapshot(first.wrapper.snapshot), null);
    const state = await f.coordinator.load();
    const next = { ...state, revision: state.revision + 1 };
    assert.equal(
      await f.coordinator.compareAndSwap(
        state.revision,
        next,
        first.wrapper,
        [],
      ),
      true,
    );
    assert.deepEqual(
      await f.coordinator.getSnapshot(first.wrapper.snapshot),
      first.wrapper,
    );
    assert.equal(
      f.database
        .prepare(
          "SELECT event_revision FROM snapshot_cache_revisions WHERE hash=?",
        )
        .get(first.wrapper.snapshot)!.event_revision,
      next.revision,
    );
  } finally {
    await f.close();
  }
});
