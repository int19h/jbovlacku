import { test, expect, type Page, type Locator } from "@playwright/test";
import { createIdentity, corePath } from "./helpers.ts";
import { setRichNodes } from "./rich-helpers.ts";

async function seed(page: Page, fields = false) {
  await page.goto("/");
  await page.evaluate(async (fields) => {
    const { newDraft, newPlace } = await import(String("/src/model/draft.ts"));
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const value = [
      [
        { code: "first\n\nlast" },
        { code: "" },
        { word: { language: "jbo", spelling: "https://cukta" }, label: "" },
        { url: "https://example.org/", label: " label\n\nlast " },
      ],
    ];
    const place = newPlace(1);
    const draft = newDraft({
      spelling: "broda",
      kind: "gismu",
      meaning: "A private test meaning.",
      text: [],
      frameMode: "context",
      places: [place, newPlace(4)],
      step: 4,
    });
    if (fields) {
      draft.text = value;
      draft.notes = value;
      draft.etymologyText = value;
      draft.frameConstraints = [value];
      place.description = value;
      place.constraints = [value];
      place.defaults = [
        {
          kind: "suggested",
          format: "lojban",
          language: "en",
          text: "zo'e",
          condition: value,
          explanation: value,
        },
      ];
      place.derivations = [
        { word: "cukta", definition: null, place: 1, explanation: value },
      ];
      place.kind = "custom";
      place.hint = {
        alternatives: [
          { tags: ["referent"], abstractor: null, relation_arity: null },
        ],
        note: value,
      };
      draft.examples = [
        { language: "jbo", text: "mi broda", translation: value, notes: value },
      ];
      draft.operands = [
        {
          id: "bridi",
          category: "bridi",
          minimum: 1,
          maximum: 1,
          description: value,
        },
      ];
      draft.rafsiClaims = [{ rafsi: "bro", rationale: value }];
    }
    await new LocalStore().put("drafts", "current", draft);
  }, fields);
  await page.goto("/new/editor");
  await expect(
    page.getByLabel("Definition text", { exact: true }),
  ).toHaveAttribute("contenteditable", "true");
}
const editor = (page: Page) =>
  page.getByRole("textbox", { name: "Definition text", exact: true });
const toolbar = (page: Page) =>
  page.getByRole("toolbar", {
    name: "Definition text formatting",
    exact: true,
  });
const nodes = (field: Locator) => field.evaluate((node: any) => node.value);
async function paste(field: Locator, plain: string, html = "") {
  await field.focus();
  await field.evaluate(
    (node, { plain, html }) => {
      const data = new DataTransfer();
      data.setData("text/plain", plain);
      data.setData("text/html", html);
      node.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        }),
      );
    },
    { plain, html },
  );
}

test("typed places, exact TeX, undo, keyboard toolbar, and 50-place dropdown", async ({
  page,
}) => {
  await seed(page);
  const field = editor(page);
  await expect(field).toHaveAttribute("aria-multiline", "true");
  await field.pressSequentially("___");
  await expect(
    field.getByRole("img", { name: "place 1", exact: true }),
  ).toHaveCount(1);
  await field.press("Backspace");
  await expect(field).toHaveText("___");
  await field.fill("");
  await field.pressSequentially("\\{ \\[ \\\\ \\__4__");
  expect(await nodes(field)).toEqual([["\\{ \\[ \\\\ \\", 4]]);
  await field.press("Control+z");
  await field.press("Control+Shift+z");
  await expect(
    field.getByRole("img", { name: "place 4", exact: true }),
  ).toHaveCount(1);
  const more = toolbar(page).getByLabel("More places");
  await more.focus();
  await expect(more.locator('option[value="4"]')).toHaveText(
    "Place 4 (declared)",
  );
  await more.selectOption("50");
  await toolbar(page)
    .getByRole("button", { name: "Insert selected place" })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    field.getByRole("img", { name: "place 50", exact: true }),
  ).toHaveCount(1);
  for (const control of await toolbar(page).getByRole("button").all()) {
    const box = await control.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
});

test("clearing a preexisting field and editing blank paragraphs keep valid stored arrays", async ({
  page,
}) => {
  await seed(page, true);
  const field = editor(page);
  await field.fill("");
  expect(await nodes(field)).toEqual([]);
  const inspect = async () =>
    page.evaluate(async (path) => {
      const core = await import(path);
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { draftToBody, coreProblems } = await import(
        String("/src/model/draft.ts")
      );
      const draft = await new LocalStore().get("drafts", "current");
      const body = draftToBody(draft).body;
      return {
        text: draft.text,
        core: coreProblems(body, core.wordId(body.word), [], "native"),
      };
    }, corePath);
  await expect.poll(async () => (await inspect()).text).toEqual([]);
  expect((await inspect()).core).toEqual([]);
  await field.pressSequentially("first");
  await field.press("Enter");
  expect(await nodes(field)).toEqual([["first"]]);
  await field.pressSequentially("second");
  await expect
    .poll(async () => (await inspect()).text)
    .toEqual([["first"], ["second"]]);
  expect((await inspect()).core).toEqual([]);
});

