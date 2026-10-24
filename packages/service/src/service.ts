import {
  readVerifiedRecord,
  streamVerifiedRecords,
  prepareVerifiedRecords,
  retainVerifiedRecords,
  projectVerifiedRecord,
  verifiedRecordKey,
  compactRecord,
  type StoredVerifiedRecord,
} from "./verified-records.ts";
import type { IndexStore } from "./index-store.ts";
import type { EvaluationRuntime, EvaluationSession } from "./evaluation.ts";
import {
  AssistanceService,
  AssistanceError,
  type AssistanceOptions,
  type ContextDefinition,
} from "./assistance.ts";
import {
  checkpointBindingKey,
  type CheckpointBinding,
  type CheckpointStore,
  type ServiceCheckpoint,
} from "./checkpoint.ts";
import {
  buildPackages,
  rebasePackages,
  type MaterializedPackages,
  type PackageRecord,
} from "./packages.ts";
import {
  canonicalize,
  contentHash,
  prepareAdmission,
  prepareSelection,
  createEvaluationSession,
  restoreHostEvaluationSession,
  utf8,
  inspectHostStoredBody,
  type Evaluation,
  type EvaluationRequest,
} from "../../core/src/index.ts";
import {
  type ObjectStore,
  type Coordinator,
  type State,
  type Snapshot,
  type StateMetadata,
  type StoredEvent,
} from "./storage.ts";
const zeroView = `jve1:${"0".repeat(64)}`;
const idPattern = /^(sha256:|jve1:|jvw1:|ed25519:)[a-f0-9]{64}$/;
/** Admission requires canonical base64 of the full SSHSIG blob. Private fields reproduce its exact envelope. */
export function canonicalStoredEnvelope(
  id: string,
  event: Pick<StoredEvent, "header" | "signature">,
): string {
  return canonicalize(
    utf8(
      JSON.stringify({
        id,
        header: event.header,
        signature: btoa(String.fromCharCode(...event.signature)),
      }),
    ),
  );
}
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public event: string | null = null,
    public field: string | null = null,
  ) {
    super(message);
  }
}
const json = (
  value: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
const sorted = (values: string[]) => [...values].sort();
const compareBytes = (a: number[], b: number[]): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
};
export interface ServiceOptions {
  assistance?: AssistanceOptions;
  serverId: string;
  selectedView?: string;
  stateLimits?: EvaluationRequest["limits"];
  policyUrl: string;
  publicOrigin?: string;
  corsOrigins?: string[];
  index?: IndexStore;
  asyncMaterialization?: boolean;
  evaluationRuntime?: EvaluationRuntime;
  checkpoints?: CheckpointStore;
  /** Minimum time between cache captures. The default is 60,000 ms. */
  checkpointIntervalMs?: number;
  coreVersion?: string;
  reportError?: (error: unknown) => void;
  allowPrototypeBatch?: boolean;
  beforeCommit?: (state: State) => Promise<void>;
  /**
   * Lower response bounds, for tests of the cut states. A value above the
   * documented bound is ignored, so the contract never widens.
   */
  limits?: { reviewers?: number; profileClaims?: number; recordBytes?: number };
}
/** Reviewer details listed per score when a word request asks for them. */
const REVIEWER_LIMIT = 64;
/** Concurrent profile claims listed in an identity response. */
const PROFILE_CLAIM_LIMIT = 16;
/** Total encoded bytes of profile claim bodies in one identity response. */
const PROFILE_CLAIM_BYTES = 1048576;

