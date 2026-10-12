import { test, expect, type Page } from "@playwright/test";
import {
  acceptFirstSignature,
  corePath,
  createIdentity,
  fixture,
  PASSPHRASE,
} from "./helpers.ts";

async function outboxActions(page: Page) {
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const items = await new LocalStore().list("outbox");
    return items
      .sort((a: any, b: any) => a.signedAt - b.signedAt || a.order - b.order)
      .map((item: any) => ({
        group: item.group,
        order: item.order,
        state: item.peers.self.state,
        transport: JSON.parse(item.transport),
      }));
  });
}
const meaningBox = (page: Page) =>
  page.getByRole("textbox", { name: "Meaning" });

test("a first-time contributor writes a short literal definition and publishes it with an endorsement", async ({
  page,
}) => {
  await createIdentity(page);
  await page.getByRole("link", { name: "Add a word" }).click();
  await expect(page).toHaveTitle("Add a word: Meaning · jbovlacku");
  await meaningBox(page).fill("A disposable test meaning without places.");
  await expect(page.getByText("Saved in this browser")).toBeVisible();
  await page.getByRole("button", { name: "New word" }).click();
  await page.getByRole("radio", { name: /^gismu/ }).check();
  await page.getByRole("button", { name: "Make a gismu" }).click();
  await expect(
    page.getByRole("heading", { name: "Make a gismu" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Enter without generation" }).click();
  await page.getByLabel("Spelling").fill("brodu");
  await page.getByRole("button", { name: "Use brodu" }).click();
  await expect(page.getByRole("heading", { name: "brodu" })).toBeVisible();
  await page
    .getByRole("button", { name: "Use the meaning as the definition" })
    .click();
  await page.getByLabel("Read circled numbers as place references").uncheck();
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.getByRole("heading", { name: "Publish as" })).toBeVisible();
  await expect(
    page.getByText(
      "New definitions use CC0 1.0. By publishing, you release your contribution under CC0 1.0.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "CC0 1.0" })).toHaveAttribute(
    "href",
    "https://creativecommons.org/publicdomain/zero/1.0/",
  );
  await expect(page.getByText("Your key backup is untested.")).toBeVisible();
  await expect(
    page.getByText("Signed with your key, with your endorsement."),
  ).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await page.locator("aside").getByRole("button", { name: "Publish" }).click();
  await acceptFirstSignature(page);
  await expect(page).toHaveTitle("brodu · jbovlacku");
  await expect(page.getByRole("status")).toContainText(
    "Published brodu with your endorsement.",
  );
  // The definition is found by its text, so other publications of the word do not matter.
  const first = page.locator("article.definition", {
    hasText: "A disposable test meaning without places.",
  });
  await expect(first).toHaveCount(1);
  await expect(first.getByRole("button", { name: "Endorse" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const actions = await outboxActions(page);
  expect(
    actions.map((a: any) => [a.transport.envelope.header.action.kind, a.state]),
  ).toEqual([
    ["definition.publish", "accepted"],
    ["judgment.set", "accepted"],
  ]);
  expect(actions[0].group).toBe(actions[1].group);
  expect(actions[1].transport.envelope.header.action.target).toBe(
    actions[0].transport.envelope.id,
  );
  expect(actions[0].transport.body.license).toEqual({
    expression: "CC0-1.0",
    url: "https://creativecommons.org/publicdomain/zero/1.0/",
    attribution: "",
  });
  expect(actions[0].transport.body.legacy).toBe(null);
  expect(actions[0].transport.envelope.header.action.origin).toBe("native");
  // The draft is gone after publication.
  await page.getByRole("link", { name: "Add a word" }).click();
  await expect(meaningBox(page)).toHaveValue("");
});

test("structured places keep declared order when prose mentions place 3 first, and a bad reference offers a literal escape", async ({
  page,
}) => {
  await createIdentity(page);
  await page.getByRole("link", { name: "Add a word" }).click();
  await meaningBox(page).fill("___ is read by ___ in ___.");
  await expect(page.getByText("3 placeholders found.")).toBeVisible();
  await page.getByRole("button", { name: "New word" }).click();
  await page.getByRole("radio", { name: /^lujvo/ }).check();
  await page.getByRole("button", { name: "Build the lujvo" }).click();
  await expect(
    page.getByRole("heading", { name: "Build the lujvo" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Type the spelling yourself" }).click();
  await page.getByLabel("Spelling").fill("brodyckusni");
  await page.getByRole("button", { name: "Use brodyckusni" }).click();
  await page
    .getByRole("button", { name: "Use the meaning with numbered places" })
    .click();
  await expect(page.getByLabel("Number of places")).toHaveValue("fixed");
  // Reorder the prose so place 3 appears first. The declared order stays 1, 2, 3.
  const editor = page.getByRole("textbox", { name: "Definition text" });
  await editor.fill("③ holds ① read by ②.");
  await page.getByLabel("Description for place 1").fill("the text");
  await page.getByLabel("Description for place 2").fill("the reader");
  await page.getByLabel("Description for place 3").fill("the medium");
  await page.getByLabel("Kind of thing for place 2").selectOption("object");
  await page
    .getByRole("button", { name: "Add a derivation for place 3" })
    .click();
  await page
    .getByLabel("Source word of derivation 1 for place 3")
    .fill("cukta");
  await page.getByLabel("Source place of derivation 1 for place 3").fill("5");
  await page.getByRole("button", { name: "Approve the numbering" }).click();
  await expect(page.getByText("Place numbering approved.")).toBeVisible();
  // A reference to an undeclared place blocks signing.
  await editor.fill("③ holds ① read by ② at ④.");
  await expect(
    page.getByRole("region", { name: "Rendered definition" }),
  ).toContainText("Place 4 is referenced in the definition but not declared.");
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.getByText(/\d+ problems? block signing\./)).toBeVisible();
  await expect(
    page.locator("aside").getByRole("button", { name: "Publish" }),
  ).toBeDisabled();
  await page.getByRole("link", { name: "Edit" }).first().click();
  await page
    .getByRole("button", { name: "Convert references to literal text" })
    .click();
  // Each reference becomes an escaped literal circled character. The visible text stays.
  await expect(editor).toHaveValue("\\③ holds \\① read by \\② at \\④.");
  await expect(
    page.getByRole("region", { name: "Rendered definition" }),
  ).not.toContainText("referenced but not declared");
  // Restore the structured text and publish.
  await editor.fill("③ holds ① read by ②.");
  await page.getByRole("button", { name: "Approve the numbering" }).click();
  await page.getByRole("button", { name: "Review" }).click();
  await expect(
    page.locator(".preview-card .place-strip").getByLabel("place 1: the text"),
  ).toBeVisible();
  await page.locator("aside").getByRole("button", { name: "Publish" }).click();
  await acceptFirstSignature(page);
  await expect(page).toHaveTitle("brodyckusni · jbovlacku");
  const actions = await outboxActions(page);
  const body = actions[0].transport.body;
  expect(body.text).toEqual([[3, " holds ", 1, " read by ", 2, "."]]);
  expect(body.frame.arity).toEqual({ mode: "fixed", count: 3 });
  expect(body.frame.places.map((p: any) => p.index)).toEqual([1, 2, 3]);
  expect(body.frame.places[1].type_hints).toEqual([
    {
      alternatives: [
        { tags: ["entity"], abstractor: null, relation_arity: null },
      ],
      note: [],
    },
  ]);
  expect(body.frame.places[2].derivation).toEqual([
    {
      word: { language: "jbo", spelling: "cukta" },
      definition: null,
      place: 5,
      explanation: [],
    },
  ]);
  await expect(
    page
      .locator("article.definition")
      .first()
      .getByRole("link", { name: "place 3", exact: true }),
  ).toBeVisible();
});

test("the draft survives reload and browser back at every step and exports as a file", async ({
  page,
}) => {
  await page.goto("/new/meaning");
  await meaningBox(page).fill("A draft that must survive.");
  await page.getByLabel("Lojban word").fill("brodo");
  await expect(page.getByText("Saved in this browser")).toBeVisible();
  await page.reload();
  await expect(meaningBox(page)).toHaveValue("A draft that must survive.");
  await expect(page.getByLabel("Lojban word")).toHaveValue("brodo");
  await page.getByRole("button", { name: "New word" }).click();
  await page.getByRole("radio", { name: /^cmavo/ }).check();
  await page.getByRole("button", { name: "Enter the cmavo" }).click();
  await page.getByLabel("selma'o").fill("UI");
  await page.getByLabel("Morphology notes").fill("Attributed note.");
  await page.goBack();
  await expect(page.getByRole("radio", { name: /^cmavo/ })).toBeChecked();
  await page.goForward();
  await expect(page.getByLabel("selma'o")).toHaveValue("UI");
  await page.reload();
  await expect(page.getByLabel("Morphology notes")).toHaveValue(
    "Attributed note.",
  );
  await expect(page.getByLabel("Spelling")).toHaveValue("brodo");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export draft" }).click();
  const download = await downloadPromise;
  const text = await (await download.createReadStream())
    .toArray()
    .then((chunks) => Buffer.concat(chunks as Buffer[]).toString());
  const exported = JSON.parse(text);
  expect(exported.spelling).toBe("brodo");
  expect(exported.selmaho).toEqual(["UI"]);
  expect(exported.meaning).toBe("A draft that must survive.");
  // Changing the type with incompatible fields asks first and keeps the prose.
  await page.goto("/new/type");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("radio", { name: /^gismu/ }).click();
  await expect(page.getByRole("radio", { name: /^cmavo/ })).toBeChecked();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("radio", { name: /^gismu/ }).check();
  await expect(page.getByRole("radio", { name: /^gismu/ })).toBeChecked();
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        return (await new LocalStore().get("drafts", "current")).kind;
      }),
    )
    .toBe("gismu");
  await page.goto("/new/form");
  await expect(page.getByLabel("selma'o")).toHaveCount(0);
  await expect(page.getByLabel("Morphology notes")).toHaveValue(
    "Attributed note.",
  );
});

test("the full editor preserves every structured field and supports manual headword and type entry", async ({
  page,
}) => {
  await createIdentity(page);
  await page.getByRole("link", { name: "Add a word" }).click();
  await page.getByRole("link", { name: "Skip to the full editor" }).click();
  await expect(page).toHaveTitle("Full editor · jbovlacku");
  await page.getByLabel("Headword").fill("brodi");
  await page.getByLabel("Type", { exact: true }).selectOption("cmavo");
  await page.getByLabel("selma'o").fill("BAI");
  await page
    .getByRole("textbox", { name: "Definition text" })
    .fill("① is the operand ② of [[brodi]].");
  await page.getByRole("button", { name: "+ Add a place" }).click();
  await page.getByRole("button", { name: "+ Add a place" }).click();
  await page.getByLabel("Number of places").selectOption("context");
  await page.getByLabel("Description for place 1").fill("the agent");
  await page.getByLabel("Kind of thing for place 1").selectOption("custom");
  await page
    .getByLabel("Tags for alternative 1")
    .fill("agent, https://example.invalid/tags/custom");
  await page.getByLabel("Abstractor for alternative 1").selectOption("ka");
  await page.getByRole("button", { name: "Approve the numbering" }).click();
  await page.getByLabel("Add a gloss", { exact: true }).fill("gloss (sense)");
  await page.getByLabel("Add a gloss", { exact: true }).press("Enter");
  await page.getByRole("button", { name: "Add a default for place 1" }).click();
  await page.getByLabel("Default value 1 for place 1").fill("li pa");
  await page.getByLabel("Condition 1 for place 1").fill("when unspecified");
  await page.getByLabel("Constraints between places").fill("① differs from ②");
  await page
    .getByRole("textbox", { name: "Notes" })
    .fill("A note mentioning ①.");
  await page.getByRole("button", { name: "Add an example" }).click();
  await page.getByLabel("Example 1", { exact: true }).fill("mi brodi do");
  await page.getByLabel("Translation of example 1").fill("I brodi you");
  await page
    .getByRole("textbox", { name: "Etymology" })
    .fill("Made up for a test.");
  await page.getByRole("button", { name: "Add a source" }).click();
  await page.getByLabel("Source 1 label").fill("Test source");
  await page.getByLabel("Source 1 link").fill("https://example.invalid/source");
  await page.getByRole("button", { name: "Add an operand" }).click();
  await page.getByLabel("Operand 1 ID").fill("bridi");
  await page.getByLabel("Operand 1 category").fill("bridi");
  await page.getByLabel("Operand 1 maximum").fill("");
  await page.getByLabel("Labels", { exact: true }).fill("experimental, test");
  await page.getByRole("button", { name: "Add a rafsi claim" }).click();
  await page.getByLabel("Rafsi 1", { exact: true }).fill("bod");
  await page.getByLabel("Rationale for rafsi 1").fill("Test claim.");
  await page.getByRole("button", { name: "Review" }).click();
  await expect(
    page.getByText(
      "4 signed records: the definition, your endorsement, 1 rafsi claim, and their pair endorsements.",
    ),
  ).toBeVisible();
  await page.locator("aside").getByRole("button", { name: "Publish" }).click();
  await acceptFirstSignature(page);
  await expect(page).toHaveTitle("brodi · jbovlacku");
  const actions = await outboxActions(page);
  expect(
    actions.map((a: any) => a.transport.envelope.header.action.kind),
  ).toEqual([
    "definition.publish",
    "judgment.set",
    "rafsi.publish",
    "judgment.set",
  ]);
  expect(new Set(actions.map((a: any) => a.group)).size).toBe(1);
  expect(actions.every((a: any) => a.state === "accepted")).toBe(true);
  const body = actions[0].transport.body;
  expect(body.classification).toEqual({ kind: "cmavo", selmaho: ["BAI"] });
  expect(body.frame.arity).toEqual({ mode: "context" });
  expect(body.frame.places[0].type_hints[0].alternatives[0]).toEqual({
    tags: ["agent", "https://example.invalid/tags/custom"],
    abstractor: "ka",
    relation_arity: null,
  });
  expect(body.frame.places[0].defaults[0]).toEqual({
    kind: "conventional",
    value: { format: "lojban", text: "li pa" },
    condition: [["when unspecified"]],
    explanation: [],
  });
  expect(body.frame.constraints).toEqual([[[1, " differs from ", 2]]]);
  expect(body.text[0]).toEqual([
    1,
    " is the operand ",
    2,
    " of ",
    { word: { language: "jbo", spelling: "brodi" }, label: "brodi" },
    ".",
  ]);
  expect(body.glosses).toEqual([
    { language: "en", text: "gloss", sense: "sense" },
  ]);
  expect(body.notes).toEqual([["A note mentioning ", 1, "."]]);
  expect(body.examples).toEqual([
    {
      language: "jbo",
      text: "mi brodi do",
      translation: [["I brodi you"]],
      notes: [],
    },
  ]);
  expect(body.etymology.text).toEqual([["Made up for a test."]]);
  expect(body.sources).toEqual([
    {
      label: "Test source",
      url: "https://example.invalid/source",
      event: null,
      locator: null,
    },
  ]);
  expect(body.operands).toEqual([
    {
      id: "bridi",
      category: "bridi",
      description: [],
      cardinality: { minimum: 1, maximum: null },
    },
  ]);
  expect(body.labels).toEqual(["experimental", "test"]);
  const claim = actions[2].transport;
  expect(claim.body.rafsi).toBe("bod");
  expect(claim.body.rationale).toEqual([["Test claim."]]);
  expect(actions[3].transport.envelope.header.action.target).toBe(
    claim.envelope.header.action.assignment,
  );
  // The word page shows the claim and the pair judgment.
  await expect(
    page.getByRole("heading", { name: "Rafsi claims" }),
  ).toBeVisible();
  await expect(page.getByText("bod", { exact: true }).first()).toBeVisible();
  // Revise round-trips every field back into the editor.
  await page
    .locator("article.definition", { hasText: "is the operand" })
    .first()
    .getByRole("link", { name: "Revise" })
    .click();
  await expect(page).toHaveTitle("Full editor · jbovlacku");
  await expect(page.getByLabel("Headword")).toHaveValue("brodi");
  await expect(page.getByLabel("Type", { exact: true })).toHaveValue("cmavo");
  await expect(
    page.getByRole("textbox", { name: "Definition text" }),
  ).toHaveValue("① is the operand ② of [[brodi]].");
  await expect(page.getByLabel("Default value 1 for place 1")).toHaveValue(
    "li pa",
  );
  await expect(page.getByLabel("Operand 1 ID")).toHaveValue("bridi");
  await expect(page.getByLabel("Source 1 label")).toHaveValue("Test source");
  await expect(page.getByText(/Revision of jve1:/)).toBeVisible();
});

test("revising an imported definition keeps the parent, cites it, copies the rights notice, and inherits no judgments", async ({
  page,
}) => {
  const f = fixture();
  await createIdentity(page);
  await page.getByLabel("Search words and meanings").fill("library");
  await page.getByLabel("Search words and meanings").press("Enter");
  await page
    .getByRole("region", { name: "Search results" })
    .getByRole("link", { name: "ckusro", exact: true })
    .click();
  await page
    .locator("article.definition")
    .first()
    .getByRole("link", { name: "Revise" })
    .click();
  await expect(
    page.getByText(
      "The imported attribution stays with the parent. Your contribution is released under CC0 1.0.",
    ),
  ).toBeVisible();
  await page
    .getByText("Sources", { exact: true })
    .first()
    .scrollIntoViewIfNeeded();
  await expect(page.getByLabel("Source 1 record")).toHaveValue(
    f.definitions.imported,
  );
  await expect(page.getByLabel("Source 2 position")).toHaveValue(
    "footer.publicDomainNotice",
  );
  await expect(
    page.getByText("Required for a revision of imported text"),
  ).toHaveCount(2);
  await page
    .getByRole("textbox", { name: "Definition text" })
    .fill("① is a library of books ②, revised.");
  await page.getByLabel("Number of places").selectOption("fixed");
  await page.getByRole("button", { name: "+ Add a place" }).click();
  await page.getByRole("button", { name: "+ Add a place" }).click();
  await page.getByRole("button", { name: "Approve the numbering" }).click();
  await page.getByRole("button", { name: "Review" }).click();
  await expect(
    page.getByText(
      "The imported text keeps its source rights claim and attribution through the parent link and sources.",
    ),
  ).toBeVisible();
  await page.locator("aside").getByRole("button", { name: "Publish" }).click();
  await acceptFirstSignature(page);
  await expect(page).toHaveTitle("ckusro · jbovlacku");
  const actions = await outboxActions(page);
  const publish = actions[0].transport;
  expect(publish.envelope.header.action.parents).toEqual([
    f.definitions.imported,
  ]);
  expect(publish.envelope.header.action.origin).toBe("native");
  expect(publish.body.legacy).toBe(null);
  expect(publish.body.license.expression).toBe("CC0-1.0");
  expect(publish.body.sources[0].event).toBe(f.definitions.imported);
  expect(publish.body.sources.at(-1).locator).toBe("footer.publicDomainNotice");
  // The revision shows beside the import with its own endorsement only.
  const articles = page.locator("article.definition");
  await expect(articles).toHaveCount(2);
  const revised = articles.filter({ hasText: "revised." });
  await expect(
    revised.getByRole("button", { name: "Endorse" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    revised.getByRole("img", {
      name: /^Score 0: 0 for, 0 against, 1 reviewer/,
    }),
  ).toBeVisible();
  const original = articles.filter({ hasText: "x1 is a library" });
  await expect(original.getByText(/Revision proposed by/)).toBeVisible();
  await expect(original.getByText("arj", { exact: true })).toBeVisible();
});

test("a standalone rafsi claim shows competing words, signs the claim with its pair blessing, and the rafsi page lists both", async ({
  page,
}) => {
  await createIdentity(page);
  await page.getByLabel("Search words and meanings").fill("dictionary");
  await page.getByLabel("Search words and meanings").press("Enter");
  await page
    .getByRole("region", { name: "Search results" })
    .getByRole("link", { name: "vlacku", exact: true })
    .click();
  await page.getByRole("link", { name: "claim one" }).click();
  await expect(page).toHaveTitle("Claim a rafsi for vlacku · jbovlacku");
  await page.getByLabel("Rafsi spelling").fill("cku");
  await page
    .getByLabel("Rationale")
    .fill("A deliberate conflict for the test.");
  await page.getByRole("button", { name: "Check claims and preview" }).click();
  await expect(
    page.getByText(/Conflict: cku is already claimed for/),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "cukta", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Sign and publish the claim" })
    .click();
  await acceptFirstSignature(page);
  await expect(page).toHaveTitle("vlacku · jbovlacku");
  await expect(page.getByRole("status")).toContainText(
    "Published the claim cku for vlacku with your endorsement.",
  );
  const actions = await outboxActions(page);
  expect(
    actions.map((a: any) => a.transport.envelope.header.action.kind),
  ).toEqual(["rafsi.publish", "judgment.set"]);
  expect(actions[1].transport.envelope.header.action.target).toBe(
    actions[0].transport.envelope.header.action.assignment,
  );
  await expect(
    page.getByRole("link", { name: "cku", exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("link", { name: "cku", exact: true }).first().click();
  await expect(page).toHaveTitle("Rafsi cku · jbovlacku");
  await expect(page.getByText("2 words claim this rafsi.")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "cku for cukta" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "cku for vlacku" }),
  ).toBeVisible();
});

test("the wizard fits a 360 pixel screen and keeps every control reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto("/new/meaning");
  await meaningBox(page).fill("___ is narrow.");
  await expect(page.getByText("Saved in this browser")).toBeVisible();
  await page.getByRole("button", { name: "New word" }).click();
  await expect(
    page.getByRole("heading", { name: "What kind of word?" }),
  ).toBeVisible();
  for (const path of [
    "/new/type",
    "/new/form",
    "/new/places",
    "/new/editor",
    "/new/publish",
  ]) {
    await page.goto(path);
    await expect(page.locator("main h1").first()).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      path,
    ).toBe(true);
  }
  await page.goto("/new/places");
  await page
    .getByRole("button", { name: "Use the meaning with numbered places" })
    .click();
  await page.getByLabel("Description for place 1").fill("narrow");
  await page.getByRole("button", { name: "Review" }).focus();
  expect(
    await page.evaluate(() => {
      const active = document.activeElement!;
      const rect = active.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= innerHeight;
    }),
  ).toBe(true);
  void PASSPHRASE;
});

/** Saves a reviewed draft with one rafsi claim and opens the publish step through the app router. */
async function openPublishWithClaim(
  page: Page,
  spelling: string,
  rafsi: string,
) {
  await page.evaluate(
    async ({ spelling, rafsi }) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { newDraft } = await import(String("/src/model/draft.ts"));
      await new LocalStore().put(
        "drafts",
        "current",
        newDraft({
          spelling,
          kind: "gismu",
          meaning: "A disposable test meaning.",
          text: "A disposable test meaning with <script>window.bad=true</script>.",
          structured: false,
          frameMode: "none",
          step: 5,
          rafsiClaims: [{ rafsi, rationale: "Disposable claim." }],
        }),
      );
    },
    { spelling, rafsi },
  );
  // A full page load locks the key. Signing then opens the unlock dialog.
  await page.goto("/new/publish");
}
/** Navigates inside the app, keeping the in-memory key and session choices. */
async function spaGoto(page: Page, path: string) {
  await page.evaluate((target) => {
    const anchor = document.createElement("a");
    anchor.href = target;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }, path);
}
async function outboxRecords(page: Page) {
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return (await new LocalStore().list("outbox")).map((item: any) => ({
      id: item.id,
      group: item.group,
      kind: JSON.parse(item.transport).envelope.header.action.kind,
      transport: item.transport,
      state: item.peers.self.state,
    }));
  });
}

test("a requested rafsi claim is signed even when every lookup fails, and a known collision needs acknowledgment", async ({
  page,
}) => {
  await createIdentity(page);
  await page.getByText("Offline signing", { exact: true }).click();
  await page.getByLabel("Sign from history saved in this browser only").check();
  // Every API request fails. The reviewed draft still decides the group.
  await page.route("**/api/v1/**", (route) => route.abort("connectionreset"));
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { newDraft } = await import(String("/src/model/draft.ts"));
    await new LocalStore().put(
      "drafts",
      "current",
      newDraft({
        spelling: "brodu",
        kind: "gismu",
        meaning: "A disposable test meaning.",
        text: "A disposable test meaning with <script>window.bad=true</script>.",
        structured: false,
        frameMode: "none",
        step: 5,
        rafsiClaims: [{ rafsi: "rod", rationale: "Disposable claim." }],
      }),
    );
  });
  await spaGoto(page, "/new/publish");
  const conflicts = page.getByRole("region", { name: "Known conflicts" });
  await expect(conflicts).toContainText("Rafsi claims: rod.");
  await expect(conflicts).toContainText("conflict coverage is unknown");
  await expect(conflicts).toContainText(
    "Existing-definition coverage is unknown",
  );
  await expect(page.locator("aside")).toContainText("4 signed records");
  await page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true })
    .click();
  await acceptFirstSignature(page);
  const saved = page.getByRole("region", { name: "Saved publication" });
  await expect(saved).toContainText("Saved. Not delivered yet.");
  const records = await outboxRecords(page);
  expect(records.map((r: any) => r.kind).sort()).toEqual(
    [
      "definition.publish",
      "judgment.set",
      "judgment.set",
      "rafsi.publish",
    ].sort(),
  );
  expect(new Set(records.map((r: any) => r.group)).size).toBe(1);
  const claim = records.find((r: any) => r.kind === "rafsi.publish");
  expect(JSON.parse(claim.transport).body.rafsi).toBe("rod");
  await page.unroute("**/api/v1/**");
  // A claim that the local package already lists for another word: the full editor's claim collides with cukta's cku.
  await page.goto("/preferences");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(
    "The English search package is saved in this browser.",
  );
  await openPublishWithClaim(page, "brodi", "cku");
  await expect(conflicts).toContainText("cku is also claimed by cukta");
  await expect(conflicts).toContainText(
    /Competing claims come from the local package of snapshot/,
  );
  const publish = page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true });
  await expect(publish).toBeDisabled();
  await page.getByRole("checkbox", { name: /I keep the claim cku/ }).check();
  await expect(publish).toBeEnabled();
});

