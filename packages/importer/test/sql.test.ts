import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  access,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  initializeCore,
  identityFromSeed,
  contentHash,
  utf8,
  evaluate,
  prepareAdmission,
  interpretDefinition,
  wordId,
} from "../../core/src/index.ts";
import { canonical, type Carrier } from "../src/index.ts";
import { decodeCopyField, readCopyRows } from "../src/sql-copy.ts";
import {
  importSqlSnapshot,
  parseSqlManifest,
  SQL_SOURCE,
  type SqlManifest,
} from "../src/sql.ts";
import type { ImportSizeEstimate } from "../src/import-estimate.ts";

const directories: string[] = [];
const seed = new Uint8Array(32).fill(43);
let fixture: Buffer;
let fixtureManifest: SqlManifest;
before(async () => {
  await initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  );
  fixture = await readFile(
    new URL("../fixtures/lensisku-sql-sample.sql", import.meta.url),
  );
  fixtureManifest = JSON.parse(
    await readFile(
      new URL("../fixtures/lensisku-sql-sample.manifest.json", import.meta.url),
      "utf8",
    ),
  );
});
after(async () => {
  for (const path of directories)
    await rm(path, { recursive: true, force: true });
});
async function setup(bytes = fixture) {
  const base = process.env.JVC_TEST_ROOT ?? tmpdir();
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "sql-import-test-"));
  directories.push(directory);
  const sourcePath = join(directory, "source.sql");
  const manifestPath = join(directory, "manifest.json");
  const manifest = {
    ...fixtureManifest,
    sha256: contentHash(bytes),
    bytes: bytes.length,
  };
  await writeFile(sourcePath, bytes);
  await writeFile(manifestPath, canonical(manifest));
  return {
    directory,
    sourcePath,
    manifestPath,
    output: join(directory, "proposal"),
    seed,
    roots: [],
  };
}
async function carriers(output: string): Promise<Carrier[]> {
  return (await readFile(join(output, "carriers.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
function mutate(bytes: Buffer, transform: (fields: string[]) => void): Buffer {
  let inDefinitions = false;
  return Buffer.from(
    bytes
      .toString("utf8")
      .split("\r\n")
      .map((line) => {
        if (line.startsWith("COPY "))
          inDefinitions = line.startsWith("COPY public.definitions ");
        if (line === "\\.") inDefinitions = false;
        if (inDefinitions && !line.startsWith("COPY ")) {
          const fields = line.split("\t");
          transform(fields);
          return fields.join("\t");
        }
        return line;
      })
      .join("\r\n"),
  );
}
async function updateSource(
  input: Awaited<ReturnType<typeof setup>>,
  bytes: Buffer,
) {
  input.sourcePath = join(
    input.directory,
    `${contentHash(bytes).slice(7)}.sql`,
  );
  const manifest = {
    ...fixtureManifest,
    sha256: contentHash(bytes),
    bytes: bytes.length,
  };
  await writeFile(input.sourcePath, bytes);
  await writeFile(input.manifestPath, canonical(manifest));
}

test("COPY decoding retains null distinctions, escaped UTF-8 bytes, and literal text", () => {
  assert.equal(decodeCopyField("\\N"), null);
  assert.equal(decodeCopyField("\\\\N"), "\\N");
  assert.equal(
    decodeCopyField("one\\ttwo\\nthree\\rfour\\\\end"),
    "one\ttwo\nthree\rfour\\end",
  );
  assert.equal(decodeCopyField("caf\\303\\251"), "café");
  assert.equal(decodeCopyField("caf\\xc3\\xa9"), "café");
  assert.equal(decodeCopyField("\ufefftext"), "\ufefftext");
  assert.throws(() => decodeCopyField("\\377"), /encoded data/);
});

test("COPY reader counts ignored CRLF tables and reports each malformed physical row", async () => {
  const bytes = Buffer.from(
    "COPY public.ignored (id, payload) FROM stdin;\r\n1\t" +
      "x".repeat(600000) +
      "\r\n\\.\r\nCOPY public.test (id, value) FROM stdin;\r\n1\ta\\tb\r\n2\r\n\\.\r\n",
  );
  const input = await setup(bytes);
  const counts: Record<string, number> = {};
  const rows = [];
  for await (const row of readCopyRows(
    input.sourcePath,
    new Set(["test"]),
    (table, count) => {
      counts[table] = count;
    },
  ))
    rows.push(row);
  assert.deepEqual(counts, { ignored: 1, test: 2 });
  assert.deepEqual(rows[0].values, ["1", "a\tb"]);
  assert.match(rows[1].error!, /1 fields instead of 2/);
  assert.equal(rows[1].line, 6);
});

test("SQL fixture produces signed definitions in three languages and retains history and keyword indices", async () => {
  const input = await setup();
  let estimate = 0;
  const result = await importSqlSnapshot({
    ...input,
    estimate: (value) => {
      estimate = value.estimated_total_bytes;
    },
  });
  assert.equal(result.report.added, 4, JSON.stringify(result.report));
  assert.equal(
    result.report.incomplete,
    false,
    JSON.stringify(result.report.unresolved),
  );
  assert.deepEqual(Object.keys(result.report.languages).sort(), [
    "en",
    "fr",
    "ru",
  ]);
  assert.ok(estimate > 0 && estimate < 4_000_000_000);
  const records = await carriers(input.output);
  assert.equal(records.length, 10);
  for (const carrier of records)
    assert.equal(prepareAdmission(utf8(canonical(carrier))).action_valid, true);
  const definitions = records.filter(
    (item) => item.envelope.header.action.kind === "definition.publish",
  );
  const first = definitions.find((item) => item.body.legacy.record.id === 4)!;
  assert.equal(first.body.legacy.source, SQL_SOURCE);
  assert.equal(
    first.body.legacy.attribution.author_account.origin,
    "https://lensisku.lojban.org",
  );
  assert.deepEqual(first.body.legacy.original.definitions.definitionid, {
    $source_number: "4",
  });
  assert.equal(first.body.license.expression, "unknown");
  assert.equal(first.body.frame.arity.mode, "context");
  assert.equal(Object.hasOwn(first.body, "operands"), false);
  assert.equal(Object.hasOwn(first.body, "examples"), false);
  const interpreted = interpretDefinition<any>(first.body);
  assert.equal(interpreted.frame.arity.mode, "context");
  assert.deepEqual(interpreted.operands, []);
  assert.deepEqual(interpreted.examples, []);
  assert.deepEqual(interpreted.legacy, first.body.legacy);
  assert.ok(
    definitions.some(
      (item) => item.body.legacy.original.definition_versions.length > 0,
    ),
  );
  assert.ok(
    definitions.some((item) => item.body.legacy.original.scores.length > 0),
  );
  const db = new DatabaseSync(join(input.output, "journal.sqlite"));
  try {
    const values = db
      .prepare("SELECT lexical FROM versions")
      .all()
      .map((item) => JSON.parse(item.lexical as string));
    assert.ok(values.every((item) => Object.keys(item).length === 12));
    assert.ok(values.every((item) => "known" in item.place_keyword_indices));
    assert.ok(
      values.some((item) => item.place_keyword_indices.known.length > 0),
    );
    assert.ok(values.some((item) => item.glosses.known.length > 0));
  } finally {
    db.close();
  }
  const view = JSON.parse(
    await readFile(join(input.output, "selected-view.json"), "utf8"),
  );
  const selection = JSON.parse(
    await readFile(join(input.output, "import-selection.json"), "utf8"),
  );
  const evaluated = evaluate({
    events: records.map((item) => canonical(item.envelope)),
    bodies: Object.fromEntries(
      records.map((item) => [item.envelope.id, canonical(item.body)]),
    ),
    selected_view: view.envelope.id,
    import_selections: { [result.selection]: selection },
  } as any) as any;
  assert.equal(evaluated.available, true, JSON.stringify(evaluated.reasons));
});

test("repeat import reuses exact signed envelopes and rebuilds interrupted outputs", async () => {
  const input = await setup();
  const first = await importSqlSnapshot(input);
  const bytes = await readFile(join(input.output, "carriers.jsonl"));
  await rm(join(input.output, "carriers.jsonl"));
  const second = await importSqlSnapshot(input);
  assert.equal(second.view, first.view);
  assert.equal(second.selection, first.selection);
  assert.deepEqual(await readFile(join(input.output, "carriers.jsonl")), bytes);
  const archive = JSON.parse(
    await readFile(
      join(
        input.output,
        "source-archive",
        `${fixtureManifest.sha256.slice(7)}.reference.json`,
      ),
      "utf8",
    ),
  );
  assert.equal(archive.path, input.sourcePath);
  assert.equal(archive.bytes, fixture.length);
  assert.equal(archive.snapshot, fixtureManifest.sha256);
});

test("source changes create parented revisions and source reversions reuse original envelopes", async () => {
  const input = await setup();
  const initial = await importSqlSnapshot(input);
  const original = await carriers(input.output);
  const changed = mutate(fixture, (fields) => {
    if (fields[3] === "4") fields[4] += " Changed source text.";
  });
  await updateSource(input, changed);
  const revision = await importSqlSnapshot(input);
  assert.equal(revision.report.revised, 1, JSON.stringify(revision.report));
  assert.equal(revision.report.reused, 3);
  const revised = await carriers(input.output);
  const publication = revised.find(
    (item) =>
      item.envelope.header.action.kind === "definition.publish" &&
      item.body.legacy?.record.id === 4 &&
      item.body.legacy.snapshot !== fixtureManifest.sha256,
  )!;
  const old = original.find(
    (item) =>
      item.envelope.header.action.kind === "definition.publish" &&
      item.body.legacy?.record.id === 4,
  )!;
  assert.deepEqual(publication.envelope.header.action.parents, [
    old.envelope.id,
  ]);
  assert.notEqual(revision.view, initial.view);
  // A distinct capture with the original lexical content remains a separate observation.
  await updateSource(
    input,
    Buffer.concat([fixture, Buffer.from("-- Later observation\r\n")]),
  );
  const reverted = await importSqlSnapshot(input);
  assert.equal(reverted.report.reverted, 1);
  assert.equal(reverted.selection, initial.selection);
});

test("score and timestamp changes remain separate observations without lexical revisions", async () => {
  const input = await setup();
  const first = await importSqlSnapshot(input);
  let changed = mutate(fixture, (fields) => {
    if (fields[3] === "4") {
      fields[7] = "1789000000";
      fields[12] = "2026-09-13 00:00:00+00";
    }
  });
  changed = tableMutation(changed, "natlangwordbestplaces", (fields) =>
    fields[1] === "4" ? [...fields.slice(0, 3), "777777"] : fields,
  );
  assert.match(changed.toString(), /4\t4\t0\t777777/);
  await updateSource(input, changed);
  const second = await importSqlSnapshot(input);
  assert.equal(second.report.reused, 4);
  assert.equal(second.report.revised, 0);
  assert.ok(
    second.report.notices.some((notice) =>
      /attribution or source dates changed/.test(notice),
    ),
  );
  assert.equal(second.selection, first.selection);
  const db = new DatabaseSync(join(input.output, "journal.sqlite"));
  try {
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM observations").get() as any)
        .count,
      8,
    );
  } finally {
    db.close();
  }
});

test("unrepresentable and malformed rows retain archive evidence and explicit notices", async () => {
  const changed = mutate(fixture, (fields) => {
    if (fields[3] === "4") fields[1] = "99999999";
  });
  const input = await setup(changed);
  const result = await importSqlSnapshot(input);
  assert.equal(result.report.added, 3);
  assert.equal(result.report.incomplete, true);
  assert.ok(
    result.report.unresolved.some(
      (issue) => issue.record === 4 && /valsi reference/.test(issue.reason),
    ),
  );
  const split = Buffer.from(
    fixture
      .toString()
      .replace(/COPY public\.definitions ([^]*?)\\\.\r\n/, (block) =>
        block.replace(/\t/g, (token, offset) =>
          offset === block.indexOf("\t") ? "\n" : token,
        ),
      ),
  );
  const broken = await setup(split);
  const brokenResult = await importSqlSnapshot(broken);
  assert.ok(
    brokenResult.report.unresolved.some(
      (issue) =>
        /COPY row has/.test(issue.reason) && /line=/.test(issue.locator),
    ),
  );
  assert.ok(
    brokenResult.report.notices.some((notice) =>
      /Manifest row count differs/.test(notice),
    ),
  );
});

test("lost journal, corrupt envelopes, changed source, and signing failure cannot mint duplicate batches", async () => {
  const input = await setup();
  await importSqlSnapshot(input);
  await rm(join(input.output, "journal.sqlite"));
  await assert.rejects(importSqlSnapshot(input), /journal is missing/);
  const corrupt = await setup();
  await importSqlSnapshot(corrupt);
  const db = new DatabaseSync(join(corrupt.output, "journal.sqlite"));
  db.exec("UPDATE versions SET digest='sha256:broken'");
  db.close();
  await assert.rejects(importSqlSnapshot(corrupt), /lexical digest/);
  const mismatched = await setup();
  await writeFile(
    mismatched.sourcePath,
    Buffer.concat([fixture, Buffer.from("\n")]),
  );
  await assert.rejects(importSqlSnapshot(mismatched), /pinned digest/);
  const interrupted = await setup();
  await assert.rejects(
    importSqlSnapshot({
      ...interrupted,
      checkpoint: async (stage) => {
        if (stage === "journal-durable")
          throw new Error("simulated interruption");
      },
    }),
    /simulated/,
  );
  const recovered = await importSqlSnapshot(interrupted);
  assert.equal((await carriers(interrupted.output)).length, 10);
  assert.equal(recovered.report.reused, 4);
});

test("TOML archive metadata retains pinned bytes, date uncertainty, and table counts", () => {
  const toml = utf8(
    'source = "dict"\nfetched_at = 2026-09-13T00:00:00+00:00\nsha256 = "' +
      "a".repeat(64) +
      '"\nbytes = 123\nnotes = "Export date only. Text fields remain unverifiable."\n[coverage.counts]\n"definitions" = 4\n',
  );
  const manifest = parseSqlManifest(toml, "/tmp/snapshot.sql");
  assert.equal(manifest.sha256, "sha256:" + "a".repeat(64));
  assert.deepEqual(manifest.expected_rows, { definitions: 4 });
  assert.match(manifest.notes[0], /unverifiable/);
});

test("COPY escaped-byte errors stay local to the row", async () => {
  const input = await setup(
    Buffer.from(
      "COPY public.test (id, value) FROM stdin;\n1\t\\377\n2\tvalid\n\\.\n",
    ),
  );
  const rows = [];
  for await (const row of readCopyRows(input.sourcePath, new Set(["test"])))
    rows.push(row);
  assert.match(rows[0].error!, /UTF-8/);
  assert.deepEqual(rows[1].values, ["2", "valid"]);
});

test("changed roots publish a new view without republishing definitions", async () => {
  const input = await setup();
  const first = await importSqlSnapshot(input);
  const initial = await carriers(input.output);
  const identity = initial[0].envelope.header.issuer;
  const roots = [{ identity, q: { numerator: 1, denominator: 1 } }];
  const second = await importSqlSnapshot({ ...input, roots });
  assert.notEqual(second.view, first.view);
  assert.equal(second.selection, first.selection);
  const records = await carriers(input.output);
  assert.equal(
    records.filter(
      (item) => item.envelope.header.action.kind === "definition.publish",
    ).length,
    4,
  );
  assert.equal(records.filter((item) => !item.body.legacy).length, 2);
  const view = records.find((item) => item.envelope.id === second.view)!;
  assert.deepEqual(view.body.roots, roots);
  assert.deepEqual(view.envelope.header.action.parents, [first.view]);
  assert.equal(
    (await importSqlSnapshot({ ...input, roots })).view,
    second.view,
  );
});

test("an exact older snapshot retains later absent records and records the reversion", async () => {
  const input = await setup();
  const first = await importSqlSnapshot(input);
  // A new definition copies an existing source context in this synthetic test.
  let firstLine: string | undefined;
  let inDefinitions = false;
  const later = Buffer.from(
    fixture
      .toString()
      .split("\r\n")
      .flatMap((line) => {
        if (line.startsWith("COPY "))
          inDefinitions = line.startsWith("COPY public.definitions ");
        if (inDefinitions && line === "\\.") {
          inDefinitions = false;
          const fields = firstLine!.split("\t");
          fields[3] = "9999999";
          return [fields.join("\t"), line];
        }
        if (inDefinitions && !line.startsWith("COPY ") && !firstLine)
          firstLine = line;
        return [line];
      })
      .join("\r\n"),
  );
  await updateSource(input, later);
  const second = await importSqlSnapshot(input);
  assert.equal(second.report.added, 1);
  await updateSource(input, fixture);
  const returned = await importSqlSnapshot(input);
  const selection = JSON.parse(
    await readFile(join(input.output, "import-selection.json"), "utf8"),
  );
  assert.equal(selection.length, 10);
  assert.notEqual(returned.selection, first.selection);
  assert.equal(returned.selection, second.selection);
  assert.deepEqual(returned.report.omitted, [9999999]);
  const db = new DatabaseSync(join(input.output, "journal.sqlite"));
  try {
    const runs = db.prepare("SELECT snapshot FROM batches ORDER BY run").all();
    assert.equal(runs.length, 3);
    assert.equal(runs[2].snapshot, runs[0].snapshot);
    assert.equal(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM observations WHERE record=4")
          .get() as any
      ).count,
      3,
    );
  } finally {
    db.close();
  }
});

test("classification status labels, dialect tags, exact source numbers, and reserved source keys survive", async () => {
  let changed = fixture
    .toString()
    .replace("3\tcmevla", "3\tobsolete cmevla")
    .replace("2\ten\tEnglish", "2\ten-bpfk\tEnglish");
  const source = tableMutation(
    Buffer.from(changed),
    "definition_versions",
    (fields, position) => {
      if (position === 0)
        fields[8] = '{"$source_number":1.250,"large":9007199254740993001}';
      return fields;
    },
  );
  const input = await setup(source);
  const result = await importSqlSnapshot(input);
  assert.equal(result.report.added, 4, JSON.stringify(result.report));
  const records = (await carriers(input.output)).filter(
    (item) => item.envelope.header.action.kind === "definition.publish",
  );
  assert.ok(records.some((item) => item.body.language === "en-bpfk"));
  const original = records.find((item) => item.body.legacy.record.id === 74481)!
    .body.legacy.original.definition_versions[0].gloss_keywords;
  assert.deepEqual(original, {
    $source_object: [
      ["$source_number", { $source_number: "1.250" }],
      ["large", { $source_number: "9007199254740993001" }],
    ],
  });
  const experimental = records.filter(
    (item) =>
      item.body.legacy.original.valsitypes.descriptor === "obsolete cmevla",
  );
  assert.ok(experimental.length > 0);
  assert.ok(
    experimental.every(
      (item) =>
        item.body.classification.kind === "cmevla" &&
        item.body.labels.includes("obsolete"),
    ),
  );
});

test("source changes during staging stop before a signed batch commits", async () => {
  const input = await setup();
  await assert.rejects(
    importSqlSnapshot({
      ...input,
      checkpoint: async (stage) => {
        if (stage === "source-durable")
          await writeFile(
            input.sourcePath,
            Buffer.concat([fixture, Buffer.from("-- Concurrent mutation\r\n")]),
          );
      },
    }),
    /changed during extraction/,
  );
  const db = new DatabaseSync(join(input.output, "journal.sqlite"));
  try {
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM versions").get() as any).count,
      0,
    );
  } finally {
    db.close();
  }
});

test("an operator cannot replace a source path that still names earlier archive evidence", async () => {
  const input = await setup();
  const original = await importSqlSnapshot(input);
  const changed = mutate(fixture, (fields) => {
    if (fields[3] === "4") fields[4] += " Changed source text.";
  });
  await writeFile(input.sourcePath, changed);
  await writeFile(
    input.manifestPath,
    canonical({
      ...fixtureManifest,
      sha256: contentHash(changed),
      bytes: changed.length,
    }),
  );
  await assert.rejects(
    importSqlSnapshot(input),
    /immutable source files at distinct paths/,
  );
  const proposal = JSON.parse(
    await readFile(join(input.output, "proposal.json"), "utf8"),
  );
  assert.equal(proposal.selected_view, original.view);
});

test("a corrupted journal view lookup cannot substitute different signed roots", async () => {
  const input = await setup();
  await importSqlSnapshot(input);
  const db = new DatabaseSync(join(input.output, "journal.sqlite"));
  db.exec("UPDATE views SET body='{}'");
  db.close();
  await assert.rejects(importSqlSnapshot(input), /invalid view record/);
});

function tableMutation(
  bytes: Buffer,
  table: string,
  change: (fields: string[], position: number) => string[] | null,
): Buffer {
  let inside = false;
  let position = 0;
  return Buffer.from(
    bytes
      .toString()
      .split("\r\n")
      .flatMap((line) => {
        if (line.startsWith("COPY ")) {
          inside = line.startsWith(`COPY public.${table} `);
          position = 0;
          return [line];
        }
        if (line === "\\.") {
          inside = false;
          return [line];
        }
        if (!inside) return [line];
        const changed = change(line.split("\t"), position++);
        return changed === null ? [] : [changed.join("\t")];
      })
      .join("\r\n"),
  );
}
test("SQL imports keep acute cmevla display, source spelling, and plain identity", async () => {
  const spelling = "m\u0301a'an";
  const input = await setup(
    tableMutation(fixture, "valsi", (fields) => {
      if (fields[0] === "26591") fields[1] = spelling;
      return fields;
    }),
  );
  const result = await importSqlSnapshot(input);
  assert.equal(result.report.added, 4, JSON.stringify(result.report));
  const record = (await carriers(input.output)).find(
    (item) =>
      item.envelope.header.action.kind === "definition.publish" &&
      item.body.legacy?.record.id === 74481,
  )!;
  assert.equal(record.body.word.spelling, spelling.normalize("NFC"));
  assert.equal(record.body.legacy.original.valsi.word, spelling);
  assert.equal(
    record.envelope.header.action.word,
    wordId({ language: "jbo", spelling: "ma'an" }),
  );
});

function withSyntheticRelatedRows(bytes: Buffer): Buffer {
  return Buffer.from(
    bytes
      .toString()
      .replace(
        'COPY public.etymology (etymologyid, valsiid, langid, content, "time", userid) FROM stdin;\r\n',
        'COPY public.etymology (etymologyid, valsiid, langid, content, "time", userid) FROM stdin;\r\n1\t4\t2\tauthored origin\t1\t25\r\n',
      )
      .replace(
        'COPY public.example (exampleid, valsiid, definitionid, examplenum, content, "time", userid) FROM stdin;\r\n',
        'COPY public.example (exampleid, valsiid, definitionid, examplenum, content, "time", userid) FROM stdin;\r\n1\t4\t4\t1\tmi bajra\t1\t25\r\n',
      ),
  );
}

test("r2 F1 derived vectors, cache columns, metadata, and computed word values stay only in the archive", async () => {
  const input = await setup();
  await importSqlSnapshot(input);
  for (const carrier of (await carriers(input.output)).filter(
    (item) => item.envelope.header.action.kind === "definition.publish",
  )) {
    const original = carrier.body.legacy.original;
    for (const row of [
      original.definitions,
      original.valsi,
      ...original.definition_versions,
    ]) {
      assert.ok(
        Object.keys(row).every(
          (key) =>
            key !== "embedding" &&
            key !== "metadata" &&
            key !== "canonical_word" &&
            !key.startsWith("cached_"),
        ),
        Object.keys(row).join(","),
      );
    }
    assert.match(carrier.body.legacy.extraction, /v3$/);
    assert.ok(
      carrier.body.legacy.limitations.some(
        (item: string) => /embedding/.test(item) && /archive/.test(item),
      ),
    );
    assert.equal(typeof carrier.body.legacy.attribution.author, "string");
  }
});

for (const [table, affected] of [
  ["keywordmapping", 4],
  ["definition_versions", 74481],
  ["natlangwords", 4],
  ["etymology", 4],
  ["example", 4],
  ["natlangwordbestplaces", 36101],
  ["languages", 4],
  ["valsi", 74481],
  ["valsitypes", 4],
] as const) {
  test(`r2 F2 known owner of malformed ${table} remains unresolved and keeps its selection`, async () => {
    const clean = withSyntheticRelatedRows(fixture);
    const input = await setup(clean);
    const first = await importSqlSnapshot(input);
    const bad = tableMutation(clean, table, (fields, position) =>
      position === 0 ? [...fields, "extra"] : fields,
    );
    await updateSource(input, bad);
    const result = await importSqlSnapshot(input);
    assert.equal(result.report.revised, 0);
    assert.equal(result.selection, first.selection);
    assert.ok(
      result.report.unresolved.some((issue) => issue.record === affected),
      JSON.stringify(result.report),
    );
    const before = await setup(bad);
    const fresh = await importSqlSnapshot(before);
    assert.ok(
      !(await carriers(before.output)).some(
        (item) =>
          item.envelope.header.action.kind === "definition.publish" &&
          item.body.legacy?.record.id === affected,
      ),
    );
    assert.ok(fresh.report.added < 4);
  });
  test(`r2 F2 unknown owner of malformed ${table} preserves unrelated lookup references`, async () => {
    const clean = withSyntheticRelatedRows(fixture);
    const input = await setup(clean);
    const first = await importSqlSnapshot(input);
    const bad = tableMutation(clean, table, (fields, position) =>
      position === 0 ? ["broken"] : fields,
    );
    await updateSource(input, bad);
    const result = await importSqlSnapshot(input);
    assert.equal(result.selection, first.selection);
    if (["languages", "valsitypes", "valsi", "natlangwords"].includes(table))
      assert.ok(
        result.report.reused > 0 && result.report.reused < 4,
        JSON.stringify(result.report),
      );
    else assert.equal(result.report.reused, 0, JSON.stringify(result.report));
    assert.ok(result.report.unresolved.length > 0);
  });
}

test("r2 F3 malformed definition identity is present and never classified as omitted", async () => {
  const input = await setup();
  await importSqlSnapshot(input);
  const bad = mutate(fixture, (fields) => {
    if (fields[3] === "4") fields.push("extra");
  });
  await updateSource(input, bad);
  const result = await importSqlSnapshot(input);
  assert.ok(
    result.report.unresolved.some(
      (issue) => issue.record === 4 && /COPY-row/.test(issue.locator),
    ),
  );
  assert.ok(!result.report.omitted.includes(4));
});

test("r2 F5 malformed manifest shape fails before creating any output", async () => {
  for (const [field, value] of [
    ["notes", undefined],
    ["notes", [123]],
    ["url", 4],
    ["expected_rows", []],
    ["expected_rows", { definitions: -1 }],
    ["unexpected", "field"],
  ] as const) {
    const input = await setup();
    const manifest: any = JSON.parse(
      await readFile(input.manifestPath, "utf8"),
    );
    if (value === undefined) delete manifest[field];
    else manifest[field] = value;
    await writeFile(input.manifestPath, JSON.stringify(manifest));
    await assert.rejects(importSqlSnapshot(input), /manifest/i);
    await assert.rejects(readFile(join(input.output, "journal.sqlite")), {
      code: "ENOENT",
    });
  }
});

test("r2 F6 exact A B A reversion has its own observation and preserves every batch", async () => {
  const input = await setup();
  const first = await importSqlSnapshot(input);
  await updateSource(
    input,
    mutate(fixture, (fields) => {
      if (fields[3] === "4") fields[4] += " changed";
    }),
  );
  await importSqlSnapshot(input);
  await updateSource(input, fixture);
  const result = await importSqlSnapshot(input);
  assert.equal(result.report.reverted, 1);
  const db = new DatabaseSync(join(input.output, "journal.sqlite"));
  try {
    const observations = db
      .prepare("SELECT * FROM observations WHERE record=4 ORDER BY run")
      .all();
    assert.deepEqual(
      observations.map((row) => row.disposition),
      ["added", "revised", "reverted"],
    );
    const batches = db.prepare("SELECT * FROM batches ORDER BY run").all();
    assert.equal(batches.length, 3);
    assert.equal(JSON.parse(batches[0].report as string).added, 4);
    assert.equal(JSON.parse(batches[2].report as string).reverted, 1);
    assert.equal(batches[0].view, first.view);
  } finally {
    db.close();
  }
});

test("r2 F8 latest publication in the returning context becomes the revision parent", async () => {
  const input = await setup();
  await importSqlSnapshot(input);
  const first = (await carriers(input.output)).find(
    (item) =>
      item.envelope.header.action.kind === "definition.publish" &&
      item.body.legacy?.record.id === 4,
  )!;
  const moved = tableMutation(fixture, "valsi", (fields) =>
    fields[0] === "4" ? [fields[0], "bajru", ...fields.slice(2)] : fields,
  );
  await updateSource(input, moved);
  await importSqlSnapshot(input);
  const returned = mutate(fixture, (fields) => {
    if (fields[3] === "4") fields[4] += " new text in old context";
  });
  await updateSource(input, returned);
  await importSqlSnapshot(input);
  const records = (await carriers(input.output)).filter(
    (item) =>
      item.envelope.header.action.kind === "definition.publish" &&
      item.body.legacy?.record.id === 4,
  );
  const revision = records.find((item) =>
    JSON.stringify(item.body.text).includes("new text in old context"),
  )!;
  assert.deepEqual(revision.envelope.header.action.parents, [
    first.envelope.id,
  ]);
});

test("r2 Grok language edits change the definition language and gloss-only language evidence", async () => {
  const input = await setup();
  await importSqlSnapshot(input);
  const changed = tableMutation(fixture, "languages", (fields) =>
    fields[0] === "2" ? [fields[0], "en-simple", ...fields.slice(2)] : fields,
  );
  await updateSource(input, changed);
  const result = await importSqlSnapshot(input);
  assert.equal(result.report.revised, 2);
  const selected = JSON.parse(
    await readFile(join(input.output, "import-selection.json"), "utf8"),
  );
  const current = (await carriers(input.output)).find(
    (item) =>
      selected.includes(item.envelope.id) &&
      item.envelope.header.action.kind === "definition.publish" &&
      item.body.legacy?.record.id === 4,
  )!;
  assert.equal(current.body.language, "en-simple");
  assert.equal(current.body.glosses[0].language, "en-simple");
  // The Russian definition keeps its own context while its gloss language changes.
  const mixed = tableMutation(fixture, "natlangwords", (fields) =>
    fields[0] === "41609" ? [fields[0], "2", ...fields.slice(2)] : fields,
  );
  const glossInput = await setup(mixed);
  await importSqlSnapshot(glossInput);
  const old = (await carriers(glossInput.output)).find(
    (item) =>
      item.envelope.header.action.kind === "definition.publish" &&
      item.body.legacy?.record.id === 36101,
  )!;
  await updateSource(
    glossInput,
    tableMutation(mixed, "languages", (fields) =>
      fields[0] === "2" ? [fields[0], "en-simple", ...fields.slice(2)] : fields,
    ),
  );
  const glossResult = await importSqlSnapshot(glossInput);
  const ids = JSON.parse(
    await readFile(join(glossInput.output, "import-selection.json"), "utf8"),
  );
  const updated = (await carriers(glossInput.output)).find(
    (item) =>
      ids.includes(item.envelope.id) &&
      item.envelope.header.action.kind === "definition.publish" &&
      item.body.legacy?.record.id === 36101,
  )!;
  assert.equal(updated.body.language, "ru");
  assert.equal(updated.body.glosses[0].language, "en-simple");
  assert.deepEqual(updated.envelope.header.action.parents, [old.envelope.id]);
  assert.equal(glossResult.report.revised, 3);
});

test("r2 Grok SQL lock tells the operator to settle the prior import", async () => {
  const input = await setup();
  await mkdir(join(input.output, ".import-lock"), { recursive: true });
  await assert.rejects(
    importSqlSnapshot(input),
    /locked.*Settle the prior import/,
  );
});

test("r2 Grok numeric-only old language baselines migrate from signed tags without republishing", async () => {
  const input = await setup();
  const first = await importSqlSnapshot(input);
  const db = new DatabaseSync(join(input.output, "journal.sqlite"));
  try {
    for (const version of db.prepare("SELECT * FROM versions").all()) {
      const lexical = JSON.parse(version.lexical as string);
      const body = JSON.parse(version.carrier as string).body;
      lexical.language = { known: body.legacy.original.definitions.langid };
      const encoded = canonical(lexical);
      db.prepare("UPDATE versions SET lexical=?,digest=? WHERE event=?").run(
        encoded,
        contentHash(utf8(encoded)),
        version.event as string,
      );
      db.prepare("UPDATE entries SET baseline=? WHERE selected=?").run(
        encoded,
        version.event as string,
      );
    }
  } finally {
    db.close();
  }
  await updateSource(
    input,
    Buffer.concat([fixture, Buffer.from("-- New observation\r\n")]),
  );
  const same = await importSqlSnapshot(input);
  assert.equal(same.selection, first.selection);
  assert.equal(same.report.revised, 0);
  const after = new DatabaseSync(join(input.output, "journal.sqlite"));
  try {
    const stored = JSON.parse(
      after.prepare("SELECT baseline FROM entries WHERE record=4").get()!
        .baseline as string,
    );
    assert.deepEqual(stored.language.known, {
      source_id: { $source_number: "2" },
      tag: "en",
    });
  } finally {
    after.close();
  }
  await updateSource(
    input,
    tableMutation(fixture, "languages", (fields) =>
      fields[0] === "2" ? [fields[0], "en-simple", ...fields.slice(2)] : fields,
    ),
  );
  assert.equal((await importSqlSnapshot(input)).report.revised, 2);
});

test("r2 Grok historical candidates with equal lexical digests retain the right gloss languages", async () => {
  const source = tableMutation(fixture, "natlangwords", (fields) =>
    fields[0] === "41609" ? [fields[0], "2", ...fields.slice(2)] : fields,
  );
  const input = await setup(source);
  const first = await importSqlSnapshot(input);
  const old = (await carriers(input.output)).find(
    (item) =>
      item.envelope.header.action.kind === "definition.publish" &&
      item.body.legacy?.record.id === 36101,
  )!;
  const changed = tableMutation(source, "languages", (fields) =>
    fields[0] === "2" ? [fields[0], "en-simple", ...fields.slice(2)] : fields,
  );
  await updateSource(input, changed);
  await importSqlSnapshot(input);
  await updateSource(input, source);
  const restored = await importSqlSnapshot(input);
  assert.equal(restored.selection, first.selection);
  const selected = JSON.parse(
    await readFile(join(input.output, "import-selection.json"), "utf8"),
  );
  assert.ok(selected.includes(old.envelope.id));
  assert.equal(restored.report.reverted, 3);
});

test("r2 F8 a source reversion determines the latest observed parent across contexts", async () => {
  const input = await setup();
  await importSqlSnapshot(input);
  const first = (await carriers(input.output)).find(
    (item) =>
      item.envelope.header.action.kind === "definition.publish" &&
      item.body.legacy?.record.id === 4,
  )!;
  const changed = mutate(fixture, (fields) => {
    if (fields[3] === "4") fields[4] += " newer known text";
  });
  await updateSource(input, changed);
  await importSqlSnapshot(input);
  await updateSource(input, fixture);
  await importSqlSnapshot(input);
  const moved = tableMutation(fixture, "valsi", (fields) =>
    fields[0] === "4" ? [fields[0], "bajru", ...fields.slice(2)] : fields,
  );
  await updateSource(input, moved);
  await importSqlSnapshot(input);
  await updateSource(
    input,
    mutate(fixture, (fields) => {
      if (fields[3] === "4") fields[4] += " final context text";
    }),
  );
  await importSqlSnapshot(input);
  const final = (await carriers(input.output)).find(
    (item) =>
      item.envelope.header.action.kind === "definition.publish" &&
      item.body.legacy?.record.id === 4 &&
      JSON.stringify(item.body.text).includes("final context text"),
  )!;
  assert.deepEqual(final.envelope.header.action.parents, [first.envelope.id]);
});

test("r2 malformed definition fragments without readable IDs leave complete rows usable", async () => {
  const bad = tableMutation(fixture, "definitions", (fields, position) =>
    position === 0 ? ["unreadable", "fragment"] : fields,
  );
  const input = await setup(bad);
  const result = await importSqlSnapshot(input);
  assert.equal(result.report.added, 3);
  assert.ok(
    result.report.unresolved.some(
      (issue) => issue.record === null && /COPY-row/.test(issue.locator),
    ),
  );
});

test("r2 invalid source spellings remain unresolved without aborting other definitions", async () => {
  const bad = tableMutation(fixture, "valsi", (fields) =>
    fields[0] === "4"
      ? [fields[0], " bad spelling", ...fields.slice(2)]
      : fields,
  );
  const input = await setup(bad);
  const result = await importSqlSnapshot(input);
  assert.equal(result.report.added, 3);
  assert.ok(result.report.unresolved.some((issue) => issue.record === 4));
});

test("r2 F3 a split definition tail cannot impersonate a complete record ID", async () => {
  const prefix = [
    "318",
    "731",
    "62020",
    "62020",
    "source text prefix",
    "\\N",
    "1",
    "1",
    "\\N",
    "\\N",
    "f",
    "\\N",
    "2026-09-13 00:00:00+00",
    "\\N",
    "\\N",
    "source display name",
    "Easy French",
    "gismu",
    "source prefix",
  ].join("\t");
  const tail = [
    "French text continuation",
    "minra",
    "mir minr",
    "4",
    "1",
    "",
    "\\N",
    "\\N",
    "\\N",
  ].join("\t");
  const broken = Buffer.from(
    fixture
      .toString()
      .replace(
        /(COPY public\.definitions [^]*?)(\\\.\r\n)/,
        (_, block, end) => `${block}${prefix}\r\n${tail}\r\n${end}`,
      ),
  );
  const input = await setup(broken);
  const result = await importSqlSnapshot(input);
  assert.equal(
    result.report.added,
    4,
    JSON.stringify(result.report.unresolved),
  );
  const fragments = result.report.unresolved.filter((issue) =>
    /definitions\/COPY-row/.test(issue.locator),
  );
  assert.deepEqual(
    fragments.map((issue) => issue.record),
    [62020],
  );
  assert.match(
    fragments[0].locator,
    /COPY-row=5\/line=\d+.*COPY-row=6\/line=\d+/,
  );
  assert.ok(!result.report.unresolved.some((issue) => issue.record === 4));
  assert.ok(
    (await carriers(input.output)).some(
      (carrier) =>
        carrier.envelope.header.action.kind === "definition.publish" &&
        carrier.body.legacy?.record.id === 4,
    ),
  );
});

for (const [table, prefixColumn] of [
  ["keywordmapping", 0],
  ["definition_versions", 0],
  ["etymology", 0],
  ["example", 1],
  ["natlangwordbestplaces", 0],
] as const) {
  test(`r2 F3 an invalid numeric prefix in ${table} cannot establish its following owner`, async () => {
    const clean = withSyntheticRelatedRows(fixture);
    const broken = tableMutation(clean, table, (fields, position) => {
      if (position === 0) fields[prefixColumn] = "continuation fragment";
      return fields;
    });
    const input = await setup(broken);
    const result = await importSqlSnapshot(input);
    assert.equal(result.report.added, 0);
    assert.ok(
      result.report.unresolved.some(
        (issue) =>
          issue.record === null &&
          issue.locator.startsWith(`${table}/COPY-row=`),
      ),
    );
  });
}

function splitHistoryNotes(bytes: Buffer, pieces = 2): Buffer {
  return tableMutation(bytes, "definition_versions", (fields, position) => {
    if (position === 1)
      fields[5] +=
        "\r\n" +
        Array.from(
          { length: pieces - 1 },
          (_, index) => `continued notes ${index + 1}`,
        ).join("\r\n");
    return fields;
  });
}

test("r3 N1 a raw CRLF inside history notes leaves only its owner unresolved", async () => {
  const input = await setup(splitHistoryNotes(fixture));
  const result = await importSqlSnapshot(input);
  assert.equal(
    result.report.added,
    3,
    JSON.stringify(result.report.unresolved),
  );
  const publications = (await carriers(input.output)).filter(
    (carrier) => carrier.envelope.header.action.kind === "definition.publish",
  );
  assert.deepEqual(
    publications
      .map((carrier) => carrier.body.legacy.record.id)
      .sort((a, b) => a - b),
    [4, 36101, 53191],
  );
  assert.ok(result.report.unresolved.every((issue) => issue.record === 74481));
  const sourceIssue = result.report.unresolved.find((issue) =>
    issue.locator.startsWith("definition_versions/COPY-row="),
  )!;
  assert.match(
    sourceIssue.locator,
    /COPY-row=2\/line=\d+.*COPY-row=3\/line=\d+/,
  );
});

test("r3 N1 a split history row preserves the owner selection while other records reuse", async () => {
  const input = await setup();
  const clean = await importSqlSnapshot(input);
  await updateSource(input, splitHistoryNotes(fixture));
  const result = await importSqlSnapshot(input);
  assert.equal(result.selection, clean.selection);
  assert.equal(
    result.report.reused,
    3,
    JSON.stringify(result.report.unresolved),
  );
  assert.equal(result.report.revised, 0);
  assert.ok(result.report.unresolved.every((issue) => issue.record === 74481));
});

test("r3 N1 several raw line breaks in one history field keep one malformed owner", async () => {
  const input = await setup(splitHistoryNotes(fixture, 4));
  const result = await importSqlSnapshot(input);
  assert.equal(result.report.added, 3);
  assert.ok(result.report.unresolved.every((issue) => issue.record === 74481));
  const issue = result.report.unresolved.find((item) =>
    item.locator.startsWith("definition_versions/COPY-row="),
  )!;
  assert.equal((issue.locator.match(/COPY-row=/g) ?? []).length, 4);
});

for (const table of [
  "languages",
  "valsitypes",
  "valsi",
  "natlangwords",
] as const) {
  test(`r3 N1 an unreadable ${table} lookup key does not freeze unrelated definitions`, async () => {
    const broken = tableMutation(fixture, table, (fields, position) =>
      position === 0 ? ["unreadable lookup"] : fields,
    );
    const input = await setup(broken);
    const result = await importSqlSnapshot(input);
    assert.ok(
      result.report.added > 0 && result.report.added < 4,
      JSON.stringify(result.report),
    );
    assert.ok(
      result.report.unresolved.some(
        (issue) =>
          issue.record === null &&
          issue.locator.startsWith(`${table}/COPY-row=`),
      ),
    );
  });
}

test("r3 N1 short COPY fragments stay separate from complete rows and later tables", async () => {
  const source = Buffer.from(
    "COPY public.first (id, owner, text, end) FROM stdin;\r\n1\t4\thead\r\ntail\tend\r\n2\t5\tvalid\tend\r\n3\t6\tshort\r\n\\.\r\nCOPY public.second (id, text) FROM stdin;\r\n9\tvalid\r\n\\.\r\n",
  );
  const input = await setup(source);
  const rows = [];
  const counts: Record<string, number> = {};
  for await (const row of readCopyRows(
    input.sourcePath,
    new Set(["first", "second"]),
    (table, count) => {
      counts[table] = count;
    },
  ))
    rows.push(row);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].values[1], "4");
  assert.match(rows[0].error!, /physical|fragment/);
  assert.deepEqual(rows[1].values, ["2", "5", "valid", "end"]);
  assert.ok(rows[2].error);
  assert.equal(rows[3].table, "second");
  assert.deepEqual(counts, { first: 4, second: 1 });
});

