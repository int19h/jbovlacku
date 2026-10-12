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
type Message = WorkerRequest extends infer R
  ? R extends { id: number }
    ? Omit<R, "id">
    : never
  : never;
export class PersonalCalculator {
  private worker: Worker | null = null;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Set<Listener>();
  status: PersonalStatus = { state: "idle" };
  private loadedKey: string | null = null;
  private loading: Promise<PersonalStatus> | null = null;
  private rankCache = new Map<string, LocalRanking>();
  private abort: AbortController | null = null;
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
  private request(message: Message): Promise<WorkerResponse> {
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
  /** Stops any download or evaluation. The next calculation starts from the cache. */
  cancel() {
    this.abort?.abort(new Error("Cancelled."));
    this.abort = null;
    this.worker?.terminate();
    this.worker = null;
    for (const entry of this.pending.values())
      entry.reject(new Error("Cancelled."));
    this.pending.clear();
    this.loadedKey = null;
    this.loading = null;
    this.rankCache.clear();
    this.set({
      state: "failed",
      message: "The local calculation was cancelled.",
      kind: "cancelled",
    });
  }
  private async inventory(
    refresh: boolean,
    signal: AbortSignal,
  ): Promise<SnapshotInventory> {
    if (!refresh) {
      const cached = await latestInventory(this.store);
      if (cached) return cached;
    }
    return syncRecords(this.store, {
      signal,
      onProgress: (progress) => this.set({ state: "downloading", progress }),
    });
  }
  /**
   * Makes sure that a session for the current snapshot, mode, and overlay is
   * loaded. Concurrent callers share one load, and only the explicit Cancel
   * stops it. A refresh downloads the latest snapshot first.
   */
  async ensure(
    options: {
      mode?: CalculationMode;
      refresh?: boolean;
    } = {},
  ): Promise<PersonalStatus> {
    const mode = options.mode ?? "personal";
    if (this.loading) {
      const current = await this.loading;
      if (
        current.state === "ready" &&
        current.mode === mode &&
        !options.refresh
      )
        return current;
      if (current.state === "failed") return current;
    }
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
    const abort = new AbortController();
    this.abort = abort;
    this.loading = (async () => {
      try {
        let inventory: SnapshotInventory;
        try {
          inventory = await this.inventory(
            options.refresh ?? false,
            abort.signal,
          );
        } catch (error) {
          if (options.refresh || abort.signal.aborted) throw error;
          const cached = await latestInventory(this.store);
          if (!cached) throw error;
          inventory = cached;
        }
        const key = await this.key(inventory, mode);
        if (this.loadedKey === key && this.status.state === "ready")
          return this.status;
        const records = await loadRecords(this.store, inventory);
        const overlay =
          mode === "personal"
            ? await this.effective(inventory, records.bodies)
            : null;
        const digest = key.split("|")[2];
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
        const loaded = await this.request({ type: "load", input });
        if (loaded.type !== "loaded")
          throw new Error("Unexpected worker reply.");
        if (abort.signal.aborted) throw new Error("Cancelled.");
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
        const kind: PersonalStatus & { state: "failed" } extends {
          kind: infer K;
        }
          ? K
          : never =
          error instanceof RecordsError
            ? error.kind
            : /^Cancelled\.$/.test(message) || abort.signal.aborted
              ? "cancelled"
              : /fetch|network|answer|connection|timed out|HTTP/i.test(message)
                ? "network"
                : "worker";
        const status: PersonalStatus = {
          state: "failed",
          message:
            kind === "cancelled"
              ? "The local calculation was cancelled."
              : describe(error),
          kind,
        };
        this.loadedKey = null;
        this.set(status);
        return status;
      } finally {
        if (this.abort === abort) this.abort = null;
        this.loading = null;
      }
    })();
    return this.loading;
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
  /** Ranks one word under the loaded session for the mode. */
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
    const cacheKey = `${mode}|${word}`;
    const cached = this.rankCache.get(cacheKey);
    if (cached) return cached;
    const reply = await this.request({ type: "rank", word });
    if (reply.type !== "ranked") throw new Error("Unexpected worker reply.");
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
        reviewers_complete: score.reviewers
          ? score.reviewers.length >= score.direct_reviewers
          : undefined,
      })),
      layers: result.layers,
      unavailable_scores: result.unavailable_scores,
    };
    this.rankCache.set(cacheKey, ranking);
    return ranking;
  }
  /** Forgets the loaded session after private choices or the identity change. */
  invalidate() {
    this.loadedKey = null;
    this.rankCache.clear();
    if (this.status.state === "ready") this.set({ state: "idle" });
  }
}
