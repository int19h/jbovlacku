import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash, initializeCore } from "../../core/src/index.ts";
import { importSqlSnapshot, SQL_EXTRACTION, SQL_SOURCE } from "../src/sql.ts";
import { readJournal } from "../src/storage.ts";

const directories: string[] = [];
const seed = new Uint8Array(32).fill(127);
before(async () => {
  await initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  );
});
after(async () => {
  for (const directory of directories)
    await rm(directory, { recursive: true, force: true });
});

function table(
  name: string,
  columns: string[],
  rows: (string | number | null)[][],
): string {
  return `COPY public.${name} (${columns.join(", ")}) FROM stdin;\n${rows
    .map((row) =>
      row.map((value) => (value === null ? "\\N" : String(value))).join("\t"),
    )
    .join("\n")}${rows.length ? "\n" : ""}\\.\n`;
}

// These synthetic rows reproduce the preserved IM-01 probe.
const common =
  table(
    "languages",
    ["langid", "tag"],
    [
      [1, "jbo"],
      [2, "en"],
    ],
  ) +
  table("valsitypes", ["typeid", "descriptor"], [[1, "gismu"]]) +
  table(
    "valsi",
    ["valsiid", "word", "typeid", "source_langid", "rafsi"],
    [[10, "broda", 1, 1, null]],
  ) +
  table(
    "definitions",
    [
      "definitionid",
      "valsiid",
      "langid",
      "definition",
      "notes",
      "etymology",
      "selmaho",
      "jargon",
      "rafsi",
      "userid",
    ],
    [
      [
        100,
        10,
        2,
        "A synthetic audit definition.",
        null,
        null,
        null,
        null,
        null,
        null,
      ],
    ],
  ) +
  table(
    "natlangwords",
    ["wordid", "langid", "word", "meaning"],
    [
      [20, 2, "synthetic gloss", null],
      [21, 2, "second gloss", null],
    ],
  ) +
  table("definition_versions", ["version_id", "definition_id"], []) +
  table("etymology", ["etymologyid", "valsiid", "langid"], []) +
  table("example", ["exampleid", "definitionid"], []) +
  table("natlangwordbestplaces", ["wordid", "definitionid"], []);
const mappings = (count: number) =>
  table(
    "keywordmapping",
    ["natlangwordid", "definitionid", "place"],
    [
      [20, 100, 0],
      [21, 100, 0],
    ].slice(0, count),
  );

async function setup() {
  const base = process.env.JVC_TEST_ROOT ?? tmpdir();
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "sql-completeness-"));
  directories.push(directory);
  return directory;
}

async function run(
  directory: string,
  name: string,
  relation: string,
  expected: number,
) {
  const bytes = Buffer.from(common + relation);
  const sourcePath = join(directory, `${name}.sql`);
  const manifestPath = join(directory, `${name}.manifest.json`);
  await writeFile(sourcePath, bytes);
  await writeFile(
    manifestPath,
    JSON.stringify({
      source: SQL_SOURCE,
      account_origin: SQL_SOURCE,
      url: "https://example.test/synthetic.sql",
      retrieved_at: "2026-10-27T00:00:00Z",
      sha256: contentHash(bytes),
      bytes: bytes.length,
      extraction: SQL_EXTRACTION,
      recipe: "lensisku-sql-copy-v1",
      expected_rows: {
        languages: 2,
        valsitypes: 1,
        valsi: 1,
        definitions: 1,
        natlangwords: 2,
        keywordmapping: expected,
        definition_versions: 0,
        etymology: 0,
        example: 0,
        natlangwordbestplaces: 0,
      },
      notes: ["Synthetic audit fixture."],
    }),
  );
  const output = join(directory, "proposal");
  const result = await importSqlSnapshot({
    sourcePath,
    manifestPath,
    output,
    seed,
    roots: [],
  });
  const journal = await readJournal(output);
  assert.ok(journal);
  return { result, entry: journal.entries["100"] };
}

for (const [name, relation, expected] of [
  ["absent", "", 1],
  ["short", mappings(1), 2],
] as const) {
  test(`IM-01 ${name} SQL relation keeps the selected publication and known baseline`, async () => {
    const directory = await setup();
    const first = await run(
      directory,
      "complete",
      mappings(expected),
      expected,
    );
    assert.equal(first.result.report.incomplete, false);
    assert.equal(first.entry.versions.length, 1);
    const second = await run(directory, name, relation, expected);
    assert.equal(second.result.report.incomplete, true);
    assert.equal(second.result.report.revised, 0);
    assert.equal(second.result.selection, first.result.selection);
    assert.deepEqual(second.entry, first.entry);
    assert.ok(
      second.result.report.unresolved.some(
        (issue) =>
          issue.record === 100 &&
          /keywordmapping.*incomplete/.test(issue.reason),
      ),
      JSON.stringify(second.result.report),
    );
    const fresh = await run(await setup(), name, relation, expected);
    assert.equal(fresh.result.report.added, 0);
    assert.equal(fresh.entry, undefined);
  });
}

test("IM-01 a complete empty SQL relation permits a real gloss removal", async () => {
  const directory = await setup();
  const first = await run(directory, "complete", mappings(1), 1);
  const second = await run(directory, "empty", mappings(0), 0);
  assert.equal(second.result.report.incomplete, false);
  assert.deepEqual(second.result.report.unresolved, []);
  assert.equal(second.result.report.revised, 1);
  assert.notEqual(second.entry.selected, first.entry.selected);
  assert.equal(second.entry.versions.length, 2);
  assert.deepEqual(second.entry.baseline.glosses, { known: [] });
  const publication = second.entry.versions.find(
    (version) => version.carrier.envelope.id === second.entry.selected,
  )!.carrier;
  assert.deepEqual(publication.body.glosses ?? [], []);
  assert.deepEqual(publication.envelope.header.action.parents, [
    first.entry.selected,
  ]);
});
