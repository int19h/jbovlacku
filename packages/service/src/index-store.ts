import type { SearchEntry } from "./packages.ts";
export interface IndexStore {
  replace(snapshot: string, entries: SearchEntry[]): Promise<void>;
  reuse?(previous: string, snapshot: string): Promise<void>;
  publish?(snapshot: string): Promise<void>;
  restore?(snapshot: string, entries: SearchEntry[]): Promise<void>;
}

export const UPSERT_SEARCH_ENTRY =
  "INSERT INTO search_entries VALUES(?,?,?) ON CONFLICT(snapshot,event) DO UPDATE SET value=excluded.value";
