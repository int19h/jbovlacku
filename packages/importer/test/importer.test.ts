import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  initializeCore,
  createEvent,
  contentHash,
  utf8,
  evaluate,
  interpretDefinition,
  prepareSelection,
  wordId,
} from "../../core/src/index.ts";
import {
  importCapture,
  canonical,
  type CaptureManifest,
  type Journal,
} from "../src/index.ts";
import { encodeOriginal, parseSourceJson } from "../src/source-json.ts";
import {
  parseProtocolJson,
  publishProposal,
  readJournal,
} from "../src/storage.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const seed = new Uint8Array(32).fill(42);
const testDirectories: string[] = [];
after(async () => {
  await Promise.all(
    testDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});
let source: Buffer;
let manifest: CaptureManifest;
before(async () => {
  await initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  );
  source = await readFile(
    new URL("../fixtures/lensisku-sample.json", import.meta.url),
  );
  manifest = JSON.parse(
    await readFile(
      new URL("../fixtures/lensisku-sample.manifest.json", import.meta.url),
      "utf8",
    ),
  );
});
const run = (journal?: Journal) =>
  importCapture({ sourceBytes: source, manifest, seed, roots: [], journal });
function capture(
  rows: Record<string, any>[],
  journal?: Journal,
  unavailable_fields = manifest.unavailable_fields,
) {
  const bytes = utf8(JSON.stringify({ definitions: rows }));
  return importCapture({
    sourceBytes: bytes,
    manifest: {
      ...manifest,
      sha256: contentHash(bytes),
      expected_rows: rows.length,
      unavailable_fields,
    },
    seed,
    roots: [],
    journal,
  });
}
const rows = () =>
  JSON.parse(source.toString()).definitions as Record<string, any>[];

test("REST imports preserve acute cmevla display and plain word identity", () => {
  for (const spelling of ["dján", "m\u0301a'an", "ḾA'AN"]) {
    const row: Record<string, any> = {
      ...rows()[0],
      valsiword: spelling,
      type_name: "cmevla",
    };
    const result = capture([row]);
    assert.equal(result.report.added, 1, JSON.stringify(result.report));
    const carrier =
      result.journal.entries[String(row.definitionid)].versions[0].carrier;
    assert.equal(carrier.body.word.spelling, spelling.normalize("NFC"));
    assert.equal(carrier.body.legacy.original.valsiword, spelling);
    const plain = spelling
      .normalize("NFD")
      .replaceAll("\u0301", "")
      .normalize("NFC");
    assert.equal(
      carrier.envelope.header.action.word,
      wordId({ language: "jbo", spelling: plain }),
    );
  }
  const invalid = capture([
    { ...rows()[0], valsiword: "blánu", type_name: "gismu" },
  ]);
  assert.equal(invalid.report.added, 0);
  assert.ok(
    invalid.report.unresolved.some((item) =>
      /action and body rules/.test(item.reason),
    ),
  );
});

test("source extraction preserves exact numbers and reserved-key source objects", () => {
  const raw =
    '{"score":100001.0,"fraction":1.00000000000000001,"huge":9007199254740993,"nested":{"$source_number":"source-owned","$source_object":[4]}}';
  assert.deepEqual(encodeOriginal(parseSourceJson(raw)), {
    score: { $source_number: "100001.0" },
    fraction: { $source_number: "1.00000000000000001" },
    huge: { $source_number: "9007199254740993" },
    nested: {
      $source_object: [
        ["$source_number", "source-owned"],
        ["$source_object", [{ $source_number: "4" }]],
      ],
    },
  });
  assert.throws(
    () => parseSourceJson('{"id":4,"id":5}'),
    /Duplicate source key/,
  );
});

test("attributed place imports and selected views pass the shared state evaluator", () => {
  const result = run();
  assert.equal(result.report.added, 2);
  const body = result.journal.entries["4"].versions[0].carrier.body;
  assert.equal(body.legacy.attribution.author_account.account, 1);
  assert.equal(
    body.legacy.attribution.author_account.evidence.kind,
    "source-id",
  );
  assert.deepEqual(body.text, [
    [1, " runs on surface ", 2, " using limbs ", 3, " with gait ", 4, "."],
  ]);
  assert.equal(interpretDefinition<any>(body).frame.arity.mode, "context");
  assert.equal(body.license.expression, "unknown");
  assert.deepEqual(body.legacy.original.score, { $source_number: "100001.0" });
  assert.equal(body.legacy.conversion.mappings.length, 4);
  assert.equal(result.view.body.account_authority, false);
  assert.deepEqual(result.view.body.account_witnesses, []);
  assert.deepEqual(result.view.body.roots, []);
  const input = {
    events: result.carriers.map((carrier) => canonical(carrier.envelope)),
    bodies: Object.fromEntries(
      result.carriers.map((carrier) => [
        carrier.envelope.id,
        canonical(carrier.body),
      ]),
    ),
    selected_view: result.view.envelope.id,
    import_selections: { [result.selection.hash]: result.selection.ids },
  };
  const evaluated = evaluate(input);
  assert.equal(evaluated.available, true, JSON.stringify(evaluated.reasons));
  assert.equal(
    evaluated.publications[result.journal.entries["4"].selected].eligible,
    "eligible",
  );
});

