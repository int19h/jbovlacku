import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  SqlVectorStore,
  type VectorLimits,
} from "../../../packages/service/src/semantic/sql-vector-store.ts";
import type { AssistanceService } from "../../../packages/service/src/assistance.ts";

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
  constructor(path: string, limits?: VectorLimits) {
    const database = new DatabaseSync(path);
    database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    const statements = new Map<string, StatementSync>();
    super(
      {
        exec(sql, ...bindings) {
          let statement = statements.get(sql);
          if (!statement)
            statements.set(sql, (statement = database.prepare(sql)));
          if (statement.columns().length)
            return statement.all(...bindings) as Record<string, unknown>[];
          statement.run(...bindings);
          return [];
        },
        transaction(operation) {
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
      },
      limits,
    );
    this.database = database;
  }
  checkpoint(): void {
    this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  close(): void {
    this.database.close();
  }
}
