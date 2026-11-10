# Browser evaluation measurement

This opt-in harness measures the current personal-calculation entrypoint and evaluation worker against a disposable dictionary copy.
It does not change product code or run through the default browser test suite.
It uses one browser page and one evaluation worker at a time.
The Node server evaluates only the disposable copy and finishes startup before browser measurements start.
Every measured trial starts a fresh Chromium process on a profile seeded by an earlier, closed browser.

## Prepare a disposable copy

Run these commands from the repository root with Node.js 24 and the repository's pinned tools.
Select an unused scratch directory with enough disk space for the copy and outputs.
Replace the angle-bracket placeholders below with paths for your environment.
Set `JVC_BENCH_SOURCE` to a directory that contains the dictionary snapshot.
Keep the running site and its data unchanged.

```sh
export JVC_BENCH_ROOT="<out-dir>"
export JVC_BENCH_SOURCE="<source-snapshot>"
mkdir -p "$JVC_BENCH_ROOT"
cp -a --reflink=auto "$JVC_BENCH_SOURCE" "$JVC_BENCH_ROOT/data"
printf '%s\n' disposable-browser-evaluation-copy > "$JVC_BENCH_ROOT/data/.browser-eval-disposable-copy"
```

If the new copy contains `.node-data-lock`, remove only its copied lock before starting this harness.
Inspect that copied directory first.
The usual lock contains only `owner.json`.
Never remove the source lock or stop its server.

```sh
ls -la "$JVC_BENCH_ROOT/data/.node-data-lock"
rm "$JVC_BENCH_ROOT/data/.node-data-lock/owner.json"
rmdir "$JVC_BENCH_ROOT/data/.node-data-lock"
```

Install the dependencies and pinned tools described in the [development guide](../../docs/development.md).
Set the build and browser paths below for your environment.
Build the normal core and standalone server before measurement.
The harness builds only its measurement page and worker wrapper into scratch space.
The compiled core remains the normal release artifact. Its build metadata records the source revision and Wasm SHA-256. The harness refuses a missing, stale, or dirty-build artifact and records the same binding in its environment file.

```sh
export CARGO_TARGET_DIR="<rust-target-dir>"
export JVC_WASM_BINDGEN="<wasm-bindgen-path>"
export PLAYWRIGHT_BROWSERS_PATH="<playwright-browsers-dir>"
npm run build:core
npm run build:server
```

## Run the measurements

The harness requires the data copy to reside below its output directory.
It also requires the disposable-copy marker shown above.
It refuses an occupied API port before it sends any request there.
It waits for its own child server's listening message before it uses that API.
Both listeners bind to `127.0.0.1`.

Normal completion, handled interruptions, and controlled output failures close the listeners and stop the copied server.
An external SIGKILL or host termination can bypass cleanup.
Graceful shutdown can wait for the copied server without a fixed deadline.
Cancellation during data preparation is deferred until preparation returns.
The default ports are 9250 for the copied service and 9251 for the measurement page.

SIGINT, SIGTERM, and SIGHUP request graceful shutdown with exit status 130, 143, and 129, respectively.
A second signal of any of those types triggers escalation.
An output failure keeps exit status 1 through escalation and does not count as a signal.
Cancellation admits no new trial or numerical operation, including operations whose setup was pending.
The lifecycle registers each limiter before its initial scan and stops all registered limiters before browser or server shutdown.

The second handled termination signal sets a 250 ms exit deadline independent of browser close, server exit, HTTP drain, or CDP completion.
The forced path first disables every limiter and synchronously resumes matching recorded identities.
It then kills the owned copied server through its child handle at the deadline.
Playwright's process-exit hook terminates its owned Chromium process groups.
The documented PID reuse limits also apply to this final resume pass.

Run the small protocol probe first.
The probe records whether Chromium accepts worker CPU throttling and measures a fixed worker loop.
It needs no dictionary server or data copy.

```sh
node --import tsx scripts/browser-eval-baseline/run.mjs \
  --out="$JVC_BENCH_ROOT/probe" --probe
```

The matrix rotates condition order across three repetitions.
Word order rotates the three cohorts, so each cohort supplies the first word once.
Each successful base trial ranks 60 distinct real words, adds one signed local judgment, reloads, and ranks the same words again.
The new judgment uses a fixed, publicly known disposable seed and never leaves the disposable copy.

```sh
/usr/bin/time -v node --expose-gc --max-old-space-size=6144 --import tsx \
  scripts/browser-eval-baseline/run.mjs \
  --out="$JVC_BENCH_ROOT" --data="$JVC_BENCH_ROOT/data" \
  --conditions=cpu1,cpu4,cpu6,mid,phone --repeats=3 --label=matrix
```

