import { test, expect } from "@playwright/test";
import { corePath } from "./helpers.ts";

test("browser core and personal scores keep an effective definition in the first layer after a concurrent publisher transfer", async ({
  page,
}) => {
  await page.goto("/");
  const results = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const word = { language: "jbo", spelling: "tcrecfihi" };
    const wordId = core.wordId(word);
    const definition = (seed: number, nonce: string) =>
      core.createEvent(
        new Uint8Array(32).fill(seed),
        [],
        nonce,
        {
          kind: "definition.publish",
          word: wordId,
          language: "en",
          parents: [],
          origin: "native",
        },
        {
          word,
          language: "en",
          text: [["A synthetic receipt ranking case."]],
          frame: null,
          operands: [],
          glosses: [],
          notes: [],
          etymology: { text: [], formation: null, compound: null },
          examples: [],
          classification: { kind: "other", selmaho: [] },
          labels: [],
          sources: [],
          license: {
            expression: "CC0-1.0",
            url: "https://creativecommons.org/publicdomain/zero/1.0/",
            attribution: "",
          },
          legacy: null,
        },
      );
    const visible = definition(234, "a1".repeat(16));
    const hidden = definition(235, "a2".repeat(16));
    const root = new Uint8Array(32).fill(237);
    const transfer = core.createEvent(
      new Uint8Array(32).fill(235),
      [],
      "a3".repeat(16),
      {
        kind: "identity.transfer",
        successor: core.identityFromSeed(new Uint8Array(32).fill(236)),
      },
      null,
    );
    const judgment = core.createEvent(
      root,
      [],
      "a4".repeat(16),
      { kind: "judgment.set", target: hidden.envelope.id, value: "bless" },
      null,
    );
    const view = core.createEvent(
      root,
      [],
      "a5".repeat(16),
      { kind: "view.publish", parents: [] },
      {
        name: "Synthetic receipt view",
        description: [],
        notes: [],
        roots: [
          {
            identity: core.identityFromSeed(root),
            q: { numerator: 1, denominator: 1 },
          },
        ],
        rafsi_threshold: { numerator: 1, denominator: 1 },
        H: { numerator: 3, denominator: 1 },
        alpha: { numerator: 1, denominator: 2 },
        excluded: [],
        calculation: "simple-routes-bounds-v1",
        work: 1000,
        import_sets: [],
        account_witnesses: [],
        account_authority: false,
      },
    );
    const records = [visible, hidden, transfer, judgment, view];
    const input = {
      events: records.map((record) =>
        core.canonicalize(core.utf8(JSON.stringify(record.envelope))),
      ),
      bodies: Object.fromEntries(
        records
          .filter((record) => record.body !== null)
          .map((record) => [
            record.envelope.id,
            core.canonicalize(core.utf8(JSON.stringify(record.body))),
          ]),
      ),
      selected_view: view.envelope.id,
      import_selections: {},
    };
    const site = core.rankWord(input, wordId);
    const session = core.evaluateSession({
      ...input,
      overlay: {
        version: 1,
        base_view: view.envelope.id,
        root_changes: [],
        trust: [],
        blocked: [],
        work: null,
      },
    });
    try {
      const rank = session.rankWord(wordId);
      const snapshot = "sha256:" + "1".repeat(64);
      const { viewScores } = await import(
        String("/src/components/localview.ts")
      );
      const personal = await viewScores(
        {
          session: { preferences: { viewMode: "personal" } },
          personal: {
            rankWord: async () => ({
              ...rank,
              snapshot,
              view: view.envelope.id,
            }),
          },
        } as any,
        wordId,
        { snapshot, view: view.envelope.id } as any,
      );
      return {
        visible: visible.envelope.id,
        hidden: hidden.envelope.id,
        receipt: session.state.receipts[hidden.envelope.id],
        site,
        personal,
      };
    } finally {
      session.free();
    }
  }, corePath);
  expect(results.receipt.interpretation).toBe("inert");
  for (const rank of [results.site, results.personal]) {
    expect(rank.layers).toEqual([[results.visible]]);
    expect(
      rank.scores.map((score: { target: string }) => score.target),
    ).toEqual([results.visible]);
    expect(rank.unavailable_scores).toEqual([]);
  }
  expect(results.personal.personal).toBe(true);
  expect(results.personal.reason).toBeNull();
});
