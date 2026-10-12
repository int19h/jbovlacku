/**
 * Planned handover and compromise notices. Lifecycle events never pass
 * through the ordinary group signer. A handover persists the old key's
 * transfer, the successor's acceptance, and the encrypted successor key in
 * one transaction before any send. A compromise notice names a safe frontier
 * of the key's own history.
 */
import {
  canonicalize,
  finishSigning,
  prepareSigning,
  utf8,
  verifyEnvelope,
} from "../../../../packages/core/src/index.ts";
import {
  getActivity,
  getEnvelope,
  getManifest,
  identityHeads,
  type Peer,
} from "./api.ts";
import { loadOwnHistory, type OwnHistory } from "./history.ts";
import { freshPeer } from "./delivery.ts";
import {
  describeTransport,
  type KeyBackup,
  type LocalStore,
  type OutboxItem,
  type SavedRecipient,
} from "./store.ts";
import type { Envelope, Transport } from "../model/types.ts";

export const LIFECYCLE_KINDS = [
  "identity.transfer",
  "identity.accept",
  "identity.compromise",
  "identity.merge",
];
function nonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
/** Signs one event with an explicit key. The caller chose that key on purpose. */
export async function signWith(
  key: CryptoKey,
  identity: string,
  previous: string[],
  action: Record<string, unknown>,
): Promise<Transport> {
  const prepared = prepareSigning(identity, previous, nonce(), action, null);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      key,
      prepared.signing_bytes as BufferSource,
    ),
  );
  return finishSigning(prepared, signature) as Transport;
}
export function outboxItem(
  transport: Transport,
  group: string,
  order: number,
  recipients: Record<string, SavedRecipient>,
): OutboxItem {
  const bytes = canonicalize(utf8(JSON.stringify(transport)));
  return {
    id: transport.envelope.id,
    identity: transport.envelope.header.issuer,
    transport: bytes,
    group,
    order,
    label: describeTransport(transport),
    recipients,
    peers: Object.fromEntries(
      Object.keys(recipients).map((peer) => [peer, freshPeer()]),
    ),
    stopped: false,
    signedAt: Date.now(),
  };
}
/** A lifecycle claim that a peer listed but could not supply as a valid signed record. */
export interface UnverifiedClaim {
  id: string;
  kind: string;
  reason: string;
}
/** What one configured peer knows about an identity. */
export interface PeerKnowledge {
  peer: Peer;
  /** "answered" when every request succeeded and every scan reached its end, else the failure text. */
  status: "answered" | string;
  /** True only when the head and activity scans reached a terminal cursor. */
  complete: boolean;
  snapshot: string | null;
  heads: string[];
  /** Authenticated transfer events by this identity, with their successor. */
  transfers: { id: string; successor: string }[];
  /** Authenticated compromise notices by this identity. */
  compromises: string[];
  /** Authenticated acceptance events by the successor identity that name a transfer. */
  acceptances: { id: string; transfer: string }[];
  /** Listed lifecycle claims that failed authentication. */
  unverified: UnverifiedClaim[];
}
/** Bounds on one peer scan. They are explicit and reported when hit. */
export const SCAN_LIMITS = { pages: 64, items: 20000, millis: 60000 };
class ScanIncomplete extends Error {}
/**
 * Asks every configured peer for the identity's heads and lifecycle events.
 * A scan is complete only when every page sequence reached a terminal cursor
 * inside the limits. Lifecycle claims count only after the signed record is
 * fetched from that peer and verified. A failed or truncated peer is
 * reported, never treated as empty.
 */
