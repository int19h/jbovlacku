// Preserve the pinned Rust recognizer for existing morphology versions.
// Branch order and cache charges form part of the compatibility contract.
import { isInitialPair, isPermissiblePair } from "./phonotactics.ts";
import { resource } from "./errors.ts";

type Chars = readonly string[];
type PartRange = { start: number; end: number };
type HeadPolicy = "standard" | "experimental-cgv";
export type Kind =
  | "gismu"
  | "lujvo"
  | "fuhivla"
  | "cmavo"
  | "cmevla"
  | "unknown";
export interface Reading {
  kind: Kind;
  tokens: string[];
}
export type WordReading = Reading;
export const MAX_WORD_BYTES = 128;
const WORK_LIMIT = 50_000;

class LujvoRecognitionCache {
  experimental = false;
  remaining = WORK_LIMIT;
  spent = 0;
  exhausted = false;
  private readonly results = new Map<string, boolean>();
  charge(): boolean {
    if (this.remaining === 0) {
      this.exhausted = true;
      return false;
    }
    this.remaining -= 1;
    this.spent += 1;
    return true;
  }
  lujvo_from(
    index: number,
    end: number,
    has_initial: boolean,
  ): boolean | undefined {
    return this.results.get(`${end},${index},${Number(has_initial)}`);
  }
  record_lujvo_from(
    index: number,
    end: number,
    has_initial: boolean,
    result: boolean,
  ): void {
    this.results.set(`${end},${index},${Number(has_initial)}`, result);
  }
}

function parse_cmavo_form_chars(chars: Chars): string | undefined {
  if (chars.length === 0) return undefined;
  if (chars.every(is_y)) return chars.join("");
  if (chars.length === 1 && is_digit(chars[0])) return digit_to_cmavo(chars[0]);
  if (chars[0] === "'" || starts_with_cluster(chars, 0)) return undefined;
  for (const onset of parse_onsets(chars, 0)) {
    const tail = parse_cmavo_form_tail(chars, onset.end);
    if (tail !== undefined) return onset.normalized + tail;
  }
  return undefined;
}
function parse_cmavo_form_tail(
  chars: Chars,
  start: number,
): string | undefined {
  const diphthong = parse_diphthong_end(chars, start);
  if (diphthong !== undefined) {
    const [semivowel, after] = diphthong;
    const nucleus = normalize_vowel(chars[start]) + semivowel;
    if (after === chars.length) return nucleus;
    if (chars[after] === "'") {
      const tail = parse_cmavo_form_tail(chars, after + 1);
      if (tail !== undefined) return nucleus + "'" + tail;
    }
  }
  const after = parse_single_vowel_end(chars, start);
  if (after !== undefined) {
    const nucleus = is_y(chars[start])
      ? chars[start]
      : normalize_vowel(chars[start]);
    if (after === chars.length) return nucleus;
    if (chars[after] === "'") {
      const tail = parse_cmavo_form_tail(chars, after + 1);
      if (tail !== undefined) return nucleus + "'" + tail;
    }
  }
  return undefined;
}
function parse_onsets(
  chars: Chars,
  start: number,
): { end: number; normalized: string }[] {
  const onsets: { end: number; normalized: string }[] = [];
  const glide = parse_glide_end(chars, start);
  if (glide !== undefined)
    onsets.push({
      end: glide,
      normalized: "iíĭ".includes(chars[start]) ? "ĭ" : "ŭ",
    });
  for (let end = max_initial_end(chars, start); end >= start; end -= 1) {
    if (parse_initial_end(chars, start, end) !== undefined)
      onsets.push({ end, normalized: chars.slice(start, end).join("") });
  }
  return onsets;
}
function max_initial_end(chars: Chars, start: number): number {
  return Math.min(chars.length, start + 3);
}
function append_parse_onset_ends(
  chars: Chars,
  start: number,
  ends: number[],
): void {
  const glide = parse_glide_end(chars, start);
  if (glide !== undefined) ends.push(glide);
  for (let end = max_initial_end(chars, start); end >= start; end -= 1) {
    if (parse_initial_end(chars, start, end) !== undefined) ends.push(end);
  }
}
function has_parse_onset_end(
  chars: Chars,
  start: number,
  target: number,
): boolean {
  return (
    parse_glide_end(chars, start) === target ||
    (target >= start &&
      target <= max_initial_end(chars, start) &&
      parse_initial_end(chars, start, target) !== undefined)
  );
}
function has_parse_onset(chars: Chars, start: number): boolean {
  if (parse_glide_end(chars, start) !== undefined) return true;
  for (let end = max_initial_end(chars, start); end >= start; end -= 1) {
    if (parse_initial_end(chars, start, end) !== undefined) return true;
  }
  return false;
}
function parse_initial_end(
  chars: Chars,
  start: number,
  end: number,
): number | undefined {
  if (!valid_initial_shape(chars, start, end)) return undefined;
  if (
    end < chars.length &&
    (is_consonant(chars[end]) || starts_glide(chars, end))
  )
    return undefined;
  return end;
}
function valid_initial_shape(
  chars: Chars,
  start: number,
  end: number,
): boolean {
  switch (end - start) {
    case 0:
      return true;
    case 1:
      return is_consonant(chars[start]);
    case 2:
      return isInitialPair(chars[start], chars[start + 1]);
    case 3:
      return valid_three_consonant_initial(chars, start);
    default:
      return false;
  }
}
function append_parse_nucleus_ends(
  chars: Chars,
  start: number,
  ends: number[],
): void {
  const diphthong = parse_diphthong_end(chars, start);
  if (diphthong !== undefined) ends.push(diphthong[1]);
  const single = parse_single_vowel_end(chars, start);
  if (single !== undefined) ends.push(single);
}
function has_parse_nucleus_end(
  chars: Chars,
  start: number,
  target: number,
): boolean {
  return (
    parse_diphthong_end(chars, start)?.[1] === target ||
    parse_single_vowel_end(chars, start) === target
  );
}
function has_parse_nucleus_end_at_or_before(
  chars: Chars,
  start: number,
  limit: number,
): boolean {
  const diphthong = parse_diphthong_end(chars, start);
  const single = parse_single_vowel_end(chars, start);
  return (
    (diphthong !== undefined && diphthong[1] <= limit) ||
    (single !== undefined && single <= limit)
  );
}
function parse_diphthong_end(
  chars: Chars,
  start: number,
): [string, number] | undefined {
  const raw = raw_diphthong_end(chars, start);
  if (raw === undefined) return undefined;
  const [semivowel, end] = raw;
  const next = next_non_comma_index(chars, end);
  if (next !== undefined && matches_diphthong_semivowel(chars[next], semivowel))
    return undefined;
  if (starts_with_nucleus(chars, end)) return undefined;
  return [semivowel, end];
}
function matches_diphthong_semivowel(
  value: string,
  semivowel: string,
): boolean {
  return semivowel === "ĭ"
    ? is_one(value, "iíĭ")
    : semivowel === "ŭ" && is_one(value, "uúŭ");
}
function parse_single_vowel_end(
  chars: Chars,
  start: number,
): number | undefined {
  const value = chars[start];
  if (value === undefined) return undefined;
  if (!is_y(value) && !is_vowel(value) && !is_one(value, "ĭŭ"))
    return undefined;
  const end = start + 1;
  return starts_with_nucleus(chars, end) ? undefined : end;
}
function parse_glide_end(chars: Chars, start: number): number | undefined {
  return starts_glide(chars, start) ? start + 1 : undefined;
}
function starts_with_nucleus(chars: Chars, start: number): boolean {
  return (
    start < chars.length &&
    (parse_diphthong_end(chars, start) !== undefined ||
      parse_single_vowel_end(chars, start) !== undefined)
  );
}
function starts_with_cluster(chars: Chars, start: number): boolean {
  return is_consonant(chars[start]) && is_consonant(chars[start + 1]);
}
function blocks_word_shape(chars: Chars, allow_mz: boolean): boolean {
  return (
    has_invalid_apostrophe(chars) ||
    has_digit_followed_by_nucleus(chars) ||
    has_geminated_consonant(chars) ||
    has_y_hiatus(chars) ||
    has_vowel_hiatus(chars) ||
    has_voicing_mismatch(chars) ||
    has_forbidden_consonant_triple(chars) ||
    has_forbidden_consonant_pair(chars, allow_mz)
  );
}
function has_invalid_apostrophe(chars: Chars): boolean {
  return chars.some(
    (value, index) =>
      value === "'" &&
      (!can_precede_apostrophe(previous_non_comma(chars, index)?.[1]) ||
        !starts_with_nucleus(chars, index + 1)),
  );
}
function can_precede_apostrophe(value: string | undefined): boolean {
  return is_vowel(value) || is_y(value) || is_one(value, "ĭŭ");
}
function has_geminated_consonant(chars: Chars): boolean {
  return chars.some((value, index) => {
    if (!is_consonant(value)) return false;
    const next = next_non_comma_index(chars, index + 1);
    return next !== undefined && chars[next] === value;
  });
}
function has_forbidden_consonant_triple(chars: Chars): boolean {
  let first: string | undefined;
  let second: string | undefined;
  for (const value of chars) {
    if (!is_consonant(value)) {
      first = undefined;
      second = undefined;
      continue;
    }
    if (
      first === "n" &&
      ((second === "d" && is_one(value, "jz")) ||
        (second === "t" && is_one(value, "cs")))
    )
      return true;
    first = second;
    second = value;
  }
  return false;
}
function has_forbidden_consonant_pair(
  chars: Chars,
  allow_mz: boolean,
): boolean {
  return chars.some((value, index) => {
    if (!is_consonant(value)) return false;
    const next = next_non_comma_index(chars, index + 1);
    return (
      next !== undefined &&
      is_consonant(chars[next]) &&
      !isPermissiblePair(value, chars[next]) &&
      !(allow_mz && value === "m" && chars[next] === "z")
    );
  });
}
function has_digit_followed_by_nucleus(chars: Chars): boolean {
  return chars.some((value, index) => {
    if (!is_digit(value)) return false;
    const next = next_non_comma_index(chars, index + 1);
    return next !== undefined && starts_with_nucleus(chars, next);
  });
}
function has_y_hiatus(chars: Chars): boolean {
  return chars.some((value, index) => {
    if (!is_y(value)) return false;
    const next = next_non_comma_index(chars, index + 1);
    return (
      next !== undefined &&
      !is_y(chars[next]) &&
      starts_with_nucleus(chars, next)
    );
  });
}
function is_one(value: string | undefined, values: string): boolean {
  return value !== undefined && values.includes(value);
}
function is_digit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}
function base_vowel(value: string | undefined): string | undefined {
  switch (value) {
    case "a":
    case "á":
      return "a";
    case "e":
    case "é":
      return "e";
    case "i":
    case "í":
      return "i";
    case "o":
    case "ó":
      return "o";
    case "u":
    case "ú":
      return "u";
    default:
      return undefined;
  }
}
function is_vowel(value: string | undefined): boolean {
  return base_vowel(value) !== undefined;
}
function normalize_vowel(value: string): string {
  if (is_one(value, "áéíóú")) return value;
  if (value === "ĭ") return "i";
  if (value === "ŭ") return "u";
  return base_vowel(value) ?? value;
}
function is_consonant(value: string | undefined): boolean {
  return is_one(value, "bcdfgjklmnprstvxz");
}
function starts_glide(chars: Chars, index: number): boolean {
  return (
    is_one(chars[index], "iíĭuúŭ") && next_starts_nucleus(chars, index + 1)
  );
}
function next_starts_nucleus(chars: Chars, index: number): boolean {
  while (chars[index] === ",") index += 1;
  return starts_with_nucleus(chars, index);
}
function previous_non_comma(
  chars: Chars,
  index: number,
): [number, string] | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1)
    if (chars[cursor] !== ",") return [cursor, chars[cursor]];
  return undefined;
}
function has_cgv(chars: Chars): boolean {
  return chars.some(
    (value, index) =>
      is_one(value, "iíĭuúŭ") &&
      starts_glide(chars, index) &&
      is_consonant(previous_non_comma(chars, index)?.[1]),
  );
}
function has_voicing_mismatch(chars: Chars): boolean {
  return chars.some((value, index) => {
    const first = obstruent_voicing(value);
    const next = next_non_comma_index(chars, index + 1);
    if (first === undefined || next === undefined) return false;
    const second = obstruent_voicing(chars[next]);
    return second !== undefined && first !== second;
  });
}
function obstruent_voicing(value: string): boolean | undefined {
  if (is_one(value, "bdgjvz")) return true;
  if (is_one(value, "cfkpstx")) return false;
  return undefined;
}
function is_gismu_chars(chars: Chars, allow_mz: boolean): boolean {
  if (chars.length !== 5) return false;
  const [a, b, c, d, e] = chars;
  return (
    (is_consonant(a) &&
      is_vowel(b) &&
      is_consonant(c) &&
      is_consonant(d) &&
      is_vowel(e) &&
      (isPermissiblePair(c, d) || (allow_mz && c === "m" && d === "z"))) ||
    (isInitialPair(a, b) && is_vowel(c) && is_consonant(d) && is_vowel(e))
  );
}

