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
  // The spelling is absent: the package and the server both say so.
  await expect(result).toContainText(
    /Not in the local package of snapshot [0-9a-f]{12}…/,
  );
  await expect(result).toContainText(
    /The server has no definition of ckusinxa in snapshot [0-9a-f]{12}…/,
  );
  // A specific source definition is the author's choice among the package's definitions.
  const exact = page.getByLabel("Exact definition of cukta");
  await expect(exact).toHaveValue("");
  const options = await exact
    .locator("option")
    .evaluateAll((nodes) => nodes.map((n) => (n as HTMLOptionElement).value));
  expect(options.length).toBeGreaterThan(2);
  const chosenDefinition = options[2];
  await exact.selectOption(chosenDefinition);
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
  // This form uses sinxa itself, so it needs no acknowledgment for its unused cku claim.
  await expect(primary).toBeEnabled();
  await expect(result.getByRole("checkbox")).toHaveCount(0);
  await primary.click();
  await expect(page).toHaveURL(/\/new\/places$/);
  const draft = await currentDraft(page);
  expect(draft.spelling).toBe("ckusinxa");
  expect(
    draft.compound.components.map((c: { rafsi: string }) => c.rafsi),
  ).toEqual(["cku", "sinxa"]);
  expect(draft.compound.score).toBe(7917);
  expect(draft.compound.morphology.version).toBe("2");
  expect(
    draft.compound.components.map(
      (c: { definition: string | null }) => c.definition,
    ),
  ).toEqual([chosenDefinition, null]);
  expect(draft.evidenceForm).toBe("ckusinxa");
  // The builder state survives a reload.
  await page.goto("/new/lujvo");
  await expect(page.getByRole("region", { name: "Result" })).toContainText(
    "ckusinxa",
  );
  // The evidence describes one exact form. Another spelling blocks publication until the form is built again.
  await page.goto("/new/editor");
  await page.getByLabel("Headword").fill("ckusinxe");
  await expect(page.getByRole("status").last()).toHaveText(
    "Saved in this browser",
  );
  await page.goto("/new/publish");
  await expect(page.locator("main")).toContainText(
    'The compound evidence describes "ckusinxa", not "ckusinxe". Build the form again, or remove the evidence.',
  );
  await expect(
    page.locator("aside").getByRole("button", { name: "Publish", exact: true }),
  ).toBeDisabled();
});

