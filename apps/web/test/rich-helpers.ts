import { expect, type Locator } from "@playwright/test";
import { placeGlyph } from "../../../packages/core/src/place-glyphs.ts";
import type { RichText } from "../src/model/types.ts";

/** Read the field's node tree without a textarea or markup projection. */
export async function richNodes(field: Locator): Promise<RichText> {
  return field.evaluate((node: any) => node.value);
}
export async function richText(field: Locator): Promise<string> {
  return (await richNodes(field))
    .map((paragraph) =>
      paragraph
        .map((node) => {
          if (typeof node === "string") return node;
          if (typeof node === "number") return placeGlyph(node);
          if ("code" in node) return node.code;
          if ("operand" in node) return `[${node.operand}]`;
          return node.label;
        })
        .join(""),
    )
    .join("\n\n");
}
export async function expectRichText(
  field: Locator,
  expected: string | RegExp,
) {
  await expect(field).toHaveAttribute("contenteditable", "true");
  if (typeof expected === "string")
    await expect.poll(() => richText(field)).toBe(expected);
  else await expect.poll(() => richText(field)).toMatch(expected);
}
export async function setRichNodes(field: Locator, value: RichText) {
  await field.evaluate((node: any, value) => {
    node.value = value;
    node.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}
/** Type paragraph breaks and inline newlines through the editor's keys. */
export async function typeRichText(field: Locator, value: string) {
  await field.fill("");
  const paragraphs = value.split("\n\n");
  for (const [index, paragraph] of paragraphs.entries()) {
    if (index) await field.press("Enter");
    for (const [line, text] of paragraph.split("\n").entries()) {
      if (line) await field.press("Shift+Enter");
      await field.pressSequentially(text);
    }
  }
}
export async function appendRichText(field: Locator, value: string) {
  await field.press("Control+End");
  await field.pressSequentially(value);
}
