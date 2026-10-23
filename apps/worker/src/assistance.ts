import type {
  AssistanceBudgetSnapshot,
  AssistanceBudgetStore,
} from "../../../packages/service/src/assistance.ts";

export function workerAssistanceBudgetStore(storage: {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  sync(): Promise<void>;
}): AssistanceBudgetStore {
  const key = "assistance-spending-v1";
  return {
    async load() {
      return (await storage.get<AssistanceBudgetSnapshot>(key)) ?? null;
    },
    async save(snapshot) {
      await storage.put(key, snapshot);
      await storage.sync();
    },
  };
}
