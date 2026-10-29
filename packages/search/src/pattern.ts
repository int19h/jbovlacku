import { createSearchPattern } from "../../core/src/index.ts";
import { stripAcuteAccents } from "../../morphology/src/index.ts";

export const PATTERN_BYTE_LIMIT = 256;
export const PATTERN_WORKER_TIMEOUT_MS = 1000;
export const PATTERN_TIMEOUT_MESSAGE =
  "Pattern search reached its time or work limit. Use a shorter or more specific pattern.";
export class PatternError extends Error {
  readonly status: number;
  constructor(
    public code: "pattern_invalid" | "pattern_timeout",
    message: string,
  ) {
    super(message);
    this.status = code === "pattern_invalid" ? 400 : 422;
  }
}
export const isPatternQuery = (query: string) =>
  query.trim().startsWith("/") || /[*?@$]/u.test(query);
export const patternKey = (value: string) =>
  stripAcuteAccents(value.normalize("NFC"))
    .toLocaleLowerCase("en")
    .replaceAll("’", "'")
    .replaceAll("h", "'");

/** Preserve regexp syntax. Rust rewrites only literal nodes after parsing it. */
export function patternSource(query: string): string {
  const raw = query.trim().normalize("NFC");
  if (new TextEncoder().encode(raw).length > PATTERN_BYTE_LIMIT)
    throw new PatternError(
      "pattern_invalid",
      "Patterns permit at most 256 UTF-8 bytes. Use a shorter pattern.",
    );
  if (raw.startsWith("/")) {
    if (raw.length < 3 || !raw.endsWith("/"))
      throw new PatternError(
        "pattern_invalid",
        "Write a regular expression as /.../ with a nonempty body.",
      );
    return raw.slice(1, -1);
  }
  const value = patternKey(raw);
  if (!value || /[^a-z0-9'*?@$]/u.test(value))
    throw new PatternError(
      "pattern_invalid",
      "The glob contains an unsupported character. Use letters, apostrophes, digits, *, ?, @, or $.",
    );
  let source = "\\A";
  for (const letter of value)
    source +=
      letter === "*"
        ? "[a-z']*"
        : letter === "?"
          ? "[a-z']"
          : letter === "@"
            ? "[aeiouy]"
            : letter === "$"
              ? "[bcdfgjklmnprstvxz]"
              : letter;
  return source + "\\z";
}
export function compilePattern(query: string) {
  try {
    const compiled = createSearchPattern(patternSource(query));
    return {
      test(spelling: string): boolean {
        try {
          return compiled.is_match(patternKey(spelling));
        } catch (error) {
          if (String(error) !== "pattern_timeout") throw error;
          throw new PatternError("pattern_timeout", PATTERN_TIMEOUT_MESSAGE);
        }
      },
      free: () => compiled.free(),
    };
  } catch (error) {
    if (error instanceof PatternError) throw error;
    if (String(error) !== "pattern_invalid") throw error;
    throw new PatternError(
      "pattern_invalid",
      "The regular expression is invalid or exceeds its compilation limit. Use a simpler pattern.",
    );
  }
}