export async function askPeers(
  peers: Peer[],
  identity: string,
  successor: string | null,
  signal?: AbortSignal,
): Promise<PeerKnowledge[]> {
  return Promise.all(
    peers.map(async (peer): Promise<PeerKnowledge> => {
      const knowledge: PeerKnowledge = {
        peer,
        status: "answered",
        complete: false,
        snapshot: null,
        heads: [],
        transfers: [],
        compromises: [],
        acceptances: [],
        unverified: [],
      };
      const deadline = AbortSignal.timeout(SCAN_LIMITS.millis);
      const scanSignal = signal
        ? AbortSignal.any([signal, deadline])
        : deadline;
      const check = () => {
        if (deadline.aborted)
          throw new ScanIncomplete(
            `the scan exceeded ${SCAN_LIMITS.millis / 1000} seconds`,
          );
        signal?.throwIfAborted();
      };
      try {
        const manifest = await getManifest({ peer, signal: scanSignal });
        knowledge.snapshot = manifest.snapshot;
        let after: string | null = null;
        const seen = new Set<string>();
        for (let page = 0; ; page++) {
          check();
          if (page >= SCAN_LIMITS.pages)
            throw new ScanIncomplete(
              `the head scan did not end within ${SCAN_LIMITS.pages} pages`,
            );
          const result = await identityHeads(
            identity,
            manifest.snapshot,
            after,
            { peer, signal: scanSignal },
          );
          for (const head of result.heads) {
            if (after !== null && head <= after)
              throw new Error("the head scan did not advance");
            knowledge.heads.push(head);
          }
          if (result.next === null) break;
          if (
            seen.has(result.next) ||
            result.next !== result.heads.at(-1) ||
            (after !== null && result.next <= after)
          )
            throw new Error("the head scan repeated or malformed a cursor");
          seen.add(result.next);
          after = result.next;
        }
        const scan = async (who: string) => {
          const items: { id: string; action: Record<string, unknown> }[] = [];
          let cursor: string | null = null;
          const cursors = new Set<string>();
          for (let page = 0; ; page++) {
            check();
            if (page >= SCAN_LIMITS.pages || items.length > SCAN_LIMITS.items)
              throw new ScanIncomplete(
                `the activity scan of ${who.slice(0, 16)}… did not end within the scan limits`,
              );
            const result = await getActivity(who, cursor, {
              peer,
              signal: scanSignal,
              snapshot: manifest.snapshot,
              limit: 200,
            });
            items.push(...result.items);
            if (result.next === null) break;
            if (cursors.has(result.next))
              throw new Error("the activity scan repeated a cursor");
            cursors.add(result.next);
            cursor = result.next;
          }
          return items;
        };
        // Authenticate a listed lifecycle event before counting it.
        const authenticated = async (
          id: string,
          who: string,
          kind: string,
        ): Promise<Envelope | null> => {
          try {
            const envelope = await getEnvelope(id, manifest.snapshot, {
              peer,
              signal: scanSignal,
            });
            verifyEnvelope(utf8(JSON.stringify(envelope)));
            if (
              envelope.id !== id ||
              envelope.header.issuer !== who ||
              envelope.header.action.kind !== kind
            )
              throw new Error("the signed record does not match the claim");
            return envelope;
          } catch (error) {
            knowledge.unverified.push({
              id,
              kind,
              reason: error instanceof Error ? error.message : String(error),
            });
            return null;
          }
        };
        for (const item of await scan(identity)) {
          if (item.action.kind === "identity.transfer") {
            const envelope = await authenticated(
              item.id,
              identity,
              "identity.transfer",
            );
            if (envelope)
              knowledge.transfers.push({
                id: envelope.id,
                successor: String(envelope.header.action.successor),
              });
          }
          if (item.action.kind === "identity.compromise") {
            const envelope = await authenticated(
              item.id,
              identity,
              "identity.compromise",
            );
            if (envelope) knowledge.compromises.push(envelope.id);
          }
        }
        if (successor)
          for (const item of await scan(successor))
            if (item.action.kind === "identity.accept") {
              const envelope = await authenticated(
                item.id,
                successor,
                "identity.accept",
              );
              if (envelope)
                knowledge.acceptances.push({
                  id: envelope.id,
                  transfer: String(envelope.header.action.transfer),
                });
            }
        knowledge.complete = true;
        if (knowledge.unverified.length)
          knowledge.status = `it listed ${knowledge.unverified.length} lifecycle record${knowledge.unverified.length === 1 ? "" : "s"} that it could not supply as valid signed evidence`;
      } catch (error) {
        knowledge.status =
          error instanceof ScanIncomplete
            ? `incomplete: ${error.message}`
            : error instanceof Error
              ? error.message
              : "The peer did not answer.";
      }
      return knowledge;
    }),
  );
}
/**
 * Fetches and authenticates the branches that a peer reports and this browser
 * does not hold: each unknown head and its unknown ancestors, from that peer.
 * Every fetched envelope must be signed by the identity and is kept in the
 * local own-history store. A branch that cannot be resolved is an error,
 * never an acknowledged loss.
 */
