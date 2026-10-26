import { test, expect, type Page } from "@playwright/test";
const status = (page: Page) =>
  page.getByRole("status", { name: "Word form", exact: true });
async function typed(page: Page, word: string) {
  await page.goto("/new/meaning");
  await page
    .getByRole("textbox", { name: "Meaning", exact: true })
    .fill("A synthetic word-form definition.");
  await page
    .getByRole("textbox", { name: "Lojban word", exact: true })
    .fill(word);
  await page.getByRole("button", { name: "New word", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "What kind of word?" }),
  ).toBeVisible();
}

test("the full editor checks every selected kind immediately as spelling and type change", async ({
  page,
}) => {
  await page.goto("/new/editor");
  const headword = page.getByLabel("Headword", { exact: true });
  const kind = page.getByLabel("Type", { exact: true });
  await headword.fill("bangu");
  await kind.selectOption("fuhivla");
  await expect(status(page)).toContainText(
    "The spelling does not match the selected fu'ivla type.",
  );
  await expect(status(page)).toHaveAttribute("aria-live", "polite");
  for (const [value, word, detected] of [
    ["gismu", "bangu", "gismu"],
    ["lujvo", "ckusni", "lujvo"],
    ["fuhivla", "leksiko", "fu'ivla"],
    ["cmavo", "lo", "cmavo"],
    ["cmevla", ".lojban.", "cmevla"],
    ["compound", "taia", "compound"],
  ]) {
    await kind.selectOption(value);
    await headword.fill(word);
    await expect(status(page)).toContainText(`Detected form: ${detected}.`);
    await expect(status(page)).not.toContainText("does not match");
    await headword.fill("zzzz");
    await expect(status(page)).toContainText("does not match");
  }
});
test("manual Form updates its warning and permits an explicit experimental classification", async ({
  page,
}) => {
  await typed(page, "bangu");
  await page
    .getByRole("link", { name: "Type it in and skip the builder" })
    .click();
  await page.getByLabel("Spelling", { exact: true }).fill("leksiko");
  await expect(status(page)).toContainText(
    "The spelling does not match the selected gismu type.",
  );
  await page
    .getByRole("checkbox", { name: "Experimental classification", exact: true })
    .check();
  await expect(status(page)).toContainText(
    "The experimental label permits this classification.",
  );
  await page.getByRole("button", { name: "Use leksiko", exact: true }).click();
  await expect(page).toHaveURL(/\/new\/places$/);
});
test("Type recognizes compound cmavo and updates feedback after a different type choice", async ({
  page,
}) => {
  await typed(page, "taia");
  await expect(status(page)).toContainText("Words: tai · a.");
  await expect(
    page.getByLabel(
      "Which other kind? Every lexical kind that the format permits is listed.",
    ),
  ).toHaveValue("compound");
  await page.getByRole("radio", { name: /^cmavo/ }).check();
  await expect(status(page)).toContainText(
    "does not match the selected cmavo type",
  );
  await page.getByRole("radio", { name: /^Other/ }).check();
  await expect(status(page)).not.toContainText("does not match");
});
test("accepted CgV names and borrowings display the exact current-BPFK warning", async ({
  page,
}) => {
  await page.goto("/new/editor");
  await page.getByLabel("Type", { exact: true }).selectOption("cmevla");
  await page.getByLabel("Headword", { exact: true }).fill("cian");
  await expect(status(page)).toContainText(
    "This form is not valid under the current BPFK morphology.",
  );
  await expect(status(page)).not.toContainText("does not match");
  await page.getByLabel("Type", { exact: true }).selectOption("fuhivla");
  await page.getByLabel("Headword", { exact: true }).fill("sliagri");
  await expect(status(page)).toContainText(
    "This form is not valid under the current BPFK morphology.",
  );
  await expect(status(page)).not.toContainText("does not match");
  await page.getByLabel("Headword", { exact: true }).fill("leksiko");
  await expect(status(page)).not.toContainText("current BPFK");
});
test("full-editor labels and explicit classification controls stay synchronized", async ({
  page,
}) => {
  await page.goto("/new/editor");
  await page.getByLabel("Type", { exact: true }).selectOption("gismu");
  await page.getByLabel("Headword", { exact: true }).fill("leksiko");
  await page.getByLabel("Labels", { exact: true }).fill("experimental");
  await expect(status(page)).toContainText(
    "The experimental label permits this classification.",
  );
  await expect(
    page.getByRole("checkbox", {
      name: "Experimental classification",
      exact: true,
    }),
  ).toBeChecked();
  await page
    .getByRole("checkbox", { name: "Experimental classification", exact: true })
    .uncheck();
  await expect(page.getByLabel("Labels", { exact: true })).toHaveValue("");
  await page.getByLabel("Labels", { exact: true }).fill("experimental");
  await page.getByLabel("Labels", { exact: true }).fill("");
  await expect(status(page)).toContainText("Choose another type");
  await expect(
    page.getByRole("checkbox", {
      name: "Experimental classification",
      exact: true,
    }),
  ).not.toBeChecked();
});
