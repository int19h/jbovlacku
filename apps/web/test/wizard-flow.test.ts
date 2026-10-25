import { test, expect, type Page } from "@playwright/test";
import {
  acceptFirstSignature,
  corePath,
  createIdentity,
  PASSPHRASE,
} from "./helpers.ts";

test.use({ actionTimeout: 10000 });
test.setTimeout(30000);

async function open(page: Page, path: string) {
  await page.evaluate(async (path) => {
    const { navigate } = await import(String("/src/app/router.ts"));
    navigate(path);
  }, path);
}

async function stored(page: Page) {
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().get("drafts", "current");
  });
}

/** Synthetic package entries and disposable drafts stay in this browser. */
async function seed(
  page: Page,
  options: {
    kind?: string;
    spelling?: string;
    compound?: boolean;
    selected?: string;
    formation?: boolean;
    cut?: boolean;
    competitors?: string[];
    step?: number;
    claims?: boolean;
  } = {},
) {
  await page.evaluate(
    async ({ options, corePath }) => {
      const core = await import(corePath);
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { newDraft } = await import(String("/src/model/draft.ts"));
      const builders = await import(String("/src/model/builders.ts"));
      const store = new LocalStore();
      const rows = [
        {
          language: "en",
          name: "English",
          word: "book",
          input: "cukta",
          weight: { numerator: "1", denominator: "1" },
        },
      ];
      const components = [
        {
          id: "a",
          spelling: "cukta",
          kind: "gismu",
          definition: null,
          gloss: "book",
          claims: [
            {
              rafsi: "cku",
              pair: core.rafsiPairId(
                core.wordId({ language: "jbo", spelling: "cukta" }),
                "cku",
              ),
            },
          ],
          locked: null,
        },
        {
          id: "b",
          spelling: "valsi",
          kind: "gismu",
          definition: null,
          gloss: "word",
          claims: [
            {
              rafsi: "vla",
              pair: core.rafsiPairId(
                core.wordId({ language: "jbo", spelling: "valsi" }),
                "vla",
              ),
            },
          ],
          locked: null,
        },
      ];
      const result = core.buildLujvo({ profile: "cll", components });
      const candidate = result.candidates[0];
      const spelling =
        options.spelling ?? (options.compound ? candidate.spelling : "cukta");
      const draft = newDraft({
        spelling,
        kind: options.kind ?? (options.compound ? "lujvo" : "gismu"),
        meaning: "A disposable meaning.",
        text: "A disposable meaning.",
        structured: false,
        step: options.step ?? 5,
        compound: options.compound
          ? builders.compoundMetadata(result, candidate, components, "")
          : null,
        formation: options.formation
          ? builders.manualFormation(rows, "Historical evidence.")
          : null,
        evidenceForm: options.compound || options.formation ? spelling : null,
        lujvo: {
          ...builders.newLujvoState(),
          components,
          selected: options.selected ?? null,
        },
        gismu: {
          ...builders.newGismuState(),
          rows,
          manual: "cukte",
          selected: "cukte",
        },
        rafsiClaims: options.claims
          ? [{ rafsi: "cku", rationale: "Disposable claim." }]
          : [],
      });
      if (!options.formation && !options.selected) draft.gismu = null;
      await store.put("drafts", "current", draft);
      const spellings = ["cukta", "valsi", ...(options.competitors ?? [])];
      await store.put("packages", "en", {
        version: 2,
        snapshot: "sha256:" + "a".repeat(64),
        entries: spellings.map((spelling, i) => ({
          event: "jve1:" + String(i + 1).repeat(64),
          word: { language: "jbo", spelling },
          language: "en",
          glosses: [],
          plain_text: "Synthetic entry.",
          classification: { kind: "gismu", selmaho: [] },
          body: null,
          issuer: "ed25519:" + "1".repeat(64),
          notes: false,
          attribution: null,
          rafsi: spelling === "valsi" ? ["vla"] : ["cku"],
          rafsi_complete: !(options.cut && spelling === "cukta"),
        })),
      });
    },
    { options, corePath },
  );
}