test("repeat batches reuse signed envelopes and the original view", () => {
  const first = run(),
    second = run(JSON.parse(canonical(first.journal)));
  assert.equal(second.report.added, 0);
  assert.equal(second.report.reused, 2);
  assert.equal(canonical(first.carriers), canonical(second.carriers));
  assert.equal(canonical(first.journal), canonical(second.journal));
});

test("lexical revisions parent prior publications and reversions reuse original judgments", () => {
  const first = run(),
    altered = rows();
  altered[0].definition = "A synthetic changed definition.";
  const revision = capture(altered, first.journal);
  assert.equal(revision.report.revised, 1);
  const revised = revision.journal.entries["4"].versions[1].carrier;
  assert.deepEqual(revised.envelope.header.action.parents, [
    first.journal.entries["4"].selected,
  ]);
  const reverted = run(revision.journal);
  assert.equal(reverted.report.reverted, 1);
  assert.equal(
    reverted.journal.entries["4"].selected,
    first.journal.entries["4"].selected,
  );
  assert.equal(reverted.journal.entries["4"].versions.length, 2);
  assert.equal(reverted.journal.entries["4"].observations.length, 3);
  assert.deepEqual(reverted.selection.ids, first.selection.ids);
});

test("partial and absent rows cannot erase richer history or deprecate publications", () => {
  const first = run(),
    partial = rows().slice(0, 1);
  delete partial[0].notes;
  delete partial[0].selmaho;
  const result = capture(partial, first.journal);
  assert.equal(result.report.revised, 0);
  assert.deepEqual(result.selection.ids, first.selection.ids);
  assert.deepEqual(
    result.journal.entries["4"].baseline.notes,
    first.journal.entries["4"].baseline.notes,
  );
  assert.equal(result.report.omitted.length, 1);
  assert.equal(result.journal.entries["4"].versions.length, 1);
});

test("source scores and author display changes never create fabricated lexical revisions", () => {
  const first = run(),
    altered = rows();
  altered[0].score = 999.25;
  altered[0].username = "renamed-source-author";
  altered[0].created_at = "2026-10-11T00:00:00Z";
  const result = capture(altered, first.journal);
  assert.equal(result.report.revised, 0);
  assert.deepEqual(result.selection.ids, first.selection.ids);
  assert.equal(result.journal.entries["4"].observations.length, 2);
  assert.ok(
    result.report.notices.some((notice) =>
      notice.includes("attribution or source dates changed"),
    ),
  );
  assert.equal(
    result.journal.entries["4"].versions[0].carrier.body.legacy.attribution
      .author,
    "officialdata",
  );
});

test("new field coverage is an archived enrichment observation without an automatic edit", () => {
  const first = run(),
    altered = rows();
  altered[0].official_rafsi = "baj";
  const result = capture(
    altered,
    first.journal,
    manifest.unavailable_fields.filter((field) => field !== "official_rafsi"),
  );
  assert.equal(result.report.revised, 0);
  assert.equal(result.report.enriched, 2);
  assert.deepEqual(result.journal.entries["4"].baseline.official_rafsi, {
    known: ["baj"],
  });
  assert.equal(
    result.journal.entries["4"].versions[0].carrier.body.legacy.original
      .official_rafsi,
    null,
  );
});

test("new IDs become additions and identical duplicate source rows deduplicate", () => {
  const first = run(),
    altered = rows();
  altered.push({ ...altered[0], definitionid: 999999, valsiword: "test word" });
  const result = capture(altered, first.journal);
  assert.equal(result.report.added, 1);
  assert.equal(result.selection.ids.length, 3);
  const repeated = capture([altered[0], altered[0]], first.journal);
  assert.equal(repeated.report.duplicates, 1);
  assert.equal(repeated.report.incomplete, false);
  assert.equal(repeated.journal.entries["4"].versions.length, 1);
});

test("mismatched snapshots and missing journal envelopes fail instead of duplicating imports", () => {
  assert.throws(
    () =>
      importCapture({
        sourceBytes: source,
        manifest: { ...manifest, sha256: "sha256:" + "0".repeat(64) },
        seed,
        roots: [],
      }),
    /pinned digest/,
  );
  const result = run();
  result.journal.entries["4"].versions = [];
  assert.throws(() => run(result.journal), /lacks its original envelope/);
});

test("username-only capture leaves numeric authorship unknown", () => {
  const bytes = utf8(JSON.stringify({ definitions: rows() }));
  const result = importCapture({
    sourceBytes: bytes,
    manifest: {
      ...manifest,
      url: "https://lensisku.lojban.org/api/jbovlaste/definitions/list?username=officialdata",
      sha256: contentHash(bytes),
    },
    seed,
    roots: [],
  });
  assert.equal(
    result.journal.entries["4"].versions[0].carrier.body.legacy.attribution
      .author_account,
    null,
  );
});

test("a changed source spelling uses evidence instead of a parent across word contexts", () => {
  const first = run(),
    altered = rows();
  altered[0].valsiword = "bajra changed";
  const result = capture(altered, first.journal);
  const revised = result.journal.entries["4"].versions.at(-1)!.carrier;
  assert.deepEqual(revised.envelope.header.action.parents, []);
  assert.equal(
    revised.body.sources[0].event,
    first.journal.entries["4"].selected,
  );
});

