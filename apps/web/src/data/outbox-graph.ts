/** Local own-history checks for a stopped record. */
import type { Envelope, Transport } from "../model/types.ts";
import type { OutboxItem } from "./store.ts";

export function ownGraph(
  items: OutboxItem[],
  own: Envelope[],
  identity: string,
) {
  const graph = new Map<string, string[]>();
  const add = (envelope: Envelope) => {
    if (
      !Array.isArray(envelope.header.previous) ||
      envelope.header.previous.some((id) => typeof id !== "string")
    )
      throw new Error("The local own history has invalid predecessor links.");
    graph.set(envelope.id, envelope.header.previous);
  };
  for (const envelope of own)
    if (envelope.header.issuer === identity) add(envelope);
  for (const item of items)
    if (item.identity === identity) {
      const envelope = (JSON.parse(item.transport) as Transport).envelope;
      if (envelope.id !== item.id || envelope.header.issuer !== identity)
        throw new Error("The local signed record does not match its identity.");
      add(envelope);
    }
  return graph;
}
/** Every retained chain includes its direct edge into each ancestor. */
export function dependentIds(graph: Map<string, string[]>) {
  const dependedOn = new Set<string>();
  for (const [id, previous] of graph)
    for (const ancestor of previous)
      if (ancestor !== id) dependedOn.add(ancestor);
  return dependedOn;
}
export function hasOwnDependent(graph: Map<string, string[]>, id: string) {
  return dependentIds(graph).has(id);
}
export function remainingHeads(
  graph: Map<string, string[]>,
  remembered: string[],
  discarded: string,
) {
  const candidates = new Set([...remembered, ...graph.keys()]);
  candidates.delete(discarded);
  for (const previous of graph.values())
    for (const id of previous) candidates.delete(id);
  return [...candidates].sort();
}

export const DISCARDED_PREDECESSOR =
  "This group names a discarded local record. Refresh your own history before signing again. Nothing was saved or sent.";

/** Reads discard markers inside the transaction that saves a signed group. */
export function discardedPredecessorReads(
  keys: IDBObjectStore,
  previous: Iterable<string>,
) {
  return [...new Set(previous)].map((id) => keys.get(`discarded:${id}`));
}