test("r3 N3 check-existing restages a copied journal and preserves every carrier byte", async () => {
  const input = await setup();
  await importSqlSnapshot(input);
  const expected = await readFile(join(input.output, "carriers.jsonl"));
  const output = join(input.directory, "check");
  await mkdir(output);
  await copyFile(
    join(input.output, "journal.sqlite"),
    join(output, "journal.sqlite"),
  );
  const estimates: ImportSizeEstimate[] = [];
  const result = await importSqlSnapshot({
    ...input,
    output,
    checkExisting: true,
    estimate: (value) => estimates.push(value),
  });
  assert.equal(
    estimates.length,
    1,
    "The check must restage instead of replaying the committed batch.",
  );
  assert.ok(estimates[0].stage_bytes > 0);
  assert.equal(estimates[0].scope, "proposal");
  assert.equal(estimates[0].budget_bytes, 1_500_000_000);
  assert.equal(result.report.reused, 4);
  assert.deepEqual(await readFile(join(output, "carriers.jsonl")), expected);
  assert.equal(result.size_measurement.loaded_copy_measured, false);
});

test("r3 N3 check-existing refuses a missing journal before output writes", async () => {
  const input = await setup();
  await assert.rejects(
    importSqlSnapshot({ ...input, checkExisting: true }),
    /check requires an existing SQL journal/i,
  );
  await assert.rejects(access(input.output), { code: "ENOENT" });
});

