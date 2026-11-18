import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initializeCore } from "../../../../packages/core/src/index.ts";
import type { PackageEntry } from "../../src/model/types.ts";

Object.assign(globalThis, {
  location: new URL("http://local.invalid"),
  history: { state: null },
});

await initializeCore(
  await readFile(
    new URL(
      "../../../../packages/core/generated/jvc_runtime_bg.wasm",
      import.meta.url,
    ),
  ),
);
const {
  cappedHitEntries,
  distinctHitRafsi,
  previewEntryForHit,
  summarizeHitEntries,
  takeRafsiRows,
  HIT_CONTENT_LIMIT,
} = await import("../../src/data/package-search.ts");
const { localSearch } = await import("../../src/data/search.ts");

const entry = (index: number): PackageEntry => ({
  event: "jve1:" + (index + 1).toString(16).padStart(64, "0"),
  word: { language: "jbo", spelling: "broda" },
  language: "en",
  glosses: [{ language: "en", text: "book", sense: null }],
  plain_text: `x${index} is a book`,
  classification: { kind: "gismu", selmaho: [] },
  body: null,
});

test("capped entries keep the strongest first entries of a huge hit", () => {
  const entries = Array.from({ length: HIT_CONTENT_LIMIT + 5 }, (_, index) =>
    entry(index),
  );
  const shown = cappedHitEntries({ entries } as never);
  assert.equal(shown.length, HIT_CONTENT_LIMIT);
  assert.equal(shown[0], entries[0]);
  assert.equal(shown[HIT_CONTENT_LIMIT - 1], entries[HIT_CONTENT_LIMIT - 1]);
  const small = [entry(0), entry(1)];
  assert.equal(cappedHitEntries({ entries: small } as never), small);
});

test("rafsi rows stop at the display limit instead of visiting the rest", () => {
  let firstPulls = 0;
  let secondPulls = 0;
  const counting = (count: number, bump: () => void) => {
    const spellings = Array.from(
      { length: count },
      (_, index) => `raf${index}`,
    );
    return {
      [Symbol.iterator]() {
        const inner = spellings[Symbol.iterator]();
        return {
          next() {
            bump();
            return inner.next();
          },
        };
      },
    };
  };
  const hits = [
    {
      word_id: "one",
      word: { spelling: "broda" },
      matchingRafsi: counting(100000, () => {
        firstPulls++;
      }),
    },
    {
      word_id: "two",
      word: { spelling: "brodax" },
      matchingRafsi: counting(100000, () => {
        secondPulls++;
      }),
    },
  ];
  const found = new Map<string, { spelling: string; language: string; rafsi: string }>();
  const filled = takeRafsiRows(
    hits as never,
    "en",
    found,
    1000,
  );
  assert.equal(filled, true);
  assert.equal(found.size, 1000);
  // 1,000 rows plus the one spelling that proves more exist.
  assert.ok(firstPulls <= 1002, `visited ${firstPulls} spellings`);
  // The second hit is never visited once the rows are full.
  assert.equal(secondPulls, 0);
});

test("a later language's row replaces an existing word-and-rafsi key", () => {
  const found = new Map<
    string,
    { spelling: string; language: string; rafsi: string }
  >();
  const same = [
    {
      word_id: "one",
      word: { spelling: "broda" },
      matchingRafsi: ["bau"],
    },
  ];
  assert.equal(takeRafsiRows(same as never, "en", found, 1000), false);
  assert.equal(found.get("one|bau")?.language, "en");
  assert.equal(takeRafsiRows(same as never, "fr", found, 1000), false);
  assert.equal(found.size, 1);
  assert.equal(found.get("one|bau")?.language, "fr");
});

test("a replacement past the cap fills nothing and sets no limit", () => {
  const found = new Map<
    string,
    { spelling: string; language: string; rafsi: string }
  >();
  const full = [
    {
      word_id: "one",
      word: { spelling: "broda" },
      matchingRafsi: Array.from({ length: 1000 }, (_, index) => `raf${index}`),
    },
  ];
  assert.equal(takeRafsiRows(full as never, "en", found, 1000), false);
  assert.equal(found.size, 1000);
  const dup = [
    {
      word_id: "one",
      word: { spelling: "broda" },
      matchingRafsi: ["raf0"],
    },
  ];
  assert.equal(takeRafsiRows(dup as never, "fr", found, 1000), false);
  assert.equal(found.get("one|raf0")?.language, "fr");
  const novel = [
    {
      word_id: "one",
      word: { spelling: "broda" },
      matchingRafsi: ["rafX"],
    },
  ];
  assert.equal(takeRafsiRows(novel as never, "fr", found, 1000), true);
});

test("rafsi rows deduplicate repeat spellings without filling", () => {
  const hits = [
    {
      word_id: "one",
      word: { spelling: "broda" },
      matchingRafsi: ["raf0", "raf1"],
    },
    {
      word_id: "one",
      word: { spelling: "broda" },
      matchingRafsi: ["raf0", "raf1"],
    },
  ];
  const found = new Map<string, { spelling: string; language: string; rafsi: string }>();
  const filled = takeRafsiRows(hits as never, "en", found, 1000);
  assert.equal(filled, false);
  assert.equal(found.size, 2);
  const refilled = takeRafsiRows(hits as never, "fr", found, 1000);
  assert.equal(refilled, false);
  assert.equal(found.size, 2);
});

test("part summaries keep every entry in order with bounded text", () => {
  const entries = [
    entry(0),
    { ...entry(1), glosses: [] },
    { ...entry(2), glosses: [], plain_text: "x".repeat(10000) },
  ];
  const rows = summarizeHitEntries(entries as never);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    event: entries[0].event,
    summary: "book",
  });
  assert.equal(rows[1].event, entries[1].event);
  assert.equal(rows[1].summary, "x1 is a book");
  assert.equal(rows[2].summary, "x".repeat(60));
  assert.equal(rows[2].summary.length, 60);
});

test("part rafsi keep every distinct spelling in first-occurrence order", () => {
  const v2 = (index: number, rafsi: string[]) => ({
    ...entry(index),
    issuer: "ed25519:" + "a".repeat(64),
    notes: false,
    rafsi,
    rafsi_complete: true,
    attribution: null,
  });
  const rafsi = distinctHitRafsi(
    [v2(0, ["raf0", "raf1"]), v2(1, ["raf1", "raf2"]), v2(2, [])] as never,
  );
  assert.deepEqual(rafsi, ["raf0", "raf1", "raf2"]);
  assert.deepEqual(distinctHitRafsi([entry(0)] as never), []);
});

test("the row entry is the hit's first entry when it previews", () => {
  const entries = [entry(0), entry(1), entry(2)];
  const hit = { entries } as never;
  assert.equal(previewEntryForHit(hit, entries[0].event), entries[0]);
  assert.equal(previewEntryForHit(hit, entries[2].event), undefined);
  assert.equal(previewEntryForHit(hit, "jve1:" + "f".repeat(64)), undefined);
  assert.equal(
    previewEntryForHit({ entries: [] } as never, entries[0].event),
    undefined,
  );
});

test("local grouping keeps the preview entry first", () => {
  // Characterization: pages read entries[0] instead of scanning, so the
  // engine must keep the preview first across merge orders.
  for (const order of [
    [0, 1, 2],
    [2, 1, 0],
    [1, 2, 0],
  ]) {
    const hits = localSearch(order.map((index) => entry(index)) as never, "book");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.entries[0]!.event, hits[0]!.preview!.event);
  }
});
