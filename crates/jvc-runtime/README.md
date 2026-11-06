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
Word results and their serialized cache are separate operations described below.
There is no job protocol, worker integration, or app capability.
`rankWord` remains the synchronous exact operation and explicitly rejects `simple-routes-shun-f64-v1`.

## Owned word results

`start_word_results` consumes the session's current prepared graphs.
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
Its complete identity requires snapshot, logical inventory, input, view, overlay, mode, build, contract, policy, algorithm, and logical session.
The host supplies authenticated identities from its retained snapshot.
Exact-profile diagnostic descriptor bindings alone do not identify that snapshot.
The word and reviewer requirement also belong to each entry's key.
Use `wordResultPolicyBinding` for the result policy component.
`describeWordResults` keeps available evaluation evidence when descriptor admission fails.

Call `bind` after any identity component changes.
Body mapping and import selection changes must change the supplied snapshot or inventory identity.
Personal overlay identities must include identity changes and the effective `public_shun_issuer`.
Site mode requires a null overlay.
A changed binding clears fixed failures, reservations, and unpinned old results.
Promised pinned delivery survives invalidation.
A repaired worker uses the same logical identity and preserves deadline failures.
A fork uses a new logical session identity.

Admission reserves output bytes, one consumer slot, and failure-marker capacity before numerical work starts.
The cache permits 32 MiB of result bytes and reservations, with 4 MiB per result.
It retains at most 16 unpinned entries for reuse.
Live tickets can pin more entries under the 64-consumer ceiling.
Pinned bytes count once per distinct result.
Admission evicts only unpinned entries or returns `ranking_busy` with `retry_after: 1`.

`complete` transfers ownership of a full `Uint8Array` buffer and detaches the caller's buffer.
Each result expires 60 seconds after completion.
All attached tickets share that fixed expiry.
Reads return a delivery copy and never extend the expiry.
Tickets retain their pins after reads until expiry or cancellation.
The cache retains no evaluation-session reference.

Fixed failures retain at most 128 markers and 1 MiB of metadata.
Admission reserves 8,192 metadata bytes per pending marker.
A full marker table refuses new uncached work while cached reads remain available.
`deadline` records `resource_unavailable`, `limit: deadline`, and `retryable: false`.
It also keeps the parent's `background_evaluation_running_at_expiry` observation.
No deadline observer or worker repair loop exists in this step.
The future parent controller supplies that observation and calls `deadline`.
Cancellation releases reservations without creating a fixed failure.
Disposal releases all retained bytes and metadata.
A process restart loses this in-memory cache and its markers.

## Setup measurement

The `jvc-state` example `ranking_setup_size` measures a trusted checkpoint and projected node stream.
Run it with a core-result JSON file and a node-per-line JSON file.
It reports source bytes, structural records, setup bytes, and setup units against existing ceilings.
It restores the checkpoint and streams its source without retaining a source serialization buffer.
Measurement does not change runtime policy limits.
