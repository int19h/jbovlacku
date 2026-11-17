import { test, expect, type Page, type Locator } from "@playwright/test";
import { createIdentity, corePath } from "./helpers.ts";
import { richText, setRichNodes, typeRichText } from "./rich-helpers.ts";
import type { RichText } from "../src/model/types.ts";

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
    const draft = newDraft({
      spelling: "broda",
      kind: "gismu",
      meaning: "A private test meaning.",
      text: [],
      // These editor cases start with a deliberately cleared definition.
      definitionInitialized: true,
      frameMode: "context",
      places: [newPlace(1), newPlace(4)],
      step: 4,
    });
    const place = draft.places[0];
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
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "clipboardData", { value: data });
      node.dispatchEvent(event);
    },
    { plain, html },
  );
}

test("typed places, exact TeX, undo, keyboard toolbar, and 50-place grid", async ({
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
  await typeRichText(field, "");
  await field.pressSequentially("\\{ \\[ \\\\ \\__4__");
  expect(await nodes(field)).toEqual([["\\{ \\[ \\\\ \\", 4]]);
  const beforeUndo = await nodes(field);
  await field.press("Control+z");
  await expect(
    field.getByRole("img", { name: "place 4", exact: true }),
  ).toHaveCount(0);
  expect(await nodes(field)).not.toEqual(beforeUndo);
  await field.press("Control+Shift+z");
  expect(await nodes(field)).toEqual(beforeUndo);
  await expect(
    field.getByRole("img", { name: "place 4", exact: true }),
  ).toHaveCount(1);
  const more = toolbar(page).getByRole("button", {
    name: "More places",
    exact: true,
  });
  await more.click();
  const grid = page.getByRole("grid", { name: "Places 4 to 50" });
  await expect(
    grid.getByRole("button", { name: "Place 4, declared", exact: true }),
  ).toBeVisible();
  await grid.getByRole("button", { name: "Place 50", exact: true }).focus();
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

test("saved partial place tokens complete after reload and Ctrl-End with undo", async ({
  page,
}) => {
  await seed(page);
  const field = editor(page);
  for (const [partial, index, prefix] of [
    [["before __"], 1, "before "],
    [["before _", "_"], 1, "before "],
    [["before __50_"], 50, "before "],
    [["before _", "_50_"], 50, "before "],
    [["__"], 1, ""],
    [["_", "_50_"], 50, ""],
  ] as const) {
    await setRichNodes(field, [[...partial]]);
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const { LocalStore } = await import(String("/src/data/store.ts"));
          return (await new LocalStore().get("drafts", "current")).text;
        }),
      )
      .toEqual([[...partial]]);
    await page.reload();
    expect(await nodes(field)).toEqual([[...partial]]);
    await field.press("Control+End");
    await field.pressSequentially("_");
    expect(await nodes(field)).toEqual([[...(prefix ? [prefix] : []), index]]);
    await field.press("Backspace");
    expect(await richText(field)).toBe(partial.join("") + "_");
    await expect(field.getByRole("img")).toHaveCount(0);
  }
});

test("clearing a preexisting field and editing blank paragraphs keep valid stored arrays", async ({
  page,
}) => {
  await seed(page, true);
  const field = editor(page);
  await typeRichText(field, "");
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

test("the grid marks only places in the active frame as declared", async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const draft = await store.get("drafts", "current");
    draft.frameMode = "none";
    await store.put("drafts", "current", draft);
  });
  await page.reload();
  const more = toolbar(page).getByRole("button", {
    name: "More places",
    exact: true,
  });
  await more.click();
  const grid = page.getByRole("grid", { name: "Places 4 to 50" });
  await expect(
    grid.getByRole("button", { name: "Place 4", exact: true }),
  ).toBeVisible();
  await grid.press("Escape");
  await page
    .getByLabel("Number of places", { exact: true })
    .selectOption("context");
  await more.click();
  await expect(
    grid.getByRole("button", { name: "Place 4, declared", exact: true }),
  ).toBeVisible();
  await expect(
    grid.getByRole("button", { name: "Place 5", exact: true }),
  ).toBeVisible();
  await grid.press("Escape");
});

