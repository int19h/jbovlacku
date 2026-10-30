import { expect, test, type Locator, type Page } from "@playwright/test";
import { richNodes } from "./rich-helpers.ts";
import type { RichNode, RichText } from "../src/model/types.ts";

const original = "keep\r\nline\rbare\r\nexact";
const neighbor: RichText[number] = [
  "before\r\n",
  " adjacent\r",
  { code: "code\r\nexact" },
  { word: { language: "jbo", spelling: "cukta" }, label: "word\rexact" },
  { url: "https://example.org/", label: "web\r\nexact" },
];
const kinds = ["prose", "code", "word", "web"] as const;
function node(kind: (typeof kinds)[number], text: string): RichNode {
  return kind === "prose"
    ? text
    : kind === "code"
      ? { code: text }
      : kind === "word"
        ? { word: { language: "jbo", spelling: "cukta" }, label: text }
        : { url: "https://example.org/target", label: text };
}
async function mount(page: Page, value: RichText) {
  await page.goto("/");
  await page.evaluate(async (value) => {
    const { richField } = await import(String("/src/components/rich-field.ts"));
    const field = richField("Round four field", { value });
    document.body.replaceChildren(field.wrapper);
  }, value);
  return page.getByRole("textbox", { name: "Round four field", exact: true });
}
async function choose(field: Locator, offset: number, end = offset) {
  await field.focus();
  await field.evaluate(
    (field, { offset, end }) => {
      const text = field.querySelector("p")!.lastElementChild!.firstChild!;
      const range = document.createRange();
      range.setStart(text, offset);
      range.setEnd(text, end);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    },
    { offset, end },
  );
}
for (const kind of kinds) {
  for (const inserted of ["X", "漢"]) {
    test(`r4 ${kind} ${inserted === "X" ? "typing" : "composition"} normalizes only its edited node`, async ({
      page,
    }) => {
      const value: RichText = [
        [...neighbor, node(kind, original)],
        ["outer\r\n", " exact\r"],
      ];
      const field = await mount(page, value);
      const offset = original.indexOf("exact") + 3;
      await choose(field, offset);
      await page.keyboard.type(inserted);
      const changed = (
        original.slice(0, offset) +
        inserted +
        original.slice(offset)
      ).replace(/\r\n?/gu, "\n");
      await expect
        .poll(() => richNodes(field))
        .toEqual([[...neighbor, node(kind, changed)], value[1]]);
      await field.press("Control+z");
      await expect
        .poll(() => richNodes(field))
        .toEqual([
          [...neighbor, node(kind, original.replace(/\r\n?/gu, "\n"))],
          value[1],
        ]);
      await field.press("Control+Shift+z");
      await expect
        .poll(() => richNodes(field))
        .toEqual([[...neighbor, node(kind, changed)], value[1]]);
    });
  }
  test(`r4 ${kind} paste deletion and newline edits normalize only their node`, async ({
    page,
  }) => {
    const value: RichText = [[...neighbor, node(kind, original)]];
    const field = await mount(page, value);
    const offset = original.indexOf("exact") + 3;
    await choose(field, offset);
    await field.evaluate((field) => {
      const transfer = new DataTransfer();
      transfer.setData("text/plain", "P\r\nQ");
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "clipboardData", { value: transfer });
      field.dispatchEvent(event);
    });
    let changed = (
      original.slice(0, offset) +
      "P\nQ" +
      original.slice(offset)
    ).replace(/\r\n?/gu, "\n");
    expect(await richNodes(field)).toEqual([
      [...neighbor, node(kind, changed)],
    ]);
    await field.press("Control+z");
    expect(await richNodes(field)).toEqual([
      [...neighbor, node(kind, original.replace(/\r\n?/gu, "\n"))],
    ]);
    await mount(page, value);
    await choose(field, offset);
    await page.keyboard.press("Backspace");
    changed = (original.slice(0, offset - 1) + original.slice(offset)).replace(
      /\r\n?/gu,
      "\n",
    );
    expect(await richNodes(field)).toEqual([
      [...neighbor, node(kind, changed)],
    ]);
    await field.press("Control+z");
    expect(await richNodes(field)).toEqual([
      [...neighbor, node(kind, original.replace(/\r\n?/gu, "\n"))],
    ]);
    await mount(page, value);
    await choose(field, offset);
    await page.keyboard.press("Shift+Enter");
    changed = (
      original.slice(0, offset) +
      "\n" +
      original.slice(offset)
    ).replace(/\r\n?/gu, "\n");
    expect(await richNodes(field)).toEqual([
      [...neighbor, node(kind, changed)],
    ]);
  });
}

test("r4 an untouched field keeps blank paragraphs on save and publication", async ({
  page,
}) => {
  await page.goto("/");
  const exact = await page.evaluate(async () => {
    const { newDraft } = await import(String("/src/model/draft.ts"));
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const draft = newDraft({ spelling: "broda", kind: "gismu", step: 4 });
    draft.text = [["first\r\n", " adjacent\r"], [" \t"], ["last"]];
    draft.notes = [["note\r\n", " adjacent\r"], [" \t"]];
    await new LocalStore().put("drafts", "current", draft);
    return { text: draft.text, notes: draft.notes };
  });
  await page.goto("/new/editor");
  const field = page.getByRole("textbox", {
    name: "Definition text",
    exact: true,
  });
  await expect(field).toBeVisible();
  await page.getByLabel("Headword", { exact: true }).fill("brode");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        const { draftToBody } = await import(String("/src/model/draft.ts"));
        const draft = await new LocalStore().get("drafts", "current");
        const { body } = draftToBody(draft);
        return {
          spelling: draft.spelling,
          saved: { text: draft.text, notes: draft.notes },
          published: { text: body?.text, notes: body?.notes },
        };
      }),
    )
    .toEqual({ spelling: "brode", saved: exact, published: exact });
  await field.press("Control+End");
  await field.pressSequentially("X");
  expect(await richNodes(field)).toEqual([exact.text[0], ["lastX"]]);
});

for (const kind of ["word", "web"] as const) {
  test(`r4 ${kind} target-only changes preserve the exact label`, async ({
    page,
  }) => {
    const field = await mount(page, [[...neighbor, node(kind, original)]]);
    await choose(field, original.indexOf("exact"));
    await page.getByRole("button", { name: "Edit link", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Edit link", exact: true });
    await dialog
      .getByLabel(kind === "word" ? "Lojban word" : "HTTPS address", {
        exact: true,
      })
      .fill(kind === "word" ? "klama" : "https://example.org/changed");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    const changed =
      kind === "word"
        ? { word: { language: "jbo", spelling: "klama" }, label: original }
        : { url: "https://example.org/changed", label: original };
    expect(await richNodes(field)).toEqual([[...neighbor, changed]]);
  });
}
