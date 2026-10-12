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
} from "../../../../packages/core/src/index.ts";
import {
  getReceipt,
  objectBytes,
  postEvent,
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
export type Classified = { state: PeerState; error: string | null };
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
    const equivalent = await isEquivalentVariant(
      transport.envelope,
      receipt.envelope_hash,
      fetchVariant,
    );
    if (!equivalent)
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
async function isEquivalentVariant(
  stored: Envelope,
  claimedHash: string,
  fetchVariant: (id: string) => Promise<Uint8Array>,
): Promise<boolean> {
  try {
    const bytes = await fetchVariant(stored.id);
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
  return Math.max(exponential, retryAfterMs ?? 0);
}
/** Plain description of a peer state for the Not delivered page. */
export function describePeer(peer: PeerDelivery): string {
  if (peer.failure === "unresolved")
    return `${peer.error ?? "The recipient is not configured in this browser."} The signed bytes are kept here.`;
  switch (peer.state) {
    case "accepted":
      return "Delivered.";
    case "queued":
      return peer.attempts === 0
        ? "Waiting to send."
        : "Waiting to send again.";
    case "unknown":
      if (peer.failure === "offline")
        return "No connection. The client asks whether the record arrived before it sends the same bytes again.";
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
/**
 * Merges the outcome of one attempt with the peer state stored meanwhile. A
 * final state recorded by another tab stays. A newer decision stays when this
 * attempt started before it. Attempt counters never go down.
 */
export function mergePeer(
  stored: PeerDelivery,
  next: PeerDelivery,
  started: number,
): PeerDelivery {
  const attempts = Math.max(stored.attempts, next.attempts);
  const storedFinal = stored.state === "accepted" || stored.state === "refused";
  const nextFinal = next.state === "accepted" || next.state === "refused";
  if (stored.state === "accepted" && next.state !== "accepted") return stored;
  if (storedFinal && !nextFinal) return { ...stored, attempts };
  if (
    stored.lastAttempt !== null &&
    stored.lastAttempt > started &&
    next.state !== "accepted"
  )
    return { ...stored, attempts };
  return { ...next, attempts };
}

export class DeliveryEngine {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<DeliveryListener>();
  private inFlight = new Map<string, Promise<OutboxItem | undefined>>();
  constructor(private store: LocalStore) {
    window.addEventListener("online", () => void this.tick());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void this.tick();
    });
  }
  subscribe(listener: DeliveryListener) {
    this.listeners.add(listener);
    void this.items()
      .then(listener)
      .catch(() => listener([]));
    return () => this.listeners.delete(listener);
  }
  private async notify() {
    const items = await this.items().catch(() => [] as OutboxItem[]);
    for (const listener of this.listeners) listener(items);
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
    await this.notify();
    void this.tick();
  }
  /** Starts the retry loop. Called after the app has storage. */
  start() {
    void this.tick();
  }
  private schedule() {
    clearTimeout(this.timer);
    void this.items().then((items) => {
      let next = Infinity;
      for (const item of items) {
        if (!isActive(item)) continue;
        for (const peer of Object.values(item.peers))
          if (this.automaticallyDue(peer, Infinity))
            next = Math.min(next, peer.nextAttempt!);
      }
      if (next !== Infinity)
        this.timer = setTimeout(
          () => void this.tick(),
          Math.max(250, next - Date.now()),
        );
    });
  }
  /** Whether automatic delivery may attempt this peer at time `now`. */
  private automaticallyDue(peer: PeerDelivery, now: number): boolean {
    return (
      peer.state !== "accepted" &&
      peer.state !== "refused" &&
      peer.failure !== "unresolved" &&
      peer.nextAttempt !== null &&
      peer.nextAttempt <= now
    );
  }
  /** Sends every record with a due peer, in group order. */
  async tick() {
    if (!navigator.onLine) {
      this.schedule();
      return;
    }
    const now = Date.now();
    for (const item of await this.items()) {
      if (!isActive(item)) continue;
      if (
        Object.values(item.peers).some((peer) =>
          this.automaticallyDue(peer, now),
        )
      )
        await this.deliver(item.id, false);
    }
    this.schedule();
  }
  /**
   * Delivers one record. Automatic delivery follows each peer's own schedule
   * and skips stopped records and refused or unresolved peers. An explicit
   * attempt retries every unfinished peer now.
   */
  async deliver(
    id: string,
    explicit: boolean,
  ): Promise<OutboxItem | undefined> {
    // A second caller waits for the attempt in progress instead of racing it.
    const running = this.inFlight.get(id);
    if (running) return running;
    const work = this.deliverNow(id, explicit).finally(() =>
      this.inFlight.delete(id),
    );
    this.inFlight.set(id, work);
    return work;
  }
  private async deliverNow(
    id: string,
    explicit: boolean,
  ): Promise<OutboxItem | undefined> {
    let item = await this.fresh(id);
    if (!item) return undefined;
    // Earlier records of the same group go first so dependencies arrive in order.
    const earlier = (await this.items()).filter(
      (other) =>
        other.group === item!.group &&
        other.order < item!.order &&
        isActive(other),
    );
    for (const dependency of earlier)
      await this.deliver(dependency.id, explicit);
    item = (await this.fresh(id)) ?? item;
    const now = Date.now();
    for (const peerId of Object.keys(item.peers)) {
      const current = await this.fresh(id);
      if (!current) return undefined;
      const peer = current.peers[peerId];
      if (!peer || peer.state === "accepted") continue;
      if (!explicit && (current.stopped || !this.automaticallyDue(peer, now)))
        continue;
      const started = Date.now();
      const next = await this.attempt(current, peerId, peer);
      // Merge only this peer's result with what is stored now. A stop, another
      // tab's acceptance, or a newer retry decision stays.
      await this.store.mergeOutbox(id, (stored) => ({
        ...stored,
        peers: {
          ...stored.peers,
          [peerId]: stored.peers[peerId]
            ? mergePeer(stored.peers[peerId], next, started)
            : next,
        },
      }));
      await this.notify();
    }
    return this.fresh(id);
  }
  private async attempt(
    item: OutboxItem,
    peerId: string,
    peer: PeerDelivery,
  ): Promise<PeerDelivery> {
    const target = savedPeer(item, peerId);
    if (!target)
      return {
        ...peer,
        nextAttempt: null,
        error: `Recipient "${peerId}" is not configured in this record. The record saved no address for it, and current preferences never replace a missing address. Nothing was sent.`,
        failure: "unresolved",
      };
    const started = Date.now();
    const attempts = peer.attempts + 1;
    const fetchVariant = (id: string) =>
      objectBytes(`/events/${encodeURIComponent(id)}`, 20480, {
        peer: target,
      });
    const settle = async (receipt: Receipt): Promise<PeerDelivery> => {
      const { state, error } = await classifyReceipt(
        item,
        receipt,
        fetchVariant,
      );
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
      };
    };
    try {
      // After an unknown outcome, ask whether the record arrived before sending again.
      if (peer.state === "unknown" || peer.state === "missing-body") {
        try {
          const receipt = await getReceipt(item.id, { peer: target });
          const settled = await settle(receipt);
          if (settled.state === "accepted" || settled.state === "refused")
            return settled;
        } catch (error) {
          if (!(error instanceof RequestError && error.status === 404))
            throw error;
        }
      }
      const receipt = await postEvent(item.transport, { peer: target });
      return settle(receipt);
    } catch (error) {
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
        };
      }
      const transport = error instanceof TransportError ? error.kind : null;
      return {
        state: "unknown",
        attempts,
        lastAttempt: started,
        nextAttempt: started + backoff(attempts, null),
        error: error instanceof Error ? error.message : "Delivery is unknown.",
        failure: transport ?? "server",
        receipt: peer.receipt,
      };
    }
  }
  /** Stops future automatic attempts for every unfinished selected peer of one record. */
  async stop(id: string) {
    await this.store.mergeOutbox(id, (item) => ({ ...item, stopped: true }));
    await this.notify();
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
            : ({
                ...peer,
                state: peer.state === "queued" ? "queued" : "unknown",
                nextAttempt: Date.now(),
                failure: peer.failure === "unresolved" ? null : peer.failure,
              } as PeerDelivery),
        ]),
      ),
    }));
    await this.notify();
    await this.deliver(id, true);
    this.schedule();
  }
  /** Immediate explicit attempt. Follows the receipt lookup and immutable retry rules. */
  async tryNow(id: string) {
    await this.store.mergeOutbox(id, (item) => ({
      ...item,
      peers: Object.fromEntries(
        Object.entries(item.peers).map(([peerId, peer]) => [
          peerId,
          peer.state === "accepted" || peer.state === "queued"
            ? peer
            : ({
                ...peer,
                state: peer.state === "refused" ? "unknown" : peer.state,
                failure: peer.failure === "unresolved" ? null : peer.failure,
              } as PeerDelivery),
        ]),
      ),
    }));
    await this.notify();
    const result = await this.deliver(id, true);
    this.schedule();
    return result;
  }
  /** Signed records and their bodies as JSON lines, for export. */
  async exportLines(items: OutboxItem[]): Promise<string> {
    return (
      items.map((item) => item.transport).join("\n") +
      (items.length ? "\n" : "")
    );
  }
}
