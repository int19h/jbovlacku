/**
 * Local calculation from authenticated records in a worker. The personal mode
 * applies this browser's private choices as an overlay. The site mode uses no
 * overlay, so its result can be compared with the server's scores.
 */
import {
  canonicalize,
  contentHash,
  utf8,
} from "../../../../packages/core/src/index.ts";
import type { LocalStore, Overlay } from "./store.ts";
import {
  forgetInventory,
  latestInventory,
  loadRecords,
  RecordsError,
  syncRecords,
  type RecordsProgress,
  type SnapshotInventory,
} from "./records.ts";
import type { WorkerRequest, WorkerResponse } from "../workers/evaluate.ts";
import type { Calculation, ScoreRecord, TrustScope } from "../model/types.ts";
import { describe } from "../lib/dom.ts";

export type CalculationMode = "personal" | "site";
export interface LocalRanking {
  mode: CalculationMode;
  snapshot: string;
  view: string;
  overlay: string;
  calculation: Calculation | null;
  scores: ScoreRecord[];
  layers: string[][];
  unavailable_scores: string[];
}
export type PersonalStatus =
  | { state: "idle" }
  | { state: "downloading"; progress: RecordsProgress }
  | { state: "evaluating"; mode: CalculationMode; events: number }
  | {
      state: "ready";
      mode: CalculationMode;
      snapshot: string;
      view: string;
      events: number;
      overlay: string;
      available: boolean;
      reasons: string[];
    }
  | {
      state: "failed";
      message: string;
      kind: RecordsError["kind"] | "worker" | "cancelled";
    };
type Listener = (status: PersonalStatus) => void;
/** What the effective overlay needs from the session: the current identity, or null when anonymous. */
export interface OverlayContext {
  identity: string | null;
  /** Accepted continuity from this calculation snapshot only. */
  actors?: Record<string, string>;
}
/**
 * The effective input of one personal calculation: a version 2 overlay. It
 * has the six version 1 fields and `public_shun_issuer`. The core resolves
 * that issuer's effective public shuns into personal blocks, with scope,
 * continuity, clear, and conflict rules, so this client derives none.
 * Saved private preferences stay version 1. Nothing here is stored.
 */
export interface EffectiveOverlay extends Omit<Overlay, "version"> {
  version: 2;
  public_shun_issuer: string | null;
}
/** The digest of canonical JSON null: the overlay digest of the site view. */
export const nullOverlayDigest = () => contentHash(utf8("null"));
function sortedUnique<T>(items: T[], key: (item: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const item of items) byKey.set(key(item), item);
  return [...byKey.values()]
    .map((item) => ({ item, bytes: canonicalize(utf8(JSON.stringify(item))) }))
    .sort((a, b) => (a.bytes < b.bytes ? -1 : a.bytes > b.bytes ? 1 : 0))
    .map((entry) => entry.item);
}
/**
 * The overlay as the core expects it for a personal calculation. The current
 * identity becomes a root with q=1 only when its snapshot continuity group has
 * no view allocation or private root change. It is the `public_shun_issuer`
 * whose effective public shuns the core turns into personal blocks. An anonymous session names no issuer. Private
 * blocks are copied as saved. No public shun is derived here.
 */
