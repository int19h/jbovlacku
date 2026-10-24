import { test, expect } from "@playwright/test";

test("invalid saved arity stays editable and arity controls save whole numbers", async ({
  page,
}) => {
  await page.goto("/new/editor");
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { newDraft, newPlace } = await import(String("/src/model/draft.ts"));
    const draft = newDraft({
      spelling: "broda",
      kind: "gismu",
      text: "A relation with a repeated tail.",
      frameMode: "variadic",
      variadicMinimum: 1.5,
      places: [
        {
          ...newPlace(1),
          kind: "custom",
          hint: {
            alternatives: [
              {
                tags: ["relation"],
                abstractor: null,
                relation_arity: { mode: "fixed", count: 1.5 },
              },
            ],
            note: [],
          },
        },
      ],
      tail: { description: [], kind: "unspecified", hint: null },
    });
    await new LocalStore().put("drafts", "current", draft);
  });
  await page.reload();
  await expect(page.getByLabel("Headword")).toHaveValue("broda");
  await expect(
    page.getByLabel("Count for alternative 1", { exact: true }),
  ).toHaveValue("1.5");
  await expect(
    page.getByLabel("Minimum number of places", { exact: true }),
  ).toHaveValue("1.5");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.locator("main")).toContainText(/problems? block signing/);
  await expect(
    page.locator("aside").getByRole("button", { name: "Publish", exact: true }),
  ).toBeDisabled();
  await page.getByRole("link", { name: "Edit", exact: true }).click();
  const count = page.getByLabel("Count for alternative 1", { exact: true });
  await page
    .getByLabel("Relation arity for alternative 1", { exact: true })
    .selectOption("variadic");
  await expect(count).toHaveValue("1");
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        const draft = await new LocalStore().get("drafts", "current");
        return draft.places[0].hint.alternatives[0].relation_arity;
      }),
    )
    .toEqual({ mode: "variadic", minimum: 1 });
  await count.fill("2.9");
  await expect(count).toHaveValue("2.9");
  await count.blur();
  await expect(count).toHaveValue("2");
  const minimum = page.getByLabel("Minimum number of places", { exact: true });
  await minimum.fill("1.9");
  await expect(minimum).toHaveValue("1.9");
  await minimum.blur();
  await expect(minimum).toHaveValue("1");
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        const draft = await new LocalStore().get("drafts", "current");
        return [
          draft.places[0].hint.alternatives[0].relation_arity,
          draft.variadicMinimum,
        ];
      }),
    )
    .toEqual([{ mode: "variadic", minimum: 2 }, 1]);
  await page.reload();
  await expect(
    page.getByLabel("Count for alternative 1", { exact: true }),
  ).toHaveValue("2");
  await expect(
    page.getByLabel("Minimum number of places", { exact: true }),
  ).toHaveValue("1");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.locator("main")).not.toContainText(
    /problems? block signing/,
  );
});
