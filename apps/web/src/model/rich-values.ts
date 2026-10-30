/** Small rich-text helpers that reading pages can load without the editor. */
import type { RichText } from "./types.ts";

/** Import old string fields with their original plain-text whitespace rules. */
export function richValue(value: RichText | string | undefined): RichText {
  return typeof value === "string"
    ? value
        .split(/\n\s*\n/u)
        .map((part) => part.replace(/\s+$/u, ""))
        .filter(Boolean)
        .map((part) => [part])
    : (value ?? []);
}

/** Stored whitespace stays exact, but it does not supply visible content. */
export function richHasContent(value: RichText): boolean {
  return value.some((paragraph) =>
    paragraph.some((node) =>
      typeof node === "string" ? node.trim().length > 0 : true,
    ),
  );
}

/** Edited fields omit blank paragraphs. Nonblank nodes stay exact. */
export function canonicalRich(value: RichText): RichText {
  const paragraphs = value.filter((paragraph) => richHasContent([paragraph]));
  return paragraphs.length === value.length ? value : paragraphs;
}

/** Replaced fields clean blank paragraphs and normalize only changed text. */
export function editedRich(value: RichText, previous: RichText = []): RichText {
  const oldNodes = previous.flat();
  return canonicalRich(
    value.map((paragraph) =>
      paragraph.map((node) => {
        if (typeof node === "string")
          return oldNodes.includes(node) ? node : node.replace(/\r\n?/gu, "\n");
        if (typeof node === "number" || "operand" in node) return node;
        const field = "code" in node ? "code" : "label";
        const text = "code" in node ? node.code : node.label;
        if (typeof text !== "string") return node;
        if (
          oldNodes.some(
            (old) =>
              old &&
              typeof old === "object" &&
              ("code" in node
                ? "code" in old && old.code === text
                : "word" in node
                  ? "word" in old && old.label === text
                  : "url" in old && old.label === text),
          )
        )
          return node;
        return { ...node, [field]: text.replace(/\r\n?/gu, "\n") };
      }),
    ),
  );
}

const richFields = new Set([
  "text",
  "notes",
  "note",
  "description",
  "condition",
  "explanation",
  "translation",
  "rationale",
  "selection_reason",
  "constraints",
  "frameConstraints",
  "etymologyText",
  "formNotes",
]);
const richContainers = new Set([
  "frame",
  "places",
  "tail",
  "hint",
  "type_hints",
  "defaults",
  "derivation",
  "derivations",
  "operands",
  "examples",
  "etymology",
  "formation",
  "sources",
  "rafsiClaims",
  "gismu",
  "rows",
]);
/** Normalize accepted changes. Inference logs and proposal evidence stay exact. */
export function canonicalRichFields<T>(
  value: T,
  previous?: T,
  rich = false,
): T {
  if (Array.isArray(value)) {
    if (
      rich &&
      value.every(
        (paragraph) =>
          Array.isArray(paragraph) &&
          paragraph.every(
            (node) =>
              typeof node === "string" ||
              typeof node === "number" ||
              (node !== null &&
                typeof node === "object" &&
                !Array.isArray(node)),
          ),
      )
    )
      return JSON.stringify(value) === JSON.stringify(previous)
        ? value
        : (editedRich(
            value as RichText,
            Array.isArray(previous) ? (previous as RichText) : [],
          ) as T);
    const oldItems = Array.isArray(previous) ? previous : [];
    const items = value.map((item, index) => {
      const exact = oldItems.find(
        (old) => JSON.stringify(old) === JSON.stringify(item),
      );
      const key =
        item && typeof item === "object"
          ? Object.hasOwn(item, "id")
            ? "id"
            : Object.hasOwn(item, "index")
              ? "index"
              : null
          : null;
      const old =
        exact ??
        (key
          ? oldItems.find(
              (old) => old && typeof old === "object" && old[key] === item[key],
            )
          : oldItems[index]);
      return canonicalRichFields(item, old, rich);
    });
    return items.every((item, index) => item === value[index])
      ? value
      : (items as T);
  }
  if (value === null || typeof value !== "object") return value;
  let changed = false;
  const fields = Object.entries(value).map(([key, original]) => {
    const before =
      previous && typeof previous === "object"
        ? (previous as Record<string, unknown>)[key]
        : undefined;
    const next = richFields.has(key)
      ? canonicalRichFields(original, before, true)
      : richContainers.has(key)
        ? canonicalRichFields(original, before)
        : original;
    changed ||= next !== original;
    return [key, next];
  });
  return changed ? (Object.fromEntries(fields) as T) : value;
}