test("the referent shortcut names its broad meaning and retired hints need deliberate replacement", async ({
  page,
}) => {
  await createIdentity(page);
  await seed(page);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { newPlace } = await import(String("/src/model/draft.ts"));
    const store = new LocalStore();
    const draft: any = await store.get("drafts", "current");
    draft.structured = true;
    draft.text = [[1, " has a fixture meaning."]];
    draft.frameMode = "fixed";
    draft.numberingApproved = true;
    draft.places = [
      {
        ...newPlace(1),
        kind: "custom",
        hint: {
          alternatives: [
            { tags: ["mass"], abstractor: null, relation_arity: null },
          ],
          note: [["Retained annotation."]],
        },
      },
    ];
    await store.put("drafts", "current", draft);
  });
  await open(page, "/new/editor");
  const kind = page.getByRole("combobox", {
    name: "Kind of thing for place 1",
  });
  await expect(kind.locator('option[value="object"]')).toHaveText(
    "anything (referent)",
  );
  await expect(page.locator("main")).toContainText(
    'keeps the retired tag "mass"',
  );
  await expect(page.locator("main")).toContainText(
    "mass is an opaque legacy annotation outside the current tag tree and has no current alias.",
  );
  await expect(page.getByRole("button", { name: /Replace mass/ })).toHaveCount(
    0,
  );
  expect((await stored(page)).places[0].hint.alternatives[0].tags).toEqual([
    "mass",
  ]);
  await kind.selectOption("object");
  await expect
    .poll(async () => (await stored(page)).places[0].kind)
    .toBe("object");
  await expect(page.locator("main")).not.toContainText(
    'keeps the retired tag "mass"',
  );
  const hints = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { draftToBody } = await import(String("/src/model/draft.ts"));
    const draft: any = await new LocalStore().get("drafts", "current");
    return draftToBody(draft).body!.frame!.places[0].type_hints;
  });
  expect(hints[0].alternatives[0].tags).toEqual(["referent"]);
});

for (const [tag, replacement] of [
  ["entity", "referent"],
  ["tuple", "sequence"],
]) {
  test(`the author explicitly replaces ${tag} with ${replacement} without changing other annotations`, async ({
    page,
  }) => {
    await createIdentity(page);
    await seed(page);
    await page.evaluate(
      async ({ tag, replacement }) => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        const { newPlace } = await import(String("/src/model/draft.ts"));
        const store = new LocalStore();
        const draft: any = await store.get("drafts", "current");
        draft.structured = true;
        draft.text = [[1, " has a fixture meaning."]];
        draft.frameMode = "fixed";
        draft.numberingApproved = true;
        draft.places = [
          {
            ...newPlace(1),
            kind: "custom",
            hint: {
              alternatives: [
                {
                  tags: [tag, replacement].sort(),
                  abstractor: "ka",
                  relation_arity: { mode: "fixed", count: 2 },
                },
              ],
              note: [[1, " keeps this exact note."]],
            },
          },
        ];
        await store.put("drafts", "current", draft);
      },
      { tag, replacement },
    );
    await open(page, "/new/editor");
    await expect(page.locator("main")).toContainText(
      `${tag} means ${replacement}.`,
    );
    await expect(page.locator("main")).not.toContainText(
      "The original signed body stays valid.",
    );
    const before = (await stored(page)).places[0].hint;
    expect(before.alternatives[0].tags).toContain(tag);
    await page
      .getByRole("button", {
        name: `Replace ${tag} with ${replacement}`,
        exact: true,
      })
      .click();
    await expect
      .poll(
        async () => (await stored(page)).places[0].hint.alternatives[0].tags,
      )
      .toEqual([replacement]);
    const after = (await stored(page)).places[0].hint;
    expect(after.note).toEqual(before.note);
    expect(after.alternatives[0].abstractor).toBe("ka");
    expect(after.alternatives[0].relation_arity).toEqual({
      mode: "fixed",
      count: 2,
    });
    await expect(page.locator("main")).not.toContainText(
      `keeps the retired tag "${tag}"`,
    );
    const tags = page.getByRole("textbox", { name: "Tags for alternative 1" });
    await tags.fill(tag);
    await expect(tags).toBeFocused();
    await expect(tags).toHaveValue(tag);
    await expect(
      page.getByRole("button", {
        name: `Replace ${tag} with ${replacement}`,
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", {
        name: `Replace ${tag} with ${replacement}`,
        exact: true,
      })
      .click();
    await expect
      .poll(
        async () => (await stored(page)).places[0].hint.alternatives[0].tags,
      )
      .toEqual([replacement]);
    const edited = (await stored(page)).places[0].hint;
    expect(edited.note).toEqual(before.note);
    expect(edited.alternatives[0].abstractor).toBe("ka");
    expect(edited.alternatives[0].relation_arity).toEqual({
      mode: "fixed",
      count: 2,
    });
  });
}