test("word links and code use accessible dialogs and preserve empty labels", async ({
  page,
}) => {
  await seed(page);
  await toolbar(page)
    .getByRole("button", { name: "Word link, link a Lojban word", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Link a word", exact: true });
  await expect(dialog.getByLabel("Lojban word")).toBeFocused();
  await dialog.getByLabel("Lojban word").fill("https://cukta");
  await dialog.getByRole("button", { name: "Insert", exact: true }).click();
  await expect(
    toolbar(page).getByRole("button", {
      name: "Word link, link a Lojban word",
      exact: true,
    }),
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
  await toolbar(page)
    .getByRole("button", { name: "Web link", exact: true })
    .click();
  const web = page.getByRole("dialog", { name: "Web link", exact: true });
  await web
    .getByLabel("HTTPS address", { exact: true })
    .fill("http://example.org/");
  await web.getByRole("button", { name: "Insert", exact: true }).click();
  await expect(web.getByRole("status")).toHaveText("Enter an HTTPS address.");
  await web
    .getByLabel("HTTPS address", { exact: true })
    .fill("https://example.org/");
  const label = web.getByLabel("Link label", { exact: true });
  expect(await label.evaluate((node) => node.tagName)).toBe("INPUT");
  await label.fill("source label");
  await web.getByRole("button", { name: "Insert", exact: true }).click();
  expect((await nodes(editor(page)))[0].at(-1)).toEqual({
    url: "https://example.org/",
    label: "source label",
  });
});

test("the operand dialog inserts a named chip for a declared operand", async ({
  page,
}) => {
  await seed(page, true);
  await toolbar(page)
    .getByRole("button", { name: "Insert operand", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Insert operand",
    exact: true,
  });
  await dialog.getByLabel("Operand", { exact: true }).selectOption("bridi");
  await dialog.getByRole("button", { name: "Insert", exact: true }).click();
  await expect(
    editor(page).getByRole("img", { name: "operand bridi", exact: true }),
  ).toHaveCount(1);
  expect((await nodes(editor(page)))[0].at(-1)).toEqual({ operand: "bridi" });
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
  await caret(".rich-code:last-of-type", 10);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type(" tail");
  expect((await nodes(field))[1].slice(-2)).toEqual([
    { code: "after link" },
    " tail",
  ]);
  const exact = [
    { code: "keep\r\n\r\nexact" },
    { url: "https://example.org/", label: "keep\r\rexact " },
  ];
  await setRichNodes(field, [exact]);
  await field.press("Control+End");
  await field.pressSequentially("㊿");
  expect(await nodes(field)).toEqual([[...exact, 50]]);
});

test("beforeinput reads same-turn target ranges and DOM selections without moving boundary carets", async ({
  page,
}) => {
  await seed(page);
  const field = editor(page);
  const inputAt = async (
    targetRanges: boolean,
    collapsed: boolean,
    edge = false,
  ) => {
    await field.press("Control+End");
    return field.evaluate(
      (node, { targetRanges, collapsed, edge }) => {
        const text = edge
          ? node.querySelector(".rich-web-link")!.firstChild!
          : node.querySelectorAll(".rich-literal")[collapsed ? 0 : 1]
              .firstChild!;
        const range = document.createRange();
        range.selectNodeContents(text);
        if (collapsed) range.collapse(!edge);
        const event = new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: edge ? " suffix" : "new",
        });
        Object.defineProperty(event, "getTargetRanges", {
          value: () =>
            targetRanges
              ? [
                  new StaticRange({
                    startContainer: range.startContainer,
                    startOffset: range.startOffset,
                    endContainer: range.endContainer,
                    endOffset: range.endOffset,
                  }),
                ]
              : [],
        });
        if (!targetRanges) {
          const selection = window.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
        }
        node.dispatchEvent(event);
        return event.defaultPrevented;
      },
      { targetRanges, collapsed, edge },
    );
  };
  for (const targetRanges of [true, false]) {
    await setRichNodes(field, [["keep"], ["replace"]]);
    expect(await inputAt(targetRanges, false)).toBe(true);
    expect(await nodes(field)).toEqual([["keep"], ["new"]]);
    await setRichNodes(field, [["keep"], ["replace"]]);
    expect(await inputAt(targetRanges, true)).toBe(true);
    expect(await nodes(field)).toEqual([["newkeep"], ["replace"]]);
    const exact: RichText = [
      [
        { code: "keep\r\n\r\ncode" },
        { word: { language: "jbo", spelling: "cukta" }, label: "keep\rword" },
        { url: "https://example.org/raw", label: "keep\r\nweb" },
      ],
    ];
    await setRichNodes(field, exact);
    expect(await inputAt(targetRanges, true, true)).toBe(true);
    expect(await nodes(field)).toEqual([[...exact[0], " suffix"]]);
  }
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
  await typeRichText(field, "");
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
    const event = new ClipboardEvent("copy", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "clipboardData", { value: data });
    node.dispatchEvent(event);
    return data.getData("text/plain");
  });
  expect(copied).toBe("① [bridi] ㊿");
  await typeRichText(field, "");
  await paste(field, copied);
  await page
    .getByRole("dialog", { name: "Paste circled numbers" })
    .getByRole("button", { name: "Keep literal text" })
    .click();
  expect(await nodes(field)).toEqual([[copied]]);
});

