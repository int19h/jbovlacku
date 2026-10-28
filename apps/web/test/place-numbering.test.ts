import { test, expect, type Page } from "@playwright/test";
import {
  acceptFirstSignature,
  createIdentity,
  corePath,
  PASSPHRASE,
} from "./helpers.ts";

const ordinary =
  "A place stays in the meaning even when nobody says it. Only zi'o removes it. That is why a container with no lid is not a botpi, whose x4 is the lid. Keep the places that the idea cannot do without, and add other details when needed with a tag such as sepi'o (\"using tool\").";
const firmer =
  "Few good definitions have more than five places, because a word with that many is hard to use. A place stays in the meaning even when nobody says it, and only zi'o removes it. Keep the places that the idea cannot do without, and add other details when needed with a tag such as sepi'o (\"using tool\").";

async function seed(
  page: Page,
  options: {
    meaning?: string;
    count?: number;
    frameMode?: string;
    kind?: string;
    operands?: boolean;
    indices?: number[];
  } = {},
) {
  await page.evaluate(async (options) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { newDraft, newPlace } = await import(String("/src/model/draft.ts"));
    const draft = newDraft({
      spelling: "brodu",
      kind: options.kind ?? "gismu",
      meaning: options.meaning ?? "A disposable test meaning.",
      text: options.meaning ? [] : [["A disposable test definition."]],
      frameMode: options.frameMode ?? "fixed",
      places: (
        options.indices ??
        Array.from({ length: options.count ?? 0 }, (_, i) => i + 1)
      ).map((index) => newPlace(index)),
      tail:
        options.frameMode === "variadic"
          ? { description: [], kind: "unspecified", hint: null }
          : null,
      frameRole: options.operands ? "constructed-predicate" : "predicate",
      operands: options.operands
        ? Array.from({ length: 6 }, (_, i) => ({
            id: `arg${i}`,
            category: "sumti",
            minimum: 1,
            maximum: 1,
            description: [],
          }))
        : [],
      step: 4,
    });
    await new LocalStore().put("drafts", "current", draft);
  }, options);
}

const note = (page: Page) => page.getByRole("note");
const parts = (page: Page) =>
  page.getByRole("list", { name: "Places used in each part" });

