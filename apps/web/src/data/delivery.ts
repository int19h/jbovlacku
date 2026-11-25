/**
 * Delivery of signed records to peers. Records are immutable. Retry sends the
 * identical bytes. Each peer has its own receipt and schedule. Every outcome is
 * merged into current storage so a stop or another tab's write survives.
 */
import {
  canonicalize,
  contentHash,
  utf8,
  verifyEnvelope,
} from "../../../../packages/core/src/browser.ts";
import {
  getReceipt,
  transientReceiptFailure,
  forgetMaterializedReceipt,
  MaterializationPendingError,
  receiptBindingMatches,
  receiptMaterialized,
  viewPending,
  waitForMaterialization,
  localPeer,
  objectBytes,
  postEvent,
  rememberAcceptedReceipt,
  RequestError,
  TransportError,
  type Peer,
} from "./api.ts";
import type {
  LocalStore,
  OutboxItem,
  PeerDelivery,
  PeerState,
} from "./store.ts";
import type { Envelope, Receipt, Transport } from "../model/types.ts";

const REFUSAL_STATUSES = [400, 403, 404, 405, 409, 413, 422, 451];
const BASE_DELAY = 15000;
const MAX_DELAY = 30 * 60 * 1000;
const MAX_TIMER_DELAY = 2 ** 31 - 1;

/** Stop the page wait even when a storage operation stalls. */
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let aborted = () => {};
  const stopped = new Promise<never>((_, reject) => {
    aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    signal.removeEventListener("abort", aborted);
  }
}

export function freshPeer(): PeerDelivery {
  return {
    state: "queued",
    attempts: 0,
    lastAttempt: null,
    nextAttempt: Date.now(),
    error: null,
    failure: null,
    receipt: null,
  };
}
/** True when the record has unfinished delivery at any selected peer and is not stopped. */
export function isActive(item: OutboxItem): boolean {
  return (
    !item.stopped &&
    Object.values(item.peers).some((p) => p.state !== "accepted")
  );
}
export function isFinished(item: OutboxItem): boolean {
  return Object.values(item.peers).every((p) => p.state === "accepted");
}
/** Visible failures exclude a first online send that still has no outcome. */
export function isNotDelivered(
  item: OutboxItem,
  online = navigator.onLine,
): boolean {
  return (
    (item.stopped && !isFinished(item)) ||
    (isActive(item) &&
      (!online ||
        Object.values(item.peers).some(
          (peer) =>
            peer.state !== "accepted" &&
            (peer.state !== "queued" ||
              peer.attempts > 0 ||
              peer.failure !== null),
        )))
  );
}
/** True only when every record reached every selected recipient. */
export function deliveryAccepted(
  items: { peers: Record<string, { state: string }> }[],
): boolean {
  return (
    items.length > 0 &&
    items.every((item) => {
      const peers = Object.values(item.peers);
      return (
        peers.length > 0 && peers.every((peer) => peer.state === "accepted")
      );
    })
  );
}
export function unfinishedPeers(item: OutboxItem): string[] {
  return Object.entries(item.peers)
    .filter(([, p]) => p.state !== "accepted")
    .map(([id]) => id);
}
/** Whether the transport includes a body that the receipt must confirm. */
export function requiresBody(transport: string): boolean {
  return (JSON.parse(transport) as Transport).body !== null;
}
/** Hash of the exact stored envelope bytes, as the server reports it. */
export function storedEnvelopeHash(transport: string): string {
  const envelope = (JSON.parse(transport) as Transport).envelope;
  return contentHash(utf8(canonicalize(utf8(JSON.stringify(envelope)))));
}
export type Classified = {
  state: PeerState;
  error: string | null;
  verifyReceipt?: true;
};
/**
 * Interprets a receipt for an item. Delivery completes only when the receipt
 * names the stored envelope, or an authenticated equivalent variant of it, and
 * the required body hash. A receipt that cannot establish those matches leaves
 * delivery unknown.
 */