test("explicit numeric authors cannot contradict the pinned author filter", () => {
  const first = run(),
    altered = rows();
  altered[0].definition = "Changed text with inconsistent account evidence.";
  altered[0].user_id = 99;
  const result = capture(altered, first.journal);
  assert.equal(result.report.unresolved[0].record, 4);
  assert.match(result.report.unresolved[0].reason, /explicit author differs/);
  assert.equal(
    result.journal.entries["4"].selected,
    first.journal.entries["4"].selected,
  );
});

test("changed text with omitted notes labels unavailable notes in the new publication", () => {
  const first = run(),
    altered = rows();
  altered[0].definition =
    "Synthetic revised text with partial source coverage.";
  delete altered[0].notes;
  const result = capture(altered, first.journal);
  const body = result.journal.entries["4"].versions.at(-1)!.carrier.body;
  assert.ok(!Object.hasOwn(body, "notes"));
  assert.deepEqual(interpretDefinition<any>(body).notes, []);
  assert.deepEqual(result.journal.entries["4"].baseline.notes, {
    unknown: true,
  });
  assert.ok(
    body.legacy.limitations.some(
      (notice: string) =>
        notice.includes("notes") && notice.includes("unavailable"),
    ),
  );
  assert.ok(!Object.hasOwn(body.legacy.original, "notes"));
});

test("protocol configuration and journal input reject duplicate keys and unsafe source numbers", () => {
  for (const value of [
    '{"source":"one","source":"two"}',
    '{"expected_rows":9007199254740993}',
    '{"q":1.00000000000000001}',
  ]) {
    assert.throws(() => parseProtocolJson(utf8(value)));
  }
});

async function outputDirectory() {
  const root = process.env.JVC_TEST_ROOT
    ? resolve(process.env.JVC_TEST_ROOT)
    : join(tmpdir(), "jbovlacku-importer-tests");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "reopen-"));
  testDirectories.push(directory);
  return directory;
}

test("interruption after durable journal commit reopens and rebuilds all derived output with original envelopes", async () => {
  const output = await outputDirectory(),
    first = run();
  const archive = join(
    output,
    "source-archive",
    `${manifest.sha256.slice(7)}.json`,
  );
  await assert.rejects(
    publishProposal(output, source, manifest, first, async (stage) => {
      if (stage === "journal-durable") {
        assert.deepEqual(await readFile(archive), source);
        assert.equal((await readJournal(output))!.head, first.journal.head);
        throw new Error("Synthetic interruption after journal commit.");
      }
    }),
    /Synthetic interruption/,
  );
  await assert.rejects(readFile(join(output, "carriers.jsonl")), {
    code: "ENOENT",
  });
  const reopened = run(await readJournal(output));
  assert.equal(reopened.report.added, 0);
  assert.equal(canonical(reopened.carriers), canonical(first.carriers));
  await publishProposal(output, source, manifest, reopened);
  assert.equal(
    await readFile(join(output, "carriers.jsonl"), "utf8"),
    first.carriers.map((carrier) => canonical(carrier) + "\n").join(""),
  );
  assert.equal(
    parseProtocolJson<Record<string, unknown>>(
      await readFile(join(output, "proposal.json")),
    ).selected_view,
    first.view.envelope.id,
  );
});

test("interruption after a partial set of derived outputs recovers from the committed journal", async () => {
  const output = await outputDirectory(),
    first = run();
  await assert.rejects(
    publishProposal(output, source, manifest, first, async (stage) => {
      if (stage === "carriers-written")
        throw new Error("Synthetic interruption after carrier output.");
    }),
    /Synthetic interruption/,
  );
  await assert.rejects(readFile(join(output, "selected-view.json")), {
    code: "ENOENT",
  });
  const reopened = run(await readJournal(output));
  await publishProposal(output, source, manifest, reopened);
  assert.equal(
    await readFile(join(output, "selected-view.json"), "utf8"),
    canonical(first.view),
  );
});

test("conflicting bytes at an existing source hash stop before journal commitment", async () => {
  const output = await outputDirectory(),
    first = run();
  await mkdir(join(output, "source-archive"));
  const archive = join(
    output,
    "source-archive",
    `${manifest.sha256.slice(7)}.json`,
  );
  await writeFile(archive, "Conflicting archive bytes");
  await assert.rejects(
    publishProposal(output, source, manifest, first),
    /existing source archive bytes differ/,
  );
  assert.equal(await readFile(archive, "utf8"), "Conflicting archive bytes");
  await assert.rejects(readJournal(output), /import journal is missing/);
});

test("escaped source objects preserve integer-like keys in their original insertion order", () => {
  const original = encodeOriginal(
    parseSourceJson(
      '{"b":0,"$source_number":"source-owned","2":2,"1":1,"nested":{"$source_object":[],"8":8,"3":3}}',
    ),
  ) as { $source_object: [string, unknown][] };
  assert.deepEqual(
    original.$source_object.map(([key]) => key),
    ["b", "$source_number", "2", "1", "nested"],
  );
  const nested = original.$source_object.at(-1)![1] as {
    $source_object: [string, unknown][];
  };
  assert.deepEqual(
    nested.$source_object.map(([key]) => key),
    ["$source_object", "8", "3"],
  );
});

