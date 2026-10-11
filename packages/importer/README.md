This importer prepares signed proposals from pinned local Lensisku JSON captures. A proposal contains literal definitions, an import selection, and a view. An import selection lists the exact publications that the view accepts.

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

The output includes `carriers.jsonl`, `import-selection.json`, `selected-view.json`, `proposal.json`, and `journal.json`. The source archive keeps the exact bytes and manifest by digest. The carrier contains all retained publication envelopes and their bodies.

The journal is the local record of imported source versions. A repeat run reuses its original signed envelopes and view. Keep the journal with the proposal when you resume an import.

The command saves and flushes the exact source before it commits the journal. It flushes the journal file and its directory before it writes dependent output files. A repeat run can rebuild incomplete output files from the committed journal.

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

This prototype does not implement the general SQL migration, source account management, or cross-post marker reconciliation. It requires a complete local capture instead of fetching live pages. It does not claim that absent rows represent authenticated deletions.
