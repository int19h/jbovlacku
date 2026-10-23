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
Migration rebuilds and retains its current snapshot only. Other old snapshot IDs expire.
A rebuilt inventory must match the stored current pointer. A mismatch reports storage unavailable.
Legacy object-store wrappers and the old snapshot-ID table remain as one-time cleanup debt.
Anonymous event and selection admission has no contributor quota. Signed object retention remains unbounded.
This prototype needs an admission policy and resource limits before public use.
New admissions store wrappers in bounded coordinator rows and create no more legacy wrapper objects.

At most two distinct evaluation jobs and two package jobs run at once.
Requests for the same snapshot and view share evaluation work.
An unknown or invalid requested view is rejected before full evaluation.
Alternate views cannot evict the most recent configured-view evaluation.
If a committed admission cannot obtain an evaluation slot, its receipt still reports the durable acceptance and cursor.
It reports unavailable interpretation with `evaluation_resource_unavailable`. A later receipt read or retry can evaluate it.

Use a separate data directory for each test service. Do not point a disposable test at another service's database.
A selected view and explicit import selection determine which imported publications appear.
The [importer guide](../packages/importer/README.md) describes local signed proposals and their disposable key inputs.

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
The importer tests use pinned JSON captures. General SQL migration, inferred place conversion, and automatic rafsi publication remain unfinished.
Use disposable contributor keys and synthetic account evidence. Do not use real contributor keys or change a Lensisku account.
Read imported SQL as data. Do not execute an import dump against a service database.
Use mocked providers before real inference tests.

## Optional AI assistance

AI assistance is off by default. The shared service implements the same assistance jobs on Node and the local Worker.
Each action needs an explicit browser request. The provider key stays on the server.
The provider uses the configured base URL plus `/chat/completions`. Clients cannot supply a provider URL or model.
The tested configuration uses `meta/muse-spark-1.3-contributor`, the `meta` route only, and `medium` reasoning.
The service forbids provider redirects and fallback routes. It sends one `submit_answer` tool and checks every answer locally.
Every request uses `tool_choice: "auto"`. The tested provider supports only that choice.
The answer still requires one valid `submit_answer` call. A missing call counts as a failed answer and receives correction instructions.
After three failed answers for one task, that task fails. A provider or transport failure stops the job without an automatic paid retry.

Both local adapters accept these variables:

| Variable | Purpose |
| --- | --- |
| `JVC_AI_ENABLED` | Set `enabled` to offer assistance. The default is disabled. |
| `JVC_AI_BASE_URL` | Provider base URL. The default is `https://openrouter.ai/api/v1`. Use HTTPS, or HTTP on loopback for a local provider. |
| `JVC_AI_KEY_FILE` | Path to the server-held provider key. Node reads the file for each model turn. The local Worker launcher reads it at startup. |
| `JVC_AI_PROVIDER_NAME` | Public provider name. The default is `OpenRouter`. Capability metadata uses this name and the route, without the private endpoint URL. |
| `JVC_AI_MODEL` | Model name. The default is `meta/muse-spark-1.3-contributor`. |
| `JVC_AI_PROVIDER_ROUTE` | Single permitted route. The default is `meta`. |
| `JVC_AI_REASONING_EFFORT` | Reasoning level. The default is `medium`. |
| `JVC_AI_OPERATIONS` | Comma-separated permitted operations. The default contains all six operations below. An empty value disables every operation. |
| `JVC_AI_DECISION_REPORTS` | Set `enabled` to request a written decision report before the tool call. The default is disabled. |
| `JVC_AI_MAX_TOKENS` | Maximum output tokens for each provider turn. The default is 16,384. The permitted range is 128 through 32,768. |
| `JVC_AI_TIMEOUT_MS` | Time limit for the complete job. The default is 120,000 milliseconds. The permitted range is 10 through 900,000. Job expiry also bounds this time. |
| `JVC_AI_CONCURRENCY` | Maximum active jobs. The default is two. The permitted range is one through four. |
| `JVC_AI_MAX_COST_USD` | Maximum reserved cost for one job. The default is 2 USD. The permitted range is 0.001 through 10. |
| `JVC_AI_MAX_PRICE` | Maximum input and output price in USD per million tokens. The default is 10. The permitted range is 0.001 through 100. |

Operations are `type`, `lujvo`, `gismu-sources`, `cmavo-class`, `definition`, and `places-glosses`.
The `default` profile covers the enabled operations. The `components` profile proposes lujvo components.
The `lujvo` profile also proposes a spelling. The deterministic builder constructs and recovers that spelling before the service returns it.
Existing component choices constrain a proposal. An AI answer never assigns a rafsi or publishes a definition.
Explicit rafsi locks enter construction as draft choices. They do not claim accepted assignment standing or an endorsement.
A lujvo draft can contain zero or one component before the author completes it. The service preserves those draft constraints during inference.
Draft metadata still uses the documented HTTPS morphology and scoring identifiers. Empty rafsi values mean unlocked component choices.
Initial place suggestions contain at most 16 places. Component suggestions contain two through eight components.
Selma'o suggestions contain at most 16 classes. Larger existing structures remain available through manual editing.

