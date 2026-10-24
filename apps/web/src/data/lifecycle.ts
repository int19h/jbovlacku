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
} from "../../../../packages/core/src/browser.ts";
import {
  getActivity,
  getEnvelope,
  identityHeads,
  RequestError,
  TransportError,
  type Peer,
  type IdentityHeadsPage,
} from "./api.ts";
import {
  loadOwnHistory,
  snapshotExpired,
  SNAPSHOT_SCAN_ATTEMPTS,
  type OwnHistory,
} from "./history.ts";
import { freshPeer } from "./delivery.ts";
import {
  discardedPredecessorReads,
  DISCARDED_PREDECESSOR,
} from "./outbox-graph.ts";
import {
  describeTransport,
  type KeyBackup,
  type LocalStore,
  type OutboxItem,
  type SavedRecipient,
} from "./store.ts";
import type { ActivityResponse, Envelope, Transport } from "../model/types.ts";

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
/**
 * How a peer scan ended. "complete" reached every terminal cursor and proved
 * every listed claim. "unreachable" got no usable answer at all. "partial"
 * stopped at a limit or timeout. "malformed" received a page that breaks the
 * API contract, such as a repeated cursor or another snapshot.
 */
export type ScanOutcome = "complete" | "unreachable" | "partial" | "malformed";
export interface PeerKnowledge {
  peer: Peer;
  /** "answered" when every request succeeded and every scan reached its end, else the failure text. */
  status: "answered" | string;
  /** True only when the head and activity scans reached a terminal cursor. */
  complete: boolean;
  outcome: ScanOutcome;
  snapshot: string | null;
  heads: string[];
  /** Authenticated transfer events by this identity, with their successor. */
  transfers: { id: string; successor: string }[];
  /** Authenticated compromise notices by this identity. */
  compromises: string[];
  /** Authenticated acceptance events by the successor identity that name a transfer. */
  acceptances: { id: string; transfer: string }[];
  /** All successor records listed by the complete activity scan. */
  successorEvents: string[];
  /** Listed lifecycle claims that failed authentication. */
  unverified: UnverifiedClaim[];
}
/** Bounds on one peer scan. They are explicit and reported when hit. */
export const SCAN_LIMITS = { pages: 64, items: 20000, millis: 60000 };
class ScanIncomplete extends Error {}
class ScanMalformed extends Error {}
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
    peers.map((peer) => scanPeer(peer, identity, successor, signal)),
  );
}
interface ScanBudget {
  signal: AbortSignal;
  check: () => void;
  attempts: number;
  pages: number;
  items: number;
}
const scanContexts = new WeakMap<
  PeerKnowledge,
  {
    identity: string;
    successor: string | null;
    budget: ScanBudget;
  }
