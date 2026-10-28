import type { VectorSqlConnection } from "./sql-vector-store.ts";

/** Query text never enters this store. Allocation is separate from document vectors. */
export interface QueryCache {
  get(profile: string, input: string): Promise<Uint8Array | null>;
  put(profile: string, input: string, vector: Uint8Array): Promise<void>;
}

export class SqlQueryCache implements QueryCache {
  constructor(
    private sql: VectorSqlConnection,
    private maximumBytes = 32 * 1024 * 1024,
    private maximumEntries = 2048,
  ) {
    if (
      ![maximumBytes, maximumEntries].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      )
    )
      throw new Error("The query cache limits are invalid.");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS semantic_queries(profile TEXT NOT NULL,input TEXT NOT NULL,vector BLOB NOT NULL,used INTEGER NOT NULL,PRIMARY KEY(profile,input))",
    );
    sql.exec(
      "CREATE INDEX IF NOT EXISTS semantic_query_eviction ON semantic_queries(used,profile,input)",
    );
  }
  async get(profile: string, input: string) {
    return this.sql.transaction(() => {
      const row = this.sql.exec(
        "SELECT vector FROM semantic_queries WHERE profile=? AND input=?",
        profile,
        input,
      )[0];
      if (!row) return null;
      this.sql.exec(
        "UPDATE semantic_queries SET used=? WHERE profile=? AND input=?",
        Date.now(),
        profile,
        input,
      );
      return row.vector as Uint8Array;
    });
  }
  async put(profile: string, input: string, vector: Uint8Array) {
    if (vector.byteLength > this.maximumBytes) return;
    this.sql.transaction(() => {
      this.sql.exec(
        "INSERT INTO semantic_queries VALUES(?,?,?,?) ON CONFLICT(profile,input) DO UPDATE SET vector=excluded.vector,used=excluded.used",
        profile,
        input,
        vector,
        Date.now(),
      );
      let usage = this.sql.exec(
        "SELECT COUNT(*) AS count,COALESCE(SUM(length(vector)),0) AS bytes FROM semantic_queries",
      )[0];
      while (
        Number(usage.count) > this.maximumEntries ||
        Number(usage.bytes) > this.maximumBytes
      ) {
        const old = this.sql.exec(
          "SELECT profile,input,length(vector) AS bytes FROM semantic_queries ORDER BY used,profile,input LIMIT 1",
        )[0];
        this.sql.exec(
          "DELETE FROM semantic_queries WHERE profile=? AND input=?",
          String(old.profile),
          String(old.input),
        );
        usage = {
          count: Number(usage.count) - 1,
          bytes: Number(usage.bytes) - Number(old.bytes),
        };
      }
    });
  }
}
