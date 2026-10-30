import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  initializeCore,
  wordId,
  type Evaluation,
} from "../../../../packages/core/src/index.ts";
import { lexicalSearch } from "../../../../packages/service/src/lexical-search.ts";
import type { SearchEntry } from "../../../../packages/service/src/packages.ts";
import type { PackageEntry, SearchHit } from "../../src/model/types.ts";
let localSearch: typeof import("../../src/data/search.ts").localSearch;
before(async () => {
  await initializeCore(
    await readFile(
      new URL(
        "../../../../packages/core/generated/jvc_runtime_bg.wasm",
        import.meta.url,
      ),
    ),
  );
  Object.assign(globalThis, {
    location: new URL("http://local.invalid"),
    history: { state: null },
  });
  localSearch = (await import("../../src/data/search.ts")).localSearch;
});
const entries = (spellings: string[]): PackageEntry[] =>
  spellings.map((spelling, index) => ({
    event: "jve1:" + (index + 1).toString(16).padStart(64, "0"),
    word: { language: "jbo", spelling },
    language: "en",
    glosses: [],
    plain_text: "Synthetic definition.",
    classification: { kind: "cmavo", selmaho: [] },
    body: null,
  }));

test("local and server search share sequence rank, fallback order, display, and query limits", () => {
  const source = entries([
    "i",
    "je",
    "bo",
    "klama",
    "tai",
    "a",
    "taia",
    "ibo",
    "iboku",
    "iseri'abo",
    "dján",
    "djan",
    "pa",
    "ri'a",
    "ije",
    "le",
    "nu",
    "lenu",
    "mi",
  ]);
  const evaluation = {
    publications: Object.fromEntries(
      source.map((row) => [
        row.event,
        { word: wordId(row.word), eligible: "eligible", status: "active" },
      ]),
    ),
    receipts: Object.fromEntries(
      source.map((row) => [row.event, { interpretation: "effective" }]),
    ),
  } as unknown as Evaluation;
  const shape = (
    hits: {
      word: unknown;
      word_id: string;
      match: SearchHit["match"];
      definitions: string[];
    }[],
  ) =>
    hits.map(({ word, word_id, match, definitions }) => ({
      word,
      word_id,
      match,
      definitions,
    }));
  for (const query of [
    "klama.",
    "(klama)",
    ".i",
    "1",
    "riha",
    "klama mibaoz",
    "mibaoz klama",
    "ijebo klama",
    "le nu klama",
    "i seri'a bo",
    "ise ri'abo",
    "iseri'abo",
    "I SE RÍ’ABO",
    "i bo",
    "mi klama i seri'a bo",
    "ijebo",
    "i klama i",
    "taia",
    "tai a",
    "DJÁN",
    [...Array(99).fill("mi"), "bo"].join(" "),
    "i".repeat(129),
  ]) {
    const server = lexicalSearch(
      source as unknown as SearchEntry[],
      query,
      "en",
      evaluation,
    );
    const local = localSearch(source, query);
    assert.deepEqual(shape(local), shape(server), query);
    assert.equal(local.segmentation, server.segmentation, query);
  }
  assert.deepEqual(
    localSearch(source, "ijebo").map((hit) => hit.word.spelling),
    ["ije", "bo"],
  );
  assert.deepEqual(
    localSearch(source, "i klama i").map((hit) => hit.word.spelling),
    ["i", "klama"],
  );
});

test("known-word ordering agrees locally and remotely for whole query tokens and retired eligibility", () => {
  const source = entries(["lo", "ve", "ti", "me", "mi", "klama", "iseri'abo"]);
  const view = "jve1:" + "a".repeat(64);
  const evaluation = {
    publications: Object.fromEntries(
      source.map((row) => [
        row.event,
        { word: wordId(row.word), eligible: "eligible", status: "active" },
      ]),
    ),
    receipts: Object.fromEntries(
      source.map((row) => [row.event, { interpretation: "effective" }]),
    ),
  } as unknown as Evaluation;
  for (const row of source) row.search_status = { view, status: "active" };
  for (const [query, expected] of [
    ["love", false],
    ["time", false],
    ["klama", true],
    ["mi klama", true],
    ["iseri'abo", true],
  ] as const) {
    for (const group of ["lojban", "definitions"] as const) {
      assert.equal(
        localSearch(source, query, undefined, false, { group, view }).allLojban,
        expected,
        query,
      );
      assert.equal(
        lexicalSearch(
          source as unknown as SearchEntry[],
          query,
          "en",
          evaluation,
          false,
          undefined,
          {},
          { group },
        ).allLojban,
        expected,
        query,
      );
    }
  }
  source[5].search_status!.status = "retired";
  evaluation.publications[source[5].event].status = "deprecated";
  for (const includeRetired of [false, true])
    for (const query of ["klama", "mi klama"])
      assert.equal(
        localSearch(source, query, undefined, false, { view, includeRetired })
          .allLojban,
        lexicalSearch(
          source as unknown as SearchEntry[],
          query,
          "en",
          evaluation,
          includeRetired,
        ).allLojban,
      );
  evaluation.publications[source[5].event].status = "unknown" as any;
  assert.equal(
    localSearch(source, "klama", undefined, false, {
      view,
      includeRetired: true,
    }).allLojban,
    lexicalSearch(
      source as unknown as SearchEntry[],
      "klama",
      "en",
      evaluation,
      true,
    ).allLojban,
  );
  source[5].search_status!.status = "ineligible";
  evaluation.publications[source[5].event].eligible = "unknown";
  assert.equal(
    localSearch(source, "mi klama", undefined, false, {
      view,
      includeRetired: true,
    }).allLojban,
    false,
  );
  assert.equal(
    localSearch(
      source.map(({ search_status, ...row }) => row),
      "klama",
    ).allLojban,
    false,
  );
});
