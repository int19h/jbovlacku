import { test, expect, type Page } from "@playwright/test";
import { fixture } from "./helpers.ts";

async function downloadPackage(page: Page) {
  await page.goto("/preferences");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(
    "The English search package is saved in this browser.",
  );
}
async function startDraft(page: Page, kind: "lujvo" | "gismu") {
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto("/new/meaning");
  await page
    .getByRole("textbox", { name: "Meaning" })
    .fill("___ is a bookmark in book ___.");
  await page.getByRole("button", { name: "New word" }).click();
  await page.getByRole("heading", { name: "What kind of word?" }).waitFor();
  await page.getByRole("radio", { name: new RegExp(kind) }).check();
  await page
    .getByRole("button", {
      name: kind === "lujvo" ? "Build the lujvo" : "Make a gismu",
    })
    .click();
}
async function currentDraft(page: Page) {
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().get("drafts", "current");
  });
}

test("the lujvo builder offers long forms beside listed rafsi, recovers parts, honors locks, and needs acknowledgment of competing claims", async ({
  page,
}) => {
  await downloadPackage(page);
  await startDraft(page, "lujvo");
  await expect(
    page.getByRole("heading", { name: "Build the lujvo" }),
  ).toBeVisible();
  await page.getByLabel("Add a part").fill("cukta");
  await expect(
    page.getByRole("list", { name: "Matching words" }),
  ).toContainText("rafsi cku");
  await page.getByRole("button", { name: "Add cukta", exact: true }).click();
  await page.getByLabel("Add a part").fill("sinxa");
  await page.getByRole("button", { name: "Add sinxa as entered" }).click();
  const result = page.getByRole("region", { name: "Result" });
  await expect(result).toContainText("ckusinxa");
  await expect(result).toContainText("Construction score 7917");
  await expect(result).toContainText("Recovered parts: cku + sinxa");
  // Every gismu row offers the stem and the whole gismu beside the listed claim.
  const cuktaRow = page.getByRole("group", { name: "Rafsi for cukta" });
  await expect(
    cuktaRow.getByRole("radio", { name: /^cukt stem/ }),
  ).toBeVisible();
  await expect(
    cuktaRow.getByRole("radio", { name: /^cukta last/ }),
  ).toBeVisible();
  await expect(
    cuktaRow.getByRole("radio", { name: "cku", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Other forms" })).toContainText(
    "cukt + y + sinxa",
  );
  // A lock keeps the stem and the join stays separate from the chosen form.
  await cuktaRow.getByRole("radio", { name: /^cukt stem/ }).check();
  await expect(result).toContainText("cuktysinxa");
  await expect(result).toContainText("Recovered parts: cukt + y + sinxa");
  // A lock in an impossible position is explained instead of silently dropped.
  await cuktaRow.getByRole("radio", { name: /^cukta last/ }).check();
  await expect(result).toContainText("cannot stand in position 1");
  await expect(
    page.getByRole("button", { name: /^Use /, exact: false }).last(),
  ).toBeDisabled();
  await cuktaRow.getByRole("radio", { name: "automatic" }).check();
  // A rafsi entered by hand that another word claims needs acknowledgment.
  await page.getByLabel("Other rafsi you know").nth(1).fill("cku");
  await page.getByLabel("Other rafsi you know").nth(1).press("Tab");
  await expect(result).toContainText("Competing claims");
  await expect(result).toContainText("cku is also claimed by cukta");
  const primary = page.locator("button.btn-primary");
  await expect(primary).toHaveText("Use ckucku");
  await expect(primary).toBeDisabled();
  for (const box of await result.getByRole("checkbox").all()) await box.check();
  await expect(primary).toBeEnabled();
  // Choose the listed alternative instead and continue.
  await page.getByRole("button", { name: "Use ckusinxa" }).click();
  await expect(primary).toHaveText("Use ckusinxa");
  await primary.click();
  await expect(page).toHaveURL(/\/new\/places$/);
  const draft = await currentDraft(page);
  expect(draft.spelling).toBe("ckusinxa");
  expect(
    draft.compound.components.map((c: { rafsi: string }) => c.rafsi),
  ).toEqual(["cku", "sinxa"]);
  expect(draft.compound.score).toBe(7917);
  expect(draft.compound.morphology.version).toBe("1");
  // The builder state survives a reload.
  await page.goto("/new/lujvo");
  await expect(page.getByRole("region", { name: "Result" })).toContainText(
    "ckusinxa",
  );
});

test("the extended profile joins whole-word parts that CLL rules reject", async ({
  page,
}) => {
  await startDraft(page, "lujvo");
  await page.getByLabel("Add a part").fill("fulta");
  await page.getByRole("button", { name: "Add fulta as entered" }).click();
  await page.getByLabel("Add a part").fill("ismu");
  await page.getByRole("button", { name: "Add ismu as entered" }).click();
  const result = page.getByRole("region", { name: "Result" });
  await expect(result).toContainText("No valid lujvo comes from these parts");
  await expect(
    page
      .getByText(/usable as a long form only under the extended profile/)
      .first(),
  ).toBeVisible();
  await page.getByRole("radio", { name: "Extended: whole-word parts" }).check();
  await expect(result).toContainText("fulty'ismu");
  await expect(result).toContainText("under the extended scorer");
  await expect(result).toContainText("Recovered parts: fult + y' + ismu");
  // A fu'ivla part is offered whole under the extended profile.
  await page.getByRole("button", { name: "Remove fulta" }).click();
  await page.getByLabel("Add a part").fill("leksiko");
  await page.getByRole("button", { name: "Add leksiko as entered" }).click();
  await page.getByRole("button", { name: "Move leksiko up" }).click();
  await expect(result).toContainText("leksiko'yismu");
  await expect(result).toContainText("Recovered parts: leksiko + 'y + ismu");
});

test("the gismu generator scores exactly, shares ranks, lists conflicts, and records the run", async ({
  page,
}) => {
  const f = fixture();
  await downloadPackage(page);
  await startDraft(page, "gismu");
  await expect(
    page.getByRole("heading", { name: "Make a gismu" }),
  ).toBeVisible();
  await expect(
    page.getByText(/updated six-language table of CLL chapter 4.14/),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "https://lojban.github.io/cll/4/14/" }),
  ).toBeVisible();
  await expect(
    page.getByText("Fill in every scoring input before the generator runs."),
  ).toBeVisible();
  const inputs: Record<string, string> = {
    "Mandarin Chinese": "moku",
    Hindi: "kukurmutta",
    English: "macrum",
    Spanish: "ongo",
    Russian: "grip",
    Arabic: "futr",
  };
  for (const [name, value] of Object.entries(inputs))
    await page.getByLabel(`Scoring letters for ${name}`).fill(value);
  await expect(
    page.getByText(/10944 candidate forms were scored completely/),
  ).toBeVisible();
  const candidates = page.getByRole("region", { name: "Candidates" });
  await expect(candidates).toContainText("mokru");
  // Equal exact scores share a rank, and the next lower score follows the tied group.
  const rows = await candidates.locator("tbody tr").evaluateAll((rows) =>
    rows.map((r) => ({
      rank: Number(r.children[0].textContent),
      score: (r.children[2] as HTMLElement).title,
    })),
  );
  const byScore = new Map<string, number[]>();
  for (const { rank, score } of rows)
    byScore.set(score, [...(byScore.get(score) ?? []), rank]);
  const tied = [...byScore.entries()].find(([, ranks]) => ranks.length > 1);
  expect(tied, "a tied pair of distinct forms").toBeDefined();
  expect(new Set(tied![1]).size).toBe(1);
  for (const ranks of byScore.values()) expect(new Set(ranks).size).toBe(1);
  const fraction = (value: string) => {
    const [n, d] = value.split("/").map(Number);
    return n / d;
  };
  const after = rows.find(
    (r) => fraction(r.score) < fraction(tied![0]) && r.rank > tied![1][0],
  );
  expect(after, "a lower score after the tied group").toBeDefined();
  expect(after!.rank).toBe(tied![1][0] + tied![1].length);
  await page.getByRole("button", { name: "Choose monku" }).click();
  const selected = page.getByRole("region", { name: "Selected form" });
  await expect(selected).toContainText("exactly 4477/10000");
  await expect(selected).toContainText("rank 6 of 10944");
  await expect(selected).toContainText("4 of 4 letters recognized");
  await expect(selected).toContainText("Possible short rafsi: mo'u, mok, mon");
  // A manual form that repeats an existing gismu lists the identical conflict and needs acknowledgment.
  await page.getByLabel("Type a form yourself").fill("cukta");
  await expect(candidates).toContainText("identical to cukta");
  await page.getByRole("button", { name: "Choose cukta" }).click();
  await expect(selected).toContainText("identical to cukta");
  await expect(selected).toContainText("cku is claimed by cukta");
  const primary = page.locator("button.btn-primary");
  await expect(primary).toHaveText("Use cukta");
  await expect(primary).toBeDisabled();
  await selected.getByRole("checkbox").check();
  await expect(primary).toBeEnabled();
  await page.getByLabel("Why this form").fill("Only a test.");
  await primary.click();
  await expect(page).toHaveURL(/\/new\/places$/);
  const draft = await currentDraft(page);
  expect(draft.spelling).toBe("cukta");
  expect(draft.formation.method).toBe("algorithmic");
  expect(draft.formation.weights_profile.name).toBe("CLL 1995");
  expect(draft.formation.algorithm.parameters.weighting).toBe(
    "normalize-positive-sum-v1",
  );
  expect(draft.formation.sources).toHaveLength(6);
  expect(draft.formation.sources[0].weight).toEqual({
    numerator: 347,
    denominator: 1000,
  });
  expect(draft.formation.sources[2].weight).toEqual({
    numerator: 4,
    denominator: 25,
  });
  expect(draft.formation.conflicts).toEqual([
    {
      word: f.words.cukta,
      rule: "identical",
      snapshot: expect.stringMatching(/^sha256:/),
    },
  ]);
  expect(typeof draft.formation.selected_rank).toBe("number");
  expect(draft.formation.candidates.length).toBeGreaterThan(0);
});

test("a custom profile needs a positive weight and an unfinished row never gets an invented value", async ({
  page,
}) => {
  await startDraft(page, "gismu");
  await page.getByLabel("Weights").selectOption("custom");
  await page.getByRole("button", { name: "Add a language" }).click();
  await page.getByLabel("Language tag of row 7").fill("deu");
  await page.getByLabel("Weight numerator of row 7").fill("0");
  await page.getByLabel("Weight numerator of row 7").press("Tab");
  await expect(
    page.getByText("Fill in every scoring input before the generator runs."),
  ).toBeVisible();
  for (let row = 1; row <= 6; row++) {
    await page.getByRole("button", { name: `Remove row 1` }).click();
  }
  await page.getByLabel("Scoring letters for deu").fill("pilts");
  await expect(
    page.getByText(/At least one language weight must be positive/),
  ).toBeVisible();
  await page.getByLabel("Weight numerator of row 1").fill("3");
  await page.getByLabel("Weight numerator of row 1").press("Tab");
  await expect(
    page.getByText(/candidate forms were scored completely/),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /^Choose / })
    .first()
    .click();
  await expect(
    page.getByRole("region", { name: "Selected form" }),
  ).toContainText("0.800 of 1.000");
});
