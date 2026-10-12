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
} from "../../../../packages/core/src/index.ts";
import { getActivity, getManifest, identityHeads, type Peer } from "./api.ts";
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
/** What one configured peer knows about an identity. */
export interface PeerKnowledge {
  peer: Peer;
  /** "answered" when every request succeeded, else the failure text. */
  status: "answered" | string;
  snapshot: string | null;
  heads: string[];
  /** Existing transfer events by this identity, with their successor. */
  transfers: { id: string; successor: string }[];
  /** Existing compromise notices by this identity. */
  compromises: string[];
  /** Acceptance events by the successor identity that name a transfer. */
  acceptances: { id: string; transfer: string }[];
}
/**
 * Asks every configured peer for the identity's heads and lifecycle events.
 * A failed peer is reported, never treated as empty.
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
        snapshot: null,
        heads: [],
        transfers: [],
        compromises: [],
        acceptances: [],
      };
      try {
        const manifest = await getManifest({ peer, signal });
        knowledge.snapshot = manifest.snapshot;
        let after: string | null = null;
        for (let page = 0; page < 16; page++) {
          const result = await identityHeads(
            identity,
            manifest.snapshot,
            after,
            {
              peer,
              signal,
            },
          );
          knowledge.heads.push(...result.heads);
          after = result.next;
          if (after === null) break;
        }
        const scan = async (who: string) => {
          const items: { id: string; action: Record<string, unknown> }[] = [];
          let cursor: string | null = null;
          for (let page = 0; page < 32; page++) {
            const result = await getActivity(who, cursor, {
              peer,
              signal,
              snapshot: manifest.snapshot,
              limit: 200,
            });
            items.push(...result.items);
            cursor = result.next;
            if (cursor === null) break;
          }
          return items;
        };
        for (const item of await scan(identity)) {
          if (item.action.kind === "identity.transfer")
            knowledge.transfers.push({
              id: item.id,
              successor: String(item.action.successor),
            });
          if (item.action.kind === "identity.compromise")
            knowledge.compromises.push(item.id);
        }
        if (successor)
          for (const item of await scan(successor))
            if (item.action.kind === "identity.accept")
              knowledge.acceptances.push({
                id: item.id,
                transfer: String(item.action.transfer),
              });
      } catch (error) {
        knowledge.status =
          error instanceof Error ? error.message : "The peer did not answer.";
      }
      return knowledge;
    }),
  );
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
  const db = await store.database;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["outbox", "heads", "keys"], "readwrite");
    const outbox = tx.objectStore("outbox");
    outbox.put(transfer, transfer.id);
    outbox.put(accept, accept.id);
    const heads = tx.objectStore("heads");
    heads.put([transfer.id], old.identity);
    heads.put([accept.id], successor.identity);
    const keys = tx.objectStore("keys");
    keys.put(successor, "selected");
    keys.put(old, `retired:${old.identity}`);
    keys.put(record, `handover:${old.identity}`);
    keys.put(record, `handover-of:${successor.identity}`);
    if (options.successorTested) keys.put(true, `tested:${successor.identity}`);
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(tx.error ?? new Error("Local storage did not save the handover."));
    tx.onerror = () => {};
  });
  return record;
}
/** Persists a compromise notice and marks the key, before any send. */
export async function queueCompromise(
  store: LocalStore,
  item: OutboxItem,
): Promise<void> {
  const envelope = (JSON.parse(item.transport) as Transport).envelope;
  if (envelope.header.action.kind !== "identity.compromise")
    throw new Error("The record is not a compromise notice.");
  const db = await store.database;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["outbox", "heads", "keys"], "readwrite");
    tx.objectStore("outbox").put(item, item.id);
    tx.objectStore("heads").put([item.id], item.identity);
    tx.objectStore("keys").put(item.id, `compromised:${item.identity}`);
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(tx.error ?? new Error("Local storage did not save the notice."));
    tx.onerror = () => {};
  });
}
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
