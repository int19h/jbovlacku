import { DatabaseSync } from "node:sqlite";
import { sqliteConnection } from "../../../packages/service/src/sqlite.ts";
import {
  DEFAULT_VECTOR_LIMITS,
  SqlVectorStore,
  type VectorLimits,
} from "../../../packages/service/src/semantic/sql-vector-store.ts";
import type { AssistanceService } from "../../../packages/service/src/assistance.ts";
import { SqlQueryCache } from "../../../packages/service/src/semantic/query-cache.ts";

export function semanticVectorLimits(
  environment: Record<string, string | undefined> = process.env,
): VectorLimits {
  const limits = { ...DEFAULT_VECTOR_LIMITS };
  for (const [name, key] of [
    ["JVC_SEMANTIC_STORE_ASSOCIATIONS", "associations"],
    ["JVC_SEMANTIC_STORE_VECTORS", "vectors"],
    ["JVC_SEMANTIC_STORE_BYTES", "bytes"],
  ] as const) {
    const value = environment[name];
    if (value === undefined) continue;
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw new Error(`${name} must be a positive safe integer.`);
    limits[key] = Number(value);
  }
  return limits;
}

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
    const connection = sqliteConnection(database, true);
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
