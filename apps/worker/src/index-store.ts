import { UPSERT_SEARCH_ENTRY } from "../../../packages/service/src/index-store.ts";
import type { SearchEntry } from "../../../packages/service/src/packages.ts";

export class D1IndexStore {
  private ready?: Promise<unknown>;
  publish?: (snapshot: string, required?: readonly string[]) => Promise<void>;

  constructor(
    private database: D1Database,
    staged = false,
  ) {
    if (staged)
      this.publish = (snapshot, required) =>
        this.publishCurrent(snapshot, required);
  }

  private initialize() {
    return (this.ready ??= this.database
      .batch([
        this.database.prepare(
          "CREATE TABLE IF NOT EXISTS search_entries(snapshot TEXT NOT NULL,event TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(snapshot,event))",
        ),
        this.database.prepare(
          "CREATE TABLE IF NOT EXISTS search_current(id INTEGER PRIMARY KEY CHECK(id=1),snapshot TEXT NOT NULL)",
        ),
        this.database.prepare(
          "CREATE TABLE IF NOT EXISTS search_aliases(snapshot TEXT PRIMARY KEY,source TEXT NOT NULL)",
        ),
        this.database.prepare(
          "CREATE TABLE IF NOT EXISTS search_snapshots(snapshot TEXT PRIMARY KEY,entries INTEGER NOT NULL)",
        ),
      ])
      .then(() =>
        this.database
          .prepare(
            // Only the published legacy generation is known to be complete.
            "INSERT OR IGNORE INTO search_snapshots SELECT c.snapshot,COUNT(e.event) FROM search_current c LEFT JOIN search_entries e ON e.snapshot=c.snapshot WHERE c.id=1 GROUP BY c.snapshot",
          )
          .run(),
      )
      .catch((error) => {
        this.ready = undefined;
        throw error;
      }));
  }

  private async generation(snapshot: string) {
    await this.initialize();
    return this.database
      .prepare(
        "SELECT COALESCE(a.source,s.snapshot) AS source,g.entries FROM search_snapshots s LEFT JOIN search_aliases a ON a.snapshot=s.snapshot JOIN search_snapshots g ON g.snapshot=COALESCE(a.source,s.snapshot) WHERE s.snapshot=?",
      )
      .bind(snapshot)
      .first<{ source: string; entries: number }>();
  }

  async replace(snapshot: string, entries: SearchEntry[]) {
    await this.initialize();
    // Chunk writes stay private until all entries exist. A failed rebuild also
    // leaves an already published copy of this same snapshot intact.
    const staging = "staging:" + crypto.randomUUID();
    try {
      for (let start = 0; start < entries.length; start += 100)
        await this.database.batch(
          entries
            .slice(start, start + 100)
            .map((entry) =>
              this.database
                .prepare(UPSERT_SEARCH_ENTRY)
                .bind(staging, entry.event, JSON.stringify(entry)),
            ),
        );
      await this.database.batch([
        this.database
          .prepare("DELETE FROM search_aliases WHERE snapshot=?")
          .bind(snapshot),
        this.database
          .prepare("DELETE FROM search_entries WHERE snapshot=?")
          .bind(snapshot),
        this.database
          .prepare(
            "INSERT INTO search_entries SELECT ?,event,value FROM search_entries WHERE snapshot=?",
          )
          .bind(snapshot, staging),
        this.database
          .prepare("DELETE FROM search_entries WHERE snapshot=?")
          .bind(staging),
        this.database
          .prepare(
            "INSERT INTO search_snapshots VALUES(?,?) ON CONFLICT(snapshot) DO UPDATE SET entries=excluded.entries",
          )
          .bind(snapshot, entries.length),
      ]);
    } catch (error) {
      // A later publication also removes abandoned staging rows if cleanup fails.
      await this.database
        .prepare("DELETE FROM search_entries WHERE snapshot=?")
        .bind(staging)
        .run()
        .catch(() => {});
      throw error;
    }
    if (!this.publish) await this.publishCurrent(snapshot);
  }

  async reuse(previous: string, snapshot: string): Promise<boolean> {
    const generation = await this.generation(previous);
    if (!generation) return false;
    const statements = [];
    if (generation.source !== snapshot)
      statements.push(
        this.database
          .prepare(
            "INSERT INTO search_aliases VALUES(?,?) ON CONFLICT(snapshot) DO UPDATE SET source=excluded.source",
          )
          .bind(snapshot, generation.source),
      );
    statements.push(
      this.database
        .prepare(
          "INSERT INTO search_snapshots VALUES(?,?) ON CONFLICT(snapshot) DO UPDATE SET entries=excluded.entries",
        )
        .bind(snapshot, generation.entries),
    );
    await this.database.batch(statements);
    if (!this.publish) await this.publishCurrent(snapshot);
    return true;
  }

  async restore(snapshot: string, entries: SearchEntry[]): Promise<void> {
    const generation = await this.generation(snapshot);
    if (generation) {
      const count = await this.database
        .prepare("SELECT COUNT(*) AS n FROM search_entries WHERE snapshot=?")
        .bind(generation.source)
        .first<number>("n");
      if (count === entries.length) return;
    }
    await this.replace(snapshot, entries);
  }

  private async publishCurrent(
    snapshot: string,
    required: readonly string[] = [],
  ) {
    await this.initialize();
    const ids = [...new Set([snapshot, ...required])];
    // Every statement sees the old pointer until the final statement. The D1
    // batch commits cleanup and the new pointer together or rolls them all back.
    const retained = `SELECT snapshot FROM search_current WHERE id=1 UNION SELECT value FROM json_each(?)`;
    const bindings = JSON.stringify(ids);
    const keep = `snapshot IN (${retained}) OR snapshot IN (SELECT source FROM search_aliases WHERE snapshot IN (${retained}))`;
    await this.database.batch([
      ...["search_entries", "search_snapshots", "search_aliases"].map((table) =>
        this.database
          .prepare(`DELETE FROM ${table} WHERE NOT (${keep})`)
          .bind(bindings, bindings),
      ),
      this.database
        .prepare(
          // The NOT NULL constraint rejects an absent or incomplete generation.
          "INSERT INTO search_current VALUES(1,(SELECT snapshot FROM search_snapshots WHERE snapshot=?)) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot",
        )
        .bind(snapshot),
    ]);
  }
}
