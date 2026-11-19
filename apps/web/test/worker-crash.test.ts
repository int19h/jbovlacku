import { test, expect } from "@playwright/test";
import { corePath } from "./helpers.ts";

/** Runs one local search against a worker whose script throws on load. */
async function crashedSearch(
  page: import("@playwright/test").Page,
  script: string,
) {
  await page.goto("/");
  await page.route("**/package-search-worker.ts*", (route) =>
    route.fulfill({ contentType: "text/javascript", body: script }),
  );
  return page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { searchPackage } = await import(
      String("/src/data/package-search.ts")
    );
    const entries = Array.from({ length: 10 }, (_, index) => ({
      event: "jve1:" + (index + 1).toString(16).padStart(64, "0"),
      word: { language: "jbo", spelling: "broda" },
      language: "en",
      glosses: [{ language: "en", text: "book", sense: null }],
      plain_text: "x1 is a book",
      classification: { kind: "gismu", selmaho: [] },
      body: null,
    }));
    try {
      await searchPackage(
        { snapshot: "sha256:" + "a".repeat(64), entries },
        "en",
        ["book"],
      );
      return "resolved";
    } catch (error) {
      return (error as Error).message;
    }
  }, corePath);
}

test("worker crashes classify by cause, not history", async ({ page }) => {
  // The error event carries the allocation failure in both engines:
  // Chromium reports "Uncaught RangeError: ..." and Firefox reports the
  // bare "RangeError: ..." with a null error object. Only an allocation
  // failure in either engine's wording reports does-not-fit.
  const memory = await crashedSearch(
    page,
    "throw new RangeError('Array buffer allocation failed');",
  );
  expect(memory).toContain("does not fit");
  // An ordinary code bug keeps the startup message, even though the previous
  // crash already reported a memory failure: a prior reply alone never
  // classifies a later crash.
  const bug = await crashedSearch(page, "throw new Error('review code bug');");
  expect(bug).toContain("could not start");
});

test("an invalid array length keeps the startup message", async ({ page }) => {
  // `new Array(-1)` throws "Invalid array length" without allocating
  // anything, in both engines' wording, so freeing storage cannot repair
  // it and the page must not report does-not-fit.
  const crash = await crashedSearch(page, "new Array(-1);");
  expect(crash).toContain("could not start");
  expect(crash).not.toContain("does not fit");
});

test("an out-of-bounds crash keeps the startup message", async ({ page }) => {
  // A DataView bounds error is a RangeError in both engines, but it is not
  // an allocation failure, so the page must not report does-not-fit.
  const bounds = await crashedSearch(
    page,
    "new DataView(new ArrayBuffer(1)).getUint32(2);",
  );
  expect(bounds).toContain("could not start");
  expect(bounds).not.toContain("does not fit");
});
