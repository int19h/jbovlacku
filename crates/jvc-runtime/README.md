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
The preparation contract is `jvc-session-ranking-preparation-v3`.
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

The default policy permits 1,000,000 structural records, a 512 MiB setup envelope, and 300,000,000 preparation units.
It permits 8,192 publications per word, 4,096 targets, 128 contexts, a 64 MiB graph envelope, and 16 MiB metadata encodings.
The setup ceiling is 1 GiB. The unit ceiling is 1,000,000,000.
All limits are inclusive. These envelopes model allocation and work, rather than operating-system memory or CPU time.

Setup admission counts index inputs before it allocates indexes.
It permits one bucket per input, even when duplicate keys later share a bucket.
The target count includes publication IDs and assignment IDs.
Merged trust counts include all public and private rules, even when replacement or clears later remove some rules.
Both public and merged scope indexes contribute their bucket and rule counts.
Private heed rules each reserve a pair bucket and a weight entry.
Private rules also reserve transient conflict-map space.
This preflight count can exceed the final retained entry count.

The base byte coefficients follow native heap measurements across dictionary, unique-publication, shared-rafsi, and private-scope shapes.
The model doubles the base for a safety margin.
The copied-key allowance counts the string copies used by the indexes and their temporary maps.
It excludes body text and unrelated serialized record fields.
Publications reserve their word, ID, assignment, language, and context-kind copies.
Each trust or private rule reserves eight copies of its actor, subject, scope, and value strings.
Private actor sizes use resolved continuity IDs.

| Input count | Base bytes per entry |
| --- | ---: |
| Word buckets | 256 |
| Publication IDs in word buckets | 64 |
| Target buckets | 256 |
| IDs in target buckets | 96 |
| Judgment-count buckets | 192 |
| Merged trust rules | 1,024 |
| Scope buckets, both indexes | 256 |
| Rule IDs in scope buckets | 16 |
| Private pair buckets | 192 |
| Private weights | 512 |
| Private conflict rules, including temporary space | 1,536 |

Let `I` be the sum of these counts and `K` be the copied-key byte allowance.
The unit coefficient reserves eight operations per entry per tree level.
The safety margin also doubles the key and operation terms.
Units describe count-based work, rather than measured CPU seconds.

```text
setup_bytes = 2 * (sum(count * base_bytes) + K)
setup_units = 2 * (8 * I * bit_length(I + 1) + K)
```

The measured dictionary has 269,350 structural records and 165,438,058 source bytes.
Its indexes retain 64,033,159 requested heap bytes.
The preflight envelope reserves 222,635,832 bytes and 204,442,264 units.
The default budget also accommodates the 64 MiB graph envelope and 16 MiB metadata envelope.
It leaves more than 95 million units for word preparation.
The measurements do not guarantee capacity for every word or every future dictionary revision.

The streaming source hash has independent limits, `source_bytes` and `source_millis`.
Their defaults are 256 MiB and 30,000 elapsed milliseconds. Their ceilings are 1 GiB and 120,000 milliseconds.
The measured native source walk takes about 0.75 CPU seconds and retains no source buffer.
The writer measures bytes and consults a monotonic clock at most 256 KiB apart and after serialization.
Native builds use `Instant`. Wasm builds use the host's `performance.now()`.
The time limit stops cooperatively at writer boundaries. It does not preempt serialization between writes.
A refused walk returns no partial binding and does not construct an index.
The source length remains part of usage reporting, but it does not charge setup memory or preparation units.

The state counts retained nodes, evaluation maps, nested judgments, and overlay entries as structural records.
A preparation attempt starts with its setup units already charged.
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

## Measure setup allocation

The native measurement example uses a counting global allocator and process CPU counters.
It reports requested live heap growth and peak heap growth around index construction.
It excludes checkpoint restoration from those index measurements.
It also reports counts by index kind, conservative input counts, and source-hash time and temporary allocation.
The full process peak includes restoration and synthetic input construction.
Allocator metadata and size-class rounding remain outside the requested-byte counter.
The doubled admission envelope supplies additional margin for them.

Use only independently authenticated host projections for these arguments.
The example does not authenticate a checkpoint or its projected nodes.
It never writes to its input files.

```sh
cargo run -p jvc-runtime --example ranking_setup_measurement --release --locked -- trusted-core.json trusted-nodes.ndjson
```

The example restores one dictionary and builds three synthetic shapes from its publication metadata.
The synthetic shapes use unique words, shared rafsi assignments, and unique private scopes.
Each run requires its actual index counts to fit the preflight counts.
Each run also requires the default model to cover its measured peak heap and admit its setup.