Start the Node source service with the variables above and `npm run start`.
For the local Worker, use `npx tsx apps/worker/dev-ai.ts` instead of the ordinary Wrangler command.
Set `JVC_WORKER_DATA_DIR` to its task-specific local storage directory. `HOST` and `PORT` select its listener.
The launcher reads the named key file into an in-memory Worker binding. It never writes another credential file or passes the key in command arguments.
It suppresses Wrangler binding output and reports only a fixed startup error on failure.
The Worker runtime cannot read a host file path. Its provider key binding is `JVC_AI_KEY`.
The ordinary Wrangler command leaves assistance off unless the operator supplies that binding and enables the configuration.
Hosted secret setup and deployment remain separate operator work.

The billing reservation uses UTF-8 request bytes as a conservative input-token bound, plus 1,024 tokens for transport overhead.
It reserves each turn's maximum output tokens at `JVC_AI_MAX_PRICE` before sending that turn.
It also sends that price ceiling to the provider. Unknown usage stays unknown in the log.
Every turn sends `usage: { include: true }`, including correction turns.
[OpenRouter's usage guide](https://openrouter.ai/docs/cookbook/administration/usage-accounting) says that this field is deprecated and has no effect because usage is automatic.
The request retains the explicit field for the configured protocol. It does not guarantee that a response contains usage.
The log records only the token counts and cost that the provider supplies.
These bounds require a provider that honors its advertised price ceiling. They do not establish billing behavior for an untested compatible provider.

An individual provider response has a 256 KiB limit. Each job reserves at most 2 MiB for its full inference log.
Before a provider turn, the service reserves space for that request, the complete bounded response, and its displayed log fields.
If the next turn cannot fit, the job fails with `log_limit` before it sends that turn.
At most four private jobs retain logs at once. This reserves at most 8 MiB for logs, in addition to bounded proposals and runtime data.
A full reservation returns HTTP 429. Saving or dismissing a result releases its reservation through acknowledgment.

`GET /api/v1/session` returns a CSRF token and sets a Secure, HttpOnly, SameSite=Strict session cookie.
The browser sends the token in `X-CSRF-Token` for `POST /api/v1/assist` and `DELETE /api/v1/jobs/ID`.
Private requests use the configured `JVC_PUBLIC_ORIGIN` on Node or `PUBLIC_ORIGIN` on the Worker, or the request origin by default.
Extra origins permitted for public dictionary reads cannot use private jobs.
Each session can start 12 jobs per hour. Each client network address can start 48 jobs per hour.
At most 128 sessions exist at once. Sessions expire after one hour. Quota failures include a retry interval.

Accepted work returns HTTP 202 with an opaque job ID, expiry, and polling interval.
Job reads expose the current task and answer count. Cancel aborts the outbound request and stops further local turns.
Cancellation cannot reverse an already transmitted request or a provider charge.
Private jobs expire after at most ten minutes. A service restart or Worker eviction also loses them.
They use transient memory rather than the dictionary object store, indexes, receipt journal, or ordinary logs.

The browser saves a terminal result with its draft, then sends `DELETE` as an acknowledgment.
Until acknowledgment or expiry, the service holds the result in transient memory so a lost response can be read again.
Acknowledgment preserves the terminal state and discards the result and log. It does not cancel a completed action.
The browser keeps the durable log copy. Publication and peer synchronization omit that log.
Raw JSON exports preserve the exchanged payload fields, except server credentials and encrypted reasoning.
The service removes those fields before a response or correction request leaves the inference runner.
The browser limits each API response to 16 MiB and each response wait to 30 seconds. An action expires after 15 minutes in the browser.

The public [prompt guide](../prompts/README.md) describes the four studied tasks and their answer checks.
Source suggestions run once per requested language row. Supported short language codes are `en`, `zh`, `hi`, `es`, `ru`, `ar`, `bn`, `pt`, `fr`, `ms`, `de`, and `ja`.
The preset codes `eng`, `cmn`, `hin`, `spa`, `rus`, `ara`, `ben`, `por`, `fra`, `msa`, `deu`, and `jpn` select the same respective prompts.
Proposals keep each source row's original language code.
English gloss suggestions keep language `en` even when the definition uses another language. Existing glosses in other languages remain present.
Source proposals preserve missing words as empty editable rows. Their notes retain the sense, whole-word IPA, stem, stem IPA, and uncertainty.
The additional prompts cover type, components, selma'o, definition text, and an initial place structure.
To update the runtime prompt bundle after editing a prompt, run `node prompts/build-bundle.mjs`.
The service tests require that the generated bundle matches every public prompt file exactly.

Run the mocked inference checks with `npx tsx --test packages/service/test/assistance.test.ts`.
The adapter suite runs both hosts against a disposable mocked provider and key file.
It tests the disabled state, corrected answer, private session, secret redaction, and log acknowledgment.
Neither test suite reads a real provider key or sends paid inference requests.

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
npm run test:web-unit
```

Playwright loads these files when it lists tests, but it does not run them. Run this command as well as `npm run test:web`.

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