export async function fetchBranches(
  store: LocalStore,
  history: OwnHistory,
  knowledge: PeerKnowledge[],
  signal?: AbortSignal,
): Promise<{ fetched: number }> {
  let fetched = 0;
  for (const k of knowledge) {
    if (!k.complete || !k.snapshot) continue;
    const pending = k.heads.filter((h) => !history.events.has(h));
    while (pending.length) {
      signal?.throwIfAborted();
      const id = pending.pop()!;
      if (history.events.has(id)) continue;
      if (fetched >= 4096)
        throw new Error(
          `${k.peer.label} reports more than 4096 unknown records. Export and merge history with the CLI.`,
        );
      let envelope: Envelope;
      try {
        envelope = await getEnvelope(id, k.snapshot, { peer: k.peer, signal });
        verifyEnvelope(utf8(JSON.stringify(envelope)));
      } catch (error) {
        throw new Error(
          `${k.peer.label} reports record ${id.slice(0, 20)}… but could not supply it as a valid signed record (${error instanceof Error ? error.message : String(error)}).`,
        );
      }
      if (envelope.id !== id || envelope.header.issuer !== history.identity)
        throw new Error(
          `${k.peer.label} supplied a record that does not belong to this key.`,
        );
      history.events.set(id, envelope);
      // Keep the verified branch locally, so later history loads do not depend on that peer.
      await store.put("ownhistory", id, envelope);
      fetched++;
      for (const previous of envelope.header.previous)
        if (!history.events.has(previous)) pending.push(previous);
    }
  }
  if (fetched) {
    const ancestors = new Set<string>();
    for (const envelope of history.events.values())
      for (const previous of envelope.header.previous) ancestors.add(previous);
    history.frontier = [...history.events.keys()]
      .filter((id) => !ancestors.has(id))
      .sort();
  }
  return { fetched };
}
/** A persisted handover: both events and the successor, for status and retries. */
export interface HandoverRecord {
  old: string;
  successor: string;
  transfer: string;
  accept: string;
  signedAt: number;
}
/**
 * Persists the transfer, the acceptance, the encrypted successor key, the
 * retired old key, and both identities' heads in one transaction. Nothing is
 * sent before this transaction completes.
 */