test("the lujvo builder says when a spelling is taken in the local package and on the server", async ({
  page,
}) => {
  await downloadPackage(page);
  await startDraft(page, "lujvo");
  await page.getByLabel("Add a part").fill("cukta");
  await page.getByRole("button", { name: "Add cukta", exact: true }).click();
  await page.getByLabel("Add a part").fill("sorcu");
  await page.getByRole("button", { name: "Add sorcu as entered" }).click();
  await page.getByLabel("Other rafsi you know").nth(1).fill("sro");
  await page.getByLabel("Other rafsi you know").nth(1).press("Tab");
  const result = page.getByRole("region", { name: "Result" });
  await expect(result).toContainText("Recovered parts: cku + sro");
  await expect(result).toContainText(
    /Taken: ckusro is defined in the local package of snapshot [0-9a-f]{12}…/,
  );
  await expect(result).toContainText(
    /The server defines ckusro in snapshot [0-9a-f]{12}…/,
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
  // Without a package, availability is unknown and says so. The server still answers.
  await expect(result).toContainText(
    "Availability in the local package is unknown: no package is downloaded.",
  );
  await expect(result).toContainText(
    /The server has no definition of fulty'ismu (now|in snapshot [0-9a-f]{12}…)\./,
  );
  // With the rafsi claim ful, the builder makes fuly'ismu. The pinned jbotci
  // lineage reads it back as ful, y', ismu (crates/jvc-morphology/evidence/word-parses.json).
  await page.getByLabel("Other rafsi you know").nth(0).fill("ful");
  await page.getByLabel("Other rafsi you know").nth(0).press("Tab");
  await expect(result).toContainText("fuly'ismu");
  await expect(result).toContainText("Recovered parts: ful + y' + ismu");
  // A whole-word core that no reference reads as one lujvo is rejected, not offered.
  await page.getByRole("button", { name: "Remove fulta" }).click();
  await page.getByLabel("Add a part").fill("leksiko");
  await page.getByRole("button", { name: "Add leksiko as entered" }).click();
  await page.getByRole("button", { name: "Move leksiko up" }).click();
  await expect(result).toContainText("No valid lujvo comes from these parts");
  await expect(result).toContainText(
    "leksiko'yismu: The selected profile does not read this form as one lujvo.",
  );
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
  // A typed form that repeats an existing gismu is scored under the run.
  // Before its row is chosen, its conflicts already block the primary action.
  await page.getByLabel("Type a form yourself").fill("cukta");
  await expect(candidates).toContainText("identical to cukta");
  const primary = page.locator("button.btn-primary");
  await expect(primary).toHaveText("Use cukta");
  await expect(primary).toBeDisabled();
  await expect(primary).toHaveAttribute(
    "title",
    "Acknowledge every known conflict first, or choose another form.",
  );
  await page.getByRole("button", { name: "Choose monku" }).click();
  await expect(primary).toHaveText("Use monku");
  await expect(primary).toBeEnabled();
  const selected = page.getByRole("region", { name: "Selected form" });
  await expect(selected).toContainText("exactly 4477/10000");
  await expect(selected).toContainText("rank 6 of 10944");
  await expect(selected).toContainText("4 of 4 letters recognized");
  await expect(selected).toContainText("Possible short rafsi: mo'u, mok, mon");
  // A manual form that repeats an existing gismu lists the identical conflict and needs acknowledgment.
  // Choosing the manual row keeps the same conflicts and the same acknowledgment rule.
  await page.getByRole("button", { name: "Choose cukta" }).click();
  await expect(selected).toContainText("identical to cukta");
  await expect(selected).toContainText("cku is claimed by cukta");
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
  // Without a completed run, a typed form has unknown conflicts and cannot be used from here.
  await page.getByLabel("Type a form yourself").fill("pilta");
  const manualNote = page.getByText(
    "The manual form is checked for conflicts under the run. Complete the source rows so the run can score it, or use Enter without generation.",
  );
  await expect(manualNote).toBeVisible();
  await expect(page.locator("button.btn-primary")).toHaveText("Use pilta");
  await expect(page.locator("button.btn-primary")).toBeDisabled();
  await page.getByLabel("Type a form yourself").fill("");
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

for (const measure of ["recognition work", "build recognition work"]) {
  test(`the wizard gives lock advice for ${measure} from WebAssembly`, async ({
    page,
  }) => {
    await page.route(
      "**/packages/core/generated/jvc_runtime.js",
      async (route) => {
        const response = await route.fetch();
        const failure = JSON.stringify({
          kind: "resource-limit",
          measure,
          value: 50001,
          limit: 50000,
        });
        const body = (await response.text()).replace(
          "export function build_lujvo(bytes) {",
          `export function build_lujvo(bytes) { throw ${JSON.stringify(failure)};`,
        );
        await route.fulfill({ response, body });
      },
    );
    await startDraft(page, "lujvo");
    for (const spelling of ["bangu", "sinxa"]) {
      await page.getByLabel("Add a part").fill(spelling);
      await page
        .getByRole("button", { name: `Add ${spelling} as entered` })
        .click();
    }
    const result = page.getByRole("region", { name: "Result" });
    await expect(result).toContainText(
      `The builder stopped: ${measure} is 50001, above the limit of 50000.`,
    );
    await expect(result).toContainText(
      "Lock a component form or request fewer results.",
    );
  });
}
