This importer prepares signed proposals from pinned local Lensisku JSON captures and SQL snapshots. A proposal contains literal definitions, an import selection, and a view. An import selection lists the exact publications that the view accepts.

## REST captures

The current extraction supports the audited definitions-list endpoint and English language ID 2. The two-row fixture comes from the pinned 2,429-row capture. Its provenance file names the full capture digest and explains the derived sample.

The importer signs the extraction with the supplied disposable key. Numeric author evidence comes from an explicit `user_id` field or the audited endpoint's numeric `user_id` filter. A username alone does not establish account authorship.

Original strings and source number tokens remain in `legacy.original`. Source fields with endpoint placeholders remain unknown in the lexical digest. This recipe marks `official_rafsi`, `experimental_rafsi`, `rafsi`, `gloss_keywords`, and `place_keywords` unavailable in the pinned listing.

Text remains literal rich text with a null frame. The importer does not infer place structure, place keyword indices, or individual votes. It preserves rafsi fields at their source locations without publishing automatic rafsi claims.

Known rafsi fields split on ASCII whitespace. Non-ASCII whitespace stays inside its original token and receives a review notice. Manifest-unavailable fields supply no known lexical value.

A missing, null, or manifest-unavailable `type_name` leaves the row unresolved. The importer preserves its exact source and prior selection until the type is known. A present unsupported type maps to `other` with an explicit source limitation.

This extraction records classification as one atomic lexical field. It also requires an explicitly fetched `selmaho` field with a string or null value. Missing or manifest-unavailable `selmaho` leaves the row unresolved until that classification evidence is complete.

Rights remain unknown because the capture contains no rights statement. An importer signature does not grant permission to distribute the text. The local proposal does not establish public contribution terms.

Run the tests from the checkout root:

```sh
npx tsx --test packages/importer/test/*.test.ts
```

The tests use the operating system's temporary directory by default. Set `JVC_TEST_ROOT` to choose another test directory. Each test run removes the temporary directories that it creates.

Create an external file that contains a disposable seed as 64 lowercase hexadecimal digits. Create a roots file that contains the operator's explicit array of identity allocations, or `[]`. Keep the seed outside the output directory.

The manifest names `source`, `url`, `retrieved_at`, `sha256`, `extraction`, `recipe`, and `unavailable_fields`. Use `extraction: "lensisku-list-literal-v1"` and `recipe: "lensisku-definitions-list-v1"`. The optional `expected_rows` field makes the row count mandatory.

For this local example, put the disposable seed and roots files in `.cache/import-input`.
The output goes into a separate directory. These paths are examples, not capture provenance.
Run the importer from the checkout root with the source file, manifest, seed, roots, and output paths:

```sh
npx tsx packages/importer/src/cli.ts \
  --source packages/importer/fixtures/lensisku-sample.json \
  --manifest packages/importer/fixtures/lensisku-sample.manifest.json \
  --seed .cache/import-input/disposable-seed.hex \
  --roots .cache/import-input/roots.json \
  --output .cache/import-sample \
  --sign
```

The output includes `carriers.jsonl`, `import-selection.json`, `selected-view.json`, `proposal.json`, and `journal.sqlite`. The source archive keeps the exact bytes and manifest by digest. The carrier contains all retained publication envelopes and their bodies.

The journal is the local record of imported source versions. A repeat run reuses its original signed envelopes and view. Keep the journal with the proposal when you resume an import.

The command saves and flushes the exact source before it commits the SQLite journal. It commits the journal before it writes dependent output files. A repeat run can rebuild incomplete output files from the committed journal.

Existing source files remain immutable at their hash paths. The command refuses conflicting archive bytes. Protocol configuration and journal files use the core JSON parser, which rejects duplicate keys and unsafe numbers.

Changed known lexical fields create revisions with valid parent links. Source reversions reuse an earlier matching publication. Missing fields and absent rows never erase prior evidence or prove source deletion.

A unique exact lexical digest takes priority over poorer compatible historical versions. Without an exact match, a poorer capture can match prior publications through jointly known fields. The importer requires no known field conflicts and exactly one matching prior revision.

The importer retains the chosen prior revision's richer field evidence. Different coverage does not establish that omitted fields stayed unchanged. The archived observation preserves the poorer capture as separate evidence.

If multiple prior revisions match, the report marks the reversion unresolved. The current selection and richer evidence remain unchanged. This result does not assert which historical revision the partial capture represents.

Problem rows remain in the exact source archive. The report marks the proposal incomplete and names each unresolved row's source ID, source position, and reason. Valid rows continue through the same batch.

Exit status 0 means that the command saved a proposal. The proposal can still contain unresolved rows.
Before you submit a proposal, read the `incomplete` field and unresolved rows in the JSON output.
Automated callers must inspect this output instead of using exit status alone.

Identical duplicate source rows count once. Conflicting duplicate IDs receive explicit conflict notices and produce no new publication for that ID. Existing selections remain unchanged for conflicted or unrepresentable rows.

New field coverage becomes an archived enrichment observation. It does not automatically create a historical author edit. The report records additions, revisions, reused publications, source reversions, enrichment, and absent rows.

The default proposal disables account controls and declares no account witnesses. The supplied roots remain an explicit operator choice. Legacy scores never become influence allocations.

If the journal is missing while prior output remains, the command stops. Rebuild the journal from retained source evidence and envelopes before another import. If a process leaves `.import-lock`, settle that process before you remove the exact lock directory.

