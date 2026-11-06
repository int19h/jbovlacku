# Session ranking preparation

Float preparation attaches to the existing `EvaluationSession`.
It borrows the retained authenticated records and their evaluation.
It does not accept another input container or repeat envelope authentication.
The state builds its target, scope, judgment-count, and private-weight indexes once, after setup admission.
Unavailable descriptors skip the index bound and setup estimate, reporting zero setup bytes and units.
Their source walk still has its independent byte and time limits. Malformed restored overlays return an error instead of a panic.
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
The preparation contract is `jvc-session-ranking-preparation-v4`.
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

The default policy permits 1,000,000 structural records and a 512 MiB setup envelope.
It has separate unit allowances: 400,000,000 `setup_units` and 100,000,000 context `units`.
It permits 8,192 publications per word, 4,096 targets, 128 contexts, a 64 MiB graph envelope, and 16 MiB metadata encodings.
The setup ceiling is 1 GiB. Each unit allowance has a 1,000,000,000 ceiling.
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
The model also reserves fixed B-tree root costs, then doubles the whole base for a safety margin.
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

Small B-trees allocate a node with spare slots, even for one entry.
Each nonempty index map reserves 1,536 base bytes for its root and first split node.
Each target or private-conflict set reserves 384 base bytes.
The aarch64 allocation probes observe map nodes up to 1,520 bytes and set nodes up to 376 bytes.
Cloned scope objects and trust-value sets remain covered by their existing per-rule coefficients.

Let `nz(x)` be one for a positive count and zero otherwise.
The map count includes word, target, judgment, private-pair, and temporary conflict maps.
When scope rules exist, it also reserves both scope maps and one scratch pair map.
Only one scratch pair map is live at a time.
The set count permits one target set per target bucket and one conflict set per private input rule.
Preflight can overcount shared buckets and conflict groups.
Empty indexes reserve no root allocation.

Let `I` be the sum of entry counts and `K` be the copied-key byte allowance.
The unit coefficient reserves eight operations per entry per tree level.
The safety margin also doubles the key and operation terms.
Units describe count-based work, rather than measured CPU seconds.

```text
M = nz(words) + nz(target_groups) + nz(judgment_groups)
    + nz(private_pairs) + nz(private_rules) + 3 * nz(scope_buckets)
S = target_groups + private_rules
B = 1536 * M + 384 * S
setup_bytes = 2 * (sum(count * base_bytes) + K + B)
setup_units = 2 * (8 * I * bit_length(I + 1) + K)
```

The measured dictionary has 269,350 structural records and 165,438,058 source bytes.
Its indexes retain 64,033,159 requested heap bytes.
The preflight envelope reserves 291,524,664 bytes and 204,442,264 units.
The default budget also accommodates the 64 MiB graph envelope and 16 MiB metadata envelope.
The dictionary leaves 195,557,736 setup units unused. Word preparation retains its full 100,000,000-unit allowance.
A uniform 50% increase in dictionary counts and copied-key bytes still fits the default setup units and memory.
That growth also fits the source-byte and record limits, with the graph and metadata envelopes reserved.
Growth near 55% reaches the combined setup-memory envelope before the separate setup-unit allowance.
These count-based growth figures assume the same shape and do not promise that every future word fits.
The measurements do not guarantee capacity for every word or every future dictionary revision.

The streaming source hash has independent limits, `source_bytes` and `source_millis`.
Their defaults are 256 MiB and 30,000 elapsed milliseconds. Their ceilings are 1 GiB and 120,000 milliseconds.
The measured native source walk takes about one CPU second and retains no source buffer.
The writer measures bytes and consults a monotonic clock at most 256 KiB apart and after serialization.
Native builds use `Instant`. Wasm builds require the host's `performance.now()`.
Browsers, browser workers, and Node provide that clock. Bare hosts must supply it.
The time limit stops cooperatively at writer boundaries. It does not preempt serialization between writes.
This deadline covers hashing only. Count walks and index construction have record and unit limits, without an elapsed-time deadline.
A refused walk returns no partial binding and does not construct an index.
The source length remains part of usage reporting, but it does not charge setup memory or preparation units.

The state counts retained nodes, evaluation maps, nested judgments, and overlay entries as structural records.
`setup_units` usage records index work separately. `charged_units` starts at zero and counts only discovery and context work.
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
Word results and their serialized cache are separate operations described below.
There is no job protocol, worker integration, or app capability.
`rankWord` remains the synchronous exact operation and explicitly rejects `simple-routes-shun-f64-v1`.

## Measure setup allocation

The native measurement example uses a counting global allocator and process CPU counters.
It reports requested live heap growth and peak heap growth around index construction.
It excludes checkpoint restoration and other threads from those index measurements.
The example and allocation regression share one thread-local measurement window.
Reallocation conservatively counts old and new buffers together, even when the allocator can grow in place.
Every window requires the unmargined base to cover its peak, leaving the full outer 2x margin unused.
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