function lujvo_from_until_with_cache(
  chars: Chars,
  index: number,
  end: number,
  has_initial: boolean,
  cache: LujvoRecognitionCache,
): boolean {
  if (!cache.charge()) return false;
  const cached = cache.lujvo_from(index, end, has_initial);
  if (cached !== undefined) return cached;
  let result: boolean;
  if (index >= end) result = false;
  else if (
    has_initial &&
    lujvo_core_part_ranges_until(chars, index, end, cache) !== undefined
  )
    result = true;
  else if (
    !has_initial &&
    (lujvo_core_part_ranges_until(chars, index, end, cache)?.length ?? 0) > 1
  )
    result = true;
  else if (!has_initial && is_cvv_final_rafsi_slice(chars, index, end))
    result = true;
  else
    result = initial_rafsi_ends_until_with_cache(chars, index, end, cache).some(
      (next) =>
        next > index &&
        lujvo_from_until_with_cache(chars, next, end, true, cache),
    );
  cache.record_lujvo_from(index, end, has_initial, result);
  return result;
}
function lujvo_part_ranges_from_with_cache(
  chars: Chars,
  index: number,
  end: number,
  has_initial: boolean,
  cache: LujvoRecognitionCache,
): PartRange[] | undefined {
  if (!cache.charge() || index >= end) return undefined;
  if (has_initial) {
    const ranges = lujvo_core_part_ranges_until(chars, index, end, cache);
    if (ranges !== undefined) return ranges;
  }
  if (!has_initial) {
    const ranges = lujvo_core_part_ranges_until(chars, index, end, cache);
    if (ranges !== undefined && ranges.length > 1) return ranges;
  }
  if (!has_initial && is_cvv_final_rafsi_slice(chars, index, end))
    return [{ start: index, end }];
  for (const next of initial_rafsi_ends_until_with_cache(
    chars,
    index,
    end,
    cache,
  )) {
    if (next <= index) continue;
    const rest = lujvo_part_ranges_from_with_cache(
      chars,
      next,
      end,
      true,
      cache,
    );
    if (rest !== undefined)
      return [...initial_rafsi_ranges(chars, index, next), ...rest];
  }
  return undefined;
}
function initial_rafsi_ranges(
  chars: Chars,
  start: number,
  end: number,
): PartRange[] {
  for (let index = start + 1; index < end; index += 1) {
    if (is_rafsi_hyphen_start(chars, index))
      return [
        { start, end: index },
        { start: index, end },
      ];
  }
  const hyphen = cvv_rafsi_hyphen_start_for_initial_end(chars, start, end);
  return hyphen === undefined
    ? [{ start, end }]
    : [
        { start, end: hyphen },
        { start: hyphen, end },
      ];
}
function is_rafsi_hyphen_start(chars: Chars, index: number): boolean {
  return is_y(chars[index]) || (chars[index] === "'" && is_y(chars[index + 1]));
}
function starts_with_cvcy_lujvo_chars_with_cache(
  chars: Chars,
  index: number,
  end: number,
  cache: LujvoRecognitionCache,
): boolean {
  if (!cache.charge()) return false;
  const base = cvc_rafsi_end(chars, index);
  if (base === undefined || base >= end || !is_y(chars[base])) return false;
  let after = base + 1;
  if (chars[after] === "'") after += 1;
  return (
    after <= end && lujvo_from_until_with_cache(chars, after, end, true, cache)
  );
}
function lujvo_core_part_ranges_until(
  chars: Chars,
  index: number,
  end: number,
  cache: LujvoRecognitionCache,
): PartRange[] | undefined {
  if (!cache.charge()) return undefined;
  if (
    is_gismu_slice(chars, index, end, cache.experimental) ||
    is_short_final_rafsi_slice(chars, index, end) ||
    is_cvv_final_rafsi_slice(chars, index, end) ||
    is_fuhivla_shape_slice_with_cache(chars, index, end, cache)
  )
    return [{ start: index, end }];
  const split = stressed_initial_rafsi_short_final_split_with_cache(
    chars,
    index,
    end,
    cache,
  );
  return split === undefined
    ? undefined
    : [...initial_rafsi_ranges(chars, index, split), { start: split, end }];
}
function initial_rafsi_ends_until_with_cache(
  chars: Chars,
  index: number,
  end: number,
  cache: LujvoRecognitionCache,
): number[] {
  if (!cache.charge()) return [];
  const ends = extended_rafsi_ends_until_with_cache(chars, index, end, cache);
  ends.push(...y_rafsi_ends(chars, index).filter((next) => next <= end));
  if (!any_extended_rafsi_starts_until_with_cache(chars, index, end, cache))
    ends.push(
      ...y_less_rafsi_ends(chars, index).filter(
        (next) =>
          next <= end &&
          !any_extended_rafsi_starts_until_with_cache(chars, next, end, cache),
      ),
    );
  return [...new Set(ends)];
}
function any_extended_rafsi_starts_until_with_cache(
  chars: Chars,
  index: number,
  end: number,
  cache: LujvoRecognitionCache,
): boolean {
  if (!cache.charge()) return false;
  if (cache.experimental) {
    if (index >= end) return false;
    if (
      is_fuhivla_shape_slice_with_cache(chars, index, end, cache) ||
      fuhivla_rafsi_base_ends_until_with_cache(chars, index, end, cache)
        .length > 0
    )
      return true;
    for (let next = index + 1; next <= end; next += 1)
      if (stressed_fuhivla_rafsi_slice_with_cache(chars, index, next, cache))
        return true;
    return false;
  }
  return (
    index < end &&
    (is_fuhivla_shape_slice_with_cache(chars, index, end, cache) ||
      extended_rafsi_ends_until_with_cache(chars, index, end, cache).length >
        0 ||
      stressed_extended_rafsi_ends_until_with_cache(chars, index, end, cache)
        .length > 0)
  );
}
function stressed_extended_rafsi_ends_until_with_cache(
  chars: Chars,
  index: number,
  end: number,
  cache: LujvoRecognitionCache,
): number[] {
  if (!cache.charge()) return [];
  const ends: number[] = [];
  for (let next = index + 1; next <= end; next += 1)
    if (stressed_extended_rafsi_slice_with_cache(chars, index, next, cache))
      ends.push(next);
  return ends;
}
function extended_rafsi_ends_until_with_cache(
  chars: Chars,
  index: number,
  end: number,
  cache: LujvoRecognitionCache,
): number[] {
  if (!cache.charge()) return [];
  const ends: number[] = [];
  for (const base of fuhivla_rafsi_base_ends_until_with_cache(
    chars,
    index,
    end,
    cache,
  )) {
    const next = rafsi_hyphen_end(chars, base);
    if (next !== undefined && next <= end) ends.push(next);
  }
  if (cache.experimental)
    ends.push(...hy_rafsi_ends(chars, index).filter((next) => next <= end));
  else {
    for (const base of brivla_head_ends_until_with_cache(
      chars,
      index,
      end,
      cache,
    )) {
      if (chars.slice(index, base).some(is_y)) continue;
      const next = hy_rafsi_hyphen_end(chars, base);
      if (next !== undefined && next <= end) ends.push(next);
    }
  }
  return ends;
}
function stressed_initial_rafsi_short_final_split_with_cache(
  chars: Chars,
  start: number,
  end: number,
  cache: LujvoRecognitionCache,
): number | undefined {
  if (!cache.charge()) return undefined;
  for (let split = end - 1; split > start; split -= 1)
    if (
      is_short_final_rafsi_slice(chars, split, end) &&
      stressed_initial_rafsi_slice_with_cache(chars, start, split, cache)
    )
      return split;
  return undefined;
}
function stressed_initial_rafsi_slice_with_cache(
  chars: Chars,
  start: number,
  end: number,
  cache: LujvoRecognitionCache,
): boolean {
  if (!cache.charge()) return false;
  return (
    stressed_extended_rafsi_slice_with_cache(chars, start, end, cache) ||
    y_rafsi_slice(chars, start, end) ||
    y_less_rafsi_ends(chars, start).some((next) => next === end)
  );
}
function stressed_extended_rafsi_slice_with_cache(
  chars: Chars,
  start: number,
  end: number,
  cache: LujvoRecognitionCache,
): boolean {
  if (!cache.charge()) return false;
  return (
    (cache.experimental
      ? hy_rafsi_slice(chars, start, end)
      : stressed_brivla_rafsi_slice_with_cache(chars, start, end, cache)) ||
    stressed_fuhivla_rafsi_slice_with_cache(chars, start, end, cache)
  );
}
function stressed_brivla_rafsi_slice_with_cache(
  chars: Chars,
  start: number,
  end: number,
  cache: LujvoRecognitionCache,
): boolean {
  if (!cache.charge()) return false;
  if (end < start + 3 || chars[end - 2] !== "'" || !is_y(chars[end - 1]))
    return false;
  const stress_end = end - 2;
  return brivla_head_ends_until_with_cache(chars, start, stress_end, cache)
    .filter((head) => head < stress_end)
    .some((head) =>
      stressed_syllable_ends_for_profile(
        chars,
        head,
        stress_end,
        cache.experimental,
      ).some((after) => after === stress_end),
    );
}
function stressed_fuhivla_rafsi_slice_with_cache(
  chars: Chars,
  start: number,
  end: number,
  cache: LujvoRecognitionCache,
): boolean {
  if (!cache.charge()) return false;
  if (end < start + 2 || !is_y(chars[end - 1])) return false;
  const base = end - 1;
  return fuhivla_head_ends_until_with_cache(chars, start, base, cache)
    .filter((head) => head < base)
    .some((head) =>
      stressed_syllable_ends_for_profile(
        chars,
        head,
        base,
        cache.experimental,
      ).some((after) =>
        consonantal_chain_then_onset(chars, after, base, cache.experimental),
      ),
    );
}
function consonantal_chain_then_onset(
  chars: Chars,
  index: number,
  end: number,
  experimental: boolean,
): boolean {
  if (
    (experimental && chars[index] === "'" && index + 1 === end) ||
    ((experimental || chars[index] !== "'") &&
      has_parse_onset_end(chars, index, end))
  )
    return true;
  return consonantal_syllable_ends(chars, index, end).some(
    (next) =>
      next > index &&
      consonantal_chain_then_onset(chars, next, end, experimental),
  );
}
function fuhivla_rafsi_base_ends_until_with_cache(
  chars: Chars,
  index: number,
  lookahead_end: number,
  cache: LujvoRecognitionCache,
): number[] {
  if (!cache.charge()) return [];
  const ends: number[] = [];
  for (let base = index + 1; base < lookahead_end; base += 1)
    if (
      rafsi_hyphen_end(chars, base) !== undefined &&
      fuhivla_rafsi_base_slice_with_cache(
        chars,
        index,
        base,
        lookahead_end,
        cache,
      )
    )
      ends.push(base);
  return ends;
}
function fuhivla_rafsi_base_slice_with_cache(
  chars: Chars,
  start: number,
  end: number,
  lookahead_end: number,
  cache: LujvoRecognitionCache,
): boolean {
  if (!cache.charge()) return false;
  if (
    start >= end ||
    chars.slice(start, end).some(is_y) ||
    unstressed_syllable_ends_for_fuhivla(chars, start, end).length === 0
  )
    return false;
  return fuhivla_head_ends_until_with_cache(chars, start, lookahead_end, cache)
    .filter((head) => head > start && head < end)
    .some(
      (head) =>
        (cache.experimental && chars[head] === "'" && head + 1 === end) ||
        ((cache.experimental || chars[head] !== "'") &&
          has_parse_onset_end(chars, head, end)),
    );
}
function brivla_head_ends_until_with_cache(
  chars: Chars,
  index: number,
  end: number,
  cache: LujvoRecognitionCache,
): number[] {
  if (!cache.charge()) return [];
  if (
    index > end ||
    chars[index] === "'" ||
    !starts_with_onset(chars, index) ||
    cmavo_word_slice_with_cache(chars, index, end, cache) ||
    slinkuhi_slice_with_cache(chars, index, end, cache)
  )
    return [];
  return brivla_head_ends_without_lookahead(chars, index, end);
}
function fuhivla_head_ends_until_with_cache(
  chars: Chars,
  index: number,
  end: number,
  cache: LujvoRecognitionCache,
): number[] {
  if (!cache.charge()) return [];
  if (rafsi_string_starts_slice_with_cache(chars, index, end, cache)) return [];
  return brivla_head_ends_until_with_cache(chars, index, end, cache);
}
function brivla_head_ends_without_lookahead(
  chars: Chars,
  index: number,
  end: number,
): number[] {
  const ends = [index];
  const stack = [index];
  while (stack.length > 0) {
    const start = stack.pop()!;
    for (const after of unstressed_syllable_ends_for_fuhivla(chars, start, end))
      if (after > start && !ends.includes(after)) {
        ends.push(after);
        stack.push(after);
      }
  }
  return ends.sort((a, b) => a - b);
}
function slinkuhi_slice_with_cache(
  chars: Chars,
  start: number,
  end: number,
  cache: LujvoRecognitionCache,
): boolean {
  if (!cache.charge()) return false;
  return (
    start < end &&
    !rafsi_string_starts_slice_with_cache(chars, start, end, cache) &&
    is_consonant(chars[start]) &&
    rafsi_string_starts_slice_with_cache(chars, start + 1, end, cache)
  );
}
function rafsi_string_starts_slice_with_cache(
  chars: Chars,
  start: number,
  end: number,
  cache: LujvoRecognitionCache,
): boolean {
  if (!cache.charge() || start >= end) return false;
  for (let word_end = start + 1; word_end <= end; word_end += 1)
    if (
      rafsi_string_slice_for_lookahead_with_cache(
        chars,
        start,
        word_end,
        end,
        cache,
      )
    )
      return true;
  return false;
}
function rafsi_string_slice_for_lookahead_with_cache(
  chars: Chars,
  start: number,
  end: number,
  lookahead_end: number,
  cache: LujvoRecognitionCache,
): boolean {
  if (!cache.charge()) return false;
  return rafsi_string_from_with_cache(chars, start, end, lookahead_end, cache);
}
function rafsi_string_from_with_cache(
  chars: Chars,
  start: number,
  end: number,
  lookahead_end: number,
  cache: LujvoRecognitionCache,
): boolean {
  if (!cache.charge() || start >= end) return false;
  let cursor = start;
  while (cursor < end) {
    const next = y_less_rafsi_ends(chars, cursor).find(
      (after) =>
        after <= end &&
        y_less_rafsi_is_unstressed_in_context(
          chars,
          cursor,
          after,
          lookahead_end,
        ),
    );
    if (next === undefined) break;
    cursor = next;
  }
  return rafsi_string_ending_with_cache(
    chars,
    cursor,
    end,
    lookahead_end,
    cache,
  );
}
function y_less_rafsi_is_unstressed_in_context(
  chars: Chars,
  start: number,
  end: number,
  context: number,
): boolean {
  if (cvc_rafsi_end(chars, start) === end)
    return !nucleus_is_stressed_in_context(
      chars,
      start + 1,
      start + 2,
      context,
    );
  if (ccv_rafsi_end(chars, start) === end)
    return !nucleus_is_stressed_in_context(
      chars,
      start + 2,
      start + 3,
      context,
    );
  return cvv_rafsi_is_unstressed_in_context(chars, start, end, context);
}
function cvv_rafsi_is_unstressed_in_context(
  chars: Chars,
  start: number,
  end: number,
  context: number,
): boolean {
  if (start >= end || !is_consonant(chars[start])) return false;
  for (const vowel_end of vowel_pair_ends(chars, start + 1)) {
    if (
      end !== vowel_end &&
      r_hyphen_end(chars, vowel_end) !== end &&
      n_hyphen_end(chars, vowel_end) !== end
    )
      continue;
    if (chars[start + 2] === "'" && vowel_end === start + 4)
      return (
        !nucleus_is_stressed_in_context(chars, start + 1, start + 2, context) &&
        !nucleus_is_stressed_in_context(chars, start + 3, start + 4, context)
      );
    if (vowel_end === start + 3)
      return !nucleus_is_stressed_in_context(
        chars,
        start + 1,
        vowel_end,
        context,
      );
  }
  return false;
}
function nucleus_is_stressed_in_context(
  chars: Chars,
  start: number,
  end: number,
  context: number,
): boolean {
  return (
    syllable_has_explicit_stress(chars, start, end) ||
    nucleus_has_implicit_stress(chars, end, context)
  );
}
function nucleus_has_implicit_stress(
  chars: Chars,
  index: number,
  context: number,
): boolean {
  const stack = [index];
  const afters: number[] = [];
  while (stack.length > 0) {
    const cursor = stack.pop()!;
    if (afters.includes(cursor)) continue;
    afters.push(cursor);
    if (cursor < context && is_consonant(chars[cursor])) stack.push(cursor + 1);
    const glide = parse_glide_end(chars, cursor);
    if (glide !== undefined && glide <= context) stack.push(glide);
  }
  return afters.some((cursor) =>
    stress_tail_reaches_boundary(chars, cursor, context),
  );
}
function stress_tail_reaches_boundary(
  chars: Chars,
  index: number,
  context: number,
): boolean {
  const after_h = [index];
  if (index < context && chars[index] === "'") after_h.push(index + 1);
  return after_h.some((cursor) => {
    const after_y = [cursor];
    if (cursor < context && is_y(chars[cursor])) after_y.push(cursor + 1);
    return after_y.some((start) =>
      syllable_ends(chars, start, context).some((after) => after === context),
    );
  });
}
function rafsi_string_ending_with_cache(
  chars: Chars,
  start: number,
  end: number,
  lookahead_end: number,
  cache: LujvoRecognitionCache,
): boolean {
  if (!cache.charge()) return false;
  return (
    (is_gismu_slice_for_rafsi_string(
      chars,
      start,
      end,
      lookahead_end,
      cache.experimental,
    ) &&
      post_word_slice_with_cache(chars, end, lookahead_end, cache)) ||
    (is_cvv_final_rafsi_slice_for_rafsi_string(
      chars,
      start,
      end,
      lookahead_end,
    ) &&
      post_word_slice_with_cache(chars, end, lookahead_end, cache)) ||
    y_less_rafsi_ends(chars, start).some(
      (mid) =>
        mid > start &&
        mid < end &&
        is_short_final_rafsi_slice_for_rafsi_string(
          chars,
          mid,
          end,
          lookahead_end,
        ) &&
        post_word_slice_with_cache(chars, end, lookahead_end, cache),
    ) ||
    y_rafsi_slice(chars, start, end) ||
    hy_rafsi_slice(chars, start, end) ||
    (cache.experimental && initial_pair_y_ending(chars, start, end))
  );
}
function initial_pair_y_ending(
  chars: Chars,
  start: number,
  end: number,
): boolean {
  const pair_y = (index: number) =>
    index + 3 === end &&
    isInitialPair(chars[index], chars[index + 1]) &&
    chars[index + 2] === "y";
  return (
    (start + 3 <= end && pair_y(start)) ||
    y_less_rafsi_ends(chars, start).some(
      (next) => next + 3 <= end && pair_y(next),
    )
  );
}
function is_gismu_slice_for_rafsi_string(
  chars: Chars,
  start: number,
  end: number,
  lookahead_end: number,
  allow_mz: boolean,
): boolean {
  if (end !== start + 5) return false;
  if (
    !(
      (isInitialPair(chars[start], chars[start + 1]) &&
        is_vowel(chars[start + 2]) &&
        is_consonant(chars[start + 3]) &&
        is_vowel(chars[start + 4])) ||
      (is_consonant(chars[start]) &&
        is_vowel(chars[start + 1]) &&
        is_consonant(chars[start + 2]) &&
        is_consonant(chars[start + 3]) &&
        is_vowel(chars[start + 4]) &&
        (isPermissiblePair(chars[start + 2], chars[start + 3]) ||
          (allow_mz && chars[start + 2] === "m" && chars[start + 3] === "z")))
    )
  )
    return false;
  return (
    syllable_is_stressed_in_context(chars, start, start + 3, lookahead_end) &&
    final_syllable_slice_in_context(chars, start + 3, end, lookahead_end)
  );
}
function is_cvv_final_rafsi_slice_for_rafsi_string(
  chars: Chars,
  start: number,
  end: number,
  lookahead_end: number,
): boolean {
  return (
    end === start + 4 &&
    is_consonant(chars[start]) &&
    is_vowel(chars[start + 1]) &&
    chars[start + 2] === "'" &&
    is_vowel(chars[start + 3]) &&
    syllable_is_stressed_in_context(chars, start, start + 2, lookahead_end) &&
    final_syllable_slice_in_context(chars, start + 3, end, lookahead_end)
  );
}
function is_short_final_rafsi_slice_for_rafsi_string(
  chars: Chars,
  start: number,
  end: number,
  lookahead_end: number,
): boolean {
  return (
    is_short_final_rafsi_slice(chars, start, end) &&
    final_syllable_slice_in_context(chars, start, end, lookahead_end)
  );
}
function syllable_is_stressed_in_context(
  chars: Chars,
  start: number,
  syllable_end: number,
  context: number,
): boolean {
  return (
    syllable_has_explicit_stress(chars, start, syllable_end) ||
    stressed_syllable_has_implicit_stress(chars, start, syllable_end, context)
  );
}
function final_syllable_slice_in_context(
  chars: Chars,
  start: number,
  end: number,
  context: number,
): boolean {
  return (
    final_syllable_slice(chars, start, end) &&
    !stressed_syllable_has_implicit_stress(chars, start, end, context)
  );
}
function post_word_slice_with_cache(
  chars: Chars,
  index: number,
  end: number,
  cache: LujvoRecognitionCache,
): boolean {
  if (!cache.charge()) return false;
  const next = next_non_comma_index(chars, index);
  return (
    next === undefined ||
    next >= end ||
    (!starts_with_pause_required_nucleus(chars, next) &&
      lojban_word_slice_with_cache(chars, next, end, cache))
  );
}

