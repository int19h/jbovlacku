/**
 * Shared rich-text rendering and the editor's text conventions.
 * Rendering never evaluates markup. Every string renders inside a bidi isolate.
 */
import { el, link, sr, text } from "../lib/dom.ts";
import { placeGlyph } from "../lib/format.ts";
import type { RichNode, RichText } from "./types.ts";

const DIRECTION_CONTROLS = /[‪-‮⁦-⁩]/u;
export interface RenderOptions {
  language?: string;
  /** Where place markers link. Null renders markers without links. */
  placeHref?: ((index: number) => string) | null;
  /** Query terms to highlight in string nodes. */
  highlight?: string | null;
  /** Element for paragraphs. */
  paragraph?: "p" | "span" | "div";
  className?: string;
}
export function isRichText(value: unknown): value is RichText {
  return (
    Array.isArray(value) && value.every((paragraph) => Array.isArray(paragraph))
  );
}
/** A place marker element. Its accessible name is "place N". */
export function placeMarker(index: number, href: string | null): HTMLElement {
  const node = href ? link(null, href) : el("span");
  node.className = index > 20 ? "pl badge" : "pl";
  node.append(sr("place "), text(String(index)));
  node.setAttribute("aria-label", `place ${index}`);
  if (!href) node.setAttribute("role", "img");
  node.querySelector("span:last-child")!.setAttribute("aria-hidden", "true");
  return node;
}
function highlighted(value: string, query: string | null | undefined): Node[] {
  if (!query) return [text(value)];
  const lower = value.toLocaleLowerCase("en");
  const needle = query.toLocaleLowerCase("en");
  if (!needle) return [text(value)];
  const nodes: Node[] = [];
  let index = 0;
  for (;;) {
    const found = lower.indexOf(needle, index);
    if (found === -1) break;
    if (found > index)
      nodes.push(document.createTextNode(value.slice(index, found)));
    nodes.push(el("mark", { text: value.slice(found, found + needle.length) }));
    index = found + needle.length;
  }
  if (index < value.length)
    nodes.push(document.createTextNode(value.slice(index)));
  return nodes;
}
export function renderInline(
  node: RichNode,
  options: RenderOptions,
): Node | null {
  if (typeof node === "string") {
    const span = el("bdi");
    for (const part of highlighted(node, options.highlight)) span.append(part);
    if (DIRECTION_CONTROLS.test(node)) {
      span.className = "direction-warning";
      span.title = "This text contains invisible direction controls.";
    }
    return span;
  }
  if (typeof node === "number") {
    if (!Number.isInteger(node) || node < 1) return null;
    return placeMarker(
      node,
      options.placeHref === null
        ? null
        : (options.placeHref ?? ((n) => `#place-${n}`))(node),
    );
  }
  if (node && typeof node === "object") {
    if ("code" in node && typeof node.code === "string")
      return el("code", { text: node.code, lang: "jbo" });
    if ("operand" in node && typeof node.operand === "string")
      return el("bdi", { class: "operand", text: `[${node.operand}]` });
    if (
      "word" in node &&
      node.word?.language === "jbo" &&
      typeof node.word.spelling === "string"
    ) {
      const label = String(node.label ?? node.word.spelling);
      const anchor = link(
        el("bdi", { text: label }),
        `/word/${encodeURIComponent(node.word.spelling)}`,
      );
      anchor.lang = "jbo";
      anchor.title = node.word.spelling;
      return anchor;
    }
    if ("url" in node && typeof node.url === "string") {
      try {
        const url = new URL(node.url);
        if (url.protocol === "https:") {
          const anchor = link(
            `${String(node.label ?? url.href)} (${url.host})`,
            url.href,
            {
              rel: "noopener noreferrer",
              target: "_blank",
            },
          );
          anchor.title = url.href;
          return anchor;
        }
      } catch {}
      return el("bdi", { text: String(node.label ?? node.url) });
    }
  }
  return null;
}
/** Renders rich text. Each paragraph becomes one element. */
export function renderRichText(
  value: unknown,
  options: RenderOptions = {},
): HTMLElement {
  const container = el("div", { class: options.className });
  if (options.language) container.lang = options.language;
  if (!isRichText(value)) return container;
  for (const paragraph of value) {
    const row = el(options.paragraph ?? "p");
    for (const node of paragraph) {
      const rendered = renderInline(node, options);
      if (rendered) row.append(rendered);
    }
    container.append(row);
  }
  return container;
}
/** Plain text of rich text for titles and summaries. Places become circled numerals. */
export function plainText(value: unknown): string {
  if (!isRichText(value)) return "";
  return value
    .map((paragraph) =>
      paragraph
        .map((node) => {
          if (typeof node === "string") return node;
          if (typeof node === "number") return placeGlyph(node);
          if (node && typeof node === "object") {
            if ("label" in node && typeof node.label === "string")
              return node.label;
            if ("code" in node) return node.code;
            if ("operand" in node) return `[${node.operand}]`;
          }
          return "";
        })
        .join(""),
    )
    .join("\n");
}
/** Escapes control and direction characters for source views. */
export function visibleJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/gu,
    (c) =>
      c === "\n" ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
export const CIRCLED = /([①-⑳])/u;
/**
 * Editor text to rich text. In structured mode, circled numerals ① through ⑳
 * become integer place nodes. In literal mode they stay text.
 * Paragraphs split on blank lines.
 */
export function textToRichText(source: string, structured: boolean): RichText {
  const paragraphs = source
    .split(/\n\s*\n/)
    .map((s) => s.replace(/\s+$/u, ""))
    .filter((s) => s.length);
  return paragraphs.map((paragraph) => {
    if (!structured) return [paragraph];
    const nodes: RichNode[] = [];
    for (const fragment of paragraph.split(CIRCLED)) {
      if (!fragment) continue;
      const code = fragment.codePointAt(0)! - 0x245f;
      if (fragment.length === 1 && code >= 1 && code <= 20) nodes.push(code);
      else nodes.push(fragment);
    }
    return nodes;
  });
}
/** Rich text back to editor text. Integer nodes become circled numerals or an explicit token. */
export function richTextToText(value: RichText): string {
  return value
    .map((paragraph) =>
      paragraph
        .map((node) => {
          if (typeof node === "string") return node;
          if (typeof node === "number")
            return node <= 20 ? placeGlyph(node) : `{place ${node}}`;
          if ("label" in node && typeof node.label === "string")
            return node.label;
          if ("code" in node) return node.code;
          if ("operand" in node) return `[${node.operand}]`;
          return "";
        })
        .join(""),
    )
    .join("\n\n");
}
/** Place indices referenced by rich text. */
export function referencedPlaces(value: RichText): Set<number> {
  const result = new Set<number>();
  for (const paragraph of value)
    for (const node of paragraph)
      if (typeof node === "number") result.add(node);
  return result;
}
/** Counts inline nodes, for the 8,192 node limit. */
export function countNodes(value: RichText): number {
  return value.reduce((sum, paragraph) => sum + paragraph.length, 0);
}
