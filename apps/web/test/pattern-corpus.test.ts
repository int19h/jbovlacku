import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

test("R2 real English positive patterns complete in the browser worker", async ({
  page,
}) => {
  test.skip(
    !process.env.JVC_PATTERN_EN_KEYS,
    "Set JVC_PATTERN_EN_KEYS to the pinned 33,267-key English export.",
  );
  const spellings = readFileSync(process.env.JVC_PATTERN_EN_KEYS!, "utf8")
    .trimEnd()
    .split("\n");
  expect(spellings).toHaveLength(33_267);
  await page.goto("/");
  const result = await page.evaluate(async (spellings) => {
    const { searchPackage } = await import(
      String("/src/data/package-search.ts")
    );
    const pkg = {
      snapshot: "sha256:" + "d".repeat(64),
      entries: spellings.map((spelling, index) => ({
        event: "jve1:" + (index + 1).toString(16).padStart(64, "0"),
        word: { language: "jbo", spelling },
        language: "en",
        glosses: [],
        plain_text: "",
        classification: { kind: "other", selmaho: [] },
        body: null,
      })),
    };
    const rows: {
      query: string;
      words: number;
      scanned: number;
      prepared: boolean;
    }[] = [];
    for (const query of [
      "$@$$@$$@",
      "$$@$@$$@",
      "$@$$@$$@*",
      String.raw`/^\w{3,8}$/`,
      String.raw`/^\w{10,}$/`,
      "*zei*",
    ]) {
      const found = await searchPackage(pkg, "en", [query]);
      rows.push({
        query,
        words: found.totals[0],
        scanned: found.metrics.entries,
        prepared: found.prepared,
      });
    }
    return rows;
  }, spellings);
  expect(result.map((row) => row.words)).toEqual([
    1692, 317, 2547, 10541, 3284, 194,
  ]);
  expect(result.map((row) => row.scanned)).toEqual(Array(6).fill(33_267));
  expect(result.map((row) => row.prepared)).toEqual([
    true,
    false,
    false,
    false,
    false,
    false,
  ]);
});