export async function queueHandover(
  store: LocalStore,
  options: {
    transfer: OutboxItem;
    accept: OutboxItem;
    successor: KeyBackup;
    old: KeyBackup;
    successorTested: boolean;
    /** The previewed frontier. The stored heads must still equal it. */
    expectedHeads: string[];
  },
): Promise<HandoverRecord> {
  const { transfer, accept, successor, old } = options;
  const transferEnvelope = (JSON.parse(transfer.transport) as Transport)
    .envelope;
  const acceptEnvelope = (JSON.parse(accept.transport) as Transport).envelope;
  if (
    transferEnvelope.header.issuer !== old.identity ||
    acceptEnvelope.header.issuer !== successor.identity ||
    transferEnvelope.header.action.successor !== successor.identity ||
    acceptEnvelope.header.action.transfer !== transferEnvelope.id ||
    acceptEnvelope.header.previous.length !== 0
  )
    throw new Error("The handover events do not match the two keys.");
  const record: HandoverRecord = {
    old: old.identity,
    successor: successor.identity,
    transfer: transfer.id,
    accept: accept.id,
    signedAt: Date.now(),
  };
  const expected = [...options.expectedHeads].sort().join(" ");
  const db = await store.database;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["outbox", "heads", "keys"], "readwrite");
    const outbox = tx.objectStore("outbox");
    const heads = tx.objectStore("heads");
    const keys = tx.objectStore("keys");
    let failure: Error | undefined;
    const stop = (message: string) => {
      failure = new LifecycleConflictError(message);
      tx.abort();
    };
    // Compare the current state before writing. Another tab can have retired this key meanwhile.
    const reads = [
      keys.get("selected"),
      keys.get(`handover:${old.identity}`),
      keys.get(`compromised:${old.identity}`),
      heads.get(old.identity),
      heads.get(successor.identity),
      keys.get(`handover-of:${successor.identity}`),
    ] as IDBRequest[];
    let remaining = reads.length;
    const results: unknown[] = [];
    reads.forEach((request, index) => {
      request.onsuccess = () => {
        results[index] = request.result;
        if (--remaining) return;
        const [
          selected,
          handover,
          compromised,
          oldHeads,
          successorHeads,
          successorRecord,
        ] = results as [
          KeyBackup | undefined,
          unknown,
          unknown,
          string[] | undefined,
          string[] | undefined,
          unknown,
        ];
        if (selected?.identity !== old.identity)
          return stop(
            "Another tab changed the selected key. Nothing was saved or sent. Reload and review the handover again.",
          );
        if (handover || compromised)
          return stop(
            "This key was retired or reported stolen meanwhile. Nothing was saved or sent.",
          );
        if ((oldHeads ?? []).slice().sort().join(" ") !== expected)
          return stop(
            "The old key's known history changed during signing. Nothing was saved or sent. Review the handover again.",
          );
        if (successorHeads || successorRecord)
          return stop(
            "The new key already has history in this browser. Nothing was saved or sent.",
          );
        outbox.put(transfer, transfer.id);
        outbox.put(accept, accept.id);
        heads.put([transfer.id], old.identity);
        heads.put([accept.id], successor.identity);
        keys.put(successor, "selected");
        keys.put(old, `retired:${old.identity}`);
        keys.put(record, `handover:${old.identity}`);
        keys.put(record, `handover-of:${successor.identity}`);
        if (options.successorTested)
          keys.put(true, `tested:${successor.identity}`);
      };
    });
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(
        failure ??
          tx.error ??
          new Error("Local storage did not save the handover."),
      );
    tx.onerror = () => {};
  });
  return record;
}
/** Persists a compromise notice and marks the key, before any send. */
export async function queueCompromise(
  store: LocalStore,
  item: OutboxItem,
  expectedHeads: string[],
): Promise<void> {
  const envelope = (JSON.parse(item.transport) as Transport).envelope;
  if (envelope.header.action.kind !== "identity.compromise")
    throw new Error("The record is not a compromise notice.");
  const expected = [...expectedHeads].sort().join(" ");
  const db = await store.database;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["outbox", "heads", "keys"], "readwrite");
    const heads = tx.objectStore("heads");
    const keys = tx.objectStore("keys");
    let failure: Error | undefined;
    const headsRequest = heads.get(item.identity);
    const markRequest = keys.get(`compromised:${item.identity}`);
    let remaining = 2;
    const proceed = () => {
      if (--remaining) return;
      const current = (headsRequest.result as string[] | undefined) ?? [];
      if (markRequest.result) {
        failure = new LifecycleConflictError(
          "This key already has a compromise notice in this browser. Nothing was saved or sent.",
        );
        return tx.abort();
      }
      if (current.slice().sort().join(" ") !== expected) {
        failure = new LifecycleConflictError(
          "The key's known history changed during signing. Nothing was saved or sent. Review the frontier again.",
        );
        return tx.abort();
      }
      tx.objectStore("outbox").put(item, item.id);
      heads.put([item.id], item.identity);
      keys.put(item.id, `compromised:${item.identity}`);
    };
    headsRequest.onsuccess = proceed;
    markRequest.onsuccess = proceed;
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(
        failure ??
          tx.error ??
          new Error("Local storage did not save the notice."),
      );
    tx.onerror = () => {};
  });
}
/** A lifecycle write that found a different stored state than its preview. */
export class LifecycleConflictError extends Error {}
/** The own events of a history in causal order, oldest first, with their ancestors. */
export function causalOrder(history: OwnHistory): {
  order: Envelope[];
  ancestors: Map<string, Set<string>>;
} {
  const events = history.events;
  const ancestors = new Map<string, Set<string>>();
  const order: Envelope[] = [];
  const visiting = new Set<string>();
  const visit = (id: string) => {
    if (ancestors.has(id) || visiting.has(id)) return;
    const envelope = events.get(id);
    if (!envelope) return;
    visiting.add(id);
    const set = new Set<string>();
    for (const previous of envelope.header.previous) {
      visit(previous);
      if (events.has(previous)) {
        set.add(previous);
        for (const a of ancestors.get(previous) ?? []) set.add(a);
      }
    }
    ancestors.set(id, set);
    visiting.delete(id);
    order.push(envelope);
  };
  for (const id of [...events.keys()].sort()) visit(id);
  return { order, ancestors };
}
/** The retained and excluded sets for a chosen safe frontier. */
export function cutoffPreview(
  history: OwnHistory,
  safe: string[],
): { retained: string[]; excluded: string[] } {
  const { order, ancestors } = causalOrder(history);
  const retained = new Set<string>();
  for (const id of safe) {
    if (!history.events.has(id)) continue;
    retained.add(id);
    for (const a of ancestors.get(id) ?? []) retained.add(a);
  }
  return {
    retained: order.map((e) => e.id).filter((id) => retained.has(id)),
    excluded: order.map((e) => e.id).filter((id) => !retained.has(id)),
  };
}
export { loadOwnHistory };