test("r3 N3 check-existing refuses new definitions and rolls back all ledger changes", async () => {
  const input = await setup();
  await importSqlSnapshot(input);
  const previous = await readFile(join(input.output, "carriers.jsonl"));
  const output = join(input.directory, "check");
  await mkdir(output);
  await copyFile(
    join(input.output, "journal.sqlite"),
    join(output, "journal.sqlite"),
  );
  const changed = mutate(fixture, (fields) => {
    if (fields[3] === "4") fields[4] = "A changed definition.";
  });
  await updateSource(input, changed);
  await assert.rejects(
    importSqlSnapshot({ ...input, output, checkExisting: true }),
    /check cannot sign a new publication or view/i,
  );
  assert.deepEqual(
    await readFile(join(input.output, "carriers.jsonl")),
    previous,
  );
  const db = new DatabaseSync(join(output, "journal.sqlite"));
  try {
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM versions").get()?.count,
      4,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM batches").get()?.count,
      1,
    );
  } finally {
    db.close();
  }
});

test("r3 N3 check-existing refuses a new roots view", async () => {
  const input = await setup();
  await importSqlSnapshot(input);
  const output = join(input.directory, "check");
  await mkdir(output);
  await copyFile(
    join(input.output, "journal.sqlite"),
    join(output, "journal.sqlite"),
  );
  const roots = [
    {
      identity: identityFromSeed(seed),
      q: { numerator: 1, denominator: 1 },
    },
  ];
  await assert.rejects(
    importSqlSnapshot({ ...input, output, roots, checkExisting: true }),
    /check cannot sign a new publication or view/i,
  );
});

