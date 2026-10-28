import type {
  AssistanceBudgetSnapshot,
  AssistanceBudgetStore,
} from "../../../packages/service/src/assistance.ts";

interface BudgetTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}
interface BudgetStorage extends BudgetTransaction {
  transaction<T>(
    operation: (transaction: BudgetTransaction) => Promise<T>,
  ): Promise<T>;
  sync(): Promise<void>;
}

// Binary parts leave room for structured-clone overhead below 128 KiB.
const PART_BYTES = 64 * 1024;
// Escaped 128-character IDs can take six JSON bytes per character.
const MAX_BYTES = 32 * 1024 * 1024;
const MANIFEST_KEY = "assistance-spending-manifest-v1";
const LEGACY_KEY = "assistance-spending-v1";
const partKey = (index: number) => `assistance-spending-part-v1:${index}`;
interface Manifest {
  version: 1;
  parts: number;
  bytes: number;
  sha256: string;
}
function manifest(value: unknown): Manifest {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).sort().join(",") !== "bytes,parts,sha256,version"
  )
    throw new Error("The spending storage manifest is invalid.");
  const result = value as Manifest;
  if (
    result.version !== 1 ||
    !Number.isSafeInteger(result.bytes) ||
    result.bytes < 1 ||
    result.bytes > MAX_BYTES ||
    result.parts !== Math.ceil(result.bytes / PART_BYTES) ||
    typeof result.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(result.sha256)
  )
    throw new Error("The spending storage manifest is invalid.");
  return result;
}
async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function workerAssistanceBudgetStore(
  storage: BudgetStorage,
): AssistanceBudgetStore {
  return {
    async load() {
      return storage.transaction(async (transaction) => {
        const stored = await transaction.get<unknown>(MANIFEST_KEY);
        if (stored === undefined) {
          if ((await transaction.get(partKey(0))) !== undefined)
            throw new Error("The spending storage manifest is missing.");
          return (
            (await transaction.get<AssistanceBudgetSnapshot>(LEGACY_KEY)) ??
            null
          );
        }
        const metadata = manifest(stored);
        const bytes = new Uint8Array(metadata.bytes);
        for (let index = 0; index < metadata.parts; index++) {
          const part = await transaction.get<unknown>(partKey(index));
          const expected = Math.min(
            PART_BYTES,
            metadata.bytes - index * PART_BYTES,
          );
          if (!(part instanceof Uint8Array) || part.byteLength !== expected)
            throw new Error("A spending storage part is missing or invalid.");
          bytes.set(part, index * PART_BYTES);
        }
        if ((await digest(bytes)) !== metadata.sha256)
          throw new Error("The spending storage checksum does not match.");
        try {
          return JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          );
        } catch {
          throw new Error("The spending storage snapshot is invalid.");
        }
      });
    },
    async save(snapshot) {
      const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
      if (bytes.byteLength > MAX_BYTES)
        throw new Error(
          "The spending storage snapshot exceeds its size limit.",
        );
      const metadata: Manifest = {
        version: 1,
        parts: Math.ceil(bytes.byteLength / PART_BYTES),
        bytes: bytes.byteLength,
        sha256: await digest(bytes),
      };
      await storage.transaction(async (transaction) => {
        const previous = await transaction.get<unknown>(MANIFEST_KEY);
        const oldParts = previous === undefined ? 0 : manifest(previous).parts;
        for (let index = 0; index < metadata.parts; index++)
          await transaction.put(
            partKey(index),
            bytes.slice(index * PART_BYTES, (index + 1) * PART_BYTES),
          );
        for (let index = metadata.parts; index < oldParts; index++)
          await transaction.delete(partKey(index));
        await transaction.put(MANIFEST_KEY, metadata);
        await transaction.delete(LEGACY_KEY);
      });
      await storage.sync();
    },
  };
}
