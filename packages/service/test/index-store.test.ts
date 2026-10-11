import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqliteIndexStore } from "../../../apps/server/src/storage.ts";
import { D1IndexStore } from "../../../apps/worker/src/index-store.ts";
import type { SearchEntry } from "../src/packages.ts";

for (const adapter of ["Node", "D1"] as const) {
  test(`${adapter} rebuild updates existing derived text for the same snapshot`, async () => {
    const root = process.env.JVC_TEST_ROOT ?? tmpdir();
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "index-rebuild-"));
    const path = join(directory, "index.sqlite");
    const database = new DatabaseSync(path);
    let index: {
      replace(snapshot: string, entries: SearchEntry[]): Promise<void>;
      close?(): void;
    };
    if (adapter === "Node") index = new SqliteIndexStore(path);
    else {
      const binding = {
        prepare(sql: string) {
          const statement = database.prepare(sql);
          let values: (string | number)[] = [];
          const prepared = {
            bind(...bindings: (string | number)[]) {
              values = bindings;
              return prepared;
            },
            run() {
              statement.run(...values);
              return Promise.resolve({ success: true });
            },
          };
          return prepared;
        },
        async batch(statements: { run(): Promise<unknown> }[]) {
          database.exec("BEGIN");
          try {
            const result = await Promise.all(
              statements.map((statement) => statement.run()),
            );
            database.exec("COMMIT");
            return result;
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
        },
      };
      index = new D1IndexStore(binding as unknown as D1Database);
    }
    const snapshot = "sha256:" + "1".repeat(64);
    const entry: SearchEntry = {
      event: "jve1:" + "2".repeat(64),
      word: { language: "jbo", spelling: "klama" },
      language: "en",
      glosses: [],
      plain_text: "goes",
      classification: { kind: "gismu", selmaho: [] },
      body: "sha256:" + "3".repeat(64),
    };
    try {
      await index.replace(snapshot, [entry]);
      await index.replace(snapshot, [{ ...entry, plain_text: "① goes to ②" }]);
      const rows = database
        .prepare(
          "SELECT value FROM search_entries WHERE snapshot=? AND event=?",
        )
        .all(snapshot, entry.event);
      assert.equal(rows.length, 1);
      assert.equal(JSON.parse(String(rows[0].value)).plain_text, "① goes to ②");
      assert.equal(
        database
          .prepare("SELECT snapshot FROM search_current WHERE id=1")
          .get()!.snapshot,
        snapshot,
      );
    } finally {
      index.close?.();
      database.close();
      await rm(directory, { recursive: true });
    }
  });
}
