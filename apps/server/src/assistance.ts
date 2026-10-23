import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  normalizeClientNetwork,
  providerConfig,
} from "../../../packages/service/src/inference.ts";
import type {
  AssistanceBudgetSnapshot,
  AssistanceBudgetStore,
  AssistanceOptions,
} from "../../../packages/service/src/assistance.ts";

export class SqliteAssistanceBudgetStore implements AssistanceBudgetStore {
  private database: DatabaseSync;
  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS assistance_budget(id INTEGER PRIMARY KEY CHECK(id=1), snapshot TEXT NOT NULL)",
    );
  }
  async load(): Promise<AssistanceBudgetSnapshot | null> {
    const row = this.database
      .prepare("SELECT snapshot FROM assistance_budget WHERE id=1")
      .get();
    return row ? JSON.parse(String(row.snapshot)) : null;
  }
  async save(snapshot: AssistanceBudgetSnapshot): Promise<void> {
    this.database
      .prepare(
        "INSERT INTO assistance_budget VALUES(1,?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot",
      )
      .run(JSON.stringify(snapshot));
  }
  close(): void {
    this.database.close();
  }
}

export function trustedProxyAddresses(value: string): string[] {
  const addresses = value
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);
  if (addresses.some((address) => !normalizeClientNetwork(address)))
    throw new Error(
      "JVC_TRUSTED_PROXY_ADDRESSES must contain exact IP addresses.",
    );
  return addresses;
}

export function nodeAssistance(
  env: Record<string, string | undefined>,
  budgetStore?: AssistanceBudgetStore,
): AssistanceOptions {
  if (env.JVC_AI_ENABLED !== "enabled") return {};
  if (!budgetStore)
    throw new Error("AI assistance requires a durable spending store.");
  if (!env.JVC_AI_KEY_FILE)
    throw new Error(
      "JVC_AI_KEY_FILE is required when AI assistance is enabled.",
    );
  const path = env.JVC_AI_KEY_FILE;
  return {
    budgetStore,
    provider: providerConfig(env, async () => {
      try {
        return await readFile(path, "utf8");
      } catch {
        throw new Error("The configured AI key file is unavailable.");
      }
    }),
  };
}
