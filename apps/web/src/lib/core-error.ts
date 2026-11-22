/** Checks on values thrown by the shared core. */

/**
 * True when a thrown value is the core's spelling refusal: a string that
 * parses to an object whose `code` is `"spelling"`. Anything else — another
 * core error, an `Error`, a runtime crash — is not a spelling refusal.
 */
export function isSpellingRefusal(error: unknown): boolean {
  if (typeof error !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(error);
    return (
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed as { code?: unknown }).code === "spelling"
    );
  } catch {
    return false;
  }
}

/**
 * Runs a core lookup. A spelling refusal becomes null. Every other thrown
 * value is rethrown, so real failures keep their own reporting.
 */
export function nullOnSpellingRefusal<T>(lookup: () => T): T | null {
  try {
    return lookup();
  } catch (error) {
    if (isSpellingRefusal(error)) return null;
    throw error;
  }
}