test("Backspace and canceled composition keep old pasted tokens literal", async ({
  page,
}) => {
  await seed(page);
  const field = editor(page);
  for (const token of ["㊿", "___", "__4__"]) {
    await typeRichText(field, "");
    await paste(field, token + " ");
    if (token === "㊿")
      await page
        .getByRole("dialog", { name: "Paste circled numbers" })
        .getByRole("button", { name: "Keep literal text" })
        .click();
    await field.press("Backspace");
    expect(await nodes(field)).toEqual([[token]]);
    await field.dispatchEvent("compositionstart", { data: "" });
    await field.dispatchEvent("compositionend", { data: "" });
    await expect(field.getByRole("img")).toHaveCount(0);
    expect(await nodes(field)).toEqual([[token]]);
  }
});

test("boundary Backspace preserves emoji and combining characters as whole clusters", async ({
  page,
}) => {
  await seed(page);
  const field = editor(page);
  await paste(field, "🙂e\u0301 ");
  await field.press("Backspace");
  expect(await nodes(field)).toEqual([["🙂e\u0301"]]);
  await field.press("Backspace");
  expect(await nodes(field)).toEqual([["🙂"]]);
  await field.press("Backspace");
  expect(await nodes(field)).toEqual([]);
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

test("undo does not cross a mode change when the visible document is unchanged", async ({
  page,
}) => {
  await seed(page);
  const field = editor(page);
  const mode = page.getByLabel("Read circled numbers as place references");
  for (const structured of [false, true]) {
    await field.pressSequentially("①");
    // ProseMirror groups history events within 500 milliseconds.
    await page.waitForTimeout(600);
    await field.press("Control+a");
    await field.press("Backspace");
    expect(await nodes(field)).toEqual([]);
    await mode.setChecked(structured);
    await field.press("Control+z");
    expect(await nodes(field)).toEqual([]);
    await expect(field.getByRole("img")).toHaveCount(0);
  }
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
  await page
    .getByRole("textbox", { name: "Type note", exact: true })
    .first()
    .focus();
  const hintPlaces = page
    .getByRole("toolbar", { name: "Type note formatting", exact: true })
    .first()
    .getByRole("button", { name: "More places", exact: true });
  await hintPlaces.click();
  const hintGrid = page.getByRole("grid", { name: "Places 4 to 50" });
  await expect(
    hintGrid.getByRole("button", { name: "Place 4, declared", exact: true }),
  ).toBeVisible();
  await hintGrid.press("Escape");
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
  await typeRichText(field, "");
  await field.pressSequentially("\\① and ④");
  await expect(
    page.getByLabel("Description for place 2", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Description for place 3", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Approve the numbering" }).click();
  const read = () =>
    page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      return new LocalStore().get("drafts", "current");
    });
  await expect
    .poll(async () => (await read()).text)
    .toEqual([["\\", 1, " and ", 4]]);
  const stored = await read();
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

test("a fully declared manual frame with 17 places reaches Publish without AI", async ({
  page,
}) => {
  await createIdentity(page);
  let requests = 0;
  await page.route("**/api/v1/assist", async (route) => {
    requests++;
    await route.abort();
  });
  await seed(page);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { newPlace } = await import(String("/src/model/draft.ts"));
    const store = new LocalStore();
    const draft = await store.get("drafts", "current");
    const indices = Array.from({ length: 17 }, (_, index) => index + 1);
    draft.frameMode = "fixed";
    draft.places = indices.map((index) => newPlace(index));
    draft.text = [indices.flatMap((index) => [index, " "])];
    draft.numberingApproved = false;
    await store.put("drafts", "current", draft);
  });
  await page.reload();
  await expect(
    page.getByRole("heading", {
      name: "Are all 17 places needed?",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Approve the numbering", exact: true })
    .click();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /^Publish as / }),
  ).toBeVisible();
  await expect(
    page.locator("aside").getByRole("button", { name: "Publish", exact: true }),
  ).toBeEnabled();
  expect(requests).toBe(0);
});

