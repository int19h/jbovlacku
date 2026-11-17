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
  // bare "RangeError: ..." with a null error object.
  const memory = await crashedSearch(
    page,
    "throw new RangeError('review allocation failure');",
  );
  expect(memory).toContain("does not fit");
  // An ordinary code bug keeps the startup message, even though the previous
  // crash already reported a memory failure: a prior reply alone never
  // classifies a later crash.
  const bug = await crashedSearch(page, "throw new Error('review code bug');");
  expect(bug).toContain("could not start");
});
