/**
 * Fast conservative word-spelling check backed by a range table generated
 * from jvc-core's pinned Unicode normalization and accent rules.
 *
 * Returns:
 * - "valid": guaranteed to pass core wordId spelling validation.
 * - "invalid": guaranteed to fail core wordId spelling validation.
 * - "check": contains a character outside the table; ask the core.
 */
import { OUTSIDE_SAFE_BMP_SPELLING } from "./word-spelling-ranges.ts";

export type WordSpellingStatus = "valid" | "invalid" | "check";

export function wordSpellingStatus(spelling: string): WordSpellingStatus {
  const len = spelling.length;
  if (!len || len > 256) return "invalid";
  if (spelling.charCodeAt(0) === 32 || spelling.charCodeAt(len - 1) === 32)
    return "invalid";
  let nonAscii = 0;
  for (let i = 0; i < len; i++) {
    const code = spelling.charCodeAt(i);
    nonAscii |= (code - 32) | (126 - code);
  }
  if (nonAscii >= 0) return "valid";
  if (OUTSIDE_SAFE_BMP_SPELLING.test(spelling)) return "check";
  // Every character in the safe BMP table occupies at most 3 UTF-8 bytes, so
  // up to 85 units always fit within the 256-byte core limit (85 * 3 = 255).
  if (len <= 85) return "valid";
  let bytes = len;
  for (let i = 0; i < len; i++) {
    const code = spelling.charCodeAt(i);
    if (code > 127) bytes += code > 2047 ? 2 : 1;
  }
  return bytes <= 256 ? "valid" : "invalid";
}
