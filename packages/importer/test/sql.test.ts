import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  initializeCore,
  contentHash,
  utf8,
  evaluate,
  prepareAdmission,
} from "../../core/src/index.ts";
import { canonical, type Carrier } from "../src/index.ts";
import { decodeCopyField, readCopyRows } from "../src/sql-copy.ts";
import {
  importSqlSnapshot,
  parseSqlManifest,
  SQL_SOURCE,
  type SqlManifest,
} from "../src/sql.ts";

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
  assert.equal(records.length, 5);
  for (const carrier of records)
    assert.equal(prepareAdmission(utf8(canonical(carrier))).action_valid, true);
  const definitions = records.filter((item) => item.body.legacy);
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
      item.body.legacy?.record.id === 4 &&
      item.body.legacy.snapshot !== fixtureManifest.sha256,
  )!;
  const old = original.find((item) => item.body.legacy?.record.id === 4)!;
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
  const changed = mutate(fixture, (fields) => {
    if (fields[3] === "4") {
      fields[7] = "1789000000";
      fields[12] = "2026-09-13 00:00:00+00";
    }
  });
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
  assert.equal((await carriers(interrupted.output)).length, 5);
  assert.equal(recovered.report.added, 4);
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
  assert.equal(records.filter((item) => item.body.legacy).length, 4);
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
  assert.equal(selection.length, 5);
  assert.notEqual(returned.selection, first.selection);
  assert.equal(returned.selection, second.selection);
  assert.deepEqual(returned.report.omitted, [9999999]);
});

test("classification status labels, dialect tags, exact source numbers, and reserved source keys survive", async () => {
  let changed = fixture
    .toString()
    .replace("3\tcmevla", "3\tobsolete cmevla")
    .replace("2\ten\tEnglish", "2\ten-bpfk\tEnglish");
  const source = mutate(Buffer.from(changed), (fields) => {
    if (fields[3] === "4")
      fields[14] = '{"$source_number":1.250,"large":9007199254740993001}';
  });
  const input = await setup(source);
  const result = await importSqlSnapshot(input);
  assert.equal(result.report.added, 4, JSON.stringify(result.report));
  const records = (await carriers(input.output)).filter(
    (item) => item.body.legacy,
  );
  assert.ok(records.some((item) => item.body.language === "en-bpfk"));
  const original = records.find((item) => item.body.legacy.record.id === 4)!
    .body.legacy.original.definitions.metadata;
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