test("after the group is saved, a lost delivery response offers delivery of the same records and never a second publication", async ({
  page,
}) => {
  await createIdentity(page);
  await openPublishWithClaim(page, "brode", "rod");
  // The listener counts every POST, including after the route handler is removed.
  let posts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/api/v1/events")
    )
      posts++;
  });
  await page.route("**/api/v1/events", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    // The server stores the record, but the browser gets a receipt it cannot match.
    const response = await route.fetch();
    const receipt = await response.json();
    try {
      await route.fulfill({
        status: 200,
        json: { ...receipt, envelope_hash: "sha256:" + "0".repeat(64) },
      });
    } catch {
      // A request that the page no longer awaits cannot be answered. It stays unknown either way.
    }
  });
  const aside = page.locator("aside");
  await aside.getByRole("button", { name: "Publish", exact: true }).click();
  const unlock = page.getByRole("dialog", { name: "Unlock your key" });
  await unlock.getByLabel("Passphrase").fill(PASSPHRASE);
  await unlock.getByRole("button", { name: "Unlock" }).click();
  await acceptFirstSignature(page);
  const saved = page.getByRole("region", { name: "Saved publication" });
  await expect(saved).toContainText("Saved. Not delivered yet.");
  await expect(saved).toContainText(
    "Publishing again would create a second definition",
  );
  // The page is bound to the saved group. No Publish control remains.
  await expect(
    aside.getByRole("button", { name: "Publish", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Publish", exact: true }),
  ).toHaveCount(0);
  // Every record was uploaded exactly once. A receipt lookup for a dependency
  // can already have confirmed some records; the last one stays unknown.
  await expect
    .poll(async () =>
      (await outboxRecords(page)).every((r: any) => r.state !== "queued"),
    )
    .toBe(true);
  const first = await outboxRecords(page);
  expect(first).toHaveLength(4);
  expect(first.some((r: any) => r.state === "unknown")).toBe(true);
  expect(posts).toBe(4);
  const postsBefore = posts;
  // A second action on the page delivers the saved bytes. The receipt lookup finds the stored record without a new POST.
  await page.unroute("**/api/v1/events");
  await saved.getByRole("button", { name: "Try now" }).click();
  await expect(saved).toContainText("Published.");
  expect(posts).toBe(postsBefore);
  const after = await outboxRecords(page);
  expect(after.map((r: any) => [r.id, r.group, r.transport])).toEqual(
    first.map((r: any) => [r.id, r.group, r.transport]),
  );
  expect(after.every((r: any) => r.state === "accepted")).toBe(true);
  // Reload and browser back show the saved group, never the draft as a new publication.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Saved publication" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Publish", exact: true }),
  ).toHaveCount(0);
  await page.goto("/word/brode");
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Saved publication" }),
  ).toBeVisible();
  expect((await outboxRecords(page)).length).toBe(4);
  // A new draft starts from Add a word with nothing of the old one.
  await page.getByRole("link", { name: "Add a word" }).click();
  await expect(page.getByRole("textbox", { name: "Meaning" })).toHaveValue("");
  // The published text with hostile markup renders literally after recovery.
  await page.goto(
    `/definition/${encodeURIComponent(first.find((r: any) => r.kind === "definition.publish").id)}`,
  );
  await expect(
    page.getByText(
      "A disposable test meaning with <script>window.bad=true</script>.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(await page.evaluate(() => Boolean((window as any).bad))).toBe(false);
});

