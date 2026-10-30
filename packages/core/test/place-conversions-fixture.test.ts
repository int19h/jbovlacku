import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  initializeCore,
  prepareAdmission,
  canonicalize,
  utf8,
  wordId,
  evaluate,
} from "../src/index.ts";
import { loadImportProposal } from "../../importer/src/load.ts";

const directory = new URL(
  "./fixtures/place-conversions-reviewed/",
  import.meta.url,
);
let manifest: any;
let records: any[];
let view: any;
before(async () => {
  await initializeCore(
    await readFile(
      new URL("../generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  );
  manifest = JSON.parse(
    await readFile(new URL("fixture.json", directory), "utf8"),
  );
  records = (await readFile(new URL("carriers.jsonl", directory), "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => {
      assert.equal(canonicalize(utf8(line)), line);
      return JSON.parse(line);
    });
  view = JSON.parse(
    await readFile(new URL("selected-view.json", directory), "utf8"),
  );
});

test("reviewed frame carriers authenticate as native revisions of their exact source events", async () => {
  assert.equal(records.length, 30);
  assert.equal(new Set(records.map((row) => row.envelope.id)).size, 30);
  for (const [file, digest] of Object.entries(manifest.files)) {
    assert.equal(
      "sha256:" +
        createHash("sha256")
          .update(await readFile(new URL(file, directory)))
          .digest("hex"),
      digest,
    );
  }
  for (const record of [...records, view]) {
    const result = prepareAdmission(utf8(JSON.stringify(record)));
    assert.equal(result.action_valid, true);
    assert.equal(result.body_status, "present");
  }
  for (const expected of manifest.definitions) {
    const row = records.find((record) => record.envelope.id === expected.event);
    assert.equal(row.envelope.header.action.kind, "definition.publish");
    assert.equal(row.envelope.header.action.origin, "native");
    assert.deepEqual(row.envelope.header.action.parents, [
      expected.source_event,
    ]);
    assert.equal(row.envelope.header.action.word, wordId(row.body.word));
    assert.equal(row.envelope.header.content.hash, expected.body);
    assert.equal(row.body.word.spelling, expected.word);
    assert.equal(row.body.language, "en");
    assert.equal(row.body.legacy, undefined);
    assert.equal(row.body.license.expression, "CC0-1.0");
    assert.equal(row.body.sources[0].event, expected.source_event);
    assert.equal(row.body.sources[1].locator, "footer.publicDomainNotice");
  }
});

test("all reviewed frames keep the explicit source numbering and supply complete place rows", () => {
  let places = 0;
  for (const expected of manifest.definitions) {
    const { body } = records.find(
      (record) => record.envelope.id === expected.event,
    );
    assert.equal(body.frame.role, "predicate");
    assert.deepEqual(body.frame.arity, {
      mode: "fixed",
      count: expected.place_count,
    });
    assert.deepEqual(
      body.frame.places.map((place: any) => place.index),
      Array.from({ length: expected.place_count }, (_, i) => i + 1),
    );
    assert.ok(expected.conversion_aliases.length > 0);
    const original: number[] = [];
    for (const paragraph of expected.source_text)
      for (const node of paragraph) {
        for (const match of node.matchAll(/x\s*_\s*(?:\{\s*(\d+)\s*\}|(\d+))/g))
          original.push(Number(match[1] ?? match[2]));
      }
    const rendered = body.text
      .flat()
      .filter((node: unknown) => typeof node === "number");
    assert.deepEqual(rendered, original);
    for (const place of body.frame.places) {
      assert.ok(place.description.length > 0);
      assert.ok(place.glosses.length > 0);
      assert.equal(place.defaults, undefined);
      assert.equal(place.derivation, undefined);
    }
    places += expected.place_count;
  }
  assert.equal(places, 91);
});

test("manual corrections preserve broad referents, type alternatives, and explicit cross-place references", () => {
  const body = (word: string) =>
    records.find((row) => row.body.word.spelling === word).body;
  const types = (word: string, index: number) =>
    body(word)
      .frame.places[index - 1].type_hints[0].alternatives.map(
        (item: any) => item.tags[0],
      )
      .sort();
  for (const [word, index] of [
    ["prami", 2],
    ["pilno", 2],
    ["xamgu", 1],
    ["kurji", 2],
    ["nelci", 2],
  ] as const) {
    assert.deepEqual(types(word, index), ["referent"]);
  }
  assert.deepEqual(types("troci", 2), ["event", "relation"]);
  assert.deepEqual(types("bridi", 3), ["sequence", "set"]);
  assert.deepEqual(
    body("ji'efri").frame.places[0].glosses.map((row: any) => row.text),
    ["live-experience"],
  );
  assert.deepEqual(
    body("tavla").frame.places[1].glosses.map((row: any) => row.text),
    ["addressee"],
  );
  assert.deepEqual(body("vecnu").frame.places[2].description, [
    ["Buyer that purchases ", 2, " from ", 1, "."],
  ]);
  assert.equal(manifest.review.semantic_corrections.length, 12);
});

test("native frame candidates remain active without inherited source history or automatic judgments", () => {
  const all = [...records, view];
  const result = evaluate({
    events: all.map((row) => JSON.stringify(row.envelope)),
    bodies: Object.fromEntries(
      all.map((row) => [row.envelope.id, JSON.stringify(row.body)]),
    ),
    selected_view: view.envelope.id,
    import_selections: { [manifest.selection]: [] },
  });
  assert.equal(result.available, true);
  for (const row of records) {
    assert.equal(result.publications[row.envelope.id].status, "active");
    assert.equal(result.publications[row.envelope.id].content_available, true);
  }
  assert.equal(
    all.some((row) => row.envelope.header.action.kind === "judgment.set"),
    false,
  );
});

test("the existing proposal loader admits the fixture once and reuses its exact records", async () => {
  const parent = process.env.JVC_TEST_ROOT ?? tmpdir();
  await mkdir(parent, { recursive: true });
  const data = await mkdtemp(join(parent, "place-conversion-fixture-"));
  try {
    const proposal = fileURLToPath(directory);
    const first = await loadImportProposal({ proposal, directory: data });
    assert.equal(first.accepted, 31);
    assert.equal(first.duplicate, 0);
    assert.equal(first.view, manifest.view);
    const second = await loadImportProposal({ proposal, directory: data });
    assert.equal(second.accepted, 0);
    assert.equal(second.duplicate, 31);
    assert.equal(second.position, first.position);
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});