export function effectiveOverlay(
  overlay: Overlay,
  baseView: string,
  context: OverlayContext,
  viewRoots: string[],
): EffectiveOverlay {
  const rootChanges = overlay.root_changes.map((r) => ({
    identity: r.identity,
    q: r.q,
  }));
  const { identity } = context;
  const actor = (key: string) => context.actors?.[key] ?? key;
  if (
    identity &&
    !viewRoots.some((root) => actor(root) === actor(identity)) &&
    !rootChanges.some((r) => actor(r.identity) === actor(identity))
  )
    rootChanges.push({ identity, q: { numerator: 1, denominator: 1 } });
  const blocked = overlay.blocked.map((entry) => ({
    identity: entry.identity,
    scope: entry.scope,
  }));
  const scopeKey = (scope: TrustScope) =>
    `${scope.kind}|${scope.word}|${scope.language}`;
  return {
    version: 2,
    public_shun_issuer: /^ed25519:/.test(identity ?? "") ? identity : null,
    base_view: baseView,
    root_changes: sortedUnique(rootChanges, (r) => r.identity),
    trust: sortedUnique(
      overlay.trust
        .filter(
          (rule) =>
            /^ed25519:/.test(rule.issuer) &&
            identity !== null &&
            actor(rule.issuer) === actor(identity),
        )
        .map((rule) => ({
          issuer: rule.issuer,
          subject: rule.subject,
          scope: rule.scope,
          value: rule.value,
          weight: rule.value === "heed" ? rule.weight : null,
        })),
      (rule) => `${rule.issuer}|${rule.subject}|${scopeKey(rule.scope)}`,
    ),
    blocked: sortedUnique(
      blocked,
      (entry) => `${entry.identity}|${scopeKey(entry.scope)}`,
    ),
    work: overlay.work,
  };
}
export function overlayDigest(
  overlay: Overlay | EffectiveOverlay | null,
): string {
  return contentHash(utf8(canonicalize(utf8(JSON.stringify(overlay)))));
}
type Pending = {
  resolve: (value: WorkerResponse) => void;
  reject: (error: Error) => void;
};
/** One calculation run. Every asynchronous step checks that its run is still the current one. */
interface Run {
  id: number;
  /** The generation the run belongs to. Cancel and invalidate advance it. */
  generation: number;
  abort: AbortController;
}
type Message = WorkerRequest extends infer R
  ? R extends { id: number }
    ? Omit<R, "id">
    : never
  : never;
