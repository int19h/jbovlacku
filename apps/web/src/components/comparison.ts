/** Readable field values for revision comparisons. Exact values stay optional. */
import { el, p } from "../lib/dom.ts";
import { renderRichText, visibleJson } from "../model/richtext.ts";
import { kindLabel } from "../model/types.ts";

export const fieldLabels: Record<string, string> = {
  word: "Word",
  language: "Language",
  text: "Definition",
  frame: "Place structure",
  operands: "Operands",
  glosses: "Glosses",
  notes: "Notes",
  etymology: "Etymology",
  examples: "Examples",
  classification: "Type",
  labels: "Labels",
  sources: "Sources",
  license: "Rights",
  legacy: "Import evidence",
  type_hints: "Kind of thing",
  relation_arity: "Relation places",
  selmaho: "Selma'o",
  url: "URL",
  id: "ID",
  from: "Starting place",
  index: "Place",
  constraints: "Constraints",
  derivation: "From",
  condition: "When",
  explanation: "Explanation",
};
const label = (key: string) =>
  fieldLabels[key] ??
  key.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
const richFields = new Set([
  "text",
  "description",
  "notes",
  "condition",
  "explanation",
  "translation",
  "selection_reason",
  "note",
  "constraints",
]);
const empty = (value: unknown) =>
  value === null || value === "" || (Array.isArray(value) && !value.length);

export function readableValue(value: unknown, field: string): HTMLElement {
  if (value === undefined) return p("Not present", "meta");
  if (empty(value)) return p("Not specified", "meta");
  if (
    richFields.has(field) &&
    Array.isArray(value) &&
    value.every((paragraph) => Array.isArray(paragraph))
  ) {
    const result = renderRichText(value, { placeHref: null });
    result.classList.add("comparison-prose");
    for (const code of result.querySelectorAll("code"))
      code.before(el("span", { class: "meta", text: "Code: " }));
    return result;
  }
  if (Array.isArray(value)) {
    const list = el("ul");
    for (const item of value)
      list.append(el("li", {}, readableValue(item, field)));
    return list;
  }
  if (typeof value === "object" && value !== null) {
    const list = el("dl", { class: "comparison-details" });
    for (const [key, child] of Object.entries(value)) {
      if (empty(child)) continue;
      // Constraints are a list of rich texts, unlike a definition's paragraphs.
      const content =
        key === "constraints" && Array.isArray(child)
          ? el(
              "div",
              {},
              ...child.map((item) => readableValue(item, "constraints")),
            )
          : readableValue(child, key);
      list.append(
        el("dt", { text: key === "text" ? "Text" : label(key) }),
        el("dd", {}, content),
      );
    }
    return list.childElementCount ? list : p("Not specified", "meta");
  }
  return p(field === "kind" ? kindLabel(String(value)) : String(value));
}

export function exactValues(before: unknown, after: unknown): HTMLElement {
  return el(
    "details",
    { class: "comparison-exact" },
    el("summary", { text: "Show exact values" }),
    el("h4", { text: "Parent" }),
    el("pre", {
      class: "json",
      text: before === undefined ? "Not present" : visibleJson(before),
    }),
    el("h4", { text: "This revision" }),
    el("pre", {
      class: "json",
      text: after === undefined ? "Not present" : visibleJson(after),
    }),
  );
}