test("semicolon parts restart blank numbering before approval and preserve the signed places", async ({
  page,
}) => {
  await createIdentity(page);
  const meaning =
    "___ seemingly has property ___; ___ seems to have property ___ but actually doesn't";
  await seed(page, { meaning });
  await page.goto("/new/meaning");
  await expect(
    page.getByText("2 placeholders found.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("link", { name: /^Places\b/ }).click();
  await expect(parts(page).getByRole("listitem")).toHaveCount(2);
  await expect(
    parts(page).getByRole("listitem").nth(0).locator("p.meta"),
  ).toHaveText("Part 1: places 1, 2");
  await expect(
    parts(page).getByRole("listitem").nth(1).locator("p.meta"),
  ).toHaveText("Part 2: places 1, 2");
  await page
    .getByRole("button", { name: "Use the meaning with numbered places" })
    .click();
  await expect(page.getByLabel("Definition text")).toHaveValue(
    "① seemingly has property ②; ① seems to have property ② but actually doesn't",
  );
  await expect(
    page.getByLabel("Description for place 2", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Description for place 3", { exact: true }),
  ).toHaveCount(0);
  await expect(
    parts(page).getByRole("listitem").nth(1).locator("p.meta"),
  ).toHaveText("Part 2: places 1, 2");
  await page.getByRole("button", { name: "Approve the numbering" }).click();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(
    page.locator("aside").getByRole("button", { name: "Publish", exact: true }),
  ).toBeEnabled();
  await page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Unlock your key" })
    .getByLabel("Passphrase", { exact: true })
    .fill(PASSPHRASE);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await acceptFirstSignature(page);
  await expect(page).toHaveTitle("brodu · jbovlacku");
  const body = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const outbox = await new LocalStore().list("outbox");
    return outbox
      .map((item: any) => JSON.parse(item.transport))
      .find(
        (item: any) =>
          item.envelope.header.action.kind === "definition.publish",
      ).body;
  });
  expect(body.frame.arity).toEqual({ mode: "fixed", count: 2 });
  expect(body.text).toEqual([
    [
      1,
      " seemingly has property ",
      2,
      "; ",
      1,
      " seems to have property ",
      2,
      " but actually doesn't",
    ],
  ]);
});

test("explicit numbers reserve places per part and escaped numbers stay literal", async ({
  page,
}) => {
  await page.goto("/");
  await seed(page, {
    meaning: String.raw`___ sees ① with ___; \③ stays literal beside ___ and {place 4}`,
  });
  await page.goto("/new/meaning");
  await expect(
    page.getByText("4 placeholders found.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("link", { name: /^Places\b/ }).click();
  await expect(
    parts(page).getByRole("listitem").nth(0).locator("p.meta"),
  ).toHaveText("Part 1: places 1, 2, 3");
  await expect(
    parts(page).getByRole("listitem").nth(1).locator("p.meta"),
  ).toHaveText("Part 2: places 1, 4");
  await page
    .getByRole("button", { name: "Use the meaning with numbered places" })
    .click();
  await expect(page.getByLabel("Definition text")).toHaveValue(
    String.raw`② sees ① with ③; \③ stays literal beside ① and ④`,
  );
  await expect(note(page)).toContainText(ordinary);
  await expect(
    parts(page).getByRole("listitem").nth(1).locator(".pl"),
  ).toHaveCount(2);
  // The breakdown follows edits to the definition before approval.
  await page.getByLabel("Definition text").fill("① sees ②; ③ stays with ④");
  await expect(
    parts(page).getByRole("listitem").nth(0).locator("p.meta"),
  ).toHaveText("Part 1: places 1, 2");
  await expect(
    parts(page).getByRole("listitem").nth(1).locator("p.meta"),
  ).toHaveText("Part 2: places 3, 4");
});

test("places above twenty use the explicit editor token", async ({ page }) => {
  await page.goto("/");
  await seed(page, { meaning: Array(21).fill("___").join(" with ") });
  await page.goto("/new/meaning");
  await expect(
    page.getByText("21 placeholders found.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("link", { name: /^Places\b/ }).click();
  await page
    .getByRole("button", { name: "Use the meaning with numbered places" })
    .click();
  await expect(page.getByLabel("Definition text")).toHaveValue(
    /⑳ with \{place 21\}$/u,
  );
  await expect(
    page.getByLabel("Description for place 21", { exact: true }),
  ).toBeVisible();
  await expect(note(page).getByRole("heading")).toHaveText(
    "Are all 21 places needed?",
  );
});

test("the note changes at four and six places and the help works by keyboard", async ({
  page,
}) => {
  await createIdentity(page);
  await seed(page, { count: 3 });
  await page.goto("/new/places");
  await expect(note(page)).toHaveCount(0);
  await page
    .getByRole("button", { name: "+ Add a place", exact: true })
    .click();
  await expect(note(page).getByRole("heading")).toHaveText(
    "Does every place belong?",
  );
  await expect(note(page).locator("p").first()).toHaveText(ordinary);
  const help = note(page).locator("summary");
  await help.focus();
  await page.keyboard.press("Enter");
  await expect(note(page)).toContainText(
    "An omitted place is zo'e, the value that the speaker means.",
  );
  await expect(note(page)).toContainText(
    "zbasu still has a maker. zi'o makes a different relation.",
  );
  await expect(note(page)).toContainText(
    "BAI tags such as sepi'o, ma'e, and bau, or fi'o with any selbri.",
  );
  await expect(note(page)).toContainText(
    "bamri: x1 buys x2 from x3 for price x4.",
  );
  await expect(
    note(page).getByRole("link", { name: "CLL 7.7" }),
  ).toHaveAttribute("href", "https://lojban.github.io/cll/7/7/");
  await expect(
    note(page).getByRole("link", { name: "CLL 9.5" }),
  ).toHaveAttribute("href", "https://lojban.github.io/cll/9/5/");
  await page
    .getByRole("button", { name: "+ Add a place", exact: true })
    .click();
  await expect(note(page).getByRole("heading")).toHaveText(
    "Does every place belong?",
  );
  await page
    .getByRole("button", { name: "+ Add a place", exact: true })
    .click();
  await expect(note(page).getByRole("heading")).toHaveText(
    "Are all 6 places needed?",
  );
  await expect(note(page).locator("p").first()).toHaveText(firmer);
  await expect(
    page.getByRole("checkbox", { name: /acknowledge|needed|belong/i }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page).toHaveTitle("Add a word: Publish · jbovlacku");
  await expect(
    page.locator("aside").getByRole("button", { name: "Publish", exact: true }),
  ).toBeEnabled();
});

test("the full editor counts declarations and the repeating tail once, excluding operands and null frames", async ({
  page,
}) => {
  await page.goto("/");
  await seed(page, { count: 3, operands: true });
  await page.goto("/new/editor");
  await expect(note(page)).toHaveCount(0);
  await page
    .getByLabel("Number of places", { exact: true })
    .selectOption("variadic");
  await expect(note(page).getByRole("heading")).toHaveText(
    "Does every place belong?",
  );
  await page.getByLabel("Minimum number of places").fill("100");
  await expect(note(page).getByRole("heading")).toHaveText(
    "Does every place belong?",
  );
  await page
    .getByLabel("Number of places", { exact: true })
    .selectOption("none");
  await expect(note(page)).toHaveCount(0);
  await page
    .getByLabel("Number of places", { exact: true })
    .selectOption("context");
  await expect(note(page)).toHaveCount(0);
  await page.goto("/");
  await seed(page, { frameMode: "context", indices: [1, 20, 200] });
  await page.goto("/new/editor");
  await expect(note(page)).toHaveCount(0);
});

test("hiding the note survives navigation and reload for this draft and does not affect signed records", async ({
  page,
}) => {
  await createIdentity(page);
  await seed(page, { count: 6 });
  await page.goto("/new/editor");
  await expect(note(page)).toContainText(firmer);
  const before = await page.evaluate(async (corePath) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { draftToBody } = await import(String("/src/model/draft.ts"));
    const { omitDefinitionDefaults } = await import(corePath);
    return omitDefinitionDefaults(
      draftToBody(await new LocalStore().get("drafts", "current")).body,
    );
  }, corePath);
  await note(page).getByRole("button", { name: "Hide for this draft" }).click();
  await expect(note(page)).toHaveCount(0);
  await expect(
    page.getByLabel("Number of places", { exact: true }),
  ).toBeFocused();
  await expect(page.getByText("Saved in this browser")).toBeVisible();
  await page.reload();
  await expect(note(page)).toHaveCount(0);
  await page.getByRole("link", { name: /^Places\b/ }).click();
  await expect(note(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  const publish = page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true });
  await expect(publish).toBeEnabled();
  await publish.click();
  await page
    .getByRole("dialog", { name: "Unlock your key" })
    .getByLabel("Passphrase", { exact: true })
    .fill(PASSPHRASE);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await acceptFirstSignature(page);
  await expect(page).toHaveTitle("brodu · jbovlacku");
  const body = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const outbox = await new LocalStore().list("outbox");
    return outbox
      .map((item: any) => JSON.parse(item.transport))
      .find(
        (item: any) =>
          item.envelope.header.action.kind === "definition.publish",
      ).body;
  });
  expect(body).toEqual(before);
  expect(JSON.stringify(body)).not.toContain("placeCountNoteHidden");
  await seed(page, { count: 4 });
  await page.goto("/new/editor");
  await expect(note(page)).toContainText(ordinary);
});

test("the note fits a narrow screen and its controls meet the touch target rule", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  await seed(page, { count: 6 });
  await page.goto("/new/places");
  await expect(note(page)).toContainText(firmer);
  for (const control of [
    note(page).locator("summary"),
    note(page).getByRole("button", { name: "Hide for this draft" }),
  ]) {
    const box = await control.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(360);
  await note(page).locator("summary").click();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(360);
});

test("the note applies to every lexical kind", async ({ page }) => {
  await page.goto("/");
  const kinds: string[] = await page.evaluate(async () => {
    const { lexicalKinds } = await import(String("/src/model/types.ts"));
    return lexicalKinds;
  });
  for (const kind of kinds) {
    await seed(page, { count: 4, kind });
    await page.goto("/new/editor");
    await expect(note(page).getByRole("heading")).toHaveText(
      "Does every place belong?",
    );
  }
});

test("edited code, links, and escaped glyphs do not add places to the breakdown", async ({
  page,
}) => {
  await page.goto("/");
  await seed(page, { count: 2 });
  await page.goto("/new/places");
  await page
    .getByLabel("Definition text")
    .fill(String.raw`① sees \③ with ` + "`④; literal` [[cukta|⑤; literal]]; ②");
  await expect(parts(page).getByRole("listitem")).toHaveCount(2);
  await expect(
    parts(page).getByRole("listitem").nth(0).locator("p.meta"),
  ).toHaveText("Part 1: places 1");
  await expect(
    parts(page).getByRole("listitem").nth(1).locator("p.meta"),
  ).toHaveText("Part 2: places 2");
});

test("an excessive explicit number keeps the editor within the frame limit", async ({
  page,
}) => {
  await page.goto("/");
  await seed(page, { meaning: "{place 65535} is explicit" });
  await page.goto("/new/places");
  await page
    .getByRole("button", { name: "Use the meaning with numbered places" })
    .click();
  await expect(page.locator(".place-row")).toHaveCount(256);
  await expect(
    page.getByRole("region", { name: "Rendered definition" }),
  ).toContainText(
    "Place 65535 is referenced in the definition but not declared.",
  );
});

test("Meaning preserves every noncircled backslash when the author uses its text", async ({
  page,
}) => {
  await page.goto("/");
  const prefix =
    String.raw`regex \[a-z] and C:\\share and \{operand x} ` + "\\`code\\` ";
  const meaning = prefix + String.raw`___; \{place 4} and \① beside ___`;
  await seed(page, { meaning });
  await page.goto("/new/meaning");
  await expect(
    page.getByText("Every other backslash stays as typed.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("link", { name: /^Places\b/ }).click();
  await expect(parts(page).locator("p.meta")).toHaveText([
    "Part 1: places 1",
    "Part 2: places 1, 4",
  ]);
  await page
    .getByRole("button", { name: "Use the meaning with numbered places" })
    .click();
  await expect(page.getByText("Saved in this browser")).toBeVisible();
  const saved = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().get("drafts", "current");
  });
  expect(saved.meaning).toBe(meaning);
  expect(saved.text).toEqual([[prefix, 1, "; \\", 4, " and ① beside ", 1]]);
  await page.getByRole("link", { name: /^Meaning\b/ }).click();
  await expect(
    page.getByRole("textbox", { name: "Meaning", exact: true }),
  ).toHaveValue(meaning);
});