test("another source word starts without the first word's pronunciation or stem", async ({
  page,
}) => {
  await createIdentity(page);
  await seed(page, { formation: true });
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const draft: any = await store.get("drafts", "current");
    Object.assign(draft.gismu.rows[0], {
      word_ipa: "bʊk",
      stem: "book",
      ipa: "bʊk",
    });
    await store.put("drafts", "current", draft);
  });
  await open(page, "/new/gismu");
  await page
    .getByRole("button", { name: "Add an alternative word for English" })
    .click();
  await expect.poll(async () => (await stored(page)).gismu.rows.length).toBe(2);
  const rows = (await stored(page)).gismu.rows;
  expect(rows[0].word_ipa).toBe("bʊk");
  expect(rows[0].stem).toBe("book");
  expect(rows[0].ipa).toBe("bʊk");
  expect(rows[1]).toMatchObject({
    language: "en",
    name: "English",
    word: "",
    input: "",
    word_ipa: null,
    stem: null,
    ipa: null,
    weight: rows[0].weight,
  });
});

test("draft export keeps private source evidence while publication and Revise keep signed fields only", async ({
  page,
}) => {
  await createIdentity(page);
  await seed(page, { formation: true, spelling: "brodo" });
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const draft: any = await store.get("drafts", "current");
    const privateEvidence = { word_ipa: "bʊk", stem: "book", ipa: "bʊk" };
    Object.assign(draft.gismu.rows[0], privateEvidence, {
      notes: [["An authored source note."]],
    });
    Object.assign(draft.formation.sources[0], {
      word_ipa: privateEvidence.word_ipa,
      notes: [["An authored source note."]],
    });
    draft.gismu.rows.push({
      language: "es",
      name: "Spanish",
      word: "",
      input: "",
      weight: null,
      notes: [],
      stem: "cant",
      ipa: "kant",
      aiNoteGroup: [],
    });
    draft.formation.sources.push({
      language: "fr",
      word: "",
      word_ipa: null,
      input: null,
      weight: { numerator: 1, denominator: 2 },
      notes: [],
    });
    draft.gismu.rows.push({
      language: "fr",
      name: "French",
      word: "",
      word_ipa: null,
      input: "",
      inputOriginal: null,
      weight: { numerator: "1", denominator: "2" },
      notes: [],
      stem: null,
      ipa: "",
      aiNoteGroup: [],
    });
    await store.put("drafts", "current", draft);
  });
  await open(page, "/new/publish");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Export draft" }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export draft" }).click();
  const file = await (await download).path();
  const exported = JSON.parse(
    await (await import("node:fs/promises")).readFile(file!, "utf8"),
  );
  expect(exported.gismu.rows[0]).toMatchObject({
    word_ipa: "bʊk",
    stem: "book",
    ipa: "bʊk",
  });
  expect(exported.formation.sources[0]).toMatchObject({
    word_ipa: "bʊk",
  });
  expect(exported.gismu.rows[1]).toMatchObject({
    stem: "cant",
    ipa: "kant",
  });
  expect(exported.gismu.rows[2]).toMatchObject({
    weight: { numerator: "1", denominator: "2" },
    stem: null,
    ipa: "",
  });
  expect(exported.formation.sources).toHaveLength(2);
  expect(exported.formation.sources[1].weight).toEqual({
    numerator: 1,
    denominator: 2,
  });
  expect(exported.formation.sources[1].word_ipa).toBeNull();
  for (const row of exported.formation.sources) {
    expect(row).not.toHaveProperty("stem");
    expect(row).not.toHaveProperty("ipa");
  }
  await page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true })
    .click();
  const unlock = page.getByRole("dialog", { name: "Unlock your key" });
  await unlock.getByLabel("Passphrase").fill(PASSPHRASE);
  await unlock.getByRole("button", { name: "Unlock", exact: true }).click();
  await acceptFirstSignature(page);
  await expect(page).toHaveURL(/\/word\/brodo/);
  const published = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const items = await new LocalStore().list("outbox");
    return JSON.parse(items.find((item: any) => item.order === 0).transport);
  });
  expect(published.body.etymology.formation.sources).toEqual([
    {
      language: "en",
      word: "book",
      word_ipa: "bʊk",
      input: { format: "lojbanized", text: "cukta" },
      weight: { numerator: 1, denominator: 1 },
      notes: [["An authored source note."]],
    },
    {
      language: "fr",
      word: "",
      weight: { numerator: 1, denominator: 2 },
    },
  ]);
  expect(published.body.etymology.formation.sources[1]).not.toHaveProperty(
    "word_ipa",
  );
  expect(published.body.etymology.formation.sources[1]).not.toHaveProperty(
    "input",
  );
  expect(published.body.etymology.formation.sources[1]).not.toHaveProperty(
    "notes",
  );
  const interpreted = await page.evaluate(
    async ({ corePath, body }) =>
      (await import(corePath)).interpretDefinition(body),
    { corePath, body: published.body },
  );
  expect(interpreted.etymology.formation.sources[1]).toEqual({
    language: "fr",
    word: "",
    weight: { numerator: 1, denominator: 2 },
    input: null,
    notes: [],
    word_ipa: null,
  });
  await page.goto(
    `/new/editor?revise=${encodeURIComponent(published.envelope.id)}`,
  );
  await expect
    .poll(async () => (await stored(page))?.parents)
    .toEqual([published.envelope.id]);
  const revision = await stored(page);
  expect(revision.gismu).toBeNull();
  expect(revision.formation.sources).toEqual(
    interpreted.etymology.formation.sources,
  );
});

