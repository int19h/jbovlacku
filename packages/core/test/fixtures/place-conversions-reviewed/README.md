# Reviewed frames for conversion tests

This fixture contains 30 signed native revisions with 91 reviewed place rows.
Each revision names an exact imported Lensisku definition as its parent.
The fixture preserves that source prose and converts its explicit place variables into integer nodes.
It adds reviewed descriptions, place glosses, and conservative type hints.
It stores no virtual definitions or judgments. The virtual protocol remains an implementation requirement.

The implementing agent compared every place with the source prose after model generation.
The fixture metadata records 12 substantive corrections and the model's reported cost of USD 0.053158.
The `ji'efri` and `plicru` annotations retain uncertainty from their terse source descriptions.
These test annotations do not claim historical author approval or replace a later corpus enrichment.
Native annotations use CC0. Parent references retain the imported text and its separate source-rights statement.
The disposable signer has no authority outside this fixture. The private signing key is not retained.

## Load a disposable copy

Build the core bindings before using the existing importer loader.
From the repository root, select a new local data directory and run:

```sh
node --import tsx packages/importer/src/load-cli.ts \
  --proposal packages/core/test/fixtures/place-conversions-reviewed \
  --data /build/jbovlacku/tests/place-conversion-fixture
```

This admits the 30 native revisions and the separate test view.
A repeat load reuses those exact records. It creates no new signatures.
The test view selects no imports. On an empty database, source-parent links remain unresolved while the native definitions stay readable.

For comparison with imports, use a disposable copy of the named source snapshot.
Admit `carriers.jsonl` through that copy's ordinary event API.
Keep that copy's existing view and import selections. Do not adopt the empty test view for that comparison.
Never load this fixture into a live dictionary service.

`fixture.json` pins each source event, source body, source definition ID, native revision, and generated-file hash.
The two snapshots in that metadata distinguish the imported dictionary snapshot from its original SQL source file.