export async function classifyReceipt(
  item: OutboxItem,
  receipt: Receipt,
  fetchVariant: (id: string) => Promise<Uint8Array>,
): Promise<Classified> {
  if (receipt.id !== item.id)
    return {
      state: "unknown",
      error:
        "The server returned a receipt for another record. Delivery remains unknown.",
    };
  if (receipt.admission === "refused")
    return {
      state: "refused",
      error: `This server refused the record: ${receipt.reasons.join(", ") || "no reason given"}.`,
    };
  const transport = JSON.parse(item.transport) as Transport;
  const envelopeHash = storedEnvelopeHash(item.transport);
  if (typeof receipt.envelope_hash !== "string")
    return {
      state: "unknown",
      error:
        "The receipt does not name the stored envelope. Delivery remains unknown.",
    };
  if (receipt.envelope_hash !== envelopeHash) {
    // The server can retain an equivalent valid signature variant. Fetch it and
    // require the same signed header before accepting the different hash.
    let bytes: Uint8Array;
    try {
      bytes = await fetchVariant(item.id);
    } catch {
      return {
        state: "unknown",
        error: "The browser could not read the envelope named by the receipt.",
        verifyReceipt: true,
      };
    }
    if (!isEquivalentVariant(transport.envelope, receipt.envelope_hash, bytes))
      return {
        state: "unknown",
        error:
          "The receipt names an envelope that does not match the stored record. Delivery remains unknown.",
      };
  }
  if (transport.body !== null) {
    const required = transport.envelope.header.content?.hash ?? null;
    if (receipt.body_status === "present") {
      if (
        typeof receipt.body_hash !== "string" ||
        receipt.body_hash !== required
      )
        return {
          state: "unknown",
          error:
            "The receipt does not confirm the submitted body hash. Delivery remains unknown.",
        };
      return { state: "accepted", error: null };
    }
    if (receipt.body_status === "withheld" || receipt.body_status === "invalid")
      return {
        state: "refused",
        error: `The server stored the signed header but refused its body (${receipt.body_status}).`,
      };
    return {
      state: "missing-body",
      error:
        "The server stored the signed header without its body. The complete record will be sent again.",
    };
  }
  if (receipt.body_status !== "none")
    return {
      state: "unknown",
      error:
        "The receipt reports a body for a record that has none. Delivery remains unknown.",
    };
  return { state: "accepted", error: null };
}
function isEquivalentVariant(
  stored: Envelope,
  claimedHash: string,
  bytes: Uint8Array,
): boolean {
  try {
    if (contentHash(utf8(canonicalize(bytes))) !== claimedHash) return false;
    verifyEnvelope(bytes);
    const variant = JSON.parse(canonicalize(bytes)) as Envelope;
    const headerOf = (envelope: Envelope) =>
      canonicalize(utf8(JSON.stringify(envelope.header)));
    return variant.id === stored.id && headerOf(variant) === headerOf(stored);
  } catch {
    return false;
  }
}
export function backoff(attempts: number, retryAfterMs: number | null): number {
  const exponential = Math.min(
    BASE_DELAY * 2 ** Math.max(0, attempts - 1),
    MAX_DELAY,
  );
  const delay = retryAfterMs ?? 0;
  return Number.isSafeInteger(delay) && Number.isSafeInteger(Date.now() + delay)
    ? Math.max(exponential, delay)
    : exponential;
}
/** Plain description of a peer state for the Not delivered page. */
export function describePeer(peer: PeerDelivery): string {
  if (peer.failure === "unresolved")
    return `${peer.error ?? "The recipient is not configured in this browser."} The signed bytes are kept here.`;
  if (peer.verifyReceipt)
    return "The result is unconfirmed. Receipt verification is pending.";
  switch (peer.state) {
    case "accepted":
      return "Delivered.";
    case "queued":
      if (peer.sendStarted !== undefined)
        return "A send started. Its outcome is not confirmed yet.";
      return peer.attempts === 0
        ? "Waiting to send."
        : "Waiting to send again.";
    case "unknown":
      if (peer.failure === "offline")
        return "No connection to the server. The client asks whether the record arrived before it sends the same bytes again.";
      if (peer.failure === "timeout")
        return "The server did not answer. The client asks whether the record arrived before it sends the same bytes again.";
      return `${peer.error ?? "The outcome is unknown."} The client asks whether the record arrived before it sends the same bytes again.`;
    case "missing-body":
      return peer.error ?? "The server has the header without its body.";
    case "refused":
      return `${peer.error ?? "The server refused this record."} Retries are paused until you try again.`;
  }
}
export type DeliveryListener = (items: OutboxItem[]) => void;
/** The peer saved with the record for one recipient, or null without saved address evidence. */
export function savedPeer(item: OutboxItem, peerId: string): Peer | null {
  const saved = item.recipients?.[peerId];
  if (!saved) return null;
  return {
    id: peerId,
    base: `${saved.origin}${saved.base}`,
    label: saved.label,
  };
}
/** The label of a recipient from the record's saved address. */
export function recipientLabel(item: OutboxItem, peerId: string): string {
  return (
    item.recipients?.[peerId]?.label ??
    `recipient "${peerId}" without a saved address`
  );
}
/** True when no attempt stored an outcome or a send mark since `seen` was read. */
export function unchangedSince(
  stored: PeerDelivery,
  seen: PeerDelivery,
): boolean {
  return (
    stored.attempt === seen.attempt && stored.sendAttempt === seen.sendAttempt
  );
}
/**
 * Merges the outcome of one attempt with the peer state stored meanwhile.
 * `seen` is the state the attempt read and `attempt` is its random ID. An
 * accepted state always stays. An acceptance from a valid receipt always
 * applies. Any other outcome applies only while this attempt's own send
 * mark is stored, or when no other attempt stored an outcome or a mark
 * since `seen` was read. Attempt counters never go down.
 */
