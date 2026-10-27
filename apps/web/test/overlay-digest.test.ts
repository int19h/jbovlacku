import { test, expect, type Page } from "@playwright/test";
import { corePath } from "./helpers.ts";

async function harness(page: Page) {
  await page.route("**/authority-harness", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Authority test</title>",
    }),
  );
  await page.goto("/authority-harness");
}

test("site calculation and browser session metadata use the same null overlay digest", async ({
  page,
}) => {
  await harness(page);
  const result = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { nullOverlayDigest } = await import(String("/src/data/personal.ts"));
    const seed = new Uint8Array(32).fill(21);
    const identity = core.identityFromSeed(seed);
    const word = { language: "jbo", spelling: "banli" };
    const definition = core.createEvent(
      seed,
      [],
      "1".repeat(32),
      {
        kind: "definition.publish",
        word: core.wordId(word),
        language: "en",
        parents: [],
        origin: "native",
      },
      {
        word,
        language: "en",
        text: [["Synthetic definition."]],
        classification: { kind: "gismu" },
        license: { expression: "CC0-1.0" },
      },
    );
    const view = core.createEvent(
      seed,
      [],
      "2".repeat(32),
      { kind: "view.publish", parents: [] },
      {
        name: "Synthetic view",
        description: [],
        roots: [{ identity, q: { numerator: 1, denominator: 1 } }],
        rafsi_threshold: { numerator: 1, denominator: 1 },
        H: { numerator: 3, denominator: 1 },
        alpha: { numerator: 1, denominator: 2 },
        excluded: [],
        calculation: "simple-routes-bounds-v1",
        work: 1000,
        import_sets: [],
        account_witnesses: [],
        account_authority: false,
        notes: [],
      },
    );
    const blessing = core.createEvent(
      seed,
      [],
      "3".repeat(32),
      { kind: "judgment.set", target: definition.envelope.id, value: "bless" },
      null,
    );
    const input = {
      events: [definition, view, blessing].map((record) =>
        JSON.stringify(record.envelope),
      ),
      bodies: Object.fromEntries(
        [definition, view].map((record) => [
          record.envelope.id,
          core.canonicalize(core.utf8(JSON.stringify(record.body))),
        ]),
      ),
      selected_view: view.envelope.id,
      import_selections: {},
      overlay: null,
    };
    const site = core.rankWord(input, core.wordId(word));
    const empty = {
      version: 1,
      base_view: view.envelope.id,
      root_changes: [],
      trust: [],
      blocked: [],
      work: null,
    };
    const explicit = core.rankWord(
      { ...input, overlay: empty },
      core.wordId(word),
    );
    return {
      site: site.calculation.overlay,
      browser: nullOverlayDigest(),
      explicit: explicit.calculation.overlay,
      expectedExplicit: core.contentHash(
        core.utf8(core.canonicalize(core.utf8(JSON.stringify(empty)))),
      ),
      sameScores:
        JSON.stringify(site.scores) === JSON.stringify(explicit.scores),
    };
  }, corePath);
  expect(result.site).toBe(result.browser);
  expect(result.explicit).toBe(result.expectedExplicit);
  expect(result.site).not.toBe(result.explicit);
  expect(result.sameScores).toBe(true);
});
