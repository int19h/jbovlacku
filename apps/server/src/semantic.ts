import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  SqlVectorStore,
  type VectorLimits,
} from "../../../packages/service/src/semantic/sql-vector-store.ts";
import type { AssistanceService } from "../../../packages/service/src/assistance.ts";
import { SqlQueryCache } from "../../../packages/service/src/semantic/query-cache.ts";

/** A caller timeout cannot close the stores or release the host lock during retained transport work. */
export async function closeSemanticIndexHost(
  assistance: Pick<AssistanceService, "drainEmbeddingTransports"> | undefined,
  budget: { close(): void } | undefined,
  vectors: { close(): void } | undefined,
  release: () => Promise<void>,
): Promise<void> {
  await assistance?.drainEmbeddingTransports();
  budget?.close();
  vectors?.close();
  await release();
}

/** This database contains derived data only. Dictionary admission uses another connection. */
export class SqliteVectorStore extends SqlVectorStore {
  private database: DatabaseSync;
  readonly queryCache: SqlQueryCache;
  constructor(path: string, limits?: VectorLimits) {
    const database = new DatabaseSync(path);
    database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    const statements = new Map<string, StatementSync>();
    const connection = {
      exec(sql: string, ...bindings: (string | number | Uint8Array | null)[]) {
        let statement = statements.get(sql);
        if (!statement)
          statements.set(sql, (statement = database.prepare(sql)));
        if (statement.columns().length)
          return statement.all(...bindings) as Record<string, unknown>[];
        statement.run(...bindings);
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
    super(connection, limits);
    this.queryCache = new SqlQueryCache(connection);
    this.database = database;
  }
  checkpoint(): void {
    this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  close(): void {
    this.database.close();
  }
}
