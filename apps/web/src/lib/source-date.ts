import { monthYear } from "./format.ts";

/** Source dates describe the source row. They do not date the importer's signature. */
export function sourceDate(body: { legacy: unknown } | null): string | null {
  const legacy = body?.legacy as {
    attribution?: { dates?: Record<string, string | null> };
  } | null;
  if (!legacy) return null;
  const dates = legacy.attribution?.dates ?? {};
  // SQL time is the source edit time. created_at can be a later database migration.
  if (typeof dates.time === "string" && /^(0|[1-9][0-9]*)$/.test(dates.time)) {
    const seconds = Number(dates.time);
    const date = new Date(seconds * 1000);
    if (Number.isSafeInteger(seconds) && Number.isFinite(date.getTime()))
      return monthYear(date);
  }
  for (const value of [
    dates.created_at,
    dates.created,
    dates.updated_at,
    dates.updated,
  ]) {
    if (typeof value !== "string") continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return monthYear(new Date(parsed));
  }
  return null;
}
