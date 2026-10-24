# Jbovlacku state evaluator

This crate rebuilds editorial state from authenticated events. It does not select a public view automatically.
`EvaluationInput` names the exact selected view. It contains admitted `VerifiedEnvelope` values, body bytes keyed by event ID, and import selections.
Import selection keys are SHA-256 identifiers. The evaluator checks each canonical sorted selection before use.
An optional unsigned overlay changes the selected policy locally. Invalid overlays produce unavailable results.

The evaluator retains semantic errors in the causal graph. It gives invalid actions no editorial effect.
Missing predecessors suspend the affected continuity group. Missing publication bodies remain separate from author status.
Definitions retain lineage labels when a parent is missing or does not match their word and language.

Native authority follows accepted key succession. Imported authority starts independently at the selected account claim.
Carried history follows immutable signed predecessor and acceptance links. Later former-key gaps and cutoffs do not change independently adopted history.
Historical witness certificates establish closure and availability guards. Missing observation bodies or predecessors keep potential certificates pending.
Pending certificates prevent an older controller or an active default from replacing missing evidence. Current certificates need complete retained witness history.
A malformed observation body cannot certify a never-certified period or create its historical guard.
For an already certified period, a missing or malformed newer observation body retains its current frontier position and prevents controller fallback.
The account authority flag disables imported status powers. A certified account link can still authorize bridge management when that flag is false.
Missing parent views disable account guard decisions. Native rankings remain available when the selected view body is available.

`evaluate_context` constructs the positive graph for one word and language. It resolves scopes and continuity before row normalization.
Exclusions and local blocks remove shares after normalization. They do not increase surviving shares.
`publication_status` and `account_control` expose the frontend status and certificate fields directly.

The ancestry cache uses indexed bitsets and topological unions. Its global work budget counts bitset allocation, union words, dependency indexing, and missing-ID propagation.
Construction stops as soon as the budget runs out. The evaluator does not publish confident partial state from that construction.
The default budget is 1,000,000 words. Each of the three caches allocates a full indexed bitset for each event.
Even unrelated events therefore cost about `3 * N * ceil(N / 64)` words. The default budget supports roughly 4,500 unrelated events.
Dependencies and carry unions reduce that ceiling. This is a prototype limit, not a production scale target.
Exceeding the budget makes the entire evaluation unavailable, including other accounts and native publications, with reason `resource_unavailable`.
A party that supplies a few thousand admitted events can therefore exhaust the default budget. The 200,000-event admission limit does not promise evaluation support at that size.
A signed chain of 2,429 imported definitions with four certified account periods passes the default budget.
Witness groups are cached per policy. Claim chains and carry boundaries are cached per account candidate.
A 5,000-event chain with a smaller budget returns unavailable without recursive traversal.

The evaluator performs no peer retrieval. A service must retrieve the named missing inputs within its synchronization deadline before publishing conditional results.
It cannot detect an omitted branch when no supplied event or reference exposes that branch.

The handover test suite executes H01 through H48 with signed records. Each case uses four delivery orders, duplicate delivery, and serialized reconstruction.
The suite also covers account evidence, native cutoffs, scope conflicts, private overlays, import selection conflicts, rafsi gates, and resource limits.
These tests sample delivery orders. They do not enumerate every permutation of a large event set.
