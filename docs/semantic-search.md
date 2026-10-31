# Semantic indexing and search

The Node operator command builds a fresh vector index from the dictionary's private semantic records.
A vector represents a definition for later meaning comparisons. A generation binds its associations to one snapshot, view, and profile.
The Node host can search a published generation with partial coverage and a configured query provider.
The target and coverage contracts below define required behavior. The [README](../README.md) states the implemented scope.

The command uses the application recipe from the [format specification](format.md#optional-derived-embeddings).
It never reads historical research vectors. It retains complete profile metadata and each target's authenticated provenance and exact input hash.
A publication retains its event, envelope representation, and body hash. A virtual retains its descriptor and authenticated base envelope and body hash.
Virtuals have no event, envelope, or signed body of their own.
The evaluator decides whether each signed or virtual target is effective, selected, active, and eligible under the requested view.
Equal inputs share one vector under the same profile. They retain separate target associations.

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
Changed publications keep their own event and body associations. Changed virtual targets keep their own descriptor and exact base associations.
New inputs remain pending. A revision never transfers another target's judgments or vector association.
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
It waits at least one, two, then four seconds after each refusal, or longer for the saved `Retry-After` deadline.
The header accepts integer seconds or an HTTP date.
Each wait is limited to 60 seconds. All waits in one run are limited to 120 seconds in total.
If the required delay exceeds either bound, the job remains paused without an early retry.

The store saves the cooldown deadline for the complete profile, capped at one hour from each refusal.
The cap limits faulty provider values. A later refusal can extend the deadline by at most another hour.
Restarts and other generations of that profile respect the saved deadline.
Status exposes this Unix timestamp in milliseconds as `retry_after`.
A deadline in the past needs no further wait.
If a 429 body times out, its header still sets the cooldown, but the timed-out batch needs an explicit retry.

To override a faulty deadline, stop the server for the directory and use `--command clear-cooldown --job GENERATION_ID`.
This clears the deadline for every generation of that profile, including longer deadlines saved by older versions.
The command preserves batches, charges, retry selections, and profile suspensions. It sends no provider request.
See [cooldown recovery](development.md#semantic-index-cooldown-recovery) for the complete command.

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
Publication changes only the derived index pointer. Public queries also require the compatible profile and host configuration described below.
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
Query vectors use a separate allocation of at most 2,048 entries and 32 MiB of vector bytes.
Node scans at most 128 associations per page. One extra row determines whether another page remains.

## Enable Node meaning search

Set `JVC_SEMANTIC_PROFILE` to the complete profile hash from the indexing status.
Keep the existing AI configuration and key-file path. Restart the server with its indexed data directory.
The server reads `semantic-vectors.sqlite` beside its dictionary and spending databases.
No key reaches the browser. The browser never receives query or document vectors.

The selected generation must match the requested view and complete profile.
Every target passes the format's single [semantic target admission](format.md#semantic-target-admission) procedure in the requested snapshot and language.
A publication matches its event, envelope representation, authenticated body, word, language, semantic extraction version, and recomputed recipe input.
A virtual matches its descriptor, authenticated base envelope and body, canonical converted word, language, semantic extraction version, and recomputed recipe input.
Both kinds need an exact compatible vector association. A virtual never needs an envelope or signed body of its own.

The semantic extraction version is the core's `SEMANTIC_PROJECTION_VERSION`, currently integer `4`. It is separate from the Lensisku import string `legacy.extraction`.
Shared index entries carry it as `extraction_version`. Receivers select their own snapshot and view and derive language from authenticated content.

Trusted semantic projections retain these authenticated bindings, so scans do not reread original definition bodies.
Unchanged targets remain searchable after other events change the snapshot. New targets remain pending until their vectors exist.

Missing or mismatched associations count as pending and cannot enter the results.
An extraction-version change can make an association stale even when its snapshot stays unchanged.
Failed coverage requires matching current associations and follows the format's [SemanticCoverage](format.md#semantic-coverage) rules.
A failed entry does not disable unrelated indexed definitions.

The profile must remain compatible. A context with no indexed targets returns empty hits and its full `SemanticCoverage`, without paid inference.

Set `JVC_SEMANTIC_INDEXING=enabled` to index new definitions and rebuild stale associations while the server runs.
The server checks the latest completed snapshot every five seconds after each cycle ends.
It uses its existing directory lock and AssistanceService, including the same execution slots, spending ledger, and limits.

The operator must first publish a completed generation for the selected profile and view.
The server does not adopt unfinished operator jobs, which can contain failed or ambiguous sends.

The background job stages bounded pages, publishes partial coverage, and embeds one batch at a time.
Before embedding missing document vectors, it probes the retained profile.
Existing exact input hashes reuse retained vectors. Other inputs receive fresh vectors.

An extraction change starts a new generation when current coverage contains stale associations, including within the same snapshot.
The preceding generation serves its still-valid hits until the new generation finishes preparation and publishes.
If extraction preserves the exact input bytes, the new associations reuse stored vectors without another embedding call.
The server does not create a new generation when all eligible targets have matching current bindings and admitted vectors.
When every valid input has a stored vector, `input_limit` errors trigger no provider probe and keep their failed counts.

Completed background generations leave storage when no current, rollback, active background pointer, or in-flight search retains them.
A search retains its generation through inference, scanning, and final retention checks. Cancellation releases it after the worker stops reading.
Profile coverage reads also retain their generation until their shared calculation finishes.

Retirement marks an unreferenced generation as retired before it deletes rows.
Each transaction deletes at most 128 associations or batch-input links.
It yields between transactions. New readers and publication cannot select that generation.
Each transaction removes only inputs and vectors without a remaining association. It updates storage counts in the same transaction.

An interrupted retirement keeps its cleanup marker. A later background prune or explicit retirement continues that cleanup.
Operator-created generations remain under explicit operator control. The existing capacity limits still apply.

To remove a completed background generation, stop the server that holds its data directory lock.
Set `JVC_DATA_DIR` to that directory and `JVC_INDEX_JOB` to the exact generation ID.
Run these commands from the repository root:

```sh
npx tsx apps/server/src/semantic-cli.ts --data "$JVC_DATA_DIR" --command unpublish --job "$JVC_INDEX_JOB"
npx tsx apps/server/src/semantic-cli.ts --data "$JVC_DATA_DIR" --command retire --job "$JVC_INDEX_JOB"
```

Retirement releases that generation's idle background pointer in the same transaction that marks it retired.
A suspended profile uses the same procedure. Retirement preserves its suspension and retained accounting evidence.
Active readers, running jobs, prepared or sent batches, and unsettled provider transports still block retirement.
If another current or rollback reference retains the generation, remove that exact reference before retirement.
A released pointer cannot resume or publish the retired generation. No command sends a provider request.

A durable background pointer retains unfinished work across failures and restarts.
The background server retries this work automatically. The operator CLI keeps its manual recovery and retry policy.
A known refusal before dispatch creates no provider charge. Busy slots and temporary refusals receive exponential backoff from one second to one minute.
A probe with an operation ID, or an unknown dispatch outcome, counts as a sent attempt.
Each sent probe retains its own charge, even when it fails before the indexing batch starts.
The server waits for saved provider cooldowns and hourly or daily budget windows. It never raises a spending cap.
Provider hints keep the existing one-hour cooldown cap. Budget-window hints retain their full delay, including a daily window.

An unknown send receives at most three automatic retries in one recovery round.
Each indexing retry creates a linked batch and a new shared-budget operation. Earlier batches and conservative charges remain intact.
The delays are one, two, and four seconds, or longer when a provider or budget deadline requires it.
A completed vector never enters another paid indexing batch. A retry waits until its earlier transport and settlement finish.

After four sent failures, the server splits a batch into individual inputs. Each input then has its own bounded retry round.
After that round fails, the server parks the input for one hour. Healthy inputs continue while it waits.
A request that exceeds an empty spending limit splits immediately. An individual input that still exceeds that limit waits one hour.

Parked inputs retain their exact profile, input hash, prior batch, failure count, and deadline across restarts and newer snapshots.
New generations reuse these holds. They do not send parked inputs early or replay completed vectors.
A finished pass can retain failed coverage and advance to a newer snapshot.
Due inputs return automatically even when the snapshot does not change. Inputs absent from the current generation do not dispatch.
An unsettled earlier transport does not wake a finished pass. Other ready inputs and newer snapshots can still proceed.

Sent probe failures pause the job with `background_retry_exhausted` after four attempts and wait one hour.
The sent failure count and cooldown survive server restarts, including restarts before the fourth failure.
Only an expired cooldown opens a new probe recovery round. Unrelated input holds keep their own deadlines.

Node writes `semantic_index_status` messages when the recovery state changes, even when `JVC_LOG_ERRORS` is disabled.
These messages omit provider response text. Repeated identical refusals do not write another status line.
A restart never shortens a probe recovery cooldown, parked input deadline, provider cooldown, or budget window.

Generation status includes `background_recovery` while the background job waits.
It names `next_attempt`, `not_before`, `sent_attempts`, `refusals`, `exhausted`, and `reason`.
Operator status also exposes the count and earliest deadline of retained input holds in `background_inputs`.
This diagnostic reads at most 128 holds before yielding. Ordinary generation and public profile reads omit this scan.
Times are Unix milliseconds. `not_before` preserves provider and budget deadlines separately from the recovery cooldown.

The five-second host schedule starts eligible attempts. Healthy work continues through consecutive batches without that delay.
A successful vector clears its input hold in the same transaction. Unrelated successes do not reset another input's retry count.
A suspended profile still requires a compatible replacement profile.

Fully staged jobs recover from retained inputs without reading their old source snapshot again.
Storage exhaustion, invalid provider configuration, and an expired source snapshot during unfinished preparation receive a one-hour cooldown.
A refusal before job creation retains its deadline and log state under the profile and view.
An unpublished preparation with no dispatched batch can move to a newer source snapshot after expiry.
Automatic recovery cannot repair invalid provider configuration or create missing storage capacity.

Shutdown stops scheduling and new claims, then drains admitted transports before closing storage and releasing the directory lock.
A stop after a claim and before dispatch retains that unsent batch as failed and pauses the job with `index_paused`.
The next server start recovers that background job, including a stop during a rate-limit wait.
Operator jobs still require their existing explicit recovery and retry commands.

Cold coverage reads at most 128 metadata bindings before yielding to the main event loop.
Requests for the same exact evaluation and generation share one coverage calculation.
Settled coverage stays cached until association or batch progress changes, or the profile gains or loses a vector.
Failure, recovery, and retry selection invalidate that cache. A vector completed by another generation also invalidates it.
If progress changes during a shared calculation, the next request after completion refreshes its counts.
Coverage reads use bounded pages and do not claim an atomic snapshot across those pages.
A failure on this optional path makes capabilities report meaning search as unavailable. Other capabilities remain present.

`GET /api/v1/embedding-profiles` returns exactly one `profiles` array.
Each entry contains `id`, `label`, `query_available`, `coverage`, and `limitations`, under the [frontend API contract](frontend.md#optional-service-api).
Coverage uses the format's [SemanticCoverage](format.md#semantic-coverage) object for both profile entries and search responses.
Optional `snapshot`, `view`, and `language` parameters select the coverage context.
Without those parameters, the request uses the latest completed snapshot, configured view, and all languages.
An absent current generation returns an empty array.
Coverage counts exact current target bindings, even when the generation began under an older snapshot.

Its `signed` and `virtual` objects each contain `indexed`, `eligible`, `pending`, and `failed` counts.
Each target counts once, even when aliases share it or several targets share vector bytes.
For each kind, `eligible = indexed + pending + failed` under the format's definitions.
`undetermined_bases` counts selected bases whose unavailable content, unresolved status, or missing evidence prevents determination of eligible virtual targets.
Known deprecated or unselected bases do not enter these counts. A known null frame determines zero virtual targets.
Unavailable vectors for known eligible targets count as pending work or failed attempts. Indeterminate virtual target sets count through `undetermined_bases` instead.

`POST /api/v1/search/semantic` accepts these JSON fields:

```json
{
  "query": "x1 buys x2 from x3",
  "language": "en",
  "snapshot": "sha256:SNAPSHOT_HASH",
  "view": "jve1:VIEW_HASH",
  "profile": "sha256:PROFILE_HASH",
  "limit": 30
}
```

Replace each placeholder with its complete lowercase hash.
Language tags use lowercase BCP 47 syntax and at most 63 bytes, without a registry membership test.
Malformed tags return HTTP 400 before inference. Every successful response keeps the required coverage fields.
The API accepts limits from 1 through 100. Its general query limit is 16 KiB.
This profile has a tighter limit of 4,096 UTF-8 bytes, including its exact query prefix. Oversized inputs fail before payment.
The server rejects malformed Unicode and does not normalize, trim, or silently truncate the query.
Query fields belong in the JSON body, not the URL.

The response names its snapshot, view, profile, and exact query input hash.
Each hit contains exactly `target`, `event`, `virtual`, `base_body`, `word`, `distance`, and `position`.
For a publication, `target` equals its event ID. Its `event` is that ID, and `virtual` and `base_body` are null.
For a virtual, `target` is its `jvv1:` ID, `virtual` is its descriptor, and `base_body` is its authenticated base body hash.
Its `event` is null. Word is the canonical candidate's word ID, distance is a finite cosine distance, and position starts at one.
Equal distances use full target-ID order across both kinds. Several definitions of one word can appear in the public results.
Coverage is the same `SemanticCoverage` object for the selected language. Its target admission and count rules match the profile response.
Distance measures related meaning. It is not a dictionary score, endorsement, or calibrated probability.

The scanner uses the same effective, selected, active candidates as ordinary lexical search without retired results.
Known deprecated virtuals remain available through retired lexical results and exact links, but never enter semantic hits or semantic eligibility counts.
It runs in at most two reusable Node workers. Each worker has a bounded SQLite page cache and keeps at most 100 best hits.
Each client network can hold at most one scan worker, including after cancellation until that worker acknowledges completion.
Requests with an empty or absent network share one client identity and the same limit.
Another scan from that network returns `semantic_busy` before it can take the second worker.
A third client also receives `semantic_busy` while both workers are busy. There is no unbounded scan queue.
Neither the scanner nor a query cache hit reads original definition bodies.
Expiry during inference or scanning returns `snapshot_expired`, without exposing a result from a different snapshot.

## Query cache, probes, and cancellation

The query cache stores only the full profile hash, exact prefixed input hash, vector bytes, and last-use time.
It stores no query text, definition body, or cross-snapshot search result.
Least recently used entries leave when the entry or byte limit is reached. Ties use profile and input hash order.
Every search applies its requested dictionary context, including when another snapshot computed the cached query vector.

Concurrent misses for one profile and input share one computation.
At most sixteen distinct computations wait at once. Provider work uses the existing shared execution and spending limits.
A cache hit creates no provider request or reservation, including when paid work has exhausted its budget.
The first caller's network owns a shared query computation. Later waiters do not incur another charge.
Cache timing can reveal that someone recently used the same public-dictionary query.

Before the first new query computation after restart, the server recomputes up to two public document reference inputs.
It repeats this probe before a new computation when the last successful probe is at least one hour old.
Cache hits do not trigger paid probes. They still consult the durable profile suspension state before returning results.
The probe compares current vectors with retained vectors under a fixed cosine-distance tolerance of 0.0005.
Independent public reference tests found ordinary same-provider differences up to about 0.0002, including repeated identical batches.
This tolerance allows that numerical variation. It is not fitted to dictionary search targets and does not adapt after failures.
The operator status command reports the latest probe's operation, model, input hashes, distances, time, and tolerance.
It stores no query text or provider key.
Confirmed drift or an unexpected model name suspends the profile, including its cached queries.
The hosted revision remains unknown. A passing sample cannot prove that every input remains compatible or that the alias never changes.
Financial refusals and transient provider failures do not suspend a compatible profile.

New query computations respect the saved provider cooldown. They never automatically retry a failed provider request.
Cancellation ends one caller's wait and stops its vector scan.
An admitted shared embedding computation continues to settle and can fill the cache after all callers leave.
Shutdown waits for those computations and actual provider transports before closing stores and releasing the data-directory lock.
An expired or canceled search does not refund an already sent request or start a replacement.

The browser meaning mode and AI dictionary tools are separate features.
Downloaded document vectors alone do not provide offline meaning search. Derived-vector exchange remains unavailable.