async function mountKeyboardField(
  page: Page,
  text: string,
  narrow = false,
  direction?: string,
) {
  await page.goto("/");
  await page.evaluate(
    async ({ text, narrow, direction }) => {
      const { richField } = await import(
        String("/src/components/rich-field.ts")
      );
      const field = richField("Keyboard field", { value: [[text]] });
      if (direction) field.wrapper.dir = direction;
      if (narrow) {
        field.wrapper.style.width = "110px";
        field.wrapper.style.font = "16px monospace";
      }
      document.body.replaceChildren(field.wrapper);
    },
    { text, narrow, direction },
  );
  return page.getByRole("textbox", { name: "Keyboard field", exact: true });
}

async function keyboardSelection(field: Locator) {
  return field.evaluate((node) => {
    const text = node.querySelector("p .rich-literal")!.firstChild!;
    const selection = getSelection()!;
    const offset = (point: Node | null, at: number) =>
      point === text ? at : -1;
    return {
      anchor: offset(selection.anchorNode, selection.anchorOffset),
      focus: offset(selection.focusNode, selection.focusOffset),
      selected: selection.toString(),
    };
  });
}

async function chooseKeyboardSelection(
  field: Locator,
  anchor: number,
  focus: number,
) {
  await field.focus();
  await field.evaluate(
    (node, { anchor, focus }) => {
      const text = node.querySelector("p .rich-literal")!.firstChild!;
      getSelection()!.setBaseAndExtent(text, anchor, text, focus);
      document.dispatchEvent(new Event("selectionchange"));
    },
    { anchor, focus },
  );
}

async function expectKeyboardSelection(
  field: Locator,
  text: string,
  anchor: number,
  focus: number,
) {
  const selected = text.slice(Math.min(anchor, focus), Math.max(anchor, focus));
  await expect
    .poll(async () => {
      const now = await keyboardSelection(field);
      return [now.anchor, now.focus, now.selected];
    })
    .toEqual([anchor, focus, selected]);
}

const lineMotionText = "alpha beta gamma delta";
const lineMotionCases = [
  {
    name: "a backward selection extended Home keeps its anchor",
    anchor: 12,
    focus: 6,
    key: "Shift+Home",
    after: [12, 0],
    steps: [
      ["Shift+ArrowRight", [12, 1]],
      ["Shift+ArrowLeft", [12, 0]],
    ],
  },
  {
    name: "a backward selection extended End keeps its anchor",
    anchor: 12,
    focus: 6,
    key: "Shift+End",
    after: [12, 22],
    steps: [
      ["Shift+ArrowLeft", [12, 21]],
      ["Shift+ArrowRight", [12, 22]],
    ],
  },
  {
    name: "a forward selection extended Home keeps its anchor",
    anchor: 6,
    focus: 12,
    key: "Shift+Home",
    after: [6, 0],
    steps: [
      ["Shift+ArrowRight", [6, 1]],
      ["Shift+ArrowLeft", [6, 0]],
    ],
  },
  {
    name: "a forward selection extended End keeps its anchor",
    anchor: 6,
    focus: 12,
    key: "Shift+End",
    after: [6, 22],
    steps: [
      ["Shift+ArrowLeft", [6, 21]],
      ["Shift+ArrowRight", [6, 22]],
    ],
  },
] as const;

for (const lineCase of lineMotionCases) {
  test(lineCase.name, async ({ page }) => {
    const field = await mountKeyboardField(page, lineMotionText);
    await chooseKeyboardSelection(field, lineCase.anchor, lineCase.focus);
    await expectKeyboardSelection(
      field,
      lineMotionText,
      lineCase.anchor,
      lineCase.focus,
    );
    await field.press(lineCase.key);
    await expectKeyboardSelection(
      field,
      lineMotionText,
      lineCase.after[0],
      lineCase.after[1],
    );
    for (const [key, after] of lineCase.steps) {
      await field.press(key);
      await expectKeyboardSelection(field, lineMotionText, after[0], after[1]);
    }
  });
}