Use `--conditions` to select a subset and `--repeats` to select one through ten repetitions.
Use `--product-reload` to run `increment-actors` and then `increment-advance`. This is the personal-view sequence after a delivered judgment. The two operation records contain the request bytes and worker time for each step.
This mode also seeds a fresh product `LocalStore` with the exact diagnostic input, loads `PersonalCalculator` without a network request, inserts the same judgment at its sorted inventory position, and runs `PersonalCalculator.ensure()` again. The reload must reach the new snapshot. This isolates the calculator's reload logic from download and server-materialization time and leaves the data copy unchanged. The product server is not started in this mode.
The `product-reload` operation records total calculator time, worker request bytes, Wasm capacity, and session statistics. Sixty `product-rank` operations then rank through that calculator before `product-finish` closes it.
Use `--delta-reload` to reuse the base actor map and advance the loaded session with only the new local judgment. This diagnostic skips `increment-actors` and matches the site-view reload path. The default retains the full `increment-actors` and `increment-load` sequence. Both advance modes insert the judgment at its sorted inventory position and use the calculator's ordered-subset selection.
The diagnostic advance does not apply the calculator's view, overlay, mode, import-selection, or earlier-body guards. Its measurement therefore applies only when those inputs remain unchanged, as in this judgment trial. The separate `product-reload` operation applies all product guards through the calculator.
Use `--verify-full-reload` to add a full `oracle-load` of the same appended input and 60 `oracle-rank` operations. Rank records contain the complete core result. An external comparison can make sure that the incremental and full results are identical byte for byte.
Use `--api-port` and `--port` to select other unused local ports.
Use `--timeout-ms` to change the per-operation timeout, whose default is 600,000 ms.
A timeout, resource refusal, renderer crash, or memory stop remains a measured failure.
Such outcomes never become zero latency or a successful load.
The process exit status describes harness completion, rather than workload availability.

Run a separate profiling trial to avoid mixing profiler overhead into the primary distributions.
`--stress-only` adds 16 disposable reviewers, 320 judgments on 20 common real words, and 16 trust rules.
That separate session still uses the copied view's exact profile.
It has no incremental-submission phase.
This option does not assert that the source snapshot contains those judgments.

```sh
/usr/bin/time -v node --expose-gc --max-old-space-size=6144 --import tsx \
  scripts/browser-eval-baseline/run.mjs \
  --out="$JVC_BENCH_ROOT" --data="$JVC_BENCH_ROOT/data" \
  --conditions=cpu1 --repeats=1 --profile --label=profile-real

node --expose-gc --max-old-space-size=6144 --import tsx \
  scripts/browser-eval-baseline/run.mjs \
  --out="$JVC_BENCH_ROOT" --data="$JVC_BENCH_ROOT/data" \
  --conditions=cpu1 --repeats=1 --profile --stress-only --label=profile-synthetic
```

## Boundaries and constraints

The product measurement calls `PersonalCalculator.ensure` from a blank measurement page.
Its product worker uses the normal request protocol and a read-only measurement getter. It is separate from the diagnostic worker wrapper.
Use `--product-reload --product-only` to measure only the first product load, one signed local judgment, the incremental reload, and product rankings.
Before that first load, a separate setup worker seeds IndexedDB in a persistent browser profile and terminates. That browser closes, then a new browser opens the same profile for the measured load. Seeding processes and their residue are outside the measured browser. The new page core initializes during calculator setup, for the overlay digest and later signing. The PSS watchdog pauses only during this setup and resumes before the calculator starts.
The reload inventory is computed outside the browser from the deterministic signed envelope. The browser stores that small inventory and calls the real calculator again.

It retains the normal inventory, byte, and evaluation limits.
The page does not render the dictionary application or measure paint, search, layout, or accessibility.
The diagnostic retains only the last complete ranking response, rather than the application's whole word-result cache.
Its bootstrap bundle differs from the application bundle.
A product refusal can prevent any evaluation worker from starting.

The full-input diagnostic bypasses the browser download gate and IndexedDB authentication stage.
It transfers raw envelopes, bodies, and selected import identifiers in one uncompressed JSON response.
The existing worker still authenticates the records through the normal shared core.
It runs the production continuity pass and personal-session load.
It uses the copied server's traversal limit, separately from the product browser's default limit.
Its transfer bytes and load time do not represent the paginated production records protocol.

