import { setRichNodes } from "./rich-helpers.ts";
import { appendRichText } from "./rich-helpers.ts";
import { expect, test } from "@playwright/test";
import { corePath } from "./helpers.ts";

test("R5 an edit keeps TeX and reserved-looking text literal in prose code and labels", async ({
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
  const value = String.raw`$T_{cr}$ {join} {char d800} \rightarrow \rho Tom \& Jerry`;
  await setRichNodes(
    page.getByRole("textbox", { name: "Definition text", exact: true }),
    [
      [
        value + " ",
        { code: value },
        " ",
        { url: "https://example.org/", label: value },
      ],
    ],
  );
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
      { code: value },
      " ",
      { url: "https://example.org/", label: value },
    ],
  ]);
});

test("R5 nearby edits preserve rare stored values", async ({ page }) => {
  await page.goto("/");
  const original = await page.evaluate(async (path) => {
    const core = await import(path);
    await core.initializeCore();
    const { newDraft } = await import(String("/src/model/draft.ts"));
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const text = [["one\r\n\r\ntwo ", "adjacent "], ["  "], ["last"]];
    const notes = [["note\r", " adjacent "], [" \t"]];
    await new LocalStore().put(
      "drafts",
      "current",
      newDraft({
        spelling: "broda",
        kind: "gismu",
        structured: true,
        text,
        notes,
      }),
    );
    return { text, notes };
  }, corePath);
  await page.goto("/new/places");
  const editor = page.getByRole("textbox", {
    name: "Definition text",
    exact: true,
  });
  await expect(editor).toBeVisible();
  const read = () =>
    page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const draft = await new LocalStore().get("drafts", "current");
      return { text: draft.text, notes: draft.notes };
    });
  expect(await read()).toEqual(original);
  await appendRichText(editor, " added");
  await expect(
    page.getByText("Saved in this browser", { exact: true }),
  ).toBeVisible();
  expect(await read()).toEqual({
    text: [["one\r\n\r\ntwo ", "adjacent "], ["  "], ["last", " added"]],
    notes: original.notes,
  });
});

test("R5 an invalid Unicode character shows a plain definition error", async ({
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
  const editor = page.getByRole("textbox", {
    name: "Definition text",
    exact: true,
  });
  await expect(editor).toBeVisible();
  await setRichNodes(editor, [["bad" + String.fromCharCode(0xd800)]]);
  await expect(
    page.getByText(
      "The definition contains an invalid Unicode character. Replace that character before publishing.",
      { exact: true },
    ),
  ).toBeVisible();
});