test("Home and End move by visual line in wrapped text", async ({ page }) => {
  const text = "one two three four five six seven eight nine ten";
  const field = await mountKeyboardField(page, text, true);
  await chooseKeyboardSelection(field, 24, 24);
  await field.press("Home");
  await expectKeyboardSelection(field, text, 19, 19);
  await field.press("End");
  await expectKeyboardSelection(field, text, 28, 28);
});

test("Home stays native on a Mac platform and elsewhere", async ({
  page,
}) => {
  const field = await mountKeyboardField(page, lineMotionText);
  await chooseKeyboardSelection(field, 12, 12);
  const outcome = await field.evaluate((node) => {
    const dispatch = (platform: string) => {
      const original = navigator.platform;
      Object.defineProperty(navigator, "platform", {
        value: platform,
        configurable: true,
      });
      try {
        const notPrevented = node.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Home",
            bubbles: true,
            cancelable: true,
          }),
        );
        const selection = getSelection()!;
        const text = node.querySelector("p .rich-literal")!.firstChild!;
        return {
          notPrevented,
          anchor: selection.anchorNode === text ? selection.anchorOffset : -1,
          focus: selection.focusNode === text ? selection.focusOffset : -1,
        };
      } finally {
        Object.defineProperty(navigator, "platform", {
          value: original,
          configurable: true,
        });
      }
    };
    return { mac: dispatch("MacIntel"), other: dispatch("Linux x86_64") };
  });
  // Line motion is the browser's on every platform; on macOS Home
  // scrolls and never moves the caret. The editor intercepts neither.
  expect(outcome.mac).toEqual({ notPrevented: true, anchor: 12, focus: 12 });
  expect(outcome.other).toEqual({ notPrevented: true, anchor: 12, focus: 12 });
});

for (const platform of ["Linux x86_64", "MacIntel"]) {
  test(`a pending native caret does not swallow line motion: ${platform}`, async ({
    page,
  }) => {
    const field = await mountKeyboardField(page, "alpha beta");
    await field.evaluate((node, platform) => {
      Object.defineProperty(navigator, "platform", {
        value: platform,
        configurable: true,
      });
    }, platform);
    await chooseKeyboardSelection(field, 0, 0);
    await page.waitForTimeout(40);
    const immediate = await field.evaluate((node, platform) => {
      const text = node.querySelector("p .rich-literal")!.firstChild!;
      const selection = getSelection()!;
      const snap = () => ({
        anchor: selection.anchorOffset,
        focus: selection.focusOffset,
        text: selection.toString(),
      });
      // Move the native caret and send both line keys in one task, before
      // the browser delivers the pending selectionchange.
      selection.setBaseAndExtent(text, 5, text, 5);
      const command = (backward: boolean, shift: boolean) => {
        const mac = platform === "MacIntel";
        const key = mac
          ? backward
            ? "ArrowLeft"
            : "ArrowRight"
          : backward
            ? "Home"
            : "End";
        const unhandled = node.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            keyCode: mac ? (backward ? 37 : 39) : backward ? 36 : 35,
            bubbles: true,
            cancelable: true,
            shiftKey: shift,
            metaKey: mac,
          }),
        );
        if (unhandled)
          selection.modify(
            shift ? "extend" : "move",
            backward ? "backward" : "forward",
            "lineboundary",
          );
        return snap();
      };
      const start = snap();
      const home = command(true, false);
      const end = command(false, true);
      return { start, home, end };
    }, platform);
    expect(immediate.home).toEqual({ anchor: 0, focus: 0, text: "" });
    expect(immediate.end).toEqual({ anchor: 0, focus: 10, text: "alpha beta" });
    await field.press("x");
    await expect
      .poll(() => field.evaluate((node: any) => node.value))
      .toEqual([["x"]]);
  });
}