test("F4 manual entry and Etymology can remove evidence after confirmation", async ({
  page,
}) => {
  await createIdentity(page);
  await seed(page, { compound: true });
  await open(page, "/new/form?manual=1");
  await expect(page.locator("main")).toContainText(
    "This draft keeps construction evidence",
  );
  const remove = page.getByRole("button", {
    name: "Remove formation evidence",
    exact: true,
  });
  page.once("dialog", (dialog) => void dialog.dismiss());
  await remove.click();
  expect((await stored(page)).compound).not.toBeNull();
  page.once("dialog", (dialog) => void dialog.accept());
  await remove.click();
  await expect.poll(async () => (await stored(page)).compound).toBeNull();
  await open(page, "/about");
  await seed(page, { formation: true });
  await open(page, "/new/editor");
  page.once("dialog", (dialog) => void dialog.accept());
  await page
    .getByRole("button", { name: "Remove formation evidence", exact: true })
    .click();
  await expect.poll(async () => (await stored(page)).formation).toBeNull();
});

test("F4 opening the other builder asks before removing evidence", async ({
  page,
}) => {
  await createIdentity(page);
  await seed(page, { compound: true });
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await open(page, "/new/gismu");
  await expect.poll(() => dialogs.length).toBe(1);
  expect((await stored(page)).kind).toBe("lujvo");
  expect((await stored(page)).compound).not.toBeNull();
  await expect(page).toHaveURL(/\/new\/type$/);
});

