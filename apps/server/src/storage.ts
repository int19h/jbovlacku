import { mkdir, open, readFile, link, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { UPSERT_SEARCH_ENTRY } from "../../../packages/service/src/index-store.ts";
import { SqlRowsCoordinator } from "../../../packages/service/src/sql-coordinator.ts";
import { DatabaseSync } from "node:sqlite";
import {
  emptyState,
  type State,
  type ObjectStore,
  type Coordinator,
} from "../../../packages/service/src/storage.ts";
export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function durableDirectory(
  path: string,
  sync = syncDirectory,
): Promise<void> {
  const firstCreated = await mkdir(path, { recursive: true });
  if (firstCreated === undefined) return;
  let current = path;
  for (;;) {
    await sync(dirname(current));
    if (current === firstCreated) break;
    current = dirname(current);
  }
}
export class FileObjectStore implements ObjectStore {
  constructor(private directory: string) {}
  private path(hash: string) {
    if (!/^(snapshot2?:sha256:|sha256:)[a-f0-9]{64}$/.test(hash))
      throw new Error("Invalid object key.");
    return join(this.directory, hash.replaceAll(":", "-"));
  }
  async get(hash: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.path(hash));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async put(hash: string, bytes: Uint8Array): Promise<void> {
    await durableDirectory(this.directory);
    const path = this.path(hash);
    const temporary = join(this.directory, `.pending-${randomUUID()}`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const old = await readFile(path);
        if (!Buffer.from(bytes).equals(old))
          throw new Error("Object hash collision.");
      }
    } finally {
      await file.close();
      await unlink(temporary);
    }
    const directory = await open(this.directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
export class SqliteCoordinator extends SqlRowsCoordinator {
  private database: DatabaseSync;
  private closed = false;
  constructor(path: string, retainedSnapshots = 16) {
    const database = new DatabaseSync(path);
    database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    super(
      {
        exec(sql, ...bindings) {
          const statement = database.prepare(sql);
          if (statement.columns().length)
            return statement.all(...bindings) as Record<string, unknown>[];
          statement.run(...bindings);
          return [];
        },
        transaction(operation) {
          database.exec("BEGIN IMMEDIATE");
          try {
            const value = operation();
            database.exec("COMMIT");
            return value;
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
        },
      },
      retainedSnapshots,
    );
    this.database = database;
  }
  close() {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}

export class SqliteIndexStore {
  private database: DatabaseSync;
  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS search_entries(snapshot TEXT NOT NULL,event TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(snapshot,event)); CREATE TABLE IF NOT EXISTS search_current(id INTEGER PRIMARY KEY CHECK(id=1),snapshot TEXT NOT NULL)",
    );
  }
  async replace(
    snapshot: string,
    entries: import("../../../packages/service/src/packages.ts").SearchEntry[],
  ) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.database.prepare(UPSERT_SEARCH_ENTRY);
      for (const entry of entries)
        insert.run(snapshot, entry.event, JSON.stringify(entry));
      this.database
        .prepare(
          "INSERT INTO search_current VALUES(1,?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot",
        )
        .run(snapshot);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.database.close();
  }
}