test("a failed local group write keeps the real draft, reports the failure, and sends nothing", async ({
  page,
}) => {
  await createIdentity(page);
  await openPublishWithClaim(page, "brodo", "rod");
  let posts = 0;
  await page.route("**/api/v1/events", (route) => {
    if (route.request().method() === "POST") posts++;
    return route.continue();
  });
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    LocalStore.prototype.queueGroup = async () => {
      throw new Error("Storage failed");
    };
  });
  await page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true })
    .click();
  const unlock = page.getByRole("dialog", { name: "Unlock your key" });
  await unlock.getByLabel("Passphrase").fill(PASSPHRASE);
  await unlock.getByRole("button", { name: "Unlock" }).click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status").last()).toContainText("Storage failed");
  await expect(
    page.getByRole("region", { name: "Saved publication" }),
  ).toHaveCount(0);
  await expect(
    page.locator("aside").getByRole("button", { name: "Publish", exact: true }),
  ).toBeEnabled();
  expect(posts).toBe(0);
  expect(await outboxRecords(page)).toHaveLength(0);
  const draft = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().get("drafts", "current");
  });
  expect(draft.spelling).toBe("brodo");
  expect(draft.rafsiClaims).toEqual([
    { rafsi: "rod", rationale: "Disposable claim." },
  ]);
});