test("Grok 3 gismu acknowledgments belong to the selected spelling", async ({
  page,
}) => {
  await createIdentity(page);
  await seed(page, { selected: "cukte", formation: true });
  await open(page, "/new/gismu");
  const roots = page.getByRole("group", { name: "Root conflicts" });
  await roots.getByRole("checkbox").check();
  await page.getByLabel("Type a form yourself").fill("cukti");
  await page.getByRole("button", { name: "Choose cukti", exact: true }).click();
  await expect(roots.getByRole("checkbox")).not.toBeChecked();
  await expect(page.locator(".action-bar .btn-primary")).toBeDisabled();
});

test("Grok 3 lujvo acknowledgments belong to the selected spelling", async ({
  page,
}) => {
  await createIdentity(page);
  await seed(page, { compound: true, competitors: ["spofu"] });
  await open(page, "/new/lujvo");
  const claims = page.getByRole("group", { name: "Competing rafsi claims" });
  await claims.getByRole("checkbox").check();
  const next = page
    .getByRole("region", { name: "Other forms", exact: true })
    .getByRole("row")
    .filter({ hasText: "cku" })
    .filter({ has: page.getByRole("button", { name: /^Use / }) })
    .first();
  await next.getByRole("button").click();
  await expect(claims.getByRole("checkbox")).not.toBeChecked();
});

test("Grok 4 an invalid restored lujvo stays visible until a current form is chosen", async ({
  page,
}) => {
  await createIdentity(page);
  await seed(page, { compound: true, selected: "old-invalid-choice" });
  await open(page, "/new/lujvo");
  await expect(page.locator("main")).toContainText(
    "old-invalid-choice is no longer a candidate",
  );
  await expect(page.locator(".action-bar .btn-primary")).toBeDisabled();
  expect((await stored(page)).lujvo.selected).toBe("old-invalid-choice");
  await page
    .getByRole("region", { name: "Other forms", exact: true })
    .getByRole("button")
    .first()
    .click();
  await expect(page.locator(".action-bar .btn-primary")).toBeEnabled();
});

test("N3 manual root reviews stay private without a formation method claim", async ({
  page,
}) => {
  await createIdentity(page);
  await seed(page, { spelling: " cukta " });
  await open(page, "/new/publish");
  const publish = page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true });
  await expect(
    page.getByRole("region", { name: "Known conflicts" }),
  ).toContainText("identical conflict with cukta");
  await expect(publish).toBeDisabled();
  await page
    .getByLabel(
      /although the refreshed package shows a (?:new|known) root conflict with cukta/,
    )
    .check();
  await expect(publish).toBeEnabled();
  await expect(page.locator("aside")).toContainText(
    "This acknowledgment stays in your private draft. It adds no signed formation evidence.",
  );
  await expect.poll(async () => (await stored(page)).formation).toBeNull();
  await page
    .getByLabel(/I publish cukta although the refreshed package shows/)
    .uncheck();
  await expect(publish).toBeDisabled();
  await expect
    .poll(async () => (await stored(page)).publishAcknowledged.length)
    .toBe(0);
  expect((await stored(page)).formation).toBeNull();
  expect((await stored(page)).evidenceForm).toBeNull();
  await page
    .getByLabel(/I publish cukta although the refreshed package shows/)
    .check();
  await open(page, "/new/places");
  await open(page, "/new/publish");
  await expect(
    page.getByLabel(
      /although the refreshed package shows a (?:new|known) root conflict with cukta/,
    ),
  ).toBeChecked();
  await expect
    .poll(async () => (await stored(page)).publishAcknowledged.length)
    .toBe(1);
  await page.reload();
  await expect(
    page.getByLabel(
      /although the refreshed package shows a (?:new|known) root conflict with cukta/,
    ),
  ).toBeChecked();
  await publish.click();
  const unlock = page.getByRole("dialog", { name: "Unlock your key" });
  await unlock.getByLabel("Passphrase").fill(PASSPHRASE);
  await unlock.getByRole("button", { name: "Unlock", exact: true }).click();
  await acceptFirstSignature(page);
  await expect(page).toHaveURL(/\/word\/cukta/);
  const body = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const items = await new LocalStore().list("outbox");
    return JSON.parse(items.find((item: any) => item.order === 0).transport)
      .body;
  });
  expect(body).not.toHaveProperty("etymology");
  const interpreted = await page.evaluate(
    async ({ corePath, body }) =>
      (await import(corePath)).interpretDefinition(body),
    { corePath, body },
  );
  expect(interpreted.etymology.formation).toBeNull();
});

