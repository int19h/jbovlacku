# Exact ranking prototype

This crate implements section 8 of the [format specification](../../docs/format.md) with exact fractions.
Its calculation profiles are `simple-routes-bounds-v1` and `simple-routes-shun-v1`.
`BigRational` stores a fraction with integers that can grow beyond machine integer sizes.
The library builds for native Rust and `wasm32-unknown-unknown`.

The caller supplies a resolved graph.
An actor represents one identity continuity group.
The state layer resolves continuity, scoped trust, conflicting opinions, and private weights before it supplies this graph.
It merges duplicate destinations before normalization.
It normalizes each original positive row before it removes blocked destinations.
It also zeroes blocked actors' own allowances and outgoing rows.
Missing identity or eligibility data must produce an unavailable state in the caller.

`Graph::new` rejects self edges, duplicate destinations, nonpositive shares, and rows whose shares exceed one.
It selects `Profile::BoundsV1` and supplies empty refusal lists.
`Graph::with_refusals` accepts an explicit profile and resolved refusal lists.
Each target lists the actors whose effective shuns forbid entry.
The constructor sorts these lists and rejects duplicates or invalid actors.
Under `Profile::ShunV1`, a route cannot enter a target that any earlier actor on that route shuns.
The rejected route supplies neither judgment weight nor onward mass. Its share disappears without redistribution.
The target's own allowance, prior credit, and independent permitted routes remain eligible.
`Profile::BoundsV1` ignores route refusals and preserves the old expansion rule.
`normalize_row` accepts distinct resolved destinations and positive weights.
It divides weights by the larger of their sum and one.
It then removes blocked destinations without enlarging surviving shares.
The helper does not merge contradictory weights or resolve scope.

`rank` returns an interval for every actor and reports completed expansion work.
`Ranker::advance` retains complete stages for a later total budget.
It costs every positive edge attempt before each stage, including attempts that revisit an actor or encounter a refusal.
It merges prefixes by visited actor set and endpoint.
A failed stage leaves the retained lower totals and completed work unchanged.
If `Ranker::advance` returns a resource error, `bounds()` retains valid intervals for the last complete stage.
Those intervals do not represent the reference result for the requested budget.
The caller must not label them with that budget or report them as a successful result for that request.

An unfinished calculation keeps all completed contributions in its lower result.
Its upper result adds exactly 65 relaxed terms, from `f` through `alpha^64 * P^T^64 * f`.
It then adds `alpha^65 * sum(f) / (1-alpha)` to each actor's upper endpoint.
The first relaxed frontier gives no lower credit.
The upper calculation ignores route refusals as well as repeated actors.
An unfinished `simple-routes-shun-v1` upper endpoint can include forbidden routes. It does not measure received influence.
The selected algorithm name and the result's `exact` flag identify this limitation.
No hop cutoff, random estimate, coefficient change, or tighter alternate calculation replaces this profile.

`score` returns support, opposition, and net intervals.
`difference` cancels shared verdicts before it sums weight intervals for the same graph.
`separate_difference` subtracts net score intervals from different context graphs.
`nondominated_layers` accepts eligible candidates and groups candidates without a certified superior.
An exact equality remains a tie.
Full candidate IDs determine presentation order within each layer.

`Eligibility::Unavailable` makes scoring and comparison return an error.
If you explicitly score a rejected target, `Eligibility::Ineligible` gives inert judgments.
The layer function rejects both statuses so neither becomes a fabricated zero-score competitor.
An eligible deprecated definition has zero score and follows all active definitions in the default layers.
The caller retains unavailable candidates outside these layers with their visible status.

## Resource limits

The work budget ranges from one through ten million.
It limits expansion attempts, not matrix work or memory.
The default resource limits appear below.
A limit error makes the requested result unavailable.
It never returns a completed score with an uncertified partial upper endpoint.
`Graph::with_limits`, `score_with_limits`, and `difference_with_limits` accept explicit replacement limits.

| Resource                                                  | Default limit |
| --------------------------------------------------------- | ------------: |
| Actors                                                    |        10,000 |
| Positive graph edges                                      |       100,000 |
| Effective refusal pairs                                   |       100,000 |
| Searched elements across refusal membership tests         |    10,000,000 |
| Live prefixes across current and next stages              |       250,000 |
| Entries across live visited actor sets                    |     4,000,000 |
| Bits in either integer of each checked fraction           |        16,384 |
| Edge visits across the fixed relaxed calculation          |    10,000,000 |
| Candidate pairs in a layer calculation                    |     1,000,000 |
| Actor terms across candidate pairs in a layer calculation |    10,000,000 |

The fraction limit measures each stored or calculated fraction after an operation.
An individual integer operation can temporarily use more bits before this check.
The prefix and visited-set limits bound both live stage maps together.
Refusal membership tests iterate the shorter of the visited set and the target's refusal list.
Each element searched in the other sorted list counts as one test. Empty target lists require no tests.
The test count accumulates across committed stages and resumed work.
A failed stage leaves that count unchanged along with the lower totals and frontier.
Graph reuse must also match the selected profile and effective refusal relation.
The library does not install an operating-system memory or CPU deadline.
The caller must bound input construction before it allocates an oversized graph.

## Independent tests and measurements

The test oracle enumerates each individual simple route without merging stages or calculating relaxed walks.
Twenty-four generated five-actor graphs test actor bounds, candidate score bounds, and candidate difference bounds at five budgets.
Thirty-two further five-actor graphs compare both profiles with the independent oracle at five budgets.
They also test that additional refusals on fixed positive rows never increase exact weights.
The shun cases cover intermediary refusals, independent routes, onward credit, retained allowances, rejected shares, and bounded membership work.
The adversarial tests cover cycles, shared verdicts, opposite verdicts, input permutation, merged-stage cost, blocked shares, zero coefficients, and resume.
They also cover unavailable candidates, negative active scores, exact ties, and transactional resource failures.
The state crate owns continuity, scope, and missing-history tests because this crate accepts their resolved output.

