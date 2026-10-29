import { test, expect, type Page, type Locator } from "@playwright/test";
import { createIdentity, fixture } from "./helpers.ts";
import { richNodes } from "./rich-helpers.ts";
import type { RichText } from "../src/model/types.ts";

async function mount(page: Page, value: RichText) {
  await page.goto("/");
  await page.evaluate(async (value) => {
    const { richField } = await import(String("/src/components/rich-field.ts"));
    const field = richField("Round three field", { value, operands: () => [] });
    document.body.replaceChildren(field.wrapper);
  }, value);
  return page.getByRole("textbox", { name: "Round three field", exact: true });
}
async function seed(page: Page, operands = false) {
  await page.goto("/");
  await page.evaluate(async (operands) => {
    const { newDraft, newPlace } = await import(String("/src/model/draft.ts"));
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().put(
      "drafts",
      "current",
      newDraft({
        spelling: "broda",
        kind: "gismu",
        text: [["hello world"]],
        notes: [["retained note"]],
        frameMode: "context",
        places: [newPlace(1)],
        operands: operands
          ? [
              {
                id: "bridi",
                category: "bridi",
                description: [],
                minimum: 1,
                maximum: 1,
              },
            ]
          : [],
        step: 4,
      }),
    );
  }, operands);
  await page.goto("/new/editor");
  await expect(
    page.getByRole("textbox", { name: "Definition text", exact: true }),
  ).toBeVisible();
}
async function clickMiddle(page: Page, field: Locator) {
  const point = await field
    .locator(".rich-literal")
    .first()
    .evaluate((node) => {
      const range = document.createRange();
      range.setStart(node.firstChild!, 6);
      range.setEnd(node.firstChild!, 7);
      const box = range.getBoundingClientRect();
      return { x: box.left + 0.2, y: box.top + box.height / 2 };
    });
  await page.mouse.click(point.x, point.y);
}

test("r3 pointer focus keeps the clicked caret in an unfocused editor", async ({
  page,
}) => {
  const field = await mount(page, [["hello world"]]);
  await clickMiddle(page, field);
  await page.keyboard.type("X");
  expect(await richNodes(field)).toEqual([["hello Xworld"]]);
  await page
    .getByRole("button", { name: "Insert place 1", exact: true })
    .focus();
  await clickMiddle(page, field);
  await page.keyboard.type("Y");
  expect(await richNodes(field)).toEqual([["hello YXworld"]]);
});