test("F7 Grok 7 Publish reviews saved compound conflicts and rejects changed coverage", async ({
  page,
}) => {
  await createIdentity(page);
  await seed(page, { compound: true, competitors: ["spofu"] });
  // Revise can carry compound evidence without any builder state.
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const draft = await store.get("drafts", "current");
    draft.lujvo = null;
    await store.put("drafts", "current", draft);
  });
  await open(page, "/new/publish");
  const claims = page.getByLabel(/I keep .*although.*component rafsi/);
  const publish = page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true });
  await expect(
    page.getByRole("region", { name: "Known conflicts" }),
  ).toContainText("cku is also claimed by spofu");
  await expect(publish).toBeDisabled();
  await claims.check();
  await open(page, "/new/places");
  await open(page, "/new/publish");
  await expect(claims).toBeChecked();
  await expect
    .poll(async () => (await stored(page)).publishAcknowledged.length)
    .toBe(1);
  await page.reload();
  await expect(claims).toBeChecked();
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const cached = await store.get("packages", "en");
    cached.entries.push({
      ...cached.entries.at(-1),
      word: { language: "jbo", spelling: "spali" },
    });
    await store.put("packages", "en", cached);
  });
  await open(page, "/new/places");
  await open(page, "/new/publish");
  await expect(claims).not.toBeChecked();
  await expect(publish).toBeDisabled();
});

test("F7 published rafsi claim acknowledgments survive a return to Edit", async ({
  page,
}) => {
  await createIdentity(page);
  await seed(page, { spelling: "broda", claims: true });
  await open(page, "/new/publish");
  const claim = page.getByLabel(/I keep the claim cku although other words/);
  await claim.check();
  await open(page, "/new/places");
  await open(page, "/new/publish");
  await expect(claim).toBeChecked();
});

test("F8 an accepted definition opens the word despite a refused endorsement", async ({
  page,
}) => {
  await createIdentity(page);
  await seed(page, { spelling: "brode" });
  await page.route("**/api/v1/events", async (route) => {
    if (
      route.request().postDataJSON()?.envelope?.header?.action?.kind ===
      "judgment.set"
    )
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "synthetic_refusal" }),
      });
    else await route.continue();
  });
  await open(page, "/new/publish");
  await page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true })
    .click();
  await acceptFirstSignature(page);
  await expect(page).toHaveURL(/\/word\/brode/);
  await expect(
    page.getByRole("link", { name: /not delivered/i }).first(),
  ).toBeVisible();
});

test("F10 Places Back and saved draft continuation return to the matching builder", async ({
  page,
}) => {
  await createIdentity(page);
  await seed(page, { compound: true, step: 3 });
  await open(page, "/new/places");
  await expect(
    page.getByRole("link", { name: "Back", exact: true }),
  ).toHaveAttribute("href", "/new/lujvo");
  await open(page, "/new/meaning?word=broda");
  await expect(
    page.getByRole("link", { name: "Continue the saved draft", exact: true }),
  ).toHaveAttribute("href", "/new/lujvo");
});