The example first measures 420 small shapes, then restores one dictionary and builds three large synthetic shapes.
The large shapes use unique words, shared rafsi assignments, and unique private scopes.
The small shapes cover single entries, shared keys, public scopes, private weights, clears, conflicts, and mixed inputs.
Their sizes include 11/12/13 entries and further B-tree split boundaries through 257 entries.
Each run requires its actual index counts to fit the preflight counts.
Each run requires the default model to admit setup and reserve at least twice its measured peak heap.
The small suite also runs without a dictionary:

```sh
cargo run -p jvc-runtime --example ranking_setup_measurement --release --locked -- --small
cargo test -p jvc-runtime --test setup_allocations --locked
```

## Owned word results

`start_word_results` consumes the session's current prepared graphs after preflight admission.
A valid but refused start leaves those graphs and their preparation identity unchanged.
The caller can retry that same preparation with a corrected result policy.
The request names the owner, descriptor binding, preparation identity, and unsigned `WordResultPolicy`.
`word_result_policy_binding` hashes the normalized policy and numerical contracts before cache admission.
The TypeScript function is `wordResultPolicyBinding`.
A second active attempt returns `ranking_busy`.
A valid preparation or policy replacement cancels the old numerical attempt.
Invalid bindings and malformed policies leave it intact.

`step_word_results` accepts 1 through 65,536 numerical operations per slice.
Invalid steps fail before mutation.
The attempt uses owned kernel tasks and the float decisions module.
Only a complete upper calculation permits scores or comparisons.
A completed upper calculation with incomplete route exploration still gives usable intervals.
Definition layers report `layers_complete: false` when a definition lacks its required estimate.
A missing rafsi estimate does not make definition layers incomplete.
Known inactive pairs appear separately and do not make a complete word partial.
Rafsi decisions cover the requested word's pairs only.
They do not select between different spellings or claim uniqueness across other words.
Unresolved pairs retain their potential decisions without becoming eligible.

Results include support, opposition, net intervals, comparison margins, definition layers, and unavailable reasons.
Each score includes actual-positive, eligible-potential, and threshold decisions with their margins.
Optional reviewer details include bounded incoming identities and explicit completeness fields.
The result labels float intervals as numerically approximate and uncertified.
Aggregate results omit reviewer lists.
`reviewers: 0` requests empty lists and differs from an aggregate request.

The default policy permits 10,000,000 numerical operations, 64 MiB of modeled memory, and 4 MiB of serialized output.
It permits 128 targets, 8,192 candidate comparisons, 1,000,000 actor terms, and 4,096 reviewer entries.
The reviewer limit defaults to absent and has a ceiling of 128 per target.
Policy ceilings permit 100,000,000 operations, 256 MiB of memory, and 4,096 targets.
They permit 1,000,000 comparisons, 10,000,000 actor terms, and 16,384 reviewer entries.
The output ceiling stays at 4 MiB.
All bounds are inclusive.
Conservative preflight envelopes can refuse work before those actual counts reach their limits.
The actor-term envelope also bounds score proofs and structural known-zero searches.

Graph reservations charge 1,024 bytes per actor, 128 per edge, and 64 per refusal.
The decision envelope charges 32 bytes per target-actor entry and 320 per reserved proof entry.
The envelope also reserves twice its modeled serialized output for assembly and encoding.
Kernel reservations separately charge owned tasks, pending stages, and retained graph outcomes.
These coefficients bound admission models, not operating-system memory.

Identical execution bindings share one graph outcome within an attempt.
The reuse key includes the result policy binding.
Progress reports actual numerical operations and `in_call_reuse` separately.
Pending work appears in graph progress and contributes to the performed counters.
`take_word_result` consumes the ready bytes exactly once.
Cancellation, failures, session disposal, and successful serialization release graphs, pending stages, and numerical outcomes.
Serialized ready bytes hold no graph lease.

The TypeScript handle exposes `startWordResults`, `stepWordResults`, `wordResultProgress`, `takeWordResult`, and `cancelWordResults`.
The caller drives slices explicitly.
These methods create no scheduler, worker, job protocol, route, or app capability.
`rankWord` keeps its exact-profile behavior.

## Serialized word cache

`WordResultCache` belongs to the logical session owner, outside a disposable evaluation worker.
It retains only serialized results and fixed failures.
Its complete identity requires snapshot, logical inventory, input, view, overlay, mode, build, contract, algorithm, and logical session.
The host supplies authenticated identities from its retained snapshot.
Exact-profile diagnostic descriptor bindings alone do not identify that snapshot.
The complete normalized result policy belongs to each word key, including its reviewer requirement and output limit.
`reserve(word, policy, now)` derives that digest and reservation from one serialized policy value.
Aggregate and reviewer requests share one budget without clearing each other's results or failure markers.
Initialize the shared core before using policy normalization or cache admission.
`wordResultPolicyBinding` exposes the same normalized digest.
`describeWordResults` keeps available evaluation evidence when descriptor admission fails.

