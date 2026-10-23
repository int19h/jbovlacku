# Development

The prototype runs locally. The [README](../README.md) distinguishes implemented features from the full target specifications.
The commands below use paths relative to a repository checkout. They do not require the development VM's directory layout.
The human partner's VM also hosts other projects and services. Keep unrelated resources available throughout the work.

## Workspace and temporary files

On this VM, use implementation worktrees under `/build/jbovlacku/worktrees` and task-specific scratch directories under `/build/jbovlacku`.
The primary checkout is `/home/int19h.linux/git/jbovlacku`. The prototype worktree is `/build/jbovlacku/worktrees/prototype` on branch `codex/prototype`.
An isolated worktree is a checkout with its own files.
Use `CARGO_TARGET_DIR` for external Rust build files. Use `JVC_DATA_DIR` for the standalone service's persistent data.

Before work, make sure that the current path and branch match the assigned task.
Record the exact scratch path before cleanup. Delete only that task directory after you inspect its contents.
Do not delete `/build`, sibling worktrees, shared caches, or unrelated directories.
Do not overwrite another agent's changes. Assign file scopes before concurrent work.

## Tools and build

Use Node.js 24 or newer. `rust-toolchain.toml` selects Rust 1.99.0 and the WebAssembly target.
WebAssembly is a portable compiled form for browsers and Workers.
The repository limits Rust builds to two parallel jobs. The WebAssembly build script also uses two jobs.
The generated bindings require `wasm-bindgen-cli` 0.2.105 to match the Rust dependency.

Use compatible Ubuntu packages through `apt` when the task needs a system tool.
Use `npx` for compatible npm tools when necessary. Keep project dependency versions pinned.
Do not install packages for another distribution into this VM. Do not replace shared system libraries for a prototype dependency.
Use the smallest task-relevant privileged action. Keep existing VM services usable.

If the matching binding tool is absent, install it through Cargo:

```sh
cargo install wasm-bindgen-cli --version 0.2.105 --locked --jobs 2
```

Run the build from the repository root:

```sh
npm ci
npm run build
```

`npm ci` installs the locked npm packages. The build produces WebAssembly bindings, the standalone server bundle, and browser assets.
The outputs are `packages/core/generated`, `apps/server/dist`, and `apps/web/dist`.
The repository ignores these reproducible outputs.

The core build accepts `CARGO_TARGET_DIR` and `JVC_WASM_BINDGEN`.
The first variable selects Rust build storage. The second names the exact `wasm-bindgen` executable.
Its version must remain 0.2.105.
For this VM, use a task-specific target directory:

```sh
CARGO_TARGET_DIR=/build/jbovlacku/targets/prototype npm run build:core
```

