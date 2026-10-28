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
    ["i", "je", "bo"],
  );
  assert.deepEqual(
    localSearch(source, "i klama i").map((hit) => hit.word.spelling),
    ["i", "klama"],
  );
});
