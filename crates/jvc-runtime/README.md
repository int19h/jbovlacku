# Session ranking preparation

Float preparation attaches to the existing `EvaluationSession`.
It borrows the retained authenticated records and their evaluation.
It does not accept another input container or repeat envelope authentication.
The state builds its target and private-weight indexes once, after setup admission.
Every fork and restore starts without those indexes or prepared graphs.

`ranking_descriptor` accepts an unsigned policy with a `core_binding` and optional limits.
The caller must authenticate that core build identity before it supplies the policy.
The descriptor binds the retained record projections, evaluation, selected view, overlay, and evaluation limits.
It also binds the format, row contract, projection versions, checkpoint version, core identity, preparation policy, and signed parameters.
Float parameters carry their reduced rational values and binary64 bits.
Fresh, forked, and restored equivalent states share semantic bindings.
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
A successful policy change releases the previous preparation.
`clear_ranking_preparation` releases the current graphs and keeps the setup indexes.
The TypeScript handle exposes these operations as `rankingDescriptor`, `prepareRanking`, `rankingPreparation`, and `clearRankingPreparation`.
The browser facade exposes them without host insertion or checkpoint restore.

The default policy permits 1,000,000 structural records, a 512 MiB setup envelope, and 100,000,000 preparation units.
It permits 8,192 publications per word, 4,096 targets, 128 contexts, a 64 MiB graph envelope, and 16 MiB metadata encodings.
All limits are inclusive and bounded by implementation ceilings.
These defaults are admission bounds, not measured dictionary capacity.

Setup serialization stops at the metadata byte limit.
The setup envelope charges 16 times those source bytes plus 256 bytes per structural record.
Setup units use `4 * source_bytes + 64 * (records + 1) * bit_length(records + 1)`.
The state counts retained nodes, evaluation maps, nested judgments, and overlay entries as structural records.
A preparation attempt starts with those setup units already charged.
It charges one unit plus eight units per visited word publication.
Each context charges one unit, 16 times the source bytes, 64 times the record count, and eight times the pair-square count.
The pair-square count bounds pairwise scope comparisons across public and merged private rules and weight entries.
These conservative envelopes bound structural preparation work separately from numerical operations.
They do not establish a deadline or a measured instruction count.
Before context resolution, the graph envelope charges 1,024 bytes per actor bound, 128 per edge, 64 per refusal, and 512 per judgment.
The actor bound includes judgment actors, roots, and both endpoints of applicable trust rules.
Kernel graph count limits also apply before resolution.
Metadata encodings have their own byte limit.

Preparation returns target statuses and context metadata with execution and context bindings.
It does not return word scores, ranking layers, or numerical results.
There is no result cache, job protocol, worker integration, or app capability.
`rankWord` remains the synchronous exact operation and explicitly rejects `simple-routes-shun-f64-v1`.
