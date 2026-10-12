/**
 * Ties a subscription to the time a node stays in the document. One observer
 * serves every registered node, so a page with many controls pays for one
 * check per DOM change instead of one observer per control.
 */
const entries = new Map<Node, (() => void)[]>();
let observer: MutationObserver | null = null;
function check() {
  for (const [node, cleanups] of entries)
    if (!node.isConnected) {
      entries.delete(node);
      for (const cleanup of cleanups) cleanup();
    }
  if (!entries.size) {
    observer?.disconnect();
    observer = null;
  }
}
/** Runs `cleanup` once, after `node` leaves the document. */
export function onDisconnect(node: Node, cleanup: () => void) {
  const list = entries.get(node) ?? [];
  list.push(cleanup);
  entries.set(node, list);
  if (!observer) {
    observer = new MutationObserver(check);
    // The node is usually appended after this call. Observe from the next task.
    queueMicrotask(() =>
      observer?.observe(document.body, { childList: true, subtree: true }),
    );
  }
}
