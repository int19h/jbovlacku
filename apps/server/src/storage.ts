import { mkdir, open, readFile, link, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CheckpointBinding } from "../../../packages/service/src/checkpoint.ts";
import { UPSERT_SEARCH_ENTRY } from "../../../packages/service/src/index-store.ts";
import { SqlRowsCoordinator } from "../../../packages/service/src/sql-coordinator.ts";
import { DatabaseSync } from "node:sqlite";
import {
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
export interface CheckpointPin {
  binding: string;
  hash: string;
  file: string;
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
    database.exec(
      "CREATE TABLE IF NOT EXISTS evaluation_checkpoint_pin (id INTEGER PRIMARY KEY CHECK(id=1), binding TEXT NOT NULL, hash TEXT NOT NULL, file TEXT NOT NULL)",
    );
  }
  checkpointPin(): CheckpointPin | null {
    const row = this.database
      .prepare(
        "SELECT binding,hash,file FROM evaluation_checkpoint_pin WHERE id=1",
      )
      .get();
    return row
      ? {
          binding: String(row.binding),
          hash: String(row.hash),
          file: String(row.file),
        }
      : null;
  }
  pinCheckpoint(binding: CheckpointBinding, pin: CheckpointPin): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const metadata = JSON.parse(
        String(
          this.database.prepare("SELECT state FROM metadata WHERE id=1").get()!
            .state,
        ),
      );
      if (
        metadata.materialized_snapshot !== binding.snapshot ||
        metadata.materialized_position !== binding.position
      ) {
        this.database.exec("ROLLBACK");
        return false;
      }
      this.database
        .prepare(
          "INSERT INTO evaluation_checkpoint_pin VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET binding=excluded.binding,hash=excluded.hash,file=excluded.file",
        )
        .run(pin.binding, pin.hash, pin.file);
      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}

export class SqliteIndexStore {
  private database: DatabaseSync;
  publish?: (snapshot: string) => Promise<void>;
  constructor(path: string, staged = false) {
    this.database = new DatabaseSync(path);
    if (staged)
      this.publish = async (snapshot) => {
        this.publishCurrent(snapshot);
      };
    this.database.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS search_entries(snapshot TEXT NOT NULL,event TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(snapshot,event)); CREATE TABLE IF NOT EXISTS search_current(id INTEGER PRIMARY KEY CHECK(id=1),snapshot TEXT NOT NULL); CREATE TABLE IF NOT EXISTS search_aliases(snapshot TEXT PRIMARY KEY, source TEXT NOT NULL)",
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
      if (!this.publish) this.publishCurrent(snapshot);
      this.database
        .prepare("DELETE FROM search_aliases WHERE snapshot=?")
        .run(snapshot);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  private publishCurrent(snapshot: string): void {
    this.database
      .prepare(
        "INSERT INTO search_current VALUES(1,?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot",
      )
      .run(snapshot);
  }
  async reuse(previous: string, snapshot: string): Promise<void> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const alias = this.database
        .prepare("SELECT source FROM search_aliases WHERE snapshot=?")
        .get(previous);
      const source = alias ? String(alias.source) : previous;
      const current = this.database
        .prepare("SELECT snapshot FROM search_current WHERE id=1")
        .get();
      if (
        (!current &&
          !alias &&
          !this.database
            .prepare("SELECT 1 FROM search_entries WHERE snapshot=? LIMIT 1")
            .get(source)) ||
        (current &&
          String(current.snapshot) !== previous &&
          !alias &&
          !this.database
            .prepare("SELECT 1 FROM search_entries WHERE snapshot=? LIMIT 1")
            .get(source))
      )
        throw new Error("The previous search index is unavailable.");
      if (source !== snapshot)
        this.database
          .prepare(
            "INSERT INTO search_aliases VALUES(?,?) ON CONFLICT(snapshot) DO UPDATE SET source=excluded.source",
          )
          .run(snapshot, source);
      if (!this.publish) this.publishCurrent(snapshot);
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
