import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqliteIndexStore } from "../../../apps/server/src/storage.ts";

const root = process.env.JVC_TEST_ROOT ?? tmpdir();
const hash = (n: number) => "sha256:" + n.toString(16).padStart(64, "0");
const entries = (n: number) => [
  {
    event: `event-${n}`,
    word: { language: "jbo" as const, spelling: "klama" },
    language: "en",
    glosses: [],
    plain_text: `definition ${n}`,
    classification: {},
    body: hash(n + 100),
  },
];
async function fixture() {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "retention-case-"));
  const path = join(directory, "index.sqlite");
  let index = new SqliteIndexStore(path, true);
  const database = new DatabaseSync(path);
  return {
    database,
    get index() {
      return index;
    },
    async publish(id: string, required: string[]) {
      await index.publish!(id, required);
    },
    reopen() {
      index.close();
      index = new SqliteIndexStore(path, true);
    },
    count(table: string) {
      return Number(
        database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,
      );
    },
    async close() {
      database.close();
      index.close();
      await rm(directory, { recursive: true });
    },
  };
}

test("publication bounds complete index copies to the required retained snapshots", async () => {
  const f = await fixture();
  try {
    const keep: string[] = [];
    for (let n = 1; n <= 20; n++) {
      await f.index.replace(hash(n), entries(n));
      keep.push(hash(n));
      if (keep.length > 3) keep.shift();
      await f.publish(hash(n), keep);
      assert.equal(f.count("search_entries"), keep.length);
      assert.equal(f.count("search_snapshots"), keep.length);
    }
    f.reopen();
    await f.publish(hash(20), [hash(19), hash(20)]);
    assert.equal(f.count("search_entries"), 2);
    assert.equal(
      f.database.prepare("SELECT snapshot FROM search_current").get()!.snapshot,
      hash(20),
    );
  } finally {
    await f.close();
  }
});

test("retained aliases preserve their expired source until the last alias expires", async () => {
  const f = await fixture();
  try {
    await f.index.replace(hash(1), entries(1));
    await f.publish(hash(1), [hash(1)]);
    await f.index.reuse(hash(1), hash(2));
    await f.index.reuse(hash(2), hash(3));
    await f.index.replace(hash(4), entries(4));
    await f.publish(hash(3), [hash(3), hash(4)]);
    assert.equal(f.count("search_aliases"), 1);
    assert.equal(
      f.database
        .prepare("SELECT source FROM search_aliases WHERE snapshot=?")
        .get(hash(3))!.source,
      hash(1),
    );
    assert.equal(
      f.database
        .prepare("SELECT COUNT(*) AS n FROM search_entries WHERE snapshot=?")
        .get(hash(1))!.n,
      1,
    );
    assert.equal(
      f.database
        .prepare("SELECT COUNT(*) AS n FROM search_entries WHERE snapshot=?")
        .get(hash(4))!.n,
      1,
    );
    await f.publish(hash(4), [hash(4)]);
    assert.equal(f.count("search_aliases"), 1);
    assert.equal(f.count("search_entries"), 2);
    await f.publish(hash(4), [hash(4)]);
    assert.equal(f.count("search_aliases"), 0);
    assert.equal(f.count("search_entries"), 1);
    assert.equal(f.count("search_snapshots"), 1);
  } finally {
    await f.close();
  }
});

test("restart preserves a required staged generation and removes an abandoned one", async () => {
  const f = await fixture();
  try {
    await f.index.restore(hash(1), entries(1));
    await f.publish(hash(1), [hash(1)]);
    await f.index.reuse(hash(1), hash(2));
    await f.index.replace(hash(3), entries(3));
    await f.index.replace(hash(4), entries(4));
    f.reopen();
    await f.publish(hash(2), [hash(2), hash(3)]);
    assert.equal(
      f.database
        .prepare("SELECT COUNT(*) AS n FROM search_entries WHERE snapshot=?")
        .get(hash(3))!.n,
      1,
    );
    assert.equal(
      f.database
        .prepare("SELECT COUNT(*) AS n FROM search_entries WHERE snapshot=?")
        .get(hash(4))!.n,
      0,
    );
    await f.publish(hash(3), [hash(3)]);
    assert.equal(f.count("search_entries"), 2);
    await f.publish(hash(3), [hash(3)]);
    assert.equal(f.count("search_entries"), 1);
    assert.equal(f.count("search_snapshots"), 1);
  } finally {
    await f.close();
  }
});

test("publication cleanup failure rolls back the marker and keeps required staged rows", async () => {
  const f = await fixture();
  try {
    await f.index.replace(hash(1), entries(1));
    await f.publish(hash(1), []);
    await f.index.replace(hash(2), entries(2));
    await f.publish(hash(2), []);
    await f.index.replace(hash(3), entries(3));
    f.database.exec(
      "CREATE TRIGGER reject_cleanup BEFORE DELETE ON search_entries BEGIN SELECT RAISE(ABORT,'injected cleanup failure'); END",
    );
    await assert.rejects(f.publish(hash(3), []), /injected cleanup failure/);
    assert.equal(
      f.database.prepare("SELECT snapshot FROM search_current").get()!.snapshot,
      hash(2),
    );
    assert.equal(f.count("search_entries"), 3);
    f.database.exec("DROP TRIGGER reject_cleanup");
    await f.publish(hash(3), []);
    assert.equal(f.count("search_entries"), 2);
    await f.publish(hash(2), [hash(3)]);
    assert.equal(
      f.database.prepare("SELECT snapshot FROM search_current").get()!.snapshot,
      hash(2),
    );
    assert.equal(f.count("search_entries"), 2);
    await assert.rejects(f.publish(hash(999), []), /generation is unavailable/);
    assert.equal(
      f.database.prepare("SELECT snapshot FROM search_current").get()!.snapshot,
      hash(2),
    );
    assert.equal(f.count("search_entries"), 2);
  } finally {
    await f.close();
  }
});
