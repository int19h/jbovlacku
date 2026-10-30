import type { DatabaseSync, StatementSync } from "node:sqlite";

/** Bind local SQLite statements and keep each transaction synchronous. */
export function sqliteConnection(
  database: DatabaseSync,
  cacheStatements = false,
) {
  const statements = new Map<string, StatementSync>();
  return {
    exec(
      sql: string,
      ...bindings: (string | number | Uint8Array | null)[]
    ): Record<string, unknown>[] {
      let statement = statements.get(sql);
      if (!statement) {
        statement = database.prepare(sql);
        if (cacheStatements) statements.set(sql, statement);
      }
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
}
export type SqliteConnection = ReturnType<typeof sqliteConnection>;
