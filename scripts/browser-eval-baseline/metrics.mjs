export function distribution(values) {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  const q = (p) =>
    sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null;
  return {
    n: sorted.length,
    min: sorted[0] ?? null,
    p50: q(0.5),
    p90: q(0.9),
    p95: q(0.95),
    p99: q(0.99),
    max: sorted.at(-1) ?? null,
    mean: sorted.length
      ? sorted.reduce((a, b) => a + b, 0) / sorted.length
      : null,
  };
}
export function workerTimings(records) {
  const values = records.map((r) => r.value?.measurement?.worker_ms);
  return {
    ...distribution(values),
    missing_worker_timings: values.filter((value) => !Number.isFinite(value))
      .length,
  };
}

export function profileSummary(profile) {
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const parents = new Map();
  for (const n of profile.nodes)
    for (const c of n.children ?? []) parents.set(c, n.id);
  const totals = {
    ancestry_us: 0,
    other_evaluation_us: 0,
    ranking_us: 0,
    signature_us: 0,
    idle_us: 0,
    gc_us: 0,
    other_us: 0,
  };
  for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
    let n = nodes.get(profile.samples[i]);
    const stack = [];
    while (n) {
      stack.push(n.callFrame.functionName);
      n = nodes.get(parents.get(n.id));
    }
    const text = stack.join("\n");
    const us = profile.timeDeltas?.[i] ?? 0;
    const key = /\(idle\)/.test(text)
      ? "idle_us"
      : /\(garbage collector\)/.test(text)
        ? "gc_us"
        : /jvc_state.*graph.*(?:build_cache|Closure.*(?:union|make_dense|insert)|build_closure)/.test(
              text,
            )
          ? "ancestry_us"
          : /jvc_rank|rank_word|rankWord/.test(text)
            ? "ranking_us"
            : /ed25519|sshsig|verify_envelope/.test(text)
              ? "signature_us"
              : /jvc_state|evaluat/.test(text)
                ? "other_evaluation_us"
                : "other_us";
    totals[key] += us;
  }
  return {
    ...totals,
    samples: profile.samples?.length ?? 0,
    top_functions: profile.nodes
      .filter((n) => n.hitCount)
      .toSorted((a, b) => b.hitCount - a.hitCount)
      .slice(0, 30)
      .map((n) => ({ name: n.callFrame.functionName, hits: n.hitCount })),
  };
}