Use established cryptographic libraries. Do not implement curve arithmetic in application code.
Keep dependency notices with redistributed files. The [dependency guide](dependencies.md) describes the required notices.
The project software license remains a prelaunch choice.
New native definitions use the [CC0 contribution terms](format.md#remaining-body-fields). Imports retain their source rights and attribution.

## Standalone app

The Node.js adapter serves the API and built browser assets. It stores objects, receipt state, and SQLite indexes in its data directory.
A new directory starts empty. The adapter requires no Cloudflare credentials or network access to Cloudflare.
Keep the data directory across process restarts when persistence matters.

Start the built application from the repository root:

```sh
JVC_DATA_DIR="$PWD/.cache/node" npm run start:built
```

The application listens on `127.0.0.1:8789`. Its readiness endpoint is `/api/health/ready`.
Stop the foreground process with Ctrl+C. SIGINT and SIGTERM close the service and its SQLite databases.
`npm run start` runs the TypeScript source instead of the built server bundle.
Build the WebAssembly bindings before either command.

The Node adapter accepts these environment variables:

| Variable              | Purpose                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `JVC_DATA_DIR`        | Persistent objects and SQLite databases. The default is `data/node` relative to the checkout. |
| `HOST`                | Listen address. The source default is `127.0.0.1`.                                            |
| `PORT`                | Listen port. The default is `8789`.                                                           |
| `JVC_ASSETS_DIR`      | Browser assets. The source default is `apps/web/dist`.                                        |
| `JVC_SERVER_ID`       | Service identifier. The source default is `local-node`.                                       |
| `JVC_VIEW`            | Explicit selected view event ID. A fresh service has no dictionary view.                      |
| `JVC_STATE_TRAVERSAL_LIMIT` | Explicit state work budget from 1 through 1,000,000,000. It overrides the saved import limit. |
| `JVC_PUBLIC_ORIGIN`   | Explicit public origin permitted to submit browser writes through a reverse proxy.            |
| `JVC_SNAPSHOT_LIMIT`  | Retained snapshot count. The default is 16. Allowed values are 1 through 64.                  |
| `JVC_CORS_ORIGINS`    | Comma-separated additional permitted origins.                                                 |
| `JVC_POLICY_URL`      | Operator policy URL. The prototype placeholder is not a published policy.                     |
| `JVC_PROTOTYPE_BATCH` | Set `enabled` only for authorized local batch fixtures. The default disables batch admission. |

A browser write is allowed when its `Origin` equals the request URL's origin.
Set `JVC_PUBLIC_ORIGIN` when an HTTPS reverse proxy gives the browser a different public origin.
Other browser origins need explicit `JVC_CORS_ORIGINS` entries.
The adapter does not infer the public origin from forwarded headers.
Browser assets allow local scripts and WebAssembly. They block inline scripts, JavaScript string evaluation, and framing.

The coordinator keeps the most recent 16 distinct snapshot wrappers by default.
Use `JVC_SNAPSHOT_LIMIT` on Node or `SNAPSHOT_LIMIT` in the Worker configuration to change this count.
Expired or unpublished snapshot reads return HTTP 410 with `snapshot_expired`.
Signed envelopes, bodies, selections, and accepted event cursors remain durable after wrapper expiry.
Reusing an identical retained snapshot ID refreshes its retention position.
A wrapper becomes visible only in the transaction that publishes its current pointer.

An older prototype database has no trusted snapshot publication order.
Migration from the first prototype retains its current snapshot only. Other old snapshot IDs expire.
A rebuilt inventory must match the stored current pointer. A mismatch reports storage unavailable.
Legacy object-store wrappers and the old snapshot-ID table remain as one-time cleanup debt.
Anonymous event and selection admission has no contributor quota. Signed object retention remains unbounded.

A generation is an index copy for one snapshot. An alias points to a generation with the same entries.
The Node search index retains its current generation, one rollback generation, active staged generations, and the source generations that aliases use.
Index publication removes obsolete rows, aliases, and markers in the same SQLite transaction.
Historical API reads use immutable packages. If an index base is absent, the service rebuilds it from the completed package entries.

This prototype needs an admission policy and resource limits before public use.
New admissions store wrappers in bounded coordinator rows and create no more legacy wrapper objects.

At most two distinct evaluation jobs and two package jobs run at once.
Requests for the same snapshot and view share evaluation work.
An unknown or invalid requested view is rejected before full evaluation.
Alternate views cannot evict the most recent configured-view evaluation.
If a committed admission cannot obtain an evaluation slot, its receipt still reports the durable acceptance and cursor.
It reports unavailable interpretation with `evaluation_resource_unavailable`. A later receipt read or retry can evaluate it.

The Node adapter evaluates new snapshots in the background.
Without an explicit snapshot, word, search, identity, account, and package reads use the last completed snapshot.
The manifest also names that completed snapshot. Interpreted results name their snapshot and view.
Raw replication reads can expose the newer accepted inventory and name its snapshot.

The accepted cursor advances after durable admission. The materialized cursor advances after evaluation, packages, and index publication complete.
During that gap, a new event receipt reports `index_lag` and `evaluation_pending`, with unavailable interpretation and a null snapshot.
A late-body receipt also uses a null snapshot until the completed snapshot contains the same body mapping.
An unchanged event keeps the completed snapshot and its derived receipt while later writes wait.
This receipt lets the browser finish its wait without waiting for every other write.
The service retains the preceding completed snapshot during a backlog. Failed jobs leave it available, and later reads retry the latest inventory.

After local publication, a fresh browser word read waits for accepted records from this server to finish evaluation.
The page shows that the server stored the records while its word view updates.
This page session tracks only receipts whose envelope and required body match the saved delivery.
The wait lasts at most 15 seconds and stops when the reader leaves the page.
A temporary network failure or HTTP 5xx response triggers another poll within that same deadline.
A failed wait keeps delivery accepted and offers a refresh. Ordinary reads and explicit snapshot reads still use their completed snapshot.

A checkpoint is a saved evaluated state.
The Node adapter keeps one pinned checkpoint under `evaluation-cache` in `JVC_DATA_DIR`.
The file contains compressed Node binary data. An independent SQLite row pins its digest and calculation context.
That context includes the exact snapshot, logical inventory, event position, selected view, work limits, and Wasm artifact digest.

The core also compares its checkpoint schema and binding before restore.
Missing, damaged, incompatible, or mismatched checkpoints return to full evaluation from original records.
The cache limits are 256 MiB compressed and 768 MiB decoded. A cache failure does not change protocol results.

Shutdown drains pending evaluation and checkpoint work before it closes SQLite.
Checkpoint recovery rebuilds a missing search index from the saved entries before readiness.
The service captures at most one checkpoint per minute after a 100 ms quiet period.
It keeps only the latest pending snapshot during that interval. A failed capture also counts toward the interval.
Shutdown bypasses the interval and saves the latest completed state.
Core export and binary serialization still run synchronously on the Node event loop.
The interval limits their frequency, not their duration.

Use a separate data directory for each test service. Do not point a disposable test at another service's database.
A selected view and explicit import selection determine which imported publications appear.
The [importer guide](../packages/importer/README.md) describes local signed proposals and their disposable key inputs.

### Initial Lensisku data

The importer reads pinned REST captures and PostgreSQL COPY snapshots under one canonical Lensisku source origin.
Both extraction commands share one journal for that origin and importer key.
The SQL extraction uses every source definition language that the format can represent.
It preserves authored source fields and available history. It omits derived vectors and caches with explicit source limitations.
Malformed related rows leave affected definitions unresolved. They never create false source removals.
The importer guide describes both extraction commands, source manifests, and unresolved reports.

After preparing a signed proposal, stop the Node server for the target data directory.
From the repository root, load the proposal into that directory:

```sh
npx tsx packages/importer/src/load-cli.ts \
  --proposal .cache/import-sql \
  --data .cache/node \
  --state-traversal-limit 1000000000
JVC_DATA_DIR="$PWD/.cache/node" npm run start
```

The loader admits signed carriers, their import selection, and their selected view.
It records the selected view and explicit traversal budget in `loaded-view.json`.
Node startup reads that file. `JVC_VIEW` and `JVC_STATE_TRAVERSAL_LIMIT` provide explicit overrides.
A repeat load reuses accepted event positions. It does not create new signatures.

The loader and Node server hold an exclusive `.node-data-lock` in the target directory.
If a process leaves that lock, settle the process before removing its exact lock directory.
Keep the proposal journal and external source archive available for retries and source inspection.
The SQL archive records the digest and path of the external dump instead of copying it into the proposal.
Rights remain unknown in this extraction. Local loading grants no publication authority.

Large imports need a larger explicit state work budget and enough memory.
The traversal flag changes the work limit only. It does not remove memory or event limits.
The loader completes admission before the server builds its snapshot, indexes, and search packages.
Successful admission alone does not establish successful dictionary evaluation.

The service streams original envelopes and bodies into the shared core, with at most 16 record reads in progress per job.
The core authenticates each envelope and the complete original body before it retains the fields needed for state.
These fields include source selection evidence and numeric source-account evidence. Stored bodies and signed identifiers keep their original bytes.
Sessions retain evaluated state instead of all source bodies. Small ancestor sets use sparse storage.
Identical history caches share storage when the snapshot contains no acceptance events. Work charges stay unchanged.

When the event limit is exceeded, the core returns `resource_unavailable` before it builds ancestry caches.
It retains authenticated records so that a later limit change can recover them.

New snapshots reuse authenticated compact records and the preceding evaluation.
A complete issuer with one active key can update a judgment register or publish a native definition without a full rebuild.
The new event cannot resolve an old missing reference. The evaluator also requires enough work for the equivalent full result.

Trust, lifecycle, view, account, status, rafsi, profile, report, and bridge changes rebuild state from the retained authenticated records.
Changed bodies, import selections, calculation configuration, or unavailable history also force a rebuild.
These rules follow the [history and authority rules](format.md#4-causal-order-and-acceptance) and the [ranking rules](format.md#8-editorial-trust-and-ranking).

Forks share immutable ancestor payloads. After 64 appended records, a rebuild incorporates the new IDs into the ancestor universe.
The evaluator retains the full logical work charge. Uncertain work at an ancestor-width boundary forces a rebuild.

Judgment updates can return a patch of at most 1 MiB for the exact parent session.
The facade applies that patch to immutable result maps. Other changes return the full result.
Differential tests compare the complete state and ranking with full evaluation.
The external Lensisku slice test is ignored in an ordinary Cargo test run.
It requires a local file of signed carriers through `JVC_LENSISKU_CARRIERS`.
If you request this test without that variable, the test fails with a setup message.

From the repository root, run the external test with the carrier file that your task authorizes:

```sh
JVC_LENSISKU_CARRIERS=/absolute/path/to/carriers.jsonl \
  cargo test -p jvc-state --test incremental \
  lensisku_slice_mixed_writes_equal_full_evaluation -- --ignored --exact --nocapture
```

Search packages reuse authenticated text and attribution fields from unchanged records.
New or changed record bytes pass the original validators. Stored objects remain immutable.
Judgments reuse package parts and search entries. Changed publications rebuild the affected language packages.

Missing, changed, or late body bytes retain their separate handling. The verifier caches at most 1,024 validated public keys per builder.
Every signature still passes the point, scalar, embedded-key, and equation rules.
The existing combined-request API remains available for smaller browser snapshots. It still allocates the complete request.

The measurement below predates the review fixes and the removal of derived embedding vectors from signed import bodies.
It used 59,125 definitions, 44 languages, and the saved 1,000,000,000-unit traversal budget.
It began with 59,141 events and ended with 59,146 after five signed endorsements.
Earlier local probes added 15 endorsements. Definition bodies and import selections remained unchanged.
The source listened on `127.0.0.1:8951`. The start command used no Node heap override.

With a checkpoint, readiness took 6.11 seconds. The first `klama` word request took 0.32 seconds.
Process startup through that response took 6.43 seconds.
A second restart restored all five writes. Its readiness took 6.20 seconds, and its first word request took 0.32 seconds.
The second restart took 6.51 seconds through the first word response.

The five endorsements became visible in 4.26, 2.50, 2.11, 2.16, and 2.15 seconds.
The timer ran from the signed POST until the first word response with the new reviewer count.
Later receipt and event reads made sure that the named snapshot contained each signed event.
Admission receipts reported durable acceptance, `index_lag`, `evaluation_pending`, and a null snapshot.
Reads used the preceding completed snapshot while the new snapshot evaluated.

Search took 11 to 74 milliseconds across English, French, and Russian.
The same run read language packages, package parts, and original definition bodies successfully.
The checkpoint file used 67,471,830 bytes, or 64.35 MiB.
Wasm linear memory reached 1.69 GiB. Linux reported peak process memory of 3.51 GiB, including Wasm.

The word request with a checkpoint and all five writes met the five-second request targets.
Process startup plus the first word response still exceeded five seconds.
Initial evaluation without a checkpoint still authenticates every record and builds the complete history state.
A preliminary run took 70.01 seconds for its first word request, above the original 30-second target.
Initial package generation also rereads retained bytes to detect storage failures.

These single-process measurements use the VM's existing filesystem cache. They do not establish performance on another host or under concurrent full imports.
The measurements do not establish hosted Worker resource compliance.

The first full SQL evaluation before streaming reached WebAssembly's 4 GiB memory limit with derived source vectors in every body.
The revised extraction omits derived vectors and cache fields. Full dictionary serving with that extraction remains unmeasured.
An explicit traversal limit or a larger Node heap does not remove the WebAssembly memory limit.

## Browser development

The browser development server proxies `/api` to `http://127.0.0.1:8789` by default.
Start the Node adapter first. Start Vite in another terminal from the repository root:

```sh
npm run dev:web
```

Vite listens on `http://127.0.0.1:5177`. `JVC_WEB_API_TARGET` selects another API origin for the proxy.
`npm run build:web` builds the static assets without rebuilding Rust or the server bundle.
The Node adapter serves those built assets directly.

Browser signing requires localhost or HTTPS. Plain HTTP through a Tailscale IP address provides reading only.
Use an authorized HTTPS setup for remote signing tests. Do not disable browser security to make HTTP signing work.
Key backup exports do not include unpublished drafts or pending outbox records.

## Local Worker API

The Worker uses the shared service layer and the same WebAssembly runtime.
Its local bindings use R2 for immutable objects, D1 for indexes, and a Durable Object for admission coordination.
`apps/worker/wrangler.jsonc` declares local bindings. The current adapter exposes the API.
The Worker is API-only. The full browser hosting contract remains a target requirement.

Run Wrangler from the repository root after the core build:

```sh
npm run dev:worker -- --port 8790 --persist-to "$PWD/.cache/worker"
```

This command uses local storage and exposes the API on port `8790`.
Use a task-specific `/build/jbovlacku` path for `--persist-to` on this VM.
`npm run types:worker` regenerates the Worker type declarations.
Do not use production bindings or deploy during local tests.

The measured local batch contains 2,430 events. The table records R2 operations before D1 and Durable Object work.

| Measured implementation                         | Batch admission | Cold search |
| ----------------------------------------------- | --------------: | ----------: |
| Earlier object-store wrappers                   |          17,013 |       9,726 |
| Bounded coordinator wrappers and view preflight |          17,010 |       9,727 |

The current counts include the R2 adapter's read before each immutable write.
The cold search also includes two reads for requested-view preflight.
The local batch opt-in enables Worker diagnostic logs with request paths, R2 counts, and Wasm linear-memory size.
These counters describe sequential fixture requests. Concurrent requests can overlap the counter deltas.
The logs omit body content and signing keys.
Private cache serialization now avoids an extra Wasm parse of each complete wrapper.
In the Node measurement, the first cache write kept Wasm memory at 3.93 MB instead of growing to 43.06 MB.
Evaluation still grew Wasm memory to about 73 MB after admission and 90 MB after cold search.
These samples do not bound total memory. JavaScript, SQLite, and the host also allocate memory.

Local Wrangler success does not prove deployed quota, memory, or CPU compliance.
The prototype batch endpoint is a local opt-in. Larger hosted imports need bounded incremental jobs.

## Native carrier tools

The native `jvc` command supports canonical directory carriers, committed Git trees, JSONL carriers, and envelope-only streams.
A carrier is a portable snapshot of records and selections.
The [carrier guide](../crates/jvc-carrier/README.md) describes the file layout, validation, refusal policy, and operational read limits.

Print the supported native interface from the repository root:

```sh
cargo run -p jvc-runtime --bin jvc -- --help
```

Use `cargo run -p jvc-runtime --bin jvc --` before the arguments below.
The table names the implemented interface. Output files and directories must be new.

| Arguments                                                              | Behavior                                                                                           |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `canonicalize FILE`                                                    | Write canonical JSON to standard output.                                                           |
| `verify FILE`                                                          | Inspect one signed envelope and report signature, action, and body availability.                   |
| `evaluate FILE`                                                        | Evaluate a runtime input object containing events, bodies, a selected view, and import selections. |
| `validate DIRECTORY`                                                   | Inspect canonical carrier files, signatures, body schemas, hashes, and the manifest.               |
| `validate-git REPOSITORY COMMIT`                                       | Read and inspect exact blobs from a local committed tree.                                          |
| `validate-checkout REPOSITORY COMMIT`                                  | Also make sure that checkout files match the committed blobs.                                      |
| `inventory DIRECTORY`                                                  | Report the snapshot, logical inventory digest, and manifest.                                       |
| `import FILE --format jsonl --output DIRECTORY [--selection FILE ...]` | Import canonical records and separately supplied import selections.                                |
| `export DIRECTORY --format jsonl`                                      | Write canonical records to standard output. It omits import selections.                            |
| `merge LEFT RIGHT --output DIRECTORY [--policy FILE]`                  | Write the authenticated set union with an explicit local refusal policy when supplied.             |
| `retain DIRECTORY --policy FILE --output DIRECTORY`                    | Write a filtered carrier and its resolved policy sidecar.                                          |

JSONL carriers contain `{body,envelope}` records. Export sorts them by event ID.
A JSONL export does not include import selections. Keep each selection as a separate canonical JSON file.
Supply every required selection through repeated `--selection FILE` arguments when importing.
This restores the complete carrier snapshot. Importing records alone cannot restore a snapshot that contained selections.

An envelope-only stream contains one signed envelope per line without inline bodies.
`validate`, `inventory`, `export`, and `merge` accept this separate format through `--format envelope-jsonl`.
Envelope validation reports signature and action results. Its report explicitly states that causal evaluation was not requested.
It does not establish full dictionary conformance.

Git commands require a full commit object ID. They never fetch remote data or select a branch by arrival order.
Keep the input directory stable during a read. The Git reader avoids hooks, filters, lazy fetch, and global configuration changes.
The full target `jvc` catalog remains larger than the implemented command surface.

Refusal policies contain `refused_bodies`, `refused_events`, and `refused_issuers` arrays.
They remain private local policy. The carrier does not adopt a peer's refusal policy.
`retain` and a policy-bearing `merge` write `OUTPUT.retention-policy.json` beside the output directory.
The sidecar contains the resolved policy. Refusing a known event records its issuer so that later merges can retain the refusal.

Keep that sidecar beside the output directory, outside the public carrier.
If either local input has an adjacent retention-policy sidecar, a merge without `--policy` refuses to continue.
Use `merge --policy FILE` to select the refusal policy explicitly. That selection can intentionally override the saved policy.
Removing the sidecar loses this check. A filtered directory alone does not remember refusals, and a later merge can restore content from its other input.
A refusal does not prove physical deletion from Git history, peers, or backups.
If a write fails, treat partial output as unusable until inspected.

## Tests and evidence

Install Git, Node.js 24, and `ssh-keygen` before the Rust tests.
The core interoperability tests use Node WebCrypto and OpenSSH.
On Ubuntu, the `openssh-client` package supplies `ssh-keygen`.

Run the available tests from the repository root after the core build:

```sh
cargo test --workspace
npm run typecheck
npm run test:service
JVC_TEST_ROOT="$PWD/.cache/adapter-tests" npm run test:adapters
npx tsx --test packages/importer/test/*.test.ts
npx tsx --test packages/core/test/evaluation-request.test.ts
```

The adapter tests start a built Node server and local Wrangler on available loopback ports.
They test restart, late bodies, snapshot reads, expiry, same-origin writes, exact retry, and logical parity. Build the server and core before these tests.
`JVC_ADAPTER_CARRIER` optionally adds a local signed JSONL corpus to both adapter runs.
`JVC_ADAPTER_SELECTION` adds its selection sidecar, and `JVC_ADAPTER_VIEW` enables a retained-view search check.
`JVC_ADAPTER_ONLY` selects `node` or `worker` for a diagnostic run.
`JVC_ADAPTER_CORPUS_ONLY=enabled` skips the preceding synthetic request sequence.
These inputs stay outside the committed synthetic adapter fixture.
Service unit tests use the system temporary directory by default and remove each owned case after it finishes.
`JVC_TEST_ROOT` selects another test directory. Adapter tests retain their own logs in their reported directory.
The browser security probe runs all three Playwright engines:

```sh
npx playwright install chromium firefox webkit
npx tsx scripts/test-server-security.ts
```

`JVC_CHROMIUM`, `JVC_FIREFOX`, and `JVC_WEBKIT` can select existing compatible browser executables.
`JVC_SECURITY_BROWSERS` selects a comma-separated subset of `chromium,firefox,webkit`.
The probe verifies real runtime WebAssembly, blocked JavaScript evaluation, blocked inline scripts, and blocked framing.
`scripts/measure-service-io.ts` uses the same corpus variables to count object operations and sample Node and Wasm memory.
`JVC_IO_REPORT` selects an output report file. Its disposable database is removed when the measurement finishes.
The importer tests use pinned JSON captures and a small SQL fixture with source provenance.
Inferred place conversion and automatic rafsi publication remain unfinished.
Use disposable contributor keys and synthetic account evidence. Do not use real contributor keys or change a Lensisku account.
Read imported SQL as data. Do not execute an import dump against a service database.
Use mocked providers before real inference tests.

Install the Chromium test binary into a task-specific directory, then run the browser tests:

```sh
PLAYWRIGHT_BROWSERS_PATH="$PWD/.cache/playwright" npx playwright install chromium
PLAYWRIGHT_BROWSERS_PATH="$PWD/.cache/playwright" JVC_TEST_ROOT="$PWD/.cache/browser-tests" npm run test:web
```

The browser tests start their own API and Vite processes. Ports `8797` and `5177` must be free.
`JVC_TEST_API_PORT` and `JVC_WEB_PORT` select other ports. `JVC_TEST_ROOT` selects the parent directory of the run data. Each run creates a separate `browser-run-*` directory. Workers reuse that directory through `JVC_PLAYWRIGHT_RUN_ROOT`. Runs retain their fixtures and results.

The fixture server opens a readiness listener on `JVC_READY_PORT`. The default is the API port plus 1000. That port must be free before a run starts. The listener answers 200 only after every fixture record is admitted and the fixture file is written. The runner waits for that answer. `JVC_FIXTURE_DELAY_MS` delays the preparation, for readiness tests only.
The server fixture publishes a seeded two-root view with synthetic definitions, an import selection, and a rafsi claim. Its record IDs are written to `fixture.json` in that directory.
The draft model and the builder metadata have Node unit tests:

```sh
npx tsx --test apps/web/test/unit/*.test.ts
```

On this VM, place browser binaries and test data under a task-specific `/build/jbovlacku` directory.

The shared format corpus also supports native and Chromium comparison:

```sh
PLAYWRIGHT_BROWSERS_PATH="$PWD/.cache/playwright" python3 crates/jvc-core/tests/run-browser-parity.py
```

That harness accepts `CARGO_TARGET_DIR` and `WASM_BINDGEN`. Its binding tool override differs from `JVC_WASM_BINDGEN` in the main build script.
It records results under the selected Rust target directory.

The state and ranking corpus uses the generated browser bindings from `npm run build:core`.
Install Chromium as described above. Use new corpus directories for each run so old fixtures cannot enter the comparison:

```sh
mkdir -p .cache
export JVC_STATE_PARITY_DIR="$(mktemp -d "$PWD/.cache/state-parity.XXXXXX")"
export JVC_SHUN_PARITY_DIR="$(mktemp -d "$PWD/.cache/shun-parity.XXXXXX")"
cargo test -p jvc-state -p jvc-runtime --locked --jobs 2 -- --test-threads=2
npm run build:core
node scripts/test-state-parity.mjs
```

The runner initializes the browser WebAssembly module before it compares complete native state and ranking results.
Ranking cases compare `rank_word`, session ranking, and `rank_with_reviewers`, including `public_shun_block` and `private_block` details.
When `JVC_SHUN_PARITY_DIR` is set, the runner requires shun-profile cases and both block reasons, separately and together.
Without that variable, the runner compares state only. CI sets both corpus variables before the native tests and browser comparison.
The runner writes `_wasm-report.json` into `JVC_STATE_PARITY_DIR`.
`JVC_STATE_PARITY_WASM_DIR` selects another directory of browser bindings. `JVC_CHROMIUM` selects another Chromium executable.

The [ranking guide](../crates/jvc-rank/README.md) describes its independent route oracle and eleven measurement scenarios.
Its measurement script uses `CARGO_TARGET_DIR` or the repository's `target` directory.
It requires an explicit output file and refuses to replace existing evidence.
Install Node.js and `/usr/bin/time` before those measurements.
Do not treat the recorded timings as a performance guarantee for another host.

The expansion budget counts graph expansion work. It does not bound relaxed matrix work, fraction arithmetic, memory, or total CPU time.
The weighted sixteen-actor measurement takes 8.119 seconds in WebAssembly with zero completed expansions.
Resource errors must expose unavailable results instead of fabricated zero scores.
[Issue 9](https://github.com/int19h/jbovlacku/issues/9) tracks ranking CPU limits before public deployment.

The state evaluator also has a work budget for history traversal and ancestor sets.
The current default budget can run out at roughly 4,500 events in a flat history.
This is an approximate limit. Histories with more edges can reach it sooner, and the requested state also affects the work.
The configured event-count limit does not guarantee successful evaluation of every history below that count.
[Issue 11](https://github.com/int19h/jbovlacku/issues/11) tracks state evaluation beyond the local corpus.
Use the [state validation guide](../crates/jvc-state/VALIDATION.md) for its tested corpus and limits.

The required acceptance tests also cover both adapters, restart, duplicate delivery, interrupted snapshots, missing evidence, and delivery permutations.
They must compare logical state from identical records and an explicit view.
The [handover cases](handover-cases.md) supply required account-control outcomes.
The [format specification](format.md) and [frontend specification](frontend.md) define the complete target acceptance requirements.

Record the exact source revision, commands, fixture versions, failures, and limits with test results.
Do not claim that a planned scenario is an executed test.
Available commands and local test results do not establish complete specification conformance or public deployment readiness.

## Container package

The OCI image packages the standalone adapter and browser assets. OCI is the standard container image format.
The scripts default to Podman and image name `localhost/jbovlacku:prototype`.
`JVC_CONTAINER_ENGINE` selects another compatible engine. `JVC_CONTAINER_IMAGE` selects another local image name.
The build does not push or publish the image.

Build and test the local image from the repository root:

```sh
bash scripts/container-build.sh
JVC_CONTAINER_TEST_DIR="$PWD/.cache/container-tests" bash scripts/container-smoke.sh
```

The image runs as the `node` user with UID `1000`. It listens on port `8789` and stores persistent data at `/var/lib/jbovlacku`.
Use a named volume or writable mount at that path. Keep the volume when you recreate a service container.
The smoke script creates a unique disposable volume and binds an available loopback port.
It tests a signed write, process restart, exact retry, receipt deduplication, browser assets, and clean shutdown.
Its cleanup removes only its own named container and volume. It retains test files in the selected directory.

The image retains application notices, font licenses, and the Rust standard library notices.
The [dependency guide](dependencies.md) names those files.
Run the smoke test after image or storage changes. A successful build alone does not prove persistence.

## Review and human tests

Sol 6.1 with high reasoning effort performs implementation work. Use native harness subagents for assigned implementation and review work.
The coordinating agent performs the first review and directs fixes until that review passes.
Opus and Grok then perform independent external reviews. Kimi remains parked unless the human partner changes that assignment.
Each review must name the exact commit or complete working diff under review.
A later substantive change requires a new review of the affected behavior.

Resolve review findings and rerun the relevant tests before handoff.
Luna performs thorough testing before the human partner starts local acceptance tests.
Give Luna the reviewed revision, both adapter commands, fixture locations, and expected outcomes.
Preserve failures and limits in the handoff. A green unit test result does not replace browser or adapter tests.
If a required scenario is unavailable, state the missing behavior explicitly.

Provide tested URLs through the VM's Tailscale address. Name the service, port, revision, adapter, and permitted signing mode for each URL.
Make sure that the URL works from the expected test client before handoff.
Do not expose a local service publicly or change network policy without separate authorization.
Keep authorized test services available for human testing.

## Release boundary

Prototype work includes local implementation, tests, reviews, and human testing on this VM.
It does not authorize production deployment, live dictionary contributions, external account mutation, or a public release.
Expressly authorized private GitHub issues and pull requests remain development work.
Do not merge or deploy through an inferred review approval.
Real provider requests and authenticated cross-posting require their own authorized test scope.
Before launch, select the software license, trust roots, witnesses, imports, and operator policies.
Implement and test the chosen CC0 contribution flow and the separate imported source-rights convention before public contributions.
Retain the distinction between signed attribution and permission to distribute source content.