test("unrepresentable rows remain archived with source IDs while unrelated rows import", async () => {
  const input = rows();
  input.push({ ...input[0], definitionid: 999991, valsiword: " edge space" });
  input.push({
    ...input[0],
    definitionid: 999992,
    valsiword: "control\u0000word",
  });
  input.push({
    ...input[0],
    definitionid: 999993,
    definition: "x".repeat(256 * 1024),
  });
  input.push({ ...input[0], definitionid: 999994, langid: 3 });
  const bytes = utf8(JSON.stringify({ definitions: input }));
  const pinned = {
    ...manifest,
    sha256: contentHash(bytes),
    expected_rows: input.length,
  };
  const result = importCapture({
    sourceBytes: bytes,
    manifest: pinned,
    seed,
    roots: [],
  });
  assert.equal(result.report.added, 2);
  assert.equal(result.report.incomplete, true);
  assert.deepEqual(
    result.report.unresolved.map((item) => item.record),
    [999991, 999992, 999993, 999994],
  );
  assert.ok(
    result.report.unresolved.every((item) =>
      item.locator.includes(String(item.record)),
    ),
  );
  assert.match(
    result.report.unresolved.at(-1)!.reason,
    /Unmapped source language ID: 3/,
  );
  const output = await outputDirectory();
  await publishProposal(output, bytes, pinned, result);
  assert.deepEqual(
    await readFile(
      join(output, "source-archive", `${pinned.sha256.slice(7)}.json`),
    ),
    Buffer.from(bytes),
  );
  assert.equal((await readJournal(output))!.entries["999993"], undefined);
});

test("conflicting duplicates preserve prior selection and report the source identity", () => {
  const first = run(),
    input = rows();
  input.push({
    ...input[0],
    definition: "Conflicting overlapping page value.",
  });
  const result = capture(input, first.journal);
  assert.deepEqual(result.report.conflicts, [4]);
  assert.equal(result.report.unresolved[0].record, 4);
  assert.equal(result.report.incomplete, true);
  assert.equal(
    result.journal.entries["4"].selected,
    first.journal.entries["4"].selected,
  );
  assert.equal(result.report.revised, 0);
});

test("a poorer unambiguous reversion reuses its richer prior publication", () => {
  const first = run(),
    revised = rows();
  revised[0].definition = "Synthetic changed text.";
  const second = capture(revised, first.journal);
  const poorer = rows();
  delete poorer[0].notes;
  const result = capture(poorer, second.journal);
  assert.equal(result.report.reverted, 1);
  assert.equal(result.report.revised, 0);
  assert.equal(
    result.journal.entries["4"].selected,
    first.journal.entries["4"].selected,
  );
  assert.deepEqual(
    result.journal.entries["4"].baseline.notes,
    first.journal.entries["4"].baseline.notes,
  );
  assert.equal(result.journal.entries["4"].versions.length, 2);
});

test("a poorer reversion with multiple compatible prior versions remains unresolved", () => {
  const first = run(),
    changedNotes = rows();
  changedNotes[0].notes = "A different known source note.";
  const second = capture(changedNotes, first.journal);
  const changedText = rows();
  changedText[0].notes = changedNotes[0].notes;
  changedText[0].definition = "A changed current text.";
  const third = capture(changedText, second.journal);
  const poorer = rows();
  delete poorer[0].notes;
  const result = capture(poorer, third.journal);
  assert.equal(result.report.reverted, 0);
  assert.equal(result.report.revised, 0);
  assert.equal(result.report.unresolved[0].record, 4);
  assert.match(result.report.unresolved[0].reason, /multiple prior revisions/);
  assert.equal(
    result.journal.entries["4"].selected,
    third.journal.entries["4"].selected,
  );
  assert.deepEqual(
    result.journal.entries["4"].baseline,
    third.journal.entries["4"].baseline,
  );
  assert.equal(
    result.journal.entries["4"].observations.at(-1)!.disposition,
    "unresolved-reversion",
  );
});

test("a contradicting known field prevents reuse of a prior revision", () => {
  const first = run(),
    revised = rows();
  revised[0].definition = "Synthetic changed text.";
  const second = capture(revised, first.journal);
  const poorer = rows();
  delete poorer[0].notes;
  poorer[0].selmaho = "A changed classification";
  const result = capture(poorer, second.journal);
  assert.equal(result.report.reverted, 0);
  assert.equal(result.report.revised, 1);
  assert.notEqual(
    result.journal.entries["4"].selected,
    first.journal.entries["4"].selected,
  );
});

test("a unique exact reversion takes priority over a poorer compatible historical version", () => {
  const initial = rows();
  delete initial[0].notes;
  const bytes = utf8(JSON.stringify({ definitions: initial }));
  const first = importCapture({
    sourceBytes: bytes,
    manifest: { ...manifest, sha256: contentHash(bytes) },
    seed,
    roots: [],
  });
  const enriched = rows();
  enriched[0].notes = "Known enrichment note N.";
  const enrichment = capture(enriched, first.journal);
  assert.equal(enrichment.report.enriched, 1);
  assert.equal(enrichment.journal.entries["4"].versions.length, 1);
  const known = rows();
  known[0].notes = "Changed known note M.";
  const second = capture(known, enrichment.journal);
  const changedText = rows();
  changedText[0].notes = known[0].notes;
  changedText[0].definition = "Changed text Y.";
  const third = capture(changedText, second.journal);
  const result = capture(known, third.journal);
  assert.equal(result.report.reverted, 1);
  assert.equal(result.report.revised, 0);
  assert.equal(result.report.unresolved.length, 0);
  assert.equal(
    result.journal.entries["4"].selected,
    second.journal.entries["4"].selected,
  );
  assert.equal(result.journal.entries["4"].versions.length, 3);
});

