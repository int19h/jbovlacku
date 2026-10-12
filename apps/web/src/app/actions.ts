/**
 * Signing. A group of records is signed in dependency order, persisted as one
 * local transaction, and only then dispatched. Retry never creates a new signature.
 */
import {
  canonicalize,
  finishSigning,
  prepareSigning,
  utf8,
} from "../../../../packages/core/src/index.ts";
import { forgetWord } from "../data/api.ts";
import { ownHeads } from "../data/history.ts";
import { freshPeer, type DeliveryEngine } from "../data/delivery.ts";
import {
  describeTransport,
  type OutboxItem,
  type OutboxLabel,
} from "../data/store.ts";
import type { Session } from "./session.ts";
import type { Transport } from "../model/types.ts";

export interface GroupItem {
  action: Record<string, unknown> & { kind: string };
  body: unknown | null;
  /** Fills references to earlier items of the group, by index. */
  dependsOn?: (ids: string[]) => Record<string, unknown>;
  label?: Partial<OutboxLabel>;
}
export interface SignedGroup {
  group: string;
  items: OutboxItem[];
  ids: string[];
}
export class Signer {
  constructor(
    private session: Session,
    private delivery: DeliveryEngine,
    private offlineSigning: () => boolean,
  ) {}
  /** Signs and persists a group. Does not send. */
  async sign(
    items: GroupItem[],
    peerIds: string[] = this.session.preferences.peers.map((peer) => peer.id),
  ): Promise<SignedGroup> {
    const session = this.session;
    if (!session.storageAvailable)
      throw new Error(
        "Restore browser storage access and reload before signing.",
      );
    if (!session.backup || !session.workingKey)
      throw new Error("Unlock your key before signing.");
    const identity = session.backup.identity;
    const signingKey = session.workingKey;
    let previous = await ownHeads(
      session.store,
      identity,
      this.offlineSigning(),
    );
    if (
      session.workingKey !== signingKey ||
      session.backup?.identity !== identity
    )
      throw new Error("Unlock this identity again before signing.");
    const group = crypto.randomUUID();
    const signed: OutboxItem[] = [];
    const ids: string[] = [];
    for (const [order, item] of items.entries()) {
      const nonce = Array.from(
        crypto.getRandomValues(new Uint8Array(16)),
        (n) => n.toString(16).padStart(2, "0"),
      ).join("");
      const action = {
        ...item.action,
        ...(item.dependsOn ? item.dependsOn(ids) : {}),
      };
      const prepared = prepareSigning(
        identity,
        previous,
        nonce,
        action,
        item.body,
      );
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          "Ed25519",
          signingKey,
          prepared.signing_bytes as BufferSource,
        ),
      );
      if (session.workingKey !== signingKey)
        throw new Error(
          "The key was locked before the signed group was saved. Sign again.",
        );
      const transport = finishSigning(prepared, signature) as Transport;
      const bytes = canonicalize(utf8(JSON.stringify(transport)));
      const label = { ...describeTransport(transport), ...(item.label ?? {}) };
      signed.push({
        id: transport.envelope.id,
        identity,
        transport: bytes,
        group,
        order,
        label,
        peers: Object.fromEntries(peerIds.map((peer) => [peer, freshPeer()])),
        stopped: false,
        signedAt: Date.now(),
      });
      ids.push(transport.envelope.id);
      previous = [transport.envelope.id];
    }
    await session.store.queueGroup(signed);
    await this.delivery.invalidate();
    session.touch();
    return { group, items: signed, ids };
  }
  /** Signs, persists, then dispatches the group in order. Returns the stored items after the first attempt. */
  async publish(
    items: GroupItem[],
    peerIds: string[] = this.session.preferences.peers.map((peer) => peer.id),
  ): Promise<OutboxItem[]> {
    const signed = await this.sign(items, peerIds);
    const results: OutboxItem[] = [];
    for (const item of signed.items) {
      const delivered = await this.delivery.deliver(item.id, true);
      results.push(delivered ?? item);
      const action = item.label;
      void action;
    }
    for (const item of items)
      if (typeof item.action.word === "string") forgetWord(item.action.word);
    return results;
  }
}
