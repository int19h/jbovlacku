import { test, expect, type Locator, type Page } from "@playwright/test";
import { fixture, fingerprintText, createIdentity } from "./helpers.ts";
import type { RichText } from "../src/model/types.ts";

async function mount(
  page: Page,
  value: RichText,
  options: { literal?: boolean; operands?: boolean } = {},
) {
  await page.goto("/");
  await page.evaluate(
    async ({ value, options }) => {
      const { richField } = await import(
        String("/src/components/rich-field.ts")
      );
      const field = richField("Round two field", {
        value,
        structured: !options.literal,
        ...(options.operands ? { operands: () => [] } : {}),
      });
      document.body.replaceChildren(field.wrapper);
    },
    { value, options },
  );
  return page.getByRole("textbox", { name: "Round two field", exact: true });
}
const nodes = (field: Locator) => field.evaluate((node: any) => node.value);
async function caret(field: Locator, selector: string, offset: number) {
  await field.focus();
  await field.locator(selector).evaluate((node, offset) => {
    const range = document.createRange();
    range.setStart(node.firstChild ?? node, offset);
    range.collapse(true);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }, offset);
  await field.page().waitForTimeout(40);
}
async function paste(field: Locator, text?: string) {
  await field.evaluate((node, text) => {
    const data = new DataTransfer();
    if (text !== undefined) data.setData("text/plain", text);
    else data.setData("text/html", "<img src=x>");
    node.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  }, text);
}
const containers = [
  {
    name: "code",
    selector: ".rich-code",
    node: { code: "abcd" },
    updated: (text: string) => ({ code: text }),
  },
  {
    name: "word link",
    selector: ".rich-word-link",
    node: {
      word: { language: "jbo" as const, spelling: "cukta" },
      label: "abcd",
    },
    updated: (text: string) => ({
      word: { language: "jbo" as const, spelling: "cukta" },
      label: text,
    }),
  },
  {
    name: "web link",
    selector: ".rich-web-link",
    node: { url: "https://example.org/", label: "abcd" },
    updated: (text: string) => ({ url: "https://example.org/", label: text }),
  },
];
for (const kind of containers) {
  for (const text of ["XX", "X\n\nY"]) {
    test(`r2 paste ${JSON.stringify(text)} inside ${kind.name} keeps one container`, async ({
      page,
    }) => {
      const field = await mount(page, [[kind.node]]);
      await caret(field, kind.selector, 2);
      await paste(field, text);
      expect(await nodes(field)).toEqual([[kind.updated(`ab${text}cd`)]]);
    });
  }
  test(`r2 type before leading ${kind.name} with Home and ArrowLeft`, async ({
    page,
  }) => {
    const field = await mount(page, [[kind.node, " tail"]]);
    await caret(field, kind.selector, 0);
    await field.press("ArrowLeft");
    await field.pressSequentially("before ");
    expect(await nodes(field)).toEqual([["before ", kind.node, " tail"]]);
    await field.press("Control+Home");
    await field.press("Home");
    await field.pressSequentially("start ");
    expect(await nodes(field)).toEqual([["start before ", kind.node, " tail"]]);
  });
  test(`r2 Backspace removes empty ${kind.name} before preceding prose`, async ({
    page,
  }) => {
    const field = await mount(page, [["keep ", kind.updated("ab"), " tail"]]);
    await caret(field, kind.selector, 2);
    await field.press("ArrowRight");
    await field.press("Backspace");
    await field.press("Backspace");
    await field.press("Backspace");
    expect(await nodes(field)).toEqual([["keep  tail"]]);
    await expect(field.locator(kind.selector)).toHaveCount(0);
    await field.evaluate((node: any, empty) => {
      node.value = [["keep ", empty, " tail"]];
    }, kind.updated(""));
    await caret(field, kind.selector, 0);
    await field.press("Delete");
    expect(await nodes(field)).toEqual([["keep  tail"]]);
    await expect(field.locator(kind.selector)).toHaveCount(0);
  });
  test(`r2 forward Delete after code keeps following ${kind.name} graphemes`, async ({
    page,
  }) => {
    const field = await mount(page, [
      [{ code: "prefix" }, kind.updated("e\u0301👩‍💻z")],
    ]);
    await caret(field, ".rich-code:first-child", 6);
    await field.press("ArrowRight");
    await field.press("Delete");
    expect(await nodes(field)).toEqual([
      [{ code: "prefix" }, kind.updated("👩‍💻z")],
    ]);
    await field.press("Delete");
    expect(await nodes(field)).toEqual([
      [{ code: "prefix" }, kind.updated("z")],
    ]);
  });
  test(`r2 toolbar replaces a selection from ${kind.name} through following prose`, async ({
    page,
  }) => {
    const field = await mount(page, [[kind.node, " after"]]);
    await field.focus();
    await field.evaluate((node, selector) => {
      const range = document.createRange();
      range.setStart(node.querySelector(selector)!.firstChild!, 2);
      range.setEnd(
        node.querySelector("p .rich-literal:last-of-type")!.firstChild!,
        6,
      );
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    }, kind.selector);
    await page.waitForTimeout(40);
    await page
      .getByRole("button", { name: "Insert place 1", exact: true })
      .click();
    expect(await nodes(field)).toEqual([[kind.updated("ab"), 1]]);
  });
}
test("r2 forward Delete keeps the remainder of a saved literal", async ({
  page,
}) => {
  const field = await mount(page, [[{ code: "prefix" }, "e\u0301👩‍💻z"]]);
  await caret(field, ".rich-code", 6);
  await field.press("ArrowRight");
  await field.press("Delete");
  expect(await nodes(field)).toEqual([[{ code: "prefix" }, "👩‍💻z"]]);
  await field.evaluate((node: any) => {
    node.value = [];
  });
  await field.pressSequentially("e\u0301👩‍💻z");
  await field.press("Control+Home");
  await field.press("Delete");
  expect(await nodes(field)).toEqual([["👩‍💻z"]]);
});
test("r2 paste without usable plain text preserves a selection", async ({
  page,
}) => {
  const field = await mount(page, [["keep this"]]);
  await field.focus();
  await field.press("Control+a");
  await paste(field);
  expect(await nodes(field)).toEqual([["keep this"]]);
  await paste(field, "");
  expect(await nodes(field)).toEqual([["keep this"]]);
});
test("r2 circled paste in a code label stays literal without a conversion dialog", async ({
  page,
}) => {
  const field = await mount(page, [[{ code: "abcd" }]]);
  await caret(field, ".rich-code", 2);
  await paste(field, "①\n\n___");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await nodes(field)).toEqual([[{ code: "ab①\n\n___cd" }]]);
});
test("r2 toolbar has one tab stop and preserves native select keys", async ({
  page,
}) => {
  const field = await mount(page, [["text"]]);
  const toolbar = page.getByRole("toolbar");
  expect(
    await toolbar
      .locator("button,select")
      .evaluateAll(
        (nodes) =>
          nodes.filter(
            (node) =>
              !(node as HTMLButtonElement).disabled &&
              (node as HTMLElement).tabIndex === 0,
          ).length,
      ),
  ).toBe(1);
  const first = toolbar.getByRole("button", {
    name: "Insert place 1",
    exact: true,
  });
  await first.focus();
  await first.press("ArrowRight");
  await expect(
    toolbar.getByRole("button", { name: "Insert place 2", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  const select = toolbar.getByLabel("More places");
  await expect(select).toBeFocused();
  await select.press("ArrowDown");
  await expect(select).toHaveValue("5");
  await expect(select).toBeFocused();
  await select.press("Alt+ArrowRight");
  await expect(
    toolbar.getByRole("button", { name: "Insert selected place", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(field).toBeFocused();
});
for (const kind of containers.filter((kind) => kind.name !== "code")) {
  test(`r2 ${kind.name} exposes its target and supports editing`, async ({
    page,
  }) => {
    const field = await mount(page, [[kind.node]]);
    const target = kind.name === "word link" ? "cukta" : "https://example.org/";
    const link = field.getByRole("group");
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAccessibleName(
      new RegExp(target === "cukta" ? "cukta" : "example"),
    );
    await caret(field, kind.selector, 2);
    await field.pressSequentially("X");
    await expect(link).toHaveAccessibleName(`abXcd, ${kind.name} to ${target}`);
    await page.getByRole("button", { name: "Edit link", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Link label", { exact: true })).toHaveValue(
      "abXcd",
    );
    await dialog.getByLabel("Link label", { exact: true }).fill("new label");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    expect(await nodes(field)).toEqual([[kind.updated("new label")]]);
    await expect(link).toHaveAccessibleName(
      `new label, ${kind.name} to ${target}`,
    );
    await expect(
      page.getByRole("button", { name: "Edit link", exact: true }),
    ).toBeFocused();
  });
}
test("r2 never-focused toolbar insertion appends to existing content", async ({
  page,
}) => {
  const field = await mount(page, [["existing"]]);
  await page
    .getByRole("button", { name: "Insert place 2", exact: true })
    .click();
  expect(await nodes(field)).toEqual([["existing", 2]]);
});
test("r2 unavailable operands explain the disabled control", async ({
  page,
}) => {
  await mount(page, [["text"]], { operands: true });
  const control = page.getByRole("button", {
    name: "Insert operand",
    exact: true,
  });
  await expect(control).toBeDisabled();
  await expect(control).toHaveAccessibleDescription(
    "Declare an operand first.",
  );
});
test("r2 literal mode replaces the place-rule hint", async ({ page }) => {
  const field = await mount(page, [["literal"]], { literal: true });
  const hint = page.locator(
    `[id="${await field.getAttribute("aria-describedby")}"]`,
  );
  await expect(hint).toContainText(
    "Literal mode keeps typed characters as text.",
  );
  await expect(hint).not.toContainText("Type ___");
});
test("r2 place-list updates retain blank paragraphs, caret, and undo", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const { newDraft, newPlace } = await import(String("/src/model/draft.ts"));
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().put(
      "drafts",
      "current",
      newDraft({
        spelling: "broda",
        kind: "gismu",
        text: [],
        frameMode: "context",
        places: [newPlace(1)],
        step: 4,
      }),
    );
  });
  await page.goto("/new/editor");
  const field = page.getByRole("textbox", {
    name: "Definition text",
    exact: true,
  });
  await field.pressSequentially("the agent");
  await page.waitForTimeout(550);
  await field.press("Enter");
  expect(await nodes(field)).toEqual([["the agent"]]);
  await page
    .getByRole("button", { name: "+ Add a place", exact: true })
    .click();
  await expect(field.locator("p")).toHaveCount(2);
  await page.waitForTimeout(550);
  await field.pressSequentially("tail");
  expect(await nodes(field)).toEqual([["the agent"], ["tail"]]);
  await field.press("Control+z");
  expect(await nodes(field)).toEqual([["the agent"]]);
  await field.press("Control+z");
  expect(await nodes(field)).toEqual([["the agent"]]);
  const description = page.getByRole("textbox", {
    name: "Description for place 1",
    exact: true,
  });
  await description.pressSequentially("a person");
  await page.waitForTimeout(550);
  await description.press("Enter");
  await page
    .getByRole("button", { name: "+ Add a place", exact: true })
    .click();
  await expect(description.locator("p")).toHaveCount(2);
  await page.waitForTimeout(550);
  await description.pressSequentially("tail");
  expect(await nodes(description)).toEqual([["a person"], ["tail"]]);
  await description.press("Control+z");
  expect(await nodes(description)).toEqual([["a person"]]);
  await description.press("Control+z");
  expect(await nodes(description)).toEqual([["a person"]]);
});
test("r2 reading pages load no authoring editor code or CSS", async ({
  page,
}) => {
  const editorRequests: string[] = [];
  page.on("request", (request) => {
    if (
      /prosemirror|\/components\/rich-field\.ts|\/model\/rich-editor\.ts/.test(
        request.url(),
      )
    )
      editorRequests.push(request.url());
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(editorRequests).toEqual([]);
  await page.goto("/new/editor");
  await expect(
    page.getByRole("textbox", { name: "Definition text", exact: true }),
  ).toBeVisible();
  expect(editorRequests.some((url) => /rich-field|prosemirror/.test(url))).toBe(
    true,
  );
});

for (const kind of ["code", "word link", "web link"]) {
  test(`r2 never-focused ${kind} dialog insertion appends`, async ({
    page,
  }) => {
    const field = await mount(page, [["existing"]]);
    await page
      .getByRole("button", {
        name:
          kind === "code"
            ? "Insert code"
            : kind === "word link"
              ? "Link a word"
              : "Web link",
        exact: true,
      })
      .click();
    const dialog = page.getByRole("dialog");
    if (kind === "code")
      await dialog.getByLabel("Code", { exact: true }).fill("new");
    else {
      await dialog
        .getByLabel(kind === "word link" ? "Lojban word" : "HTTPS address", {
          exact: true,
        })
        .fill(kind === "word link" ? "cukta" : "https://example.org/");
      await dialog.getByLabel("Link label", { exact: true }).fill("new");
    }
    await dialog.getByRole("button", { name: "Insert", exact: true }).click();
    const node =
      kind === "code"
        ? { code: "new" }
        : kind === "word link"
          ? {
              word: { language: "jbo" as const, spelling: "cukta" },
              label: "new",
            }
          : { url: "https://example.org/", label: "new" };
    expect(await nodes(field)).toEqual([["existing", node]]);
  });
}
for (const kind of ["word", "identity", "rafsi"] as const) {
  test(`r2 reading ${kind} loads seeded content without the editor`, async ({
    page,
  }) => {
    const editorRequests: string[] = [];
    page.on("request", (request) => {
      if (
        /prosemirror|\/components\/rich-field\.ts|\/model\/rich-editor\.ts/.test(
          request.url(),
        )
      )
        editorRequests.push(request.url());
    });
    const data = fixture();
    const route =
      kind === "word"
        ? `/word/${encodeURIComponent(data.words.cukta)}`
        : kind === "identity"
          ? `/identity/${encodeURIComponent(data.identities.rootA)}`
          : "/rafsi/cku";
    await page.goto(route);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const main = page.locator("main");
    if (kind === "word") {
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("cukta");
      await expect(main).toContainText("book");
    } else if (kind === "identity") {
      await expect(main).toContainText(fingerprintText(data.identities.rootA));
      await expect(main).toContainText("Root of the site's trust view");
    } else await expect(main).toContainText("Classic assignment.");
    expect(editorRequests).toEqual([]);
  });
}

test("r2 whitespace-only report explanations stay empty", async ({ page }) => {
  await page.goto(
    `/identity/${encodeURIComponent(fixture().identities.author)}`,
  );
  await page.getByRole("button", { name: "Report abuse", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Report identity abuse" });
  const explanation = dialog.getByRole("textbox", {
    name: "Explanation",
    exact: true,
  });
  await explanation.pressSequentially("   ");
  await dialog
    .getByRole("button", { name: "Preview the public report", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", {
      name: "Preview the public report",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", {
      name: "Sign and publish the report",
      exact: true,
    }),
  ).toHaveCount(0);
});

test("r2 whitespace-only biography has an empty preview", async ({ page }) => {
  await createIdentity(page);
  await page
    .getByRole("link", { name: "Edit public profile", exact: true })
    .click();
  const editor = page.getByRole("region", { name: "Edit public profile" });
  await editor
    .getByRole("textbox", { name: "Biography", exact: true })
    .pressSequentially("   ");
  await editor
    .getByRole("button", { name: "Preview the signed claim", exact: true })
    .click();
  const preview = page.getByRole("region", { name: "Profile preview" });
  await expect(preview).toBeVisible();
  expect(
    await preview
      .locator(":scope > p")
      .nth(1)
      .evaluate((node) => node.childElementCount),
  ).toBe(0);
});