test("word links and code use accessible dialogs and preserve empty labels", async ({
  page,
}) => {
  await seed(page);
  await toolbar(page)
    .getByRole("button", { name: "Link a word", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Link a word", exact: true });
  await expect(dialog.getByLabel("Lojban word")).toBeFocused();
  await dialog.getByLabel("Lojban word").fill("https://cukta");
  await dialog.getByRole("button", { name: "Insert", exact: true }).click();
  await expect(
    toolbar(page).getByRole("button", { name: "Link a word", exact: true }),
  ).toBeFocused();
  await toolbar(page)
    .getByRole("button", { name: "Insert code", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Insert code" })
    .getByRole("button", { name: "Insert", exact: true })
    .click();
  expect(await nodes(editor(page))).toEqual([
    [
      { word: { language: "jbo", spelling: "https://cukta" }, label: "" },
      { code: "" },
    ],
  ]);
  await toolbar(page)
    .getByRole("button", { name: "Web link", exact: true })
    .click();
  await page.getByRole("dialog", { name: "Web link" }).press("Escape");
  await expect(
    toolbar(page).getByRole("button", { name: "Web link", exact: true }),
  ).toBeFocused();
});

test("paragraph keys and toolbar insertion work inside literal, code, and link nodes", async ({
  page,
}) => {
  await seed(page);
  const field = editor(page);
  await setRichNodes(field, [
    [
      "before after",
      { code: "code" },
      { word: { language: "jbo", spelling: "cukta" }, label: "word" },
    ],
  ]);
  const caret = async (selector: string, offset: number) => {
    await field.focus();
    await field
      .locator(selector)
      .first()
      .evaluate((node, offset) => {
        const range = document.createRange();
        range.setStart(node.firstChild!, offset);
        range.collapse(true);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
      }, offset);
  };
  await caret(".rich-literal", 6);
  await page.keyboard.press("Shift+Enter");
  expect((await nodes(field))[0][0]).toBe("before\n after");
  await caret(".rich-literal", 6);
  await page.keyboard.press("Enter");
  expect(await nodes(field)).toEqual([
    ["before"],
    [
      "\n after",
      { code: "code" },
      { word: { language: "jbo", spelling: "cukta" }, label: "word" },
    ],
  ]);
  await caret(".rich-code", 2);
  await page.keyboard.press("Enter");
  expect((await nodes(field))[1][1]).toEqual({ code: "co\nde" });
  await toolbar(page)
    .getByRole("button", { name: "Insert place 2", exact: true })
    .click();
  expect((await nodes(field))[1].slice(1, 3)).toEqual([{ code: "co\nde" }, 2]);
  await caret(".rich-word-link", 2);
  await toolbar(page)
    .getByRole("button", { name: "Insert code", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Insert code" })
    .getByLabel("Code", { exact: true })
    .fill("after link");
  await page
    .getByRole("dialog", { name: "Insert code" })
    .getByRole("button", { name: "Insert", exact: true })
    .click();
  expect((await nodes(field))[1].at(-1)).toEqual({ code: "after link" });
});

test("the Lujvo builder edits its current rich definition without flattening nodes", async ({
  page,
}) => {
  await seed(page, true);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const draft = await store.get("drafts", "current");
    draft.kind = "lujvo";
    await store.put("drafts", "current", draft);
  });
  await page.goto("/new/lujvo");
  const field = page.getByRole("textbox", {
    name: "Current definition",
    exact: true,
  });
  await expect(field).toHaveAttribute("contenteditable", "true");
  const before = await nodes(field);
  await field.press("Control+End");
  await field.pressSequentially(" builder edit");
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        return (await new LocalStore().get("drafts", "current")).text;
      }),
    )
    .toEqual([[...before[0], " builder edit"]]);
});

test("paste is inert plain text with a deliberate circled-number choice", async ({
  page,
}) => {
  await seed(page);
  const field = editor(page);
  const text = "<img src=x onerror=alert(1)> [[cukta]] `code` ___ ㉑㊱㊿⓪";
  await paste(field, text, '<img src="x" onerror="alert(1)"><b>unsafe</b>');
  await page
    .getByRole("dialog", { name: "Paste circled numbers" })
    .getByRole("button", { name: "Keep literal text" })
    .click();
  expect(await nodes(field)).toEqual([[text]]);
  await expect(field.locator("img,a,script,b")).toHaveCount(0);
  await field.fill("");
  await paste(field, "___ ㉑㊱㊿⓪");
  await page
    .getByRole("dialog", { name: "Paste circled numbers" })
    .getByRole("button", { name: "Convert circled numbers" })
    .click();
  expect(await nodes(field)).toEqual([["___ ", 21, 36, 50, "⓪"]]);
});

test("copy retains readable place and operand chips in plain text", async ({
  page,
}) => {
  await seed(page);
  const field = editor(page);
  await setRichNodes(field, [[1, " ", { operand: "bridi" }, " ", 50]]);
  await field.press("Control+a");
  const copied = await field.evaluate((node) => {
    const data = new DataTransfer();
    node.dispatchEvent(
      new ClipboardEvent("copy", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
    return data.getData("text/plain");
  });
  expect(copied).toBe("① [bridi] ㊿");
  await field.fill("");
  await paste(field, copied);
  await page
    .getByRole("dialog", { name: "Paste circled numbers" })
    .getByRole("button", { name: "Keep literal text" })
    .click();
  expect(await nodes(field)).toEqual([[copied]]);
});

test("literal mode preserves typed numbers and keeps code and links while editing", async ({
  page,
}) => {
  await seed(page, true);
  await page.getByLabel("Read circled numbers as place references").uncheck();
  await editor(page).press("Control+End");
  await editor(page).pressSequentially(" ㊿ ___");
  await expect(editor(page).getByRole("img")).toHaveCount(0);
  const value = await nodes(editor(page));
  expect(value[0].slice(0, 4)).toEqual([
    { code: "first\n\nlast" },
    { code: "" },
    { word: { language: "jbo", spelling: "https://cukta" }, label: "" },
    { url: "https://example.org/", label: " label\n\nlast " },
  ]);
  expect(value[0].at(-1)).toBe(" ㊿ ___");
  await page.getByLabel("Read circled numbers as place references").check();
  await expect(
    editor(page).getByRole("img", { name: "place 50", exact: true }),
  ).toHaveCount(1);
});

test("Chromium IME composition converts once and Backspace restores the token", async ({
  page,
}) => {
  await seed(page);
  await editor(page).focus();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", {
    text: "__50__",
    selectionStart: 6,
    selectionEnd: 6,
  });
  await cdp.send("Input.insertText", { text: "__50__" });
  await expect(
    editor(page).getByRole("img", { name: "place 50", exact: true }),
  ).toHaveCount(1);
  await editor(page).press("Backspace");
  await expect(editor(page)).toHaveText("__50__");
  await cdp.detach();
});

test("every definition rich field edits nodes and preserves untouched multiline values", async ({
  page,
}) => {
  await seed(page, true);
  const labels = [
    "Definition text",
    "Description for place 1",
    "Type note",
    "Condition 1 for place 1",
    "Explanation of default 1 for place 1",
    "Constraint 1 for place 1",
    "Constraint 1 between places",
    "Notes",
    "Translation of example 1",
    "Notes for example 1",
    "Etymology",
    "Operand 1 description",
    "Explanation of derivation 1 for place 1",
    "Rationale for rafsi 1",
  ];
  for (const label of labels) {
    const field = page
      .getByRole("textbox", { name: label, exact: true })
      .first();
    await expect(field).toHaveAttribute("contenteditable", "true");
    const before = await nodes(field);
    await field.press("Control+End");
    await field.pressSequentially(" extra");
    expect((await nodes(field))[0].slice(0, 4), label).toEqual(before[0]);
  }
  await expect(
    page.getByText("Saved in this browser", { exact: true }),
  ).toBeVisible();
  await page.reload();
  for (const label of labels)
    await expect(
      page.getByRole("textbox", { name: label, exact: true }).first(),
    ).toContainText("extra");
});

test("manual declarations keep 17 places and a context frame keeps explicit gaps", async ({
  page,
}) => {
  await seed(page);
  const field = editor(page);
  for (let index = 1; index <= 17; index++)
    await field.pressSequentially(`__${index}__ `);
  expect(
    (await nodes(field))[0].filter((node: unknown) => typeof node === "number"),
  ).toEqual(Array.from({ length: 17 }, (_, index) => index + 1));
  await field.fill("");
  await field.pressSequentially("\\① and ④");
  await expect(
    page.getByLabel("Description for place 2", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Description for place 3", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Approve the numbering" }).click();
  const stored = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().get("drafts", "current");
  });
  expect(stored.text).toEqual([["\\", 1, " and ", 4]]);
  expect(
    stored.places.map((place: any) => [place.index, place.description]),
  ).toEqual([
    [1, []],
    [4, []],
  ]);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(
    page.getByText("Place 2 is referenced", { exact: false }),
  ).toHaveCount(0);
});

test("standalone biography and rafsi rationale expose the same editor", async ({
  page,
}) => {
  await createIdentity(page);
  await page.getByRole("link", { name: "Edit public profile" }).click();
  const bio = page.getByRole("textbox", { name: "Biography", exact: true });
  await expect(bio).toHaveAttribute("contenteditable", "true");
  await bio.pressSequentially("literal ___ ㊿");
  expect(await nodes(bio)).toEqual([["literal ___ ㊿"]]);
  await page.goto("/claim/cukta");
  await expect(
    page.getByRole("textbox", { name: "Rationale", exact: true }),
  ).toHaveAttribute("contenteditable", "true");
});
