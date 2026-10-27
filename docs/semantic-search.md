# Semantic indexing

The Node operator command builds a fresh vector index from the dictionary's private semantic records.
A vector represents a definition for later meaning comparisons. A generation binds its associations to one snapshot, view, and profile.
Semantic search routes and query caching remain unavailable. Both hosts keep `semantic_search` disabled.

The command uses the application recipe from the [format specification](format.md#optional-derived-embeddings).
It never reads historical research vectors. It retains complete profile metadata and the original event, envelope, body, and input hashes.
The evaluator decides whether each definition is effective, selected, active, and eligible under the requested view.
Equal inputs share one vector under the same profile. They retain separate publication associations.

## Prepare a local copy

Stop the service for the target data directory before each command.
The command takes the same exclusive directory lock as the server and importer.
Use a stopped dictionary copy or consistent SQLite backups when preparing a separate test directory.
Keep the source dictionary and its services separate from that copy.

Build the core bindings with `npm run build:core` before the first command.
Set `JVC_DATA_DIR` to the copied dictionary directory:

```sh
export JVC_DATA_DIR=/absolute/path/to/dictionary-copy
npx tsx apps/server/src/semantic-cli.ts --data "$JVC_DATA_DIR" --command prepare
```

Preparation reads the selected completed snapshot and its configured view.
It uses `loaded-view.json`, with the same `JVC_VIEW` and `JVC_STATE_TRAVERSAL_LIMIT` overrides as the server.
It reads at most 128 semantic records per page. Missing projections use the existing private backfill path.
Preparation reads no provider key and sends no inference request.

The first JSON line names the generation ID in `generation.id`.
The final line reports its source cursor, preparation state, and coverage.
Save that ID as `JVC_INDEX_JOB` for the remaining commands:

```sh
export JVC_INDEX_JOB=GENERATION_ID
npx tsx apps/server/src/semantic-cli.ts --data "$JVC_DATA_DIR" --command status --job "$JVC_INDEX_JOB"
```

Use `--pages N` to stop preparation after N pages.
Repeat `prepare --job "$JVC_INDEX_JOB"` to resume from its saved source cursor.
An expired source snapshot requires a new generation. The command never substitutes a newer snapshot in the existing job.

## Embed bounded batches

Use the existing [AI configuration](development.md#optional-ai-assistance), including `JVC_AI_ENABLED=enabled` and the server-held `JVC_AI_KEY_FILE`.
The job uses the same spending database and server ceilings as generation and embedding queries.
It uses operator spending identity and consumes no client network allowance.
The provider process reads the configured key. Command output contains no key or definition text.

Start with one bounded batch:

```sh
npx tsx apps/server/src/semantic-cli.ts --data "$JVC_DATA_DIR" --command run --job "$JVC_INDEX_JOB" --max-batches 1 --concurrency 1
```

A batch contains at most eight distinct inputs, with the existing byte and provider limits.
After the bounded pass, repeat `run` without `--max-batches` to index the remaining inputs.
The default concurrency equals the configured shared provider slots, normally two.
Use `--concurrency N` to select fewer slots. The maximum is four and cannot exceed the provider configuration.

Completed inputs never enter another paid batch in that generation.
Fresh claims resume from a saved input position and use an index for selected retries.
A later generation can reuse a retained vector only under the same full profile and exact input hash.
Changed definitions keep their own event and body associations. New inputs remain pending.
An over-limit input retains its association and `input_limit` reason.
It is excluded from embedding and counts in failed coverage.
The generation completes when every other input has a vector, including when every input is excluded.

SIGINT or SIGTERM stops new claims and lets admitted batches settle before shutdown.
The command keeps its directory lock and stores open until every actual provider transport ends.
A provider that ignores abort can keep shutdown waiting after the caller's deadline.
This wait retains the original operation. It sends no replacement request and preserves its conservative charge.
A normal bounded pass remains paused when eligible definitions still lack vectors.
Its `index_incomplete` reason describes that partial coverage. It does not erase progress.
Status lists at most 64 batches and exposes a cursor when more diagnostic rows remain.
Use `status --job GENERATION_ID --after BATCH_ID` to read the next diagnostic page.
Its summary counts completed inputs, retained dispatch intents, reported tokens and cost, and batches with missing usage.
Dispatch intents include interrupted sends whose actual delivery remains uncertain.
Reported totals exclude unknown values. The shared spending ledger keeps those unknown charges separately.
Known usage stays on a failed batch when the returned model or vectors are invalid.
Its reported cost remains part of the index summary and the shared spending ledger.

## Handle provider rate limits

An HTTP 429 response stops new claims and lets active workers settle.
The command permits at most three automatic retry rounds per run.
It waits at least one, two, then four seconds after each refusal, or longer when `Retry-After` requires it.
The header accepts integer seconds or an HTTP date.
Each wait is limited to 60 seconds. All waits in one run are limited to 120 seconds in total.
If the required delay exceeds either bound, the job remains paused without an early retry.

The store saves the cooldown deadline for the complete profile.
Restarts and other generations of that profile respect the saved deadline.
Status exposes this Unix timestamp in milliseconds as `retry_after`.
A deadline in the past needs no further wait.
If a 429 body times out, its header still sets the cooldown, but the timed-out batch needs an explicit retry.

Each automatic retry creates a linked batch and a new shared-budget operation.
Earlier batches and charges remain intact. A spending refusal stops the job.
The `--max-batches` bound includes every attempt across the retry rounds.
SIGINT or SIGTERM cancels a backoff wait and stops further attempts.
Only 429 failures from the current invocation qualify for automatic retry.
Other failures and ambiguous batches from earlier invocations require explicit retry selection.

The command emits a `backoff` JSON event before each wait, with `delay_ms`, `attempt`, and `batches`.
Attempt zero waits for a saved cooldown. Attempts one through three identify retry rounds.
If a retry's inputs already have vectors from another generation, the worker continues to fresh work without another provider call.

## Recover interrupted work

The job saves a batch intent before admission and its operation ID before provider dispatch.
If that operation link cannot reach storage, the adapter sends nothing and releases its unsent reservation.
After a hard interruption, settle the old process and directory lock before recovery:

```sh
npx tsx apps/server/src/semantic-cli.ts --data "$JVC_DATA_DIR" --command recover --job "$JVC_INDEX_JOB"
```

Recovery marks interrupted prepared batches as failed and interrupted sent batches as ambiguous.
An ambiguous batch has no retained usable result. Its provider charge can remain unknown.
The shared ledger retains conservative charges through its normal spending windows.
Recovery and ordinary resume never resend those batches automatically.

Inspect the exact failed or ambiguous batch before requesting another attempt:

```sh
npx tsx apps/server/src/semantic-cli.ts --data "$JVC_DATA_DIR" --command retry --job "$JVC_INDEX_JOB" --batch BATCH_ID
npx tsx apps/server/src/semantic-cli.ts --data "$JVC_DATA_DIR" --command run --job "$JVC_INDEX_JOB"
```

Retry creates a new operation and preserves its predecessor batch and earlier charge.
It requires a paused generation. It cannot replay an older attempt after a newer attempt owns those inputs.
Other provider or storage failures pause the job. Manual dictionary reads and admission use their existing independent paths.
An unexpected returned model or a conflicting vector suspends the complete profile in durable storage.
That suspension also blocks vector pages and publication. It does not follow from a spending refusal or unknown cost.
After repairing the provider, prepare a fresh profile and generation. The command cannot reset a suspended epoch.
If retained vectors leave too little capacity, unpublish the old current generation and retire its unused generations before indexing the replacement.

## Publish and retain generations

Preparation must finish before publication. Publication can expose partial vector coverage under that exact snapshot and view.
The pointer update uses one transaction and retains the previous generation for rollback.
A failed preparation or pointer update leaves the preceding current generation available.

```sh
npx tsx apps/server/src/semantic-cli.ts --data "$JVC_DATA_DIR" --command publish --job "$JVC_INDEX_JOB"
npx tsx apps/server/src/semantic-cli.ts --data "$JVC_DATA_DIR" --command rollback --job "$JVC_INDEX_JOB"
```

Rollback requires the named generation to remain current and a retained rollback generation.
Publication changes only the derived index pointer. It does not enable public semantic routes.
Current generations, rollback generations, and jobs with active batches cannot retire.
Use the exact current generation ID to remove its publication pointer:

```sh
npx tsx apps/server/src/semantic-cli.ts --data "$JVC_DATA_DIR" --command unpublish --job "$JVC_INDEX_JOB"
```

Unpublish removes that current pointer and its rollback reference in one transaction.
It requires the named generation to remain current. A stale generation ID leaves every pointer unchanged.
It works for suspended profiles and preserves unrelated profiles and views.
Vectors and associations remain available until separate retirement. The command does not reset the profile suspension.

After those references end, use `retire --job GENERATION_ID` for each unused generation, including its former rollback generation.
Retirement removes that generation's associations and unreferenced input and vector bytes.
Another current or rollback pointer still protects any generation that it names. Running jobs and active batches also remain protected.

The store permits 300,000 associations and 100,000 vectors by default.
Its separate logical allowance for retained document inputs and vector bytes is 2 GiB.
Each claimed batch reserves its future vector count and bytes before provider admission.
Preparation also respects those reservations, so later staged inputs cannot consume space promised to an active batch.
A capacity refusal pauses the generation with `semantic_capacity` and creates no batch or provider charge.
Completion, failure, and recovery release reservations in the same transaction as their state changes.
The final write also enforces capacity and rolls back every vector if it fails.
Older stores migrate their claim position and active reservations when the command opens them.

SQLite metadata, page overhead, and WAL files need additional physical disk space.
Query vectors require a separate cache in later work.
Node exposes bounded vector pages for that later service. It does not load the complete vector set for one page read.
