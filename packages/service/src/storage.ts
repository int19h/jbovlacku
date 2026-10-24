import type { StoredVerifiedRecord } from "./verified-records.ts";
import type { Header } from "../../core/src/index.ts";
export interface ObjectStore {
  get(hash: string): Promise<Uint8Array | null>;
  put(hash: string, bytes: Uint8Array): Promise<void>;
}
export interface StoredEvent {
  envelope_hash: string;
  body_hash: string | null;
  header: Header;
  signature: number[];
  position: number;
}
export interface State {
  revision: number;
  position: number;
  snapshot: string | null;
  events: Record<string, StoredEvent>;
  selections: string[];
  snapshots: string[];
  journal: { position: number; id: string }[];
  materialized_position: number;
  materialized_snapshot: string | null;
}
export type StateMetadata = Pick<
  State,
  | "revision"
  | "position"
  | "snapshot"
  | "materialized_position"
  | "materialized_snapshot"
>;
export const emptyState = (): State => ({
  revision: 0,
  position: 0,
  snapshot: null,
  events: {},
  selections: [],
  snapshots: [],
  journal: [],
  materialized_position: 0,
  materialized_snapshot: null,
});
export interface Coordinator {
  getVerifiedRecord?(
    binding: Omit<StoredVerifiedRecord, "compact">,
  ): Promise<StoredVerifiedRecord | null>;
  saveVerifiedRecords?(records: StoredVerifiedRecord[]): Promise<void>;
  load(): Promise<State>;
  loadMetadata?(): Promise<StateMetadata>;
  markMaterialized?(snapshot: string, position: number): Promise<boolean>;
  getSnapshot(id: string): Promise<Snapshot | null>;
  /** The host retains at most one private checkpoint base outside public expiry. */
  getCheckpointSnapshot?(id: string): Promise<Snapshot | null>;
  compareAndSwap(
    revision: number,
    state: State,
    snapshot?: Snapshot,
    changedIds?: string[],
    verifiedRecords?: StoredVerifiedRecord[],
  ): Promise<boolean>;
}
export interface Snapshot {
  snapshot: string;
  logical_inventory: string;
  manifest: FormatManifest;
  events: Record<string, Omit<StoredEvent, "position">>;
  bodies: string[];
  import_selections: string[];
}
export interface FormatManifest {
  version: 1;
  events: { count: number; hash: string };
  bodies: { count: number; hash: string };
  import_selections: { count: number; hash: string };
}