The worker wrapper adds outer timestamps, Wasm capacity readings, and a read-only session getter.
It does not change evaluation, ancestry, signature, or ranking algorithms.
Memory reads use the [CDP Runtime API](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/).
CPU profiles use the [CDP Profiler API](https://chromedevtools.github.io/devtools-protocol/tot/Profiler/).
The environment file records the compiled core and wrapper hashes.

Chromium's [CPU emulation command](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/) does not necessarily apply to dedicated workers.
The probe records the actual command result and calibration time.

The product-gate phase uses the requested page rate of 1, 4, or 6.
The worker diagnostic clears page throttling and applies a separate Linux renderer duty cycle for the slower conditions.
The limiter runs renderers for 10 ms, then stops them for 30 or 50 ms.
It checks process identity before each signal and resumes owned processes during cleanup.
It also refreshes renderer identities after the worker starts.

PID means a numeric process identifier that Linux can reuse after exit.
Start-time comparisons reduce stale-PID risk but cannot guarantee that every signal reaches a renderer launched by this run.
A renderer can exit and its PID can change owners between the start-time comparison and the signal.
PID reuse between the CDP process list and identity capture can also associate an unrelated process with this run.
In these rare cases, an unrelated process can receive `SIGSTOP` or `SIGCONT`.

An unrelated process can remain stopped after a misdirected `SIGSTOP`, even after the harness ends.
After an interrupted run, inspect stopped processes and establish each affected process's identity before any manual signal.
Do not broadly resume every stopped process on the machine.
The safeguard is not a security boundary.

The duty cycle constrains average CPU availability, rather than instruction speed.
Short operations can finish inside one active burst at full speed.
It does not reproduce a phone processor, thermal throttling, memory bandwidth, or operating-system scheduling.
Calibration times remain observations, rather than a promise of exact 4x or 6x latency.
A worker-only probe of that limiter uses `--probe --worker-limit`.

The `mid` condition combines nominal 4x diagnostic CPU restriction with 512 MiB of V8 old space and a 1,536 MiB browser PSS budget.
The `phone` condition combines nominal 6x restriction with 256 MiB of V8 old space and a 1,024 MiB PSS budget.
V8's old-space flag is not a total JavaScript or Wasm memory cap.
Wasm memory and other backing stores can exceed it.
The browser PSS watchdog samples all processes in this Chromium instance every 500 ms and closes that instance after an overrun.

PSS means proportional set size, which divides shared resident pages among processes.
The watchdog is a sampled stop rule, rather than a kernel allocation limit.
It can miss short peaks and overshoot its budget before it stops the browser.
It excludes the Node server, the harness, the operating system, and other applications.

Heavy runs need enough RAM for Chromium, the Node server, and the harness.
The baseline measured a peak browser PSS of 7,938,784,256 bytes, or about 7.39 GiB.
Allow extra RAM for the server, harness, operating system, and other applications.
No physical phone or calibrated mobile hardware is used.

## Samples, output, and interpretation

The sample contains 20 manually selected common words, 20 words with the most retained judgment events, and 20 long-tail words.
When the snapshot contains no judgments, the middle cohort instead contains words with the most active definitions and receives an explicit fallback label.
The common cohort is a manual list, rather than a measured frequency ranking.
The long-tail cohort uses low judgment counts and a stable identifier order, rather than search-usage statistics.
All cohorts require active eligible publications with effective receipts in the copied checkpoint.

Fresh and cached samples must contain 60 distinct words, with 20 in each cohort, before trials start.
Cache reuse compares the input file's byte count and streaming hash with the recorded values before any trial.
Keep the input file unchanged throughout the run.

The output includes a pinned dataset description, source input hash, per-word records, condition summaries, and environment information.
Each label gets separate NDJSON, summary, and environment files.
Successful rankings include worker computation time, parent round-trip time, JavaScript heap metrics, Wasm capacity, and the latest browser PSS sample.
The summary uses nearest-rank percentiles and records the number of observations.
Failed operations remain separate from successful latency distributions.

`trial-complete` and `completed_trials` mean that trial flow finished, rather than that every word succeeded.
Inspect `operation_errors` and each distribution's `n` before treating a trial as fully successful.
An ordinary complete base trial needs 60 successful word observations in each ranking phase.
Worker distributions use only finite worker timings and count missing timings in `missing_worker_timings`.
Parent round-trip timings remain separate in the raw operation records.
`request_bytes` is the UTF-8 size of the JSON representation of a diagnostic worker request, including its message fields and record strings. Product records use `worker_bytes`, which counts JSON representations in both directions. These metrics measure protocol payloads, not the browser's internal structured-clone encoding.

Heap metrics describe each V8 isolate at the query time.
Wasm capacity is `memory.buffer.byteLength`, including reusable allocator space and its high-water growth.
It is not a live allocation count and does not shrink when the session frees buffers.
Backing-store metrics overlap with Wasm capacity and must not be added to it.
PSS values are sampled process measurements, whose age accompanies each word record.
The post-ranking GC probe is separate from the normal per-word samples.

Network sizes describe completed requests, including response headers and bodies.
An aborted transfer can leave uncounted partial bytes.
The cold-failure measurements must state whether the worker ever became available.
The diagnostic-ready record includes input transfer, worker construction, both evaluation passes, and diagnostic control overhead.
It is not application time to usable interaction.

CPU time from CDP covers this Chromium instance, with coarse operating-system resolution for short words.
`time -v` also records the harness and its child processes, including server startup.
Profiles remain separate from primary measurements.

Profile categories use visible sampled call stacks and cannot recover every inlined ancestry operation.
The ancestry bucket describes matched graph-cache stacks, rather than all ancestry work.
The ancestry model gives only identifier-vector payload bounds for complete, same-issuer single-parent histories.
It excludes map, node, string, allocator, capacity-slack, and transient-copy costs.

The helper tests cover percentile handling, profile categorization, ancestry-model preconditions, and cleanup of stopped processes.
They also cover repeat-safe server shutdown and sample admission for fresh and cached datasets.
Lifecycle tests cover late limiter setup, pending stop ticks, repeated and mixed signals, SIGHUP, and cancelled operation admission.
They also cover cancelled server startup, cleanup rejection, and cancellation of pending worker requests.
Run them with the command below.

```sh
node --test scripts/browser-eval-baseline/*.test.mjs
```
