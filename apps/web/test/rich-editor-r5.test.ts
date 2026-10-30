import { expect, test, type Locator, type Page } from "@playwright/test";
import { richNodes } from "./rich-helpers.ts";
import type { RichNode, RichText } from "../src/model/types.ts";

const kinds = ["prose", "code", "word", "web"] as const;
type Kind = (typeof kinds)[number];
const selector = ".rich-literal,.rich-code,.rich-word-link,.rich-web-link";
function node(kind: Kind, text: string): RichNode {
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
    const field = richField("Round five field", { value });
    document.body.replaceChildren(field.wrapper);
    field.input.addEventListener("keydown", (event) => {
      (window as any).r5KeyHandled = event.defaultPrevented;
    });
  }, value);
  return page.getByRole("textbox", { name: "Round five field", exact: true });
}
/** Place the native caret inside the saved inline node, not its paragraph. */
async function choose(
  field: Locator,
  paragraph: number,
  inline: number,
  text: string,
  offset: number,
) {
  await field.focus();
  const selected = await field.evaluate(
    (field, { paragraph, inline, selector, offset }) => {
      const target = field
        .querySelectorAll("p")
        [paragraph].querySelectorAll(selector)[inline].firstChild!;
      const range = document.createRange();
      range.setStart(target, offset);
      range.collapse(true);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return {
        text: selection.anchorNode?.textContent,
        type: selection.anchorNode?.nodeType,
        offset: selection.anchorOffset,
        collapsed: selection.isCollapsed,
      };
    },
    { paragraph, inline, selector, offset },
  );
  expect(selected).toEqual({ text, type: 3, offset, collapsed: true });
}

for (const [ending, lineBreak] of [
  ["LF", "\n"],
  ["CRLF", "\r\n"],
] as const) {
  for (const key of ["Backspace", "Delete"] as const) {
    for (const kind of kinds) {
      test(`r5 ${key} joins saved ${ending} prose after ${kind}`, async ({
        page,
      }) => {
        const prefix: RichNode[] = [
          "left\r\n",
          " adjacent\r",
          node(kind, "keep\r\n"),
        ];
        // Keep a nonprose boundary before the prose that the join edits.
        if (kind === "prose") prefix.push({ code: "guard\r" });
        const suffix: RichNode[] = [{ code: "right\r\n" }, " tail\r"];
        const outside: RichText[number] = ["outer\r\n", " exact\r"];
        const raw = `cd${lineBreak}ef`;
        const value: RichText = [[...prefix, "ab"], [raw, ...suffix], outside];
        const field = await mount(page, value);
        expect(await richNodes(field)).toEqual(value);
        if (key === "Backspace") await choose(field, 1, 0, raw, 0);
        else await choose(field, 0, prefix.length, "ab", 2);
        await page.keyboard.press(key);
        const joined: RichText = [[...prefix, "abcd\nef", ...suffix], outside];
        await expect.poll(() => richNodes(field)).toEqual(joined);
        expect(await page.evaluate(() => (window as any).r5KeyHandled)).toBe(
          true,
        );
        await field.press("Control+z");
        await expect
          .poll(() => richNodes(field))
          .toEqual([[...prefix, "ab"], ["cd\nef", ...suffix], outside]);
        await field.press("Control+Shift+z");
        await expect.poll(() => richNodes(field)).toEqual(joined);
      });
    }
    for (const kind of kinds.filter((kind) => kind !== "prose")) {
      test(`r5 ${key} joins saved ${ending} prose directly after ${kind}`, async ({
        page,
      }) => {
        const raw = `cd${lineBreak}ef`;
        const left: RichNode[] = ["left\r\n", node(kind, "ab")];
        const right: RichNode[] = [raw, { code: "guard\r" }, " tail\r\n"];
        const outside: RichText[number] = ["outer\r\n", " exact\r"];
        const value: RichText = [left, right, outside];
        const field = await mount(page, value);
        expect(await richNodes(field)).toEqual(value);
        if (key === "Backspace") await choose(field, 1, 0, raw, 0);
        else await choose(field, 0, 1, "ab", 2);
        await page.keyboard.press(key);
        await expect
          .poll(() => richNodes(field))
          .toEqual([[...left, ...right], outside]);
        expect(await page.evaluate(() => (window as any).r5KeyHandled)).toBe(
          true,
        );
        await field.press("Control+z");
        await expect.poll(() => richNodes(field)).toEqual(value);
        await field.press("Control+Shift+z");
        await expect
          .poll(() => richNodes(field))
          .toEqual([[...left, ...right], outside]);
      });
      test(`r5 ${key} joins at saved ${ending} ${kind} boundary`, async ({
        page,
      }) => {
        const raw = `cd${lineBreak}ef`;
        const left: RichNode[] = ["left\r\n", { code: "guard\r" }, "ab"];
        const right: RichNode[] = [node(kind, raw), " tail\r\n"];
        const outside: RichText[number] = ["outer\r\n", " exact\r"];
        const value: RichText = [left, right, outside];
        const field = await mount(page, value);
        expect(await richNodes(field)).toEqual(value);
        if (key === "Backspace") await choose(field, 1, 0, raw, 0);
        else await choose(field, 0, 2, "ab", 2);
        await page.keyboard.press(key);
        // Moving an unchanged code or link node does not edit its stored text.
        await expect
          .poll(() => richNodes(field))
          .toEqual([[...left, ...right], outside]);
        expect(await page.evaluate(() => (window as any).r5KeyHandled)).toBe(
          true,
        );
        await field.press("Control+z");
        await expect.poll(() => richNodes(field)).toEqual(value);
        await field.press("Control+Shift+z");
        await expect
          .poll(() => richNodes(field))
          .toEqual([[...left, ...right], outside]);
      });
    }
  }
}

for (const kind of kinds) {
  for (const key of ["Backspace", "Delete"] as const) {
    test(`r5 ${key} handles the document edge inside ${kind}`, async ({
      page,
    }) => {
      const raw = "ab\r\ncd";
      const value: RichText = [[node(kind, raw)]];
      const field = await mount(page, value);
      await choose(field, 0, 0, raw, key === "Backspace" ? 0 : raw.length);
      await page.keyboard.press(key);
      expect(await page.evaluate(() => (window as any).r5KeyHandled)).toBe(
        true,
      );
      expect(await richNodes(field)).toEqual(value);
    });
  }
}