test("a missing journal beside a leftover selection or source archive requires explicit recovery", async () => {
  const selectionOnly = await outputDirectory();
  await writeFile(join(selectionOnly, "import-selection.json"), "[]");
  await assert.rejects(readJournal(selectionOnly), /import journal is missing/);
  const archiveOnly = await outputDirectory();
  await mkdir(join(archiveOnly, "source-archive"));
  await assert.rejects(readJournal(archiveOnly), /import journal is missing/);
});

test("interruption after source durability and before journal commit requires explicit recovery", async () => {
  const output = await outputDirectory();
  await assert.rejects(
    publishProposal(output, source, manifest, run(), async (stage) => {
      if (stage === "source-durable")
        throw new Error("Synthetic interruption before journal commit.");
    }),
    /Synthetic interruption/,
  );
  assert.deepEqual(
    await readFile(
      join(output, "source-archive", `${manifest.sha256.slice(7)}.json`),
    ),
    source,
  );
  await assert.rejects(readFile(join(output, "journal.json")), {
    code: "ENOENT",
  });
  await assert.rejects(readJournal(output), /import journal is missing/);
});

test("known rafsi tokens preserve non-ASCII whitespace and request review", () => {
  const first = run(),
    input = rows();
  input[0].official_rafsi = "ba\u00a0j  baj\tbrj";
  const result = capture(
    input,
    first.journal,
    manifest.unavailable_fields.filter((field) => field !== "official_rafsi"),
  );
  assert.deepEqual(result.journal.entries["4"].baseline.official_rafsi, {
    known: ["baj", "ba\u00a0j", "brj"],
  });
  assert.ok(
    result.report.notices.some(
      (notice) =>
        notice.includes("Definition 4") &&
        notice.includes("official_rafsi") &&
        notice.includes("non-ASCII whitespace"),
    ),
  );
  const unknown = capture(input, first.journal);
  assert.ok(
    !unknown.report.notices.some((notice) =>
      notice.includes("non-ASCII whitespace"),
    ),
  );
});

test("unknown source types remain unresolved until a known class permits publication", () => {
  for (const mode of ["missing", "null", "unavailable"] as const) {
    const input = rows();
    if (mode === "missing") delete input[0].type_name;
    if (mode === "null") input[0].type_name = null;
    const bytes = utf8(JSON.stringify({ definitions: input }));
    const pinned = {
      ...manifest,
      sha256: contentHash(bytes),
      unavailable_fields:
        mode === "unavailable"
          ? [...manifest.unavailable_fields, "type_name"]
          : manifest.unavailable_fields,
    };
    const first = importCapture({
      sourceBytes: bytes,
      manifest: pinned,
      seed,
      roots: [],
    });
    assert.equal(first.journal.entries["4"], undefined, mode);
    assert.ok(
      first.report.unresolved.some(
        (item) =>
          item.record === 4 && item.reason.includes("type_name is unavailable"),
      ),
      mode,
    );
    const known = capture(rows(), first.journal);
    assert.equal(
      known.journal.entries["4"].versions[0].carrier.body.classification.kind,
      "gismu",
      mode,
    );
    assert.equal(known.report.revised, 0, mode);
    assert.equal(known.report.enriched, 0, mode);
    assert.ok(known.report.added > 0, mode);
  }
});

test("missing classification keeps the prior selection and its richer evidence", () => {
  const first = run(),
    input = rows();
  delete input[0].type_name;
  input[0].definition = "Changed text while classification is unavailable.";
  const result = capture(input, first.journal);
  assert.equal(result.report.revised, 0);
  assert.equal(
    result.journal.entries["4"].selected,
    first.journal.entries["4"].selected,
  );
  assert.deepEqual(
    result.journal.entries["4"].baseline,
    first.journal.entries["4"].baseline,
  );
});

test("unsupported present types keep an explicit other mapping and source evidence", () => {
  const first = run(),
    input = rows();
  input[0].type_name = "source-specific-exotic-type";
  const result = capture(input, first.journal);
  const body = result.journal.entries["4"].versions.at(-1)!.carrier.body;
  assert.equal(body.classification.kind, "other");
  assert.equal(body.legacy.original.type_name, "source-specific-exotic-type");
  assert.ok(
    body.legacy.limitations.includes(
      "Source classification source-specific-exotic-type maps to other.",
    ),
  );
});

test("manifest-unavailable selmaho leaves the atomic classification evidence unresolved", () => {
  const first = run(),
    input = rows();
  input[0].selmaho = "NOT-AVAILABLE";
  input[0].definition = "Changed text with unavailable grammatical class.";
  const result = capture(input, first.journal, [
    ...manifest.unavailable_fields,
    "selmaho",
  ]);
  assert.equal(result.report.revised, 0);
  assert.equal(
    result.journal.entries["4"].selected,
    first.journal.entries["4"].selected,
  );
  assert.deepEqual(
    result.journal.entries["4"].baseline,
    first.journal.entries["4"].baseline,
  );
  assert.ok(
    result.report.unresolved.some(
      (item) =>
        item.record === 4 && item.reason.includes("selmaho is unavailable"),
    ),
  );
});