test("F11 both builders label cut rafsi inventories as unknown coverage", async ({
  page,
}) => {
  await createIdentity(page);
  await seed(page, { compound: true, cut: true });
  await open(page, "/new/lujvo");
  await expect(page.locator("main")).toContainText(
    "coverage is incomplete for cukta",
  );
  await open(page, "/about");
  await seed(page, { selected: "cukte", formation: true, cut: true });
  await open(page, "/new/gismu");
  await expect(
    page.getByRole("region", { name: "Selected form" }),
  ).toContainText("coverage is incomplete for cukta");
});

test("Grok 8 11 12 help names saved evidence, package conflicts, and server retention limits", async ({
  page,
}) => {
  await createIdentity(page);
  await seed(page, { spelling: "brodi" });
  await open(page, "/new/editor");
  await expect(page.locator("main")).toContainText('"Use" in a builder saves');
  await expect(page.locator("main")).toContainText(
    "Publish compares claims with the downloaded package",
  );
  await expect(page.locator("main")).not.toContainText(
    "The builders add it in a later stage",
  );
  await open(page, "/new/publish");
  await expect(page.locator("aside")).toContainText(
    "This client cannot promise what each server stores",
  );
  await expect(page.locator("aside")).not.toContainText("kept by every server");
});

for (const [spelling, rule] of [
  ["cukte", "final-vowel"],
  ["sukta", "similar-consonant"],
]) {
  test(`F6 manual ${rule} conflicts do not require source rows`, async ({
    page,
  }) => {
    await createIdentity(page);
    await seed(page, { spelling });
    await open(page, "/new/publish");
    await expect(
      page.getByRole("region", { name: "Known conflicts" }),
    ).toContainText(`${rule} conflict with cukta`);
    await expect(
      page
        .locator("aside")
        .getByRole("button", { name: "Publish", exact: true }),
    ).toBeDisabled();
  });
}

test("F4 an accepted builder switch removes the other builder evidence before Use", async ({
  page,
}) => {
  await createIdentity(page);
  await seed(page, { compound: true, formation: true, selected: "cukte" });
  page.once("dialog", (dialog) => void dialog.accept());
  await open(page, "/new/gismu");
  await expect(
    page.getByRole("heading", { name: "Make a gismu", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("group", { name: "Root conflicts" })
    .getByRole("checkbox")
    .check();
  await page.locator(".action-bar .btn-primary").click();
  await expect(page).toHaveURL(/\/new\/places$/);
  const draft = await stored(page);
  expect(draft.compound).toBeNull();
  expect(draft.formation.generated).toBe("cukte");
  expect(draft.evidenceForm).toBe("cukte");
});

test("F8 an accepted definition opens the word when a second peer is offline", async ({
  page,
}) => {
  await page.goto("/about");
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().setPreferences({
      peers: [
        { id: "self", base: "/api/v1", label: "this server" },
        {
          id: "offline",
          base: "/synthetic-offline/api/v1",
          label: "offline test peer",
        },
      ],
    });
  });
  await createIdentity(page);
  await seed(page, { spelling: "brodo" });
  await page.route("**/synthetic-offline/**", (route) =>
    route.abort("connectionreset"),
  );
  await open(page, "/new/publish");
  await page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true })
    .click();
  await acceptFirstSignature(page);
  await expect(page).toHaveURL(/\/word\/brodo/);
  await expect(page.getByRole("status")).toContainText("unfinished delivery");
});

test("Grok 3 Publish does not reuse conflicts of a different historical generated form", async ({
  page,
}) => {
  await createIdentity(page);
  await seed(page, { formation: true, spelling: "cukti" });
  const historical = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const draft = await store.get("drafts", "current");
    draft.formation.generated = "cukte";
    draft.formation.conflicts = [
      {
        word: core.wordId({ language: "jbo", spelling: "cukta" }),
        rule: "final-vowel",
        snapshot: "sha256:" + "a".repeat(64),
      },
    ];
    await store.put("drafts", "current", draft);
    return draft.formation;
  }, corePath);
  await open(page, "/new/publish");
  const publish = page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true });
  await expect(
    page.getByRole("region", { name: "Known conflicts" }),
  ).toContainText(
    "New since the recorded run: final-vowel conflict with cukta",
  );
  await expect(publish).toBeDisabled();
  await page
    .getByLabel(/I publish cukti although the refreshed package shows/)
    .check();
  await expect(publish).toBeEnabled();
  await expect
    .poll(async () => (await stored(page)).publishAcknowledged.length)
    .toBe(1);
  expect((await stored(page)).formation).toEqual({
    ...historical,
    sources: historical.sources.map((source: unknown) => ({
      ...(source as object),
      word_ipa: null,
    })),
  });
});