test("a fully disconnected author signs a complete definition into storage and later delivers the exact saved records", async ({
  page,
}) => {
  await createIdentity(page);
  await page.getByText("Offline signing", { exact: true }).click();
  await page.getByLabel("Sign from history saved in this browser only").check();
  await page.evaluate(
    async ({ spelling, rafsi }) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { newDraft } = await import(String("/src/model/draft.ts"));
      await new LocalStore().put(
        "drafts",
        "current",
        newDraft({
          spelling,
          kind: "gismu",
          meaning: "A disposable test meaning.",
          text: "A disposable test meaning with <script>window.bad=true</script>.",
          structured: false,
          frameMode: "none",
          step: 5,
          rafsiClaims: [{ rafsi, rationale: "Disposable claim." }],
        }),
      );
    },
    { spelling: "brodvi", rafsi: "rod" },
  );
  await page.route("**/api/v1/**", (route) => route.abort("connectionreset"));
  await spaGoto(page, "/new/publish");
  await page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true })
    .click();
  await acceptFirstSignature(page);
  const saved = page.getByRole("region", { name: "Saved publication" });
  await expect(saved).toContainText("Saved. Not delivered yet.");
  const before = await outboxRecords(page);
  expect(before).toHaveLength(4);
  expect(before.map((r: any) => r.state)).not.toContain("accepted");
  await page.unroute("**/api/v1/**");
  // The saved panel delivers every unfinished record with its exact bytes.
  await saved.getByRole("button", { name: "Try now" }).click();
  await expect(saved).toContainText("Published.");
  await expect
    .poll(async () =>
      (await outboxRecords(page)).every((r: any) => r.state === "accepted"),
    )
    .toBe(true);
  const after = await outboxRecords(page);
  expect(after.map((r: any) => [r.id, r.transport])).toEqual(
    before.map((r: any) => [r.id, r.transport]),
  );
  await page.goto("/word/brodvi");
  await expect(
    page
      .getByText(
        "A disposable test meaning with <script>window.bad=true</script>.",
        { exact: true },
      )
      .first(),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "rod", exact: true }),
  ).toBeVisible();
});

/** Writes a reviewed draft with one claim and returns its revision. */
async function writeReviewedDraft(page: Page, spelling: string) {
  return page.evaluate(async (spelling) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { newDraft } = await import(String("/src/model/draft.ts"));
    const draft = newDraft({
      spelling,
      kind: "gismu",
      meaning: "A disposable test meaning.",
      text: "A disposable test meaning.",
      structured: false,
      frameMode: "none",
      step: 5,
      rafsiClaims: [{ rafsi: "rod", rationale: "Disposable claim." }],
    });
    await new LocalStore().put("drafts", "current", draft);
    return draft.revision as string;
  }, spelling);
}
async function draftState(page: Page) {
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const draft = await store.get("drafts", "current");
    const last = await store.get("drafts", "published:last");
    return {
      revision: draft?.revision ?? null,
      spelling: draft?.spelling ?? null,
      last: last
        ? { revision: last.revision, group: last.group, ids: last.ids }
        : null,
    };
  });
}

test("a failure right after the group commits still recovers the same group after reload, and a failure before it keeps the draft", async ({
  page,
}) => {
  await createIdentity(page);
  await page.getByText("Offline signing", { exact: true }).click();
  await page.getByLabel("Sign from history saved in this browser only").check();
  await page.route("**/api/v1/**", (route) => route.abort("connectionreset"));
  // Before the commit: a failing group transaction keeps the draft and writes nothing.
  const revision = await writeReviewedDraft(page, "brodza");
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const original = LocalStore.prototype.queueGroup;
    (window as any).__restoreQueue = () => {
      LocalStore.prototype.queueGroup = original;
    };
    LocalStore.prototype.queueGroup = async () => {
      throw new Error("Injected commit failure");
    };
  });
  await spaGoto(page, "/new/publish");
  await page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true })
    .click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status").last()).toContainText(
    "Injected commit failure",
  );
  expect(await outboxRecords(page)).toHaveLength(0);
  expect((await draftState(page)).revision).toBe(revision);
  await expect(
    page.locator("aside").getByRole("button", { name: "Publish", exact: true }),
  ).toBeEnabled();
  // After the commit: a failing delivery refresh and a failing draft cleanup cannot undo the commit.
  await page.evaluate(async () => {
    (window as any).__restoreQueue();
    const { DeliveryEngine } = await import(String("/src/data/delivery.ts"));
    DeliveryEngine.prototype.invalidate = async () => {
      throw new Error("Injected refresh failure");
    };
    const originalDelete = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function (
      ...args: [IDBValidKey | IDBKeyRange]
    ) {
      if (
        this.name === "drafts" &&
        this.transaction.objectStoreNames.length === 1
      )
        throw new Error("Injected draft cleanup failure");
      return originalDelete.apply(this, args);
    };
  });
  await page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true })
    .click();
  const saved = page.getByRole("region", { name: "Saved publication" });
  await expect(saved).toContainText("Saved. Not delivered yet.");
  const first = await outboxRecords(page);
  expect(first).toHaveLength(4);
  const state = await draftState(page);
  expect(state.revision).toBeNull();
  expect(state.last?.revision).toBe(revision);
  expect(new Set(first.map((r: any) => r.group)).size).toBe(1);
  expect(state.last?.group).toBe(first[0].group);
  // Reload lands on the saved group. No Publish control exists for that revision.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Saved publication" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Saved publication" }),
  ).toContainText("Saved. Not delivered yet.");
  await expect(
    page.getByRole("button", { name: "Publish", exact: true }),
  ).toHaveCount(0);
  const after = await outboxRecords(page);
  expect(after.map((r: any) => [r.id, r.group, r.transport])).toEqual(
    first.map((r: any) => [r.id, r.group, r.transport]),
  );
  // A new draft is a separate publication.
  await page.getByRole("link", { name: "Add a word" }).click();
  await expect(page.getByRole("textbox", { name: "Meaning" })).toHaveValue("");
});

