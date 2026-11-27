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
  retryAtOf,
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
/** True only when the record has recipients and every one accepted it. */
export function isFinished(item: OutboxItem): boolean {
  const peers = Object.values(item.peers);
  return peers.length > 0 && peers.every((p) => p.state === "accepted");
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
  /**
   * True only for positive evidence about this record: an acceptance, a
   * refusal, a missing body, or an authenticated different envelope. Only
   * such evidence can end an open verification.
   */
  proves: boolean;
};
/**
 * Interprets a receipt for an item. Delivery completes only when the receipt
 * names the stored envelope, or an authenticated equivalent variant of it, and
 * the required body hash. A receipt that cannot establish those matches leaves
 * delivery unknown. Envelope bytes that cannot be read, parsed or verified
 * leave the verification open.
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
      proves: false,
    };
  if (receipt.admission === "refused")
    return {
      state: "refused",
      error: `This server refused the record: ${receipt.reasons.join(", ") || "no reason given"}.`,
      proves: true,
    };
  const transport = JSON.parse(item.transport) as Transport;
  const envelopeHash = storedEnvelopeHash(item.transport);
  if (typeof receipt.envelope_hash !== "string")
    return {
      state: "unknown",
      error:
        "The receipt does not name the stored envelope. Delivery remains unknown.",
      proves: false,
    };
  if (receipt.envelope_hash !== envelopeHash) {
    // The server can retain an equivalent valid signature variant. Fetch it and
    // require the same signed header before accepting the different hash.
    const open = {
      state: "unknown" as const,
      error:
        "The browser could not read or verify the envelope named by the receipt.",
      verifyReceipt: true as const,
      proves: false,
    };
    let bytes: Uint8Array;
    try {
      bytes = await fetchVariant(item.id);
    } catch {
      return open;
    }
    const variant = authenticatedVariant(receipt.envelope_hash, bytes);
    // Bytes that do not parse, hash or verify prove nothing.
    if (!variant) return open;
    if (!sameRecord(transport.envelope, variant))
      return {
        state: "unknown",
        error:
          "The receipt names an envelope that does not match the stored record. Delivery remains unknown.",
        proves: true,
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
          proves: false,
        };
      return { state: "accepted", error: null, proves: true };
    }
    if (receipt.body_status === "withheld" || receipt.body_status === "invalid")
      return {
        state: "refused",
        error: `The server stored the signed header but refused its body (${receipt.body_status}).`,
        proves: true,
      };
    if (receipt.body_status !== "missing")
      return {
        state: "unknown",
        error:
          "The receipt reports an unknown body status. Delivery remains unknown.",
        proves: false,
      };
    return {
      state: "missing-body",
      error:
        "The server stored the signed header without its body. The complete record will be sent again.",
      proves: true,
    };
  }
  if (receipt.body_status !== "none")
    return {
      state: "unknown",
      error:
        "The receipt reports a body for a record that has none. Delivery remains unknown.",
      proves: false,
    };
  return { state: "accepted", error: null, proves: true };
}
/** The envelope, when the bytes parse, match the claimed hash and verify. */
function authenticatedVariant(
  claimedHash: string,
  bytes: Uint8Array,
): Envelope | null {
  try {
    if (contentHash(utf8(canonicalize(bytes))) !== claimedHash) return null;
    verifyEnvelope(bytes);
    return JSON.parse(canonicalize(bytes)) as Envelope;
  } catch {
    return null;
  }
}
function sameRecord(stored: Envelope, variant: Envelope): boolean {
  const headerOf = (envelope: Envelope) =>
    canonicalize(utf8(JSON.stringify(envelope.header)));
  return variant.id === stored.id && headerOf(variant) === headerOf(stored);
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

/** A failed local write retries after this delay, doubled per failure up to the cap. */
const LOCAL_RETRY_DELAY = 1000;
const LOCAL_RETRY_MAX = 15000;

/**
 * An outcome that IndexedDB rejected. The outcome, the stored state that its
 * attempt read, and the attempt ID never change. A retry replays this exact
 * merge. Only the local retry time and the failure count change.
 */
type PendingWrite = {
  readonly outcome: Readonly<PeerDelivery>;
  readonly seen: Readonly<PeerDelivery>;
  readonly attempt: string;
  retryAt: number;
  failures: number;
  lastError: unknown;
  running?: Promise<boolean>;
};

/** What one delivery attempt for one recipient produced. */
type AttemptResult =
  | { kind: "outcome"; outcome: PeerDelivery }
  | { kind: "none" }
  | { kind: "mark-failed"; error: unknown };
/** What a running attempt does now. The page names only that step. */
type AttemptPhase = "lookup" | "mark" | "post";

/**
 * The next network time after a failed attempt: the later of ordinary
 * backoff from the attempt start and the server's absolute deadline.
 */
export function nextNetworkTime(
  started: number,
  attempts: number,
  retryAt: number | null,
): number {
  return Math.max(started + backoff(attempts, null), retryAt ?? 0);
}
/**
 * Whether Try now and Resume may send before the saved next time. Main lets
 * a manual action override every saved delay, including Retry-After.
 */
function manualOverridesDelay(_peer: PeerDelivery): boolean {
  return true;
}

/** What the page can say about one recipient. */
export type PeerStatus =
  | "accepted"
  | "saving-accepted"
  | "saving-refused"
  | "saving"
  | "sending"
  | "verifying"
  | "unconfirmed"
  | "unknown"
  | "refused"
  | "missing-body"
  | "queued"
  | "unresolved";
/** The next operation for one recipient, and when it runs. */
export type NextOperation = { kind: "save" | "receipt" | "send"; at: number };
export type PeerView = {
  status: PeerStatus;
  text: string;
  next: NextOperation | null;
};
/** One summary of a record that every page reads. */
export type RecordView = {
  peers: Record<string, PeerView>;
  stopped: boolean;
  /** Every recipient has a saved acceptance. */
  delivered: boolean;
  /** Every recipient accepted, saved or still awaiting a local save. */
  accepted: boolean;
  /** A computed result still awaits a local save. */
  saving: boolean;
  /** A result is not known yet: an open check, a send without outcome, or unknown. */
  unconfirmed: boolean;
  /** This tab runs an attempt for the record now. */
  sending: boolean;
  /** The record belongs on the Not delivered page. */
  notDelivered: boolean;
};
const STOPPED_SUFFIX = " Automatic delivery is stopped.";

export class DeliveryEngine {
  private profileCompletions?: Set<string>;
  private profileSkipped?: Set<string>;
  private profileWarnings?: Set<string>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scheduleGeneration = 0;
  private listRetryAt = 0;
  /** A failed read of one record delays that record alone. */
  private recordRetryAt = new Map<string, number>();
  /** A failed send-mark write or an unexpected error delays one recipient. */
  private peerWaits = new Map<string, Map<string, number>>();
  /** Records whose last failure came from a recipient, not from the record. */
  private recipientFailed = new Set<string>();
  private pendingWrites = new Map<string, Map<string, PendingWrite>>();
  /** Recipients with an attempt running in this tab, and its phase. */
  private activePeers = new Map<string, Map<string, AttemptPhase>>();
  /** Attempts between their send-mark transaction and the POST dispatch. */
  private marking = new Map<string, Set<Promise<void>>>();
  /** The timer for local writes. It never waits for network work. */
  private localTimer: ReturnType<typeof setTimeout> | undefined;
  /** Group order for the last known list. */
  private knownGroups = new Map<string, OutboxItem[]>();
  /** Record commands in order. A queued command goes before new automatic work. */
  private commands = new Map<string, Promise<unknown>>();
  /** How many commands are queued or running for each record. */
  private busy = new Map<string, number>();
  /** Records that a Discard is about to delete. No new attempt starts. */
  private locked = new Set<string>();
  /** The last list that a schedule read, for group order in page views. */
  private known: OutboxItem[] = [];
  private listeners = new Set<DeliveryListener>();
  private readErrors = new Map<DeliveryListener, (error: unknown) => void>();
  private inFlight = new Map<string, Promise<OutboxItem | undefined>>();
  constructor(private store: LocalStore) {
    window.addEventListener("online", () => {
      void this.notify().catch(() => {});
      void this.tick();
    });
    window.addEventListener("offline", () => {
      this.schedule();
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
  private pendingWrite(id: string, peerId: string) {
    return this.pendingWrites.get(id)?.get(peerId);
  }
  /**
   * The pending write that still stands for a saved recipient. A saved
   * acceptance, or a newer send mark or outcome from another attempt,
   * supersedes a pending write that is not an acceptance, by the same rule
   * as the merge. A superseded write only waits for its local transaction,
   * which changes nothing and retires it.
   */
  private liveWrite(id: string, peerId: string, stored?: PeerDelivery) {
    const write = this.pendingWrite(id, peerId);
    if (!write || !stored) return write;
    if (stored.state === "accepted") return undefined;
    if (write.outcome.state === "accepted") return write;
    return stored.sendAttempt === write.attempt ||
      unchangedSince(stored, write.seen)
      ? write
      : undefined;
  }
  /** True while a computed result for this record still awaits a local save. */
  hasPendingWrite(id: string): boolean {
    return (this.pendingWrites.get(id)?.size ?? 0) > 0;
  }
  /** Recipients that are not accepted, saved or awaiting a local save. */
  private unfinishedPeers(item: OutboxItem): string[] {
    return Object.entries(item.peers)
      .filter(
        ([peerId, peer]) =>
          peer.state !== "accepted" &&
          this.liveWrite(item.id, peerId, peer)?.outcome.state !== "accepted",
      )
      .map(([peerId]) => peerId);
  }
  /**
   * The records of each group that can still hold a later record, in one
   * pass over the list. Group order then costs the size of the group.
   */
  private groupsOf(items: OutboxItem[]): Map<string, OutboxItem[]> {
    const groups = new Map<string, OutboxItem[]>();
    for (const item of items) {
      if (item.stopped || this.unfinishedPeers(item).length === 0) continue;
      let members = groups.get(item.group);
      if (!members) groups.set(item.group, (members = []));
      members.push(item);
    }
    return groups;
  }
  private setKnown(items: OutboxItem[]) {
    this.known = items;
    this.knownGroups = this.groupsOf(items);
  }
  private earlierIn(
    groups: Map<string, OutboxItem[]>,
    item: OutboxItem,
  ): OutboxItem[] {
    return (groups.get(item.group) ?? []).filter(
      (other) => other.id !== item.id && other.order < item.order,
    );
  }
  /**
   * Group order for one recipient. Only an earlier record that has this
   * recipient and has not delivered to it can hold the child there. A
   * pending result that is not an acceptance holds it until that write
   * resolves; its local retry wakes the timer. A failed read of the earlier
   * record holds it until that read retries. Nothing is copied into the
   * child, so the wait ends with its cause.
   */
  private holdUntil(
    earlier: OutboxItem[],
    peerId: string,
    now = Date.now(),
  ): number {
    let until = 0;
    for (const parent of earlier) {
      const stored = parent.peers[peerId];
      if (!stored || stored.state === "accepted") continue;
      const write = this.liveWrite(parent.id, peerId, stored);
      if (write?.outcome.state === "accepted") continue;
      if (write) return Infinity;
      const read = this.recordRetryAt.get(parent.id) ?? 0;
      if (read > now) until = Math.max(until, read);
    }
    return until;
  }
  /** The next automatic network time for one saved recipient. */
  private networkDue(id: string, peerId: string, peer: PeerDelivery): number {
    if (peer.state === "accepted" || peer.failure === "unresolved")
      return Infinity;
    // A pending write suppresses network work for its own recipient.
    if (this.liveWrite(id, peerId, peer)) return Infinity;
    if (peer.state === "refused" || peer.nextAttempt === null) return Infinity;
    return Math.max(
      Number.isFinite(peer.nextAttempt) ? peer.nextAttempt : 0,
      this.recordRetryAt.get(id) ?? 0,
      this.peerWaits.get(id)?.get(peerId) ?? 0,
    );
  }
  /** True when the next attempt for this saved row asks for the receipt first. */
  private looksUpFirst(peer: PeerDelivery): boolean {
    return (
      peer.verifyReceipt === true ||
      peer.state !== "queued" ||
      peer.sendStarted !== undefined ||
      !navigator.onLine
    );
  }
  /** The summary of one recipient. */
  peerView(item: OutboxItem, peerId: string): PeerView {
    const peer = item.peers[peerId];
    const stopped = item.stopped === true;
    const suffix = stopped ? STOPPED_SUFFIX : "";
    if (peer.state === "accepted")
      return { status: "accepted", text: "Delivered.", next: null };
    const write = this.liveWrite(item.id, peerId, peer);
    if (write) {
      const next: NextOperation = { kind: "save", at: write.retryAt };
      const outcome = write.outcome;
      if (outcome.state === "accepted")
        return {
          status: "saving-accepted",
          text: `The server accepted this record. This browser still needs to save the receipt.${suffix}`,
          next,
        };
      if (outcome.state === "refused")
        return {
          status: "saving-refused",
          text: `${outcome.error ?? "The server refused this record."} This browser still needs to save that answer.`,
          next,
        };
      return {
        status: outcome.failure === "unresolved" ? "unresolved" : "saving",
        text:
          outcome.failure === "unresolved"
            ? `${describePeer(outcome)} This browser still needs to save this result.`
            : `The latest delivery result is not saved yet. This browser saves it before it contacts the server again.${suffix}`,
        next,
      };
    }
    const phase = this.activePeers.get(item.id)?.get(peerId);
    if (phase)
      return {
        status: "sending",
        text:
          phase === "post"
            ? "A send started. Its outcome is not confirmed yet."
            : phase === "lookup"
              ? "Checking whether the server already has this record."
              : "Delivery is in progress.",
        next: null,
      };
    let network: NextOperation | null = null;
    if (!stopped && !this.isDelivering(item.id)) {
      const due = Math.max(
        this.listRetryAt,
        this.networkDue(item.id, peerId, peer),
      );
      // Group order matters only for a recipient with a finite time.
      const at = Number.isFinite(due)
        ? Math.max(
            due,
            this.holdUntil(this.earlierIn(this.knownGroups, item), peerId),
          )
        : due;
      if (Number.isFinite(at))
        network = {
          kind: this.looksUpFirst(peer) ? "receipt" : "send",
          at,
        };
    }
    if (peer.failure === "unresolved")
      return { status: "unresolved", text: describePeer(peer), next: null };
    if (peer.verifyReceipt)
      return {
        status: "verifying",
        text: `Delivery is unconfirmed. Receipt verification is pending.${suffix}`,
        next: network,
      };
    if (peer.state === "queued" && peer.sendStarted !== undefined)
      return {
        status: "unconfirmed",
        text: `Delivery is unconfirmed. A send started, and the browser asks for the receipt before it sends again.${suffix}`,
        next: network,
      };
    return {
      status: peer.state as PeerStatus,
      text: describePeer(peer),
      next: network,
    };
  }
  /** The one delivery summary for a record. */
  view(item: OutboxItem): RecordView {
    const peers = Object.fromEntries(
      Object.keys(item.peers).map((peerId) => [
        peerId,
        this.peerView(item, peerId),
      ]),
    );
    const views = Object.values(peers);
    const any = (...statuses: PeerStatus[]) =>
      views.some((view) => statuses.includes(view.status));
    const delivered =
      views.length > 0 && views.every((view) => view.status === "accepted");
    const accepted =
      views.length > 0 &&
      views.every(
        (view) =>
          view.status === "accepted" || view.status === "saving-accepted",
      );
    const saving =
      any("saving", "saving-accepted", "saving-refused") ||
      Object.keys(item.peers).some((peerId) => {
        const write = this.liveWrite(item.id, peerId, item.peers[peerId]);
        return write?.outcome.failure === "unresolved";
      });
    // An unknown outcome can mean that the server holds the record.
    const unconfirmed = any("verifying", "unconfirmed", "unknown");
    return {
      peers,
      stopped: item.stopped === true,
      delivered,
      accepted,
      saving,
      unconfirmed,
      sending: this.isDelivering(item.id),
      notDelivered:
        !delivered &&
        (views.length === 0 ||
          isNotDelivered(item) ||
          saving ||
          unconfirmed ||
          this.recordRetryAt.has(item.id) ||
          (this.peerWaits.get(item.id)?.size ?? 0) > 0),
    };
  }
  /** Page text for one recipient. */
  describe(item: OutboxItem, peerId: string): string {
    return this.peerView(item, peerId).text;
  }
  /** True while the next automatic step for a recipient is a receipt check. */
  needsReceipt(item: OutboxItem, peerId: string): boolean {
    const view = this.peerView(item, peerId);
    return (
      !item.stopped &&
      (view.status === "verifying" || view.status === "unconfirmed")
    );
  }
  isNotDelivered(item: OutboxItem): boolean {
    return this.view(item).notDelivered;
  }
  nextTryAt(item: OutboxItem, peerId: string): number | null {
    return this.peerView(item, peerId).next?.at ?? null;
  }
  private setTimer(at?: number) {
    this.scheduleGeneration++;
    clearTimeout(this.timer);
    this.timer =
      at !== undefined && Number.isFinite(at)
        ? setTimeout(
            () => void this.tick(),
            Math.min(Math.max(250, at - Date.now()), MAX_TIMER_DELAY),
          )
        : undefined;
  }
  /** The earliest local write retry. Local writes run offline and while stopped. */
  private localDue(): number {
    let due = Infinity;
    for (const writes of this.pendingWrites.values())
      for (const write of writes.values())
        due = Math.min(due, write.running ? Infinity : write.retryAt);
    return due;
  }
  /**
   * Arms the local write timer. It is separate from network work, so a
   * local save never waits for another recipient's open request.
   */
  private armLocal() {
    clearTimeout(this.localTimer);
    const due = this.localDue();
    this.localTimer = Number.isFinite(due)
      ? setTimeout(
          () => void this.runLocal(),
          Math.min(Math.max(0, due - Date.now()), MAX_TIMER_DELAY),
        )
      : undefined;
  }
  private async runLocal() {
    const committed = await this.commitDueWrites();
    this.armLocal();
    // A commit can release network work, such as a held child.
    if (committed) this.schedule();
  }
  /** Retry in this tab even when storage cannot supply a new retry time. */
  private deferListRead() {
    this.listRetryAt = Date.now() + BASE_DELAY;
    this.setTimer(this.listRetryAt);
  }
  private schedule() {
    this.armLocal();
    if (!navigator.onLine) {
      this.setTimer();
      return;
    }
    if (Date.now() < this.listRetryAt) {
      this.setTimer(this.listRetryAt);
      return;
    }
    // A newer schedule or a storage failure can set a timer during this read.
    const generation = ++this.scheduleGeneration;
    void this.items()
      .then((items) => {
        if (generation !== this.scheduleGeneration) return;
        this.setKnown(items);
        let next = Infinity;
        const present = new Set(items.map((item) => item.id));
        const unfinished = new Set<string>();
        for (const item of items) {
          if (!isFinished(item)) unfinished.add(item.id);
          if (!isActive(item)) continue;
          next = Math.min(next, this.dueFor(item, this.knownGroups));
        }
        for (const id of this.recordRetryAt.keys())
          if (!unfinished.has(id)) this.recordRetryAt.delete(id);
        for (const id of this.peerWaits.keys())
          if (!unfinished.has(id)) this.peerWaits.delete(id);
        // A successful list read without the record proves its removal.
        for (const id of this.pendingWrites.keys())
          if (!present.has(id)) this.pendingWrites.delete(id);
        this.armLocal();
        this.setTimer(Math.max(next, this.listRetryAt));
      })
      .catch(() => {
        if (generation === this.scheduleGeneration) this.deferListRead();
      });
  }
  /**
   * The earliest automatic network time of a record. Group order is read
   * only for a recipient that has a finite time.
   */
  private dueFor(
    item: OutboxItem,
    groups: Map<string, OutboxItem[]>,
    now = Date.now(),
  ): number {
    let next = Infinity;
    let earlier: OutboxItem[] | undefined;
    for (const [peerId, peer] of Object.entries(item.peers)) {
      const due = this.networkDue(item.id, peerId, peer);
      if (!Number.isFinite(due) || due >= next) continue;
      earlier ??= this.earlierIn(groups, item);
      next = Math.min(
        next,
        Math.max(due, this.holdUntil(earlier, peerId, now)),
      );
    }
    return next;
  }
  /** Retries every local write that is due. No network request runs. */
  private async commitDueWrites(): Promise<boolean> {
    const now = Date.now();
    let committed = false;
    for (const [id, writes] of [...this.pendingWrites])
      for (const [peerId, write] of [...writes])
        if (write.retryAt <= now && (await this.commitWrite(id, peerId)))
          committed = true;
    if (committed) await this.notify().catch(() => {});
    return committed;
  }
  /** Sends every record with a due peer, in group order. */
  async tick() {
    await this.commitDueWrites();
    this.armLocal();
    if (!navigator.onLine) {
      this.schedule();
      return;
    }
    const now = Date.now();
    if (now < this.listRetryAt) {
      this.schedule();
      return;
    }
    let items: OutboxItem[];
    try {
      items = await this.items();
    } catch {
      this.deferListRead();
      return;
    }
    this.setKnown(items);
    for (const item of items) {
      if (!navigator.onLine) break;
      // A queued command for this record goes first.
      if (this.busy.has(item.id) || this.locked.has(item.id)) continue;
      if (!isActive(item)) continue;
      if (this.dueFor(item, this.knownGroups, now) <= now)
        // A failed record delays its own group. The other groups stay due.
        await this.deliver(item.id, false).catch(() => {});
    }
    this.schedule();
  }
  /**
   * Delivers one record. Automatic delivery follows each peer's own schedule
   * and skips stopped records, unresolved peers and peers with a pending
   * local write. An explicit attempt first retries pending writes once, then
   * runs now for every other recipient.
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
        // A recipient failure already has its own wait or pending write.
        // Only a failure outside the recipient loop delays the record.
        if (!this.recipientFailed.delete(id))
          this.recordRetryAt.set(id, Date.now() + BASE_DELAY);
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
    let storageFailure: { error: unknown } | undefined;
    // Local writes for this record go first. An explicit action retries
    // each one once, without waiting for its local retry time.
    for (const [peerId, write] of [...(this.pendingWrites.get(id) ?? [])])
      if (
        (explicit || write.retryAt <= Date.now()) &&
        !(await this.commitWrite(id, peerId))
      )
        storageFailure ??= { error: write.lastError };
    // navigator.onLine is only a hint. An attempt always runs, so a
    // reachable server still receives the record when the browser
    // reports offline. A network failure decides the outcome below.
    // Earlier records of the same group go first so dependencies arrive in order.
    const earlier = this.earlierIn(this.groupsOf(await this.items()), item);
    for (const dependency of earlier)
      await this.deliver(dependency.id, explicit).catch(() => {});
    item = (await this.fresh(id)) ?? item;
    const now = Date.now();
    for (const peerId of Object.keys(item.peers)) {
      const current = await this.fresh(id);
      if (!current) return undefined;
      const peer = current.peers[peerId];
      if (!peer || peer.state === "accepted") continue;
      const pending = this.liveWrite(id, peerId, peer);
      if (pending) {
        // That recipient waits for its local write. Its siblings go on.
        if (explicit) storageFailure ??= { error: pending.lastError };
        continue;
      }
      if (this.holdUntil(earlier, peerId, now) > now) continue;
      if (
        !explicit &&
        (current.stopped || this.networkDue(id, peerId, peer) > now)
      )
        continue;
      if (
        explicit &&
        !manualOverridesDelay(peer) &&
        this.networkDue(id, peerId, peer) > now
      )
        continue;
      if (this.locked.has(id)) continue;
      const started = Date.now();
      // Random, so two attempts that start in the same millisecond differ.
      const attemptId = crypto.randomUUID();
      let active = this.activePeers.get(id);
      if (!active) this.activePeers.set(id, (active = new Map()));
      const phases = active;
      phases.set(peerId, this.looksUpFirst(peer) ? "lookup" : "mark");
      try {
        const result = await this.attempt(
          current,
          peerId,
          peer,
          started,
          attemptId,
          explicit,
          (phase) => phases.set(peerId, phase),
        );
        if (result.kind === "mark-failed") {
          // Nothing was sent and nothing new was learned. A later attempt
          // rereads the row.
          this.waitPeer(id, peerId);
          storageFailure ??= { error: result.error };
        } else if (result.kind === "outcome") {
          this.peerWaits.get(id)?.delete(peerId);
          const failure = await this.saveOutcome(
            id,
            peerId,
            peer,
            result.outcome,
            attemptId,
          );
          if (failure) storageFailure ??= failure;
        }
      } catch (error) {
        // Other recipients of this record can still have work due.
        this.waitPeer(id, peerId);
        storageFailure ??= { error };
      } finally {
        phases.delete(peerId);
        if (!phases.size && this.activePeers.get(id) === phases)
          this.activePeers.delete(id);
      }
      await this.notify().catch(() => {});
    }
    if (storageFailure) {
      this.recipientFailed.add(id);
      throw storageFailure.error;
    }
    return this.fresh(id);
  }
  private waitPeer(id: string, peerId: string) {
    let waits = this.peerWaits.get(id);
    if (!waits) this.peerWaits.set(id, (waits = new Map()));
    waits.set(peerId, Date.now() + BASE_DELAY);
  }
  /** Merges one outcome. A failed write becomes a pending write in this tab. */
  private async saveOutcome(
    id: string,
    peerId: string,
    seen: PeerDelivery,
    outcome: PeerDelivery,
    attempt: string,
  ): Promise<{ error: unknown } | undefined> {
    try {
      await this.mergeWrite(id, peerId, outcome, seen, attempt);
      return undefined;
    } catch (error) {
      let writes = this.pendingWrites.get(id);
      if (!writes) this.pendingWrites.set(id, (writes = new Map()));
      writes.set(peerId, {
        outcome: Object.freeze({ ...outcome }),
        seen: Object.freeze({ ...seen }),
        attempt,
        retryAt: Date.now() + LOCAL_RETRY_DELAY,
        failures: 1,
        lastError: error,
      });
      // An older schedule read must not cancel the local retry.
      this.scheduleGeneration++;
      this.armLocal();
      return { error };
    }
  }
  /**
   * One transaction rereads the record and merges only this recipient. It
   * keeps the stop flag and every sibling. A removed record or recipient
   * stays removed. A merge that keeps every saved fact writes nothing, so a
   * superseded write retires without a put.
   */
  private mergeWrite(
    id: string,
    peerId: string,
    outcome: PeerDelivery,
    seen: PeerDelivery,
    attempt: string,
  ) {
    return this.store.mergeOutbox(id, (stored) => {
      const current = stored.peers[peerId];
      if (!current) return stored;
      const merged = mergePeer(current, outcome, seen, attempt);
      if (JSON.stringify(merged) === JSON.stringify(current)) return stored;
      return {
        ...stored,
        peers: { ...stored.peers, [peerId]: merged },
      };
    });
  }
  /**
   * Replays one pending write with its original outcome and merge identity.
   * True when it committed, was superseded by the merge, or found its record
   * or recipient removed.
   */
  private commitWrite(id: string, peerId: string): Promise<boolean> {
    const write = this.pendingWrite(id, peerId);
    if (!write) return Promise.resolve(true);
    if (write.running) return write.running;
    const running = (async () => {
      try {
        await this.mergeWrite(
          id,
          peerId,
          write.outcome,
          write.seen,
          write.attempt,
        );
        // Only this entry retires. A newer one stays.
        const writes = this.pendingWrites.get(id);
        if (writes?.get(peerId) === write) {
          writes.delete(peerId);
          if (!writes.size) this.pendingWrites.delete(id);
        }
        this.scheduleGeneration++;
        return true;
      } catch (error) {
        write.failures++;
        write.lastError = error;
        write.retryAt =
          Date.now() +
          Math.min(
            LOCAL_RETRY_DELAY * 2 ** (write.failures - 1),
            LOCAL_RETRY_MAX,
          );
        return false;
      } finally {
        write.running = undefined;
        this.armLocal();
      }
    })();
    write.running = running;
    return running;
  }
  /** Retries every pending write of a record once. Throws the last storage error. */
  private async commitPending(id: string) {
    const writes = [...(this.pendingWrites.get(id) ?? [])];
    if (!writes.length) return;
    let failure: { error: unknown } | undefined;
    for (const [peerId, write] of writes)
      if (!(await this.commitWrite(id, peerId)))
        failure ??= { error: write.lastError };
    await this.notify().catch(() => {});
    if (failure) throw failure.error;
  }
  /**
   * Runs record commands in the order called, one queue per record. A
   * command lets the next one start once it reached its own decision: Try
   * now at once, Resume after its stored change, Stop and Discard when they
   * end. Try now, Resume and Discard first wait for the attempt in progress.
   */
  private command<T>(
    id: string,
    run: (release: () => void) => Promise<T>,
  ): Promise<T> {
    const before = this.commands.get(id) ?? Promise.resolve();
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Automatic work for the record waits while a command is queued or runs.
    this.busy.set(id, (this.busy.get(id) ?? 0) + 1);
    const next = before
      .then(() => run(release))
      .finally(() => {
        const left = (this.busy.get(id) ?? 1) - 1;
        if (left) this.busy.set(id, left);
        else this.busy.delete(id);
      });
    // The chain itself never rejects. The caller gets the command's result.
    const tracked: Promise<void> = Promise.race([
      released,
      next.then(
        () => {},
        () => {},
      ),
    ]).then(() => {
      if (this.commands.get(id) === tracked) this.commands.delete(id);
    });
    this.commands.set(id, tracked);
    return next;
  }
  /** Waits until no attempt runs for the record. */
  private async settle(id: string) {
    for (;;) {
      const running = this.inFlight.get(id);
      if (!running) return;
      await running.catch(() => {});
    }
  }
  private async attempt(
    item: OutboxItem,
    peerId: string,
    peer: PeerDelivery,
    started: number,
    attemptId: string,
    explicit: boolean,
    phase: (phase: AttemptPhase) => void,
  ): Promise<AttemptResult> {
    const done = (outcome: PeerDelivery): AttemptResult => ({
      kind: "outcome",
      outcome,
    });
    const target = savedPeer(item, peerId);
    if (!target)
      return done({
        ...peer,
        nextAttempt: null,
        error: `Recipient "${peerId}" is not configured in this record. The record saved no address for it, and current preferences never replace a missing address. Nothing was sent.`,
        failure: "unresolved",
        attempt: attemptId,
      });
    const attempts = peer.attempts + 1;
    const verifying = peer.verifyReceipt === true;
    const neverSent = peer.state === "queued" && peer.sendStarted === undefined;
    const message = (error: unknown) =>
      error instanceof RequestError
        ? `${error.message}${error.code ? ` (${error.code})` : ""}`
        : error instanceof Error
          ? error.message
          : "Delivery is unknown.";
    // A failed request before the POST. It proves nothing about admission.
    const failedBefore = (
      error: unknown,
      state: PeerState,
      keepVerification: boolean,
    ) =>
      done({
        state,
        attempts,
        lastAttempt: started,
        nextAttempt: nextNetworkTime(started, attempts, retryAtOf(error)),
        error: message(error),
        failure: error instanceof TransportError ? error.kind : "server",
        receipt: peer.receipt,
        attempt: attemptId,
        ...(keepVerification ? { verifyReceipt: true } : {}),
      });
    const classify = async (receipt: Receipt) => {
      let envelopeError: unknown;
      const classified = await classifyReceipt(item, receipt, async (id) => {
        try {
          return await objectBytes(`/events/${encodeURIComponent(id)}`, 20480, {
            peer: target,
          });
        } catch (error) {
          envelopeError = error;
          throw error;
        }
      });
      return { classified, envelopeError };
    };
    // The outcome of a completed receipt classification. Only this
    // classification decides whether verification stays open.
    const settled = (
      receipt: Receipt,
      classified: Classified,
      deadline: number | null,
    ): PeerDelivery => {
      const { state, error, verifyReceipt } = classified;
      if (state === "accepted") rememberAcceptedReceipt(receipt, target);
      return {
        state,
        attempts,
        lastAttempt: started,
        nextAttempt:
          state === "accepted" || state === "refused"
            ? null
            : nextNetworkTime(started, attempts, deadline),
        error,
        failure:
          state === "refused"
            ? "refused"
            : state === "unknown"
              ? "server"
              : null,
        receipt,
        attempt: attemptId,
        ...(verifyReceipt ? { verifyReceipt: true } : {}),
      };
    };
    // What the lookup learned when it permits the repair POST. If no send
    // mark can be saved, this evidence is saved instead, so it is not lost.
    let evidence: PeerDelivery | undefined;
    // Lookup phase. After an unknown or refused outcome, an open
    // verification, or a send mark, ask whether the record arrived before
    // sending again. While the browser reports offline, a queued record is
    // looked up first too, so that a failed lookup shows that the POST was
    // never sent. No peer is rewritten first.
    if (this.looksUpFirst(peer)) {
      phase("lookup");
      let receipt: Receipt | undefined;
      try {
        receipt = await getReceipt(item.id, { peer: target });
      } catch (error) {
        // Offline, a network failure before the POST adds no evidence. The
        // saved outcome and its schedule stay as they are.
        if (error instanceof TransportError && !navigator.onLine)
          return { kind: "none" };
        // An open check stays open. A 404, a malformed answer or a failed
        // GET cannot grant a POST.
        if (verifying) return failedBefore(error, "unknown", true);
        const notFound = error instanceof RequestError && error.status === 404;
        // A queued record was never sent, so its lookup only checks the
        // connection. An error answer, or an answer without a usable
        // receipt, lets the POST go ahead.
        const answered =
          neverSent &&
          !(error instanceof TransportError) &&
          !(error instanceof DOMException && error.name === "AbortError");
        const later =
          peer.state === "refused" || peer.sendStarted !== undefined
            ? "unknown"
            : peer.state;
        if (!notFound && !answered)
          return failedBefore(
            error,
            error instanceof RequestError ? later : "unknown",
            false,
          );
        // A 404 permits the repair, but a Retry-After with it still holds
        // automatic requests. A manual action may override it.
        if (!explicit && (retryAtOf(error) ?? 0) > Date.now())
          return failedBefore(error, later, false);
      }
      if (receipt) {
        // Envelope phase.
        const { classified, envelopeError } = await classify(receipt);
        if (classified.state === "accepted" || classified.state === "refused")
          return done(settled(receipt, classified, null));
        if (classified.verifyReceipt) {
          if (envelopeError instanceof TransportError && !navigator.onLine) {
            // An open check learned nothing new.
            if (verifying) return { kind: "none" };
            // The receipt is new safety evidence. Keep it, with any future
            // deadline, or retry when the connection returns.
            const outcome = settled(receipt, classified, null);
            outcome.nextAttempt =
              peer.nextAttempt !== null && peer.nextAttempt > Date.now()
                ? peer.nextAttempt
                : Date.now();
            return done(outcome);
          }
          return done(settled(receipt, classified, retryAtOf(envelopeError)));
        }
        // Only positive evidence about this record ends an open check: a
        // missing body or an authenticated different envelope. An unusable
        // receipt keeps it open.
        if (verifying && !classified.proves)
          return failedBefore(
            new Error(classified.error ?? ""),
            "unknown",
            true,
          );
        // A completed check that proves a missing body or a mismatch, or
        // an unusable receipt without an open check, permits the identical
        // retry below.
        evidence = settled(receipt, classified, null);
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
    // not when the record is accepted, when another attempt stored an
    // outcome or its own send mark since this attempt read the record, or,
    // for an automatic attempt, when the record is stopped. That other
    // attempt then owns the outcome, and this one sends nothing.
    phase("mark");
    let maySend = false;
    let stopped = false;
    const dispatched = this.beginMarking(item.id);
    try {
      try {
        await this.store.mergeOutbox(item.id, (stored) => {
          maySend = false;
          stopped = false;
          const current = stored.peers[peerId];
          if (
            !current ||
            current.state === "accepted" ||
            !unchangedSince(current, peer)
          )
            return stored;
          if (!explicit && stored.stopped) {
            stopped = true;
            return stored;
          }
          maySend = true;
          const mark = { sendAttempt: attemptId, sendStarted: started };
          // A send starts only after verification ended or never began.
          const { verifyReceipt: _ended, ...base } = current;
          return {
            ...stored,
            peers: {
              ...stored.peers,
              [peerId]:
                current.state === "queued"
                  ? { ...base, ...mark }
                  : {
                      ...base,
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
      } catch (error) {
        // A failed mark grants no send, but the receipt's evidence stays.
        return evidence ? done(evidence) : { kind: "mark-failed", error };
      }
      if (!maySend)
        return stopped && evidence ? done(evidence) : { kind: "none" };
      // POST phase. Its own answer decides the outcome. The request starts
      // before Stop can report success.
      phase("post");
      const posting = postEvent(item.transport, { peer: target });
      dispatched();
      // Open pages show the mark, for example the saved publication row.
      await this.notify().catch(() => {});
      let receipt: Receipt;
      try {
        receipt = await posting;
      } catch (error) {
        if (
          error instanceof RequestError &&
          REFUSAL_STATUSES.includes(error.status)
        )
          return done({
            state: "refused",
            attempts,
            lastAttempt: started,
            nextAttempt: null,
            error: message(error),
            failure: "refused",
            receipt: peer.receipt,
            attempt: attemptId,
          });
        // Fetch gives the same network error for a connection that was never
        // made and for one that dropped after the server took the request, so
        // the error cannot show whether a POST arrived. The outcome is
        // unknown, and the next attempt asks for a receipt first. A damaged
        // body keeps the server's deadline.
        return done({
          state: "unknown",
          attempts,
          lastAttempt: started,
          nextAttempt: nextNetworkTime(started, attempts, retryAtOf(error)),
          error: message(error),
          failure: error instanceof TransportError ? error.kind : "server",
          receipt: peer.receipt,
          attempt: attemptId,
        });
      }
      const { classified, envelopeError } = await classify(receipt);
      return done(settled(receipt, classified, retryAtOf(envelopeError)));
    } finally {
      dispatched();
    }
  }
  /**
   * Registers an attempt that is about to save its send mark. The returned
   * function ends the registration once the POST starts or the attempt
   * gives up. Stop waits for these, so it reports success only when no
   * further POST can start.
   */
  private beginMarking(id: string): () => void {
    let end!: () => void;
    const ended = new Promise<void>((resolve) => {
      end = resolve;
    });
    let set = this.marking.get(id);
    if (!set) this.marking.set(id, (set = new Set()));
    set.add(ended);
    return () => {
      end();
      const current = this.marking.get(id);
      current?.delete(ended);
      if (current?.size === 0) this.marking.delete(id);
    };
  }
  /**
   * Stops future automatic attempts for every unfinished selected peer of
   * one record. It runs in the record's command order. When it returns, no
   * automatic POST can start: an attempt that saved its send mark first has
   * already started its POST, and every later one sees the stop flag.
   */
  async stop(id: string) {
    return this.command(id, async () => {
      // Local writes keep running while the record is stopped.
      await this.store.mergeOutbox(id, (item) => ({ ...item, stopped: true }));
      await Promise.all([...(this.marking.get(id) ?? [])]);
      try {
        await this.notify();
      } finally {
        this.schedule();
      }
    });
  }
  /**
   * Deletes a stopped leaf after storage checks its current dependencies.
   * Pending writes resolve first, so the storage guard sees every
   * acceptance. No new attempt starts for the record meanwhile.
   */
  async discard(id: string) {
    return this.command(id, async () => {
      this.locked.add(id);
      try {
        await this.settle(id);
        try {
          await this.commitPending(id);
        } catch {
          throw new Error(
            "This browser could not save a delivery result for this record yet. Discard did not run. Try again later.",
          );
        }
        await this.store.discardOutbox(id);
      } finally {
        this.locked.delete(id);
        try {
          await this.notify();
        } finally {
          this.schedule();
        }
      }
    });
  }
  /**
   * Resumes delivery with the same bytes and recipients. Pending writes must
   * commit first. If one still fails, the stop flag stays as it was.
   */
  async resume(id: string) {
    return this.command(id, async (release) => {
      await this.settle(id);
      try {
        await this.commitPending(id);
      } catch (error) {
        release();
        throw error;
      }
      await this.store
        .mergeOutbox(id, (item) => ({
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
                  : // Every other outcome stays, also an open verification. The
                    // attempt asks for the receipt first after an unknown or
                    // header-only outcome.
                    ({
                      ...peer,
                      nextAttempt: Date.now(),
                      failure:
                        peer.failure === "unresolved" ? null : peer.failure,
                    } as PeerDelivery),
            ]),
          ),
        }))
        .finally(release);
      this.peerWaits.delete(id);
      this.recordRetryAt.delete(id);
      try {
        await this.notify();
        await this.deliver(id, true);
      } finally {
        this.schedule();
      }
    });
  }
  /** Immediate explicit attempt. Follows the receipt lookup and immutable retry rules. */
  async tryNow(id: string) {
    // No peer is rewritten before the attempt. It runs after any attempt in
    // progress, so joining an older automatic attempt never consumes it.
    // Pending writes retry once first. The attempt itself asks for a
    // receipt first where the saved row needs one.
    return this.command(id, async (release) => {
      // A later command, such as Stop, need not wait for this attempt.
      release();
      await this.settle(id);
      return this.deliver(id, true);
    });
  }
  /** Signed records and their bodies as JSON lines, for export. */
  async exportLines(items: OutboxItem[]): Promise<string> {
    return (
      items.map((item) => item.transport).join("\n") +
      (items.length ? "\n" : "")
    );
  }
}
