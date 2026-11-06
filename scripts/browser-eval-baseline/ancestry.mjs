/** A lower storage bound for the current IdSet, not a prototype ancestry engine. */
export function ancestryShape(headers) {
  const byId = new Map(headers.map((h) => [h.id, h]));
  const children = new Map(),
    remaining = new Map(),
    depth = new Map(),
    queue = [];
  let edges = 0,
    foreign = 0,
    missing = 0,
    joins = 0,
    accepts = 0;
  for (const h of headers) {
    const parents = h.previous.filter((id) => {
      const p = byId.get(id);
      if (!p) {
        missing++;
        return false;
      }
      if (p.issuer !== h.issuer) {
        foreign++;
        return false;
      }
      return true;
    });
    edges += parents.length;
    joins += Number(parents.length > 1);
    accepts += Number(h.kind === "identity.accept");
    remaining.set(h.id, parents.length);
    if (!parents.length) {
      depth.set(h.id, 1);
      queue.push(h.id);
    }
    for (const p of parents) {
      const list = children.get(p) ?? [];
      list.push(h.id);
      children.set(p, list);
    }
  }
  for (let i = 0; i < queue.length; i++)
    for (const child of children.get(queue[i]) ?? []) {
      depth.set(
        child,
        Math.max(depth.get(child) ?? 1, depth.get(queue[i]) + 1),
      );
      remaining.set(child, remaining.get(child) - 1);
      if (!remaining.get(child)) queue.push(child);
    }
  const supported =
    !joins &&
    !foreign &&
    !missing &&
    !accepts &&
    queue.length === headers.length;
  const denseBytes = Math.ceil(headers.length / 64) * 8;
  const depths = [...depth.values()];
  return {
    records: headers.length,
    own_edges: edges,
    foreign_edges: foreign,
    missing_edges: missing,
    multi_parent_nodes: joins,
    identity_accept_events: accepts,
    processed: queue.length,
    max_chain_depth: depths.reduce((a, b) => Math.max(a, b), 0),
    single_parent_model_valid: supported,
    wasm32_dense_payload_per_closure: denseBytes,
    minimum_identifier_payload_bytes: supported
      ? depths.reduce((n, d) => n + Math.min(d * 4, denseBytes), 0)
      : null,
    dense_closures: supported
      ? depths.filter((d) => d * 4 > denseBytes).length
      : null,
    model:
      "IdSet vector payload lower bound for single-parent histories on wasm32; excludes capacity slack, map/Vec/Rc/node overhead and transient copies; identical link modes share storage when no identity.accept exists",
  };
}