A leftover import selection or source archive also requires explicit recovery. This includes an interruption after the source becomes durable but before the journal commits. Archived source alone cannot prove that no prior signed output escaped.

This command does not implement automatic journal reconstruction. Recover the old envelopes and journal before you resume. Choosing a new output directory is an operator decision with possible duplicate-publication risk when old envelopes cannot be recovered.

The REST command requires a complete local capture instead of fetching live pages. It does not claim that absent rows represent authenticated deletions.

## SQL snapshots

The SQL command streams PostgreSQL COPY blocks and joins source rows through a temporary SQLite database.
It reads the dump as data. It never executes SQL from the dump.
The extraction uses the source language table and retains separate tags such as `en`, `en-simple`, and `en-bpfk`.
Wiki pages, phrases, and nonwords remain outside the lexical import.
Unrepresentable rows remain in the source archive with unresolved notices.

The SQL and REST source origin is `https://lensisku.lojban.org`.
Use the same output directory and importer key for both extraction commands.
Both commands share one `journal.sqlite`, keyed by the source origin and numeric definition ID.
Their extraction identifiers remain distinct. A snapshot type does not create a second source identity.
Numeric account evidence uses that same origin.
Each imported body retains authored source fields, available version rows, keyword indices, dates, and separate word-level and definition-level rafsi.
Derived vectors and caches remain only in the source archive. Each body records their omission in its legacy limitations.
Literal text receives no inferred place frame. Rafsi evidence creates no automatic rafsi claims.

The sanitized SQL dump contains no aggregate definition scores or individual votes.
Keyword-placement scores remain separate source evidence.
An importer signature establishes neither historical authorship nor rights to distribute source content.
Rights remain unknown under this extraction.

The SQL command accepts the pinned archive TOML manifest or an extraction manifest in JSON.
It compares the source digest and byte length before extraction.
The source archive retains the original manifest and a reference to the exact external dump.
Keep the external dump available at that path. The proposal does not contain a copy of its source bytes.
Use a distinct immutable file for each later SQL snapshot.
The command refuses a new digest at a path that an earlier archive reference uses.

Use an external disposable seed and an explicit roots file, as for the REST command.
From the repository root, run the SQL command with your local input paths:

```sh
npx tsx packages/importer/src/sql-cli.ts \
  --source /path/to/lensisku-public-data.sanitized-v3.sql \
  --manifest /path/to/lensisku-public-data.manifest.toml \
  --seed .cache/import-input/disposable-seed.hex \
  --roots .cache/import-input/roots.json \
  --output .cache/import-sql \
  --sign
```

The output includes `carriers.jsonl`, `import-selection.json`, `selected-view.json`, `proposal.json`, and `journal.sqlite`.
Keep the journal with the proposal. Repeat imports reuse the retained envelopes.
The JSON report names unresolved rows and groups them by reason.
Read its `incomplete` field before loading the proposal. A saved proposal can contain unresolved source rows.
Malformed related rows leave affected definitions unresolved and preserve their prior selections.
If a damaged row has no readable owner, the importer treats its dependent table as incomplete.
The estimate before signing includes staging, the proposal, the journal, and a loaded service copy.
The SQL command stops when that estimate exceeds 3,000,000,000 bytes.

Both commands append a run record and retain separate observations for source reversions.
The REST adapter reads the shared journal into memory, as its earlier JSON implementation did.
The SQL extraction continues to stream carriers and use disk storage for joins.

An existing canonical REST `journal.json` migrates on its next successful REST import.
The command commits `journal.sqlite`, then renames the old file to `journal.json.migrated`.
If both active journal files remain after a crash, recover their exact state before another import.
The commands refuse two active journals. They never choose one by date.
An old SQL journal with the separate `/source/sql-snapshot` namespace requires explicit recovery.
Signed bodies retain their original source identity and cannot migrate through a source-name rewrite.

## Load a signed proposal

The offline loader admits an existing signed proposal into a Node data directory.
It requires no signing key. It authenticates the carriers and retains their exact signed meaning.
It admits the selection and selected view together, then saves that view for Node startup.
Repeat loads reuse accepted event positions and objects.

Stop the Node server that uses the target directory before loading it.
The server and loader hold the same exclusive `.node-data-lock`.
If a process leaves a stale lock, settle that process before removing its exact lock directory.
Do not remove a lock for a live server or loader.

From the repository root, run the loader with your proposal and target paths:

```sh
npx tsx packages/importer/src/load-cli.ts \
  --proposal .cache/import-sql \
  --data .cache/node \
  --state-traversal-limit 1000000000
JVC_DATA_DIR="$PWD/.cache/node" npm run start
```

The explicit traversal limit raises the core's state work budget for this local data directory.
It does not change signatures, causal order, ranking rules, or other core limits.
Large imports also need enough memory. A higher work budget does not guarantee successful evaluation.
The loader saves this limit in `loaded-view.json` with the selected view and selection.
Without the flag, a new directory retains the core's default limit.
`JVC_VIEW` overrides the saved view. `JVC_STATE_TRAVERSAL_LIMIT` overrides the saved traversal limit.

The loader requires exclusive local access. It is not an online import endpoint or a Worker deployment command.
Source account management, cross-post marker reconciliation, and inferred place conversion remain outside this importer.