test("F7 a new current root acknowledgment appends to historical formation evidence", async ({
  page,
}) => {
  await createIdentity(page);
  await seed(page, {
    formation: true,
    spelling: "cukti",
    competitors: ["sukti"],
  });
  const historical = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const draft = await store.get("drafts", "current");
    draft.formation.generated = "cukte";
    draft.formation.conflicts = [
      {
        word: core.wordId({ language: "jbo", spelling: "cukta" }),
        rule: "final-vowel",
        snapshot: "sha256:" + "a".repeat(64),
      },
    ];
    await store.put("drafts", "current", draft);
    return draft.formation;
  }, corePath);
  await open(page, "/new/publish");
  await page
    .getByLabel(/I publish cukti although the refreshed package shows/)
    .check();
  await expect
    .poll(async () => (await stored(page)).formation.conflicts.length)
    .toBe(2);
  const formation = (await stored(page)).formation;
  expect(formation).toEqual({
    ...historical,
    sources: historical.sources.map((source: unknown) => ({
      ...(source as object),
      word_ipa: null,
    })),
    conflicts: [
      historical.conflicts[0],
      {
        word: await page.evaluate(
          async (corePath) =>
            (await import(corePath)).wordId({
              language: "jbo",
              spelling: "sukti",
            }),
          corePath,
        ),
        rule: "similar-consonant",
        snapshot: "sha256:" + "a".repeat(64),
      },
    ],
  });
});

test("Publish refuses a package change during the current review before it signs", async ({
  page,
}) => {
  await createIdentity(page);
  await seed(page, { spelling: "broda" });
  await open(page, "/new/publish");
  const publish = page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true });
  await expect(publish).toBeEnabled();
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const cached = await store.get("packages", "en");
    cached.snapshot = "sha256:" + "b".repeat(64);
    await store.put("packages", "en", cached);
  });
  await publish.click();
  await acceptFirstSignature(page);
  await expect(page.locator("main")).toContainText(
    "The local package changed during review.",
  );
  await expect(
    page.getByRole("link", { name: "Review updated conflicts" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/new\/publish$/);
  expect(
    await page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      return (await new LocalStore().list("outbox")).length;
    }),
  ).toBe(0);
  expect((await stored(page)).spelling).toBe("broda");
});

for (const spelling of ["cukte", "broda"]) {
  test(`Grok N2 the gismu card names a v1 root inventory for ${spelling}`, async ({
    page,
  }) => {
    await createIdentity(page);
    await seed(page, { selected: spelling, formation: true });
    await page.evaluate(async (spelling) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const store = new LocalStore();
      const cached = await store.get("packages", "en");
      cached.version = 1;
      for (const entry of cached.entries) {
        delete entry.rafsi;
        delete entry.rafsi_complete;
      }
      await store.put("packages", "en", cached);
      const draft = await store.get("drafts", "current");
      draft.gismu.manual = spelling;
      draft.gismu.selected = spelling;
      await store.put("drafts", "current", draft);
    }, spelling);
    await open(page, "/new/gismu");
    const card = page.getByRole("region", { name: "Selected form" });
    await expect(card).toContainText(
      "Root inventory: local package of snapshot aaaaaaaaaaaa….",
    );
    if (spelling === "cukte")
      await expect(
        card.getByRole("group", { name: "Root conflicts" }),
      ).toContainText("cukta");
    else
      await expect(
        card.getByRole("group", { name: "Root conflicts" }),
      ).toHaveCount(0);
  });
}
