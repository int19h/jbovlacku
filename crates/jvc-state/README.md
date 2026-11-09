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
The resolver scans publications once and looks up judgments only for matching targets.
It indexes private register replacements and heed weights by resolved actor pairs.
Publication membership stays separate from eligibility and status.
Exclusions and local blocks remove shares after normalization. They do not increase surviving shares.
`publication_status` and `account_control` expose the frontend status and certificate fields directly.

The ancestry cache uses exact intervals over a topological layout. Records of one issuer occupy a contiguous block of layout positions. Same-issuer parents come before their children, records in or below a cycle keep lexical order at the end of the block, and each closure is a sorted list of disjoint position ranges.
Its global work budget counts logical work: one unit per record, per dependency edge, per missing ID propagated, and per range a union copies. One layout pass charges per record and per dependency edge once. A dependency setup pass and a closure construction pass charge those units for each of the three link modes, plus lifecycle and closure charges on the same terms.
The count charges the exact interval layout: records, edges, and the ranges in it. It counts no bitset words or pointer sizes, so the same input charges the same total in native and Wasm builds.
Construction stops as soon as the budget runs out. The evaluator does not publish confident partial state from that construction.
Range metadata has a hard cap of 64 MiB, counted cumulatively over every range vector a union copies or allocates, including discarded temporaries. A history past the cap returns `resource_unavailable` at any budget.
The default budget is 10,000,000 units. A flat history costs eight units per record, and a single-parent chain costs eighteen units per record except for ten units saved across the roots, before evaluation-time closure charges.
Exceeding the budget makes the entire evaluation unavailable, including other accounts and native publications, with reason `resource_unavailable`.
Evaluation work is not yet bounded by this budget on every path. Some register, retention, account, certificate, and downstream paths can do work that grows faster than the charged units on large histories. A follow-up change adds a work meter for those inner loops.
A signed chain of 2,429 imported definitions with four certified account periods passes the default budget.
Witness groups are cached per policy. Claim chains and carry boundaries are cached per account candidate.
A 5,000-event chain with a smaller budget returns unavailable without recursive traversal.

The evaluator performs no peer retrieval. A service must retrieve the named missing inputs within its synchronization deadline before publishing conditional results.
It cannot detect an omitted branch when no supplied event or reference exposes that branch.

The handover test suite executes H01 through H48 with signed records. Each case uses four delivery orders, duplicate delivery, and serialized reconstruction.
The suite also covers account evidence, native cutoffs, scope conflicts, private overlays, import selection conflicts, rafsi gates, and resource limits.
These tests sample delivery orders. They do not enumerate every permutation of a large event set.

## Context lookup measurements

The synthetic context probe measures one exact resolver call after fixture construction.
It varies publication and judgment counts without reading a live dictionary or running state evaluation.
The output includes the resolved graph digest, elapsed resolver time, and matching judgment count.

From the repository root, build and run the probe with the assigned Rust target directory:

```sh
cargo build -p jvc-state --release --locked --jobs 2 --example context_lookup
/usr/bin/time -v "$CARGO_TARGET_DIR/release/examples/context_lookup" 60000 5000
```

The two arguments select publications and judged targets.
The fixture places at most one judged target in the requested context.
Process CPU and peak memory include fixture construction.
The resolver timer excludes it.
These synthetic results do not establish HTTP latency or live dictionary capacity.
