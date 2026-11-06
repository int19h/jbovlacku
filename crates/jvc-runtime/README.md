# Session ranking preparation

Float preparation attaches to the existing `EvaluationSession`.
It borrows the retained authenticated records and their evaluation.
It does not accept another input container or repeat envelope authentication.
The state builds its target, scope, judgment-count, and private-weight indexes once, after setup admission.
Every fork and restore starts without those indexes or prepared graphs.

`ranking_descriptor` accepts an unsigned policy with a `core_binding` and optional limits.
The caller must authenticate that core build identity before it supplies the policy.
The descriptor binds the retained record projections, evaluation, selected view, overlay, and evaluation limits.
It also binds the format, row contract, projection versions, checkpoint version, core identity, preparation policy, and signed parameters.
Float parameters carry their reduced rational values and binary64 bits.
Fresh, forked, and restored equivalent float states share semantic bindings.
Exact profiles return unavailable descriptors before the source walk or index construction.
Their diagnostic input binding names the selected view and algorithm, without identifying the complete input.
Unavailable descriptors cannot prepare graphs.
The preparation contract is `jvc-session-ranking-preparation-v2`.
Source serialization keeps the existing serde field order and sorted `serde_json::Value` object keys.
A regression test pins that sorted-key assumption against future dependency feature changes.
Each session also supplies a separate owner identity that prevents cross-session requests.

`prepare_ranking` requires the owner identity, descriptor binding, and word identifier.
It discovers effective definition receipts and folded rafsi assignments.
Only eligible targets request context graphs.
The indexed resolver shares the exact path's semantic rules and uses rational-first float row preparation.
It keeps private replacements, private weights, public personal shuns, and private blocks distinct.
An unavailable context never becomes a successful zero graph.

The session retains one preparation at a time.
A valid replacement releases the old graphs before it constructs new graphs.
An invalid identity, binding, or word leaves the current preparation unchanged.
A failed admitted replacement leaves no prepared graphs and keeps its charged usage.
A different valid policy releases the previous controller before setup admission.
If setup refuses that policy, no descriptor or graphs remain active.
An old request then fails until the caller admits a policy again.
A malformed policy leaves the current controller intact.
Preparation generations stay monotonic through both successful and refused policy changes.
`clear_ranking_preparation` releases the current graphs and keeps the setup indexes.
The TypeScript handle exposes these operations as `rankingDescriptor`, `prepareRanking`, `rankingPreparation`, and `clearRankingPreparation`.
The browser facade exposes them without host insertion or checkpoint restore.

The default policy permits 1,000,000 structural records, a 512 MiB setup envelope, and 100,000,000 preparation units.
It permits 8,192 publications per word, 4,096 targets, 128 contexts, a 64 MiB graph envelope, and 16 MiB metadata encodings.
All limits are inclusive and bounded by implementation ceilings.
These defaults are admission bounds, not measured dictionary capacity.

The source hash writer counts bytes and retains no source buffer.
Its source limit is `(setup_bytes - 256 * records) / 16`, with checked subtraction before the walk.
The one-time setup envelope charges `16 * source_bytes + 256 * records`.
Setup units use `4 * source_bytes + 64 * (records + 1) * bit_length(records + 1)`.
The state counts retained nodes, evaluation maps, nested judgments, and overlay entries as structural records.
A preparation attempt starts with those setup units already charged.
Discovery charges `1 + 8 * visited_publications`.

Each context charges `1 + 4*T + 4*J + 24*(U+V) + 8*(Q+E+Z) + 32*O + 8*P2`.
The context charge does not include source bytes or the whole-state record count.
Each trust index needs at most eight scope bucket lookups.
Target and judgment counts need two context-key lookups.
A scope bucket groups rules with identical kind, word, and language fields.
The indexed resolver visits only matching trust buckets.

| Term | Count |
| --- | --- |
| `T` | Matching target identifiers, including publication and assignment identifiers |
| `J` | Their judgment entries |
| `U` | Matching merged public and private trust rules |
| `V` | Matching original public rules, when a personal shun issuer is present |
| `Q` | Signed policy roots |
| `E` | Signed policy exclusions |
| `Z` | Suspended actors |
| `O` | Overlay root changes, block entries, and the personal shun issuer entry |
| `P2` | The context's upper bound for pairwise rule and private-weight comparisons |

For each scope bucket, setup groups rules by actor pair and sums their squared counts.
Merged buckets also include every private weight entry for each pair, because the resolver scans those entries across scopes.
A context multiplies each matching bucket sum by the number of matching buckets.
Cauchy's inequality bounds the square of each combined pair count by that product.
The context adds the merged and original-public bounds when it needs both.
Unrelated scopes contribute nothing to these counts.

These conservative envelopes bound structural preparation work separately from numerical operations.
They do not establish a deadline or a measured instruction count.
Before context resolution, the graph envelope charges 1,024 bytes per actor bound, 128 per edge, 64 per refusal, and 512 per judgment.
The actor bound includes judgment actors, signed and overlay roots, and both endpoints of matching merged trust rules.
These modeled bounds reserve bytes only. Kernel count limits apply to the actual resolved graph in `Graph::new`.
A byte envelope can still refuse a graph whose actual counts fit the kernel limits.
Metadata encodings have their own byte limit, which does not limit source hashing.

Preparation returns target statuses and context metadata with execution and context bindings.
It does not return word scores, ranking layers, or numerical results.
There is no result cache, job protocol, worker integration, or app capability.
`rankWord` remains the synchronous exact operation and explicitly rejects `simple-routes-shun-f64-v1`.
