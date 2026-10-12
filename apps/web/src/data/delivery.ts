/**
 * Delivery of signed records to peers. Records are immutable. Retry sends the
 * identical bytes. Each peer has its own receipt and schedule.
 */
import {
  getReceipt,
  postEvent,
  RequestError,
  selfPeer,
  TransportError,
  type Peer,
} from "./api.ts";
import type {
  LocalStore,
  OutboxItem,
  PeerDelivery,
  PeerState,
} from "./store.ts";
import type { Receipt, Transport } from "../model/types.ts";

export const peers: Record<string, Peer> = { self: selfPeer };
export function peerFor(id: string): Peer {
  return peers[id] ?? selfPeer;
}
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
/**
 * Interprets a receipt for an item. Delivery completes only when the envelope
 * is stored and every required body is present with its hash.
 */
export function classifyReceipt(
  item: OutboxItem,
  receipt: Receipt,
): { state: PeerState; error: string | null } {
  if (receipt.admission === "refused")
    return {
      state: "refused",
      error: `This server refused the record: ${receipt.reasons.join(", ") || "no reason given"}.`,
    };
  if (requiresBody(item.transport)) {
    if (receipt.body_status === "present")
      return { state: "accepted", error: null };
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
  return { state: "accepted", error: null };
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

export class DeliveryEngine {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<DeliveryListener>();
  private inFlight = new Set<string>();
  private cache: OutboxItem[] | null = null;
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
    this.cache = null;
    const items = await this.items().catch(() => [] as OutboxItem[]);
    for (const listener of this.listeners) listener(items);
  }
  async items(): Promise<OutboxItem[]> {
    if (!this.cache) {
      const items = await this.store.list<OutboxItem>("outbox");
      this.cache = items.sort(
        (a, b) =>
          a.signedAt - b.signedAt ||
          a.group.localeCompare(b.group) ||
          a.order - b.order,
      );
    }
    return this.cache;
  }
  async active(): Promise<OutboxItem[]> {
    return (await this.items()).filter(isActive);
  }
  async stopped(): Promise<OutboxItem[]> {
    return (await this.items()).filter(
      (item) => item.stopped && !isFinished(item),
    );
  }
  private async save(item: OutboxItem) {
    await this.store.put("outbox", item.id, item);
    await this.notify();
  }
  /** Drops the cached list after an external write and tells listeners. */
  async invalidate() {
    await this.notify();
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
          if (
            peer.state !== "accepted" &&
            peer.state !== "refused" &&
            peer.nextAttempt !== null
          )
            next = Math.min(next, peer.nextAttempt);
      }
      if (next !== Infinity)
        this.timer = setTimeout(
          () => void this.tick(),
          Math.max(250, next - Date.now()),
        );
    });
  }
  /** Sends every record whose next attempt is due, in group order. */
  async tick() {
    if (!navigator.onLine) {
      this.schedule();
      return;
    }
    const now = Date.now();
    for (const item of await this.items()) {
      if (!isActive(item)) continue;
      const due = Object.values(item.peers).some(
        (peer) =>
          peer.state !== "accepted" &&
          peer.state !== "refused" &&
          peer.nextAttempt !== null &&
          peer.nextAttempt <= now,
      );
      if (due) await this.deliver(item.id, false);
    }
    this.schedule();
  }
  /**
   * Delivers one record to every unfinished selected peer. Explicit attempts
   * also retry refused records.
   */
  async deliver(
    id: string,
    explicit: boolean,
  ): Promise<OutboxItem | undefined> {
    if (this.inFlight.has(id))
      return (await this.items()).find((item) => item.id === id);
    this.inFlight.add(id);
    try {
      let item = (await this.items()).find((item) => item.id === id);
      if (!item) {
        this.cache = null;
        item = (await this.items()).find((item) => item.id === id);
      }
      if (!item) return undefined;
      // Earlier records of the same group go first so dependencies arrive in order.
      const earlier = (await this.items()).filter(
        (other) =>
          other.group === item!.group &&
          other.order < item!.order &&
          isActive(other),
      );
      for (const dependency of earlier) {
        if (!this.inFlight.has(dependency.id))
          await this.deliver(dependency.id, explicit);
      }
      item = (await this.items()).find((item) => item.id === id)!;
      for (const [peerId, peer] of Object.entries(item.peers)) {
        if (peer.state === "accepted") continue;
        if (peer.state === "refused" && !explicit) continue;
        if (item.stopped && !explicit) continue;
        const next = await this.attempt(item, peerId, peer);
        item = { ...item, peers: { ...item.peers, [peerId]: next } };
        await this.save(item);
      }
      return item;
    } finally {
      this.inFlight.delete(id);
    }
  }
  private async attempt(
    item: OutboxItem,
    peerId: string,
    peer: PeerDelivery,
  ): Promise<PeerDelivery> {
    const target = peerFor(peerId);
    const started = Date.now();
    const attempts = peer.attempts + 1;
    const settle = (receipt: Receipt): PeerDelivery => {
      if (receipt.id !== item.id)
        throw new Error(
          "The server returned a receipt for another record. Delivery remains unknown.",
        );
      const { state, error } = classifyReceipt(item, receipt);
      return {
        state,
        attempts,
        lastAttempt: started,
        nextAttempt:
          state === "accepted" || state === "refused"
            ? null
            : started + backoff(attempts, null),
        error,
        failure: state === "refused" ? "refused" : null,
        receipt,
      };
    };
    try {
      // After an unknown outcome, ask whether the record arrived before sending again.
      if (peer.state === "unknown" || peer.state === "missing-body") {
        try {
          const receipt = await getReceipt(item.id, { peer: target });
          const settled = settle(receipt);
          if (settled.state !== "missing-body") return settled;
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
    const item = (await this.items()).find((item) => item.id === id);
    if (!item) return;
    await this.save({ ...item, stopped: true });
  }
  /** Resumes delivery with the same bytes and recipients, after a receipt lookup. */
  async resume(id: string) {
    const item = (await this.items()).find((item) => item.id === id);
    if (!item) return;
    const peersNext = Object.fromEntries(
      Object.entries(item.peers).map(([peerId, peer]) => [
        peerId,
        peer.state === "accepted"
          ? peer
          : ({
              ...peer,
              state: peer.state === "queued" ? "queued" : "unknown",
              nextAttempt: Date.now(),
            } as PeerDelivery),
      ]),
    );
    await this.save({ ...item, stopped: false, peers: peersNext });
    await this.deliver(id, true);
    this.schedule();
  }
  /** Immediate explicit attempt. Follows the receipt lookup and immutable retry rules. */
  async tryNow(id: string) {
    const item = (await this.items()).find((item) => item.id === id);
    if (!item) return;
    const peersNext = Object.fromEntries(
      Object.entries(item.peers).map(([peerId, peer]) => [
        peerId,
        peer.state === "accepted" || peer.state === "queued"
          ? peer
          : ({
              ...peer,
              state: peer.state === "refused" ? "unknown" : peer.state,
            } as PeerDelivery),
      ]),
    );
    await this.save({ ...item, peers: peersNext });
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