test("two tabs that publish the same reviewed revision keep one group, and a newer draft from another tab survives signing", async ({
  page,
  context,
}) => {
  await createIdentity(page);
  await page.getByText("Offline signing", { exact: true }).click();
  await page.getByLabel("Sign from history saved in this browser only").check();
  const revision = await writeReviewedDraft(page, "brode");
  await page.route("**/api/v1/**", (route) => route.abort("connectionreset"));
  await spaGoto(page, "/new/publish");
  // The second tab opens the same reviewed revision.
  const other = await context.newPage();
  await other.goto("/identity");
  await other.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
  await other.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(other.getByText("Unlocked", { exact: true })).toBeVisible();
  await other.getByText("Offline signing", { exact: true }).click();
  await other
    .getByLabel("Sign from history saved in this browser only")
    .check();
  await other.route("**/api/v1/**", (route) => route.abort("connectionreset"));
  await spaGoto(other, "/new/publish");
  await expect(other.locator("aside")).toContainText("Publish as");
  // The first tab commits.
  await page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true })
    .click();
  await acceptFirstSignature(page);
  await expect(
    page.getByRole("region", { name: "Saved publication" }),
  ).toContainText("Saved. Not delivered yet.");
  const first = await outboxRecords(page);
  expect(first).toHaveLength(4);
  // The second tab's commit finds the revision already published and shows that group.
  await other
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true })
    .click();
  // This tab's session has not seen the first-signature acknowledgment yet.
  await acceptFirstSignature(other);
  await expect(other.getByRole("status").last()).toContainText(
    "already published",
  );
  await expect(
    other.getByRole("region", { name: "Saved publication" }),
  ).toContainText("Saved. Not delivered yet.");
  await expect(
    other
      .locator("aside")
      .getByRole("button", { name: "Publish", exact: true }),
  ).toHaveCount(0);
  const after = await outboxRecords(other);
  expect(after.map((r: any) => [r.id, r.group]).sort()).toEqual(
    first.map((r: any) => [r.id, r.group]).sort(),
  );
  expect((await draftState(other)).last?.revision).toBe(revision);
  await other.close();
  // A newer draft saved by another tab during signing survives, and nothing is committed for the old revision.
  const second = await writeReviewedDraft(page, "brodi");
  await spaGoto(page, "/new/publish");
  await expect(page.locator("aside")).toContainText("Publish as");
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const original = LocalStore.prototype.queueGroup;
    LocalStore.prototype.queueGroup = async function (...args: unknown[]) {
      // Another tab saves a newer revision while this tab is still signing.
      const { newDraft } = await import(String("/src/model/draft.ts"));
      const newer = newDraft({
        spelling: "brodo",
        kind: "gismu",
        meaning: "Newer.",
        text: "Newer text.",
        structured: false,
        frameMode: "none",
        step: 5,
      });
      await new LocalStore().put("drafts", "current", newer);
      (window as any).__newerRevision = newer.revision;
      return (original as any).apply(this, args);
    };
  });
  await page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true })
    .click();
  await expect(page.getByRole("status").last()).toContainText(
    "The draft changed in another tab while signing",
  );
  await expect(
    page.getByRole("link", { name: "Review the newer draft" }),
  ).toBeVisible();
  const records = await outboxRecords(page);
  expect(records).toHaveLength(4);
  const state = await draftState(page);
  expect(state.spelling).toBe("brodo");
  const newerRevision = await page.evaluate(
    () => (window as any).__newerRevision,
  );
  expect(state.revision).toBe(newerRevision);
  expect(state.revision).not.toBe(second);
  expect(state.last?.revision).toBe(revision);
  // The link's navigation flushes nothing from the stale page. The newer draft loads intact.
  await page.getByRole("link", { name: "Review the newer draft" }).click();
  await expect(page.locator("aside")).toContainText("Publish as");
  await expect(page.locator("main")).toContainText("brodo");
  await expect(page.locator("main")).not.toContainText("brodi");
  const reviewed = await draftState(page);
  expect(reviewed.spelling).toBe("brodo");
  expect(reviewed.revision).toBe(newerRevision);
});

test("a second tab that navigates after the first tab publishes does not bring the published draft back", async ({
  page,
  context,
}) => {
  await createIdentity(page);
  await page.getByText("Offline signing", { exact: true }).click();
  await page.getByLabel("Sign from history saved in this browser only").check();
  const revision = await writeReviewedDraft(page, "brode");
  await page.route("**/api/v1/**", (route) => route.abort("connectionreset"));
  await spaGoto(page, "/new/publish");
  await expect(page.locator("aside")).toContainText("Publish as");
  // The second tab shows the same reviewed draft and then goes stale.
  const other = await context.newPage();
  await other.route("**/api/v1/**", (route) => route.abort("connectionreset"));
  await other.goto("/new/publish");
  await expect(other.locator("aside")).toContainText("Publish as");
  await page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true })
    .click();
  await acceptFirstSignature(page);
  await expect(
    page.getByRole("region", { name: "Saved publication" }),
  ).toContainText("Saved. Not delivered yet.");
  const committed = await draftState(page);
  expect(committed.revision).toBeNull();
  expect(committed.last?.revision).toBe(revision);
  const records = await outboxRecords(page);
  expect(records).toHaveLength(4);
  // Navigation in the stale tab saves nothing. Add a word starts an empty draft.
  await other.getByRole("link", { name: "Add a word", exact: true }).click();
  await expect(
    other.getByRole("textbox", { name: "Meaning", exact: true }),
  ).toHaveValue("");
  const after = await draftState(other);
  expect(after.spelling).toBe("");
  expect(after.revision).not.toBe(revision);
  expect(after.last?.revision).toBe(revision);
  expect(await outboxRecords(other)).toHaveLength(4);
  // Browser back to the stale publish page saves nothing either.
  await other.goBack();
  await expect(other.locator("aside")).toContainText("Publish as");
  await expect(
    other
      .locator("aside")
      .getByRole("button", { name: "Publish", exact: true }),
  ).toBeDisabled();
  expect((await draftState(other)).spelling).toBe("");
  expect(await outboxRecords(other)).toHaveLength(4);
  await other.close();
});

test("a delayed automatic save never replaces newer content from another tab, and a failed save keeps the unsaved edits and the saved revision", async ({
  page,
}) => {
  await createIdentity(page);
  await page.getByRole("link", { name: "Add a word" }).click();
  const box = page.getByRole("textbox", { name: "Meaning", exact: true });
  await box.fill("First text.");
  await expect(page.getByRole("status").last()).toHaveText(
    "Saved in this browser",
  );
  const storedMeaning = () =>
    page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const draft = await new LocalStore().get("drafts", "current");
      return { meaning: draft?.meaning ?? null, revision: draft?.revision };
    });
  const first = await storedMeaning();
  expect(first.meaning).toBe("First text.");
  // Another tab saves newer content.
  const newer = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const draft = await store.get("drafts", "current");
    draft.meaning = "Text from another tab.";
    draft.revision = crypto.randomUUID();
    await store.put("drafts", "current", draft);
    return draft.revision as string;
  });
  // The delayed save from this page conflicts and writes nothing.
  await box.fill("First text, edited here.");
  const status = page.getByRole("status").last();
  await expect(status).toContainText(
    "Not saved: The draft changed in another tab.",
  );
  expect(await storedMeaning()).toEqual({
    meaning: "Text from another tab.",
    revision: newer,
  });
  // The unsaved edits stay available for export.
  const exported = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export draft" }).click();
  const file = await (await exported).path();
  const content = JSON.parse(
    await (await import("node:fs/promises")).readFile(file!, "utf8"),
  );
  expect(content.meaning).toBe("First text, edited here.");
  // An explicit choice replaces the stored draft with this copy.
  await page.getByRole("button", { name: "keep this copy" }).click();
  await expect(status).toHaveText("Saved in this browser");
  const kept = await storedMeaning();
  expect(kept.meaning).toBe("First text, edited here.");
  expect(kept.revision).not.toBe(newer);
  // A storage failure leaves the saved revision and the stored content unchanged.
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const original = LocalStore.prototype.saveDraft;
    (window as any).__restorePut = () => {
      LocalStore.prototype.saveDraft = original;
    };
    LocalStore.prototype.saveDraft = async () => {
      throw new Error("Injected save failure");
    };
  });
  await box.fill("First text, edited here, and again.");
  await expect(status).toContainText(
    "Not saved: Injected save failure. Export the draft.",
  );
  expect(await storedMeaning()).toEqual(kept);
  const exportedAgain = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export draft" }).click();
  const again = JSON.parse(
    await (
      await import("node:fs/promises")
    ).readFile((await (await exportedAgain).path())!, "utf8"),
  );
  expect(again.meaning).toBe("First text, edited here, and again.");
  expect(again.revision).toBe(kept.revision);
  // The next save after the failure uses the last saved revision and succeeds.
  await page.evaluate(() => (window as any).__restorePut());
  await box.fill("First text, edited here, and again, saved.");
  await expect(status).toHaveText("Saved in this browser");
  const final = await storedMeaning();
  expect(final.meaning).toBe("First text, edited here, and again, saved.");
  expect(final.revision).not.toBe(kept.revision);
  // Navigation with nothing changed writes nothing.
  await page.getByRole("link", { name: "About", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(
    "Add a word: Meaning",
  );
  expect(await storedMeaning()).toEqual(final);
});

/** The stored draft's meaning and revision. */
async function storedDraft(page: Page) {
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const draft = await new LocalStore().get("drafts", "current");
    return draft
      ? { meaning: draft.meaning as string, revision: draft.revision as string }
      : null;
  });
}
async function failDraftSaves(page: Page, message: string) {
  await page.evaluate(async (message) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const original = LocalStore.prototype.saveDraft;
    (window as any).__restoreSave = () => {
      LocalStore.prototype.saveDraft = original;
    };
    LocalStore.prototype.saveDraft = async () => {
      throw new Error(message);
    };
  }, message);
}