function paddedHistory(length: number, revised = false): Buffer {
  let history = false;
  const bytes = revised
    ? mutate(fixture, (fields) => {
        if (fields[3] === "74481") fields[4] += " revised";
      })
    : fixture;
  return Buffer.from(
    bytes
      .toString("utf8")
      .split("\r\n")
      .map((line) => {
        if (line.startsWith("COPY "))
          history = line.startsWith("COPY public.definition_versions ");
        if (line === "\\.") history = false;
        if (!history || line.startsWith("COPY ")) return line;
        const fields = line.split("\t");
        if (fields[0] === "2" && fields[1] === "74481")
          fields[12] = "P".repeat(length);
        return fields.join("\t");
      })
      .join("\r\n"),
  );
}
async function selectedDefinition(
  output: string,
  id: number,
): Promise<Carrier> {
  const db = new DatabaseSync(join(output, "journal.sqlite"), {
    readOnly: true,
  });
  try {
    return JSON.parse(
      (
        db
          .prepare(
            "SELECT carrier FROM versions JOIN entries ON entries.selected=versions.event WHERE entries.record=?",
          )
          .get(id) as any
      ).carrier,
    );
  } finally {
    db.close();
  }
}
function expandedSqlBody(body: any) {
  return {
    ...body,
    frame: null,
    operands: [],
    examples: [],
    classification: { selmaho: [], ...body.classification },
    license: { url: null, ...body.license },
    sources: body.sources.map((source: any) => ({
      url: null,
      event: null,
      locator: null,
      ...source,
    })),
  };
}