function y_rafsi_ends(chars: Chars, index: number): number[] {
  const ends: number[] = [];
  const bases = long_rafsi_ends(chars, index);
  const cvc = cvc_rafsi_end(chars, index);
  if (cvc !== undefined) bases.push(cvc);
  for (const base of bases) {
    if (is_y(chars[base])) {
      let end = base + 1;
      if (chars[end] === "'") end += 1;
      ends.push(end);
    }
  }
  return ends;
}
function y_rafsi_slice(chars: Chars, start: number, end: number): boolean {
  const bases = long_rafsi_ends(chars, start);
  const cvc = cvc_rafsi_end(chars, start);
  if (cvc !== undefined) bases.push(cvc);
  return bases.some((base) => rafsi_hyphen_end(chars, base) === end);
}
function y_less_rafsi_ends(chars: Chars, index: number): number[] {
  if (
    y_rafsi_ends(chars, index).length > 0 ||
    hy_rafsi_ends(chars, index).length > 0
  )
    return [];
  const ends: number[] = [];
  const cvc = cvc_rafsi_end(chars, index);
  if (cvc !== undefined) ends.push(cvc);
  const ccv = ccv_rafsi_end(chars, index);
  if (ccv !== undefined) ends.push(ccv);
  ends.push(...initial_cvv_rafsi_ends(chars, index));
  return ends.filter((end) => chars[end] !== "'");
}
function hy_rafsi_slice(chars: Chars, start: number, end: number): boolean {
  return hy_rafsi_ends(chars, start).some((after) => after === end);
}
function hy_rafsi_ends(chars: Chars, index: number): number[] {
  const ends: number[] = [];
  for (const base of long_rafsi_ends(chars, index)) {
    if (is_vowel(chars[base])) {
      const end = hy_rafsi_hyphen_end(chars, base + 1);
      if (end !== undefined) ends.push(end);
    }
  }
  const bases: number[] = [];
  const ccv = ccv_rafsi_end(chars, index);
  if (ccv !== undefined) bases.push(ccv);
  bases.push(...cvv_rafsi_base_ends(chars, index));
  for (const base of bases) {
    const end = hy_rafsi_hyphen_end(chars, base);
    if (end !== undefined) ends.push(end);
  }
  return ends;
}
function rafsi_hyphen_end(chars: Chars, index: number): number | undefined {
  if (!is_y(chars[index])) return undefined;
  let end = index + 1;
  if (chars[end] === "'") end += 1;
  return end;
}
function hy_rafsi_hyphen_end(chars: Chars, index: number): number | undefined {
  if (chars[index] !== "'" || !is_y(chars[index + 1])) return undefined;
  let end = index + 2;
  if (chars[end] === "'") end += 1;
  return end;
}
function long_rafsi_ends(chars: Chars, index: number): number[] {
  const ends: number[] = [];
  if (
    index + 4 <= chars.length &&
    isInitialPair(chars[index], chars[index + 1]) &&
    is_vowel(chars[index + 2]) &&
    is_consonant(chars[index + 3])
  )
    ends.push(index + 4);
  if (
    index + 4 <= chars.length &&
    is_consonant(chars[index]) &&
    is_vowel(chars[index + 1]) &&
    is_consonant(chars[index + 2]) &&
    is_consonant(chars[index + 3])
  )
    ends.push(index + 4);
  return ends;
}
function cvc_rafsi_end(chars: Chars, index: number): number | undefined {
  return index + 3 <= chars.length &&
    is_consonant(chars[index]) &&
    is_vowel(chars[index + 1]) &&
    is_consonant(chars[index + 2])
    ? index + 3
    : undefined;
}
function ccv_rafsi_end(chars: Chars, index: number): number | undefined {
  return index + 3 <= chars.length &&
    isInitialPair(chars[index], chars[index + 1]) &&
    is_vowel(chars[index + 2])
    ? index + 3
    : undefined;
}
function initial_cvv_rafsi_ends(chars: Chars, index: number): number[] {
  const ends: number[] = [];
  for (const base of cvv_rafsi_base_ends(chars, index)) {
    const end = r_hyphen_end(chars, base) ?? n_hyphen_end(chars, base);
    if (end !== undefined) ends.push(end);
    ends.push(base);
  }
  return ends;
}
function cvv_rafsi_base_ends(chars: Chars, index: number): number[] {
  return index < chars.length && is_consonant(chars[index])
    ? vowel_pair_ends(chars, index + 1)
    : [];
}
function cvv_rafsi_hyphen_start_for_initial_end(
  chars: Chars,
  start: number,
  end: number,
): number | undefined {
  return cvv_rafsi_base_ends(chars, start).find(
    (base) =>
      r_hyphen_end(chars, base) === end || n_hyphen_end(chars, base) === end,
  );
}
function r_hyphen_end(chars: Chars, index: number): number | undefined {
  return chars[index] === "r" && is_consonant(chars[index + 1])
    ? index + 1
    : undefined;
}
function n_hyphen_end(chars: Chars, index: number): number | undefined {
  return chars[index] === "n" && chars[index + 1] === "r"
    ? index + 1
    : undefined;
}
function vowel_pair_ends(chars: Chars, index: number): number[] {
  const ends: number[] = [];
  if (
    index + 3 <= chars.length &&
    is_vowel(chars[index]) &&
    chars[index + 1] === "'" &&
    is_vowel(chars[index + 2])
  )
    ends.push(index + 3);
  if (
    index + 2 <= chars.length &&
    is_diphthong_pair(chars[index], chars[index + 1])
  )
    ends.push(index + 2);
  return ends;
}
function is_gismu_slice(
  chars: Chars,
  start: number,
  end: number,
  allow_mz: boolean,
): boolean {
  return end > start && is_gismu_chars(chars.slice(start, end), allow_mz);
}
function is_short_final_rafsi_slice(
  chars: Chars,
  start: number,
  end: number,
): boolean {
  if (start >= end) return false;
  if (
    end === start + 3 &&
    is_consonant(chars[start]) &&
    is_diphthong_pair(chars[start + 1], chars[start + 2])
  )
    return true;
  if (
    end === start + 3 &&
    isInitialPair(chars[start], chars[start + 1]) &&
    is_vowel(chars[start + 2])
  )
    return true;
  return (
    end === start + 4 &&
    is_consonant(chars[start]) &&
    is_vowel(chars[start + 1]) &&
    chars[start + 2] === "'" &&
    is_vowel(chars[start + 3])
  );
}
function is_cvv_final_rafsi_slice(
  chars: Chars,
  start: number,
  end: number,
): boolean {
  return (
    start < end &&
    is_consonant(chars[start]) &&
    vowel_pair_ends(chars, start + 1).some((after) => after === end)
  );
}
function is_fuhivla_shape_slice_with_cache(
  chars: Chars,
  start: number,
  end: number,
  cache: LujvoRecognitionCache,
): boolean {
  if (!cache.charge()) return false;
  return is_fuhivla_shape_slice_with_y_policy_with_cache(
    chars,
    start,
    end,
    false,
    cache,
  );
}
function is_fuhivla_shape_slice_with_y_policy_with_cache(
  chars: Chars,
  start: number,
  end: number,
  allows_y: boolean,
  cache: LujvoRecognitionCache,
): boolean {
  if (!cache.charge()) return false;
  if (
    end <= start ||
    end - start < 4 ||
    !ends_with_vocalic_nucleus(chars, start, end) ||
    count_vocalic_nuclei(chars, start, end) < 2 ||
    (!allows_y && chars.slice(start, end).some(is_y)) ||
    has_vowel_hiatus(chars.slice(start, end)) ||
    !parse_fuhivla_shape_with_cache(chars, start, end, cache)
  )
    return false;
  if (
    rafsi_string_slice_for_lookahead_with_cache(
      chars,
      start,
      end,
      end,
      cache,
    ) ||
    slinkuhi_slice_with_cache(chars, start, end, cache) ||
    has_blocking_cmavo_prefix_slice_with_cache(chars, start, end, cache) ||
    (cache.experimental
      ? experimental_invalid_initial_continuation(chars, start, end)
      : invalid_initial_rafsi_continuation(chars, start, end)) ||
    invalid_vowel_initial_fuhivla_shape_with_cache(chars, start, end, cache)
  )
    return false;
  if (!starts_with_valid_word_onset(chars, start)) return false;
  const slice = chars.slice(start, end);
  return (
    slice.some(is_consonant) &&
    has_consonant_cluster(slice) &&
    !is_cmavo_slice(chars, start, end)
  );
}
function experimental_invalid_initial_continuation(
  chars: Chars,
  start: number,
  end: number,
): boolean {
  const prefix = cvc_rafsi_end(chars, start) ?? ccv_rafsi_end(chars, start);
  return (
    prefix !== undefined &&
    prefix < end &&
    chars[prefix] !== "r" &&
    starts_cgv_sequence(chars, prefix, end)
  );
}
function has_blocking_cmavo_prefix_slice_with_cache(
  chars: Chars,
  start: number,
  end: number,
  cache: LujvoRecognitionCache,
): boolean {
  if (!cache.charge() || start >= end) return false;
  return cmavo_word_slice_with_cache(chars, start, end, cache);
}
function cmavo_post_word_slice_with_cache(
  chars: Chars,
  prefix_start: number,
  prefix_end: number,
  end: number,
  cache: LujvoRecognitionCache,
): boolean {
  if (!cache.charge()) return false;
  const index = next_non_comma_index(chars, prefix_end);
  if (index === undefined || index >= end) return true;
  if (
    starts_with_pause_required_nucleus(chars, index) &&
    !indicator_cmavo_boundary_slice_with_cache(
      chars,
      prefix_start,
      prefix_end,
      index,
      end,
      cache,
    )
  )
    return false;
  return lojban_word_slice_with_cache(chars, index, end, cache);
}
function indicator_cmavo_boundary_slice_with_cache(
  chars: Chars,
  prefix_start: number,
  prefix_end: number,
  index: number,
  end: number,
  cache: LujvoRecognitionCache,
): boolean {
  if (!cache.charge()) return false;
  return (
    is_indicator_cmavo_slice(chars, prefix_start, prefix_end) &&
    !starts_with_nucleus(chars, index) &&
    indicator_cmavo_starts_slice_with_cache(chars, index, end, cache)
  );
}
function indicator_cmavo_starts_slice_with_cache(
  chars: Chars,
  start: number,
  end: number,
  cache: LujvoRecognitionCache,
): boolean {
  if (!cache.charge() || start >= end) return false;
  for (let word_end = start + 1; word_end <= end; word_end += 1)
    if (
      is_indicator_cmavo_slice(chars, start, word_end) &&
      cmavo_post_word_slice_with_cache(chars, start, word_end, end, cache)
    )
      return true;
  return false;
}
function is_indicator_cmavo_slice(
  chars: Chars,
  start: number,
  end: number,
): boolean {
  if (start >= end) return false;
  const text = parse_cmavo_form_chars(chars.slice(start, end));
  return text !== undefined && INDICATORS.has(text);
}
function lojban_word_slice_with_cache(
  chars: Chars,
  start: number,
  end: number,
  cache: LujvoRecognitionCache,
): boolean {
  if (!cache.charge() || start >= end) return false;
  return (
    is_cmevla_slice(chars, start, end, cache.experimental) ||
    cmavo_word_slice_with_cache(chars, start, end, cache) ||
    brivla_word_slice_with_cache(chars, start, end, cache)
  );
}
function cmavo_word_slice_with_cache(
  chars: Chars,
  start: number,
  end: number,
  cache: LujvoRecognitionCache,
): boolean {
  if (!cache.charge()) return false;
  if (
    start >= end ||
    is_cmevla_slice(chars, start, end, cache.experimental) ||
    starts_with_cvcy_lujvo_chars_with_cache(chars, start, end, cache)
  )
    return false;
  for (let word_end = start + 1; word_end <= end; word_end += 1)
    if (
      is_cmavo_slice(chars, start, word_end) &&
      cmavo_post_word_slice_with_cache(chars, start, word_end, end, cache)
    )
      return true;
  return false;
}
function is_slihykru(chars: Chars, start: number, end: number): boolean {
  const after = ccv_rafsi_end(chars, start);
  return (
    after !== undefined &&
    after + 2 < end &&
    chars[after] === "'" &&
    chars[after + 1] === "y" &&
    starts_with_onset(chars.slice(0, end), after + 2)
  );
}
function brivla_word_slice_with_cache(
  chars: Chars,
  start: number,
  end: number,
  cache: LujvoRecognitionCache,
): boolean {
  if (!cache.charge()) return false;
  return (
    !(cache.experimental && is_slihykru(chars, start, end)) &&
    !cmavo_word_slice_with_cache(chars, start, end, cache) &&
    (is_gismu_slice(chars, start, end, cache.experimental) ||
      is_lujvo_slice_with_cache(chars, start, end, cache) ||
      is_fuhivla_shape_slice_with_cache(chars, start, end, cache))
  );
}
function is_lujvo_slice_with_cache(
  chars: Chars,
  start: number,
  end: number,
  cache: LujvoRecognitionCache,
): boolean {
  if (!cache.charge()) return false;
  return (
    !(cache.experimental && is_slihykru(chars, start, end)) &&
    chars.slice(start, end).every(is_lujvo_char) &&
    !cmavo_word_slice_with_cache(chars, start, end, cache) &&
    !is_fuhivla_shape_slice_with_cache(chars, start, end, cache) &&
    lujvo_from_until_with_cache(chars, start, end, false, cache)
  );
}
function is_cmevla_slice(
  chars: Chars,
  start: number,
  end: number,
  allow_mz: boolean,
): boolean {
  return (
    start < end &&
    chars[end - 1] >= "a" &&
    chars[end - 1] <= "z" &&
    is_consonant(chars[end - 1]) &&
    !blocks_word_shape(chars.slice(start, end), allow_mz)
  );
}
function starts_with_pause_required_nucleus(
  chars: Chars,
  start: number,
): boolean {
  const next = next_non_comma_index(chars, start);
  return next !== undefined && starts_with_nucleus(chars, next);
}
function ends_with_vocalic_nucleus(
  chars: Chars,
  start: number,
  end: number,
): boolean {
  return (
    start < end && (is_vowel(chars[end - 1]) || is_one(chars[end - 1], "ĭŭ"))
  );
}
function count_vocalic_nuclei(
  chars: Chars,
  start: number,
  end: number,
): number {
  let count = 0;
  let index = start;
  while (index < end) {
    const diphthong = parse_diphthong_end(chars, index);
    if (diphthong !== undefined && diphthong[1] <= end) {
      count += 1;
      index = diphthong[1];
    } else {
      const nucleus = parse_single_vowel_end(chars, index);
      if (nucleus !== undefined && nucleus <= end) {
        count += 1;
        index = nucleus;
      } else index += 1;
    }
  }
  return count;
}
function invalid_initial_rafsi_continuation(
  chars: Chars,
  start: number,
  end: number,
): boolean {
  const prefix = cvc_rafsi_end(chars, start) ?? ccv_rafsi_end(chars, start);
  return (
    prefix !== undefined && bad_lujvo_prefix_continuation(chars, prefix, end)
  );
}
function bad_lujvo_prefix_continuation(
  chars: Chars,
  index: number,
  end: number,
): boolean {
  if (index >= end) return false;
  if (chars[index] === "r")
    return (
      starts_t_l(chars, index + 1, end) ||
      starts_n_liquid(chars, index + 1, end)
    );
  return (
    starts_affricate_liquid(chars, index, end) ||
    starts_jr_vowel(chars, index, end) ||
    starts_consonantal_then_forbidden_initial(chars, index, end) ||
    starts_gn_vowel(chars, index, end) ||
    starts_cgv_sequence(chars, index, end)
  );
}
function starts_forbidden_initial_pair(
  chars: Chars,
  index: number,
  end: number,
): boolean {
  return (
    index + 1 < end &&
    is_consonant(chars[index]) &&
    is_consonant(chars[index + 1]) &&
    !isInitialPair(chars[index], chars[index + 1])
  );
}
function starts_n_liquid(chars: Chars, index: number, end: number): boolean {
  return index + 1 < end && chars[index] === "n" && is_liquid(chars[index + 1]);
}
function starts_t_l(chars: Chars, index: number, end: number): boolean {
  return index + 1 < end && chars[index] === "t" && chars[index + 1] === "l";
}
function starts_affricate_liquid(
  chars: Chars,
  index: number,
  end: number,
): boolean {
  return (
    index + 2 < end &&
    ((chars[index] === "d" && is_one(chars[index + 1], "jz")) ||
      (chars[index] === "t" && is_one(chars[index + 1], "cs"))) &&
    is_liquid(chars[index + 2])
  );
}
function starts_jr_vowel(chars: Chars, index: number, end: number): boolean {
  return (
    index + 2 < end &&
    chars[index] === "j" &&
    chars[index + 1] === "r" &&
    is_vowel(chars[index + 2])
  );
}
function starts_consonantal_then_forbidden_initial(
  chars: Chars,
  index: number,
  end: number,
): boolean {
  return (
    index + 3 < end &&
    is_consonant(chars[index]) &&
    is_syllabic(chars[index + 1]) &&
    starts_forbidden_initial_pair(chars, index + 2, end)
  );
}
function starts_gn_vowel(chars: Chars, index: number, end: number): boolean {
  return (
    index + 2 < end &&
    chars[index] === "g" &&
    chars[index + 1] === "n" &&
    is_vowel(chars[index + 2])
  );
}
function starts_cgv_sequence(
  chars: Chars,
  index: number,
  end: number,
): boolean {
  return (
    index < end && is_consonant(chars[index]) && starts_glide(chars, index + 1)
  );
}
function invalid_vowel_initial_fuhivla_shape_with_cache(
  chars: Chars,
  start: number,
  end: number,
  cache: LujvoRecognitionCache,
): boolean {
  if (!cache.charge()) return false;
  return (
    (is_vowel(chars[start]) || is_one(chars[start], "ĭŭ")) &&
    !parse_fuhivla_shape_with_cache(chars, start, end, cache)
  );
}
function parse_fuhivla_shape_with_cache(
  chars: Chars,
  start: number,
  end: number,
  cache: LujvoRecognitionCache,
): boolean {
  if (!cache.charge()) return false;
  return (
    parse_fuhivla_shape_with_head_policy_with_cache(
      chars,
      start,
      end,
      "standard",
      cache,
    ) ||
    parse_experimental_cgv_fuhivla_shape_with_cache(chars, start, end, cache)
  );
}
function parse_experimental_cgv_fuhivla_shape_with_cache(
  chars: Chars,
  start: number,
  end: number,
  cache: LujvoRecognitionCache,
): boolean {
  if (!cache.charge()) return false;
  return (
    has_cgv(chars.slice(start, end)) &&
    parse_fuhivla_shape_with_head_policy_with_cache(
      chars,
      start,
      end,
      "experimental-cgv",
      cache,
    )
  );
}
function parse_fuhivla_shape_with_head_policy_with_cache(
  chars: Chars,
  start: number,
  end: number,
  head_policy: HeadPolicy,
  cache: LujvoRecognitionCache,
): boolean {
  if (!cache.charge()) return false;
  return fuhivla_head_ends_for_fuhivla_with_cache(
    chars,
    start,
    end,
    head_policy,
    cache,
  ).some((head) =>
    stressed_syllable_ends_for_profile(
      chars,
      head,
      end,
      cache.experimental,
    ).some((stress) => consonantal_chain_then_final(chars, stress, end)),
  );
}
function fuhivla_head_ends_for_fuhivla_with_cache(
  chars: Chars,
  start: number,
  end: number,
  head_policy: HeadPolicy,
  cache: LujvoRecognitionCache,
): number[] {
  if (!cache.charge()) return [];
  return head_policy === "standard"
    ? fuhivla_head_ends_until_with_cache(chars, start, end, cache)
    : brivla_head_ends_until_with_cache(chars, start, end, cache);
}

