/** Readable field values for revision comparisons. Exact values stay optional. */
import { el, p, button } from "../lib/dom.ts";
import { renderRichText, visibleJson, visibleText } from "../model/richtext.ts";
import { sameValue, changedItems } from "../model/comparison.ts";
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
  visibleText(key.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase()));
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
    const walker = document.createTreeWalker(result, NodeFilter.SHOW_TEXT);
    while (walker.nextNode())
      walker.currentNode.textContent = visibleText(
        walker.currentNode.textContent ?? "",
      );
    for (const node of result.querySelectorAll<HTMLElement>("[title]"))
      node.title = visibleText(node.title);
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
  return p(
    visibleText(field === "kind" ? kindLabel(String(value)) : String(value)),
  );
}

interface Change {
  field: string;
  path: string[];
  before: unknown;
  after: unknown;
}
/** Align nested lists and expose only changed children of structured fields. */
function changes(
  before: unknown,
  after: unknown,
  field: string,
  path: string[] = [],
): Change[] {
  if (sameValue(before, after)) return [];
  const rich = richFields.has(field) && field !== "constraints";
  if (!rich && Array.isArray(before) && Array.isArray(after))
    return changedItems(before, after).map(([left, right]) => ({
      field,
      path,
      before: left,
      after: right,
    }));
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object" &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const left = before as Record<string, unknown>,
      right = after as Record<string, unknown>;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap(
      (key) => changes(left[key], right[key], key, [...path, label(key)]),
    );
  }
  return [{ field, path, before, after }];
}

export function changedValues(
  before: unknown,
  after: unknown,
  field: string,
): HTMLElement {
  const container = el("div");
  const items = changes(before, after, field);
  let shown = 0;
  const more = button("", () => appendBatch(true), { class: "btn btn-quiet" });
  const appendBatch = (focus = false) => {
    more.remove();
    let first: HTMLElement | undefined;
    for (const item of items.slice(shown, shown + 50)) {
      if (item.path.length)
        container.append(el("h4", { text: item.path.join(" · ") }));
      const oldValue = readableValue(item.before, item.field),
        newValue = readableValue(item.after, item.field);
      const pair = el(
        "div",
        { class: "comparison-pair", tabindex: "-1" },
        el("div", {}, el("h4", { text: "Parent" }), oldValue),
        el("div", {}, el("h4", { text: "This revision" }), newValue),
      );
      first ??= pair;
      container.append(pair);
      if (oldValue.textContent === newValue.textContent)
        container.append(
          p(
            "The structured values differ. Open Show exact values to inspect the difference.",
            "meta",
          ),
        );
      container.append(exactValues(item.before, item.after));
    }
    shown = Math.min(shown + 50, items.length);
    if (shown < items.length) {
      more.textContent = `${items.length - shown} more changes. Show the next 50`;
      container.append(more);
    }
    if (focus) first?.focus();
  };
  appendBatch();
  return container;
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
