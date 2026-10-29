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