test("SQL body limits accept the signed omission window without truncating source history", async () => {
  const baseline = await setup(paddedHistory(0));
  await importSqlSnapshot(baseline);
  const original = await selectedDefinition(baseline.output, 74481);
  const target = 256 * 1024 - 16;
  const padding = target - Buffer.byteLength(canonical(original.body));
  assert.ok(padding > 0);
  const input = await setup(paddedHistory(padding));
  let planned = -1;
  const result = await importSqlSnapshot({
    ...input,
    estimate: (estimate) => {
      planned = estimate.new_publication_count;
    },
  });
  assert.equal(result.report.added, 4);
  assert.equal(result.report.unresolved.length, 0);
  assert.equal(planned, 4);
  const carrier = await selectedDefinition(input.output, 74481);
  assert.equal(Buffer.byteLength(canonical(carrier.body)), target);
  assert.ok(
    Buffer.byteLength(canonical(expandedSqlBody(carrier.body))) > 256 * 1024,
  );
  assert.equal(
    carrier.body.legacy.original.definition_versions[0].message,
    "P".repeat(padding),
  );
  assert.equal(
    prepareAdmission(utf8(canonical(carrier))).body_status,
    "present",
  );
});

test("SQL revision limits include the prior source before dry planning and signing", async () => {
  const baseline = await setup(paddedHistory(0));
  await importSqlSnapshot(baseline);
  await updateSource(baseline, paddedHistory(0, true));
  assert.equal((await importSqlSnapshot(baseline)).report.revised, 1);
  const calibration = await selectedDefinition(baseline.output, 74481);
  const prior = calibration.body.sources.filter(
    (source: any) => source.label === "Prior imported source version",
  );
  assert.equal(prior.length, 1);
  const length = Buffer.byteLength(canonical(calibration.body));
  for (const extra of [0, 1]) {
    const input = await setup(paddedHistory(0));
    await importSqlSnapshot(input);
    const original = await selectedDefinition(input.output, 74481);
    const padding = 256 * 1024 + extra - length;
    const hypothetical = structuredClone(calibration.body);
    hypothetical.legacy.original.definition_versions[0].message = "P".repeat(
      padding,
    );
    assert.equal(
      Buffer.byteLength(canonical(hypothetical)),
      256 * 1024 + extra,
    );
    const withoutPrior = {
      ...hypothetical,
      sources: hypothetical.sources.filter(
        (source: any) => source.label !== "Prior imported source version",
      ),
    };
    assert.ok(Buffer.byteLength(canonical(withoutPrior)) < 256 * 1024);
    await updateSource(input, paddedHistory(padding, true));
    let planned = -1;
    const result = await importSqlSnapshot({
      ...input,
      estimate: (estimate) => {
        planned = estimate.new_publication_count;
      },
    });
    assert.equal(planned, extra === 0 ? 1 : 0);
    assert.equal(result.report.revised, extra === 0 ? 1 : 0);
    const selected = await selectedDefinition(input.output, 74481);
    if (extra === 0) {
      assert.equal(Buffer.byteLength(canonical(selected.body)), 256 * 1024);
      assert.notEqual(selected.envelope.id, original.envelope.id);
      const sources = selected.body.sources.filter(
        (source: any) => source.label === "Prior imported source version",
      );
      assert.equal(sources.length, 1);
      assert.equal(sources[0].event, original.envelope.id);
      assert.equal(
        prepareAdmission(utf8(canonical(selected))).body_status,
        "present",
      );
      const repeat = await importSqlSnapshot(input);
      assert.equal(repeat.report.revised, 0);
      assert.equal(
        (await selectedDefinition(input.output, 74481)).envelope.id,
        selected.envelope.id,
      );
    } else {
      assert.equal(selected.envelope.id, original.envelope.id);
      assert.ok(
        result.report.unresolved.some(
          (item) => item.record === 74481 && /256 KiB/.test(item.reason),
        ),
      );
      const db = new DatabaseSync(join(input.output, "journal.sqlite"), {
        readOnly: true,
      });
      try {
        assert.equal(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM versions WHERE record=74481",
            )
            .get()!.count,
          1,
        );
      } finally {
        db.close();
      }
    }
  }
});