test("line keys reveal a caret the reader scrolled away from", async ({
  page,
}) => {
  const value = Array.from({ length: 45 }, (_, index) => [
    `line ${index} alpha beta`,
  ]);
  await page.goto("/");
  await page.evaluate(async (value) => {
    const { richField } = await import(String("/src/components/rich-field.ts"));
    const field = richField("Long keyboard field", { value });
    document.body.replaceChildren(field.wrapper);
  }, value);
  const field = page.getByRole("textbox", {
    name: "Long keyboard field",
    exact: true,
  });
  for (const key of ["Home", "End", "Shift+Home", "Shift+End"]) {
    await field.evaluate((node) => {
      const text =
        node.querySelectorAll("p")[30].querySelector(".rich-literal")!
          .firstChild!;
      getSelection()!.setBaseAndExtent(text, 8, text, 8);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await page.waitForTimeout(40);
    await page.evaluate(() => scrollTo(0, 0));
    await field.press(key);
    await expect
      .poll(() =>
        field.evaluate(() => {
          const selection = getSelection()!;
          const range = document.createRange();
          range.setStart(selection.focusNode!, selection.focusOffset);
          range.collapse(true);
          const rect = range.getBoundingClientRect();
          return scrollY > 0 && rect.top >= 0 && rect.top <= innerHeight;
        }),
      )
      .toBe(true);
  }
});

const resetFocusCases = [
  {
    name: "prepend paragraph",
    before: [["alpha beta"]],
    after: [["reset prefix"], ["alpha beta"]],
    typed: [["reset prefix"], ["alpha betax"]],
    typedFirefox: [["reset prefixx"], ["alpha beta"]],
  },
  {
    name: "shorten first paragraph",
    before: [["alpha beta"], ["omega end"]],
    after: [["new"], ["omega end"]],
    typed: [["new"], ["omega endx"]],
    typedFirefox: [["newx"], ["omega end"]],
  },
] as const;

for (const resetCase of resetFocusCases) {
  for (const route of ["button", "direct"] as const) {
    test(`reset then focus keeps the intended caret: ${resetCase.name} ${route}`, async ({
      page,
      browserName,
    }) => {
      await page.goto("/");
      await page.evaluate(async (before) => {
        const { richField } = await import(
          String("/src/components/rich-field.ts")
        );
        const field = richField("Reset field", { value: before });
        const button = document.createElement("button");
        button.textContent = "Replace value";
        document.body.replaceChildren(field.wrapper, button);
        (window as any).__resetField = field;
        (window as any).__resetButton = button;
      }, resetCase.before as unknown as RichText);
      const field = page.getByRole("textbox", {
        name: "Reset field",
        exact: true,
      });
      await field.focus();
      await field.evaluate((node) => {
        const text = node.querySelector(".rich-literal")!.firstChild!;
        getSelection()!.setBaseAndExtent(text, 4, text, 4);
        document.dispatchEvent(new Event("selectionchange"));
      });
      await page.waitForTimeout(60);
      if (route === "button") {
        await page.evaluate((after) => {
          const w = window as any;
          w.__resetButton.onclick = () => {
            w.__resetField.input.value = after;
            w.__resetField.input.focus();
          };
        }, resetCase.after as unknown as RichText);
        await page
          .getByRole("button", { name: "Replace value", exact: true })
          .click();
      } else {
        await field.evaluate((node, after) => {
          const input = node as any;
          input.blur();
          input.value = after;
          input.focus();
        }, resetCase.after as unknown as RichText);
      }
      await page.waitForTimeout(60);
      await field.press("x");
      await expect
        .poll(() => field.evaluate((node: any) => node.value))
        .toEqual(
          browserName === "firefox" ? resetCase.typedFirefox : resetCase.typed,
        );
    });
  }
}

test("trusted line keys replace the paragraph after a slow Home handler", async ({
  page,
}) => {
  for (let trial = 0; trial < 3; trial++) {
    const field = await mountKeyboardField(page, "Sense: new meaning");
    await field.evaluate((node) => {
      node.addEventListener("keydown", (event) => {
        if ((event as KeyboardEvent).key !== "Home") return;
        const until = performance.now() + 35;
        while (performance.now() < until) {
          // Model slow browser work during this one key.
        }
      });
    });
    await chooseKeyboardSelection(field, 18, 18);
    await page.waitForTimeout(60);
    await field.blur();
    await field.focus();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await page.waitForTimeout(60);
    await field.press("x");
    await expect
      .poll(() => field.evaluate((node: any) => node.value))
      .toEqual([["x"]]);
  }
});

test("Firefox Ctrl-drag keeps ProseMirror's normalized selection", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "firefox", "Only Firefox holds several ranges.");
  await page.goto("/");
  await page.evaluate(async () => {
    const { richField } = await import(String("/src/components/rich-field.ts"));
    const field = richField("Ranges field", {
      value: [["alpha beta"], ["middle"], ["omega end"]],
    });
    document.body.replaceChildren(field.wrapper);
  });
  const field = page.getByRole("textbox", {
    name: "Ranges field",
    exact: true,
  });
  await field.focus();
  const points = await field.evaluate((node) =>
    [0, 2].map((paragraph) =>
      [1, 4].map((offset) => {
        const text =
          node
            .querySelectorAll("p")
            [paragraph].querySelector(".rich-literal")!.firstChild!;
        const range = document.createRange();
        range.setStart(text, offset);
        range.collapse(true);
        const box = range.getBoundingClientRect();
        return { x: box.left, y: (box.top + box.bottom) / 2 };
      }),
    ),
  );
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
  };
  await drag(points[0][0], points[0][1]);
  await page.keyboard.down("Control");
  await drag(points[1][0], points[1][1]);
  await page.keyboard.up("Control");
  const selected = () =>
    field.evaluate(() => ({
      text: getSelection()!.toString(),
      ranges: getSelection()!.rangeCount,
    }));
  await expect
    .poll(selected)
    .toEqual({ text: "lpha beta\n\nmiddle\n\nomeg", ranges: 1 });
  await field.press("Delete");
  await expect
    .poll(() => field.evaluate((node: any) => node.value))
    .toEqual([["aa end"]]);
  await field.press("Control+z");
  await expect
    .poll(() => field.evaluate((node: any) => node.value))
    .toEqual([["alpha beta"], ["middle"], ["omega end"]]);
  await expect
    .poll(selected)
    .toEqual({ text: "lpha beta\n\nmiddle\n\nomeg", ranges: 1 });
});