test("a known type without selmaho cannot hide a later known classification change as enrichment", () => {
  const initial = rows();
  delete initial[0].selmaho;
  const bytes = utf8(JSON.stringify({ definitions: initial }));
  const first = importCapture({
    sourceBytes: bytes,
    manifest: { ...manifest, sha256: contentHash(bytes) },
    seed,
    roots: [],
  });
  assert.equal(first.journal.entries["4"], undefined);
  assert.ok(
    first.report.unresolved.some(
      (item) =>
        item.record === 4 && item.reason.includes("selmaho is unavailable"),
    ),
  );
  const changed = rows();
  changed[0].type_name = "cmavo";
  changed[0].selmaho = "BAI";
  const result = capture(changed, first.journal);
  assert.equal(result.report.added, 1);
  assert.equal(result.report.enriched, 0);
  assert.equal(
    result.journal.entries["4"].versions[0].carrier.body.classification.kind,
    "cmavo",
  );
  assert.deepEqual(
    result.journal.entries["4"].versions[0].carrier.body.classification.selmaho,
    ["BAI"],
  );
});

test("r3 N2 REST publications omit derived, display, and viewer fields while keeping authored evidence and scores", () => {
  const altered = rows();
  const omitted: Record<string, unknown> = {
    embedding: [0.1, 0.2, 0.3],
    similarity: 0.9,
    can_edit: true,
    user_vote: 1,
    comment_count: 4,
    has_image: true,
    sound_url: "/sounds/generated",
    langrealname: "English display name",
    metadata: { processed_text: "derived text" },
    cached_definition: "derived cache",
    canonical_word: "computed-word",
    processed_text: "derived search text",
  };
  Object.assign(altered[0], omitted, { username: "joined-display-name" });
  altered[0].user_id = 1;
  const bytes = utf8(JSON.stringify({ definitions: altered }));
  const result = importCapture({
    sourceBytes: bytes,
    manifest: { ...manifest, sha256: contentHash(bytes) },
    seed,
    roots: [],
  });
  const body = result.journal.entries["4"].versions[0].carrier.body;
  for (const key of Object.keys(omitted)) {
    assert.equal(Object.hasOwn(body.legacy.original, key), false, key);
    assert.ok(
      body.legacy.limitations.some(
        (item: string) =>
          item.includes(key) ||
          (key.startsWith("cached_") && item.includes("cached_*")),
      ),
      `Missing limitation for ${key}`,
    );
  }
  assert.equal(body.legacy.extraction, "lensisku-list-fidelity-v3");
  assert.equal(body.legacy.attribution.author, "joined-display-name");
  assert.equal(
    body.legacy.attribution.author_account.username,
    "joined-display-name",
  );
  assert.equal(body.legacy.attribution.author_account.account, 1);
  assert.equal(
    body.legacy.attribution.author_account.evidence.kind,
    "source-id",
  );
  assert.equal(
    body.license.attribution,
    "Lensisku source author: joined-display-name",
  );
  assert.deepEqual(body.legacy.original.score, { $source_number: "100001" });
  assert.equal(body.legacy.original.definition, altered[0].definition);
  assert.equal(body.legacy.original.notes, altered[0].notes);
  assert.equal(body.legacy.original.owner_only, true);
  assert.deepEqual(result.journal.entries["4"].observations[0].original, {
    archive: contentHash(bytes),
    locator: "definitions/definitionid=4",
  });
  assert.equal(
    result.journal.entries["4"].observations[0].extraction,
    "lensisku-list-fidelity-v3",
  );
});

