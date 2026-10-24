import type { SearchEntry } from "./packages.ts";
export interface IndexStore {
  replace(snapshot: string, entries: SearchEntry[]): Promise<void>;
  /** False means the source generation is absent and entries must be replaced. */
  reuse?(previous: string, snapshot: string): Promise<boolean | void>;
  publish?(snapshot: string, required?: readonly string[]): Promise<void>;
  restore?(snapshot: string, entries: SearchEntry[]): Promise<void>;
}

export const UPSERT_SEARCH_ENTRY =
  "INSERT INTO search_entries VALUES(?,?,?) ON CONFLICT(snapshot,event) DO UPDATE SET value=excluded.value";