>();
function newScanBudget(signal?: AbortSignal): ScanBudget {
  const deadline = AbortSignal.timeout(SCAN_LIMITS.millis);
  return {
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    check: () => {
      if (deadline.aborted)
        throw new ScanIncomplete(
          `the scan exceeded ${SCAN_LIMITS.millis / 1000} seconds`,
        );
      signal?.throwIfAborted();
    },
    attempts: 0,
    pages: 0,
    items: 0,
  };
}
async function scanPeer(
  peer: Peer,
  identity: string,
  successor: string | null,
  signal?: AbortSignal,
  budget = newScanBudget(signal),
): Promise<PeerKnowledge> {
  for (;;) {
    budget.attempts++;
    const knowledge: PeerKnowledge = {
      peer,
      status: "answered",
      complete: false,
      outcome: "unreachable",
      snapshot: null,
      heads: [],
      transfers: [],
      compromises: [],
      acceptances: [],
      successorEvents: [],
      unverified: [],
    };
    const scanSignal = budget.signal;
    const check = budget.check;
    scanContexts.set(knowledge, { identity, successor, budget });
    // The first raw head page captures the accepted inventory. Later failures
    // leave known evidence and block instead of counting as unreachable.
    let stage: "capture" | "heads" | "activity" | "claims" = "capture";
    try {
      check();
      const firstPage = await identityHeads(identity, null, null, {
        peer,
        signal: scanSignal,
      });
      const snapshot = firstPage.snapshot;
      knowledge.snapshot = snapshot;
      stage = "heads";
      let after: string | null = null;
      const seen = new Set<string>();
      for (let page = 0; ; page++) {
        check();
        if (++budget.pages > SCAN_LIMITS.pages)
          throw new ScanIncomplete(
            `the head scan did not end within ${SCAN_LIMITS.pages} pages`,
          );
        const result: IdentityHeadsPage =
          page === 0
            ? firstPage
            : await identityHeads(identity, snapshot, after, {
                peer,
                signal: scanSignal,
              });
        let previous = after ?? "";
        for (const head of result.heads) {
          if (head <= previous)
            throw new ScanMalformed("the head scan did not advance");
          previous = head;
          knowledge.heads.push(head);
        }
        budget.items += result.heads.length;
        if (budget.items > SCAN_LIMITS.items)
          throw new ScanIncomplete("the head scan exceeded the item limit");
        if (result.next === null) break;
        if (
          seen.has(result.next) ||
          result.next !== result.heads.at(-1) ||
          (after !== null && result.next <= after)
        )
          throw new ScanMalformed(
            "the head scan repeated or malformed a cursor",
          );
        seen.add(result.next);
        after = result.next;
      }
      stage = "activity";
      const scan = async (who: string) => {
        const items: { id: string; action: Record<string, unknown> }[] = [];
        let cursor: string | null = null;
        const cursors = new Set<string>();
        for (let page = 0; ; page++) {
          check();
          if (
            ++budget.pages > SCAN_LIMITS.pages ||
            budget.items > SCAN_LIMITS.items
          )
            throw new ScanIncomplete(
              `the activity scan of ${who.slice(0, 16)}… did not end within the scan limits`,
            );
          const result: Omit<ActivityResponse, "view"> = await getActivity(
            who,
            cursor,
            {
              peer,
              signal: scanSignal,
              snapshot,
              accepted: true,
              limit: 200,
            },
          );
          if (result.snapshot !== snapshot)
            throw new ScanMalformed(
              "the activity scan answered for another snapshot",
            );
          for (const item of result.items) {
            if (cursor !== null && item.id <= cursor)
              throw new ScanMalformed("the activity scan did not advance");
            cursor = item.id;
          }
          items.push(...result.items);
          budget.items += result.items.length;
          if (budget.items > SCAN_LIMITS.items)
            throw new ScanIncomplete(
              "the activity scan exceeded the item limit",
            );
          if (result.next === null) break;
          if (
            cursors.has(result.next) ||
            result.next !== result.items.at(-1)?.id
          )
            throw new ScanMalformed(
              "the activity scan repeated or malformed a cursor",
            );
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
          const envelope = await getEnvelope(id, snapshot, {
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
          if (snapshotExpired(error)) throw error;
          knowledge.unverified.push({
            id,
            kind,
            reason: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      };
      const ownItems = await scan(identity);
      const successorItems = successor ? await scan(successor) : [];
      knowledge.successorEvents = successorItems.map((item) => item.id);
      stage = "claims";
      for (const item of ownItems) {
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
      for (const item of successorItems)
        if (successor && item.action.kind === "identity.accept") {
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
      knowledge.outcome = knowledge.unverified.length
        ? "malformed"
        : "complete";
      if (knowledge.unverified.length)
        knowledge.status = `it listed ${knowledge.unverified.length} lifecycle record${knowledge.unverified.length === 1 ? "" : "s"} that it could not supply as valid signed evidence`;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "The peer did not answer.";
      if (snapshotExpired(error) && stage !== "capture") {
        // Evidence from an expired inventory cannot be mixed into the next attempt.
        if (budget.attempts < SNAPSHOT_SCAN_ATTEMPTS) continue;
        knowledge.snapshot = null;
        knowledge.heads = [];
        knowledge.transfers = [];
        knowledge.compromises = [];
        knowledge.acceptances = [];
        knowledge.successorEvents = [];
        knowledge.unverified = [];
        knowledge.complete = false;
        knowledge.outcome = "partial";
        knowledge.status =
          "incomplete: the server snapshots kept expiring. Retry before signing";
      } else if (error instanceof ScanIncomplete) {
        knowledge.outcome = "partial";
        knowledge.status = `incomplete: ${message}`;
      } else if (error instanceof ScanMalformed) {
        knowledge.outcome = "malformed";
        knowledge.status = `malformed answer: ${message}`;
      } else if (
        stage === "capture" &&
        (error instanceof TransportError || error instanceof RequestError)
      ) {
        // No usable answer at all.
        knowledge.outcome = "unreachable";
        knowledge.status = message;
      } else if (error instanceof TransportError) {
        // The connection failed or timed out after the peer supplied evidence.
        knowledge.outcome = "partial";
        knowledge.status = `incomplete: the ${stage} scan stopped (${message})`;
      } else if (error instanceof RequestError) {
        knowledge.outcome = "malformed";
        knowledge.status = `malformed answer: the ${stage} scan got HTTP ${error.status} (${message})`;
      } else {
        // A response that the shared readers could not interpret.
        knowledge.outcome = "malformed";
        knowledge.status = `malformed answer: ${message}`;
      }
    }
    return knowledge;
  }
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
  let committedHeads: string[] | undefined;
  for (const k of knowledge) {
    if (k.outcome !== "complete" || !k.snapshot) continue;
    for (;;) {
      const learned = new Map<string, Envelope>();
      const context = scanContexts.get(k);
      const pending = k.heads.filter((h) => !history.events.has(h));
      try {
        while (pending.length) {
          signal?.throwIfAborted();
          context?.budget.check();
          const id = pending.pop()!;
          if (history.events.has(id) || learned.has(id)) continue;
          if (fetched + learned.size >= 4096)
            throw new Error(
              `${k.peer.label} reports more than 4096 unknown records. This browser client cannot follow a history that large. Export the outbox from Not delivered to keep your signed records.`,
            );
          let envelope: Envelope;
          try {
            if (context && ++context.budget.items > SCAN_LIMITS.items)
              throw new ScanIncomplete(
                "the branch scan exceeded the item limit",
              );
            envelope = await getEnvelope(id, k.snapshot!, {
              peer: k.peer,
              signal: context?.budget.signal ?? signal,
            });
            verifyEnvelope(utf8(JSON.stringify(envelope)));
          } catch (error) {
            if (snapshotExpired(error) || error instanceof ScanIncomplete)
              throw error;
            // A branch with a missing ancestor is not known history. Nothing of it is kept.
            throw new Error(
              `${k.peer.label} reports record ${id.slice(0, 20)}… but could not supply it as a valid signed record (${error instanceof Error ? error.message : String(error)}).`,
            );
          }
          if (envelope.id !== id || envelope.header.issuer !== history.identity)
            throw new Error(
              `${k.peer.label} supplied a record that does not belong to this key.`,
            );
          learned.set(id, envelope);
          for (const previous of envelope.header.previous)
            if (!history.events.has(previous) && !learned.has(previous))
              pending.push(previous);
        }
      } catch (error) {
        if (!snapshotExpired(error)) throw error;
        if (context && context.budget.attempts < SNAPSHOT_SCAN_ATTEMPTS) {
          const fresh = await scanPeer(
            k.peer,
            context.identity,
            context.successor,
            signal,
            context.budget,
          );
          Object.assign(k, fresh);
          scanContexts.set(k, context);
          if (k.outcome === "complete") continue;
        } else {
          k.snapshot = null;
          k.heads = [];
          k.transfers = [];
          k.compromises = [];
          k.acceptances = [];
          k.successorEvents = [];
          k.unverified = [];
          k.complete = false;
          k.outcome = "partial";
          k.status =
            "incomplete: the server snapshots kept expiring. Retry before signing";
        }
        throw new Error(`${k.peer.label}: ${k.status}. Retry before signing.`);
      }
      if (!learned.size) break;
      // Keep the complete verified branch and its heads locally in one write, so
      // later history loads do not depend on that peer.
      committedHeads = await store.restoreServerOwn(history.identity, [
        ...learned.values(),
      ]);
      for (const [id, envelope] of learned) history.events.set(id, envelope);
      fetched += learned.size;
      break;
    }
  }
  if (fetched) {
    const ancestors = new Set<string>();
    for (const envelope of history.events.values())
      for (const previous of envelope.header.previous) ancestors.add(previous);
    history.frontier = [...history.events.keys()]
      .filter((id) => !ancestors.has(id))
      .sort();
    if (committedHeads) {
      if (committedHeads.join(" ") !== history.frontier.join(" "))
        throw new Error(
          "The local own history changed during refresh. Refresh the history before signing.",
        );
      history.storedHeads = committedHeads;
    }
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
    const discarded = discardedPredecessorReads(keys, [
      ...transferEnvelope.header.previous,
      ...acceptEnvelope.header.previous,
    ]);
    const reads = [
      keys.get("selected"),
      keys.get(`handover:${old.identity}`),
      keys.get(`compromised:${old.identity}`),
      heads.get(old.identity),
      heads.get(successor.identity),
      keys.get(`handover-of:${successor.identity}`),
      keys.get(`transfer-known:${old.identity}`),
      ...discarded,
    ] as IDBRequest[];
    let remaining = reads.length;
    const results: unknown[] = [];
    reads.forEach((request, index) => {
      request.onsuccess = () => {
        results[index] = request.result;
        if (--remaining) return;
        if (discarded.some((request) => request.result))
          return stop(DISCARDED_PREDECESSOR);
        const [
          selected,
          handover,
          compromised,
          oldHeads,
          successorHeads,
          successorRecord,
          knownTransfer,
        ] = results as [
          KeyBackup | undefined,
          unknown,
          unknown,
          string[] | undefined,
          string[] | undefined,
          unknown,
          unknown,
        ];
        if (selected?.identity !== old.identity)
          return stop(
            "Another tab changed the selected key. Nothing was saved or sent. Reload and review the handover again.",
          );
        if (handover || compromised || knownTransfer)
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
/** Saves one recovery acceptance and retires the old key before any send. */
export async function queueRecoveryAcceptance(
  store: LocalStore,
  transfer: Envelope,
  accept: OutboxItem,
  old: KeyBackup,
  successor: KeyBackup,
): Promise<HandoverRecord> {
  verifyEnvelope(utf8(JSON.stringify(transfer)));
  const acceptance = (JSON.parse(accept.transport) as Transport).envelope;
  verifyEnvelope(utf8(JSON.stringify(acceptance)));
  if (
    transfer.header.issuer !== old.identity ||
    transfer.header.action.kind !== "identity.transfer" ||
    transfer.header.action.successor !== successor.identity ||
    acceptance.header.issuer !== successor.identity ||
    acceptance.header.action.kind !== "identity.accept" ||
    acceptance.header.action.transfer !== transfer.id ||
    acceptance.header.previous.length !== 0
  )
    throw new Error(
      "The recovery acceptance does not match the transfer and keys.",
    );
  const transferItem = outboxItem(
    { envelope: transfer, body: null },
    accept.group,
    0,
    accept.recipients ?? {},
  );
  accept = { ...accept, order: 1 };
  const record: HandoverRecord = {
    old: old.identity,
    successor: successor.identity,
    transfer: transfer.id,
    accept: accept.id,
    signedAt: Date.now(),
  };
  const db = await store.database;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(
      ["keys", "outbox", "heads", "ownhistory"],
      "readwrite",
    );
    const keys = tx.objectStore("keys");
    const heads = tx.objectStore("heads");
    const reads = [
      keys.get("selected"),
      keys.get(`handover:${old.identity}`),
      keys.get(`recovery:${transfer.id}`),
      keys.get(`compromised:${old.identity}`),
      heads.get(successor.identity),
      keys.get(`handover-of:${successor.identity}`),
      keys.get(`transfer-known:${old.identity}`),
      heads.get(old.identity),
    ];
    let remaining = reads.length;
    let failure: Error | undefined;
    for (const read of reads)
      read.onsuccess = () => {
        if (--remaining) return;
        if (
          (reads[0].result as KeyBackup | undefined)?.identity !==
            old.identity ||
          reads.slice(1, 4).some((r) => r.result) ||
          (reads[4].result as string[] | undefined)?.length ||
          reads[5].result ||
          reads[6].result !== transfer.id
        ) {
          failure = new LifecycleConflictError(
            "The recovery state changed or an acceptance is already saved. Nothing was saved or sent. Reload and search again.",
          );
          tx.abort();
          return;
        }
        keys.put(accept.id, `recovery:${transfer.id}`);
        keys.put(record, `handover:${old.identity}`);
        keys.put(record, `handover-of:${successor.identity}`);
        keys.put(old, `retired:${old.identity}`);
        keys.put(successor, "selected");
        keys.put(true, `tested:${successor.identity}`);
        tx.objectStore("outbox").put(transferItem, transferItem.id);
        tx.objectStore("outbox").put(accept, accept.id);
        tx.objectStore("ownhistory").put(transfer, transfer.id);
        // Keep every remembered old branch and add the original transfer as a known reference.
        heads.put(
          [
            ...new Set([
              ...((reads[7].result as string[] | undefined) ?? []),
              transfer.id,
            ]),
          ].sort(),
          old.identity,
        );
        heads.put([accept.id], successor.identity);
      };
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(
        failure ??
          tx.error ??
          new Error("Local storage did not save the recovery acceptance."),
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
    const discarded = discardedPredecessorReads(keys, envelope.header.previous);
    let remaining = 2 + discarded.length;
    const proceed = () => {
      if (--remaining) return;
      if (discarded.some((request) => request.result)) {
        failure = new LifecycleConflictError(DISCARDED_PREDECESSOR);
        return tx.abort();
      }
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
    for (const request of discarded) request.onsuccess = proceed;
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
/** The own events in causal order, oldest first, without recursive traversal. */
export function causalOrder(history: OwnHistory): { order: Envelope[] } {
  const done = new Set<string>();
  const active = new Set<string>();
  const order: Envelope[] = [];
  for (const id of [...history.events.keys()].sort()) {
    const stack: { id: string; exit: boolean }[] = [{ id, exit: false }];
    while (stack.length) {
      const next = stack.pop()!;
      if (done.has(next.id)) continue;
      const envelope = history.events.get(next.id);
      if (!envelope) continue;
      if (next.exit) {
        active.delete(next.id);
        done.add(next.id);
        order.push(envelope);
        continue;
      }
      if (active.has(next.id))
        throw new Error("The known history contains a causal cycle.");
      active.add(next.id);
      stack.push({ id: next.id, exit: true });
      for (const previous of [...envelope.header.previous].reverse())
        stack.push({ id: previous, exit: false });
    }
  }
  return { order };
}
/** The retained and excluded sets for a chosen safe frontier. */
export function cutoffPreview(
  history: OwnHistory,
  safe: string[],
): { retained: string[]; excluded: string[] } {
  const { order } = causalOrder(history);
  const retained = new Set<string>();
  const pending = [...safe];
  while (pending.length) {
    const id = pending.pop()!;
    if (retained.has(id)) continue;
    const event = history.events.get(id);
    if (!event) continue;
    retained.add(id);
    pending.push(...event.header.previous);
  }
  return {
    retained: order.map((e) => e.id).filter((id) => retained.has(id)),
    excluded: order.map((e) => e.id).filter((id) => !retained.has(id)),
  };
}
export { loadOwnHistory };