test("a failed save keeps the editor on internal links and browser Back, and leaves only through an explicit choice", async ({
  page,
}) => {
  await createIdentity(page);
  await page.getByRole("link", { name: "About", exact: true }).click();
  await expect(page).toHaveURL(/\/about$/);
  await page.getByRole("link", { name: "Add a word" }).click();
  const box = page.getByRole("textbox", { name: "Meaning", exact: true });
  await box.fill("Saved original.");
  const status = page.getByRole("status").last();
  await expect(status).toHaveText("Saved in this browser");
  const saved = await storedDraft(page);
  await failDraftSaves(page, "Injected save failure");
  await box.fill("Unsaved valuable edit.");
  await expect(status).toContainText("Not saved: Injected save failure.");
  // An internal link keeps the editor and its unsaved text.
  await page.getByRole("link", { name: "About", exact: true }).click();
  await expect(status).toContainText(
    "Your unsaved edits stay on this page. Export this copy, retry, or leave without saving.",
  );
  await expect(page).toHaveURL(/\/new\/meaning$/);
  await expect(box).toHaveValue("Unsaved valuable edit.");
  expect(await storedDraft(page)).toEqual(saved);
  // Browser Back also keeps the editor, and the address stays on the editor.
  await page.goBack();
  await expect(box).toHaveValue("Unsaved valuable edit.");
  await expect(page).toHaveURL(/\/new\/meaning$/);
  await expect(status).toContainText("leave without saving");
  // The export holds the unsaved text without storage.
  const exported = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export draft" }).click();
  const content = JSON.parse(
    await (
      await import("node:fs/promises")
    ).readFile((await (await exported).path())!, "utf8"),
  );
  expect(content.meaning).toBe("Unsaved valuable edit.");
  // Retry after storage returns saves the edit, and the next link works.
  await page.evaluate(() => (window as any).__restoreSave());
  await page.getByRole("button", { name: "retry", exact: true }).click();
  await expect(status).toHaveText("Saved in this browser");
  expect((await storedDraft(page))?.meaning).toBe("Unsaved valuable edit.");
  // A new failure, then the explicit choice to leave. Storage keeps the last saved text.
  const kept = await storedDraft(page);
  await failDraftSaves(page, "Injected save failure");
  await box.fill("Edit that the user gives up.");
  await expect(status).toContainText("Not saved: Injected save failure.");
  await page.getByRole("link", { name: "About", exact: true }).click();
  await page.getByRole("button", { name: "leave without saving" }).click();
  await expect(page).toHaveURL(/\/about$/);
  expect(await storedDraft(page)).toEqual(kept);
  await page.evaluate(() => (window as any).__restoreSave());
  await page.goBack();
  await expect(box).toHaveValue("Unsaved valuable edit.");
});

test("a conflicting save keeps the editor on navigation and keeps its feedback while editing continues", async ({
  page,
}) => {
  await createIdentity(page);
  await page.getByRole("link", { name: "Add a word" }).click();
  const box = page.getByRole("textbox", { name: "Meaning", exact: true });
  await box.fill("Original.");
  const status = page.getByRole("status").last();
  await expect(status).toHaveText("Saved in this browser");
  const newer = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const draft = await store.get("drafts", "current");
    draft.meaning = "Another tab.";
    draft.revision = crypto.randomUUID();
    await store.put("drafts", "current", draft);
    return draft.revision as string;
  });
  await box.fill("My edit.");
  await expect(status).toContainText(
    "Not saved: The draft changed in another tab.",
  );
  // Further edits keep the conflict message and its control.
  await box.fill("My next edit.");
  await expect(status).not.toContainText("Saving…");
  await expect(status).toContainText(
    "Not saved: The draft changed in another tab.",
  );
  await expect(
    page.getByRole("button", { name: "keep this copy", exact: true }),
  ).toHaveCount(1);
  expect(await storedDraft(page)).toEqual({
    meaning: "Another tab.",
    revision: newer,
  });
  // A link keeps the editor, and the newer stored draft stays intact.
  await page.getByRole("link", { name: "About", exact: true }).click();
  await expect(status).toContainText("Your unsaved edits stay on this page.");
  await expect(box).toHaveValue("My next edit.");
  await expect(page).toHaveURL(/\/new\/meaning$/);
  expect(await storedDraft(page)).toEqual({
    meaning: "Another tab.",
    revision: newer,
  });
  // Browser Back keeps it too.
  await page.goBack();
  await expect(box).toHaveValue("My next edit.");
  await expect(page).toHaveURL(/\/new\/meaning$/);
  // Keeping this copy saves it, and the link then works.
  await page
    .getByRole("button", { name: "keep this copy", exact: true })
    .click();
  await expect(status).toHaveText("Saved in this browser");
  expect((await storedDraft(page))?.meaning).toBe("My next edit.");
  await page.getByRole("link", { name: "About", exact: true }).click();
  await expect(page).toHaveURL(/\/about$/);
});

test("discard in a stale tab keeps newer work that another tab saved, and discards only after a new choice", async ({
  page,
  context,
}) => {
  await createIdentity(page);
  await page.getByRole("link", { name: "Add a word" }).click();
  const box = page.getByRole("textbox", { name: "Meaning", exact: true });
  await box.fill("Old draft text.");
  await expect(page.getByRole("status").last()).toHaveText(
    "Saved in this browser",
  );
  const other = await context.newPage();
  await other.goto("/new/meaning");
  await other
    .getByRole("textbox", { name: "Meaning", exact: true })
    .fill("Newer work in another tab.");
  await expect(other.getByRole("status").last()).toHaveText(
    "Saved in this browser",
  );
  const newer = await storedDraft(other);
  expect(newer?.meaning).toBe("Newer work in another tab.");
  await other.close();
  // Discard from the stale tab deletes nothing and shows the newer draft.
  page.on("dialog", (dialog) => void dialog.accept());
  await page
    .getByRole("button", { name: "Discard draft", exact: true })
    .click();
  await expect(page.getByRole("status").last()).toContainText(
    "The draft changed in another tab. Nothing was discarded.",
  );
  await expect(box).toHaveValue("Newer work in another tab.");
  await expect(page).toHaveURL(/\/new\/meaning$/);
  expect(await storedDraft(page)).toEqual(newer);
  // A new choice from the current draft discards it.
  await page
    .getByRole("button", { name: "Discard draft", exact: true })
    .click();
  await expect(page).toHaveURL(/\/$/);
  expect(await storedDraft(page)).toBeNull();
});

test("a failed save makes the browser ask before the page unloads, and dismissing keeps the edit", async ({
  page,
}) => {
  await createIdentity(page);
  // A direct load has no earlier in-app entry, so Back leaves the page itself.
  await page.goto("/new/meaning");
  const box = page.getByRole("textbox", { name: "Meaning", exact: true });
  await box.fill("Saved original.");
  const status = page.getByRole("status").last();
  await expect(status).toHaveText("Saved in this browser");
  await failDraftSaves(page, "Injected save failure");
  await box.fill("Unsaved valuable edit.");
  await expect(status).toContainText("Not saved: Injected save failure.");
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });
  // history.back() returns at once. page.goBack() would wait for a navigation that the prompt cancels.
  await page.evaluate(() => history.back());
  await expect.poll(() => dialogs).toEqual(["beforeunload"]);
  await expect(page).toHaveURL(/\/new\/meaning$/);
  await expect(box).toHaveValue("Unsaved valuable edit.");
  expect((await storedDraft(page))?.meaning).toBe("Saved original.");
});

test("a fresh edit before the automatic save asks before a reload, and a fully saved draft does not", async ({
  page,
}) => {
  await createIdentity(page);
  await page.goto("/new/meaning");
  const box = page.getByRole("textbox", { name: "Meaning", exact: true });
  const status = page.getByRole("status").last();
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });
  await box.fill("Saved text.");
  await expect(status).toHaveText("Saved in this browser");
  // A reload of a fully saved draft asks nothing.
  await page.reload();
  await expect(box).toHaveValue("Saved text.");
  expect(dialogs).toEqual([]);
  // An edit before the timer runs is unsaved. The browser asks, and the edit stays.
  await box.fill("Fresh edit before the automatic save.");
  await page.evaluate(() => location.reload());
  await expect.poll(() => dialogs).toEqual(["beforeunload"]);
  await expect(box).toHaveValue("Fresh edit before the automatic save.");
  await expect(status).toHaveText("Saved in this browser");
  expect((await storedDraft(page))?.meaning).toBe(
    "Fresh edit before the automatic save.",
  );
  // Once saved, a reload asks nothing again and shows the saved edit.
  await page.reload();
  await expect(box).toHaveValue("Fresh edit before the automatic save.");
  expect(dialogs).toEqual(["beforeunload"]);
});

test("edits made while a navigation waits for a slow save reach storage before the page changes", async ({
  page,
}) => {
  await createIdentity(page);
  await page.getByRole("link", { name: "Add a word" }).click();
  const box = page.getByRole("textbox", { name: "Meaning", exact: true });
  const status = page.getByRole("status").last();
  await box.fill("Original.");
  await expect(status).toHaveText("Saved in this browser");
  // The next save waits until the test releases it.
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const original = LocalStore.prototype.saveDraft;
    let first = true;
    LocalStore.prototype.saveDraft = async function (...args: unknown[]) {
      if (first) {
        first = false;
        await new Promise((resolve) => {
          (window as any).__releaseSave = resolve;
        });
      }
      return (original as any).apply(this, args);
    };
  });
  await box.fill("First edit.");
  await page.waitForFunction(
    () => typeof (window as any).__releaseSave === "function",
  );
  await page.getByRole("link", { name: "About", exact: true }).click();
  // The navigation waits. A later edit arrives during the write.
  await box.fill("Later edit while the navigation is saving.");
  await expect(status).toHaveText("Saving…");
  await expect(page).toHaveURL(/\/new\/meaning$/);
  await page.evaluate(() => (window as any).__releaseSave());
  await expect(page).toHaveURL(/\/about$/);
  expect((await storedDraft(page))?.meaning).toBe(
    "Later edit while the navigation is saving.",
  );
  await page.goBack();
  await expect(box).toHaveValue("Later edit while the navigation is saving.");
});