/** Records transport page bounds. */
const RECORD_PAGE_LIMIT = 200;
const RECORD_PAGE_BYTES = 4194304;
export class DictionaryService {
  private assistance: AssistanceService;
  constructor(
    public objects: ObjectStore,
    public coordinator: Coordinator,
    public options: ServiceOptions,
  ) {
    this.assistance = new AssistanceService(
      options.assistance ?? {},
      options.serverId,
      async (events) => {
        const state = await coordinator.load();
        const definitions: ContextDefinition[] = [];
        for (const event of events) {
          const retained = state.events[event];
          if (!retained?.body_hash)
            throw new AssistanceError(
              404,
              "context",
              "A selected definition is unavailable.",
            );
          const [envelope, bytes] = await Promise.all([
            objects.get(retained.envelope_hash),
            objects.get(retained.body_hash),
          ]);
          if (!envelope || !bytes)
            throw new AssistanceError(
              404,
              "context",
              "A selected definition is unavailable.",
            );
          const header = JSON.parse(new TextDecoder().decode(envelope)).header;
          if (header.action.kind !== "definition.publish")
            throw new AssistanceError(
              400,
              "context",
              "Context must name definition events.",
            );
          if (inspectHostStoredBody(header, bytes).availability !== "valid")
            throw new AssistanceError(
              404,
              "context",
              "A selected definition does not have a valid available body.",
            );
          definitions.push({
            event,
            body: JSON.parse(new TextDecoder().decode(bytes)),
          });
        }
        return definitions;
      },
    );
  }
  private canonicalEnvelopes = new Map<string, string>();
  private importSelections = new Map<string, string[]>();
  private sessionSnapshots = new Map<string, Snapshot>();
  private packageBases = new Map<
    string,
    { snapshot: string; changed: PackageRecord[] }
  >();
  private completed?: { snapshot: Snapshot; position: number };
  private snapshotPositions = new Map<string, number>();
  private snapshotDeltas = new Map<
    string,
    { base: string | null; changed: string[] }
  >();
  private initialized?: Promise<void>;
  private pendingMaterialization?: Snapshot;
  private background?: Promise<void>;
  private backgroundError?: unknown;
  private evaluationStopping = false;
  private evaluationShutdown?: Promise<void>;
  private pendingCheckpoint?: {
    snapshot: Snapshot;
    position: number;
    packages: MaterializedPackages;
    exportAttempts?: number;
  };
  private checkpointJob?: Promise<void>;
  private checkpointTimer?: ReturnType<typeof setTimeout>;
  private checkpointDue = 0;
  private checkpointLastCapture = -Infinity;
  private checkpointFlushers = 0;
  private publication: Promise<void> = Promise.resolve();
  private metadata(): Promise<StateMetadata> {
    return this.coordinator.loadMetadata?.() ?? this.coordinator.load();
  }
  private rememberDelta(
    snapshot: string,
    base: string | null,
    changed: string[],
  ) {
    this.snapshotDeltas.set(snapshot, { base, changed });
    while (this.snapshotDeltas.size > 4)
      this.snapshotDeltas.delete(this.snapshotDeltas.keys().next().value!);
  }
  private binding(snapshot: Snapshot, position: number): CheckpointBinding {
    return {
      schema: 1,
      snapshot: snapshot.snapshot,
      logical_inventory: snapshot.logical_inventory,
      position,
      view: this.options.selectedView ?? zeroView,
      core_version: this.options.coreVersion ?? "",
      limits: this.options.stateLimits
        ? {
            events: this.options.stateLimits.events,
            traversal: this.options.stateLimits.traversal,
            claim_depth: this.options.stateLimits.claim_depth,
          }
        : null,
    };
  }
  initialize(): Promise<void> {
    return (this.initialized ??= this.initializeCheckpoint());
  }
  private async initializeCheckpoint() {
    const metadata = await this.metadata();
    const id = metadata.materialized_snapshot ?? metadata.snapshot;
    if (id && this.options.checkpoints && this.options.coreVersion) {
      const currentBase = await this.coordinator.getSnapshot(id);
      let candidate = currentBase
        ? {
            snapshot: currentBase,
            binding: this.binding(
              currentBase,
              metadata.materialized_snapshot
                ? metadata.materialized_position
                : metadata.position,
            ),
            publiclyRetained: true,
          }
        : undefined;
      try {
        const pinned = await this.options.checkpoints.latestBinding?.();
        if (
          pinned &&
          pinned.schema === 1 &&
          pinned.position <= metadata.position &&
          pinned.view === (this.options.selectedView ?? zeroView) &&
          pinned.core_version === this.options.coreVersion &&
          checkpointBindingKey(pinned) ===
            checkpointBindingKey({
              ...pinned,
              limits: this.options.stateLimits ?? null,
            })
        ) {
          const publicSnapshot = await this.coordinator.getSnapshot(
            pinned.snapshot,
          );
          const base =
            publicSnapshot ??
            (await this.coordinator.getCheckpointSnapshot?.(pinned.snapshot));
          if (
            base &&
            base.snapshot === pinned.snapshot &&
            base.logical_inventory === pinned.logical_inventory
          ) {
            const current = (await this.current()).snapshot;
            const bodies = new Set(current.bodies);
            const selections = new Set(current.import_selections);
            if (
              Object.keys(base.events).every(
                (event) => current.events[event] !== undefined,
              ) &&
              base.bodies.every((body) => bodies.has(body)) &&
              base.import_selections.every((selection) =>
                selections.has(selection),
              )
            )
              candidate = {
                snapshot: base,
                binding: pinned,
                publiclyRetained: publicSnapshot !== null,
              };
          }
        }
      } catch (error) {
        this.options.reportError?.(error);
      }
      if (candidate) {
        const { snapshot, binding, publiclyRetained } = candidate;
        const recoveredId = snapshot.snapshot;
        let recovered:
          | {
              session: EvaluationSession;
              payload: ServiceCheckpoint;
            }
          | undefined;
        try {
          const payload = await this.options.checkpoints.load(binding);
          if (payload) {
            if (
              !(payload.core instanceof Uint8Array) ||
              !Array.isArray(payload.packages?.entries)
            )
              throw new Error("The checkpoint payload is invalid.");
            for (const packages of [
              payload.packages.packages,
              payload.packages.packages2,
            ])
              if (
                !packages ||
                Object.values(packages).some(
                  (pkg) => pkg.manifest.snapshot !== recoveredId,
                )
              )
                throw new Error(
                  "The checkpoint packages name another snapshot.",
                );
            const records: string[] = [];
            const packageRecords: PackageRecord[] = [];
            for await (const {
              value: id,
              result: record,
            } of streamVerifiedRecords(
              this.coordinator,
              this.objects,
              snapshot.events,
              Object.keys(snapshot.events).sort(),
            )) {
              this.canonicalEnvelopes.set(
                snapshot.events[id].envelope_hash,
                canonicalStoredEnvelope(id, snapshot.events[id]),
              );
              records.push(record.compact);
              const content = compactRecord(record).package;
              if (content)
                packageRecords.push({
                  ...content,
                  envelope_hash: snapshot.events[id].envelope_hash,
                  missing: false,
                });
            }
            const session = await (this.options.evaluationRuntime
              ? this.options.evaluationRuntime.restore(
                  payload.core,
                  JSON.stringify(binding),
                  records,
                )
              : restoreHostEvaluationSession(
                  payload.core,
                  JSON.stringify(binding),
                  records,
                ));
            this.packageRecords.set(recoveredId, packageRecords);
            recovered = { session, payload };
          }
        } catch (error) {
          this.options.reportError?.(error);
        }
        if (recovered) {
          const { session, payload } = recovered;
          const restoresMaterialized =
            publiclyRetained &&
            recoveredId === metadata.materialized_snapshot &&
            binding.position === metadata.materialized_position;
          try {
            if (restoresMaterialized) {
              await this.options.index?.restore?.(
                recoveredId,
                payload.packages.entries,
              );
              await this.options.index?.publish?.(recoveredId, [recoveredId]);
            }
          } catch (error) {
            session.free();
            throw error;
          }
          const key = recoveredId + "|" + binding.view;
          this.sessions.set(key, session);
          this.sessionSnapshots.set(key, snapshot);
          this.evaluationCache.set(key, Promise.resolve(session.state));
          this.packageCache.set(recoveredId, Promise.resolve(payload.packages));
          if (restoresMaterialized)
            this.completed = { snapshot, position: binding.position };
          this.snapshotPositions.set(recoveredId, binding.position);
        }
      }
    }
    if (
      this.options.asyncMaterialization &&
      metadata.snapshot &&
      this.completed?.snapshot.snapshot !== metadata.snapshot
    )
      this.queueMaterialization((await this.current()).snapshot);
  }
  private queueMaterialization(snapshot: Snapshot) {
    if (this.evaluationStopping) return;
    this.pendingMaterialization = snapshot;
    if (this.background) return;
    this.background = (async () => {
      while (this.pendingMaterialization && !this.evaluationStopping) {
        this.pendingMaterialization = undefined;
        try {
          const target = (await this.current()).snapshot;
          await this.packages(target);
          this.backgroundError = undefined;
          const metadata = await this.metadata();
          if (
            metadata.snapshot &&
            this.completed?.snapshot.snapshot !== metadata.snapshot
          )
            this.pendingMaterialization = (await this.current()).snapshot;
        } catch (error) {
          this.backgroundError = error;
          this.options.reportError?.(error);
        }
      }
    })().finally(() => {
      this.background = undefined;
      if (this.pendingMaterialization && !this.evaluationStopping)
        this.queueMaterialization(this.pendingMaterialization);
    });
  }
  async flushMaterialization(): Promise<void> {
    await this.initialize();
    this.checkpointFlushers++;
    try {
      await this.flushCheckpoints();
      while (this.background) await this.background;
      await this.flushCheckpoints();
    } finally {
      this.checkpointFlushers--;
    }
    if (this.backgroundError) throw this.backgroundError;
  }
  /** Save the last completed state before the host stops its workers. */
  prepareEvaluationShutdown(): Promise<void> {
    this.evaluationStopping = true;
    return (this.evaluationShutdown ??= (async () => {
      await this.initialize();
      await this.publication;
      this.checkpointFlushers++;
      try {
        await this.flushCheckpoints();
      } finally {
        this.checkpointFlushers--;
      }
    })());
  }
  private async flushCheckpoints() {
    if (this.checkpointTimer !== undefined) clearTimeout(this.checkpointTimer);
    this.checkpointTimer = undefined;
    while (this.checkpointJob || this.pendingCheckpoint) {
      if (!this.checkpointJob) this.drainCheckpoints();
      await this.checkpointJob;
    }
  }
  private saveCheckpoint(
    snapshot: Snapshot,
    position: number,
    packages: MaterializedPackages,
  ) {
    const session = this.sessions.get(
      snapshot.snapshot + "|" + (this.options.selectedView ?? zeroView),
    );
    if (!session || !this.options.checkpoints || !this.options.coreVersion)
      return;
    this.pendingCheckpoint = { snapshot, position, packages };
    this.scheduleCheckpoint(true);
  }
  private scheduleCheckpoint(reset = false) {
    if (!this.pendingCheckpoint) return;
    if (reset) this.checkpointDue = performance.now() + 100;
    const interval = this.options.checkpointIntervalMs ?? 60000;
    this.checkpointDue = Math.max(
      this.checkpointDue,
      this.checkpointLastCapture +
        (Number.isFinite(interval) ? Math.max(0, interval) : 60000),
    );
    if (this.checkpointTimer !== undefined) clearTimeout(this.checkpointTimer);
    this.checkpointTimer = undefined;
    if (this.checkpointJob) return;
    if (this.checkpointFlushers) {
      this.drainCheckpoints();
      return;
    }
    this.checkpointTimer = setTimeout(
      () => {
        this.checkpointTimer = undefined;
        this.drainCheckpoints();
      },
      Math.max(0, this.checkpointDue - performance.now()),
    );
    (this.checkpointTimer as unknown as { unref?: () => void }).unref?.();
  }
  private drainCheckpoints() {
    if (this.checkpointJob) return;
    this.checkpointJob = (async () => {
      while (this.pendingCheckpoint) {
        if (!this.checkpointFlushers && performance.now() < this.checkpointDue)
          break;
        const checkpoint = this.pendingCheckpoint;
        this.pendingCheckpoint = undefined;
        const session = this.sessions.get(
          checkpoint.snapshot.snapshot +
            "|" +
            (this.options.selectedView ?? zeroView),
        );
        if (!session) continue;
        const binding = this.binding(checkpoint.snapshot, checkpoint.position);
        // A failed export or save consumes the interval too.
        this.checkpointLastCapture = performance.now();
        try {
          const core = await this.useSession(
            checkpoint.snapshot.snapshot +
              "|" +
              (this.options.selectedView ?? zeroView),
            async () => {
              let core: Uint8Array;
              try {
                core = await session.checkpoint(JSON.stringify(binding), true);
              } catch (error) {
                // Retry a failed live export once, including during shutdown.
                if (
                  !this.pendingCheckpoint &&
                  session.isAvailable?.() !== false &&
                  (checkpoint.exportAttempts ?? 0) < 1
                )
                  this.pendingCheckpoint = {
                    ...checkpoint,
                    exportAttempts: (checkpoint.exportAttempts ?? 0) + 1,
                  };
                throw error;
              }
              return core;
            },
          );
          await this.options.checkpoints!.save(binding, {
            core,
            packages: checkpoint.packages,
          });
        } catch (error) {
          this.options.reportError?.(error);
        }
      }
    })().finally(() => {
      this.checkpointJob = undefined;
      if (this.pendingCheckpoint) this.scheduleCheckpoint();
    });
  }
  private async interpretedSnapshot(value: string | null): Promise<Snapshot> {
    if (!this.options.asyncMaterialization || value !== null)
      return this.snapshot(value);
    await this.initialize();
    if (this.backgroundError && !this.background)
      this.queueMaterialization((await this.current()).snapshot);
    if (this.completed) return this.completed.snapshot;
    const { snapshot } = await this.current();
    await this.packages(snapshot);
    return snapshot;
  }
  private hashJson(value: unknown) {
    return contentHash(utf8(canonicalize(utf8(JSON.stringify(value)))));
  }
  private cursor(position: number) {
    return `${this.options.serverId}.${position}`;
  }
  private cursorPosition(value: string | null, state: State): number {
    if (value === null) return 0;
    const prefix = `${this.options.serverId}.`;
    if (!value.startsWith(prefix) || !/^\d+$/.test(value.slice(prefix.length)))
      throw new ApiError(
        400,
        "bad_cursor",
        "Cursor does not belong to this server.",
      );
    const n = Number(value.slice(prefix.length));
    if (
      !Number.isSafeInteger(n) ||
      n > state.position ||
      this.cursor(n) !== value
    )
      throw new ApiError(400, "bad_cursor", "Cursor is invalid.");
    return n;
  }
  private async buildSnapshot(state: State): Promise<Snapshot> {
    const ids = sorted(Object.keys(state.events));
    let lines = "";
    for (const id of ids) {
      const hash = state.events[id].envelope_hash;
      const envelope =
        this.canonicalEnvelopes.get(hash) ??
        canonicalStoredEnvelope(id, state.events[id]);
      this.canonicalEnvelopes.set(hash, envelope);
      lines += envelope + "\n";
    }
    const bodies = sorted([
      ...new Set(
        ids
          .map((id) => state.events[id].body_hash)
          .filter((h): h is string => h !== null),
      ),
    ]);
    const selections = sorted(state.selections);
    const manifest = {
      version: 1 as const,
      events: { count: ids.length, hash: contentHash(utf8(lines)) },
      bodies: { count: bodies.length, hash: this.hashJson(bodies) },
      import_selections: {
        count: selections.length,
        hash: this.hashJson(selections),
      },
    };
    const snapshot = this.hashJson(manifest);
    const value: Snapshot = {
      snapshot,
      logical_inventory: this.hashJson({
        events: ids,
        bodies,
        import_selections: selections,
      }),
      manifest,
      events: Object.fromEntries(
        ids.map((id) => {
          const { position, ...representation } = state.events[id];
          return [id, representation];
        }),
      ),
      bodies,
      import_selections: selections,
    };
    return value;
  }
  private packageCache = new Map<string, Promise<MaterializedPackages>>();
  private inFlightPackages = new Set<string>();
  private requiredIndexSnapshots(...snapshots: (string | null | undefined)[]) {
    return [
      ...new Set(
        [
          ...this.inFlightPackages,
          this.completed?.snapshot.snapshot,
          ...snapshots,
        ].filter((snapshot): snapshot is string => snapshot != null),
      ),
    ];
  }
  private packageRecords = new Map<string, PackageRecord[]>();
  private prunePackageRecords() {
    const retained = new Set([
      ...this.packageCache.keys(),
      ...this.inFlightPackages,
      ...[...this.sessions.keys()].map((key) => key.split("|")[0]),
    ]);
    for (const snapshot of this.packageRecords.keys())
      if (!retained.has(snapshot)) {
        this.packageRecords.delete(snapshot);
        this.packageBases.delete(snapshot);
      }
  }
  private packages(snapshot: Snapshot): Promise<MaterializedPackages> {
    const cached = this.packageCache.get(snapshot.snapshot);
    if (cached) return cached;
    if (this.inFlightPackages.size >= 2)
      return Promise.reject(
        new ApiError(
          503,
          "resource_unavailable",
          "Two snapshot package builds are already in progress.",
        ),
      );
    if (this.packageCache.size >= 2) {
      const evicted = [...this.packageCache.keys()].find(
        (key) =>
          !this.inFlightPackages.has(key) &&
          key !== this.completed?.snapshot.snapshot,
      );
      if (evicted === undefined)
        return Promise.reject(
          new ApiError(
            503,
            "resource_unavailable",
            "Materialized packages occupy the available cache slots.",
          ),
        );
      this.packageCache.delete(evicted);
      this.prunePackageRecords();
    }
    this.inFlightPackages.add(snapshot.snapshot);
    const key =
      snapshot.snapshot + "|" + (this.options.selectedView ?? zeroView);
    if (this.retiredSessions.has(key) && !this.sessions.has(key)) {
      this.retiredSessions.delete(key);
      this.evaluationCache.delete(key);
    }
    let previous: MaterializedPackages | undefined;
    const pending = this.evaluation(snapshot)
      .then(async () => {
        const base = this.packageBases.get(snapshot.snapshot);
        previous = base
          ? await this.packageCache.get(base.snapshot)
          : undefined;
        if (previous && base && !base.changed.length)
          return rebasePackages(previous, snapshot.snapshot, this.objects);
        return buildPackages(
          snapshot,
          this.objects,
          this.packageRecords.get(snapshot.snapshot),
          previous && base ? { previous, changed: base.changed } : undefined,
          true,
        );
      })
      .then(async (built) => {
        const publish = this.publication.then(async () => {
          if (this.evaluationStopping) return;
          const startingMetadata = await this.metadata();
          if (startingMetadata.snapshot !== snapshot.snapshot) return;
          let completed = false;
          try {
            if (this.options.index) {
              const base = this.packageBases.get(snapshot.snapshot);
              let reused = false;
              if (
                previous?.entries === built.entries &&
                base &&
                this.options.index.reuse
              )
                reused =
                  (await this.options.index.reuse(
                    base.snapshot,
                    snapshot.snapshot,
                  )) !== false;
              if (!reused)
                await this.options.index.replace(
                  snapshot.snapshot,
                  built.entries,
                );
              await this.options.index.publish?.(
                snapshot.snapshot,
                this.requiredIndexSnapshots(
                  startingMetadata.materialized_snapshot,
                ),
              );
            }
            for (let attempt = 0; attempt < 20; attempt++) {
              const metadata = await this.metadata();
              if (metadata.snapshot !== snapshot.snapshot) break;
              let published =
                metadata.materialized_snapshot === snapshot.snapshot;
              if (!published && this.coordinator.markMaterialized)
                published = await this.coordinator.markMaterialized(
                  snapshot.snapshot,
                  metadata.position,
                );
              else if (!published) {
                const state = await this.coordinator.load();
                if (state.snapshot !== snapshot.snapshot) break;
                const next = {
                  ...state,
                  revision: state.revision + 1,
                  materialized_position: state.position,
                  materialized_snapshot: snapshot.snapshot,
                };
                published = await this.coordinator.compareAndSwap(
                  state.revision,
                  next,
                  undefined,
                  [],
                );
              }
              if (published) {
                this.completed = { snapshot, position: metadata.position };
                this.snapshotPositions.set(
                  snapshot.snapshot,
                  metadata.position,
                );
                completed = true;
                try {
                  this.saveCheckpoint(snapshot, metadata.position, built);
                } catch (error) {
                  this.options.reportError?.(error);
                }
                this.retireSupersededSessions();
                break;
              }
            }
            if (
              !completed &&
              (await this.metadata()).snapshot === snapshot.snapshot
            )
              throw new ApiError(
                503,
                "busy",
                "Materialization publication is busy.",
              );
          } finally {
            const previousSnapshot =
              this.completed?.snapshot.snapshot ??
              startingMetadata.materialized_snapshot;
            if (!completed && previousSnapshot && this.options.index) {
              if (this.options.index.publish)
                await this.options.index.publish(
                  previousSnapshot,
                  this.requiredIndexSnapshots(
                    startingMetadata.materialized_snapshot,
                  ),
                );
              else {
                const old = await this.packageCache.get(previousSnapshot);
                if (old)
                  await this.options.index.replace(
                    previousSnapshot,
                    old.entries,
                  );
              }
            }
          }
        });
        this.publication = publish.catch(() => {});
        await publish;
        return built;
      });
    this.packageCache.set(snapshot.snapshot, pending);
    pending.then(
      () => {
        this.inFlightPackages.delete(snapshot.snapshot);
        this.retireSupersededSessions();
      },
      () => {
        this.inFlightPackages.delete(snapshot.snapshot);
        if (this.packageCache.get(snapshot.snapshot) === pending)
          this.packageCache.delete(snapshot.snapshot);
        this.prunePackageRecords();
      },
    );
    return pending;
  }
  private language(value: string | null): string {
    if (
      value === null ||
      value.length > 63 ||
      !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)
    )
      throw new ApiError(400, "language", "Definition language is invalid.");
    return value;
  }
  private async current(): Promise<{
    state: StateMetadata;
    snapshot: Snapshot;
  }> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const metadata = await this.metadata();
      if (metadata.snapshot) {
        const cached = await this.coordinator.getSnapshot(metadata.snapshot);
        if (cached) {
          this.snapshotPositions.set(cached.snapshot, metadata.position);
          return { state: metadata, snapshot: cached };
        }
        // Another writer may expire the pointer between these two reads.
        if ((await this.metadata()).revision !== metadata.revision) continue;
      }
      const state = await this.coordinator.load();
      const snapshot = await this.buildSnapshot(state);
      if (state.snapshot && state.snapshot !== snapshot.snapshot)
        throw new ApiError(
          503,
          "storage_unavailable",
          "Stored inventory does not match the current snapshot pointer.",
        );
      const next = {
        ...state,
        revision: state.revision + 1,
        snapshot: snapshot.snapshot,
        snapshots: sorted([...state.snapshots, snapshot.snapshot]),
      };
      if (
        await this.coordinator.compareAndSwap(
          state.revision,
          next,
          snapshot,
          state.snapshot === null ? undefined : [],
        )
      )
        return { state: next, snapshot };
    }
    throw new ApiError(503, "busy", "Snapshot publication is busy.");
  }
  private async snapshot(value: string | null): Promise<Snapshot> {
    if (value === null) return (await this.current()).snapshot;
    this.identifier(value, "sha256:");
    let cached = await this.coordinator.getSnapshot(value);
    if (!cached && (await this.metadata()).snapshot === value)
      cached = (await this.current()).snapshot;
    if (!cached || cached.snapshot !== value)
      throw new ApiError(
        410,
        "snapshot_expired",
        "Snapshot is not published or retained.",
      );
    return cached;
  }
  private identifier(value: string, prefix: string) {
    if (!value.startsWith(prefix) || !idPattern.test(value))
      throw new ApiError(400, "identifier", "Identifier is invalid.");
  }
  private async requireView(snapshot: Snapshot, view: string): Promise<void> {
    const event = snapshot.events[view];
    if (!event || event.header.action.kind !== "view.publish")
      throw new ApiError(
        404,
        "view_unavailable",
        "Requested view is not retained in this snapshot.",
        view,
      );
    if (event.body_hash === null)
      throw new ApiError(
        422,
        "view_unavailable",
        "Requested view body is unavailable.",
        view,
      );
    const record = compactRecord(
      await readVerifiedRecord(this.coordinator, this.objects, view, event),
    );
    if (!record.action_valid || record.body_status !== "present")
      throw new ApiError(
        422,
        "view_unavailable",
        "Requested view does not satisfy version 1 rules.",
        view,
      );
  }

  private evaluationCache = new Map<string, Promise<Evaluation>>();
  private inFlightEvaluations = new Set<string>();
  private sessionUses = new Map<string, number>();
  private sessions = new Map<string, EvaluationSession>();
  private retiredSessions = new Set<string>();
  private sessionRepairs = new Map<string, Promise<void>>();
  private retireSupersededSessions() {
    if (!this.options.evaluationRuntime || !this.completed) return;
    const configured = this.options.selectedView ?? zeroView;
    const current = this.completed.snapshot.snapshot + "|" + configured;
    this.retiredSessions.delete(current);
    for (const key of this.sessions.keys())
      if (
        key !== current &&
        key.endsWith("|" + configured) &&
        !this.inFlightEvaluations.has(key) &&
        !this.inFlightPackages.has(key.split("|")[0])
      )
        this.retiredSessions.add(key);
    this.releaseRetiredSessions();
  }
  private releaseRetiredSessions() {
    this.retiredSessions.delete(
      this.completed?.snapshot.snapshot +
        "|" +
        (this.options.selectedView ?? zeroView),
    );
    for (const key of this.retiredSessions) {
      const snapshot = key.split("|")[0];
      if (
        this.sessionUses.has(key) ||
        this.inFlightEvaluations.has(key) ||
        this.inFlightPackages.has(snapshot)
      )
        continue;
      this.sessions.get(key)?.free();
      this.sessions.delete(key);
      this.sessionSnapshots.delete(key);
      // Keep completed results until ordinary cache eviction needs their slot.
      if (!this.evaluationCache.has(key)) this.retiredSessions.delete(key);
    }
    this.prunePackageRecords();
  }
  private repairSession(snapshot: Snapshot, view: string) {
    const key = snapshot.snapshot + "|" + view;
    if (
      this.evaluationStopping ||
      this.sessionRepairs.has(key) ||
      this.inFlightEvaluations.has(key) ||
      this.inFlightEvaluations.size >= 2
    )
      return;
    this.sessions.get(key)?.free();
    this.sessions.delete(key);
    this.sessionSnapshots.delete(key);
    const retained = this.evaluationCache.get(key);
    this.inFlightEvaluations.add(key);
    const owns = () =>
      !this.evaluationStopping && this.evaluationCache.get(key) === retained;
    const repair = (async () => {
      if (
        this.options.checkpoints &&
        this.options.coreVersion &&
        view === (this.options.selectedView ?? zeroView)
      ) {
        const position = this.snapshotPositions.get(snapshot.snapshot);
        if (position !== undefined) {
          const binding = this.binding(snapshot, position);
          try {
            const payload = await this.options.checkpoints.load(binding);
            if (payload) {
              const records: string[] = [];
              for await (const { result: record } of streamVerifiedRecords(
                this.coordinator,
                this.objects,
                snapshot.events,
                Object.keys(snapshot.events).sort(),
              ))
                records.push(record.compact);
              const session = await (this.options.evaluationRuntime
                ? this.options.evaluationRuntime.restore(
                    payload.core,
                    JSON.stringify(binding),
                    records,
                  )
                : restoreHostEvaluationSession(
                    payload.core,
                    JSON.stringify(binding),
                    records,
                  ));
              if (owns()) {
                this.sessions.set(key, session);
                this.sessionSnapshots.set(key, snapshot);
                this.evaluationCache.set(key, Promise.resolve(session.state));
              } else session.free();
              return;
            }
          } catch (error) {
            this.options.reportError?.(error);
          }
        }
      }
      const state = await this.computeEvaluation(snapshot, view, owns);
      if (owns()) this.evaluationCache.set(key, Promise.resolve(state));
    })()
      .catch((error) => {
        this.options.reportError?.(error);
      })
      .finally(() => {
        this.inFlightEvaluations.delete(key);
        this.sessionRepairs.delete(key);
        this.retireSupersededSessions();
      });
    this.sessionRepairs.set(key, repair);
  }
  private async useSession<T>(
    key: string,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    this.sessionUses.set(key, (this.sessionUses.get(key) ?? 0) + 1);
    try {
      return await operation();
    } finally {
      const remaining = this.sessionUses.get(key)! - 1;
      if (remaining) this.sessionUses.set(key, remaining);
      else this.sessionUses.delete(key);
      this.releaseRetiredSessions();
    }
  }
  private evaluation(
    snapshot: Snapshot,
    view = this.options.selectedView ?? zeroView,
  ): Promise<Evaluation> {
    const key = snapshot.snapshot + "|" + view;
    const cached = this.evaluationCache.get(key);
    if (cached) {
      if (
        this.retiredSessions.has(key) ||
        (this.sessions.has(key) &&
          this.sessions.get(key)!.isAvailable?.() !== false) ||
        this.inFlightEvaluations.has(key)
      )
        return cached;
      // Completed state remains valid when its ranking runtime stops.
      this.repairSession(snapshot, view);
      return cached;
    }
    if (this.inFlightEvaluations.size >= 2)
      return Promise.reject(
        new ApiError(
          503,
          "resource_unavailable",
          "Two snapshot evaluations are already in progress.",
        ),
      );
    if (this.evaluationCache.size >= 2) {
      const configured = this.options.selectedView ?? zeroView;
      const protectedKey = [...this.evaluationCache.keys()]
        .filter((candidate) => candidate.endsWith("|" + configured))
        .at(-1);
      const evicted = [...this.evaluationCache.keys()].find(
        (candidate) =>
          !this.inFlightEvaluations.has(candidate) &&
          !this.sessionUses.has(candidate) &&
          !this.inFlightPackages.has(candidate.split("|")[0]) &&
          candidate !== this.completed?.snapshot.snapshot + "|" + configured &&
          (view === configured || candidate !== protectedKey),
      );
      if (evicted === undefined)
        return Promise.reject(
          new ApiError(
            503,
            "resource_unavailable",
            "Configured view evaluations occupy the available cache slots.",
          ),
        );
      this.evaluationCache.delete(evicted);
      this.retiredSessions.delete(evicted);
      this.sessions.get(evicted)?.free();
      this.sessions.delete(evicted);
      this.sessionSnapshots.delete(evicted);
      this.prunePackageRecords();
    }
    this.inFlightEvaluations.add(key);
    let result: Promise<Evaluation>;
    result = this.computeEvaluation(
      snapshot,
      view,
      () =>
        !this.evaluationStopping && this.evaluationCache.get(key) === result,
    );
    this.evaluationCache.set(key, result);
    result.then(
      () => {
        this.inFlightEvaluations.delete(key);
      },
      () => {
        this.inFlightEvaluations.delete(key);
        if (this.evaluationCache.get(key) === result) {
          this.evaluationCache.delete(key);
          this.retiredSessions.delete(key);
        }
      },
    );
    return result;
  }
  private async computeEvaluation(
    snapshot: Snapshot,
    view = this.options.selectedView ?? zeroView,
    ownsEntry: () => boolean = () => true,
  ): Promise<Evaluation> {
    const selections: Record<string, string[]> = {};
    for (const hash of snapshot.import_selections) {
      const cached = this.importSelections.get(hash);
      if (cached) {
        selections[hash] = cached;
        continue;
      }
      const raw = await this.objects.get(hash);
      if (raw) {
        selections[hash] = prepareSelection(raw).ids;
        this.importSelections.set(hash, selections[hash]);
      }
    }
    const options = {
      selected_view: view,
      import_selections: selections,
      limits: this.options.stateLimits,
    };
    const baseEntry = [...this.sessions.entries()]
      .reverse()
      .find(
        ([key, session]) =>
          this.sessionSnapshots.has(key) && session.isAvailable?.() !== false,
      );
    const baseSnapshot = baseEntry
      ? this.sessionSnapshots.get(baseEntry[0])
      : undefined;
    // Keep the immutable array if the source cache is pruned during the fork.
    const baseRecords =
      (baseSnapshot
        ? this.packageRecords.get(baseSnapshot.snapshot)
        : undefined) ?? [];
    const builder = await (baseEntry
      ? this.useSession(baseEntry[0], () => baseEntry[1].fork(options))
      : this.options.evaluationRuntime
        ? this.options.evaluationRuntime.create(options)
        : createEvaluationSession(options));
    try {
      let packageRecords: Map<string, PackageRecord> | undefined;
      const mutableRecords = () => {
        if (!packageRecords) {
          packageRecords = new Map();
          for (const record of baseRecords)
            packageRecords.set(record.id, record);
        }
        return packageRecords;
      };
      const changedPackages: PackageRecord[] = [];
      const hint = this.snapshotDeltas.get(snapshot.snapshot);
      const exactHint = baseSnapshot && hint?.base === baseSnapshot.snapshot;
      if (baseSnapshot && !exactHint)
        for (const id of Object.keys(baseSnapshot.events))
          if (!snapshot.events[id]) {
            await builder.removeRecord(id);
            if (
              ["definition.publish", "rafsi.publish"].includes(
                String(baseSnapshot.events[id].header.action.kind),
              )
            ) {
              const records = mutableRecords();
              const old = records.get(id);
              if (old) changedPackages.push(old);
              records.delete(id);
            }
          }
      const changedIds = exactHint
        ? sorted(hint.changed)
        : sorted(Object.keys(snapshot.events)).filter((id) => {
            const previous = baseSnapshot?.events[id];
            const next = snapshot.events[id];
            return (
              !previous ||
              previous.envelope_hash !== next.envelope_hash ||
              previous.body_hash !== next.body_hash
            );
          });
      for await (const { value: id, result: retained } of streamVerifiedRecords(
        this.coordinator,
        this.objects,
        snapshot.events,
        changedIds,
      )) {
        const event = snapshot.events[id];
        this.canonicalEnvelopes.set(
          event.envelope_hash,
          canonicalStoredEnvelope(id, event),
        );
        const record = await builder.addHostVerifiedRecord(retained.compact);
        if (
          record ||
          ["definition.publish", "rafsi.publish"].includes(
            String(baseSnapshot?.events[id]?.header.action.kind),
          )
        ) {
          const records = mutableRecords();
          const old = records.get(id);
          if (old) changedPackages.push(old);
          records.delete(id);
          if (record) {
            const prepared: PackageRecord = {
              ...record,
              envelope_hash: event.envelope_hash,
              missing: false,
            };
            records.set(id, prepared);
            changedPackages.push(prepared);
          }
        }
      }
      const session = await builder.finish();
      const state = session.state;
      if (ownsEntry()) {
        this.sessions.set(snapshot.snapshot + "|" + view, session);
        this.sessionSnapshots.set(snapshot.snapshot + "|" + view, snapshot);
        if (!this.packageRecords.has(snapshot.snapshot))
          this.packageRecords.set(
            snapshot.snapshot,
            packageRecords
              ? [...packageRecords.values()].sort((a, b) =>
                  a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
                )
              : baseRecords,
          );
        if (baseSnapshot && baseSnapshot.snapshot !== snapshot.snapshot)
          this.packageBases.set(snapshot.snapshot, {
            snapshot: baseSnapshot.snapshot,
            changed: changedPackages,
          });
      } else session.free();
      return state;
    } finally {
      builder.free();
    }
  }
  private async receipt(
    id: string,
    admission = "accepted",
    snapshot?: Snapshot,
    acceptedPosition?: number,
  ) {
    snapshot ??= (await this.current()).snapshot;
    const event = snapshot.events[id];
    if (!event) throw new ApiError(404, "missing", "Event is unavailable.", id);
    let derived: Evaluation["receipts"][string] | undefined;
    let reasons = ["evaluation_unavailable"];
    let bodyInvalid = false;
    let receiptSnapshot: string | null = snapshot.snapshot;
    if (this.options.asyncMaterialization) {
      await this.initialize();
      if (this.backgroundError && !this.background)
        this.queueMaterialization(snapshot);
      const complete = this.completed;
      const key =
        complete?.snapshot.snapshot +
        "|" +
        (this.options.selectedView ?? zeroView);
      const previous = complete?.snapshot.events[id];
      if (
        previous?.envelope_hash === event.envelope_hash &&
        previous?.body_hash === event.body_hash
      ) {
        receiptSnapshot = complete!.snapshot.snapshot;
        let state: Evaluation | undefined;
        try {
          state = await this.evaluation(complete!.snapshot);
        } catch (error) {
          if (
            !(error instanceof ApiError) ||
            error.code !== "resource_unavailable"
          )
            throw error;
          reasons = ["evaluation_resource_unavailable"];
        }
        derived = state?.receipts[id];
      } else {
        receiptSnapshot = null;
        reasons = ["index_lag", "evaluation_pending"];
      }
      if (!derived) {
        if (event.body_hash) {
          bodyInvalid =
            compactRecord(
              await readVerifiedRecord(
                this.coordinator,
                this.objects,
                id,
                event,
              ),
            ).body_status === "invalid";
        }
      }
    } else
      try {
        derived = (await this.evaluation(snapshot)).receipts[id];
      } catch (error) {
        if (
          !(error instanceof ApiError) ||
          error.code !== "resource_unavailable"
        )
          throw error;
        // Acceptance is durable even when interpretation must wait for a cache slot.
        reasons = ["evaluation_resource_unavailable"];
        if (event.body_hash) {
          bodyInvalid =
            compactRecord(
              await readVerifiedRecord(
                this.coordinator,
                this.objects,
                id,
                event,
              ),
            ).body_status === "invalid";
        }
      }
    return {
      id,
      admission,
      interpretation: derived?.interpretation ?? "unavailable",
      body_status:
        bodyInvalid || derived?.body.startsWith("invalid:")
          ? "invalid"
          : event.body_hash
            ? "present"
            : event.header.content
              ? "missing"
              : "none",
      cursor: this.cursor(
        acceptedPosition ?? (await this.coordinator.load()).events[id].position,
      ),
      snapshot: receiptSnapshot,
      view: this.options.selectedView ?? zeroView,
      reasons: derived?.reasons ?? reasons,
      envelope_hash: event.envelope_hash,
      body_hash: event.body_hash,
    };
  }
  async admit(bytes: Uint8Array): Promise<Response> {
    const result = await this.admitMany([bytes]);
    return json(
      result.receipts[0],
      result.receipts[0].admission === "accepted" ? 201 : 200,
    );
  }
  async admitMany(requests: Uint8Array[]) {
    if (this.options.asyncMaterialization) await this.initialize();
    if (requests.length < 1 || requests.length > 3000)
      throw new ApiError(
        413,
        "size",
        "Batch must contain 1 through 3000 events.",
      );
    const prepared = requests.map(prepareAdmission);
    const projections = new Map<string, StoredVerifiedRecord>();
    for (const p of prepared) {
      const record = projectVerifiedRecord(
        p.id,
        {
          envelope_hash: p.envelope_hash,
          body_hash: p.body === null ? null : p.header.content!.hash,
        },
        utf8(p.envelope),
        p.body === null ? undefined : utf8(p.body),
      );
      projections.set(verifiedRecordKey(record), record);
      await this.objects.put(p.envelope_hash, utf8(p.envelope));
      this.canonicalEnvelopes.set(p.envelope_hash, p.envelope);
      if (p.body !== null)
        await this.objects.put(p.header.content!.hash, utf8(p.body));
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      const state = await this.coordinator.load();
      const next = {
        ...state,
        events: { ...state.events },
        journal: [...state.journal],
        selections: [...state.selections],
        snapshots: [...state.snapshots],
      };
      next.revision++;
      const admissions: string[] = [];
      let changed = false;
      const changedIds = new Set<string>();
      for (const p of prepared) {
        const old = next.events[p.id];
        if (
          old &&
          canonicalize(utf8(JSON.stringify(old.header))) !==
            canonicalize(utf8(JSON.stringify(p.header)))
        )
          throw new ApiError(
            409,
            "collision",
            "Event ID names different headers.",
            p.id,
          );
        const preferred =
          !old || compareBytes(p.signature_bytes, old.signature) < 0;
        const descriptor = p.header.content;
        const sharedBody =
          descriptor &&
          Object.values(next.events).some(
            (e) =>
              e.body_hash === descriptor.hash &&
              e.header.content?.bytes === descriptor.bytes,
          )
            ? descriptor.hash
            : null;
        const bodyHash =
          p.body !== null
            ? p.header.content!.hash
            : (old?.body_hash ?? sharedBody);
        admissions.push(old ? "duplicate" : "accepted");
        if (!old || preferred || old.body_hash !== bodyHash) {
          changed = true;
          changedIds.add(p.id);
          if (!old) {
            next.position++;
            next.journal.push({ position: next.position, id: p.id });
          }
          next.events[p.id] = {
            envelope_hash: preferred ? p.envelope_hash : old.envelope_hash,
            body_hash: bodyHash,
            header: p.header,
            signature: preferred ? p.signature_bytes : old.signature,
            position: old?.position ?? next.position,
          };
        }
        if (p.body !== null)
          for (const [id, retained] of Object.entries(next.events))
            if (
              retained.header.content?.hash === p.header.content!.hash &&
              retained.header.content.bytes === p.header.content!.bytes &&
              retained.body_hash !== p.header.content!.hash
            ) {
              next.events[id] = {
                ...retained,
                body_hash: p.header.content!.hash,
              };
              changedIds.add(id);
              changed = true;
            }
      }
      if (!changed) {
        const snapshot = (await this.current()).snapshot;
        return {
          snapshot: snapshot.snapshot,
          receipts: await Promise.all(
            prepared.map((p, i) =>
              this.receipt(
                p.id,
                admissions[i],
                snapshot,
                state.events[p.id].position,
              ),
            ),
          ),
        };
      }
      const verified = await prepareVerifiedRecords(
        this.objects,
        next.events,
        changedIds,
        projections,
      );
      const snapshot = await this.buildSnapshot(next);
      this.snapshotPositions.set(snapshot.snapshot, next.position);
      next.snapshot = snapshot.snapshot;
      next.snapshots = sorted([...next.snapshots, snapshot.snapshot]);
      if (this.options.beforeCommit) await this.options.beforeCommit(next);
      if (
        await this.coordinator.compareAndSwap(
          state.revision,
          next,
          snapshot,
          [...changedIds],
          verified,
        )
      ) {
        if (!this.coordinator.saveVerifiedRecords)
          await retainVerifiedRecords(this.coordinator, verified);
        this.rememberDelta(snapshot.snapshot, state.snapshot, [...changedIds]);
        if (this.options.asyncMaterialization)
          this.queueMaterialization(snapshot);
        return {
          snapshot: snapshot.snapshot,
          receipts: await Promise.all(
            prepared.map((p, i) =>
              this.receipt(
                p.id,
                admissions[i],
                snapshot,
                next.events[p.id].position,
              ),
            ),
          ),
        };
      }
    }
    throw new ApiError(503, "busy", "Admission is busy.");
  }
  /** A configured bound, never above the documented one. */
  private bound(
    name: "reviewers" | "profileClaims" | "recordBytes",
    documented: number,
  ): number {
    const configured = this.options.limits?.[name];
    return Number.isSafeInteger(configured) && configured! >= 1
      ? Math.min(configured!, documented)
      : documented;
  }
  private limit(url: URL, max = 1000): number {
    const raw = url.searchParams.get("limit");
    if (raw === null) return Math.min(200, max);
    if (!/^[1-9]\d*$/.test(raw))
      throw new ApiError(400, "limit", "Limit must be a positive integer.");
    const value = Number(raw);
    if (value > max)
      throw new ApiError(400, "limit", `Limit must not exceed ${max}.`);
    return value;
  }
  private async requestBytes(
    request: Request,
    max = 1024 * 1024,
    expectedContentType = "application/json",
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (
      request.headers.has("content-encoding") &&
      request.headers.get("content-encoding") !== "identity"
    )
      throw new ApiError(
        400,
        "encoding",
        "Compressed request bodies are not supported.",
      );
    const contentType = request.headers.get("content-type")?.split(";")[0];
    if (contentType !== expectedContentType)
      throw new ApiError(400, "content_type", `Use ${expectedContentType}.`);
    if (Number(request.headers.get("content-length")) > max)
      throw new ApiError(413, "size", "Request exceeds the byte limit.");
    const reader = request.body?.getReader();
    if (!reader)
      throw new ApiError(400, "transport", "Request body is missing.");
    const abort = () => {
      void reader.cancel(signal?.reason).catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      if (signal?.aborted) abort();
      signal?.throwIfAborted();
      for (;;) {
        const { done, value } = await reader.read();
        signal?.throwIfAborted();
        if (done) break;
        length += value.length;
        if (length > max) {
          void reader.cancel().catch(() => {});
          throw new ApiError(413, "size", "Request exceeds the byte limit.");
        }
        chunks.push(value);
      }
      const result = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      return result;
    } finally {
      signal?.removeEventListener("abort", abort);
      reader.releaseLock();
    }
  }
  async fetch(request: Request, network = "local"): Promise<Response> {
    const origin = request.headers.get("origin");
    let response: Response;
    try {
      if (
        origin &&
        origin !== new URL(request.url).origin &&
        origin !== this.options.publicOrigin &&
        !(this.options.corsOrigins ?? []).includes(origin)
      ) {
        throw new ApiError(403, "origin", "Origin is not permitted.");
      }
      response = await this.route(request, network);
    } catch (error) {
      if (error instanceof ApiError || error instanceof AssistanceError)
        response = json(
          {
            code: error.code,
            message: error.message,
            event: error instanceof ApiError ? error.event : null,
            field: error instanceof ApiError ? error.field : null,
          },
          error.status,
        );
      else {
        let detail: { code?: string; message?: string } = {};
        try {
          detail = JSON.parse(String(error));
        } catch {}
        if (!detail.code) this.options.reportError?.(error);
        const code = detail.code ?? "service_unavailable";
        response = json(
          {
            code,
            message:
              detail.message ?? "Service could not complete this request.",
            event: null,
            field: null,
          },
          code === "size"
            ? 413
            : detail.code
              ? code === "transport" ||
                code === "number" ||
                code.startsWith("json")
                ? 400
                : 422
              : 503,
        );
      }
    }
    if (request.body && !request.bodyUsed && !request.body.locked)
      await request.body.cancel().catch(() => {});
    if (origin && (this.options.corsOrigins ?? []).includes(origin)) {
      response.headers.set("access-control-allow-origin", origin);
      response.headers.set("vary", "Origin");
    }
    return response;
  }
  private async route(request: Request, network: string): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/health/live")
      return json({ status: "live" });
    if (request.method === "GET" && url.pathname === "/api/health/ready") {
      if (this.options.asyncMaterialization || this.options.checkpoints)
        await this.initialize();
      await this.current();
      return json({ status: "ready" });
    }
    const path = url.pathname.replace(/^\/api\/v1/, "");
    if (!url.pathname.startsWith("/api/v1/"))
      throw new ApiError(404, "missing", "API route is unavailable.");
    if (request.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
          "access-control-allow-headers": "Content-Type, X-CSRF-Token",
        },
      });
    if (request.method === "POST" && path === "/prototype/batch") {
      if (!this.options.allowPrototypeBatch)
        throw new ApiError(
          503,
          "feature_disabled",
          "Prototype batch admission is disabled.",
        );
      const bytes = await this.requestBytes(
        request,
        16 * 1024 * 1024,
        "application/x-ndjson",
      );
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const lines = text.endsWith("\n")
        ? text.slice(0, -1).split("\n")
        : text.split("\n");
      if (lines.some((line) => line.length === 0))
        throw new ApiError(400, "transport", "Batch contains a blank line.");
      return json(await this.admitMany(lines.map(utf8)), 201);
    }
    const assistance = await this.assistance.route(
      request,
      path,
      (signal) =>
        this.requestBytes(request, 262144, "application/json", signal),
      network,
      this.options.publicOrigin,
    );
    if (assistance) return assistance;
    if (request.method === "POST" && path === "/events")
      return this.admit(await this.requestBytes(request));
    if (request.method === "POST" && path === "/import-selections") {
      const selection = prepareSelection(
        await this.requestBytes(request, 16 * 1024 * 1024),
      );
      await this.objects.put(selection.hash, utf8(selection.canonical));
      this.importSelections.set(selection.hash, selection.ids);
      for (let attempt = 0; attempt < 20; attempt++) {
        const state = await this.coordinator.load();
        if (state.selections.includes(selection.hash))
          return json({
            hash: selection.hash,
            bytes: selection.bytes,
            count: selection.count,
          });
        const next = { ...state, selections: [...state.selections] };
        next.revision++;
        next.selections.push(selection.hash);
        const snapshot = await this.buildSnapshot(next);
        next.snapshot = snapshot.snapshot;
        if (
          await this.coordinator.compareAndSwap(
            state.revision,
            next,
            snapshot,
            [],
          )
        ) {
          this.rememberDelta(snapshot.snapshot, state.snapshot, []);
          if (this.options.asyncMaterialization)
            this.queueMaterialization(snapshot);
          return json(
            {
              hash: selection.hash,
              bytes: selection.bytes,
              count: selection.count,
            },
            201,
          );
        }
      }
      throw new ApiError(503, "busy", "Selection admission is busy.");
    }
    if (request.method === "POST" && path === "/search") {
      if (url.search)
        throw new ApiError(
          400,
          "query",
          "POST search fields belong in the JSON body.",
        );
      let fields: unknown;
      try {
        fields = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await this.requestBytes(request, 131072),
          ),
        );
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(
          400,
          "transport",
          "Search body must contain a JSON object.",
        );
      }
      const names = [
        "q",
        "language",
        "snapshot",
        "view",
        "limit",
        "after",
        "retired",
      ];
      if (!fields || typeof fields !== "object" || Array.isArray(fields))
        throw new ApiError(
          400,
          "query",
          "Search body must contain a JSON object.",
        );
      for (const [name, value] of Object.entries(fields)) {
        if (
          !names.includes(name) ||
          (typeof value !== "string" &&
            !(name === "limit" && Number.isSafeInteger(value)))
        )
          throw new ApiError(
            400,
            "query",
            "Search body contains an invalid field.",
          );
        url.searchParams.set(name, String(value));
      }
    }
    if (
      request.method !== "GET" &&
      !(request.method === "POST" && path === "/search")
    )
      throw new ApiError(405, "method", "Method is not supported.");
    if (path === "/capabilities")
      return json({
        versions: [1],
        max_envelope_bytes: 20480,
        max_body_bytes: 262144,
        max_request_bytes: 1048576,
        server_id: this.options.serverId,
        policy_url: this.options.policyUrl,
        cors_origins: this.options.corsOrigins ?? [],
        body_kinds: [
          "definition.publish",
          "rafsi.publish",
          "view.publish",
          "identity.profile",
        ],
        features: {
          semantic_search: false,
          assistance: this.assistance.capabilities().length > 0,
          account_observation: false,
          lensisku_bridge: false,
          derived_exchange: false,
        },
        embedding_profiles: [],
        assistance_profiles: this.assistance.capabilities(),
        git_mirror: null,
        account_witness_service: null,
      });
    if (path === "/manifest") {
      const snapshot = await this.interpretedSnapshot(null);
      const packages = await this.packages(snapshot);
      const state = await this.metadata();
      return json({
        snapshot: snapshot.snapshot,
        logical_inventory: snapshot.logical_inventory,
        manifest: snapshot.manifest,
        accepted_cursor: this.cursor(state.position),
        materialized_cursor: this.cursor(
          this.options.asyncMaterialization
            ? (this.snapshotPositions.get(snapshot.snapshot) ??
                state.materialized_position)
            : state.materialized_position,
        ),
        packages: Object.entries(packages.packages).map(([language, p]) => ({
          language,
          hash: p.hash,
          bytes: p.bytes,
        })),
        package_versions: Object.entries(packages.packages2).map(
          ([language, p]) => ({
            language,
            version: 2,
            hash: p.hash,
            bytes: p.bytes,
          }),
        ),
      });
    }
    if (path === "/inventory") {
      const snapshot = await this.snapshot(url.searchParams.get("snapshot"));
      const kind = url.searchParams.get("kind");
      if (!["events", "bodies", "import_selections"].includes(kind ?? ""))
        throw new ApiError(400, "kind", "Inventory kind is invalid.");
      const ids =
        kind === "events"
          ? sorted(Object.keys(snapshot.events))
          : kind === "bodies"
            ? snapshot.bodies
            : snapshot.import_selections;
      const prefix = kind === "events" ? "jve1:" : "sha256:";
      const after = url.searchParams.get("after");
      if (after !== null) this.identifier(after, prefix);
      const remaining = ids.filter((id) => after === null || id > after);
      const page = remaining.slice(0, this.limit(url));
      return json({
        snapshot: snapshot.snapshot,
        kind,
        ids: page,
        next: remaining.length > page.length ? page.at(-1) : null,
      });
    }
    if (path === "/changes") {
      const { snapshot } = await this.current();
      if (!this.options.asyncMaterialization) await this.packages(snapshot);
      const state = await this.coordinator.load();
      const after = this.cursorPosition(url.searchParams.get("after"), state);
      const remaining = state.journal.filter((item) => item.position > after);
      const page = remaining.slice(0, this.limit(url));
      return json({
        items: page.map((item) => ({
          cursor: this.cursor(item.position),
          id: item.id,
        })),
        next: this.cursor(page.at(-1)?.position ?? after),
        caught_up: remaining.length === page.length,
        materialized_cursor: this.cursor(state.materialized_position),
      });
    }
    if (path.startsWith("/receipts/")) {
      const id = decodeURIComponent(path.slice(10));
      this.identifier(id, "jve1:");
      return json(await this.receipt(id));
    }
    if (path.startsWith("/events/")) {
      const id = decodeURIComponent(path.slice(8));
      this.identifier(id, "jve1:");
      const snapshot = await this.snapshot(url.searchParams.get("snapshot"));
      const event = snapshot.events[id];
      if (!event)
        throw new ApiError(404, "missing", "Event is unavailable.", id);
      return this.objectResponse(event.envelope_hash);
    }
    for (const prefix of ["/bodies/", "/import-selections/"])
      if (path.startsWith(prefix)) {
        const hash = decodeURIComponent(path.slice(prefix.length));
        this.identifier(hash, "sha256:");
        const snapshot = await this.snapshot(url.searchParams.get("snapshot"));
        const inventory =
          prefix === "/bodies/" ? snapshot.bodies : snapshot.import_selections;
        if (!inventory.includes(hash))
          throw new ApiError(404, "missing", "Object is unavailable.");
        return this.objectResponse(hash);
      }
    if (path.startsWith("/identity-heads/")) {
      const identity = decodeURIComponent(path.slice(16));
      this.identifier(identity, "ed25519:");
      const snapshot = await this.snapshot(url.searchParams.get("snapshot"));
      const own = Object.entries(snapshot.events).filter(
        ([, e]) => e.header.issuer === identity,
      );
      const parents = new Set(own.flatMap(([, e]) => e.header.previous));
      const ids = sorted(
        own.map(([id]) => id).filter((id) => !parents.has(id)),
      );
      const after = url.searchParams.get("after");
      if (after !== null) this.identifier(after, "jve1:");
      const remaining = ids.filter((id) => after === null || id > after);
      const page = remaining.slice(0, this.limit(url));
      return json({
        snapshot: snapshot.snapshot,
        identity,
        heads: page,
        next: remaining.length > page.length ? page.at(-1) : null,
      });
    }
    if (path.startsWith("/packages/")) {
      const language = this.language(decodeURIComponent(path.slice(10)));
      const snapshot = await this.interpretedSnapshot(
        url.searchParams.get("snapshot"),
      );
      const version = url.searchParams.get("version") ?? "1";
      if (version !== "1" && version !== "2")
        throw new ApiError(400, "version", "Package version must be 1 or 2.");
      const built = await this.packages(snapshot);
      const pkg = (version === "2" ? built.packages2 : built.packages)[
        language
      ];
      if (!pkg)
        throw new ApiError(404, "missing", "Language package is unavailable.");
      return this.objectResponse(pkg.hash);
    }
    if (path.startsWith("/package-parts/")) {
      const hash = decodeURIComponent(path.slice(15));
      this.identifier(hash, "sha256:");
      const bytes = await this.objects.get(hash);
      if (!bytes)
        throw new ApiError(404, "missing", "Search part is unavailable.");
      const part = JSON.parse(canonicalize(bytes));
      if (
        !Array.isArray(part) ||
        part.length > 2000 ||
        bytes.length > 4194304 ||
        part.some(
          (item) =>
            !item ||
            typeof item.event !== "string" ||
            typeof item.plain_text !== "string",
        )
      )
        throw new ApiError(404, "missing", "Search part is unavailable.");
      return this.objectResponse(hash);
    }
    if (path === "/search") {
      const query = url.searchParams.get("q");
      if (query === null || query.length === 0 || utf8(query).length > 16384)
        throw new ApiError(
          400,
          "query",
          "Query must contain 1 through 16384 bytes.",
        );
      const language = this.language(url.searchParams.get("language"));
      const snapshot = await this.interpretedSnapshot(
        url.searchParams.get("snapshot"),
      );
      const view =
        url.searchParams.get("view") ?? this.options.selectedView ?? zeroView;
      this.identifier(view, "jve1:");
      await this.requireView(snapshot, view);
      const evaluation = await this.evaluation(snapshot, view);
      if (!evaluation.available)
        throw new ApiError(
          503,
          "resource_unavailable",
          "Selected view cannot be evaluated.",
        );
      // Retired results are excluded unless the caller asks for them with retired=1.
      const retiredFlag = url.searchParams.get("retired");
      if (retiredFlag !== null && retiredFlag !== "1")
        throw new ApiError(400, "retired", "retired must be 1 when present.");
      const includeRetired = retiredFlag === "1";
      const q = query.toLocaleLowerCase("en");
      const kinds = [
        "headword",
        "gloss",
        "headword-prefix",
        "gloss-prefix",
        "token",
      ];
      const hits = new Map<
        string,
        {
          word: unknown;
          word_id: string;
          match: string;
          definitions: string[];
          preview: {
            event: string;
            word_kind: string;
            plain_text: string;
            status: string;
          };
        }
      >();
      for (const entry of (await this.packages(snapshot)).entries) {
        const publication = evaluation.publications[entry.event];
        if (
          entry.language !== language ||
          !publication ||
          publication.eligible !== "eligible" ||
          (publication.status !== "active" && !includeRetired)
        )
          continue;
        const spelling = entry.word.spelling.toLocaleLowerCase("en");
        const glosses = entry.glosses.map((g) =>
          g.text.toLocaleLowerCase("en"),
        );
        const match =
          spelling === q
            ? "headword"
            : glosses.includes(q)
              ? "gloss"
              : spelling.startsWith(q)
                ? "headword-prefix"
                : glosses.some((g) => g.startsWith(q))
                  ? "gloss-prefix"
                  : entry.plain_text.toLocaleLowerCase("en").includes(q)
                    ? "token"
                    : null;
        if (!match) continue;
        const wordId = publication.word;
        const classification = entry.classification as {
          kind?: unknown;
        } | null;
        const plainText = entry.plain_text.replace(/\s+/gu, " ").trim();
        const characters = Array.from(plainText);
        const preview = {
          event: entry.event,
          word_kind:
            typeof classification?.kind === "string"
              ? classification.kind
              : "unknown",
          plain_text:
            characters.length > 240
              ? characters.slice(0, 239).join("") + "…"
              : plainText,
          status: publication.status,
        };
        const old = hits.get(wordId);
        if (old) {
          old.definitions.push(entry.event);
          if (
            kinds.indexOf(match) < kinds.indexOf(old.match) ||
            (match === old.match && entry.event < old.preview.event)
          ) {
            old.match = match;
            old.preview = preview;
          }
        } else
          hits.set(wordId, {
            word: entry.word,
            word_id: wordId,
            match,
            definitions: [entry.event],
            preview,
          });
      }
      const ordered = [...hits.values()].sort(
        (a, b) =>
          kinds.indexOf(a.match) - kinds.indexOf(b.match) ||
          a.word_id.localeCompare(b.word_id),
      );
      const cursorHash = this.hashJson({
        query,
        language,
        snapshot: snapshot.snapshot,
        view,
        retired: includeRetired,
      }).slice(7);
      const after = url.searchParams.get("after");
      let offset = 0;
      if (after !== null) {
        const prefix = cursorHash + ".";
        if (
          !after.startsWith(prefix) ||
          !/^\d+$/.test(after.slice(prefix.length))
        )
          throw new ApiError(
            400,
            "bad_cursor",
            "Search cursor identifies another query.",
          );
        offset = Number(after.slice(prefix.length));
        if (
          !Number.isSafeInteger(offset) ||
          offset > ordered.length ||
          prefix + offset !== after
        )
          throw new ApiError(400, "bad_cursor", "Search cursor is invalid.");
      }
      const page = ordered.slice(offset, offset + this.limit(url, 100));
      return json({
        snapshot: snapshot.snapshot,
        view,
        query,
        language,
        hits: page,
        next:
          offset + page.length < ordered.length
            ? cursorHash + "." + (offset + page.length)
            : null,
      });
    }
    if (path.startsWith("/words/")) {
      const id = decodeURIComponent(path.slice(7));
      this.identifier(id, "jvw1:");
      const snapshot = await this.interpretedSnapshot(
        url.searchParams.get("snapshot"),
      );
      const view =
        url.searchParams.get("view") ?? this.options.selectedView ?? zeroView;
      this.identifier(view, "jve1:");
      await this.requireView(snapshot, view);
      const evaluation = await this.evaluation(snapshot, view);
      if (!evaluation.available)
        throw new ApiError(
          503,
          "resource_unavailable",
          "Selected view cannot be evaluated.",
        );
      const publications = Object.values(evaluation.publications).filter(
        (p) => p.word === id && p.eligible !== "not_selected",
      );
      const definitions = publications
        .filter((p) => p.kind === "definition.publish")
        .map((p) => p.id)
        .sort();
      const rafsi = publications
        .filter((p) => p.kind === "rafsi.publish")
        .map((p) => p.id)
        .sort();
      const entries = (await this.packages(snapshot)).entries;
      const word =
        entries.find((entry) => definitions.includes(entry.event))?.word ??
        null;
      const assignments = [
        ...new Set(
          publications.flatMap((p) => (p.assignment ? [p.assignment] : [])),
        ),
      ]
        .sort()
        .map((assignment) => {
          const claims = publications.filter(
            (p) => p.assignment === assignment,
          );
          return {
            id: assignment,
            claims: claims.map((p) => p.id).sort(),
            status: claims.some((p) => p.eligible === "eligible")
              ? "eligible"
              : claims.every((p) => p.eligible === "inactive")
                ? "inactive"
                : "unknown",
          };
        });
      let ranking: any = {
        calculation: null,
        scores: [],
        layers: [],
        unavailable_scores: [
          ...definitions,
          ...assignments
            .filter((a) => a.status !== "inactive")
            .map((a) => a.id),
        ].sort(),
      };
      const reviewersFlag = url.searchParams.get("reviewers");
      if (reviewersFlag !== null && reviewersFlag !== "1")
        throw new ApiError(
          400,
          "reviewers",
          "The reviewers flag must be 1 when present.",
        );
      // The core materializes reviewer details only on request, bounded there.
      const withReviewers = reviewersFlag === "1";
      try {
        const key = snapshot.snapshot + "|" + view;
        const session = this.sessions.get(key);
        if (session) {
          ranking = await this.useSession(key, () =>
            session.rankWord(
              id,
              withReviewers
                ? this.bound("reviewers", REVIEWER_LIMIT)
                : undefined,
            ),
          );
        }
      } catch {}
      const scores = ranking.scores as Record<string, unknown>[];
      return json({
        snapshot: snapshot.snapshot,
        view,
        calculation:
          ranking.calculation === null
            ? null
            : {
                ...ranking.calculation,
                inventory: snapshot.snapshot,
                logical_inventory: snapshot.logical_inventory,
              },
        word,
        definitions,
        rafsi,
        assignments,
        scores,
        statuses: definitions.map(
          (event) => evaluation.publication_statuses[event],
        ),
        layers: ranking.layers,
        unavailable_scores: ranking.unavailable_scores,
      });
    }
    if (path === "/records") {
      const snapshot = await this.snapshot(url.searchParams.get("snapshot"));
      const after = url.searchParams.get("after");
      if (after !== null) this.identifier(after, "jve1:");
      const limit = this.limit(url, RECORD_PAGE_LIMIT);
      const ids = sorted(Object.keys(snapshot.events)).filter(
        (id) => after === null || id > after,
      );
      const items: unknown[] = [];
      let bytes = 2;
      const byteLimit = this.bound("recordBytes", RECORD_PAGE_BYTES);
      let truncated = false;
      for (const id of ids) {
        if (items.length >= limit) {
          truncated = true;
          break;
        }
        const event = snapshot.events[id];
        const envelope = await this.objects.get(event.envelope_hash);
        if (!envelope)
          throw new ApiError(
            503,
            "storage_unavailable",
            "Envelope bytes are unavailable.",
            id,
          );
        const body = event.body_hash
          ? await this.objects.get(event.body_hash)
          : null;
        // "missing" means the snapshot never retained the body. "unavailable"
        // means the snapshot retained it and storage did not return it now.
        const item = {
          id,
          envelope: JSON.parse(new TextDecoder().decode(envelope)),
          body: body ? JSON.parse(new TextDecoder().decode(body)) : null,
          body_status: body
            ? "present"
            : event.body_hash
              ? "unavailable"
              : event.header.content
                ? "missing"
                : "none",
        };
        // The page bound counts the encoded item bytes as the response carries them.
        const size = utf8(JSON.stringify(item)).length + (items.length ? 1 : 0);
        if (items.length && bytes + size >= byteLimit) {
          truncated = true;
          break;
        }
        bytes += size;
        items.push(item);
      }
      return json({
        snapshot: snapshot.snapshot,
        logical_inventory: snapshot.logical_inventory,
        items,
        next: truncated ? (items.at(-1) as { id: string }).id : null,
      });
    }
    if (path.startsWith("/identities/")) {
      const rest = decodeURIComponent(path.slice(12));
      const parts = rest.split("/");
      const [identity, section] = parts;
      this.identifier(identity, "ed25519:");
      if (parts.length > 2 || (section !== undefined && section !== "activity"))
        throw new ApiError(404, "missing", "API route is unavailable.");
      const accepted = url.searchParams.get("accepted");
      if (accepted !== null && (accepted !== "1" || section !== "activity"))
        throw new ApiError(
          400,
          "accepted",
          "Accepted history requires activity and accepted=1.",
        );
      const snapshot = accepted
        ? await this.snapshot(url.searchParams.get("snapshot"))
        : await this.interpretedSnapshot(url.searchParams.get("snapshot"));
      const view =
        url.searchParams.get("view") ?? this.options.selectedView ?? zeroView;
      if (!accepted) {
        this.identifier(view, "jve1:");
        await this.requireView(snapshot, view);
      }
      const own = sorted(
        Object.entries(snapshot.events)
          .filter(([, e]) => e.header.issuer === identity)
          .map(([id]) => id),
      );
      if (section === "activity") {
        let evaluation: Evaluation | null = null;
        try {
          if (!accepted) evaluation = await this.evaluation(snapshot, view);
        } catch (error) {
          if (
            !(error instanceof ApiError) ||
            error.code !== "resource_unavailable"
          )
            throw error;
        }
        const after = url.searchParams.get("after");
        if (after !== null) this.identifier(after, "jve1:");
        const remaining = own.filter((id) => after === null || id > after);
        const page = remaining.slice(0, this.limit(url));
        const state = await this.coordinator.load();
        return json({
          snapshot: snapshot.snapshot,
          ...(accepted ? { history: "accepted" } : { view }),
          identity,
          items: page.map((id) => ({
            id,
            action: snapshot.events[id].header.action,
            interpretation: evaluation?.available
              ? (evaluation.receipts[id]?.interpretation ?? "unavailable")
              : "unavailable",
            seen: state.events[id]
              ? this.cursor(state.events[id].position)
              : null,
          })),
          next: remaining.length > page.length ? page.at(-1) : null,
        });
      }
      // Without an evaluation, no definite profile, handover, or compromise state exists.
      const evaluation = await this.evaluation(snapshot, view);
      if (!evaluation.available)
        throw new ApiError(
          503,
          "resource_unavailable",
          "Selected view cannot be evaluated.",
        );
      const lifecycle = evaluation.lifecycle as {
        key_actor: Record<string, string>;
        successor: Record<string, string>;
        suspended: Record<string, unknown>;
        retired: string[];
        compromised: string[];
      };
      const actor = lifecycle.key_actor[identity] ?? identity;
      const registers = evaluation.registers as Record<
        string,
        {
          actor: string;
          heads: string[];
          conflicted: boolean;
          values: string[];
        }
      >;
      const register = registers[`${actor}|profile`];
      // Concurrent claims are bounded by count and by total body bytes. A
      // claim past the byte budget keeps its event and hash with no body.
      const heads = sorted(register?.heads ?? []);
      const claims: unknown[] = [];
      let unavailable = false;
      let claimBytes = 0;
      const claimLimit = this.bound("profileClaims", PROFILE_CLAIM_LIMIT);
      for (const head of heads.slice(0, claimLimit)) {
        const event = snapshot.events[head];
        const bytes = event?.body_hash
          ? await this.objects.get(event.body_hash)
          : null;
        let body: unknown = null;
        let bodyStatus:
          | "present"
          | "missing"
          | "invalid"
          | "unavailable"
          | "omitted" = event?.body_hash ? "unavailable" : "missing";
        if (bytes) {
          const envelope = await this.objects.get(event!.envelope_hash);
          if (
            envelope &&
            inspectHostStoredBody(event!.header, bytes).availability === "valid"
          ) {
            if (claimBytes + bytes.length > PROFILE_CLAIM_BYTES)
              bodyStatus = "omitted";
            else {
              claimBytes += bytes.length;
              body = JSON.parse(new TextDecoder().decode(bytes));
              bodyStatus = "present";
            }
          } else if (envelope) bodyStatus = "invalid";
        }
        if (bodyStatus === "unavailable") unavailable = true;
        claims.push({
          event: head,
          issuer: event?.header.issuer ?? null,
          body_hash: event?.body_hash ?? null,
          body,
          body_status: bodyStatus,
        });
      }
      const counts = {
        definitions: 0,
        rafsi: 0,
        judgments: 0,
        trust: 0,
        reports: 0,
        other: 0,
      };
      for (const id of own) {
        const kind = snapshot.events[id].header.action.kind;
        if (kind === "definition.publish") counts.definitions++;
        else if (kind === "rafsi.publish") counts.rafsi++;
        else if (kind === "judgment.set") counts.judgments++;
        else if (kind === "trust.set") counts.trust++;
        else if (kind === "report.set") counts.reports++;
        else counts.other++;
      }
      return json({
        snapshot: snapshot.snapshot,
        view,
        identity,
        actor,
        successor: lifecycle.successor?.[identity] ?? null,
        retired: lifecycle.retired?.includes(identity) ?? false,
        compromised: lifecycle.compromised?.includes(identity) ?? false,
        suspended: Object.hasOwn(lifecycle.suspended ?? {}, actor),
        profile: {
          state: !register
            ? "none"
            : register.conflicted
              ? "conflicted"
              : unavailable
                ? "unavailable"
                : "known",
          claims,
          claims_count: heads.length,
          claims_complete:
            heads.length <= claimLimit &&
            claims.every(
              (claim) =>
                (claim as { body_status: string }).body_status !== "omitted",
            ),
        },
        counts,
      });
    }
    if (path === "/account-control") {
      const origin = url.searchParams.get("origin");
      const accountText = url.searchParams.get("account");
      let parsed: URL;
      try {
        parsed = new URL(origin ?? "");
      } catch {
        throw new ApiError(400, "origin", "Account origin is invalid.");
      }
      if (parsed.protocol !== "https:" || parsed.origin !== origin)
        throw new ApiError(
          400,
          "origin",
          "Account origin must be a canonical HTTPS origin.",
        );
      if (
        accountText === null ||
        !/^[1-9]\d*$/.test(accountText) ||
        !Number.isSafeInteger(Number(accountText))
      )
        throw new ApiError(
          400,
          "account",
          "Account must be a positive safe integer.",
        );
      const snapshot = await this.interpretedSnapshot(
        url.searchParams.get("snapshot"),
      );
      const view =
        url.searchParams.get("view") ?? this.options.selectedView ?? zeroView;
      this.identifier(view, "jve1:");
      await this.requireView(snapshot, view);
      const evaluation = await this.evaluation(snapshot, view);
      if (!evaluation.available)
        throw new ApiError(
          503,
          "resource_unavailable",
          "Selected view cannot be evaluated.",
        );
      const summary = evaluation.account_controls[origin + "#" + accountText];
      if (summary) return json({ ...summary, snapshot: snapshot.snapshot });
      return json({
        snapshot: snapshot.snapshot,
        view,
        origin,
        account: Number(accountText),
        state: "unclaimed",
        controller_candidates: [],
        contributions: [],
        certificates: [],
        chain: [],
        reasons: [],
      });
    }
    throw new ApiError(404, "missing", "API route is unavailable.");
  }
  private async objectResponse(hash: string): Promise<Response> {
    const bytes = await this.objects.get(hash);
    if (!bytes)
      throw new ApiError(404, "missing", "Object bytes are unavailable.");
    return new Response(bytes as BodyInit, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        etag: `"${hash}"`,
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }
}
