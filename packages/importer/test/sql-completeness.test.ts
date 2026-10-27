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
  options: {
    source?: string;
    counts?: Record<string, number | undefined>;
  } = {},
) {
  const bytes = Buffer.from(options.source ?? common + relation);
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
        ...options.counts,
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
  return { result, entry: journal.entries["100"], entries: journal.entries };
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

function replaceTable(source: string, name: string, replacement: string) {
  return source.replace(
    new RegExp(`COPY public\\.${name} \\([^]*?\\\\\\.\\n`),
    replacement,
  );
}

// Opus's undeclared-probe.mts also omitted the absent relation's count.
for (const name of [
  "languages",
  "valsitypes",
  "valsi",
  "definitions",
  "natlangwords",
  "keywordmapping",
  "definition_versions",
  "etymology",
  "example",
  "natlangwordbestplaces",
]) {
  for (const mode of ["uncounted", "absent", "absent and uncounted"]) {
    test(`IM-01 ${mode} ${name} preserves prior evidence and reports incomplete coverage`, async () => {
      const directory = await setup();
      const first = await run(directory, "complete", mappings(1), 1);
      const options = {
        source:
          `-- Capture with ${mode} ${name}.\n` +
          (mode.includes("absent")
            ? replaceTable(common + mappings(1), name, "")
            : common + mappings(1)),
        counts: mode.includes("uncounted") ? { [name]: undefined } : {},
      };
      const second = await run(directory, mode, "", 1, options);
      assert.equal(second.result.report.incomplete, true);
      assert.equal(second.result.report.revised, 0);
      assert.equal(second.result.selection, first.result.selection);
      assert.deepEqual(second.entry, first.entry);
      const notice = second.result.report.notices.find((notice) =>
        notice.includes(`for ${name}:`),
      );
      assert.ok(notice, JSON.stringify(second.result.report));
      if (mode.includes("uncounted")) assert.match(notice, /count is unknown/);
      if (mode.includes("absent")) assert.match(notice, /COPY rows absent/);
      const repeated = await run(directory, mode, "", 1, options);
      assert.equal(repeated.result.report.incomplete, true);
      assert.deepEqual(
        repeated.result.report.notices,
        second.result.report.notices,
      );
      assert.deepEqual(repeated.entry, first.entry);
      const fresh = await run(await setup(), mode, "", 1, options);
      assert.equal(fresh.result.report.added, 0);
      assert.equal(fresh.entry, undefined);
    });
  }
}

const twoOwners = replaceTable(
  common,
  "definitions",
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
    [100, 101].map((id) => [
      id,
      10,
      2,
      `Definition ${id}.`,
      null,
      null,
      null,
      null,
      null,
      null,
    ]),
  ),
);
const ownerMappings = (rows: (string | number | null)[][]) =>
  table("keywordmapping", ["natlangwordid", "definitionid", "place"], rows);

test("IM-01 the Opus split-row probe cannot hide another owner's missing keyword row", async () => {
  const directory = await setup();
  const counts = { definitions: 2 };
  const first = await run(directory, "complete", "", 2, {
    source:
      twoOwners +
      ownerMappings([
        [20, 100, 0],
        [21, 101, 0],
      ]),
    counts,
  });
  assert.equal(first.result.report.added, 2);
  const source =
    twoOwners +
    ownerMappings([
      [20, 100],
      ["", 0],
    ]);
  const second = await run(directory, "split-and-missing", "", 2, {
    source,
    counts,
  });
  assert.equal(second.result.report.table_rows.keywordmapping, 2);
  assert.equal(second.result.report.logical_table_rows.keywordmapping, 1);
  assert.equal(second.result.report.revised, 0);
  assert.equal(second.result.selection, first.result.selection);
  assert.deepEqual(second.entries, first.entries);
  assert.ok(
    second.result.report.notices.some((notice) =>
      /keywordmapping: declared 2, logical COPY rows 1, physical COPY rows 2/.test(
        notice,
      ),
    ),
  );
  for (const record of [100, 101])
    assert.ok(
      second.result.report.unresolved.some((issue) => issue.record === record),
    );
  const fresh = await run(await setup(), "split-and-missing", "", 2, {
    source,
    counts,
  });
  assert.equal(fresh.result.report.added, 0);
});

