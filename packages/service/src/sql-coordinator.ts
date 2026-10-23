import {
  freezeSnapshotCache,
  serializeSnapshotCache,
  serializeSnapshotCacheValue,
} from "./snapshot-cache.ts";
import {
  emptyState,
  type State,
  type StateMetadata,
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
interface SnapshotRow {
  cache_schema: 1;
  event_revision: number;
  value: Omit<Snapshot, "events">;
}
export class SqlRowsCoordinator {
  private loaded?: State;
  private snapshotCache = new Map<string, Snapshot>();
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
      "CREATE TABLE IF NOT EXISTS snapshot_event_versions (event TEXT NOT NULL, start_revision INTEGER NOT NULL, end_revision INTEGER, value TEXT NOT NULL, PRIMARY KEY(event,start_revision))",
    );
    sql.exec(
      "CREATE INDEX IF NOT EXISTS snapshot_event_version_range ON snapshot_event_versions(end_revision,start_revision)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS snapshot_cache_revisions (hash TEXT PRIMARY KEY, event_revision INTEGER NOT NULL)",
    );
    sql.exec(
      "INSERT OR IGNORE INTO metadata VALUES(1,0,?)",
      JSON.stringify(this.metadata(emptyState())),
    );
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
  async loadMetadata(): Promise<StateMetadata> {
    return JSON.parse(
      String(this.sql.exec("SELECT state FROM metadata WHERE id=1")[0].state),
    ) as StateMetadata;
  }
  private save(state: State, changedIds?: string[]) {
    const previous =
      this.loaded?.revision === this.currentRevision()
        ? this.loaded
        : undefined;
    const ids = changedIds ?? Object.keys(state.events);
    for (const id of ids) {
      const event = state.events[id];
      if (!event)
        throw new Error("A changed event is missing from the next state.");
      if (previous?.events[id] === event) continue;
      const value = JSON.stringify(event);
      const old = previous?.events[id]
        ? JSON.stringify(previous.events[id])
        : this.sql.exec("SELECT value FROM events WHERE id=?", id)[0]?.value;
      if (old !== value)
        this.sql.exec(
          "INSERT INTO events VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
          id,
          value,
        );
    }
    const oldPosition =
      previous?.position ??
      Number(
        (
          JSON.parse(
            String(
              this.sql.exec("SELECT state FROM metadata WHERE id=1")[0].state,
            ),
          ) as StateMetadata
        ).position,
      );
    for (let index = oldPosition; index < state.journal.length; index++) {
      const receipt = state.journal[index];
      this.sql.exec(
        "INSERT OR IGNORE INTO receipts VALUES(?,?)",
        receipt.position,
        receipt.id,
      );
    }
    const oldSelections = new Set(
      previous?.selections ??
        this.sql
          .exec("SELECT hash FROM selections")
          .map((row) => String(row.hash)),
    );
    for (const hash of state.selections)
      if (!oldSelections.has(hash))
        this.sql.exec("INSERT OR IGNORE INTO selections VALUES(?)", hash);
    this.sql.exec(
      "UPDATE metadata SET revision=?,state=? WHERE id=1",
      state.revision,
      JSON.stringify(this.metadata(state)),
    );
  }
  async load(): Promise<State> {
    return this.sql.transaction(() => {
      const metadata = JSON.parse(
        String(this.sql.exec("SELECT state FROM metadata WHERE id=1")[0].state),
      );
      if (this.loaded && this.loaded.revision === metadata.revision)
        return this.loaded;
      const rows = this.sql.exec("SELECT id,value FROM events ORDER BY id");
      const state: State = {
        ...metadata,
        events: Object.fromEntries(
          rows.map((row) => [
            String(row.id),
            JSON.parse(String(row.value)) as StoredEvent,
          ]),
        ),
        journal: this.sql
          .exec("SELECT position,id FROM receipts ORDER BY position")
          .map((row) => ({
            position: Number(row.position),
            id: String(row.id),
          })),
        selections: this.sql
          .exec("SELECT hash FROM selections ORDER BY hash")
          .map((row) => String(row.hash)),
        snapshots: this.sql
          .exec("SELECT hash FROM cached_snapshots ORDER BY revision,hash")
          .map((row) => String(row.hash)),
      };
      this.loaded = state;
      return state;
    });
  }
  private readSnapshot(id: string): Snapshot | null {
    if (
      !this.sql.exec("SELECT hash FROM cached_snapshots WHERE hash=?", id)
        .length
    ) {
      this.snapshotCache.delete(id);
      return null;
    }
    const cached = this.snapshotCache.get(id);
    if (cached) return cached;
    const text = this.sql
      .exec(
        "SELECT value FROM cached_snapshot_chunks WHERE hash=? ORDER BY position",
        id,
      )
      .map((row) => String(row.value))
      .join("");
    const parsed = JSON.parse(text) as Snapshot | SnapshotRow;
    const snapshot =
      "cache_schema" in parsed
        ? {
            ...parsed.value,
            events: Object.fromEntries(
              this.sql
                .exec(
                  "SELECT event,value FROM snapshot_event_versions WHERE start_revision<=? AND (end_revision IS NULL OR end_revision>?) ORDER BY event",
                  parsed.event_revision,
                  parsed.event_revision,
                )
                .map((row) => [
                  String(row.event),
                  JSON.parse(String(row.value)),
                ]),
            ),
          }
        : parsed;
    this.rememberSnapshot(snapshot);
    return snapshot;
  }
  async getSnapshot(id: string): Promise<Snapshot | null> {
    return this.sql.transaction(() => this.readSnapshot(id));
  }
  private rememberSnapshot(snapshot: Snapshot) {
    // These private objects are immutable after publication. The service replaces changed records.
    freezeSnapshotCache(snapshot);
    this.snapshotCache.set(snapshot.snapshot, snapshot);
    while (this.snapshotCache.size > this.retainedSnapshots)
      this.snapshotCache.delete(this.snapshotCache.keys().next().value!);
  }
  private cacheSnapshot(
    snapshot: Snapshot,
    revision: number,
    changedIds?: string[],
  ) {
    if (
      this.sql.exec(
        "SELECT hash FROM cached_snapshots WHERE hash=?",
        snapshot.snapshot,
      ).length
    ) {
      const old = this.readSnapshot(snapshot.snapshot)!;
      if (
        old !== snapshot &&
        serializeSnapshotCache(old) !== serializeSnapshotCache(snapshot)
      )
        throw new Error("Snapshot cache collision.");
      this.sql.exec(
        "UPDATE cached_snapshots SET revision=? WHERE hash=?",
        revision,
        snapshot.snapshot,
      );
      return;
    }
    const existing =
      this.sql.exec("SELECT event FROM snapshot_event_versions LIMIT 1")
        .length > 0;
    // A first normalized wrapper establishes the full baseline. Later wrappers add changed records only.
    const ids =
      existing && changedIds ? changedIds : Object.keys(snapshot.events);
    for (const id of ids) {
      const event = snapshot.events[id];
      if (!event)
        throw new Error("A changed event is missing from the snapshot.");
      const value = JSON.stringify(event);
      const old = this.sql.exec(
        "SELECT value FROM snapshot_event_versions WHERE event=? AND end_revision IS NULL",
        id,
      )[0];
      if (old?.value === value) continue;
      this.sql.exec(
        "UPDATE snapshot_event_versions SET end_revision=? WHERE event=? AND end_revision IS NULL",
        revision,
        id,
      );
      this.sql.exec(
        "INSERT INTO snapshot_event_versions VALUES(?,?,NULL,?)",
        id,
        revision,
        value,
      );
    }
    const { events, ...value } = snapshot;
    const serialized = serializeSnapshotCacheValue({
      cache_schema: 1,
      event_revision: revision,
      value,
    } satisfies SnapshotRow);
    this.sql.exec(
      "INSERT INTO cached_snapshots VALUES(?,?)",
      snapshot.snapshot,
      revision,
    );
    this.sql.exec(
      "INSERT INTO snapshot_cache_revisions VALUES(?,?) ON CONFLICT(hash) DO UPDATE SET event_revision=excluded.event_revision",
      snapshot.snapshot,
      revision,
    );
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
  private expireSnapshots(protectedSnapshot: string | null): string[] {
    const expired: string[] = [];
    for (const row of this.sql.exec(
      "SELECT hash FROM cached_snapshots ORDER BY revision DESC,hash LIMIT -1 OFFSET ?",
      this.retainedSnapshots,
    )) {
      const id = String(row.hash);
      // Keep the last complete snapshot while accepted writes wait for evaluation.
      if (id === protectedSnapshot) continue;
      expired.push(id);
      this.sql.exec("DELETE FROM cached_snapshot_chunks WHERE hash=?", id);
      this.sql.exec("DELETE FROM cached_snapshots WHERE hash=?", id);
      this.sql.exec("DELETE FROM snapshot_cache_revisions WHERE hash=?", id);
    }
    if (expired.length) {
      const oldest = this.sql.exec(
        "SELECT MIN(event_revision) AS revision FROM snapshot_cache_revisions",
      )[0]?.revision;
      if (oldest !== null && oldest !== undefined)
        this.sql.exec(
          "DELETE FROM snapshot_event_versions WHERE end_revision<=?",
          Number(oldest),
        );
    }
    return expired;
  }
  async compareAndSwap(
    revision: number,
    state: State,
    snapshot?: Snapshot,
    changedIds?: string[],
  ): Promise<boolean> {
    const expiredIds: string[] = [];
    const committed = this.sql.transaction(() => {
      if (this.currentRevision() !== revision) return false;
      if (snapshot) {
        if (snapshot.snapshot !== state.snapshot)
          throw new Error("Snapshot pointer does not match cached bytes.");
        this.cacheSnapshot(snapshot, state.revision, changedIds);
      }
      expiredIds.push(...this.expireSnapshots(state.materialized_snapshot));
      this.save(state, changedIds);
      return true;
    });
    if (committed) {
      this.loaded = {
        ...state,
        snapshots: this.sql
          .exec("SELECT hash FROM cached_snapshots ORDER BY revision,hash")
          .map((row) => String(row.hash)),
      };
      for (const id of expiredIds) this.snapshotCache.delete(id);
      if (snapshot) this.rememberSnapshot(snapshot);
    }
    return committed;
  }
  async markMaterialized(snapshot: string, position: number): Promise<boolean> {
    let updated: StateMetadata | undefined;
    let expired: string[] = [];
    const committed = this.sql.transaction(() => {
      const row = this.sql.exec("SELECT state FROM metadata WHERE id=1")[0];
      const metadata = JSON.parse(String(row.state)) as StateMetadata;
      if (metadata.snapshot !== snapshot || metadata.position !== position)
        return false;
      if (
        metadata.materialized_snapshot === snapshot &&
        metadata.materialized_position === position
      )
        return true;
      metadata.revision++;
      metadata.materialized_snapshot = snapshot;
      metadata.materialized_position = position;
      this.sql.exec(
        "UPDATE metadata SET revision=?,state=? WHERE id=1",
        metadata.revision,
        JSON.stringify(metadata),
      );
      expired = this.expireSnapshots(snapshot);
      updated = metadata;
      return true;
    });
    if (
      committed &&
      updated &&
      this.loaded &&
      this.loaded.revision !== updated.revision - 1
    )
      this.loaded = undefined;
    if (committed && updated && this.loaded) {
      this.loaded = {
        ...this.loaded,
        ...updated,
        snapshots: this.sql
          .exec("SELECT hash FROM cached_snapshots ORDER BY revision,hash")
          .map((row) => String(row.hash)),
      };
    }
    for (const id of expired) this.snapshotCache.delete(id);
    return committed;
  }
}