test("SQL imports map source fu'ivla classifications and preserve source evidence", async () => {
  const bytes = Buffer.from(
    fixture.toString().replace("1\tgismu\r\n", "1\tfu'ivla\r\n"),
  );
  assert.notDeepEqual(bytes, fixture);
  const input = await setup(bytes);
  const result = await importSqlSnapshot(input);
  assert.equal(result.report.added, 4);
  const definitions = (await carriers(input.output)).filter(
    (row) => row.envelope.header.action.kind === "definition.publish",
  );
  const changed = definitions.filter(
    (row) => row.body.classification.kind === "fuhivla",
  );
  assert.equal(changed.length, 2);
  for (const row of changed) {
    assert.equal(prepareAdmission(utf8(canonical(row))).action_valid, true);
    assert.equal(row.body.legacy.original.valsitypes.descriptor, "fu'ivla");
  }
});

test("fidelity import retains source spans, cached display names, original dates and official rafsi", async () => {
  const input = await setup();
  const first = await importSqlSnapshot(input);
  const records = await carriers(input.output);
  const definition = records.find(
    (item) =>
      item.envelope.header.action.kind === "definition.publish" &&
      item.body.legacy.record.id === 4,
  )!;
  const body = definition.body;
  assert.equal(
    body.legacy.original.definitions.definition,
    "$x_{1}$ runs on surface $x_{2}$ using limbs $x_{3}$ with gait $x_{4}$.",
  );
  assert.deepEqual(body.text, [
    [1, " runs on surface ", 2, " using limbs ", 3, " with gait ", 4, "."],
  ]);
  assert.equal(body.frame.arity.mode, "context");
  assert.deepEqual(
    body.frame.places.map((item: any) => item.index),
    [1, 2, 3, 4],
  );
  assert.equal(body.legacy.conversion.method, "heuristic");
  assert.equal(body.legacy.conversion.review, "unreviewed");
  for (const mapping of body.legacy.conversion.mappings) {
    assert.equal(mapping.field, "/definitions/definition");
    assert.equal(
      [...body.legacy.original.definitions.definition]
        .slice(mapping.start, mapping.end)
        .join(""),
      `$x_{${mapping.place}}$`,
    );
  }
  assert.equal(body.legacy.attribution.author, "officialdata");
  assert.equal(body.legacy.attribution.author_account.account, 1);
  assert.equal(
    body.legacy.attribution.author_account.evidence.kind,
    "source-id",
  );
  assert.equal(body.legacy.original.username_lookup.purpose, "display-only");
  assert.equal(
    body.legacy.original.username_lookup.evidence.kind,
    "username-lookup",
  );
  assert.equal(body.legacy.attribution.dates.time, "1046655416");
  const claims = records.filter(
    (item) => item.envelope.header.action.kind === "rafsi.publish",
  );
  assert.deepEqual(claims.map((item) => item.body.rafsi).sort(), [
    "baj",
    "bajr",
    "na'u",
    "nac",
    "namc",
  ]);
  assert.ok(claims.every((item) => item.body.legacy.record.kind === "word"));
  const selection = JSON.parse(
    await readFile(join(input.output, "import-selection.json"), "utf8"),
  );
  assert.ok(claims.every((item) => selection.includes(item.envelope.id)));
  assert.equal(first.report.fidelity.official_rafsi_claims, 5);
  assert.equal(first.report.fidelity.named_definitions, 4);
  const bytes = await readFile(join(input.output, "carriers.jsonl"));
  await importSqlSnapshot(input);
  assert.deepEqual(await readFile(join(input.output, "carriers.jsonl")), bytes);
});

