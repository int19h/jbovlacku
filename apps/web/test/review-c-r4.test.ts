import { richText, typeRichText } from "./rich-helpers.ts";
import { expect, test } from "@playwright/test";
import { corePath } from "./helpers.ts";

test("N1 typed TeX and backslashes keep their values in the saved draft", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async (path) => {
    const core = await import(path);
    await core.initializeCore();
    const { newDraft } = await import(String("/src/model/draft.ts"));
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().put(
      "drafts",
      "current",
      newDraft({ spelling: "broda", kind: "gismu", structured: true }),
    );
  }, corePath);
  await page.goto("/new/places");
  const value = String.raw`\rightarrow Tom \& Jerry hello\ world`;
  const source = `${value} \`\\rho\` [[https://example.org/|\\rm label]] C:\\\n\nNext.\n\n  `;
  await page
    .getByRole("textbox", { name: "Definition text", exact: true })
    .fill(source);
  await expect(
    page.getByText("Saved in this browser", { exact: true }),
  ).toBeVisible();
  const saved = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return (await new LocalStore().get("drafts", "current")).text;
  });
  expect(saved).toEqual([
    [
      value + " ",
      { code: String.raw`\rho` },
      " ",
      { url: "https://example.org/", label: String.raw`\rm label` },
      " C:\\",
    ],
    ["Next."],
  ]);
});

test("N5 keyboard batches focus the first new row through the final batch", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("region", { name: "Search results" }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const { changedValues } = await import(
      String("/src/components/comparison.ts")
    );
    document.querySelector("main")!.replaceChildren(
      changedValues(
        Array.from({ length: 120 }, (_, i) => `old${i}`),
        Array.from({ length: 120 }, (_, i) => `new${i}`),
        "labels",
      ),
    );
  });
  const rows = page.locator(".comparison-pair");
  await expect(rows).toHaveCount(50);
  await page
    .getByRole("button", { name: "70 more changes. Show the next 50" })
    .focus();
  await page.keyboard.press("Enter");
  await expect(rows).toHaveCount(100);
  await expect(rows.nth(50)).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.locator(".comparison-exact > summary").nth(50),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "20 more changes. Show the next 50" })
    .focus();
  await page.keyboard.press("Enter");
  await expect(rows).toHaveCount(120);
  await expect(rows.nth(100)).toBeFocused();
  await expect(
    page.getByRole("button", { name: /Show the next 50/ }),
  ).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(
    page.locator(".comparison-exact > summary").nth(100),
  ).toBeFocused();
});

test("N2 and N4 saved prose stays readable and typed trailing whitespace is trimmed", async ({
  page,
}) => {
  await page.goto("/");
  const prose = "line one\nline two\nline three";
  await page.evaluate(
    async ({ path, prose }) => {
      const core = await import(path);
      await core.initializeCore();
      const { newDraft } = await import(String("/src/model/draft.ts"));
      const { LocalStore } = await import(String("/src/data/store.ts"));
      await new LocalStore().put(
        "drafts",
        "current",
        newDraft({
          spelling: "broda",
          kind: "gismu",
          structured: true,
          text: [[prose], ["  "]],
        }),
      );
    },
    { path: corePath, prose },
  );
  await page.goto("/new/places");
  const editor = page.getByRole("textbox", {
    name: "Definition text",
    exact: true,
  });
  const source = await richText(editor);
  expect(source.split("\n\n")[0]).toBe(prose);
  await typeRichText(editor, source + "\n\nNext.\n\n  ");
  await expect(
    page.getByText("Saved in this browser", { exact: true }),
  ).toBeVisible();
  const saved = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return (await new LocalStore().get("drafts", "current")).text;
  });
  expect(saved).toEqual([[prose], ["  "], ["Next."], ["  "]]);
});

test("N3 distant edits in a long list render only the two changes", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("region", { name: "Search results" }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const { changedValues } = await import(
      String("/src/components/comparison.ts")
    );
    const before = Array.from({ length: 250 }, (_, i) => `item${i}`);
    const after = [...before];
    after.splice(4, 0, "added");
    after[245] = "changed";
    document
      .querySelector("main")!
      .replaceChildren(changedValues(before, after, "labels"));
  });
  await expect(page.locator(".comparison-pair")).toHaveCount(2);
  await expect(page.locator("main")).toContainText("added");
  await expect(page.locator("main")).toContainText("changed");
  await expect(
    page.getByRole("button", { name: /Show the next 50/ }),
  ).toHaveCount(0);
});
