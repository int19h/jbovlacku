/**
 * Ties a subscription to the time a node stays in the document. One observer
 * serves every registered node, so a page with many controls pays for one
 * check per DOM change instead of one observer per control.
 *
 * A node that has not joined the document yet is not a removed node. Its
 * cleanup waits until the node was in the document and left it. The observer
 * reads the added and removed subtrees of each change, so a node that joins
 * and leaves between two checks is released too. A page that builds a
 * control and then waits for data before it appends the control passes its
 * render signal, so navigation away releases the subscription even when the
 * control never joins the document. The observer starts at the first
 * registration, before the caller can append its node.
 */
interface Entry {
  cleanups: (() => void)[];
  /** Whether the node was in the document at any check or in an added subtree. */
  seen: boolean;
}
const entries = new Map<Node, Entry>();
let observer: MutationObserver | null = null;
function release(node: Node) {
  const entry = entries.get(node);
  if (!entry) return;
  entries.delete(node);
  for (const cleanup of entry.cleanups) cleanup();
}
function check(records: MutationRecord[]) {
  const added: Node[] = [];
  const removed: Node[] = [];
  for (const record of records) {
    added.push(...record.addedNodes);
    removed.push(...record.removedNodes);
  }
  for (const [node, entry] of entries) {
    if (node.isConnected || added.some((root) => root.contains(node)))
      entry.seen = true;
    if (
      !node.isConnected &&
      (entry.seen || removed.some((root) => root.contains(node)))
    )
      release(node);
  }
  if (!entries.size) {
    observer?.disconnect();
    observer = null;
  }
}
/** Runs `cleanup` once, after `node` leaves the document, or when `signal` aborts first. */
export function onDisconnect(
  node: Node,
  cleanup: () => void,
  signal?: AbortSignal,
) {
  if (signal?.aborted) {
    cleanup();
    return;
  }
  const entry = entries.get(node) ?? { cleanups: [], seen: node.isConnected };
  entry.cleanups.push(cleanup);
  entries.set(node, entry);
  signal?.addEventListener("abort", () => release(node), { once: true });
  if (!observer) {
    // Observation starts now, before the caller can append the node, so a
    // node that joins and leaves before the next task is still seen.
    observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
  }
}