test("a selected chip keeps its node selection for Cmd arrows", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });
  });
  for (const [key, after] of [
    ["Meta+ArrowRight", [[1, "x alpha beta"]]],
    ["Meta+ArrowLeft", [["x", 1, " alpha beta"]]],
  ] as const) {
    await page.goto("/");
    await page.evaluate(async () => {
      const { richField } = await import(
        String("/src/components/rich-field.ts")
      );
      const field = richField("Chip field", { value: [[1, " alpha beta"]] });
      document.body.replaceChildren(field.wrapper);
    });
    const field = page.getByRole("textbox", {
      name: "Chip field",
      exact: true,
    });
    await field.locator(".rich-chip").click();
    await field.press(key);
    await field.press("x");
    await expect
      .poll(() => field.evaluate((node: any) => node.value))
      .toEqual(after);
  }
});

test("a line selection made right after focus is kept", async ({ page }) => {
  const field = await mountKeyboardField(page, "Sense: new meaning");
  await chooseKeyboardSelection(field, 18, 18);
  await field.blur();
  await field.focus();
  // Move to the line start and extend to its end in one task, then hold
  // event delivery past the editor's focus-time selection write.
  await field.evaluate((node) => {
    const text = node.querySelector("p .rich-literal")!.firstChild!;
    const selection = getSelection()!;
    const command = (key: string, keyCode: number, shift: boolean) => {
      const unhandled = node.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          keyCode,
          bubbles: true,
          cancelable: true,
          shiftKey: shift,
        }),
      );
      if (unhandled)
        selection.modify(
          shift ? "extend" : "move",
          key === "Home" ? "backward" : "forward",
          "lineboundary",
        );
    };
    command("Home", 36, false);
    command("End", 35, true);
    const until = performance.now() + 35;
    while (performance.now() < until) {
      // Hold timers and selectionchange behind the native motion.
    }
    void text;
  });
  await page.waitForTimeout(60);
  await expectKeyboardSelection(field, "Sense: new meaning", 0, 18);
});

test("Ctrl arrows keep native word motion in mixed-direction text", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "This pins Chromium's native Ctrl+Arrow behavior.",
  );
  const text = "abc אבג def היג xyz";
  const field = await mountKeyboardField(page, text, false, "rtl");
  // Native word motion is the browser's. Let the editor sync each native
  // selection before the next key, as the main-branch comparison does.
  const key = async (name: string) => {
    await field.press(name);
    await page.waitForTimeout(40);
  };
  await chooseKeyboardSelection(field, 0, 0);
  await key("Control+ArrowRight");
  await expectKeyboardSelection(field, text, 0, 0);
  await key("Control+ArrowRight");
  await expectKeyboardSelection(field, text, 0, 0);
  await key("Control+ArrowLeft");
  await expectKeyboardSelection(field, text, 3, 3);
  await chooseKeyboardSelection(field, 0, 0);
  await key("Control+Shift+ArrowRight");
  await expectKeyboardSelection(field, text, 0, 0);
  await key("Control+Shift+ArrowRight");
  await expectKeyboardSelection(field, text, 0, 0);
  await key("Control+Shift+ArrowLeft");
  await expectKeyboardSelection(field, text, 0, 3);
});

