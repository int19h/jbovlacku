import { test, expect } from "@playwright/test";
import { expectRichText, typeRichText } from "./rich-helpers.ts";

test("wizard explanations keep Meaning help and other languages behind keyboard controls", async ({
  page,
}) => {
  await page.goto("/new/meaning");
  const help = page.getByText("Help with literal circled characters", {
    exact: true,
  });
  const explanation = page.getByText(
    "Only a backslash before a circled character is an escape.",
    { exact: false },
  );
  await expect(explanation).not.toBeVisible();
  await help.focus();
  await help.press("Enter");
  await expect(explanation).toBeVisible();
  await expect(help).toBeFocused();
  await help.press("Space");
  await expect(explanation).not.toBeVisible();
  const language = page.getByLabel("Language", { exact: true });
  const custom = page.getByLabel("Other language tag");
  await expect(language).toHaveValue("en");
  await expect(custom).toBeHidden();
  await language.focus();
  await language.selectOption("other");
  await expect(language).toBeFocused();
  await expect(custom).toBeVisible();
  await language.press("Tab");
  await expect(custom).toBeFocused();
  await custom.fill("fr");
  await expect(page.getByText("Saved in this browser")).toBeVisible();
  await page.reload();
  await expect(language).toHaveValue("other");
  await expect(custom).toHaveValue("fr");
  await language.focus();
  await language.selectOption("en");
  await expect(custom).toBeHidden();
  await expect(language).toBeFocused();
  await language.press("Tab");
  await expect(page.getByLabel("Lojban word")).toBeFocused();
  await expect(page.getByText("Saved in this browser")).toBeVisible();
  await page.reload();
  await expect(language).toHaveValue("en");
  await expect(custom).toBeHidden();
});

test("wizard explanations fill the definition and require only numbering approval", async ({
  page,
}) => {
  await page.goto("/new/meaning");
  await page
    .getByRole("textbox", { name: "Meaning", exact: true })
    .fill("___ reads ___; ___ listens.");
  await page.getByLabel("Lojban word").fill("broda");
  await page.getByRole("link", { name: "Skip to the full editor" }).click();
  const editor = page.getByRole("textbox", {
    name: "Definition text",
    exact: true,
  });
  await expectRichText(editor, "① reads ②; ① listens.");
  await expect(page.getByLabel("Type", { exact: true })).toHaveValue("gismu");
  await expect(
    page.getByRole("button", { name: /Use the meaning/ }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Both modes produce the same rich text schema.", {
      exact: false,
    }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("list", { name: "Places used in each part" })
      .locator("p.meta"),
  ).toHaveText(["Part 1: places 1, 2", "Part 2: places 1"]);
  await expect(
    page.getByRole("region", { name: "Rendered definition" }),
  ).toContainText("Approve");
  await page
    .getByRole("button", { name: "Approve the numbering" })
    .press("Enter");
  await expect(page.getByText("Place numbering approved.")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Place numbering", exact: true }),
  ).toBeFocused();
  await typeRichText(editor, "② edits ①.");
  await expect(
    page.getByRole("button", { name: "Approve the numbering" }),
  ).toBeVisible();
  await page.getByRole("link", { name: /^Meaning\b/ }).click();
  await page
    .getByRole("textbox", { name: "Meaning", exact: true })
    .fill("A different meaning.");
  await page.getByRole("link", { name: "Skip to the full editor" }).click();
  await expectRichText(editor, "② edits ①.");
  await typeRichText(editor, "");
  await expect(page.getByText("Saved in this browser")).toBeVisible();
  await page.reload();
  await expect(editor).toBeEmpty();
});

test("wizard explanations hide developer details and retain explicit type choices", async ({
  page,
}) => {
  await page.goto("/new/meaning");
  await page.getByRole("link", { name: "Skip to the full editor" }).click();
  const type = page.getByLabel("Type", { exact: true });
  await expect(type).toHaveValue("");
  await page.getByLabel("Headword").fill("vlaste");
  await expect(type).toHaveValue("lujvo");
  await page.getByLabel("Headword").fill("broda");
  await expect(type).toHaveValue("gismu");
  await type.selectOption("other");
  await page.getByLabel("Headword").fill("cukta");
  await expect(type).toHaveValue("other");
  const developer = page.getByText("Developer details", { exact: true });
  const explanation = page.getByText(
    "A missing default does not mean zo'e or an empty value. Version 1 does not execute conditions.",
    { exact: true },
  );
  await expect(explanation).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Fixed fields" }),
  ).not.toBeVisible();
  await expect(page.locator("pre.json")).not.toBeVisible();
  await expect(page.locator("main details > summary").last()).toHaveText(
    "Developer details",
  );
  await developer.focus();
  await developer.press("Enter");
  await expect(developer).toBeFocused();
  await expect(explanation).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Fixed fields" }),
  ).toBeVisible();
  await expect(page.locator("pre.json")).toBeVisible();
  await typeRichText(
    page.getByRole("textbox", { name: "Definition text", exact: true }),
    "A book.",
  );
  await expect
    .poll(
      async () => JSON.parse(await page.locator("pre.json").innerText()).text,
    )
    .toEqual([["A book."]]);
  await developer.focus();
  await developer.press("Space");
  await expect(page.locator("pre.json")).toBeHidden();
  await expect(developer).toBeFocused();
  await expect(
    page.getByRole("textbox", { name: "Definition text", exact: true }),
  ).toBeVisible();
});

test("wizard explanations preserve a definition cleared in the lujvo builder", async ({
  page,
}) => {
  await page.goto("/new/meaning");
  await page
    .getByRole("textbox", { name: "Meaning", exact: true })
    .fill("___ is a book list.");
  await page.getByLabel("Lojban word").fill("cuktyliste");
  await page.getByRole("link", { name: /^Type\b/ }).click();
  await expect(page.getByRole("radio", { name: /^lujvo\b/ })).toBeChecked();
  await page.getByRole("button", { name: "Link the lujvo parts" }).click();
  const definition = page.getByRole("textbox", {
    name: "Current definition",
    exact: true,
  });
  await typeRichText(definition, "An edited definition.");
  await typeRichText(definition, "");
  await page.getByRole("link", { name: /^Places\b/ }).click();
  await expect(
    page.getByRole("textbox", { name: "Definition text", exact: true }),
  ).toBeEmpty();
  await expect(
    page.getByRole("button", { name: /Use the meaning/ }),
  ).toHaveCount(0);
});

test("wizard explanations refresh initial type feedback for a saved automatic choice", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const { newDraft } = await import(String("/src/model/draft.ts"));
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().put(
      "drafts",
      "current",
      newDraft({
        spelling: "vlaste",
        kind: "gismu",
        autoDetectedKind: "gismu",
        text: [["A word list."]],
        step: 4,
      }),
    );
  });
  await page.goto("/new/editor");
  await expect(page.getByLabel("Type", { exact: true })).toHaveValue("lujvo");
  const status = page.getByRole("status", { name: "Word form", exact: true });
  await expect(status).toHaveText("Detected form: lujvo.");
  await expect(status).not.toContainText("does not match");
  await expect(status).not.toHaveClass(/\bnotice\b/);
});
