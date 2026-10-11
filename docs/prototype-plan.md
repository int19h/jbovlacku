# Jbovlacku prototype plan

This plan defines the target prototype stages. The [README](../README.md) describes the implemented scope.
The [format specification](format.md) and [frontend specification](frontend.md) define the intended behavior.

## Scope and location

Implementation work uses isolated worktrees under `/build/jbovlacku/worktrees`.
Temporary inputs and test results use scoped directories under `/build/jbovlacku`.
No prototype uses a real contributor key or changes a Lensisku account.
All test identities and signatures belong to disposable fixtures.
Public hosting, authenticated cross-posting, and live dictionary contributions need separate authorization.
Expressly authorized private GitHub issues and pull requests remain development work.

Each stage produces an executable result, fixture inputs, expected outputs, and a short account of failures and limits.
Record the exact specification hashes with every result. Mark experimental records as disposable rather than promising permanent compatibility.
The command name is `jvc`. Commands in the specifications describe target interfaces. The [README](../README.md) identifies commands available in the prototype.

## Stage 1: Records and signatures

Build the Rust format core, its native command, and its WebAssembly build.
Keep host storage outside this core. Start with parsing, canonical bytes, IDs, headers, bodies, and signatures.
Use the same fixture corpus in the native build and a browser harness.

Required demonstrations:

1. Produce the same canonical bytes and identifiers in both builds.
2. Accept OpenSSH signatures with the prescribed namespace and reject namespace substitution.
3. Reject duplicate JSON keys, malformed encoding, and the specified Ed25519 boundary cases consistently.
4. Retain a signed header when its body is unavailable, without inventing the missing content.
5. Export readable JSONL and recover the same record set from that export.

Do not add a new cryptographic primitive. Record the chosen libraries, versions, licenses, and boundary behavior.
Stop format integration if the two builds disagree. Resolve the profile or implementation before creating dependent fixtures.

## Stage 2: State and handover

Implement the event evaluator against small synthetic histories before adding persistent storage.
The evaluator accepts a record set and an explicit view. Its result does not depend on delivery order.
Use the [handover cases](handover-cases.md) as required fixtures.

Required demonstrations:

1. Preserve independent concurrent submissions and detect contradictory concurrent judgments.
2. Resolve a changed opinion through its causal predecessors.
3. Preserve imported status across an accepted handover.
4. Exclude later actions under a superseded account claim without freezing the successor's status.
5. Resolve included missing history after delivery without changing the handover boundary.
6. Distinguish a source-account replacement from inherited identity continuity.
7. Preserve historical rafsi evidence while excluding words with no active definitions from automatic construction.

Test permutations of delivery, duplicate delivery, restart from the complete record set, and missing dependencies.
Include both cooperative handover and source-account replacement without the old key.
The expected results must distinguish incomplete input from an actual conflict.

## Stage 3: Ranking feasibility

Implement the exact small-graph oracle and the specified bounded calculation independently.
An oracle is a deliberately slow reference calculation.
Use `q=1`, `H=3`, and `alpha=1/2` as the initial reference coefficients.
Compare candidate definitions, not only pairs of actor weights.

Required demonstrations:

1. Contain every oracle score within the corresponding calculated interval.
2. Preserve the fixed own allowance when an identity adds or removes heeds.
3. Prevent influence from returning to its source through proxies.
4. Apply scoped shuns, competing paths, and missing identity history as specified.
5. Measure useful ordering coverage, CPU time, peak memory, and arithmetic growth across stated graph sizes.
6. Repeat the calculation in native and WebAssembly builds.

Include sparse contributor-centered scenarios and dense hostile graphs. Label synthetic trust assumptions explicitly.
Legacy scores and submission counts never become authenticated individual judgments.
Publish measurements before selecting user-facing work budgets. Poor results require a visible calculation-profile change, not an undocumented depth limit.

## Stage 4: Import and storage

Import a small attributed sample, then process the available full source through the same importer.
Preserve original text, numeric authors, source coverage, and version-specific rafsi locations.
Keep inferred place structure separate from authenticated source fields.

