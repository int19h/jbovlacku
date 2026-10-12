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
/** What the overlay needs from the session: the identity and its effective public shuns. */
export interface OverlayContext {
  identity: string | null;
  shuns: { identity: string; scope: TrustScope }[];
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
 * The overlay as the core expects it. The current identity becomes a root with
 * q=1 only when the view names no allocation for it. Public shuns of the
 * current identity become local blocks, as the format specifies.
 */
export function effectiveOverlay(
  overlay: Overlay,
  baseView: string,
  context: OverlayContext,
  viewRoots: string[],
): Overlay {
  const rootChanges = overlay.root_changes.map((r) => ({
    identity: r.identity,
    q: r.q,
  }));
  const { identity } = context;
  if (
    identity &&
    !viewRoots.includes(identity) &&
    !rootChanges.some((r) => r.identity === identity)
  )
    rootChanges.push({ identity, q: { numerator: 1, denominator: 1 } });
  const blocked = [
    ...overlay.blocked.map((entry) => ({
      identity: entry.identity,
      scope: entry.scope,
    })),
    ...context.shuns.map((entry) => ({
      identity: entry.identity,
      scope: entry.scope,
    })),
  ];
  const scopeKey = (scope: TrustScope) =>
    `${scope.kind}|${scope.word}|${scope.language}`;
  return {
    version: 1,
    base_view: baseView,
    root_changes: sortedUnique(rootChanges, (r) => r.identity),
    trust: sortedUnique(
      overlay.trust
        .filter((rule) => /^ed25519:/.test(rule.issuer))
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
export function overlayDigest(overlay: Overlay | null): string {
  return contentHash(utf8(canonicalize(utf8(JSON.stringify(overlay)))));
}
type Pending = {
  resolve: (value: WorkerResponse) => void;
  reject: (error: Error) => void;
};
/** One calculation run. Every asynchronous step checks that its run is still the current one. */
interface Run {
  id: number;
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
  /**
   * True after Cancel until the user asks for a calculation again. An
   * automatic call from a page never restarts a cancelled calculation.
   */
  private cancelled = false;
  constructor(
    private store: LocalStore,
    private context: () => Promise<OverlayContext>,
  ) {}
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
    if (options.refresh) this.cancelled = false;
    while (this.loading) {
      const asked = this.loadingRequest;
      const current = await this.loading;
      if (
        current.state === "ready" &&
        current.mode === mode &&
        !options.refresh
      )
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
        !options.refresh
      )
        return current;
    }
    if (this.cancelled && !options.refresh) return this.status;
    if (
      this.status.state === "ready" &&
      this.status.mode === mode &&
      !options.refresh &&
      this.loadedKey
    ) {
      // The overlay can change between calls. Compare before reusing the session.
      const inventory = await latestInventory(this.store);
      if (inventory && (await this.key(inventory, mode)) === this.loadedKey)
        return this.status;
    }
    const run: Run = { id: ++this.runs, abort: new AbortController() };
    this.current?.abort.abort(new Error(CANCELLED));
    this.current = run;
    const promise = this.run(run, mode, options.refresh ?? false);
    this.loading = promise;
    this.loadingRequest = { mode, refresh: options.refresh ?? false };
    try {
      return await promise;
    } finally {
      if (this.loading === promise) {
        this.loading = null;
        this.loadingRequest = null;
      }
    }
  }
  /** One calculation. Nothing here touches shared state after the run stops being current. */
  private async run(
    run: Run,
    mode: CalculationMode,
    refresh: boolean,
  ): Promise<PersonalStatus> {
    const live = () => {
      if (this.current !== run || run.abort.signal.aborted)
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
      const key = await this.key(inventory, mode);
      live();
      if (this.loadedKey === key && this.status.state === "ready")
        return this.status;
      const records = await loadRecords(this.store, inventory, {
        signal: run.abort.signal,
      });
      live();
      const overlay =
        mode === "personal"
          ? await this.effective(inventory, records.bodies)
          : null;
      live();
      const digest = key.split("|")[2];
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
  ): Promise<Overlay> {
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
      await this.context(),
      viewRoots,
    );
  }
  private async key(
    inventory: SnapshotInventory,
    mode: CalculationMode,
  ): Promise<string> {
    const digest =
      mode === "personal"
        ? overlayDigest(
            await this.effective(inventory, {
              [inventory.view]:
                (
                  await this.store.get<{ body: string | null }>(
                    "records",
                    inventory.view,
                  )
                )?.body ?? "",
            }),
          )
        : nullOverlayDigest();
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
  /** Forgets the loaded session after private choices or the identity change. */
  invalidate() {
    this.loadedKey = null;
    this.rankCache.clear();
    if (this.status.state === "ready") this.set({ state: "idle" });
  }
}
