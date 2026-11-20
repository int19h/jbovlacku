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
Its global work budget counts logical work across graph construction and the evaluator's inner loops: records, dependency edges, propagated missing IDs, range unions, maxima range comparisons and signatures, successor and continuity walks, retention and cutoff checks, policy and selection scans, account claim and certificate loops, and publication and receipt passes. A `jvr1:` judgment or a managed `bridge.set` finds its publication with one lookup in an index. Each evaluation builds that index on first use, in one pass that reads every publication once. That pass is input handling, and the budget does not charge it. Later lookups in the same evaluation reuse the index. An append to a fork still charges the copy of every publication, as for any shared result. One layout pass charges per record and per dependency edge once. A dependency setup pass and a closure construction pass charge those units for each of the three link modes, plus lifecycle, closure, and evaluator loop charges on the same terms.
The count charges the exact interval layout and evaluator loop iterations. It counts no bitset words or pointer sizes, so the same input charges the same total in native and Wasm builds.
One linear pass or copy per operation over state that the host already supplied and keeps is input handling, and the budget does not count it. That state is the retained records, the record arena, a retained overlay, inherited import selections, and option strings. Nothing in the evaluator bounds this retained state beyond the size of the input that supplied it. `Limits.events` does not limit retention: a state over the quota still keeps its records, and only its evaluation is refused.
Evaluation stops as soon as the budget runs out. The evaluator does not publish confident partial state from that run.
Range metadata has a hard cap. A history past the cap returns `resource_unavailable` at any budget. The cap counts the range storage of the closures that the ancestry caches keep. A closure with one range is stored inline and counts nothing. A closure with more ranges counts 16 bytes plus 8 bytes per range. Temporary sets do not count: the unions inside one closure computation, `maxima` merges and carry closures. The cap is 64 MiB plus 1,024 bytes per record (`67,108,864 + 1,024 * records`). A record that a session appends raises the cap by its own 1,024 bytes, as a full evaluation of the same records would. No limit or host setting changes the cap. The cap is computed in 64-bit arithmetic. On a 32-bit target it stops at 4 GiB minus 1 byte from 4,128,768 records, and a 32-bit build runs out of memory before its count of kept storage reaches that value.
Each stored range costs 8 bytes. A fragmented history (for example interleaved chains of one issuer) can therefore use more ancestry memory than the old bitset representation, and an input past the cap returns `resource_unavailable` where the old representation still evaluated it. Results are unchanged for every input under the cap when the work budget covers the work.
The default work budget grows linearly with the input: a base allowance of 10,000,000 units plus 256 units per record plus 1 unit per ID in each distinct valid import selection referenced by the selected view (`10,000,000 + 256 * records + selection_ids`). A caller or operator can supply an explicit `Limits.traversal` override to replace that linear default. `Limits.events` is absent by default and serves as an optional event-count quota when configured.
Exceeding the work budget or an optional event quota makes the entire evaluation unavailable, including other accounts and native publications, with reason `resource_unavailable`.
An ordinary history grows linearly with its record count and fits the default work budget, while super-linear shapes refuse deterministically when they exhaust the budget. The layout keeps the records of each issuer in one block, in dependency order. So a closure usually has one range for each issuer that it reaches. Its kept size does not depend on how many predecessors a record names, on `maxima` calls, or on the numbers of accounts, view revisions and witness groups. A plain chain, and a history in which every record names many predecessors, count nothing. A closure that reaches other issuers through accepted transfers counts 8 bytes for each issuer that it reaches. The cap stays ahead of these charges at any size while each record's kept closures hold fewer than about 120 ranges together. For example, one actor can have up to about 60 accepted key transfers. From about 68 transfers, the work budget refuses that history first. A history whose ranges grow with its record count still refuses. For example, take a chain of 3,500 records in which each record has one child that is never merged, and give each child an ID that sorts right after its parent's ID. Each chain closure then skips every earlier child, and the 7,000 records fill the cap. If all chain IDs sort before all child IDs, the same records keep one range per closure and evaluate.
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