test("a draft from the old prototype's version 1 database opens a choice instead of a loop", async ({
  page,
  context,
}) => {
  await context.addInitScript(() => {
    (window as any).__replaceState = 0;
    const original = history.replaceState.bind(history);
    history.replaceState = (...args: [any, string, string?]) => {
      (window as any).__replaceState += 1;
      return original(...args);
    };
  });
  // Seed the real version 1 database shape before the app opens it.
  await page.route("**/src/main.ts*", (route) => route.abort());
  await page.goto("/");
  const oldRow = {
    id: "current",
    word: "brodyka",
    language: "en",
    text: "Old prototype text with ① and ②.",
    places: "the first thing\nthe second thing",
    gloss: "old gloss",
    notes: "old notes",
    license: "CC-BY-4.0",
    attribution: "An old attribution",
    kind: "gismu",
    structured: true,
    unknownField: { kept: true },
  };
  await page.evaluate(
    (row) =>
      new Promise<void>((resolve, reject) => {
        const del = indexedDB.deleteDatabase("jbovlacku-browser-v1");
        del.onerror = () => reject(String(del.error));
        del.onsuccess = () => {
          const open = indexedDB.open("jbovlacku-browser-v1", 1);
          open.onupgradeneeded = () => {
            for (const name of [
              "keys",
              "drafts",
              "outbox",
              "heads",
              "packages",
            ])
              open.result.createObjectStore(name);
          };
          open.onerror = () => reject(String(open.error));
          open.onsuccess = () => {
            const tx = open.result.transaction("drafts", "readwrite");
            tx.objectStore("drafts").put(row, "current");
            tx.oncomplete = () => {
              open.result.close();
              resolve();
            };
            tx.onerror = () => reject(String(tx.error));
          };
        };
      }),
    oldRow,
  );
  await page.unroute("**/src/main.ts*");
  await page.goto("/new/meaning");
  await expect(
    page.getByRole("heading", { name: "An older draft is saved" }),
  ).toBeVisible();
  await expect(page.locator("main")).toContainText("CC-BY-4.0");
  await expect(page.locator("main")).toContainText("An old attribution");
  await page.waitForTimeout(1500);
  expect(
    await page.evaluate(() => (window as any).__replaceState),
  ).toBeLessThan(5);
  // The old row is untouched until a choice is made, and the export keeps
  // every old field, including one this build does not know.
  const rawRow = () =>
    page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      return new LocalStore().get("drafts", "current");
    });
  expect(await rawRow()).toEqual(oldRow);
  const readDownload = async (download: Promise<any>) =>
    JSON.parse(
      await (
        await import("node:fs/promises")
      ).readFile((await (await download).path())!, "utf8"),
    );
  const exported = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export the old draft" }).click();
  const content = await readDownload(exported);
  expect(content.legacy).toEqual(oldRow);
  expect(content.spelling).toBe("brodyka");
  expect(await rawRow()).toEqual(oldRow);
  // The choice screen survives a reload, and every wizard route leads to it.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "An older draft is saved" }),
  ).toBeVisible();
  await page.goto("/new/places");
  await expect(
    page.getByRole("heading", { name: "An older draft is saved" }),
  ).toBeVisible();
  expect(await rawRow()).toEqual(oldRow);
  // A newer draft from another tab is never replaced by a stale conversion or discard.
  const newer = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { newDraft } = await import(String("/src/model/draft.ts"));
    const next = newDraft({
      spelling: "brodna",
      kind: "gismu",
      meaning: "Newer draft from another tab",
      text: "Newer draft from another tab",
    });
    await new LocalStore().put("drafts", "current", next);
    return next.revision as string;
  });
  await page
    .getByRole("button", { name: "Convert it into a new draft" })
    .click();
  await expect(page.getByRole("status").last()).toContainText(
    "Nothing was converted or discarded",
  );
  expect((await rawRow()).revision).toBe(newer);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Discard the old draft" }).click();
  await expect(page.getByRole("status").last()).toContainText(
    "Nothing was converted or discarded",
  );
  expect((await rawRow()).revision).toBe(newer);
  // The old copy stays exportable from the conflict notice.
  const again = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export the old copy" }).click();
  expect((await readDownload(again)).legacy).toEqual(oldRow);
  await page.getByRole("button", { name: "Show the current draft" }).click();
  await expect(
    page.getByRole("textbox", { name: "Meaning", exact: true }),
  ).toHaveValue("Newer draft from another tab");
  // The explicit discard of the old row, then the conversion.
  const restoreOld = () =>
    page.evaluate(async (row) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      await new LocalStore().put("drafts", "current", row);
    }, oldRow);
  await restoreOld();
  await page.goto("/new/meaning");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Discard the old draft" }).click();
  await expect(
    page.getByRole("textbox", { name: "Meaning", exact: true }),
  ).toHaveValue("");
  expect((await rawRow()).version).toBe(2);
  await restoreOld();
  await page.goto("/new/meaning");
  await page
    .getByRole("button", { name: "Convert it into a new draft" })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Meaning", exact: true }),
  ).toHaveValue("Old prototype text with ① and ②.");
  const stored = await rawRow();
  expect(stored.version).toBe(2);
  expect(stored.spelling).toBe("brodyka");
  expect(stored.places.map((p: any) => p.description)).toEqual([
    "the first thing",
    "the second thing",
  ]);
  expect(stored.glosses).toEqual([
    { language: "en", text: "old gloss", sense: "" },
  ]);
  expect(stored.notes).toBe("old notes");
});

test("the full editor keeps referents on removal, saves type notes and derivations, confirms a type change, and offers a paste choice", async ({
  page,
}) => {
  await createIdentity(page);
  await page.getByRole("link", { name: "Add a word" }).click();
  await page.getByRole("link", { name: "Skip to the full editor" }).click();
  await page.getByLabel("Headword").fill("brodfa");
  await page.getByLabel("Type", { exact: true }).selectOption("cmavo");
  await page.getByLabel("selma'o").fill("UI");
  const editor = page.getByRole("textbox", { name: "Definition text" });
  const stored = () =>
    page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      return new LocalStore().get("drafts", "current");
    });
  const status = page.getByRole("status").last();
  // A type change that drops fields asks first. Cancel keeps the selma'o.
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByLabel("Type", { exact: true }).selectOption("gismu");
  await expect(page.getByLabel("Type", { exact: true })).toHaveValue("cmavo");
  await expect(page.getByLabel("selma'o")).toHaveValue("UI");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByLabel("Type", { exact: true }).selectOption("gismu");
  await expect(page.getByLabel("Type", { exact: true })).toHaveValue("gismu");
  await expect.poll(async () => (await stored()).selmaho).toEqual([]);
  // Three places, references to all of them, then removal of the second.
  for (let i = 0; i < 3; i++)
    await page.getByRole("button", { name: "+ Add a place" }).click();
  await page.getByLabel("Description for place 2").fill("the second one");
  await page.getByLabel("Description for place 3").fill("after ②");
  await editor.fill("① gives ② to ③.");
  await page.getByRole("button", { name: "Approve the numbering" }).click();
  await expect(status).toHaveText("Saved in this browser");
  let removal = "";
  page.once("dialog", (dialog) => {
    removal = dialog.message();
    void dialog.accept();
  });
  await page.getByRole("button", { name: "Remove place 2" }).click();
  await expect
    .poll(() => removal)
    .toContain(
      "Place 2 is referenced in the definition, the description of place 3",
    );
  // The reference to the removed place is literal. The reference to the old place 3 now names place 2.
  await expect(editor).toHaveValue("① gives \\② to ②.");
  await expect(page.getByLabel("Description for place 2")).toHaveValue(
    "after \\②",
  );
  await expect.poll(async () => (await stored()).places.length).toBe(2);
  const rendered = page.getByRole("region", { name: "Rendered definition" });
  await expect(rendered).not.toContainText("referenced but not declared");
  await expect(rendered.getByRole("img", { name: "place 2" })).toHaveCount(1);
  // A custom kind of thing keeps its typed note.
  await page.getByLabel("Kind of thing for place 1").selectOption("custom");
  await page.getByLabel("Type note").fill("a typed note");
  await expect
    .poll(async () => (await stored()).places[0].hint?.note)
    .toEqual([["a typed note"]]);
  // A derivation needs an explicit source place.
  await page
    .getByRole("button", { name: "Add a derivation for place 1" })
    .click();
  await page
    .getByLabel("Source word of derivation 1 for place 1")
    .fill("sinxa");
  await expect(rendered).toContainText("needs the source place number");
  await page.getByLabel("Source place of derivation 1 for place 1").fill("2");
  await expect(rendered).not.toContainText("needs the source place number");
  await expect
    .poll(async () => (await stored()).places[0].derivations)
    .toEqual([{ word: "sinxa", definition: null, place: 2, explanation: "" }]);
  // Pasted circled numbers stay literal unless the author chooses references.
  const paste = (value: string) =>
    page
      .getByRole("textbox", { name: "Definition text" })
      .evaluate((node, value) => {
        const data = new DataTransfer();
        data.setData("text/plain", value);
        (node as HTMLTextAreaElement).setSelectionRange(
          (node as HTMLTextAreaElement).value.length,
          (node as HTMLTextAreaElement).value.length,
        );
        node.dispatchEvent(
          new ClipboardEvent("paste", {
            clipboardData: data,
            bubbles: true,
            cancelable: true,
          }),
        );
      }, value);
  page.once("dialog", (dialog) => void dialog.dismiss());
  await paste(" See ① here.");
  await expect(editor).toHaveValue("① gives \\② to ②. See \\① here.");
  page.once("dialog", (dialog) => void dialog.accept());
  await paste(" And ②.");
  await expect(editor).toHaveValue("① gives \\② to ②. See \\① here. And ②.");
  await expect(rendered.getByRole("img", { name: "place 1" })).toHaveCount(1);
  await expect(rendered.getByRole("img", { name: "place 2" })).toHaveCount(2);
});