test("r3 N2 v2 captures retain old v1 envelopes on reuse and filter only newly signed revisions", () => {
  const selectedRows = rows().slice(0, 1);
  const bytes = utf8(JSON.stringify({ definitions: selectedRows }));
  const currentManifest = {
    ...manifest,
    sha256: contentHash(bytes),
    expected_rows: 1,
  };
  const first = importCapture({
    sourceBytes: bytes,
    manifest: currentManifest,
    seed,
    roots: [],
  });
  const version = first.journal.entries["4"].versions[0];
  const oldBody = structuredClone(version.carrier.body);
  oldBody.legacy.extraction = "lensisku-list-literal-v1";
  oldBody.legacy.conversion.version = "lensisku-list-literal-v1";
  oldBody.legacy.original = encodeOriginal(
    parseSourceJson(JSON.stringify(selectedRows[0])),
  );
  oldBody.legacy.attribution.author = "officialdata";
  oldBody.legacy.attribution.author_account.username = "officialdata";
  oldBody.license.attribution = "Lensisku source author: officialdata";
  const oldCarrier = createEvent(
    seed,
    [],
    "11".repeat(16),
    version.carrier.envelope.header.action,
    oldBody,
  ) as typeof version.carrier;
  const oldJournal = structuredClone(first.journal);
  oldJournal.head = oldCarrier.envelope.id;
  oldJournal.views = [];
  oldJournal.entries["4"].selected = oldCarrier.envelope.id;
  oldJournal.entries["4"].versions[0].carrier = oldCarrier;
  oldJournal.entries["4"].observations[0].publication = oldCarrier.envelope.id;
  oldJournal.entries["4"].observations[0].extraction =
    "lensisku-list-literal-v1";
  oldJournal.entries["4"].observations[0].original = oldBody.legacy.original;
  const reused = importCapture({
    sourceBytes: bytes,
    manifest: currentManifest,
    seed,
    roots: [],
    journal: oldJournal,
  });
  assert.equal(reused.report.revised, 0);
  assert.equal(reused.report.reused, 1);
  assert.equal(reused.journal.entries["4"].selected, oldCarrier.envelope.id);
  assert.deepEqual(
    reused.journal.entries["4"].observations[0],
    oldJournal.entries["4"].observations[0],
  );
  assert.equal(
    reused.journal.entries["4"].observations.at(-1)!.extraction,
    "lensisku-list-fidelity-v3",
  );
  assert.equal(
    canonical(reused.journal.entries["4"].versions[0].carrier),
    canonical(oldCarrier),
  );
  assert.equal(
    Object.hasOwn(
      reused.journal.entries["4"].versions[0].carrier.body.legacy.original,
      "embedding",
    ),
    true,
  );
  selectedRows[0].definition = "An actual known lexical change after v1.";
  const changedBytes = utf8(JSON.stringify({ definitions: selectedRows }));
  const revised = importCapture({
    sourceBytes: changedBytes,
    manifest: { ...currentManifest, sha256: contentHash(changedBytes) },
    seed,
    roots: [],
    journal: reused.journal,
  });
  const latest = revised.journal.entries["4"].versions.at(-1)!.carrier;
  assert.equal(revised.report.revised, 1);
  assert.equal(latest.body.legacy.extraction, "lensisku-list-fidelity-v3");
  assert.equal(Object.hasOwn(latest.body.legacy.original, "embedding"), false);
  assert.deepEqual(latest.envelope.header.action.parents, [
    oldCarrier.envelope.id,
  ]);
  assert.equal(
    canonical(revised.journal.entries["4"].versions[0].carrier),
    canonical(oldCarrier),
  );
  assert.throws(
    () =>
      importCapture({
        sourceBytes: bytes,
        manifest: {
          ...currentManifest,
          extraction: "lensisku-list-literal-v1",
        },
        seed,
        roots: [],
        journal: oldJournal,
      }),
    /extraction recipe is unsupported/,
  );
});

test("r3 N2 filtering preserves escaped source object key order", () => {
  const row = JSON.stringify(rows()[0]).slice(0, -1);
  const bytes = utf8(
    `{"definitions":[${row},"$source_number":"source-owned","2":"second","1":"first"}]}`,
  );
  const result = importCapture({
    sourceBytes: bytes,
    manifest: { ...manifest, sha256: contentHash(bytes), expected_rows: 1 },
    seed,
    roots: [],
  });
  const original =
    result.journal.entries["4"].versions[0].carrier.body.legacy.original;
  assert.deepEqual(original.$source_object.slice(-3), [
    ["$source_number", "source-owned"],
    ["2", "second"],
    ["1", "first"],
  ]);
  assert.equal(
    original.$source_object.some(
      ([key]: [string, unknown]) => key === "embedding",
    ),
    false,
  );
});

test("REST imports map the source fu'ivla label to fuhivla", () => {
  const row: Record<string, any> = {
    ...rows()[0],
    valsiword: "leksiko",
    type_name: "fu'ivla",
  };
  const bytes = utf8(JSON.stringify({ definitions: [row] }));
  const result = importCapture({
    sourceBytes: bytes,
    manifest: { ...manifest, sha256: contentHash(bytes), expected_rows: 1 },
    seed,
    roots: [],
  });
  assert.equal(result.report.added, 1);
  const body =
    result.journal.entries[String(row.definitionid)].versions[0].carrier.body;
  assert.equal(body.classification.kind, "fuhivla");
  assert.equal(body.legacy.original.type_name, "fu'ivla");
});

test("official rafsi claims retain distinct source evidence and reuse their exact envelopes", async () => {
  const row = {
    ...rows()[0],
    official_rafsi: "baj bajr baj",
    experimental_rafsi: "bau",
    username: "synthetic source name",
  };
  const first = capture([row], undefined, []);
  assert.equal(first.report.fidelity.official_rafsi_claims, 2);
  assert.equal(first.report.fidelity.experimental_rafsi_claims, 0);
  const claims = first.carriers.filter(
    (item) => item.envelope.header.action.kind === "rafsi.publish",
  );
  assert.deepEqual(claims.map((item) => item.body.rafsi).sort(), [
    "baj",
    "bajr",
  ]);
  assert.ok(
    claims.every((item) => item.body.legacy.record.kind === "definition"),
  );
  assert.ok(
    claims.every((item) => first.selection.ids.includes(item.envelope.id)),
  );
  assert.ok(
    !first.carriers.some(
      (item) => item.envelope.header.action.kind === "judgment.set",
    ),
  );
  const second = capture([row], first.journal, []);
  assert.equal(canonical(second.carriers), canonical(first.carriers));
  const directory = await mkdtemp(
    join(process.env.JVC_TEST_ROOT ?? tmpdir(), "fidelity-rest-"),
  );
  testDirectories.push(directory);
  const bytes = utf8(JSON.stringify({ definitions: [row] }));
  const pinned = {
    ...manifest,
    sha256: contentHash(bytes),
    expected_rows: 1,
    unavailable_fields: [],
  };
  await publishProposal(directory, bytes, pinned, first);
  const retained = await readJournal(directory);
  const third = capture([row], retained, []);
  assert.equal(canonical(third.carriers), canonical(first.carriers));
});

