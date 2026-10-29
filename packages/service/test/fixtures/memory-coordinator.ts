import {
  emptyState,
  type State,
  type Snapshot,
  type Coordinator,
} from "../../src/storage.ts";

export class MemoryCoordinator implements Coordinator {
  constructor(public state: State = emptyState()) {}
  snapshots = new Map<string, Snapshot>();
  snapshotRevisions = new Map<string, number>();
  async load() {
    return this.state;
  }
  async loadMetadata() {
    const {
      revision,
      position,
      snapshot,
      materialized_position,
      materialized_snapshot,
    } = this.state;
    return {
      revision,
      position,
      snapshot,
      materialized_position,
      materialized_snapshot,
    };
  }
  async getSnapshot(id: string) {
    return this.snapshots.get(id) ?? null;
  }
  async getSnapshotRevision(id: string) {
    return this.snapshots.has(id) ? this.snapshotRevisions.get(id)! : null;
  }
  async compareAndSwap(revision: number, state: State, snapshot?: Snapshot) {
    if (this.state.revision !== revision) return false;
    this.state = state;
    if (snapshot) {
      this.snapshots.set(snapshot.snapshot, snapshot);
      this.snapshotRevisions.set(snapshot.snapshot, state.revision);
    }
    return true;
  }
  async markMaterialized(snapshot: string, position: number) {
    if (this.state.snapshot !== snapshot || this.state.position !== position)
      return false;
    this.state = {
      ...this.state,
      revision: this.state.revision + 1,
      materialized_snapshot: snapshot,
      materialized_position: position,
    };
    return true;
  }
}