export function mergePeer(
  stored: PeerDelivery,
  next: PeerDelivery,
  seen: PeerDelivery,
  attempt: string,
): PeerDelivery {
  const attempts = Math.max(stored.attempts, next.attempts);
  if (stored.state === "accepted" && next.state !== "accepted") return stored;
  if (next.state === "accepted") return { ...next, attempts };
  if (stored.sendAttempt === attempt || unchangedSince(stored, seen))
    return { ...next, attempts };
  return { ...stored, attempts };
}

type PendingReceipt = {
  outcome: PeerDelivery;
  seen: PeerDelivery;
  attempt: string;
};

export class DeliveryEngine {
  private profileCompletions?: Set<string>;
  private profileSkipped?: Set<string>;
  private profileWarnings?: Set<string>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scheduleGeneration = 0;
  private listRetryAt = 0;
  private recordRetryAt = new Map<string, number>();
  private pendingReceipts = new Map<string, Map<string, PendingReceipt>>();
  private listeners = new Set<DeliveryListener>();
  private readErrors = new Map<DeliveryListener, (error: unknown) => void>();
  private inFlight = new Map<string, Promise<OutboxItem | undefined>>();
  constructor(private store: LocalStore) {
    window.addEventListener("online", () => {
      void this.notify().catch(() => {});
      void this.tick();
    });
    window.addEventListener("offline", () => {
      this.setTimer();
      void this.notify().catch(() => {});
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void this.tick();
    });
  }
  subscribe(
    listener: DeliveryListener,
    onReadError?: (error: unknown) => void,
  ) {
    this.listeners.add(listener);
    if (onReadError) this.readErrors.set(listener, onReadError);
    void this.items()
      .then(listener, (error) =>
        onReadError ? onReadError(error) : listener([]),
      )
      .catch(() => {});
    return () => {
      this.listeners.delete(listener);
      this.readErrors.delete(listener);
    };
  }
  private async notify() {
    let items: OutboxItem[] = [];
    let readFailure: { error: unknown } | undefined;
    try {
      items = await this.items();
    } catch (error) {
      readFailure = { error };
    }
    let listenerFailure: { error: unknown } | undefined;
    for (const listener of this.listeners) {
      try {
        const onReadError = this.readErrors.get(listener);
        const result =
          readFailure && onReadError
            ? onReadError(readFailure.error)
            : listener(items);
        void Promise.resolve(result).catch(() => {});
      } catch (error) {
        listenerFailure ??= { error };
      }
    }
    if (listenerFailure) throw listenerFailure.error;
  }
  /** Reads every record from storage. Other tabs can write at any time, so nothing is cached. */
  async items(): Promise<OutboxItem[]> {
    const items = await this.store.list<OutboxItem>("outbox");
    return items.sort(
      (a, b) =>
        a.signedAt - b.signedAt ||
        a.group.localeCompare(b.group) ||
        a.order - b.order,
    );
  }
  /** True means that the next profile read needs current server data. */
  async restorePendingProfileReceipts(
    identity: string,
    options: {
      signal?: AbortSignal;
      checking?: () => void;
      pending?: () => void;
      invalidate?: () => void;
      unconfirmable?: () => void;
    } = {},
  ): Promise<boolean> {
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(15000),
      ...(options.signal ? [options.signal] : []),
    ]);
    let current = false;
    const seen = (this.profileCompletions ??= new Set<string>());
    const skipped = (this.profileSkipped ??= new Set<string>());
    const warned = (this.profileWarnings ??= new Set<string>());
    const keys = new Map<string, { receipt: Receipt; key: string }>();
    const observe = (key: string, receipt: Receipt, newlyChecked = false) => {
      forgetMaterializedReceipt(receipt);
      if (newlyChecked || !seen.has(key)) {
        current = true;
        options.invalidate?.();
      }
      seen.add(key);
    };
    const finish = async (
      receipt: Receipt,
      key: string,
      unconfirmable = false,
    ) => {
      signal.throwIfAborted();
      try {
        await this.store.put(
          "prefs",
          key,
          unconfirmable ? "unconfirmable" : true,
        );
      } catch {
        signal.throwIfAborted();
        // Retry the same evidence. A failed write does not change the outcome.
        skipped.add(key);
        try {
          await this.store.put(
            "prefs",
            key,
            unconfirmable ? "unconfirmable" : true,
          );
        } catch {
          /* Skip in this session if storage cannot retain the marker. */
        }
      }
      signal.throwIfAborted();
      observe(key, receipt, true);
      if (unconfirmable && !warned.has(key)) {
        warned.add(key);
        options.unconfirmable?.();
      }
    };
    const restore = async () => {
      let items: OutboxItem[];
      try {
        items = await this.items();
      } catch {
        signal.throwIfAborted();
        return false;
      }
      const candidates = items.flatMap((item) => {
        // Filter saved issuer and action before decoding potentially large bodies.
        if (!item || item.identity !== identity) return [];
        if (typeof item.transport !== "string") return [];
        if (!item.transport.includes('"identity.profile"')) return [];
        try {
          const transport = JSON.parse(item.transport) as Transport;
          if (!transport || !Object.hasOwn(transport, "body"))
            throw new Error("The stored profile has no body field.");
          const { envelope } = transport;
          if (
            envelope.header.issuer !== identity ||
            envelope.header.action.kind !== "identity.profile"
          )
            return [];
          return Object.entries(item.peers).flatMap(([id, peer]) => {
            const target = savedPeer(item, id);
            return target &&
              localPeer(target) &&
              peer.state === "accepted" &&
              peer.receipt &&
              viewPending(peer.receipt)
              ? [{ item, target, receipt: peer.receipt }]
              : [];
          });
        } catch {
          return [];
        }
      });
      signal.throwIfAborted();
      if (candidates.length) options.checking?.();
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, candidates.length) }, async () => {
          for (;;) {
            signal.throwIfAborted();
            const candidate = candidates[next++];
            if (!candidate) return;
            const { item, target, receipt } = candidate;
            let key: string;
            try {
              key =
                "profile-materialized:" +
                contentHash(
                  utf8(
                    JSON.stringify([
                      new URL(target.base, location.origin).href.replace(
                        /\/$/,
                        "",
                      ),
                      receipt.id,
                      receipt.envelope_hash,
                      receipt.body_hash ?? null,
                      receipt.body_status,
                      receipt.cursor,
                      storedEnvelopeHash(item.transport),
                      (JSON.parse(item.transport) as Transport).envelope.header
                        .content?.hash ?? null,
                    ]),
                  ),
                );
            } catch {
              continue;
            }
            if (skipped.has(key)) {
              observe(key, receipt);
              continue;
            }
            let marker: unknown;
            try {
              marker = await this.store.get<unknown>("prefs", key);
            } catch {
              signal.throwIfAborted();
              skipped.add(key);
              observe(key, receipt);
              continue;
            }
            signal.throwIfAborted();
            if (marker === true || marker === "unconfirmable") {
              observe(key, receipt);
              continue;
            }
            let classified: Classified;
            for (;;) {
              let variantError: unknown;
              classified = await classifyReceipt(
                item,
                receipt,
                async (event) => {
                  try {
                    return await objectBytes(
                      `/events/${encodeURIComponent(event)}`,
                      20480,
                      { peer: target, signal },
                    );
                  } catch (error) {
                    variantError = error;
                    throw error;
                  }
                },
              );
              signal.throwIfAborted();
              if (!variantError) break;
              if (!transientReceiptFailure(variantError)) break;
              await abortable(
                new Promise<void>((resolve) => setTimeout(resolve, 200)),
                signal,
              );
            }
            signal.throwIfAborted();
            if (classified.state !== "accepted") {
              await finish(receipt, key, true);
              continue;
            }
            keys.set(receipt.id, { receipt, key });
            let live: Receipt;
            try {
              live = await getReceipt(item.id, {
                peer: target,
                signal,
                cache: "no-store",
              });
            } catch (error) {
              signal.throwIfAborted();
              if (!transientReceiptFailure(error)) {
                await finish(receipt, key, true);
                continue;
              }
              rememberAcceptedReceipt(receipt, target);
              current = true;
              continue;
            }
            if (receiptMaterialized(live, receipt)) await finish(receipt, key);
            else if (
              !receiptBindingMatches(live, receipt) ||
              !viewPending(live)
            )
              await finish(receipt, key, true);
            else {
              rememberAcceptedReceipt(receipt, target);
              current = true;
              options.pending?.();
            }
          }
        }),
      );
      const terminal = async (accepted: Receipt, unconfirmable = false) => {
        const saved = keys.get(accepted.id);
        if (saved && receiptBindingMatches(accepted, saved.receipt))
          await finish(accepted, saved.key, unconfirmable);
      };
      await waitForMaterialization(
        { signal },
        {
          signal,
          receipts: new Set([...keys.values()].map(({ receipt }) => receipt)),
          completed: (accepted) => terminal(accepted),
          unconfirmable: (accepted) => terminal(accepted, true),
        },
      );
      signal.throwIfAborted();
      return current;
    };
    try {
      return await abortable(restore(), signal);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (signal.aborted || transientReceiptFailure(error))
        throw new MaterializationPendingError();
      return current;
    } finally {
      controller.abort();
    }
  }
  async active(): Promise<OutboxItem[]> {
    return (await this.items()).filter(isActive);
  }
  async stopped(): Promise<OutboxItem[]> {
    return (await this.items()).filter(
      (item) => item.stopped && !isFinished(item),
    );
  }
  /** Reads one record from storage, bypassing the cache. */
  private async fresh(id: string): Promise<OutboxItem | undefined> {
    return this.store.get<OutboxItem>("outbox", id);
  }
  /** Drops the cached list after an external write and tells listeners. */
  async invalidate() {
    try {
      await this.notify();
    } finally {
      void this.tick();
    }
  }
  /** Starts the retry loop. Called after the app has storage. */
  start() {
    void this.tick();
  }
  isDelivering(id: string): boolean {
    return this.inFlight.has(id);
  }
  needsReceipt(item: OutboxItem, peerId: string): boolean {
    const peer = item.peers[peerId];
    return (
      !item.stopped &&
      peer.state !== "accepted" &&
      peer.failure !== "unresolved" &&
      (peer.verifyReceipt === true ||
        this.pendingReceipt(item.id, peerId, peer) !== undefined ||
        (peer.state === "queued" &&
          peer.sendStarted !== undefined &&
          !this.isDelivering(item.id)))
    );
  }
  isNotDelivered(item: OutboxItem): boolean {
    return (
      isNotDelivered(item) ||
      (isActive(item) && this.recordRetryAt.has(item.id)) ||
      Object.keys(item.peers).some((peerId) => this.needsReceipt(item, peerId))
    );
  }
  nextTryAt(item: OutboxItem, peerId: string): number | null {
    const due = Math.max(
      this.listRetryAt,
      this.dueAt(item.id, peerId, item.peers[peerId]),
    );
    return !item.stopped && !this.isDelivering(item.id) && Number.isFinite(due)
      ? due
      : null;
  }
  private pendingReceipt(id: string, peerId: string, peer: PeerDelivery) {
    const pending = this.pendingReceipts.get(id)?.get(peerId);
    if (
      pending &&
      (peer.sendAttempt === pending.attempt ||
        unchangedSince(peer, pending.seen))
    )
      return pending;
  }
  private setTimer(delay?: number) {
    this.scheduleGeneration++;
    clearTimeout(this.timer);
    this.timer =
      delay !== undefined && navigator.onLine
        ? setTimeout(() => void this.tick(), Math.min(delay, MAX_TIMER_DELAY))
        : undefined;
  }
  /** Retry in this tab even when storage cannot supply a new retry time. */
  private deferListRead() {
    this.listRetryAt = Date.now() + BASE_DELAY;
    this.setTimer(BASE_DELAY);
  }
  private schedule() {
    if (!navigator.onLine) {
      this.setTimer();
      return;
    }
    // A newer schedule or a storage failure can set a timer during this read.
    const generation = ++this.scheduleGeneration;
    void this.items()
      .then((items) => {
        if (generation !== this.scheduleGeneration) return;
        let next = Infinity;
        const present = new Set<string>();
        for (const item of items) {
          if (!isFinished(item)) present.add(item.id);
          if (!isActive(item)) continue;
          for (const [peerId, peer] of Object.entries(item.peers))
            next = Math.min(next, this.dueAt(item.id, peerId, peer));
        }
        for (const id of this.recordRetryAt.keys())
          if (!present.has(id)) this.recordRetryAt.delete(id);
        for (const id of this.pendingReceipts.keys())
          if (!present.has(id)) this.pendingReceipts.delete(id);
        const due = Math.max(next, this.listRetryAt);
        this.setTimer(
          due === Infinity ? undefined : Math.max(250, due - Date.now()),
        );
      })
      .catch(() => {
        if (generation === this.scheduleGeneration) this.deferListRead();
      });
  }
  /** The next automatic attempt. A pending receipt permits a read only. */
  private dueAt(id: string, peerId: string, peer: PeerDelivery): number {
    if (peer.state === "accepted" || peer.failure === "unresolved")
      return Infinity;
    const delayed = this.recordRetryAt.get(id) ?? 0;
    if (this.pendingReceipt(id, peerId, peer)) return delayed;
    if (peer.state === "refused" || peer.nextAttempt === null) return Infinity;
    return Math.max(
      delayed,
      Number.isFinite(peer.nextAttempt) ? peer.nextAttempt : 0,
    );
  }
  /** Sends every record with a due peer, in group order. */
  async tick() {
    if (!navigator.onLine) {
      this.setTimer();
      return;
    }
    const now = Date.now();
    if (now < this.listRetryAt) {
      this.setTimer(this.listRetryAt - now);
      return;
    }
    let items: OutboxItem[];
    try {
      items = await this.items();
    } catch {
      this.deferListRead();
      return;
    }
    for (const item of items) {
      if (!navigator.onLine) break;
      if (
        isActive(item) &&
        Object.entries(item.peers).some(
          ([peerId, peer]) => this.dueAt(item.id, peerId, peer) <= now,
        )
      ) {
        // A failed record delays its own group. The other groups stay due.
        await this.deliver(item.id, false).catch(() => {});
      }
    }
    this.schedule();
  }
  /**
   * Delivers one record. Automatic delivery follows each peer's own schedule
   * and skips stopped records and unresolved peers. Refused peers allow
   * only pending receipt lookups. An explicit attempt runs now.
   */
  async deliver(
    id: string,
    explicit: boolean,
  ): Promise<OutboxItem | undefined> {
    // A second caller waits for the attempt in progress instead of racing it.
    const running = this.inFlight.get(id);
    if (running) return running;
    this.recordRetryAt.delete(id);
    const work = this.deliverNow(id, explicit)
      .catch((error) => {
        this.scheduleGeneration++;
        const delay = backoff(
          1,
          error instanceof RequestError ? error.retryAfterMs : null,
        );
        this.recordRetryAt.set(id, Date.now() + delay);
        throw error;
      })
      .finally(() => {
        this.inFlight.delete(id);
        if (explicit) this.schedule();
        if (this.listeners.size) void this.notify().catch(() => {});
      });
    this.inFlight.set(id, work);
    return work;
  }
  private async deliverNow(
    id: string,
    explicit: boolean,
  ): Promise<OutboxItem | undefined> {
    let item = await this.fresh(id);
    if (!item) return undefined;
    // navigator.onLine is only a hint. An attempt always runs, so a
    // reachable server still receives the record when the browser
    // reports offline. A network failure decides the outcome below.
    // Earlier records of the same group go first so dependencies arrive in order.
    const earlier = (await this.items()).filter(
      (other) =>
        other.group === item!.group &&
        other.order < item!.order &&
        isActive(other),
    );
    for (const dependency of earlier) {
      const delayed = this.recordRetryAt.get(dependency.id) ?? 0;
      if (!explicit && delayed > Date.now()) {
        this.recordRetryAt.set(id, delayed);
        return item;
      }
      await this.deliver(dependency.id, explicit);
    }
    item = (await this.fresh(id)) ?? item;
    const now = Date.now();
    let failure: { error: unknown } | undefined;
    for (const peerId of Object.keys(item.peers)) {
      const current = await this.fresh(id);
      if (!current) return undefined;
      const peer = current.peers[peerId];
      if (!peer || peer.state === "accepted") continue;
      if (!explicit && (current.stopped || this.dueAt(id, peerId, peer) > now))
        continue;
      const started = Date.now();
      // Random, so two attempts that start in the same millisecond differ.
      const attemptId = crypto.randomUUID();
      try {
        const next = await this.attempt(
          current,
          peerId,
          peer,
          started,
          attemptId,
        );
        // Null means that this attempt sent nothing and has no outcome to save.
        if (next) await this.saveOutcome(id, peerId, peer, next, attemptId);
        await this.notify();
      } catch (error) {
        // Other recipients of this record can still have work due.
        failure ??= { error };
      }
    }
    if (failure) throw failure.error;
    return this.fresh(id);
  }
  private async saveOutcome(
    id: string,
    peerId: string,
    peer: PeerDelivery,
    next: PeerDelivery,
    attemptId: string,
  ) {
    // Keep a stop, another tab's acceptance, or a newer retry decision.
    try {
      await this.store.mergeOutbox(id, (stored) => ({
        ...stored,
        peers: {
          ...stored.peers,
          [peerId]: stored.peers[peerId]
            ? mergePeer(stored.peers[peerId], next, peer, attemptId)
            : next,
        },
      }));
    } catch (error) {
      if (
        next.state === "accepted" ||
        next.state === "refused" ||
        next.verifyReceipt
      ) {
        let receipts = this.pendingReceipts.get(id);
        if (!receipts) this.pendingReceipts.set(id, (receipts = new Map()));
        receipts.set(peerId, {
          outcome: next,
          seen: peer,
          attempt: attemptId,
        });
        this.scheduleGeneration++;
      }
      throw error;
    }
    const receipts = this.pendingReceipts.get(id);
    receipts?.delete(peerId);
    if (receipts?.size === 0) this.pendingReceipts.delete(id);
  }
  private async attempt(
    item: OutboxItem,
    peerId: string,
    peer: PeerDelivery,
    started: number,
    attemptId: string,
  ): Promise<PeerDelivery | null> {
    const target = savedPeer(item, peerId);
    if (!target)
      return {
        ...peer,
        nextAttempt: null,
        error: `Recipient "${peerId}" is not configured in this record. The record saved no address for it, and current preferences never replace a missing address. Nothing was sent.`,
        failure: "unresolved",
        attempt: attemptId,
      };
    const attempts = peer.attempts + 1;
    const pending = this.pendingReceipt(item.id, peerId, peer);
    const fetchVariant = (id: string) =>
      objectBytes(`/events/${encodeURIComponent(id)}`, 20480, {
        peer: target,
      });
    const settle = async (receipt: Receipt): Promise<PeerDelivery> => {
      const { state, error, verifyReceipt } = await classifyReceipt(
        item,
        receipt,
        fetchVariant,
      );
      if (state === "accepted") rememberAcceptedReceipt(receipt, target);
      return {
        state,
        attempts,
        lastAttempt: started,
        nextAttempt:
          state === "accepted" || state === "refused"
            ? null
            : started + backoff(attempts, null),
        error,
        failure:
          state === "refused"
            ? "refused"
            : state === "unknown"
              ? "server"
              : null,
        receipt,
        attempt: attemptId,
        ...(state === "unknown" && (verifyReceipt || peer.verifyReceipt)
          ? { verifyReceipt: true }
          : {}),
      };
    };
    // Set just before the POST starts. Before that point only receipt and
    // event reads have run, and they change nothing on a server.
    let posted = false;
    try {
      // After an unknown or refused outcome, ask whether the record
      // arrived before sending again. While the browser reports offline,
      // a queued record is looked up first too, so that a failed lookup
      // shows that the POST was never sent. No peer is rewritten first.
      if (
        pending ||
        peer.verifyReceipt ||
        peer.state === "unknown" ||
        peer.state === "missing-body" ||
        peer.state === "refused" ||
        peer.sendStarted !== undefined ||
        !navigator.onLine
      ) {
        let receipt: Receipt | undefined;
        const neverSent =
          peer.state === "queued" && peer.sendStarted === undefined;
        try {
          receipt = await getReceipt(item.id, { peer: target });
        } catch (error) {
          const notFound =
            error instanceof RequestError && error.status === 404;
          // A queued record was never sent, so its lookup only checks the
          // connection. An error answer, or an answer without a usable
          // receipt, lets the POST go ahead. Only a valid receipt can show
          // that the record was delivered.
          const answered =
            neverSent &&
            !(error instanceof TransportError) &&
            !(error instanceof DOMException && error.name === "AbortError");
          if (notFound && pending?.outcome.state === "refused")
            return { ...pending.outcome, attempt: attemptId };
          if (pending || peer.verifyReceipt || (!notFound && !answered))
            throw error;
        }
        if (receipt) {
          const settled = await settle(receipt);
          if (settled.state === "accepted" || settled.state === "refused")
            return settled;
          if (pending)
            throw new Error(
              settled.error ?? "Receipt verification is pending.",
            );
          if (
            settled.state === "unknown" &&
            (!neverSent || settled.verifyReceipt)
          )
            return settled;
        }
      }
      // Store that delivery is uncertain before the POST starts. If the page
      // closes while the request is open, the next attempt in any tab then
      // asks for the receipt before it sends again. A first send stays
      // queued, so it shows neutral progress. Any other outcome becomes
      // unknown with an attempt due, so a refusal does not stay on view
      // for a record that may have arrived. The merge keeps an accepted
      // state and any state from a later attempt.
      //
      // The same transaction decides whether this attempt may send. It may
      // not when the record is accepted, or when another attempt stored an
      // outcome or its own send mark since this attempt read the record.
      // That other attempt then owns the outcome, and this one sends
      // nothing and stores nothing.
      let maySend = false;
      await this.store.mergeOutbox(item.id, (stored) => {
        maySend = false;
        const current = stored.peers[peerId];
        if (
          !current ||
          current.state === "accepted" ||
          !unchangedSince(current, peer)
        )
          return stored;
        maySend = true;
        const mark = { sendAttempt: attemptId, sendStarted: started };
        return {
          ...stored,
          peers: {
            ...stored.peers,
            [peerId]:
              current.state === "queued"
                ? { ...current, ...mark }
                : {
                    ...current,
                    state: "unknown",
                    attempts: Math.max(current.attempts, attempts),
                    lastAttempt: started,
                    nextAttempt: started,
                    error: "A send started. Its outcome is unknown.",
                    failure: null,
                    ...mark,
                  },
          },
        };
      });
      if (!maySend) return null;
      // Open pages show the mark, for example the saved publication row.
      await this.notify().catch(() => {});
      posted = true;
      const receipt = await postEvent(item.transport, { peer: target });
      return await settle(receipt);
    } catch (error) {
      if (pending) throw error;
      // A failed lookup or read before the POST is not an answer about the
      // record, even when the status is one that refuses a POST. It is
      // retried after the backoff. A refusal, or a record whose earlier POST
      // may have arrived, becomes unknown, so the retry asks again.
      if (error instanceof RequestError && !posted)
        return {
          state:
            peer.state === "refused" || peer.sendStarted !== undefined
              ? "unknown"
              : peer.state,
          attempts,
          lastAttempt: started,
          nextAttempt: started + backoff(attempts, error.retryAfterMs),
          error: `${error.message}${error.code ? ` (${error.code})` : ""}`,
          failure: "server",
          receipt: peer.receipt,
          attempt: attemptId,
          ...(peer.verifyReceipt ? { verifyReceipt: true } : {}),
        };
      if (error instanceof RequestError) {
        const refused = REFUSAL_STATUSES.includes(error.status);
        return {
          state: refused ? "refused" : "unknown",
          attempts,
          lastAttempt: started,
          nextAttempt: refused
            ? null
            : started + backoff(attempts, error.retryAfterMs),
          error: `${error.message}${error.code ? ` (${error.code})` : ""}`,
          failure: refused ? "refused" : "server",
          receipt: peer.receipt,
          attempt: attemptId,
        };
      }
      // Fetch gives the same network error for a connection that was never
      // made and for one that dropped after the server took the request, so
      // the error cannot show whether a POST arrived. Only a failure before
      // the POST started shows that the record was not sent. While the
      // browser reports offline, such a failure keeps the stored outcome
      // and retry schedule. Any other failure, including every timeout or
      // drop of the POST itself, makes the outcome unknown, and the next
      // attempt asks for a receipt first. With the browser online, a failed
      // lookup also makes the outcome unknown, so its retry waits for the
      // backoff.
      if (error instanceof TransportError && !posted && !navigator.onLine)
        return null;
      const transport = error instanceof TransportError ? error.kind : null;
      return {
        state: "unknown",
        attempts,
        lastAttempt: started,
        nextAttempt: started + backoff(attempts, null),
        error: error instanceof Error ? error.message : "Delivery is unknown.",
        failure: transport ?? "server",
        receipt: peer.receipt,
        attempt: attemptId,
        ...(peer.verifyReceipt ? { verifyReceipt: true } : {}),
      };
    }
  }
  /** Stops future automatic attempts for every unfinished selected peer of one record. */
  async stop(id: string) {
    await this.store.mergeOutbox(id, (item) => ({ ...item, stopped: true }));
    try {
      await this.notify();
    } finally {
      this.schedule();
    }
  }
  /** Deletes a stopped leaf after storage checks its current dependencies. */
  async discard(id: string) {
    try {
      await this.store.discardOutbox(id);
    } finally {
      try {
        await this.notify();
      } finally {
        this.schedule();
      }
    }
  }
  /** Resumes delivery with the same bytes and recipients, after a receipt lookup. */
  async resume(id: string) {
    await this.store.mergeOutbox(id, (item) => ({
      ...item,
      stopped: false,
      peers: Object.fromEntries(
        Object.entries(item.peers).map(([peerId, peer]) => [
          peerId,
          peer.state === "accepted"
            ? peer
            : peer.state === "refused"
              ? // Resume retries a refused record, so its outcome is unknown
                // until the attempt asks for the receipt.
                ({
                  ...peer,
                  state: "unknown",
                  nextAttempt: Date.now(),
                  error:
                    "A server refused this record before. Resume retries it.",
                  failure: null,
                } as PeerDelivery)
              : // Every other outcome stays. The attempt asks for the receipt
                // first after an unknown or header-only outcome.
                ({
                  ...peer,
                  nextAttempt: Date.now(),
                  failure: peer.failure === "unresolved" ? null : peer.failure,
                } as PeerDelivery),
        ]),
      ),
    }));
    try {
      await this.notify();
      await this.deliver(id, true);
    } finally {
      this.schedule();
    }
  }
  /** Immediate explicit attempt. Follows the receipt lookup and immutable retry rules. */
  async tryNow(id: string) {
    // No peer is rewritten before the attempt. The attempt itself asks
    // for a receipt first. While the browser reports offline, a lookup that
    // fails at the network level keeps a refused record refused. With the
    // browser online, the same failure makes the outcome unknown.
    return this.deliver(id, true);
  }
  /** Signed records and their bodies as JSON lines, for export. */
  async exportLines(items: OutboxItem[]): Promise<string> {
    return (
      items.map((item) => item.transport).join("\n") +
      (items.length ? "\n" : "")
    );
  }
}
