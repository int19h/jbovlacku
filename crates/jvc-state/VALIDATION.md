# State validation

The state test suite passes 97 tests. It includes H01 through H48 and 49 additional regressions.
The native suite finishes in 24.66 seconds on the development machine with two test threads. The tests use real authenticated signatures and canonical bodies.
Each handover case uses four delivery orders, duplicate delivery, and reconstruction from serialized envelopes.
The suite samples delivery orders. It does not enumerate every possible permutation.

The additional tests cover private overlays, native transfer and compromise rules, historical witness succession, lineage, and invalid action targets.
They also cover imported source revision conflicts across selection chunks, bridge authority, retained profile values, and rafsi eligibility.
Missing selected policy and disabled account authority receive separate receipt outcomes.
Missing witness history, missing observation bodies, missing imported bodies, and malformed observations receive separate regressions.
The suite also checks that missing view ancestry affects imported authority without disabling native ranking.
Conflicting selected source revisions remain unavailable after account status controls.

The chain benchmark contains 2,429 imported definitions and four certified account periods.
Evaluation and result export finish in 3.411 seconds with the debug build and default work budget.
A separate case with 401 accounts sharing witnesses finishes evaluation and export in 1.278 seconds.
These timings come from single runs on the development machine. They do not guarantee performance on another host.
A separate 5,000-event history reaches an explicit smaller budget without recursive traversal.
`Limits.events` is absent by default and serves as an optional event-count quota when configured.
The default work budget is `10,000,000 + 256 * records + 16 * predecessors + selection_ids`.
The `predecessors` term counts each `previous` ID on each record, whether the named record is present or absent.
If several records name the same missing record, each reference adds to the allowance.
The `selection_ids` term counts the IDs in each distinct valid import selection that the selected view names.

The full formula applies when the selection scan completes, even if the work budget or range cap later causes refusal.
If invalid selections stop the scan early, the allowance includes only the valid selections that the scan reached.
If the event quota or a record arena error prevents evaluation, the allowance includes no selection IDs.
An explicit `Limits.traversal` value overrides the default.

The evaluator charges records, dependency edges, copied ranges, and steps in its inner loops.
It also charges distinct missing IDs in each set that it propagates.
The separate cap covers the storage of ranges that the ancestry caches and compromise cutoffs keep.
The evaluator counts those ranges as in a fresh build of the same records.
The cap is 64 MiB plus 1,024 bytes per record (`67,108,864 + 1,024 * records`).
A history past that cap refuses at any work budget.
Exhaustion makes the entire evaluation unavailable, including unrelated accounts and native results.

The crate passes native and standalone wasm32-unknown-unknown build checks.
CI installs Rustfmt and Clippy on the pinned 1.99.0 toolchain.
The toolchain file selects the minimal profile, which does not include these components.

The generated parity corpus contains 353 inputs from all 97 test names. It includes every handover case and the large history tests.
Native expected outputs equal the Chromium WebAssembly outputs for all 353 inputs. The parity runner finishes in 12.810 seconds on the development machine.
The comparison includes the complete evaluator result, publication status fields, and account certificate fields.
The corpus comes from the same native fixture builders. It contains no separate implementation of expected state rules.

The parity runner writes `_wasm-report.json` into the selected corpus directory.
The corpus is generated test output. It is not a required checkout file. CI regenerates it before the browser comparison.

Run these commands from the checkout root. First install the JavaScript dependencies and Chromium as described in the development guide.
Use a new corpus directory for each run, so old cases cannot enter the comparison.

```sh
mkdir -p .cache
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/target}"
export JVC_STATE_PARITY_DIR="$(mktemp -d "$PWD/.cache/state-parity.XXXXXX")"
cargo test -p jvc-state --locked --jobs 2 -- --test-threads=2
npm run build:core
node scripts/test-state-parity.mjs
```

For concurrent work, set `CARGO_TARGET_DIR` to a separate build directory before these commands.
Use an ignored directory or a directory outside the checkout.
Set `JVC_CHROMIUM` if the browser executable is outside Playwright's normal cache.

The pure evaluator performs no peer retrieval. Service code owns retrieval deadlines and transport admission.
A complete supplied inventory cannot prove that no remote branch is hidden.

## Issuer gaps

A mixed closure contains records from more than one issuer.
The stored range index charges one unit per mixed closure and two units per range in those closures.
If any mixed closure exists, it also charges two units per issuer block.
The index counts shared caches once. Local closures add no charge.
A failed graph build stops before the index scans the ranges.

A merge scope contains the records that can contribute to one priced union.
A test compares both kinds of scope index with direct membership at every issuer gap.
If repeated wide operands would make the direct scan too large, the index reads each distinct range list once.
At a candidate gap, it reads the scopes of the ranges that end or start at that gap.
The build and the gap tests are input handling. They take no units from the work budget or the eligibility allowance.

The signed tests compare fresh evaluation, live append, and both restored appends for these merges: carry, native status, historical witness, command authority, authorized claims, and import status periods.
They use the exact fresh cost, one unit below it, and one unit above it.
All paths refuse below the cost and agree on results, work, and ancestry bytes at the cost or above it.
In each test, every priced `maxima` and carry union of the fresh evaluation stays in one issuer block or lies in one collected scope.
The same check runs on every fresh evaluation that the append differential tests compare against.

Two tests add one transfer and its acceptance to many root judgments from distinct keys.
With 30,000 judgments, the next root judgment stays incremental at the default budget.
With 2,000 judgments and an explicit limit equal to the fresh cost, the live append and both restored appends stay incremental.

## Wide predecessor lists

A native release probe used one signed selected view and 600,000 synthetic `identity.merge` records from a single other issuer.
The evaluator received the merge records as host-verified inputs.
Merge record `k` named the preceding `min(k, 64)` records, with `k` starting at zero.
The probe used the default limits and supplied no padding, selections, transfers, or acceptances.

| Records including view | Named predecessors | Work used | Default budget | Available |
| ---: | ---: | ---: | ---: | --- |
| 600,001 | 38,397,920 | 389,379,210 | 777,966,976 | Yes |

The base and record terms supplied 163,600,256 units. The predecessor term supplied 614,366,720 units.
After the first 64 merges, each additional merge needs 649 units in this shape and adds 1,280 units to the allowance.
In the probe's fresh full layout, each predecessor has one contiguous range in each ancestry cache and no missing IDs.
The cap counts zero bytes for those inline ranges.

A history with the same predecessor count can need more work.
Interleaved branches can split the ancestry of a record into many ranges.
Missing records can also add distinct missing IDs to each set that the evaluator propagates.
Other account, policy, or status work can exhaust the budget even if total work grows linearly.

The server-size probe used 143.49 seconds of user CPU time and 8.72 seconds of system CPU time.
Its peak resident memory was 12,959,648 KiB. This figure measures process memory, separate from the work units in the table.
The probe skipped checkpoint serialization and did not measure stored ancestry bytes.
These results give no memory bound for phones.
