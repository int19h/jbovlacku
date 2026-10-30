import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { before, test } from "node:test";
import { initializeCore, type Evaluation } from "../../core/src/index.ts";
import { PatternError } from "../../search/src/pattern.ts";
import { lexicalSearchAsync } from "../src/lexical-search.ts";
import type { SearchEntry } from "../src/packages.ts";

before(async () => {
  await initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  );
});

const entries: SearchEntry[] = ["klama", "kargu"].map((spelling) => ({
  event: spelling,
  word: { language: "jbo", spelling },
  language: "en",
  glosses: [{ text: "k*" }],
  plain_text: "A synthetic definition.",
  classification: { kind: "gismu" },
  body: "body",
}));
const evaluation = {
  publications: Object.fromEntries(
    entries.map(({ event }) => [
      event,
      { word: event, eligible: "eligible", status: "active" },
    ]),
  ),
  receipts: Object.fromEntries(
    entries.map(({ event }) => [event, { interpretation: "effective" }]),
  ),
} as unknown as Evaluation;

test("the default scanner stops at five seconds inside a rafsi list without partial hits", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  let visited = 0;
  const slowRafsi = ["kar", "kau", "kaz"];
  for (let index = 0; index < slowRafsi.length; index++)
    Object.defineProperty(slowRafsi, index, {
      get() {
        visited++;
        now = index ? 5000 : 4999;
        return "kar";
      },
    });
  await assert.rejects(
    lexicalSearchAsync(entries, "k*", "en", evaluation, false, {
      klama: ["kla"],
      kargu: slowRafsi,
    }),
    (error: unknown) =>
      error instanceof PatternError && error.code === "pattern_timeout",
  );
  assert.equal(visited, 2);
  const hits = await lexicalSearchAsync(entries, "k*", "en", evaluation);
  assert.equal(hits.length, 2);
});

test("the default scanner observes cancellation during a rafsi scan", async () => {
  const controller = new AbortController();
  const reason = new Error("Synthetic scan cancellation.");
  const rafsi = ["kar", "kau"];
  let visited = 0;
  Object.defineProperty(rafsi, 0, {
    get() {
      visited++;
      controller.abort(reason);
      return "kar";
    },
  });
  await assert.rejects(
    lexicalSearchAsync(
      entries,
      "k*",
      "en",
      evaluation,
      false,
      { kargu: rafsi },
      undefined,
      controller.signal,
    ),
    (error: unknown) => error === reason,
  );
  assert.equal(visited, 1);
});

test("plain and literal searches need no pattern scanner", async () => {
  const plain = await lexicalSearchAsync(entries, "klama", "en", evaluation);
  assert.equal(plain[0].match, "headword");
  const literal = await lexicalSearchAsync(
    entries,
    "k*",
    "en",
    evaluation,
    false,
    {},
    undefined,
    undefined,
    { patterns: false, group: "definitions" },
  );
  assert.equal(literal.length, 2);
  assert.ok(literal.every((hit) => hit.match === "gloss"));
});
