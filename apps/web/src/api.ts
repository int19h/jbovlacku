import {
  canonicalize,
  contentHash,
  utf8,
  verifyEnvelope,
  wordId,
} from "../../../packages/core/src/index.ts";
import type { LocalStore, OutboxItem, Receipt } from "./storage.ts";
export class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  return JSON.parse(
    new TextDecoder().decode(await objectBytes(path, 16777216, options)),
  );
}
async function readBounded(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > limit) {
    void response.body?.cancel().catch(() => {});
    throw new Error("The response exceeds the browser byte limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let onAbort: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      length += value.length;
      if (length > limit)
        throw new Error("The response exceeds the browser byte limit.");
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort!);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
async function objectBytes(
  path: string,
  limit: number,
  options: RequestInit = {},
): Promise<Uint8Array> {
  const signals = [AbortSignal.timeout(20000)];
  if (options.signal) signals.push(options.signal);
  const signal = AbortSignal.any(signals);
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    credentials: "omit",
    signal,
  });
  const bytes = await readBounded(response, limit, signal);
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      message = JSON.parse(new TextDecoder().decode(bytes)).message ?? message;
    } catch {}
    throw new RequestError(response.status, message);
  }
  return bytes;
}
export async function getEnvelope<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const bytes = await objectBytes(path, 20480, options);
  verifyEnvelope(bytes);
  return JSON.parse(canonicalize(bytes));
}
export async function getBody(
  path: string,
  hash: string,
  size: number,
): Promise<unknown> {
  const bytes = utf8(canonicalize(await objectBytes(path, 262144)));
  if (contentHash(bytes) !== hash || bytes.length !== size)
    throw new Error("The definition body did not match its signed hash.");
  return JSON.parse(new TextDecoder().decode(bytes));
}
export async function ownHeads(
  store: LocalStore,
  identity: string,
  offline = false,
  signal?: AbortSignal,
): Promise<string[]> {
  const historyTimeout = AbortSignal.timeout(120000);
  const historySignal = signal
    ? AbortSignal.any([signal, historyTimeout])
    : historyTimeout;
  const expires = performance.now() + 120000;
  const checkHistory = () => {
    historySignal.throwIfAborted();
    if (performance.now() >= expires)
      throw new DOMException(
        "Own history exceeded the browser time limit.",
        "TimeoutError",
      );
  };
  const awaitHistory = async <T>(operation: Promise<T>): Promise<T> => {
    let onAbort: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(historySignal.reason);
      historySignal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      checkHistory();
      return await Promise.race([operation, aborted]);
    } finally {
      historySignal.removeEventListener("abort", onAbort!);
    }
  };
  const workLimit = () =>
    new Error(
      "Own history exceeds the browser work limit. Export the outbox and merge history with the CLI.",
    );
  checkHistory();
  const remembered =
    (await awaitHistory(store.get<string[]>("heads", identity))) ?? [];
  if (!Array.isArray(remembered) || remembered.some((id) => !eventId(id)))
    throw new Error("Saved own-history head IDs are invalid.");
  if (remembered.length > 4096) throw workLimit();
  const known = new Set(remembered);
  const local = new Map(
    (await awaitHistory(store.list<OutboxItem>("outbox")))
      .filter((item) => item.identity === identity)
      .map((item) => [item.id, JSON.parse(item.transport).envelope]),
  );
  const manifest = offline
    ? null
    : await api<{ snapshot: string }>("/manifest", { signal: historySignal });
  if (manifest && !hashId(manifest.snapshot))
    throw new Error("The server returned an invalid own-history snapshot.");
  type OwnEnvelope = {
    id: string;
    header: { issuer: string; previous: string[] };
  };
  const verified = new Map<string, OwnEnvelope>();
  const read = async (id: string): Promise<OwnEnvelope> => {
    checkHistory();
    if (verified.has(id)) return verified.get(id)!;
    if (verified.size >= 4096) throw workLimit();
    const envelope: OwnEnvelope =
      local.get(id) ??
      (manifest
        ? await getEnvelope<OwnEnvelope>(
            `/events/${encodeURIComponent(id)}?snapshot=${encodeURIComponent(manifest.snapshot)}`,
            { signal: historySignal },
          )
        : null);
    if (!envelope)
      throw new Error(
        "This browser has no signed record for a remembered history reference. Connect to retrieve it.",
      );
    verifyEnvelope(utf8(JSON.stringify(envelope)));
    if (envelope.id !== id || envelope.header.issuer !== identity)
      throw new Error("Own history did not match the signing identity.");
    verified.set(id, envelope);
    return envelope;
  };
  let after: string | null = null;
  const cursors = new Set<string>();
  let pages = 0;
  let returnedHeads = 0;
  if (manifest)
    do {
      checkHistory();
      if (++pages > 64) throw workLimit();
      const response: any = JSON.parse(
        new TextDecoder().decode(
          await objectBytes(
            `/identity-heads/${encodeURIComponent(identity)}?snapshot=${encodeURIComponent(manifest.snapshot)}&limit=256${after ? `&after=${encodeURIComponent(after)}` : ""}`,
            65536,
            { signal: historySignal },
          ),
        ),
      );
      if (
        !response ||
        typeof response !== "object" ||
        Array.isArray(response) ||
        response.snapshot !== manifest.snapshot ||
        response.identity !== identity ||
        !Array.isArray(response.heads) ||
        response.heads.length > 256 ||
        response.heads.some((id: unknown) => !eventId(id)) ||
        !(response.next === null || eventId(response.next))
      )
        throw new Error("The server returned an invalid own-history page.");
      if (response.next !== null && cursors.has(response.next))
        throw new Error(
          "Own-history pagination repeated a cursor. Export the outbox or retry with another server.",
        );
      let previous = after ?? "";
      for (const id of response.heads) {
        if (id <= previous)
          throw new Error(
            "Own-history pagination did not advance in event-ID order.",
          );
        previous = id;
      }
      if (
        response.next !== null &&
        (!response.heads.length || response.next !== previous)
      )
        throw new Error(
          "Own-history pagination did not advance to its last returned head.",
        );
      returnedHeads += response.heads.length;
      if (returnedHeads > 4096) throw workLimit();
      for (const id of response.heads) {
        await read(id);
        known.add(id);
        if (known.size > 4096) throw workLimit();
      }
      after = response.next;
      if (after !== null) cursors.add(after);
    } while (after !== null);
  const ancestors = new Set<string>();
  const pending = [...known];
  const visited = new Set<string>();
  while (pending.length) {
    checkHistory();
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const envelope = await read(id);
    if (known.size > 1)
      for (const previous of envelope.header.previous) {
        ancestors.add(previous);
        if (!offline || local.has(previous)) pending.push(previous);
      }
  }
  const frontier = [...known].filter((id) => !ancestors.has(id)).sort();
  if (frontier.length > 64)
    throw new Error(
      "Own history has more than 64 branches. Export the outbox and merge history with the CLI.",
    );
  return frontier;
}
export async function sendItem(
  store: LocalStore,
  item: OutboxItem,
): Promise<OutboxItem> {
  const save = async (next: OutboxItem) => {
    await store.put("outbox", next.id, next);
    return next;
  };
  if (item.state === "stored") return item;
  const acceptReceipt = (receipt: Receipt): OutboxItem => {
    if (
      receipt.id !== item.id ||
      !["accepted", "duplicate", "refused"].includes(receipt.admission) ||
      !["effective", "pending", "suspended", "inert", "unavailable"].includes(
        receipt.interpretation,
      ) ||
      !["none", "present", "missing", "withheld", "invalid"].includes(
        receipt.body_status,
      ) ||
      !Array.isArray(receipt.reasons) ||
      receipt.reasons.some((reason) => typeof reason !== "string")
    )
      throw new Error(
        "The server returned an invalid receipt. Delivery remains unknown.",
      );
    return {
      ...item,
      state: receipt.admission === "refused" ? "refused" : "stored",
      receipt,
      error: undefined,
    };
  };
  try {
    if (item.state === "unknown") {
      try {
        const receipt = await api<Receipt>(
          `/receipts/${encodeURIComponent(item.id)}`,
        );
        return save(acceptReceipt(receipt));
      } catch (error) {
        if (!(error instanceof RequestError && error.status === 404))
          throw error;
      }
    }
    item = await save({ ...item, state: "unknown", error: undefined });
    const receipt = await api<Receipt>("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: item.transport,
    });
    return save(acceptReceipt(receipt));
  } catch (error) {
    const refused =
      error instanceof RequestError &&
      [400, 403, 409, 413, 422, 451].includes(error.status);
    return save({
      ...item,
      state: refused ? "refused" : "unknown",
      error: error instanceof Error ? error.message : "Delivery is unknown.",
    });
  }
}
export interface PackageEntry {
  event: string;
  word: { language: "jbo"; spelling: string };
  language: string;
  glosses: { language: string; text: string; sense: string | null }[];
  plain_text: string;
  classification: { kind: string; selmaho: string[] };
  body: string | null;
}
const PACKAGE_LIMITS = { parts: 128, bytes: 134217728, entries: 200000 };
const hashId = (value: unknown): value is string =>
  typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
