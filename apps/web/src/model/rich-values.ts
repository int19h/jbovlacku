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

/** Live blank lines have no stored paragraph. Nonblank nodes stay exact. */
export function canonicalRich(value: RichText): RichText {
  const paragraphs = value.filter((paragraph) => richHasContent([paragraph]));
  return paragraphs.length === value.length ? value : paragraphs;
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
/** Normalize authored fields. Inference logs and proposal evidence stay exact. */
export function canonicalRichFields<T>(value: T, rich = false): T {
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
      return canonicalRich(value as RichText) as T;
    const items = value.map((item) => canonicalRichFields(item, rich));
    return items.every((item, index) => item === value[index])
      ? value
      : (items as T);
  }
  if (value === null || typeof value !== "object") return value;
  let changed = false;
  const fields = Object.entries(value).map(([key, original]) => {
    const next = richFields.has(key)
      ? canonicalRichFields(original, true)
      : richContainers.has(key)
        ? canonicalRichFields(original)
        : original;
    changed ||= next !== original;
    return [key, next];
  });
  return changed ? (Object.fromEntries(fields) as T) : value;
}