test("Revise of an independently signed rich parent with compound evidence publishes every unchanged field exactly", async ({
  page,
}) => {
  await createIdentity(page);
  await page.goto("/preferences");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(
    "The English search package is saved in this browser.",
  );
  // An independent key signs a rich lujvo body and uploads it to the test server.
  const parent = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    const { postEvent } = await import(String("/src/data/api.ts"));
    const { compoundMetadata } = await import(String("/src/model/builders.ts"));
    const built = core.buildLujvo({
      profile: "cll",
      components: [
        {
          id: "a",
          spelling: "cukta",
          kind: "gismu",
          claims: [{ rafsi: "cku", pair: "jvr1:" + "c".repeat(64) }],
        },
        {
          id: "b",
          spelling: "valsi",
          kind: "gismu",
          claims: [{ rafsi: "vla", pair: "jvr1:" + "d".repeat(64) }],
        },
      ],
    });
    const candidate = built.candidates[0];
    const compound = compoundMetadata(
      built,
      candidate,
      [
        {
          id: "a",
          spelling: "cukta",
          kind: "gismu",
          definition: null,
          gloss: "",
          claims: [],
          locked: null,
        },
        {
          id: "b",
          spelling: "valsi",
          kind: "gismu",
          definition: null,
          gloss: "",
          claims: [],
          locked: null,
        },
      ],
      "built for the test",
    );
    const body = {
      word: { language: "jbo", spelling: candidate.spelling },
      language: "en",
      text: [
        [
          "Rich ",
          { url: "https://example.org/r", label: "" },
          " text with `code`, ",
          { code: "ko'a" },
          " and literal ① at ",
          1,
          "  ",
        ],
        ["second paragraph with a blank\n\nline inside"],
      ],
      frame: {
        role: "constructed-predicate",
        arity: { mode: "fixed", count: 1 },
        places: [
          {
            index: 1,
            glosses: [{ language: "fr", text: "livre  ", sense: "a" }],
            description: [
              [
                "the word ",
                { word: { language: "jbo", spelling: "cukta" }, label: "" },
              ],
            ],
            type_hints: [
              {
                alternatives: [
                  { tags: ["entity"], abstractor: null, relation_arity: null },
                ],
                note: [["note ", 1]],
              },
            ],
            defaults: [
              {
                kind: "suggested",
                value: { format: "lojban", text: "zo'e" },
                condition: [["when ", 1]],
                explanation: [[{ code: "" }]],
              },
            ],
            constraints: [],
            derivation: [
              {
                word: { language: "jbo", spelling: "cukta" },
                definition: null,
                place: 1,
                explanation: [["from cukta "]],
              },
            ],
          },
        ],
        tail: null,
        constraints: [],
      },
      operands: [],
      glosses: [{ language: "en", text: "word of a book", sense: null }],
      notes: [["notes  "]],
      etymology: {
        text: [["from cukta and valsi"]],
        formation: null,
        compound,
      },
      examples: [
        {
          language: "jbo",
          text: "mi " + candidate.spelling,
          translation: [["I ", { code: "x" }]],
          notes: [],
        },
      ],
      classification: { kind: "lujvo", selmaho: [] },
      labels: ["parent"],
      sources: [
        {
          label: " src ",
          url: "https://example.org/s",
          event: null,
          locator: null,
        },
      ],
      license: {
        expression: "CC0-1.0",
        url: "https://creativecommons.org/publicdomain/zero/1.0/",
        attribution: "",
      },
      legacy: null,
    };
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const event = core.createEvent(
      seed,
      [],
      "7".repeat(32),
      {
        kind: "definition.publish",
        word: core.wordId(body.word),
        language: "en",
        parents: [],
        origin: "native",
      },
      body,
    );
    const receipt = await postEvent(
      JSON.stringify({ envelope: event.envelope, body: event.body }),
    );
    return {
      id: event.envelope.id as string,
      body,
      admission: receipt.admission as string,
      spelling: candidate.spelling as string,
    };
  }, corePath);
  expect(parent.admission).toBe("accepted");
  // Revise through the real route, keep the draft through a reload, and change one harmless field.
  await page.goto(`/new/editor?revise=${encodeURIComponent(parent.id)}`);
  await expect(page.locator("main")).toContainText(
    "This draft copies every field of the parent definition.",
  );
  await page.reload();
  await expect(page.getByLabel("Headword")).toHaveValue(parent.spelling);
  await page.getByLabel("Labels").fill("parent, revised");
  await expect(page.getByRole("status").last()).toHaveText(
    "Saved in this browser",
  );
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.locator("aside")).toContainText("Publish as");
  await expect(page.getByText(/problems? block signing/)).toHaveCount(0);
  await page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true })
    .click();
  // The reload locked the key, so signing asks for the passphrase first.
  const unlock = page.getByRole("dialog", { name: "Unlock your key" });
  await unlock.getByLabel("Passphrase").fill(PASSPHRASE);
  await unlock.getByRole("button", { name: "Unlock" }).click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toContainText(/Published/);
  const records = await outboxRecords(page);
  const published = records
    .map((r: any) => JSON.parse(r.transport))
    .find((t: any) => t.envelope.header.action.kind === "definition.publish");
  expect(published.envelope.header.action.parents).toEqual([parent.id]);
  const { labels: parentLabels, ...parentRest } = parent.body as any;
  const { labels: revisedLabels, ...revisedRest } = published.body;
  expect(revisedLabels).toEqual(["parent", "revised"]);
  expect(parentLabels).toEqual(["parent"]);
  expect(revisedRest).toEqual(parentRest);
});

test("moving a place keeps every referent, and a language change keeps each place gloss's language", async ({
  page,
}) => {
  await createIdentity(page);
  await page.getByRole("link", { name: "Add a word" }).click();
  await page.getByRole("link", { name: "Skip to the full editor" }).click();
  await page.getByLabel("Headword").fill("brodgu");
  await page.getByLabel("Type", { exact: true }).selectOption("gismu");
  const editor = page.getByRole("textbox", { name: "Definition text" });
  for (let i = 0; i < 3; i++)
    await page.getByRole("button", { name: "+ Add a place" }).click();
  await page.getByLabel("Description for place 1").fill("first");
  await page.getByLabel("Description for place 2").fill("second, after ①");
  await page.getByLabel("Description for place 3").fill("third");
  await editor.fill("① gives ② to ③.");
  await page.getByLabel("Add a gloss for place 1").fill("fr: premier");
  await page.getByLabel("Add a gloss for place 1").press("Enter");
  await page.getByRole("button", { name: "Approve the numbering" }).click();
  const stored = () =>
    page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      return new LocalStore().get("drafts", "current");
    });
  // Move the second place up: it becomes place 1, and every reference follows.
  await page.getByRole("button", { name: "Move place 2 up" }).click();
  await expect(editor).toHaveValue("② gives ① to ③.");
  await expect(page.getByLabel("Description for place 1")).toHaveValue(
    "second, after ②",
  );
  await expect(page.getByLabel("Description for place 2")).toHaveValue("first");
  await page.getByRole("button", { name: "Move place 3 up" }).click();
  await expect(editor).toHaveValue("③ gives ① to ②.");
  // The automatic save runs after the edits settle.
  await expect
    .poll(async () => (await stored()).places.map((p: any) => p.description))
    .toEqual(["second, after ③", "third", "first"]);
  const draft = await stored();
  expect(draft.places[1].glosses).toEqual([]);
  expect(draft.places[2].glosses).toEqual([
    { language: "fr", text: "premier", sense: "" },
  ]);
  // A definition language change does not relabel place glosses.
  await page.getByLabel("Definition language").fill("de");
  await expect.poll(async () => (await stored()).language).toBe("de");
  expect((await stored()).places[2].glosses[0].language).toBe("fr");
});

test("root conflicts of a gismu are checked again against the current package before publication", async ({
  page,
}) => {
  await createIdentity(page);
  await page.goto("/preferences");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(
    "The English search package is saved in this browser.",
  );
  // A reviewed gismu draft whose recorded run acknowledged no conflict, for a form the package now holds.
  await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { newDraft } = await import(String("/src/model/draft.ts"));
    const { manualFormation } = await import(String("/src/model/builders.ts"));
    const preset = core.builderPresets().find((p: any) => p.id === "cll-1995");
    const rows = preset.languages.map((l: any) => ({
      language: l.language,
      name: l.name,
      word: l.language,
      input: "cukta",
      weight: {
        numerator: String(l.numerator),
        denominator: String(preset.denominator),
      },
    }));
    const draft = newDraft({
      spelling: "cukta",
      kind: "gismu",
      meaning: "A disposable root.",
      text: "A disposable root.",
      structured: false,
      frameMode: "none",
      step: 5,
      formation: manualFormation(rows, "Chosen before the package changed."),
      evidenceForm: "cukta",
      gismu: {
        preset: preset.id,
        rows,
        candidates: "source-letters",
        selected: null,
        manual: "cukta",
        acknowledged: [],
        reason: "",
        window: 12,
      },
    });
    await new LocalStore().put("drafts", "current", draft);
  }, corePath);
  await page.goto("/new/publish");
  const conflicts = page.getByRole("region", { name: "Known conflicts" });
  await expect(conflicts).toContainText(
    "Root conflicts were checked again against the local package",
  );
  await expect(conflicts).toContainText(
    "New since the recorded run: identical conflict with cukta",
  );
  const publish = page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true });
  await expect(publish).toBeDisabled();
  await page
    .getByLabel(
      /although the refreshed package shows a new root conflict with cukta/,
    )
    .check();
  await expect(publish).toBeEnabled();
});