const CANCELLED = "Cancelled.";
/** Reviewer details per local score, the same bound as the server applies. */
const REVIEWER_LIMIT = 64;
export class PersonalCalculator {
  private worker: Worker | null = null;
  private sequence = 0;
  private runs = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Set<Listener>();
  status: PersonalStatus = { state: "idle" };
  /** The session key of the loaded evaluation, or null. */
  private loadedKey: string | null = null;
  /** The run that owns the loaded worker session. */
  private current: Run | null = null;
  private loading: Promise<PersonalStatus> | null = null;
  /** What the load in progress was asked for, so a waiter knows whether a failure answers it. */
  private loadingRequest: { mode: CalculationMode; refresh: boolean } | null =
    null;
  /** Rankings by session key and word. A ranking never outlives its session. */
  private rankCache = new Map<string, LocalRanking>();
  private continuity: {
    snapshot: string;
    view: string;
    actors: Record<string, string>;
  } | null = null;
  /**
   * True after Cancel until the user asks for a calculation again. An
   * automatic call from a page never restarts a cancelled calculation.
   */
  private cancelled = false;
  /**
   * Advances on every cancel and every invalidation. Every asynchronous step
   * compares its generation with this one. An older step never changes state.
   */
  private generation = 0;
  /** Counts cancels. A call that a cancel interrupted ends cancelled, whatever happens later. */
  private cancels = 0;
  constructor(
    private store: LocalStore,
    private context: () => Promise<OverlayContext>,
  ) {}
  /** Accepted continuity for the loaded personal calculation only. */
  get loadedContinuity(): {
    snapshot: string;
    view: string;
    actors: Readonly<Record<string, string>>;
  } | null {
    if (
      !this.loadedKey ||
      this.status.state !== "ready" ||
      this.status.mode !== "personal" ||
      this.continuity?.snapshot !== this.status.snapshot ||
      this.continuity.view !== this.status.view
    )
      return null;
    return {
      snapshot: this.continuity.snapshot,
      view: this.continuity.view,
      actors: { ...this.continuity.actors },
    };
  }
  subscribe(listener: Listener) {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }
  private set(status: PersonalStatus) {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }
  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(
      new URL("../workers/evaluate.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const entry = this.pending.get(event.data.id);
      if (!entry) return;
      this.pending.delete(event.data.id);
      if (event.data.type === "error")
        entry.reject(new Error(event.data.message));
      else entry.resolve(event.data);
    };
    worker.onerror = (event) => {
      for (const entry of this.pending.values())
        entry.reject(
          new Error(event.message || "The evaluation worker failed."),
        );
      this.pending.clear();
    };
    this.worker = worker;
    return worker;
  }
  /** Sends one message for a run. A run that is no longer current never reaches the worker. */
  private request(run: Run, message: Message): Promise<WorkerResponse> {
    if (this.current !== run || run.abort.signal.aborted)
      return Promise.reject(new Error(CANCELLED));
    const id = ++this.sequence;
    const worker = this.ensureWorker();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ ...message, id });
    });
  }
  /** True while a download or evaluation is in progress. */
  get busy() {
    return this.loading !== null;
  }
  /**
   * Stops the download or evaluation. The next automatic call keeps the
   * cancelled state. Only an explicit refresh starts a calculation again.
   */
  cancel() {
    this.generation++;
    this.cancels++;
    this.current?.abort.abort(new Error(CANCELLED));
    this.current = null;
    this.worker?.terminate();
    this.worker = null;
    for (const entry of this.pending.values())
      entry.reject(new Error(CANCELLED));
    this.pending.clear();
    this.loadedKey = null;
    this.loading = null;
    this.rankCache.clear();
    this.cancelled = true;
    this.set({
      state: "failed",
      message:
        "The local calculation was cancelled. Recompute from records starts it again.",
      kind: "cancelled",
    });
  }
  private async inventory(
    run: Run,
    refresh: boolean,
  ): Promise<SnapshotInventory> {
    if (!refresh) {
      const cached = await latestInventory(this.store);
      if (cached) return cached;
    }
    return syncRecords(this.store, {
      signal: run.abort.signal,
      onProgress: (progress) => {
        if (this.current === run) this.set({ state: "downloading", progress });
      },
    });
  }
  /**
   * Makes sure that a session for the current snapshot, mode, and overlay is
   * loaded. A caller waits for a load in progress, and starts its own load
   * when that one ends in another state than the one it asked for. A refresh
   * downloads the latest snapshot first and clears a cancel.
   */
  async ensure(
    options: {
      mode?: CalculationMode;
      refresh?: boolean;
    } = {},
  ): Promise<PersonalStatus> {
    const mode = options.mode ?? "personal";
    const refresh = options.refresh ?? false;
    if (refresh) this.cancelled = false;
    const cancels = this.cancels;
    const cancelledStatus = (): PersonalStatus => ({
      state: "failed",
      message:
        "The local calculation was cancelled. Recompute from records starts it again.",
      kind: "cancelled",
    });
    // Every await below is followed by a generation check. A cancel ends the
    // call with the cancelled state. An invalidation starts the call again
    // with the new choices, so no older step restores state.
    for (;;) {
      const generation = this.generation;
      const moved = () => generation !== this.generation;
      if (this.loading) {
        const asked = this.loadingRequest;
        const current = await this.loading;
        if (moved()) {
          if (this.cancels !== cancels) return cancelledStatus();
          continue;
        }
        if (current.state === "ready" && current.mode === mode && !refresh)
          return current;
        if (current.state === "failed" && current.kind === "cancelled")
          return current;
        // A failure answers a waiter that asked for the same mode without a
        // new download. A waiter for another mode or for a new download runs
        // its own load.
        if (
          current.state === "failed" &&
          asked &&
          asked.mode === mode &&
          !refresh
        )
          return current;
        continue;
      }
      if (this.cancelled && !refresh) return this.status;
      if (
        this.status.state === "ready" &&
        this.status.mode === mode &&
        !refresh &&
        this.loadedKey
      ) {
        // The overlay can change between calls. Compare before reusing the session.
        const inventory = await latestInventory(this.store);
        if (moved()) {
          if (this.cancels !== cancels) return cancelledStatus();
          continue;
        }
        if (inventory) {
          const key = await this.key(inventory, mode);
          if (moved()) {
            if (this.cancels !== cancels) return cancelledStatus();
            continue;
          }
          if (key === this.loadedKey) return this.status;
        }
      }
      const run: Run = {
        id: ++this.runs,
        generation,
        abort: new AbortController(),
      };
      this.current?.abort.abort(new Error(CANCELLED));
      this.current = run;
      const promise = this.run(run, mode, refresh);
      this.loading = promise;
      this.loadingRequest = { mode, refresh };
      let result: PersonalStatus;
      try {
        result = await promise;
      } finally {
        if (this.loading === promise) {
          this.loading = null;
          this.loadingRequest = null;
        }
      }
      if (moved()) {
        if (this.cancels !== cancels) return cancelledStatus();
        continue;
      }
      return result;
    }
  }
  /** One calculation. Nothing here touches shared state after the run stops being current. */
  private async run(
    run: Run,
    mode: CalculationMode,
    refresh: boolean,
  ): Promise<PersonalStatus> {
    const live = () => {
      if (
        this.current !== run ||
        run.generation !== this.generation ||
        run.abort.signal.aborted
      )
        throw new Error(CANCELLED);
    };
    try {
      let inventory: SnapshotInventory;
      try {
        inventory = await this.inventory(run, refresh);
      } catch (error) {
        live();
        if (refresh) throw error;
        const cached = await latestInventory(this.store);
        if (!cached) throw error;
        inventory = cached;
      }
      live();
      const records = await loadRecords(this.store, inventory, {
        signal: run.abort.signal,
      });
      live();
      if (
        mode === "personal" &&
        (this.continuity?.snapshot !== inventory.snapshot ||
          this.continuity?.view !== inventory.view)
      ) {
        const response = await this.request(run, {
          type: "actors",
          input: {
            events: records.events,
            bodies: records.bodies,
            selected_view: inventory.view,
            import_selections: records.selections,
          },
        });
        live();
        if (response.type !== "actors")
          throw new Error("Unexpected worker reply.");
        this.continuity = {
          snapshot: inventory.snapshot,
          view: inventory.view,
          actors: response.actors,
        };
      }
      // One overlay per run. The digest is derived from the exact overlay
      // that enters the worker, so a result never carries another digest.
      const overlay = await this.overlayFor(inventory, mode);
      live();
      const digest = overlay ? overlayDigest(overlay) : nullOverlayDigest();
      const key = `${inventory.snapshot}|${inventory.view}|${digest}|${mode}`;
      if (this.loadedKey === key && this.status.state === "ready")
        return this.status;
      this.loadedKey = null;
      this.rankCache.clear();
      this.set({
        state: "evaluating",
        mode,
        events: inventory.events.length,
      });
      const input = {
        events: records.events,
        bodies: records.bodies,
        selected_view: inventory.view,
        import_selections: records.selections,
        ...(overlay ? { overlay } : {}),
      };
      const loaded = await this.request(run, {
        type: "load",
        session: key,
        input,
      });
      live();
      if (loaded.type !== "loaded" || loaded.session !== key)
        throw new Error("Unexpected worker reply.");
      this.loadedKey = key;
      const status: PersonalStatus = {
        state: "ready",
        mode,
        snapshot: inventory.snapshot,
        view: inventory.view,
        events: inventory.events.length,
        overlay: digest,
        available: loaded.available,
        reasons: loaded.reasons,
      };
      this.set(status);
      return status;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const aborted =
        this.current !== run ||
        run.abort.signal.aborted ||
        message === CANCELLED;
      if (aborted) {
        // Cancel, or a newer run, already reported the state. This run stays silent.
        return this.current === run
          ? this.status
          : {
              state: "failed",
              message:
                "The local calculation was cancelled. Recompute from records starts it again.",
              kind: "cancelled",
            };
      }
      const kind: PersonalStatus & { state: "failed" } extends {
        kind: infer K;
      }
        ? K
        : never =
        error instanceof RecordsError
          ? error.kind
          : /fetch|network|answer|connection|timed out|HTTP/i.test(message)
            ? "network"
            : "worker";
      const status: PersonalStatus = {
        state: "failed",
        message: describe(error),
        kind,
      };
      this.loadedKey = null;
      this.set(status);
      return status;
    } finally {
      if (this.current === run) this.current = null;
    }
  }
  private async effective(
    inventory: SnapshotInventory,
    bodies: Record<string, string>,
  ): Promise<EffectiveOverlay> {
    const viewRoots: string[] = [];
    const body = bodies[inventory.view];
    if (body)
      for (const root of (
        JSON.parse(body) as { roots?: { identity: string }[] }
      ).roots ?? [])
        viewRoots.push(root.identity);
    return effectiveOverlay(
      await this.store.overlay(),
      inventory.view,
      {
        ...(await this.context()),
        actors:
          this.continuity?.snapshot === inventory.snapshot &&
          this.continuity.view === inventory.view
            ? this.continuity.actors
            : {},
      },
      viewRoots,
    );
  }
  /** The effective overlay for a mode, read once from the private choices and the cached view body. */
  private async overlayFor(
    inventory: SnapshotInventory,
    mode: CalculationMode,
  ): Promise<EffectiveOverlay | null> {
    if (mode !== "personal") return null;
    const view = await this.store.get<{ body: string | null }>(
      "records",
      inventory.view,
    );
    return this.effective(inventory, { [inventory.view]: view?.body ?? "" });
  }
  private async key(
    inventory: SnapshotInventory,
    mode: CalculationMode,
  ): Promise<string> {
    const overlay = await this.overlayFor(inventory, mode);
    const digest = overlay ? overlayDigest(overlay) : nullOverlayDigest();
    return `${inventory.snapshot}|${inventory.view}|${digest}|${mode}`;
  }
  /**
   * Ranks one word under the loaded session for the mode. The ranking names
   * the snapshot, view, and overlay of that session. A session replaced
   * during the request is reported as a failure, never as a result.
   */
  async rankWord(
    word: string,
    options: { mode?: CalculationMode } = {},
  ): Promise<LocalRanking> {
    const mode = options.mode ?? "personal";
    const status = await this.ensure({ mode });
    if (status.state !== "ready")
      throw new Error(
        status.state === "failed"
          ? status.message
          : "The local calculation is not ready.",
      );
    const session = this.loadedKey;
    if (!session) throw new Error("The local calculation is not loaded.");
    const cacheKey = `${session}|${word}`;
    const cached = this.rankCache.get(cacheKey);
    if (cached) return cached;
    // The breakdown of a local score names its reviewers and routes. The
    // same bound as the server's applies.
    const reply = await this.rankRequest(session, word, REVIEWER_LIMIT);
    if (this.loadedKey !== session || reply.session !== session)
      throw new Error(
        "The local calculation changed while ranking this word. Try again.",
      );
    const result = reply.result as {
      calculation: Calculation | null;
      scores: ScoreRecord[];
      layers: string[][];
      unavailable_scores: string[];
    };
    const ranking: LocalRanking = {
      mode,
      snapshot: status.snapshot,
      view: status.view,
      overlay: status.overlay,
      calculation: result.calculation
        ? {
            ...result.calculation,
            inventory: status.snapshot,
            logical_inventory:
              result.calculation.logical_inventory ?? status.snapshot,
          }
        : null,
      scores: result.scores.map((score) => ({
        ...score,
        reviewers_complete:
          score.reviewers_complete ??
          (score.reviewers
            ? score.reviewers.length >= score.direct_reviewers
            : undefined),
      })),
      layers: result.layers,
      unavailable_scores: result.unavailable_scores,
    };
    this.rankCache.set(cacheKey, ranking);
    return ranking;
  }
  private rankRequest(
    session: string,
    word: string,
    reviewers: number,
  ): Promise<WorkerResponse & { type: "ranked" }> {
    if (!this.worker) return Promise.reject(new Error(CANCELLED));
    const id = ++this.sequence;
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: (reply) => {
          if (reply.type !== "ranked")
            reject(new Error("Unexpected worker reply."));
          else resolve(reply);
        },
        reject,
      });
      worker.postMessage({ type: "rank", id, session, word, reviewers });
    });
  }
  /**
   * Forgets the stored inventory as well, after the reader changed the signed
   * view. The next calculation syncs again and reads the view in use.
   */
  async forgetView() {
    this.invalidate();
    await forgetInventory(this.store).catch(() => null);
  }
  /** Forgets the loaded session after private choices or the identity change. */
  invalidate() {
    // The choices or the identity changed. A calculation in progress is
    // inert from here on, and the next call starts from the new choices.
    this.generation++;
    this.current?.abort.abort(new Error(CANCELLED));
    this.current = null;
    this.loadedKey = null;
    this.rankCache.clear();
    if (this.status.state !== "failed") this.set({ state: "idle" });
  }
}
