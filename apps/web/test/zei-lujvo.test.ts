import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createIdentity, acceptFirstSignature, PASSPHRASE } from "./helpers.ts";

const imports = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/morphology/evidence/zei-lujvo-imports.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const imported = [
  "batke zei uidje",
  "ci zei tuple",
  "cy zei bai'ei zei bangu",
  "ibu zei sance",
  "denpa bu zei sance",
  "ka'ozeino zei namcu",
];
const componentWords = (spelling: string) =>
  spelling === "ka'ozeino zei namcu"
    ? ["ka'o", "no", "namcu"]
    : spelling.split(" zei ");

async function typed(page: Page, spelling: string) {
  await page.goto("/new/meaning");
  await page
    .getByRole("textbox", { name: "Meaning", exact: true })
    .fill("A synthetic zei definition.");
  await page
    .getByRole("textbox", { name: "Lojban word", exact: true })
    .fill(spelling);
  await page.getByRole("button", { name: "New word", exact: true }).click();
  await expect(page.getByRole("radio", { name: /^lujvo/ })).toBeChecked();
  await page
    .getByRole("button", { name: "Link the lujvo parts", exact: true })
    .click();
}
async function saved(page: Page): Promise<any> {
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().get("drafts", "current");
  });
}

for (const spelling of imported)
  test(`imported zei lujvo ${spelling} links whole words and keeps its draft`, async ({
    page,
  }) => {
    expect(
      imports.cases.some(
        (entry: { spelling: string }) => entry.spelling === spelling,
      ),
    ).toBe(true);
    await typed(page, spelling);
    const result = page.getByRole("region", { name: "Result", exact: true });
    await expect(
      result.getByLabel(`Form ${spelling}`, { exact: true }),
    ).toBeVisible();
    await expect(result).toContainText(
      "No rafsi or construction score applies.",
    );
    await expect(
      page.getByRole("textbox", { name: /^Other source word for part/ }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: `Use ${spelling}`, exact: true }),
    ).toBeEnabled();
    await page.reload();
    await expect(
      result.getByLabel(`Form ${spelling}`, { exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("Current definition", { exact: true })
      .fill("A synthetic zei definition.");
    await page
      .getByRole("button", { name: `Use ${spelling}`, exact: true })
      .click();
    await expect(page).toHaveURL(/\/new\/places$/);
    const draft = await saved(page);
    expect(
      draft.compound.components.map((part: any) => part.word.spelling),
    ).toEqual(componentWords(spelling));
    expect(draft.compound.score).toBeNull();
    expect(
      draft.lujvo.components.every((part: any) => part.claims.length === 0),
    ).toBe(true);
    await page.goto("/new/lujvo");
    await expect(
      result.getByLabel(`Form ${spelling}`, { exact: true }),
    ).toBeVisible();
  });

test("zei word-type feedback rejects incomplete and malformed chains", async ({
  page,
}) => {
  await page.goto("/new/editor");
  await page.getByLabel("Type", { exact: true }).selectOption("lujvo");
  const status = page.getByRole("status", { name: "Word form", exact: true });
  for (const spelling of [
    "zei cukta",
    "cukta zei",
    "cukta zei zei dunda",
    "cukta dunda zei bangu",
    "cukta zei zz",
  ]) {
    await page.getByLabel("Headword", { exact: true }).fill(spelling);
    await expect(status).toContainText(
      "does not match the selected lujvo type",
    );
  }
  await page
    .getByLabel("Headword", { exact: true })
    .fill("cukta zei dunda zei bangu");
  await expect(status).not.toContainText("does not match");
});

test("zei feedback rejects final BU tails and accepts nonfinal BU operands", async ({
  page,
}) => {
  await page.goto("/new/editor");
  await page.getByLabel("Type", { exact: true }).selectOption("lujvo");
  const headword = page.getByLabel("Headword", { exact: true });
  const status = page.getByRole("status", { name: "Word form", exact: true });
  for (const spelling of [
    "sance zei denpa bu",
    "broda zei brode bu",
    "abu zei abu",
    "broda zei brode bu bu",
  ]) {
    await headword.fill(spelling);
    await expect(status).toContainText(
      "does not match the selected lujvo type",
    );
  }
  for (const spelling of [
    "denpa bu zei sance",
    "broda zei denpa bu zei sance",
    "abu zei broda",
    "y'y zei bu",
  ]) {
    await headword.fill(spelling);
    await expect(status).toContainText("Detected form: lujvo.");
    await expect(status).not.toContainText("does not match");
  }
});

test("zei exact definition links survive publication, revision, and reload", async ({
  page,
}) => {
  await createIdentity(page);
  await page.goto("/preferences");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(
    "The English search package is saved in this browser.",
  );
  const spelling = "CUKTA  ZEI dunda";
  await typed(page, spelling);
  const choices = page.getByLabel("Exact definition of cukta", { exact: true });
  const definition = await choices
    .locator("option")
    .nth(1)
    .getAttribute("value");
  await choices.selectOption(definition!);
  await expect
    .poll(async () => (await saved(page))?.lujvo?.components?.[0]?.definition)
    .toBe(definition);
  await page.reload();
  await expect(choices).toHaveValue(definition!);
  await page
    .getByLabel("Current definition", { exact: true })
    .fill("A synthetic signed zei definition.");
  await page
    .getByRole("button", { name: `Use ${spelling}`, exact: true })
    .click();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.locator("main")).toContainText(
    "No rafsi assignment applies.",
  );
  await page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true })
    .click();
  const unlock = page.getByRole("dialog", { name: "Unlock your key" });
  if (await unlock.isVisible()) {
    await unlock.getByLabel("Passphrase").fill(PASSPHRASE);
    await unlock.getByRole("button", { name: "Unlock", exact: true }).click();
  }
  await acceptFirstSignature(page);
  await expect(page).toHaveURL(/\/word\//);
  const published = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const rows: any[] = await new LocalStore().list("outbox");
    return rows
      .map((row) => JSON.parse(row.transport))
      .find((row) => row.envelope.header.action.kind === "definition.publish");
  });
  expect(published.body.word.spelling).toBe(spelling);
  expect(published.body.etymology.compound.components[0].definition).toBe(
    definition,
  );
  // Signed transport omits the null default.
  expect(published.body.etymology.compound.score).toBeUndefined();
  await page.goto(
    `/new/editor?revise=${encodeURIComponent(published.envelope.id)}`,
  );
  await expect(page.getByLabel("Headword", { exact: true })).toHaveValue(
    spelling,
  );
  await page.goto("/new/lujvo");
  await expect(
    page.getByLabel(`Form ${spelling}`, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: /^Other source word for part/ }),
  ).toHaveCount(0);
  expect((await saved(page)).compound.components[0].definition).toBe(
    definition,
  );
  await expect
    .poll(async () => (await saved(page))?.lujvo?.components?.[0]?.definition)
    .toBe(definition);
  await page.reload();
  await expect(
    page.getByLabel(`Form ${spelling}`, { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await saved(page))?.lujvo?.components?.[0]?.definition)
    .toBe(definition);
});