test("SQL experimental rafsi retain definition evidence and share no official source claim", async () => {
  const input = await setup(
    mutate(fixture, (fields) => {
      if (fields[3] === "4") fields[25] = "baj bau";
    }),
  );
  const result = await importSqlSnapshot(input);
  assert.equal(result.report.fidelity.official_rafsi_claims, 5);
  assert.equal(result.report.fidelity.experimental_rafsi_claims, 2);
  const records = await carriers(input.output);
  const experimental = records.filter(
    (item) =>
      item.envelope.header.action.kind === "rafsi.publish" &&
      item.body.legacy.record.kind === "definition",
  );
  assert.deepEqual(experimental.map((item) => item.body.rafsi).sort(), [
    "baj",
    "bau",
  ]);
  assert.ok(
    experimental.every(
      (item) =>
        item.body.legacy.record.id === 4 &&
        item.body.legacy.original.definitions.rafsi === "baj bau",
    ),
  );
  assert.ok(
    experimental.every(
      (item) =>
        item.body.rationale[0][0].includes("experimental") &&
        item.body.legacy.conversion.review === "unreviewed",
    ),
  );
  const baj = records.filter(
    (item) =>
      item.envelope.header.action.kind === "rafsi.publish" &&
      item.body.rafsi === "baj",
  );
  assert.equal(baj.length, 2);
  assert.equal(
    baj[0].envelope.header.action.assignment,
    baj[1].envelope.header.action.assignment,
  );
  assert.ok(
    !records.some(
      (item) => item.envelope.header.action.kind === "judgment.set",
    ),
  );
});