function unique_sorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}
function unstressed_syllable_ends_for_fuhivla(
  chars: Chars,
  index: number,
  end: number,
): number[] {
  const ends = syllable_ends(chars, index, end).filter(
    (after) =>
      !syllable_has_explicit_stress(chars, index, after) &&
      !stressed_syllable_has_implicit_stress(chars, index, after, end),
  );
  ends.push(...consonantal_syllable_ends(chars, index, end));
  return unique_sorted(ends);
}
function stressed_syllable_ends_for_profile(
  chars: Chars,
  index: number,
  end: number,
  experimental: boolean,
): number[] {
  if (!experimental)
    return stressed_syllable_ends_for_fuhivla(chars, index, end);
  return syllable_ends(chars, index, end).filter(
    (after) =>
      syllable_has_explicit_stress(chars, index, after) ||
      consonantal_chain_then_final(chars, after, end),
  );
}
function stressed_syllable_ends_for_fuhivla(
  chars: Chars,
  index: number,
  end: number,
): number[] {
  return syllable_ends(chars, index, end).filter(
    (after) =>
      syllable_has_explicit_stress(chars, index, after) ||
      stressed_syllable_has_implicit_stress(chars, index, after, end),
  );
}
function stressed_syllable_has_implicit_stress(
  chars: Chars,
  start: number,
  syllable_end: number,
  end: number,
): boolean {
  if (final_syllable_slice(chars, syllable_end, end)) return true;
  return (
    brivla_onset_has_nucleus_end(chars, start, syllable_end, true) &&
    consonantal_syllable_ends(chars, syllable_end, end).some(
      (next) =>
        next > syllable_end && consonantal_chain_then_final(chars, next, end),
    )
  );
}
function consonantal_chain_then_final(
  chars: Chars,
  index: number,
  end: number,
): boolean {
  if (final_syllable_slice(chars, index, end)) return true;
  return consonantal_syllable_ends(chars, index, end).some(
    (next) => next > index && consonantal_chain_then_final(chars, next, end),
  );
}
function final_syllable_slice(
  chars: Chars,
  start: number,
  end: number,
): boolean {
  return (
    !syllable_has_explicit_stress(chars, start, end) &&
    brivla_onset_has_nucleus_end(chars, start, end, true)
  );
}
function syllable_ends(chars: Chars, index: number, end: number): number[] {
  const ends: number[] = [];
  const onsets: number[] = [];
  append_brivla_onset_ends_unsorted(chars, index, onsets);
  for (const onset of onsets) {
    if (is_y(chars[onset])) continue;
    const nuclei: number[] = [];
    append_parse_nucleus_ends(chars, onset, nuclei);
    for (const nucleus of nuclei)
      if (nucleus <= end) {
        ends.push(nucleus);
        ends.push(...coda_ends(chars, nucleus, end));
      }
  }
  return unique_sorted(ends);
}
function consonantal_syllable_ends(
  chars: Chars,
  index: number,
  end: number,
): number[] {
  if (
    index >= end ||
    !is_consonant(chars[index]) ||
    !is_syllabic(chars[index + 1])
  )
    return [];
  return coda_ends(chars, index + 1, end).filter((after) => after > index + 1);
}
function coda_ends(chars: Chars, index: number, end: number): number[] {
  const ends = [index];
  if (
    index < end &&
    is_consonant(chars[index]) &&
    !starts_any_syllable(chars, index, end) &&
    starts_any_syllable(chars, index + 1, end)
  )
    ends.push(index + 1);
  return ends;
}
function starts_any_syllable(
  chars: Chars,
  index: number,
  end: number,
): boolean {
  if (index >= end) return false;
  if (consonantal_syllable_ends(chars, index, end).length > 0) return true;
  return brivla_onset_has_nucleus_end_at_or_before(chars, index, end);
}
function append_brivla_onset_ends_unsorted(
  chars: Chars,
  index: number,
  ends: number[],
): void {
  append_parse_onset_ends(chars, index, ends);
  const cgv = experimental_cgv_brivla_onset_end(chars, index);
  if (cgv !== undefined) ends.push(cgv);
  if (chars[index] === "'") ends.push(index + 1);
}
function brivla_onset_has_nucleus_end(
  chars: Chars,
  index: number,
  nucleus_end: number,
  skip_y: boolean,
): boolean {
  const glide = parse_glide_end(chars, index);
  if (
    glide !== undefined &&
    brivla_onset_candidate_has_nucleus_end(chars, glide, nucleus_end, skip_y)
  )
    return true;
  for (let onset = max_initial_end(chars, index); onset >= index; onset -= 1)
    if (
      parse_initial_end(chars, index, onset) !== undefined &&
      brivla_onset_candidate_has_nucleus_end(chars, onset, nucleus_end, skip_y)
    )
      return true;
  const cgv = experimental_cgv_brivla_onset_end(chars, index);
  if (
    cgv !== undefined &&
    brivla_onset_candidate_has_nucleus_end(chars, cgv, nucleus_end, skip_y)
  )
    return true;
  return (
    chars[index] === "'" &&
    brivla_onset_candidate_has_nucleus_end(
      chars,
      index + 1,
      nucleus_end,
      skip_y,
    )
  );
}
function brivla_onset_candidate_has_nucleus_end(
  chars: Chars,
  onset: number,
  nucleus_end: number,
  skip_y: boolean,
): boolean {
  return (
    (!skip_y || !is_y(chars[onset])) &&
    has_parse_nucleus_end(chars, onset, nucleus_end)
  );
}
function brivla_onset_has_nucleus_end_at_or_before(
  chars: Chars,
  index: number,
  limit: number,
): boolean {
  const glide = parse_glide_end(chars, index);
  if (
    glide !== undefined &&
    has_parse_nucleus_end_at_or_before(chars, glide, limit)
  )
    return true;
  for (let onset = max_initial_end(chars, index); onset >= index; onset -= 1)
    if (
      parse_initial_end(chars, index, onset) !== undefined &&
      has_parse_nucleus_end_at_or_before(chars, onset, limit)
    )
      return true;
  const cgv = experimental_cgv_brivla_onset_end(chars, index);
  if (
    cgv !== undefined &&
    has_parse_nucleus_end_at_or_before(chars, cgv, limit)
  )
    return true;
  return (
    chars[index] === "'" &&
    has_parse_nucleus_end_at_or_before(chars, index + 1, limit)
  );
}
function experimental_cgv_brivla_onset_end(
  chars: Chars,
  index: number,
): number | undefined {
  for (
    let initial = Math.min(index + 3, chars.length);
    initial >= index + 1;
    initial -= 1
  ) {
    if (
      valid_initial_shape(chars, index, initial) &&
      starts_glide(chars, initial)
    ) {
      const next = next_non_comma_index(chars, initial + 1);
      if (next !== undefined) return next;
    }
  }
  return undefined;
}
function syllable_has_explicit_stress(
  chars: Chars,
  start: number,
  end: number,
): boolean {
  return chars.slice(start, end).some((value) => is_one(value, "áéíóúÁÉÍÓÚ"));
}
function is_syllabic(value: string | undefined): boolean {
  return is_one(value, "lmnr");
}
function has_consonant_cluster(chars: Chars): boolean {
  return chars.some(
    (value, index) => is_consonant(value) && is_consonant(chars[index + 1]),
  );
}
function has_vowel_hiatus(chars: Chars): boolean {
  for (let index = 0; index < chars.length; index += 1) {
    if (!is_vowel(chars[index]) && !is_one(chars[index], "ĭŭ")) continue;
    if (starts_repeated_glide_diphthong_sequence(chars, index)) return true;
    if (starts_glide(chars, index)) continue;
    if (parse_diphthong_end(chars, index) !== undefined) continue;
    const next = next_non_comma_index(chars, index + 1);
    if (next !== undefined && starts_glide(chars, next)) continue;
    if (next !== undefined && starts_with_nucleus(chars, next)) return true;
  }
  return false;
}
function raw_diphthong_end(
  chars: Chars,
  start: number,
): [string, number] | undefined {
  const first = base_vowel(chars[start]);
  if (first === undefined) return undefined;
  // Commas inside a falling diphthong preserve the pinned parser behavior.
  const second = next_non_comma_index(chars, start + 1);
  if (second === undefined) return undefined;
  if (is_one(first, "aeo") && is_one(chars[second], "iíĭ"))
    return ["ĭ", second + 1];
  if (first === "a" && is_one(chars[second], "uúŭ")) return ["ŭ", second + 1];
  return undefined;
}
function starts_repeated_glide_diphthong_sequence(
  chars: Chars,
  index: number,
): boolean {
  const value = chars[index];
  const semivowel = is_one(value, "iíĭ")
    ? "ĭ"
    : is_one(value, "uúŭ")
      ? "ŭ"
      : undefined;
  if (semivowel === undefined) return false;
  const nucleus = next_non_comma_index(chars, index + 1);
  if (nucleus === undefined) return false;
  const diphthong = raw_diphthong_end(chars, nucleus);
  if (diphthong === undefined || diphthong[0] !== semivowel) return false;
  const next = next_non_comma_index(chars, diphthong[1]);
  return (
    next !== undefined && matches_diphthong_semivowel(chars[next], semivowel)
  );
}
function next_non_comma_index(chars: Chars, index: number): number | undefined {
  while (chars[index] === ",") index += 1;
  return index < chars.length ? index : undefined;
}
function is_cmavo_slice(chars: Chars, start: number, end: number): boolean {
  return (
    start < end && parse_cmavo_form_chars(chars.slice(start, end)) !== undefined
  );
}
function starts_with_onset(chars: Chars, index: number): boolean {
  return (
    index <= chars.length &&
    (has_parse_onset(chars, index) ||
      experimental_cgv_brivla_onset_end(chars, index) !== undefined)
  );
}
function starts_with_valid_word_onset(chars: Chars, index: number): boolean {
  const first = chars[index];
  if (first === undefined) return false;
  if (is_vowel(first) || is_y(first) || is_one(first, "ĭŭ")) return true;
  if (!is_consonant(first)) return false;
  const second = chars[index + 1];
  if (second === undefined || !is_consonant(second)) return true;
  if (is_consonant(chars[index + 2]))
    return (
      valid_three_consonant_initial(chars, index) &&
      !is_consonant(chars[index + 3])
    );
  return isInitialPair(first, second);
}
function valid_three_consonant_initial(chars: Chars, index: number): boolean {
  if (
    chars[index] === undefined ||
    chars[index + 1] === undefined ||
    chars[index + 2] === undefined
  )
    return false;
  return (
    is_sibilant(chars[index]) &&
    isInitialPair(chars[index], chars[index + 1]) &&
    isInitialPair(chars[index + 1], chars[index + 2]) &&
    is_liquid(chars[index + 2])
  );
}
function is_sibilant(value: string): boolean {
  return is_one(value, "csjz");
}
function is_liquid(value: string): boolean {
  return is_one(value, "lr");
}
function is_lujvo_char(value: string): boolean {
  return (
    is_consonant(value) ||
    is_vowel(value) ||
    is_y(value) ||
    is_one(value, "'ĭŭ")
  );
}
function is_diphthong_pair(first: string, second: string): boolean {
  const vowel = base_vowel(first);
  const semivowel = base_semivowel(second);
  return (
    (vowel !== undefined && is_one(vowel, "aeo") && semivowel === "i") ||
    (vowel === "a" && semivowel === "u")
  );
}
function base_semivowel(value: string): string | undefined {
  return is_one(value, "iíĭ") ? "i" : is_one(value, "uúŭ") ? "u" : undefined;
}
function is_y(value: string | undefined): boolean {
  return value === "y" || value === "ý";
}
function digit_to_cmavo(value: string): string | undefined {
  return ["no", "pa", "re", "ci", "vo", "mu", "xa", "ze", "bi", "so"][
    Number(value)
  ];
}
const INDICATORS = new Set([
  "a'a",
  "a'e",
  "a'i",
  "a'o",
  "a'u",
  "ai",
  "ai'i",
  "au",
  "ba'a",
  "ba'u",
  "be'u",
  "bi'u",
  "bu'o",
  "ca'e",
  "cai",
  "cu'ei",
  "cu'i",
  "da'i",
  "da'o",
  "dai",
  "do'a",
  "e'a",
  "e'e",
  "e'ei",
  "e'i",
  "e'o",
  "e'u",
  "ei",
  "fu'au",
  "fu'e",
  "fu'i",
  "fu'o",
  "ga'i",
  "ge'e",
  "ia",
  "ie",
  "i'a",
  "i'e",
  "i'i",
  "i'o",
  "i'u",
  "ii",
  "io",
  "iu",
  "ja'o",
  "je'u",
  "ji'a",
  "ji'ei",
  "jo'a",
  "ju'a",
  "ju'o",
  "ju'oi",
  "ka'u",
  "kau",
  "ke'u",
  "ki'a",
  "ko'oi",
  "ku'i",
  "la'a",
  "le'o",
  "li'a",
  "li'o",
  "li'oi",
  "mi'u",
  "mu'a",
  "na'i",
  "o'a",
  "o'e",
  "o'i",
  "o'o",
  "o'u",
  "oi",
  "oi'a",
  "pa'e",
  "pau",
  "pe'a",
  "pe'i",
  "pei",
  "po'o",
  "ra'u",
  "re'e",
  "ri'e",
  "ro'a",
  "ro'e",
  "ro'i",
  "ro'o",
  "ro'u",
  "ru'a",
  "ru'e",
  "sa'a",
  "sa'e",
  "sa'u",
  "sai",
  "se'a",
  "se'i",
  "se'o",
  "sei'i",
  "si'a",
  "si'au",
  "so'ei",
  "su'a",
  "ta'o",
  "ta'u",
  "ti'e",
  "to'u",
  "ua",
  "ue",
  "ue'i",
  "u'a",
  "u'e",
  "u'i",
  "u'o",
  "u'u",
  "ui",
  "uo",
  "uu",
  "va'i",
  "vu'e",
  "xo'o",
  "xu",
  "za'a",
  "zo'o",
  "zu'u",
]);