The measurement examples use synthetic trust assumptions and 32 candidate definitions.
Contributor graphs contain one root per 32 actors, three delegates per root, and three author destinations per delegate.
Other actors receive no starting allowance.
Hostile graphs connect every actor to every other actor with equal shares and give every actor `q=1`.
These uniform hostile rows exercise prefix growth and poor ordering coverage but understate fraction growth from varied private weights.
Public equal-share rows also create different denominators when their numbers of outgoing edges differ.
The fixed relaxed calculation must then combine fractions with different factors.
The uniform hostile measurements do not measure that public-view cost.
Weighted probes connect eight or sixteen actors with normalized positive prime weights that rotate by issuer.
Their row denominators differ, so exact matrix arithmetic must combine fractions with different factors.
Legacy scores and submission counts supply no judgments.

Each run includes graph construction, ranking, 32 candidate scores, 496 candidate differences, and the default layers.
Native peak memory is process RSS from `/usr/bin/time`.
WebAssembly memory is the module's allocated linear-memory size after the run, including its stack and allocator reserve.
These memory figures measure different allocations and cannot be compared as equal concepts.
WebAssembly times exclude module loading and use a fresh Node instance for each graph.
The raw artifact records one serial run per scenario on the ARM64 development VM.

| Scenario          |    Budget | Completed work | Strict pairs / 496 | Exact ties / 496 | Native ms | WebAssembly ms | Native RSS KiB | WebAssembly bytes |
| ----------------- | --------: | -------------: | -----------------: | ---------------: | --------: | -------------: | -------------: | ----------------: |
| Contributor 32    | 1,000,000 |             12 |                376 |              120 |     8.597 |         45.603 |          2,140 |         1,179,648 |
| Contributor 512   | 1,000,000 |            192 |                321 |              175 |    84.594 |         85.317 |          2,292 |         1,310,720 |
| Contributor 1,000 |         1 |              0 |                101 |                0 |   235.861 |        243.670 |          2,684 |         1,572,864 |
| Contributor 1,000 | 1,000,000 |            372 |                323 |              173 |   141.125 |        136.954 |          2,684 |         1,441,792 |
| Hostile 16        |     1,000 |            240 |                120 |               16 |    49.418 |        101.238 |          2,168 |         1,179,648 |
| Hostile 32        |         1 |              0 |                  0 |                0 |   123.675 |        253.866 |          2,392 |         1,310,720 |
| Hostile 32        | 1,000,000 |        493,024 |                215 |                0 | 1,922.799 |      2,797.385 |         46,680 |        23,986,176 |
| Hostile 64        | 1,000,000 |        258,048 |                135 |                0 | 1,401.127 |      2,187.452 |         32,380 |        16,711,680 |
| Hostile 128       |    50,000 |         16,256 |                135 |                0 | 1,909.726 |      2,888.640 |          8,948 |         4,784,128 |
| Weighted 8        |         1 |              0 |                  0 |               48 |   437.126 |        690.421 |          2,152 |         1,179,648 |
| Weighted 16       |         1 |              0 |                  0 |               16 | 4,597.898 |      8,119.080 |          2,296 |         1,245,184 |

The completed contributor calculations resolve every pair as a strict order or exact tie.
A one-unit budget on hostile 32 resolves no pair.
At one million units, hostile 32 proves only 215 of 496 strict comparisons and remains inexact.
Hostile 128 proves 135 strict comparisons and leaves 361 unresolved.
A hostile 512 graph returns an edge-resource error.
These results do not select a user-facing budget or prove acceptable performance for real community graphs.

Every native and WebAssembly run agrees on actor intervals, candidate net intervals, layer presentation, completed work, and arithmetic-bit measurements.
The examples compare a stable noncryptographic digest of these values and assert matching comparison counts.
Both runtimes also execute an independent eight-graph route oracle with candidate comparisons at three budgets.
The measurement evidence predates the shun profile. It does not measure refusal storage or membership work.
The weighted probes grow from 1,255 fraction bits at eight actors to 3,572 bits at sixteen actors.
The sixteen-actor probe needs 4.598 seconds natively and 8.119 seconds in WebAssembly despite zero completed expansion work.
A separate coprime-denominator test proves oracle containment and makes a 64-bit resource cap return an error.
Larger varied-weight graphs and real community graphs remain unmeasured.

Run these commands from the prototype worktree:

```sh
CARGO_TARGET_DIR=target/rank CARGO_BUILD_JOBS=2 cargo test -p jvc-rank --release --locked
CARGO_TARGET_DIR=target/rank CARGO_BUILD_JOBS=2 cargo build -p jvc-rank --release --locked --example feasibility
CARGO_TARGET_DIR=target/rank CARGO_BUILD_JOBS=2 cargo build -p jvc-rank --release --locked --example feasibility_wasm --target wasm32-unknown-unknown
CARGO_TARGET_DIR=target/rank python3 crates/jvc-rank/examples/measure.py .cache/rank-measurements-new.txt
```

The raw results are in `measurements/2026-10-11.txt`.
The script requires Node and `/usr/bin/time`.
It uses `CARGO_TARGET_DIR` or the repository's `target` directory.
It requires an explicit output path and refuses to replace an existing file.
It runs each scenario separately and makes sure that the native and WebAssembly digests match.