test("IM-01 a split row with no missing logical record keeps the per-owner path", async () => {
  const source =
    twoOwners +
    ownerMappings([
      [20, 100],
      ["", 0],
      [21, 101, 0],
    ]);
  const result = await run(await setup(), "split-only", "", 2, {
    source,
    counts: { definitions: 2 },
  });
  assert.equal(result.result.report.table_rows.keywordmapping, 3);
  assert.equal(result.result.report.logical_table_rows.keywordmapping, 2);
  assert.equal(result.result.report.added, 1);
  assert.equal(result.entries["100"], undefined);
  assert.ok(result.entries["101"]);
  assert.deepEqual(result.result.report.notices, []);
  assert.ok(
    result.result.report.unresolved.every((issue) => issue.record === 100),
  );
});

test("IM-01 surplus logical records remain reportable without freezing valid owners", async () => {
  const result = await run(await setup(), "surplus", "", 1, {
    source:
      twoOwners +
      ownerMappings([
        [20, 100, 0],
        [21, 101, 0],
      ]),
    counts: { definitions: 2 },
  });
  assert.equal(result.result.report.incomplete, true);
  assert.equal(result.result.report.added, 2);
  assert.deepEqual(result.result.report.unresolved, []);
  assert.ok(
    result.result.report.notices.some((notice) =>
      /keywordmapping: declared 1, logical COPY rows 2/.test(notice),
    ),
  );
});

test("IM-01 an empty mapping table does not hide an uncounted lookup table", async () => {
  const result = await run(await setup(), "uncounted-lookup", mappings(0), 0, {
    counts: { natlangwords: undefined },
  });
  assert.equal(result.result.report.incomplete, true);
  assert.equal(result.result.report.added, 0);
  assert.ok(
    result.result.report.notices.some((notice) =>
      /count is unknown for natlangwords/.test(notice),
    ),
  );
});

test("IM-01 split history cannot mask missing history while another owner changes text", async () => {
  const directory = await setup();
  const counts = { definitions: 2, definition_versions: 2 };
  const history = (rows: (string | number | null)[][]) =>
    table(
      "definition_versions",
      ["version_id", "definition_id", "message"],
      rows,
    );
  const source =
    replaceTable(
      twoOwners,
      "definition_versions",
      history([
        [1, 100, "first edit"],
        [2, 101, "second edit"],
      ]),
    ) +
    ownerMappings([
      [20, 100, 0],
      [21, 101, 0],
    ]);
  const first = await run(directory, "complete", "", 2, { source, counts });
  assert.equal(first.result.report.added, 2);
  const secondSource = replaceTable(
    source.replace("Definition 101.", "Definition 101 changed."),
    "definition_versions",
    history([
      [1, 100],
      ["", "first edit"],
    ]),
  );
  const second = await run(directory, "history-split-and-missing", "", 2, {
    source: secondSource,
    counts,
  });
  assert.equal(second.result.report.table_rows.definition_versions, 2);
  assert.equal(second.result.report.logical_table_rows.definition_versions, 1);
  assert.equal(second.result.report.revised, 0);
  assert.deepEqual(second.entries, first.entries);
  assert.ok(
    second.result.report.notices.some((notice) =>
      /definition_versions: declared 2, logical COPY rows 1/.test(notice),
    ),
  );
  assert.ok(
    second.result.report.unresolved.some(
      (issue) =>
        issue.record === 101 &&
        /definition_versions.*incomplete/.test(issue.reason),
    ),
  );
});

test("IM-01 declared counts for unread tables keep physical units", async () => {
  const result = await run(await setup(), "unread", "", 1, {
    source:
      common +
      mappings(1) +
      table("unread", ["id", "value"], [[1], ["", "tail"]]),
    counts: { unread: 1 },
  });
  assert.equal(result.result.report.table_rows.unread, 2);
  assert.equal(result.result.report.logical_table_rows.unread, undefined);
  const notice = result.result.report.notices.find((notice) =>
    notice.includes("for unread:"),
  );
  assert.match(notice!, /physical COPY rows 2/);
  assert.doesNotMatch(notice!, /logical/);
  assert.equal(result.result.report.added, 1);
});