test("r3 a native selection chosen before focus stays at its requested offset", async ({
  page,
}) => {
  const field = await mount(page, [["hello world"]]);
  await page
    .getByRole("button", { name: "Insert place 1", exact: true })
    .focus();
  await field.evaluate((node) => {
    const range = document.createRange();
    range.setStart(node.querySelector(".rich-literal")!.firstChild!, 6);
    range.collapse(true);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    (node as HTMLElement).focus();
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page.keyboard.type("X");
  expect(await richNodes(field)).toEqual([["hello Xworld"]]);
});

test("r3 live blank paragraphs stay editable while getters, saved drafts, and publication omit them", async ({
  page,
}) => {
  await seed(page);
  const field = page.getByRole("textbox", {
    name: "Definition text",
    exact: true,
  });
  await field.press("Control+End");
  await field.press("Enter");
  await field.press("Enter");
  await field.pressSequentially("second");
  await field.press("Enter");
  await expect(field.locator("p")).toHaveCount(4);
  expect(await richNodes(field)).toEqual([["hello world"], ["second"]]);
  await page
    .getByRole("textbox", { name: "Notes", exact: true })
    .evaluate((node: any) => {
      node.value = [];
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const notes = page.getByRole("textbox", { name: "Notes", exact: true });
  await notes.press("Enter");
  expect(await richNodes(notes)).toEqual([]);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        const { draftToBody } = await import(String("/src/model/draft.ts"));
        const draft = await new LocalStore().get("drafts", "current");
        const { body } = draftToBody(draft);
        return {
          saved: draft.text,
          notes: draft.notes,
          text: body?.text,
          publishedNotes: body?.notes,
        };
      }),
    )
    .toEqual({
      saved: [["hello world"], ["second"]],
      notes: [],
      text: [["hello world"], ["second"]],
      publishedNotes: [],
    });
});

test("r3 undo of a saved single blank agrees with its canonical stored value", async ({
  page,
}) => {
  const field = await mount(page, [["\n"]]);
  expect(await richNodes(field)).toEqual([]);
  await field.pressSequentially("x");
  expect(await richNodes(field)).toEqual([["x"]]);
  await field.press("Control+z");
  expect(await richNodes(field)).toEqual([]);
  await expect(field.locator("p")).toHaveCount(1);
});

test("r3 each Backspace past an emptied literal changes visible text", async ({
  page,
}) => {
  const field = await mount(page, [["keep ", { code: "ab" }, "y"]]);
  await field.press("Control+End");
  await field.press("Backspace");
  expect(await richNodes(field)).toEqual([["keep ", { code: "ab" }]]);
  await field.press("Backspace");
  expect(await richNodes(field)).toEqual([["keep ", { code: "a" }]]);
});

test("r3 toolbar hints appear only for the focused toolbar and operand guidance follows an attempt", async ({
  page,
}) => {
  await mount(page, [["text"]]);
  const text =
    "Use Left, Right, Home, and End to move through the toolbar. In More places, use Alt with those keys.";
  const hint = page.getByText(text, { exact: true });
  await expect(hint).toBeHidden();
  await expect(
    page.getByText("Declare an operand first.", { exact: true }),
  ).toBeHidden();
  const toolbar = page.getByRole("toolbar");
  await toolbar
    .getByRole("button", { name: "Insert place 1", exact: true })
    .focus();
  await expect(hint).toBeVisible();
  const operand = toolbar.getByRole("button", {
    name: "Insert operand",
    exact: true,
  });
  await operand.evaluate((node) => (node as HTMLButtonElement).click());
  await expect(
    page.getByText("Declare an operand first.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("r3 operand addition and renaming refresh every retained rich-field control", async ({
  page,
}) => {
  await seed(page);
  const retained = await page
    .getByRole("textbox", { name: "Definition text", exact: true })
    .elementHandle();
  await page
    .getByRole("button", { name: "Add an operand", exact: true })
    .click();
  await page.getByLabel("Operand 1 ID", { exact: true }).fill("bridi");
  await page.getByLabel("Operand 1 category", { exact: true }).fill("bridi");
  const controls = page.getByRole("button", {
    name: "Insert operand",
    exact: true,
  });
  for (const control of await controls.all())
    await expect(control).toBeEnabled();
  await page.getByLabel("Operand 1 ID", { exact: true }).fill("sumti");
  for (const control of await controls.all()) {
    await control.click();
    await expect(
      page.getByRole("dialog").getByLabel("Operand", { exact: true }),
    ).toHaveValue("sumti");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
  }
  expect(await retained!.evaluate((node) => node.isConnected)).toBe(true);
});

test("r3 removing the last operand refreshes every retained rich-field control", async ({
  page,
}) => {
  await seed(page, true);
  await page
    .getByRole("button", { name: "Remove operand 1", exact: true })
    .click();
  for (const control of await page
    .getByRole("button", { name: "Insert operand", exact: true })
    .all()) {
    await expect(control).toHaveAttribute("aria-disabled", "true");
    await control.evaluate((node) => (node as HTMLButtonElement).click());
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
});

for (const target of ["authoring", "profile", "rafsi"] as const) {
  test(`r3 a failed ${target} editor load shows a heading and a working Reload action`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let path = "/new/editor";
    let chunk = "**/src/pages/wizard/places.ts";
    if (target === "authoring") await seed(page);
    if (target === "profile") {
      await createIdentity(page);
      path = (await page
        .getByRole("link", { name: "Edit public profile", exact: true })
        .getAttribute("href"))!;
      expect(path).toMatch(/^\/identity\/[^/]+#edit$/);
      chunk = "**/src/components/rich-field.ts";
    }
    if (target === "rafsi") {
      path = "/claim/cukta";
      chunk = "**/src/components/rich-field.ts";
    }
    await page.route(chunk, (route) => route.abort("failed"));
    await page.goto(path);
    await expect(
      page.getByRole("heading", { name: /did not load/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Reload", exact: true }),
    ).toBeVisible();
    if (target === "authoring") {
      await expect(page.locator("main")).toContainText(
        /draft.*(?:safe|saved|kept)/i,
      );
      expect(
        await page.evaluate(async () => {
          const { LocalStore } = await import(String("/src/data/store.ts"));
          return (await new LocalStore().get("drafts", "current")).text;
        }),
      ).toEqual([["hello world"]]);
    }
    expect(errors).toEqual([]);
    await page.unroute(chunk);
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    const name =
      target === "authoring"
        ? "Definition text"
        : target === "profile"
          ? "Biography"
          : "Rationale";
    await expect(
      page.getByRole("textbox", { name, exact: true }),
    ).toBeVisible();
  });
}

test("r3 a failed report-editor load gives an accessible error and recovery", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `/identity/${encodeURIComponent(fixture().identities.author)}`,
  );
  await page.route("**/src/components/rich-field.ts", (route) =>
    route.abort("failed"),
  );
  await page.getByRole("button", { name: "Report abuse", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(/did not load/i);
  await expect(
    page.getByRole("button", { name: "Reload", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  await page.unroute("**/src/components/rich-field.ts");
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await page.getByRole("button", { name: "Report abuse", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Report identity abuse" }),
  ).toBeVisible();
});

test("r3 repeated report activation during loading opens one dialog", async ({
  page,
}) => {
  await page.goto(
    `/identity/${encodeURIComponent(fixture().identities.author)}`,
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/src/components/rich-field.ts", async (route) => {
    started();
    await gate;
    await route.continue();
  });
  const report = page.getByRole("button", {
    name: "Report abuse",
    exact: true,
  });
  await report.click();
  await requested;
  // A native activation reaches the pending handler without Playwright waiting for enabled state.
  await report.evaluate((node) => {
    (node as HTMLButtonElement).click();
    (node as HTMLButtonElement).click();
  });
  release();
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  await expect(
    page.getByRole("dialog", { name: "Report identity abuse" }),
  ).toBeVisible();
});
