/** Scope validation uses the same core schema as a public trust record. */
import { createEvent, wordId } from "../../../../packages/core/src/index.ts";
import type { TrustScope } from "../model/types.ts";
const probeSeed = new Uint8Array(32);
/** This disposable record stays in memory. It never uses the reader's key or leaves the browser. */
export function scopeError(scope: TrustScope): string | null {
  try {
    createEvent(
      probeSeed,
      [],
      "0".repeat(32),
      {
        kind: "trust.set",
        subject:
          "ed25519:3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29",
        scope,
        value: "heed",
      },
      null,
    );
    return null;
  } catch {
    return "Enter a word ID or a Lojban spelling. Use a lowercase BCP 47 language tag such as en.";
  }
}
/** Converts a spelling before storage and refuses malformed identifiers and language scopes. */
export function checkedScope(scope: TrustScope): TrustScope {
  const word =
    scope.word === "*" || scope.word.startsWith("jvw1:")
      ? scope.word
      : wordId({ language: "jbo", spelling: scope.word.normalize("NFC") });
  const checked = { ...scope, word };
  const error = scopeError(checked);
  if (error) throw new Error(error);
  return checked;
}
