/**
 * Length and count bounds for the row fields of a server search preview.
 * The server applies them before it sends a page, and the browser applies
 * the same rule to what it receives. The format allows any string length in
 * these fields, so one long value must never cost a whole page: a value over
 * its bound is dropped or shortened, and the hit stays.
 *
 * Lengths count UTF-16 code units.
 */
export const PREVIEW_RAFSI_COUNT = 16;
export const PREVIEW_RAFSI_LENGTH = 64;
export const PREVIEW_SELMAHO_COUNT = 8;
export const PREVIEW_SELMAHO_LENGTH = 32;
/** The bound for the attribution source, author and account origin. */
export const PREVIEW_ATTRIBUTION_LENGTH = 256;
export const PREVIEW_DATE_COUNT = 8;
export const PREVIEW_DATE_LABEL_LENGTH = 32;
export const PREVIEW_DATE_VALUE_LENGTH = 64;

export interface PreviewAttribution {
  source: string;
  author: string | null;
  account: { origin: string; account: number } | null;
  dates: Record<string, string>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The string items of a list that fit `length`, at most `count` of them, in
 * their order. An item that is too long is dropped. Undefined when the value
 * is not a list.
 */
export function boundedPreviewList(
  value: unknown,
  count: number,
  length: number,
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  for (const item of value) {
    if (result.length === count) break;
    if (typeof item === "string" && item.length <= length) result.push(item);
  }
  return result;
}

/**
 * The text, or its first part followed by "…" when it is longer than
 * `limit`. The result is never longer than `limit` and never ends inside a
 * surrogate pair.
 */
export function shortenedPreviewText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = limit - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end) + "…";
}

/**
 * The attribution within the preview bounds. The source and author are
 * shortened. An account whose origin is too long becomes null. A date entry
 * whose label or value is too long is dropped, and at most
 * `PREVIEW_DATE_COUNT` entries stay in their order. Null stays null.
 * Undefined means the value does not have the attribution shape.
 */
export function boundedPreviewAttribution(
  value: unknown,
): PreviewAttribution | null | undefined {
  if (value === null) return null;
  if (!isObject(value) || typeof value.source !== "string") return undefined;
  const author = value.author;
  if (author !== null && typeof author !== "string") return undefined;
  const account = value.account;
  if (
    account !== null &&
    !(
      isObject(account) &&
      typeof account.origin === "string" &&
      Number.isSafeInteger(account.account)
    )
  )
    return undefined;
  if (!isObject(value.dates)) return undefined;
  // Object.fromEntries defines own properties, so a "__proto__" label stays
  // an ordinary date label.
  const kept: [string, string][] = [];
  for (const [label, date] of Object.entries(value.dates)) {
    if (kept.length === PREVIEW_DATE_COUNT) break;
    if (
      label.length <= PREVIEW_DATE_LABEL_LENGTH &&
      typeof date === "string" &&
      date.length <= PREVIEW_DATE_VALUE_LENGTH
    )
      kept.push([label, date]);
  }
  const dates: Record<string, string> = Object.fromEntries(kept);
  return {
    source: shortenedPreviewText(value.source, PREVIEW_ATTRIBUTION_LENGTH),
    author:
      author === null
        ? null
        : shortenedPreviewText(author, PREVIEW_ATTRIBUTION_LENGTH),
    account:
      account === null ||
      (account.origin as string).length > PREVIEW_ATTRIBUTION_LENGTH
        ? null
        : {
            origin: account.origin as string,
            account: account.account as number,
          },
    dates,
  };
}