export function parse(word: string): Reading {
  return parseProfile(word, false);
}
export function parseProfile(word: string, experimental: boolean): Reading {
  return parseProfileMetered(word, experimental).reading;
}
// The optional limit supports the Rust exhaustion tests. Normal calls use 50,000.
export function parseProfileMetered(
  word: string,
  experimental: boolean,
  limit = WORK_LIMIT,
): { reading: Reading; spent: number } {
  const bytes = new TextEncoder().encode(word).length;
  if (bytes > MAX_WORD_BYTES) resource("word bytes", bytes, MAX_WORD_BYTES);
  const chars = Array.from(word);
  const end = chars.length;
  const cache = new LujvoRecognitionCache();
  cache.remaining = limit;
  cache.experimental = experimental;
  let tokens: string[] = [];
  let kind: Kind;
  if (blocks_word_shape(chars, experimental)) kind = "unknown";
  else if (is_gismu_slice(chars, 0, end, experimental)) kind = "gismu";
  else if (is_cmevla_slice(chars, 0, end, experimental)) kind = "cmevla";
  else if (is_cmavo_slice(chars, 0, end)) kind = "cmavo";
  else if (is_lujvo_slice_with_cache(chars, 0, end, cache)) {
    const ranges = lujvo_part_ranges_from_with_cache(
      chars,
      0,
      end,
      false,
      cache,
    );
    if (ranges !== undefined) {
      tokens = ranges.map((range) =>
        chars.slice(range.start, range.end).join(""),
      );
      kind = "lujvo";
    } else kind = "unknown";
  } else if (is_fuhivla_shape_slice_with_cache(chars, 0, end, cache))
    kind = "fuhivla";
  else kind = "unknown";
  if (cache.exhausted) resource("recognition work", cache.spent + 1, limit);
  return { reading: { kind, tokens }, spent: cache.spent };
}
