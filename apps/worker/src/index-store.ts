import { UPSERT_SEARCH_ENTRY } from "../../../packages/service/src/index-store.ts";
export class D1IndexStore {
  constructor(private database: D1Database) {}
  async replace(
    snapshot: string,
    entries: import("../../../packages/service/src/packages.ts").SearchEntry[],
  ) {
    await this.database.batch([
      this.database.prepare(
        "CREATE TABLE IF NOT EXISTS search_entries(snapshot TEXT NOT NULL,event TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(snapshot,event))",
      ),
      this.database.prepare(
        "CREATE TABLE IF NOT EXISTS search_current(id INTEGER PRIMARY KEY CHECK(id=1),snapshot TEXT NOT NULL)",
      ),
    ]);
    for (let start = 0; start < entries.length; start += 100)
      await this.database.batch(
        entries
          .slice(start, start + 100)
          .map((entry) =>
            this.database
              .prepare(UPSERT_SEARCH_ENTRY)
              .bind(snapshot, entry.event, JSON.stringify(entry)),
          ),
      );
    await this.database
      .prepare(
        "INSERT INTO search_current VALUES(1,?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot",
      )
      .bind(snapshot)
      .run();
  }
}
