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
The default event admission limit does not promise support for every history shape at that size.
The default 10,000,000-unit work budget counts records, dependency edges, and propagated missing IDs. A flat history costs seven units per record and a single-parent chain costs thirteen units per record, before evaluation-time closure charges.
Histories with more edges can reach the limit sooner. Exhaustion makes the entire evaluation unavailable, including unrelated accounts and native results.

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
