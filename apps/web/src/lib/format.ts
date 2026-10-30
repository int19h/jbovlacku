/** Display formatting. These functions change presentation only, never stored values. */
export interface Rational {
  numerator: string | number;
  denominator: string | number;
}
export type Interval = [Rational, Rational];

const big = (value: string | number) => BigInt(value);
export function rationalEquals(a: Rational, b: Rational) {
  return (
    big(a.numerator) * big(b.denominator) ===
    big(b.numerator) * big(a.denominator)
  );
}
export function rationalSign(value: Rational): -1 | 0 | 1 {
  const n = big(value.numerator);
  return n === 0n ? 0 : n < 0n ? -1 : 1;
}
/** Exact fraction text, such as "3/2" or "-1/4". Integers drop the denominator. */
export function fractionText(value: Rational): string {
  const n = big(value.numerator);
  const d = big(value.denominator);
  if (d === 1n) return n.toString();
  return `${n}/${d}`;
}
/**
 * Short decimal text with enough precision to show a nonzero value.
 * The exact fraction remains available through fractionText.
 */
export function decimalText(value: Rational, digits = 2): string {
  const n = big(value.numerator);
  const d = big(value.denominator);
  if (n === 0n) return "0";
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const whole = abs / d;
  let remainder = abs % d;
  if (remainder === 0n) return `${negative ? "−" : ""}${whole}`;
  let fraction = "";
  for (let i = 0; i < digits; i++) {
    remainder *= 10n;
    fraction += (remainder / d).toString();
    remainder %= d;
  }
  if (whole === 0n && /^0+$/.test(fraction)) {
    // The exact value is nonzero but rounds to zero at this precision.
    // Extend precision until a nonzero digit appears, up to twelve digits.
    let extended = fraction;
    let rest = remainder;
    while (extended.length < 12 && /^0+$/.test(extended)) {
      rest *= 10n;
      extended += (rest / d).toString();
      rest %= d;
    }
    if (/^0+$/.test(extended)) return `${negative ? "−" : "+"}<0.000000000001`;
    fraction = extended;
  }
  fraction = fraction.replace(/0+$/, "");
  return `${negative ? "−" : ""}${whole}${fraction ? "." + fraction : ""}`;
}
export function intervalIsExact(interval: Interval) {
  return rationalEquals(interval[0], interval[1]);
}
export interface Score {
  target: string;
  support: Interval;
  opposition: Interval;
  net: Interval;
  direct_reviewers: number;
  status: string;
}
export interface ScoreHeadline {
  text: string;
  label: string;
  title: string;
  exact: boolean;
  unavailable: boolean;
}
/** The headline number and its accessible description. */
export function scoreHeadline(score: Score | null | undefined): ScoreHeadline {
  if (!score) {
    return {
      text: "—",
      label: "Score unavailable",
      title: "Score unavailable. No numeric score is assumed.",
      exact: false,
      unavailable: true,
    };
  }
  const exact = intervalIsExact(score.net);
  const reviewers = `${score.direct_reviewers} reviewer${score.direct_reviewers === 1 ? "" : "s"}`;
  if (exact) {
    const value = score.net[0];
    const text = decimalText(value);
    const support = decimalText(score.support[0]);
    const opposition = decimalText(score.opposition[0]);
    if (score.direct_reviewers === 0 && rationalSign(value) === 0)
      return {
        text: "0",
        label: "Score 0, no judgments yet",
        title: "No judgments yet",
        exact: true,
        unavailable: false,
      };
    const spoken = text.replace("−", "minus ");
    return {
      text,
      label: `Score ${spoken}: ${support} for, ${opposition} against, ${reviewers}`,
      title: `Score ${text}: ${support} for, ${opposition} against, ${reviewers}. Exact value ${fractionText(value)}.`,
      exact: true,
      unavailable: false,
    };
  }
  const low = decimalText(score.net[0]);
  const high = decimalText(score.net[1]);
  return {
    text: `${low}…${high}`,
    label: `Score between ${low.replace("−", "minus ")} and ${high.replace("−", "minus ")}, order unresolved, ${reviewers}`,
    title: `Bounded score from ${fractionText(score.net[0])} to ${fractionText(score.net[1])}. Support ${fractionText(score.support[0])} to ${fractionText(score.support[1])}, opposition ${fractionText(score.opposition[0])} to ${fractionText(score.opposition[1])}, ${reviewers}.`,
    exact: false,
    unavailable: false,
  };
}
/** "ed25519 3f9a 61e0 …" grouped for reading. Display only. */
export function fingerprintText(identity: string): string {
  const [prefix, hex] = identity.split(":");
  if (!hex) return identity;
  return `${prefix} ${hex.match(/.{1,4}/g)!.join(" ")}`;
}
/** A short fallback name when no profile name is known. */
export function shortIdentity(identity: string): string {
  const hex = identity.split(":")[1] ?? identity;
  return `${hex.slice(0, 4)}…${hex.slice(-4)}`;
}
export function shortEvent(id: string): string {
  const hex = id.split(":")[1] ?? id;
  return `${id.split(":")[0]}:${hex.slice(0, 8)}…`;
}
const monthNames = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
/** "Sep 2024" for list dates. */
export function monthYear(date: Date): string {
  return `${monthNames[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}
/** "Oct 10" for activity dates within the current year, else "Oct 10, 2025". */
export function dayMonth(date: Date, now = new Date()): string {
  const base = `${monthNames[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === now.getFullYear()
    ? base
    : `${base}, ${date.getFullYear()}`;
}
export function clockTime(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}
/** Relative duration text for retry schedules, such as "in 2 minutes". */
export function inDuration(milliseconds: number): string {
  if (milliseconds <= 1000) return "now";
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `in ${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `in ${hours} hour${hours === 1 ? "" : "s"}`;
}
export function plural(
  count: number,
  singular: string,
  pluralForm = `${singular}s`,
) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
const languageNames = new Intl.DisplayNames(["en"], { type: "language" });
export function languageName(tag: string): string {
  try {
    const name = languageNames.of(tag);
    return name && name !== tag ? name : tag;
  } catch {
    return tag;
  }
}
export { placeDisplay as placeGlyph } from "../model/place-glyphs.ts";