const eventId = (value: unknown): value is string =>
  typeof value === "string" && /^jve1:[0-9a-f]{64}$/.test(value);
const languageTag = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 63 &&
  /^[a-z]{1,8}(?:-[a-z0-9]{1,8})*$/.test(value);
function fields(value: unknown, names: string[]): value is Record<string, any> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === names.length &&
    names.every((name) => Object.hasOwn(value, name))
  );
}
const count = (value: unknown, maximum: number): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= maximum;
const invalidPackage = () =>
  new Error(
    "The search package is invalid or exceeds the browser limit. Search this server or download another package.",
  );
function validateEntry(
  value: unknown,
  language: string,
): asserts value is PackageEntry {
  if (
    !fields(value, [
      "event",
      "word",
      "language",
      "glosses",
      "plain_text",
      "classification",
      "body",
    ]) ||
    !eventId(value.event) ||
    value.language !== language ||
    !languageTag(value.language) ||
    !fields(value.word, ["language", "spelling"]) ||
    value.word.language !== "jbo" ||
    typeof value.word.spelling !== "string" ||
    typeof value.plain_text !== "string" ||
    !(value.body === null || hashId(value.body)) ||
    !Array.isArray(value.glosses) ||
    value.glosses.length > 8192 ||
    value.glosses.some(
      (gloss: unknown) =>
        !fields(gloss, ["language", "text", "sense"]) ||
        !languageTag(gloss.language) ||
        typeof gloss.text !== "string" ||
        !(gloss.sense === null || typeof gloss.sense === "string"),
    ) ||
    !fields(value.classification, ["kind", "selmaho"]) ||
    ![
      "gismu",
      "cmavo",
      "lujvo",
      "fuivla",
      "cmevla",
      "compound",
      "letteral",
      "other",
    ].includes(value.classification.kind) ||
    !Array.isArray(value.classification.selmaho) ||
    value.classification.selmaho.some(
      (item: unknown) => typeof item !== "string",
    )
  )
    throw invalidPackage();
  try {
    wordId({ language: "jbo", spelling: value.word.spelling });
  } catch {
    throw invalidPackage();
  }
}
export function validateCachedPackage(
  value: unknown,
  language: string,
): asserts value is { snapshot: string; entries: PackageEntry[] } {
  if (
    !fields(value, ["snapshot", "entries"]) ||
    !hashId(value.snapshot) ||
    !Array.isArray(value.entries) ||
    value.entries.length > PACKAGE_LIMITS.entries
  )
    throw invalidPackage();
  let previous = "";
  for (const entry of value.entries) {
    validateEntry(entry, language);
    if (entry.event <= previous) throw invalidPackage();
    previous = entry.event;
  }
}
export async function downloadPackage(
  language: string,
): Promise<{ snapshot: string; entries: PackageEntry[] }> {
  const deadline = AbortSignal.timeout(120000);
  const manifest = await api<any>("/manifest", { signal: deadline });
  if (
    !manifest ||
    !hashId(manifest.snapshot) ||
    !Array.isArray(manifest.packages) ||
    manifest.packages.length > 4096
  )
    throw invalidPackage();
  for (const descriptor of manifest.packages) {
    if (
      !fields(descriptor, ["language", "hash", "bytes"]) ||
      !languageTag(descriptor.language) ||
      !hashId(descriptor.hash) ||
      !count(descriptor.bytes, 1048576)
    )
      throw invalidPackage();
  }
  const advertised = manifest.packages.filter(
    (p: any) => p.language === language,
  );
  if (!advertised.length)
    throw new Error("This server offers no search package for that language.");
  if (advertised.length !== 1) throw invalidPackage();
  const raw = await objectBytes(
    `/packages/${encodeURIComponent(language)}?snapshot=${encodeURIComponent(manifest.snapshot)}`,
    1048576,
    { signal: deadline },
  );
  if (
    raw.length !== advertised[0].bytes ||
    contentHash(raw) !== advertised[0].hash
  )
    throw new Error(
      "The search package hash did not match. Search this server or download another package.",
    );
  const pkg = JSON.parse(canonicalize(raw));
  if (
    !fields(pkg, ["version", "language", "snapshot", "parts"]) ||
    pkg.version !== 1 ||
    pkg.language !== language ||
    pkg.snapshot !== manifest.snapshot ||
    !Array.isArray(pkg.parts) ||
    pkg.parts.length > PACKAGE_LIMITS.parts
  )
    throw invalidPackage();
  let totalBytes = 0;
  let totalEntries = 0;
  const hashes = new Set<string>();
  for (const part of pkg.parts) {
    if (
      !fields(part, ["hash", "bytes", "count"]) ||
      !hashId(part.hash) ||
      !count(part.bytes, 4194304) ||
      part.bytes < 2 ||
      !count(part.count, 2000) ||
      hashes.has(part.hash)
    )
      throw invalidPackage();
    hashes.add(part.hash);
    totalBytes += part.bytes;
    totalEntries += part.count;
    if (
      totalBytes > PACKAGE_LIMITS.bytes ||
      totalEntries > PACKAGE_LIMITS.entries
    )
      throw invalidPackage();
  }
  const entries: PackageEntry[] = [];
  let previous = "";
  for (const part of pkg.parts) {
    const bytes = await objectBytes(
      `/package-parts/${encodeURIComponent(part.hash)}`,
      4194304,
      { signal: deadline },
    );
    if (bytes.length !== part.bytes || contentHash(bytes) !== part.hash)
      throw new Error(
        "The search part hash did not match. Search this server or download another package.",
      );
    const data = JSON.parse(canonicalize(bytes));
    if (!Array.isArray(data) || data.length !== part.count)
      throw invalidPackage();
    for (const entry of data) {
      validateEntry(entry, language);
      if (entry.event <= previous) throw invalidPackage();
      previous = entry.event;
      entries.push(entry);
    }
  }
  return { snapshot: manifest.snapshot, entries };
}