Supply monotonic milliseconds to cache operations that accept a clock value.
Call `bind` after any identity component changes.
Body mapping and import selection changes must change the supplied snapshot or inventory identity.
Personal overlay identities must include identity changes and the effective `public_shun_issuer`.
Site mode requires a null overlay.
A changed binding clears fixed failures, reservations, and unpinned old results.
Promised pinned delivery survives invalidation.
A repaired worker uses the same logical identity and preserves deadline failures.
A fork uses a new logical session identity.

Admission reserves the policy output limit, one consumer slot, and failure-marker capacity before numerical work starts.
The cache permits 32 MiB of result bytes and reservations, with 4 MiB per result.
It retains at most 16 unpinned entries for reuse.
Live tickets can pin more entries under the 64-consumer ceiling.
Pinned bytes count once per distinct result.
Admission decides whether all required capacity exists before it evicts any reusable entry.
It evicts only unpinned entries.
Transient reservation and consumer pressure returns `ranking_busy` with `retry_after: 1`.
Pinned-byte pressure reports seconds until the earliest fixed pinned expiry.

`complete` returns a ready ticket after it transfers a full `Uint8Array` buffer and detaches the caller's buffer.
An output larger than the reserved policy limit returns a frozen retryable `output_bytes` failure and releases the reservation.
That transfer refusal creates no permanent failure marker.
Each result expires 60 seconds after completion.
All attached tickets share that fixed expiry.
Reads return a delivery copy and never extend the expiry.
Tickets retain their pins after reads until expiry or cancellation.
The cache retains no evaluation-session reference.

Fixed failures retain at most 128 markers and 1 MiB of metadata.
Admission reserves 8,192 metadata bytes per pending marker.
Permanent marker saturation returns `markers_full` without a retry hint.
In-flight marker reservations cause transient `ranking_busy` refusals.
Cached successes and failures remain readable in both cases.
`deadline` records `resource_unavailable`, `limit: deadline`, and `retryable: false`.
It also keeps the parent's `background_evaluation_running_at_expiry` observation.
Every deadline marker requires that boolean.
Other failure markers reject that field.
No deadline observer or worker repair loop exists in this step.
The future parent controller supplies that observation and calls `deadline`.
Cancellation releases reservations without creating a fixed failure.
Disposal releases all retained bytes and metadata.
A process restart loses this in-memory cache and its markers.

## Setup measurement

Use the `jvc-runtime` example `ranking_setup_measurement` for the current index-based setup model.
It reports measured heap, index counts, modeled setup bytes and units, source bytes, and hash-walk timing.
Source hashing has independent byte and time limits, as described above.
The [allocation measurement guide](#measure-setup-allocation) gives the command and trusted-input requirements.
Measurement does not change runtime policy limits.

## Partial decisions and remaining limits

The result contract is `jvc-f64-word-results-v2`.
Serialized result progress omits the physical session token.
Step and progress replies retain that token for native attempt control.
Fresh, forked, and restored results compare without removing any provenance field.

A context or target decision failure keeps healthy contexts and scores available.
Its target retains the cause in `unavailable_scores`.
A failed comparison appears in `unavailable_comparisons`, and its candidates leave the complete ordering subset.
An ordering failure sets `unavailable_ordering` and leaves scores and successful comparisons intact.
These ordering gaps make `layers_complete` false and the result partial.
A rafsi-only decision error does not make definition layers incomplete.
Whole-word encoding failures still release all work and fail the attempt.

Reviewer construction scans each computed graph once and retains at most 16 incoming indices per actor, plus the complete incoming count.
Admission charges those edge visits once, rather than once per listed reviewer.
The existing graph byte envelope covers this bounded index.
The float reviewer contract remains separate from the exact contract.
Its `root` field contains a float q value, including zero for a non-root.
It omits `multiple_routes` and always emits boolean `public_shun_block` and `private_block` fields in every mode.
The exact contract instead uses a nullable rational root and conditional block-reason fields.

The final numerical slice performs the entire bounded finish phase synchronously.
That phase constructs decisions, layers, comparisons, reviewer details, and serialized output.
A one-operation numerical slice can therefore include the full finish phase.
Step 4 must address or measure this responsiveness limit before it claims slice latency bounds.
This step adds no finish scheduler or new yield control.

The cache enforces 64 consumers within each logical session.
A duplicate in-flight probe returns `pending` without adding a consumer.
Step 5 must enforce the global consumer cap and count shared pending attachments.
The present cache does not implement that global scheduling rule.