Required demonstrations:

1. Repeat a batch without duplicate publications or fabricated edits.
2. Process source reversions and partial API fields without treating absence as deletion.
3. Keep source rights statements and attribution distinct from importer signatures.
4. Merge two JSONL carriers through authenticated set union.
5. Remove a refused body from local advertised storage while retaining permitted signed evidence.
6. Rebuild indexes from records and recover acknowledged submissions after a simulated crash.

Read the SQL export as data. Do not execute it in a service database.
Do not rerun historical document mutation scripts as validators.

## Stage 5: Browser and standalone service

Build one small end-to-end path with the standalone Node.js service and SQLite.
Serve the same browser assets that the Cloudflare adapter will use.
The browser retains encrypted keys, drafts, pending submissions, and known own-history references.
It does not need the complete dictionary history.

Required demonstrations:

1. Search a downloaded language package with no identity and no network request per query.
2. Create a disposable identity, export its encrypted backup, and restore it in a separate browser profile.
3. Draft a definition, preview its structured places, sign it, and retain the signed outbox before upload.
4. Retry after an unknown delivery result without creating another event.
5. Publish to two independent servers and compare their interpreted state after synchronization.
6. Complete a handover from browser-held references and inspect its preserved status.
7. Distinguish stored, indexed, queued, refused, and unavailable states in the interface.

Keep inference disabled for this stage. Include a manual definition path before adding word-generation assistance.
Test browser storage loss separately from network failure. A key backup does not contain unpublished drafts or pending events.

## Stage 6: Cloudflare parity

Add the Workers adapter to the shared service layer. Use R2, D1, and a Durable Object as specified.
Run its local development environment against the same fixtures before any hosted deployment.
Native Git mirroring remains a separate job. HTTP exchange carries the same signed dictionary records.

Required demonstrations:

1. Exchange snapshots between the standalone and Workers adapters.
2. Produce the same logical state from the same records and view.
3. Preserve acknowledged writes through interrupted snapshot builds.
4. Resume bounded import and ranking jobs without changing their interpretation.
5. Run the standalone service without Cloudflare credentials or network dependencies on Cloudflare.
6. Package the standalone service as an OCI image and test a persistent-volume restart with Podman or Docker.

Record platform limits and measured costs. No public deployment is part of prototype preparation.
If a calculation cannot fit Workers, report the measured limit before changing the hosting design.

## Stage 7: Complete the authoring flow

Add the guided wizard, advanced editor, lujvo builder, and gismu generator after the earlier stages pass.
Preserve manual operation for every branch. Include cmavo and permitted fu'ivla components in compound construction.
Test non-top-scoring choices, conflicting assignments, structured etymology, place numbering, and draft preservation across mode changes.

Add semantic search and optional inference through the configured provider interface.
Test reusable embeddings across peers, model-profile mismatch, stale AI responses, cancellation, and explicit draft disclosure.
Use mocked providers first. Real inference requests need an intentional provider configuration and an authorized test scope.
Authenticated Lensisku cross-posting remains optional and needs separate live integration authorization.

## Prototype completion

A successful prototype demonstrates the agreed rules and exposes their measured limits. It does not establish production readiness.
The full release scenarios in both specifications remain requirements for public release.
Do not silently remove planned features to label an earlier stage complete as the whole product.

Public launch still needs these operator decisions:

1. Select contribution terms and the software license.
2. Publish the initial trust roots, account witnesses, and accepted import selections.
3. Select retention, admission, and optional inference policies.

The protocol permits these choices without a format redesign. Prototype fixtures use explicit synthetic substitutes.
Existing Lensisku disclaimer evidence does not silently select CC0 for new Jbovlacku submissions.

## Local tools

The [development guide](development.md) defines local tooling, tests, reviews, and shared VM rules.
Every stage must state its selected dependency versions and runtime requirements.
A tool installation alone does not prove that its runtime works with the prototype.