test("a display-only username never invents a numeric source account", () => {
  const row: Record<string, any> = {
    ...rows()[0],
    username: "synthetic source name",
  };
  delete row.user_id;
  const bytes = utf8(JSON.stringify({ definitions: [row] }));
  const result = importCapture({
    sourceBytes: bytes,
    manifest: {
      ...manifest,
      url: "https://lensisku.lojban.org/api/jbovlaste/definitions/list",
      sha256: contentHash(bytes),
      expected_rows: 1,
    },
    seed,
    roots: [],
  });
  const body =
    result.journal.entries[String(row.definitionid)].versions[0].carrier.body;
  assert.equal(body.legacy.attribution.author, row.username);
  assert.equal(body.legacy.attribution.author_account, null);
  assert.equal(result.view.body.account_authority, false);
});

test("imported rafsi eligibility follows the active definition gate", () => {
  const first = capture(
    [{ ...rows()[0], official_rafsi: "baj", experimental_rafsi: null }],
    undefined,
    [],
  );
  const claim = first.carriers.find(
    (item) => item.envelope.header.action.kind === "rafsi.publish",
  )!;
  const evaluateWith = (
    extra: any[],
    view: any,
    selection: { hash: string; canonical: string; ids: string[] },
  ) =>
    evaluate({
      events: [...first.carriers, ...extra].map((item) =>
        canonical(item.envelope),
      ),
      bodies: Object.fromEntries(
        [...first.carriers, ...extra]
          .filter((item) => item.body !== null)
          .map((item) => [item.envelope.id, canonical(item.body)]),
      ),
      selected_view: view.envelope.id,
      import_selections: { [selection.hash]: selection.ids },
    });
  assert.equal(
    evaluateWith([], first.view, first.selection).publications[
      claim.envelope.id
    ].eligible,
    "eligible",
  );
  const selection = prepareSelection(utf8(canonical([claim.envelope.id])));
  const view = createEvent(
    seed,
    [first.journal.head!],
    "a".repeat(32),
    { kind: "view.publish", parents: [first.view.envelope.id] },
    {
      ...first.view.body,
      import_sets: [
        {
          source: first.journal.source,
          importer: first.journal.importer,
          selection: selection.hash,
        },
      ],
    },
  );
  assert.equal(
    evaluateWith([view], view, selection).publications[claim.envelope.id]
      .eligible,
    "unknown",
  );
  const contributor = new Uint8Array(32).fill(79);
  const body = structuredClone(
    first.journal.entries["4"].versions[0].carrier.body,
  );
  body.legacy = null;
  const native = createEvent(
    contributor,
    [],
    "b".repeat(32),
    {
      kind: "definition.publish",
      word: wordId(body.word),
      language: body.language,
      parents: [],
      origin: "native",
    },
    body,
  );
  const retired = createEvent(
    contributor,
    [native.envelope.id],
    "c".repeat(32),
    { kind: "status.set", target: native.envelope.id, value: "deprecated" },
    null,
  );
  assert.equal(
    evaluateWith([view, native, retired], view, selection).publications[
      claim.envelope.id
    ].eligible,
    "inactive",
  );
});

test("official rafsi claims use plain spelling while retaining accented source evidence", () => {
  const result = capture(
    [
      {
        ...rows()[0],
        valsiword: "már",
        type_name: "cmevla",
        official_rafsi: "mar",
        experimental_rafsi: null,
      },
    ],
    undefined,
    [],
  );
  assert.equal(result.report.added, 1);
  const claim = result.carriers.find(
    (item) => item.envelope.header.action.kind === "rafsi.publish",
  )!;
  assert.equal(claim.body.word.spelling, "mar");
  const definition = result.journal.entries["4"].versions[0].carrier;
  assert.equal(definition.body.word.spelling, "már");
  assert.equal(
    claim.envelope.header.action.word,
    definition.envelope.header.action.word,
  );
});

test("removed official assignments stay retained without entering the new selection", () => {
  const row = {
    ...rows()[0],
    official_rafsi: "baj bajr",
    experimental_rafsi: null,
  };
  const first = capture([row], undefined, []);
  const old = first.carriers.find((item) => item.body.rafsi === "bajr")!;
  const second = capture(
    [{ ...row, official_rafsi: "baj" }],
    first.journal,
    [],
  );
  assert.equal(second.report.revised, 1);
  assert.ok(second.carriers.some((item) => canonical(item) === canonical(old)));
  assert.ok(!second.selection.ids.includes(old.envelope.id));
  assert.equal(second.report.fidelity.official_rafsi_claims, 1);
});

test("a username-only correction records provenance without replacing an old signature", () => {
  const first = run();
  const changed = rows();
  changed[0].username = "new display name";
  const second = capture(changed, first.journal);
  assert.equal(second.report.revised, 0);
  assert.deepEqual(second.carriers, first.carriers);
  assert.ok(
    second.report.notices.some((notice) =>
      /attribution or source dates changed/.test(notice),
    ),
  );
});
