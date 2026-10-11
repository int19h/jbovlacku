import { serializeSnapshotCache } from "./snapshot-cache.ts";
import {
  emptyState,
  type State,
  type StoredEvent,
  type Snapshot,
} from "./storage.ts";
export interface SqlConnection {
  exec(
    sql: string,
    ...bindings: (string | number)[]
  ): Record<string, unknown>[];
  transaction<T>(operation: () => T): T;
}
export class SqlRowsCoordinator {
  constructor(
    private sql: SqlConnection,
    private retainedSnapshots = 16,
  ) {
    if (
      !Number.isInteger(retainedSnapshots) ||
      retainedSnapshots < 1 ||
      retainedSnapshots > 64
    )
      throw new Error(
        "Snapshot retention must be an integer from 1 through 64.",
      );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, state TEXT NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS receipts (position INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL)",
    );
    sql.exec("CREATE TABLE IF NOT EXISTS selections (hash TEXT PRIMARY KEY)");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS cached_snapshots (hash TEXT PRIMARY KEY, revision INTEGER NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS cached_snapshot_chunks (hash TEXT NOT NULL, position INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(hash,position))",
    );
    sql.exec(
      "INSERT OR IGNORE INTO metadata VALUES(1,0,?)",
      JSON.stringify(this.metadata(emptyState())),
    );
    // Migrate the first prototype layout before any new admission.
    const legacy = sql.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='coordinator'",
    );
    if (legacy.length) {
      const row = sql.exec("SELECT state FROM coordinator WHERE id=1")[0];
      const state = JSON.parse(String(row.state)) as State;
      if (this.currentRevision() === 0 && state.revision > 0)
        sql.transaction(() => this.save(state));
      sql.exec("DROP TABLE coordinator");
    }
  }
  private metadata(state: State) {
    const { events, journal, selections, snapshots, ...metadata } = state;
    return metadata;
  }
  private currentRevision() {
    return Number(
      this.sql.exec("SELECT revision FROM metadata WHERE id=1")[0].revision,
    );
  }
  private save(state: State) {
    const existing = new Map(
      this.sql
        .exec("SELECT id,value FROM events")
        .map((row) => [String(row.id), String(row.value)]),
    );
    for (const [id, event] of Object.entries(state.events)) {
      const value = JSON.stringify(event);
      if (existing.get(id) !== value)
        this.sql.exec(
          "INSERT INTO events VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
          id,
          value,
        );
    }
    for (const receipt of state.journal)
      this.sql.exec(
        "INSERT OR IGNORE INTO receipts VALUES(?,?)",
        receipt.position,
        receipt.id,
      );
    for (const hash of state.selections)
      this.sql.exec("INSERT OR IGNORE INTO selections VALUES(?)", hash);
    this.sql.exec(
      "UPDATE metadata SET revision=?,state=? WHERE id=1",
      state.revision,
      JSON.stringify(this.metadata(state)),
    );
  }
  async load(): Promise<State> {
    return this.sql.transaction(() => {
      const state = JSON.parse(
        String(this.sql.exec("SELECT state FROM metadata WHERE id=1")[0].state),
      );
      state.events = Object.fromEntries(
        this.sql
          .exec("SELECT id,value FROM events ORDER BY id")
          .map((row) => [
            String(row.id),
            JSON.parse(String(row.value)) as StoredEvent,
          ]),
      );
      state.journal = this.sql
        .exec("SELECT position,id FROM receipts ORDER BY position")
        .map((row) => ({ position: Number(row.position), id: String(row.id) }));
      state.selections = this.sql
        .exec("SELECT hash FROM selections ORDER BY hash")
        .map((row) => String(row.hash));
      state.snapshots = this.sql
        .exec("SELECT hash FROM cached_snapshots ORDER BY revision,hash")
        .map((row) => String(row.hash));
      return state;
    });
  }
  async getSnapshot(id: string): Promise<Snapshot | null> {
    return this.sql.transaction(() => {
      if (
        !this.sql.exec("SELECT hash FROM cached_snapshots WHERE hash=?", id)
          .length
      )
        return null;
      const text = this.sql
        .exec(
          "SELECT value FROM cached_snapshot_chunks WHERE hash=? ORDER BY position",
          id,
        )
        .map((row) => String(row.value))
        .join("");
      return JSON.parse(text) as Snapshot;
    });
  }
  private cacheSnapshot(snapshot: Snapshot, revision: number) {
    const serialized = serializeSnapshotCache(snapshot);
    if (
      this.sql.exec(
        "SELECT hash FROM cached_snapshots WHERE hash=?",
        snapshot.snapshot,
      ).length
    ) {
      const old = this.sql
        .exec(
          "SELECT value FROM cached_snapshot_chunks WHERE hash=? ORDER BY position",
          snapshot.snapshot,
        )
        .map((row) => String(row.value))
        .join("");
      if (old !== serialized) throw new Error("Snapshot cache collision.");
      this.sql.exec(
        "UPDATE cached_snapshots SET revision=? WHERE hash=?",
        revision,
        snapshot.snapshot,
      );
      return;
    }
    this.sql.exec(
      "INSERT INTO cached_snapshots VALUES(?,?)",
      snapshot.snapshot,
      revision,
    );
    // Each chunk has at most 600,000 UTF-8 bytes, below the DO SQLite value limit.
    for (let offset = 0, position = 0; offset < serialized.length; position++) {
      let end = Math.min(offset + 200_000, serialized.length);
      if (
        end < serialized.length &&
        serialized.charCodeAt(end - 1) >= 0xd800 &&
        serialized.charCodeAt(end - 1) <= 0xdbff &&
        serialized.charCodeAt(end) >= 0xdc00 &&
        serialized.charCodeAt(end) <= 0xdfff
      )
        end--;
      this.sql.exec(
        "INSERT INTO cached_snapshot_chunks VALUES(?,?,?)",
        snapshot.snapshot,
        position,
        serialized.slice(offset, end),
      );
      offset = end;
    }
  }
  async compareAndSwap(
    revision: number,
    state: State,
    snapshot?: Snapshot,
  ): Promise<boolean> {
    return this.sql.transaction(() => {
      if (this.currentRevision() !== revision) return false;
      if (snapshot) {
        if (snapshot.snapshot !== state.snapshot)
          throw new Error("Snapshot pointer does not match cached bytes.");
        this.cacheSnapshot(snapshot, state.revision);
      }
      const expired = this.sql.exec(
        "SELECT hash FROM cached_snapshots ORDER BY revision DESC,hash LIMIT -1 OFFSET ?",
        this.retainedSnapshots,
      );
      for (const row of expired) {
        this.sql.exec(
          "DELETE FROM cached_snapshot_chunks WHERE hash=?",
          String(row.hash),
        );
        this.sql.exec(
          "DELETE FROM cached_snapshots WHERE hash=?",
          String(row.hash),
        );
      }
      this.save(state);
      return true;
    });
  }
}