const inlineHomeCases = [
  {
    name: "leading code",
    value: [[{ code: "alpha beta" }, " tail"]],
    selector: ".rich-code",
    offset: 4,
    after: [["x", { code: "alpha beta" }, " tail"]],
  },
  {
    name: "only code",
    value: [[{ code: "alpha beta" }]],
    selector: ".rich-code",
    offset: 4,
    after: [["x", { code: "alpha beta" }]],
  },
  {
    name: "leading web link",
    value: [[{ url: "https://example.org", label: "alpha beta" }, " tail"]],
    selector: ".rich-web-link",
    offset: 4,
    after: [
      ["x", { url: "https://example.org", label: "alpha beta" }, " tail"],
    ],
  },
  {
    name: "leading word link",
    value: [
      [
        { word: { language: "jbo", spelling: "klama" }, label: "alpha beta" },
        " tail",
      ],
    ],
    selector: ".rich-word-link",
    offset: 4,
    after: [
      [
        "x",
        { word: { language: "jbo", spelling: "klama" }, label: "alpha beta" },
        " tail",
      ],
    ],
  },
  {
    name: "empty leading code",
    value: [[{ code: "" }, "tail"]],
    selector: ".rich-code",
    offset: 0,
    // An empty container's caret point resolves differently per engine.
    afterChromium: [[{ code: "" }, "xtail"]],
    afterFirefox: [["x", { code: "" }, "tail"]],
  },
  {
    name: "empty leading web link",
    value: [[{ url: "https://example.org", label: "" }, "tail"]],
    selector: ".rich-web-link",
    offset: 0,
    afterChromium: [[{ url: "https://example.org", label: "" }, "xtail"]],
    afterFirefox: [["x", { url: "https://example.org", label: "" }, "tail"]],
  },
  {
    name: "place selection",
    value: [[1, " tail"]],
    selector: ".rich-chip",
    offset: 0,
    click: true,
    after: [["x", 1, " tail"]],
  },
  {
    name: "operand selection",
    value: [[{ operand: "A" }, " tail"]],
    selector: ".rich-chip",
    offset: 0,
    click: true,
    after: [["x", { operand: "A" }, " tail"]],
  },
] as const;

for (const inlineCase of inlineHomeCases) {
  test(`repeated Home leaves a leading inline node: ${inlineCase.name}`, async ({
    page,
    browserName,
  }) => {
    await page.goto("/");
    await page.evaluate(async (value) => {
      const { richField } = await import(
        String("/src/components/rich-field.ts")
      );
      const field = richField("Inline Home field", { value });
      document.body.replaceChildren(field.wrapper);
    }, inlineCase.value as unknown as RichText);
    const field = page.getByRole("textbox", {
      name: "Inline Home field",
      exact: true,
    });
    if ("click" in inlineCase && inlineCase.click)
      await field.locator(inlineCase.selector).click();
    else {
      await field.focus();
      await field.evaluate(
        (node, { selector, offset }) => {
          const container = node.querySelector(selector)!;
          const point = container.firstChild ?? container;
          getSelection()!.setBaseAndExtent(point, offset, point, offset);
          document.dispatchEvent(new Event("selectionchange"));
        },
        inlineCase,
      );
    }
    await page.waitForTimeout(60);
    await field.press("Home");
    await page.waitForTimeout(40);
    await field.press("Home");
    await field.press("x");
    const stored = () => field.evaluate((node: any) => node.value);
    const after =
      "after" in inlineCase
        ? inlineCase.after
        : browserName === "firefox"
          ? inlineCase.afterFirefox
          : inlineCase.afterChromium;
    await expect.poll(stored).toEqual(after);
    await field.press("Control+z");
    await expect.poll(stored).toEqual(inlineCase.value);
  });
}
