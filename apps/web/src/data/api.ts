/**
 * Typed HTTP client for one dictionary peer. Every response is bounded,
 * validated, and authenticated where the format permits.
 */
import { describeProfile } from "../model/profiles.ts";
import {
  STATE_EXPORT_VERSION,
  canonicalize,
  contentHash,
  inspectBody,
  interpretDefinition,
  utf8,
  verifyEnvelope,
} from "../../../../packages/core/src/browser.ts";
import {
  PREVIEW_RAFSI_COUNT,
  PREVIEW_RAFSI_LENGTH,
  PREVIEW_SELMAHO_COUNT,
  PREVIEW_SELMAHO_LENGTH,
  boundedPreviewAttribution,
  boundedPreviewList,
} from "../../../../packages/search/src/preview-row.ts";
import {
  eventId,
  hashId,
  identityId,
  languageTag,
  matchKinds,
  wordIdValid,
  type AccountControlResponse,
  type AccountKey,
  type PublicationStatus,
  type ActivityResponse,
  type Capabilities,
  type DefinitionBody,
  type IdentityResponse,
  type Envelope,
  type Manifest,
  type Receipt,
  type SearchHit,
  type SearchResponse,
  type WordResponse,
} from "../model/types.ts";

export class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string | null = null,
    public retryAfterMs: number | null = null,
    /** The absolute time from Retry-After, fixed when the headers arrived. */
    public retryAt: number | null = retryAfterMs === null
      ? null
      : Date.now() + retryAfterMs,
  ) {
    super(message);
  }
}
/** A network or timeout failure where the request outcome is unknown. */
export class TransportError extends Error {
  constructor(
    message: string,
    public kind: "offline" | "timeout",
  ) {
    super(message);
  }
}
export interface Peer {
  id: string;
  /** API base, such as "/api/v1" for the serving origin. */
  base: string;
  label: string;
}
export const selfPeer: Peer = {
  id: "self",
  base: "/api/v1",
  label: location.host || "this server",
};

/** A response body that is larger than the reader allows. */
export class ByteLimitError extends Error {
  constructor() {
    super("The response exceeds the browser byte limit.");
  }
}
export async function readBounded(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > limit) {
    void response.body?.cancel().catch(() => {});
    throw new ByteLimitError();
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let onAbort: () => void = () => {};
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
      if (length > limit) throw new ByteLimitError();
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
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
export interface RequestOptions extends RequestInit {
  peer?: Peer;
  timeoutMs?: number;
}
/**
 * The absolute Retry-After deadline. Seconds count from `received`, the time
 * the headers arrived. A date is already absolute. An unrepresentable or
 * malformed value gives null, so ordinary backoff applies.
 */
export function retryDeadline(
  value: string | null,
  received: number,
): number | null {
  if (!value) return null;
  const at = /^\d+$/.test(value.trim())
    ? received + Number(value.trim()) * 1000
    : Date.parse(value);
  return Number.isSafeInteger(at) ? Math.max(at, received) : null;
}
export async function objectBytes(
  path: string,
  limit: number,
  options: RequestOptions = {},
): Promise<Uint8Array> {
  const peer = options.peer ?? selfPeer;
  const signals = [AbortSignal.timeout(options.timeoutMs ?? 20000)];
  if (options.signal) signals.push(options.signal);
  const signal = AbortSignal.any(signals);
  let response: Response;
  try {
    signal.throwIfAborted();
    response = await fetch(`${peer.base}${path}`, {
      ...options,
      credentials: "omit",
      signal,
    });
  } catch (error) {
    // A quota failure is a physical failure, not a lost connection. It keeps
    // its own error so package downloads can report it as running out of room.
    if ((error as { name?: string } | null)?.name === "QuotaExceededError")
      throw error;
    if ((error as { name?: string } | null)?.name === "TimeoutError")
      throw new TransportError("The server did not answer in time.", "timeout");
    if (options.signal?.aborted) throw error;
    throw new TransportError("No connection to the server.", "offline");
  }
  // Fix the server's deadline when the headers arrive. A later body failure
  // keeps it.
  const received = Date.now();
  const retryAt = retryDeadline(response.headers.get("retry-after"), received);
  let bytes: Uint8Array;
  try {
    bytes = await readBounded(response, limit, signal);
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    if (name === "QuotaExceededError") throw error;
    if (response.ok) {
      if (name === "TimeoutError")
        throw new TransportError(
          "The server did not answer in time.",
          "timeout",
        );
      if (options.signal?.aborted) throw error;
      if (error instanceof TypeError)
        throw new TransportError("No connection to the server.", "offline");
      throw error;
    }
    // An error answer keeps its status and deadline when its body is too
    // large, interrupted or late. The body is discarded, and the error uses
    // the plain status message. A damaged body never proves acceptance.
    if (name !== "TimeoutError" && options.signal?.aborted) throw error;
    bytes = new Uint8Array();
  }
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    let code: string | null = null;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      if (typeof parsed.message === "string") message = parsed.message;
      if (typeof parsed.code === "string") code = parsed.code;
    } catch {}
    throw new RequestError(
      response.status,
      message,
      code,
      retryAt === null ? null : Math.max(0, retryAt - received),
      retryAt,
    );
  }
  return bytes;
}
export async function api<T = unknown>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  return JSON.parse(
    new TextDecoder().decode(await objectBytes(path, 16777216, options)),
  ) as T;
}
/** Fetches and verifies one signed envelope. */
export async function getEnvelope(
  id: string,
  snapshot?: string,
  options: RequestOptions = {},
): Promise<Envelope> {
  const bytes = await objectBytes(
    `/events/${encodeURIComponent(id)}${snapshot ? `?snapshot=${encodeURIComponent(snapshot)}` : ""}`,
    20480,
    options,
  );
  verifyEnvelope(bytes);
  const envelope = JSON.parse(canonicalize(bytes)) as Envelope;
  if (envelope.id !== id)
    throw new Error("The returned event does not match this link.");
  return envelope;
}
/** Fetches a body and compares its hash and byte length with the signed header. */
export async function getBody(
  hash: string,
  size: number,
  snapshot?: string,
  options: RequestOptions = {},
): Promise<unknown> {
  const bytes = utf8(
    canonicalize(
      await objectBytes(
        `/bodies/${encodeURIComponent(hash)}${snapshot ? `?snapshot=${encodeURIComponent(snapshot)}` : ""}`,
        262144,
        options,
      ),
    ),
  );
  if (contentHash(bytes) !== hash || bytes.length !== size)
    throw new Error("The body did not match its signed hash.");
  return JSON.parse(new TextDecoder().decode(bytes));
}
export interface LoadedRecord<B = unknown> {
  envelope: Envelope;
  body: B | null;
  /** Original authenticated JSON, before definition defaults. */
  rawBody: unknown | null;
  /** Why the body is unavailable, when it is. */
  bodyError: string | null;
}
const recordCache = new Map<string, Promise<LoadedRecord>>();
/** Loads an envelope and its body and checks the body against the action rules. */
export function loadRecord<B = unknown>(
  id: string,
  snapshot?: string,
  options: RequestOptions = {},
): Promise<LoadedRecord<B>> {
  const key = `${options.peer?.id ?? "self"}|${snapshot ?? ""}|${id}`;
  let pending = recordCache.get(key);
  if (!pending) {
    pending = (async () => {
      const envelope = await getEnvelope(id, snapshot, options);
      let body: unknown = null;
      let bodyError: string | null = null;
      let rawBody: unknown = null;
      if (envelope.header.content) {
        try {
          body = await getBody(
            envelope.header.content.hash,
            envelope.header.content.bytes,
            snapshot,
            options,
          );
          const inspected = inspectBody(
            utf8(JSON.stringify(envelope)),
            utf8(canonicalize(utf8(JSON.stringify(body)))),
          );
          if (inspected.availability !== "valid")
            throw new Error(
              "This signed body does not satisfy the format rules. Its content is unavailable.",
            );
          rawBody = body;
          if (envelope.header.action.kind === "definition.publish")
            body = interpretDefinition(body);
        } catch (error) {
          body = null;
          bodyError =
            error instanceof Error ? error.message : "The body is unavailable.";
          // A missing body in an immutable snapshot stays missing there.
          // Other failures, and unpinned absence, can recover on the next read.
          const snapshotAbsence =
            snapshot &&
            error instanceof RequestError &&
            error.status === 404 &&
            error.code === "missing";
          if (!snapshotAbsence && recordCache.get(key) === pending)
            recordCache.delete(key);
        }
      }
      return { envelope, body, rawBody, bodyError };
    })();
    recordCache.set(key, pending);
    pending.catch(() => {
      if (recordCache.get(key) === pending) recordCache.delete(key);
    });
  }
  return pending as Promise<LoadedRecord<B>>;
}
export const loadDefinition = (
  id: string,
  snapshot?: string,
  options: RequestOptions = {},
) => loadRecord<DefinitionBody>(id, snapshot, options);
export function clearRecordCache() {
  recordCache.clear();
}

/* Response validation */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function validateReceipt(value: unknown): Receipt {
  if (
    !isObject(value) ||
    !eventId(value.id) ||
    !["accepted", "duplicate", "refused"].includes(String(value.admission)) ||
    !["effective", "pending", "suspended", "inert", "unavailable"].includes(
      String(value.interpretation),
    ) ||
    !["none", "present", "missing", "withheld", "invalid"].includes(
      String(value.body_status),
    ) ||
    !Array.isArray(value.reasons) ||
    value.reasons.some((reason) => typeof reason !== "string") ||
    !(value.cursor === null || typeof value.cursor === "string") ||
    !(value.snapshot === null || hashId(value.snapshot)) ||
    typeof value.view !== "string"
  )
    throw new Error(
      "The server returned an invalid receipt. Delivery remains unknown.",
    );
  return value as unknown as Receipt;
}
export async function getReceipt(id: string, options: RequestOptions = {}) {
  return validateReceipt(
    await api(`/receipts/${encodeURIComponent(id)}`, options),
  );
}
// This page session tracks only records whose local delivery it confirmed.
const acceptedAwaitingView = new Map<string, Receipt>();
export const viewPending = (receipt: Receipt) =>
  receipt.reasons.some((reason) =>
    ["index_lag", "evaluation_pending"].includes(reason),
  );
export const localPeer = (peer: Peer = selfPeer) =>
  peer.id === selfPeer.id &&
  new URL(peer.base, location.origin).href.replace(/\/$/, "") ===
    new URL(selfPeer.base, location.origin).href.replace(/\/$/, "");

/** Call only after delivery confirms the signed envelope and required body. */
export function rememberAcceptedReceipt(receipt: Receipt, peer: Peer) {
  if (!localPeer(peer)) return false;
  if (viewPending(receipt)) {
    acceptedAwaitingView.set(receipt.id, receipt);
    return true;
  } else {
    const pending = acceptedAwaitingView.get(receipt.id);
    if (
      receipt.snapshot !== null &&
      pending?.envelope_hash === receipt.envelope_hash &&
      pending?.body_hash === receipt.body_hash &&
      pending?.body_status === receipt.body_status &&
      pending?.cursor === receipt.cursor
    )
      acceptedAwaitingView.delete(receipt.id);
  }
  return false;
}
export function hasPendingMaterialization() {
  return acceptedAwaitingView.size > 0;
}
export class MaterializationPendingError extends Error {
  constructor() {
    super(
      "This server stored your records. Its view is still updating. Refresh this page to check again.",
    );
  }
}
/** Exact representation and admission position confirmed by both receipts. */
export function receiptBindingMatches(receipt: Receipt, accepted: Receipt) {
  return (
    receipt.id === accepted.id &&
    receipt.admission !== "refused" &&
    receipt.envelope_hash === accepted.envelope_hash &&
    receipt.body_hash === accepted.body_hash &&
    receipt.body_status === accepted.body_status &&
    receipt.cursor === accepted.cursor
  );
}
/** Clear only the exact admission binding with saved completion evidence. */
export function forgetMaterializedReceipt(accepted: Receipt) {
  const pending = acceptedAwaitingView.get(accepted.id);
  if (pending && receiptBindingMatches(accepted, pending))
    acceptedAwaitingView.delete(accepted.id);
}
export function receiptMaterialized(receipt: Receipt, accepted: Receipt) {
  return (
    receiptBindingMatches(receipt, accepted) &&
    receipt.snapshot !== null &&
    !viewPending(receipt)
  );
}
/** Network failures, timeouts, rate limits, and server errors can resolve within the deadline. */
export function transientReceiptFailure(error: unknown) {
  return (
    error instanceof TransportError ||
    (error instanceof RequestError &&
      (error.status === 408 ||
        error.status === 429 ||
        (error.status >= 500 && error.status < 600)))
  );
}
/** Wait for local accepted records, without changing their delivery state. */
export async function waitForMaterialization(
  options: RequestOptions,
  wait: {
    completed?: (accepted: Receipt) => Promise<void>;
    unconfirmable?: (accepted: Receipt) => Promise<void>;
    receipts?: ReadonlySet<Receipt>;
    signal?: AbortSignal;
  } = {},
) {
  const selected = () =>
    [...acceptedAwaitingView].filter(
      ([, receipt]) =>
        !wait.receipts ||
        [...wait.receipts].some((accepted) =>
          receiptBindingMatches(receipt, accepted),
        ),
    );
  if (!localPeer(options.peer) || !selected().length) return;
  const signal =
    wait.signal ??
    AbortSignal.any([
      AbortSignal.timeout(15000),
      ...(options.signal ? [options.signal] : []),
    ]);
  try {
    while (selected().length) {
      signal.throwIfAborted();
      // At most four receipt reads share this round's deadline.
      const batch = selected();
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, batch.length) }, async () => {
          for (;;) {
            signal.throwIfAborted();
            const entry = batch[next++];
            if (!entry) return;
            const [id, accepted] = entry;
            let receipt: Receipt;
            try {
              receipt = await getReceipt(id, {
                ...options,
                signal,
                cache: "no-store",
              });
            } catch (error) {
              signal.throwIfAborted();
              if (transientReceiptFailure(error)) continue;
              if (wait.unconfirmable) {
                await wait.unconfirmable(accepted);
                forgetMaterializedReceipt(accepted);
                continue;
              }
              throw error;
            }
            if (
              receiptMaterialized(receipt, accepted) &&
              acceptedAwaitingView.get(id) === accepted
            ) {
              await wait.completed?.(accepted);
              signal.throwIfAborted();
              if (acceptedAwaitingView.get(id) === accepted)
                acceptedAwaitingView.delete(id);
            } else if (
              wait.unconfirmable &&
              (!receiptBindingMatches(receipt, accepted) ||
                !viewPending(receipt))
            ) {
              await wait.unconfirmable(accepted);
              forgetMaterializedReceipt(accepted);
            }
          }
        }),
      );
      if (!selected().length) return;
      await new Promise<void>((resolve, reject) => {
        const aborted = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", aborted);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", aborted);
          resolve();
        }, 200);
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
      });
    }
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new MaterializationPendingError();
  }
}
export async function getCapabilities(
  options: RequestOptions = {},
): Promise<Capabilities> {
  const value = await api<unknown>("/capabilities", options);
  if (
    !isObject(value) ||
    !isObject(value.features) ||
    typeof value.server_id !== "string"
  )
    throw new Error("The server returned invalid capabilities.");
  return value as unknown as Capabilities;
}
export async function getManifest(
  options: RequestOptions & { fresh?: boolean } = {},
): Promise<Manifest> {
  if (options.fresh) await waitForMaterialization(options);
  const value = await api<unknown>("/manifest", options);
  if (
    !isObject(value) ||
    !hashId(value.snapshot) ||
    (value.view !== undefined && !eventId(value.view)) ||
    (value.packages_available !== undefined &&
      typeof value.packages_available !== "boolean") ||
    !Array.isArray(value.packages) ||
    value.packages.length > 4096 ||
    value.packages.some(
      (p) =>
        !isObject(p) ||
        !languageTag(p.language) ||
        !hashId(p.hash) ||
        typeof p.bytes !== "number",
    )
  )
    throw new Error("The server returned an invalid manifest.");
  return value as unknown as Manifest;
}
const rational = (value: unknown) =>
  isObject(value) &&
  /^-?\d+$/.test(String(value.numerator)) &&
  /^\d+$/.test(String(value.denominator)) &&
  String(value.denominator) !== "0";
const interval = (value: unknown) =>
  Array.isArray(value) && value.length === 2 && value.every(rational);
function accountKey(value: unknown): value is AccountKey {
  if (
    !isObject(value) ||
    typeof value.origin !== "string" ||
    typeof value.account !== "number" ||
    !Number.isSafeInteger(value.account) ||
    value.account <= 0
  )
    return false;
  try {
    const url = new URL(value.origin);
    return url.protocol === "https:" && url.origin === value.origin;
  } catch {
    return false;
  }
}
const sortedIds = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((id, i) => eventId(id) && (i === 0 || value[i - 1] < id));
const codes = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((code) => typeof code === "string");
const nullableEvent = (value: unknown) => value === null || eventId(value);
function publicationStatus(value: unknown): value is PublicationStatus {
  return (
    isObject(value) &&
    Object.keys(value).length === 10 &&
    eventId(value.event) &&
    typeof value.state === "string" &&
    ["active", "deprecated", "conflicted", "uncertain", "unavailable"].includes(
      String(value.state),
    ) &&
    sortedIds(value.frontier) &&
    codes(value.reasons) &&
    nullableEvent(value.deciding_claim) &&
    typeof value.authority === "string" &&
    ["native", "source-account", "none", "uncertain"].includes(
      String(value.authority),
    ) &&
    (value.controller === null || identityId(value.controller)) &&
    nullableEvent(value.claim) &&
    typeof value.account_authority_applied === "boolean" &&
    (value.account_control === null ||
      (accountKey(value.account_control) &&
        Object.keys(value.account_control).length === 2)) &&
    statusAccountFields(value)
  );
}
/**
 * The account fields that each authority allows. Only the account pass sets
 * a period, a deciding period or source-account authority, and that pass
 * runs exactly for the statuses with account_authority_applied.
 *
 * | applied | authority      | account_control | controller | claim    | deciding_claim |
 * | ------- | -------------- | --------------- | ---------- | -------- | -------------- |
 * | false   | native         | null            | set        | null     | null           |
 * | false   | none           | null or set     | null       | null     | null           |
 * | false   | uncertain      | null            | null       | null     | null           |
 * | false   | source-account | not allowed     |            |          |                |
 * | true    | source-account | set             | set        | set      | null or set    |
 * | true    | none           | set             | null       | null/set | null or set    |
 * | true    | uncertain      | set             | null/set   | set if a controller, else null/set | null or set |
 * | true    | native         | not allowed     |            |          |                |
 */
function statusAccountFields(value: Record<string, unknown>): boolean {
  const reference = value.account_control !== null;
  const controller = value.controller !== null;
  const claim = value.claim !== null;
  if (!value.account_authority_applied) {
    if (claim || value.deciding_claim !== null) return false;
    switch (value.authority) {
      case "native":
        return !reference && controller;
      case "none":
        return !controller;
      case "uncertain":
        // Only the native pass gives uncertain authority without the
        // account pass, and native publications have no account.
        return !reference && !controller;
      default:
        return false;
    }
  }
  if (!reference) return false;
  switch (value.authority) {
    case "source-account":
      return controller && claim;
    case "none":
      return !controller;
    case "uncertain":
      // The pass sets a controller only with its period.
      return !controller || claim;
    default:
      return false;
  }
}
export function validateWord(value: unknown, id: string): WordResponse {
  const invalid = () =>
    new Error("The server returned an invalid word response.");
  if (
    !isObject(value) ||
    !hashId(value.snapshot) ||
    !eventId(value.view) ||
    value.status_version !== STATE_EXPORT_VERSION ||
    !(
      value.word === null ||
      (isObject(value.word) &&
        value.word.language === "jbo" &&
        typeof value.word.spelling === "string")
    ) ||
    !Array.isArray(value.definitions) ||
    !value.definitions.every(eventId) ||
    !Array.isArray(value.rafsi) ||
    !value.rafsi.every(eventId) ||
    !Array.isArray(value.assignments) ||
    !Array.isArray(value.scores) ||
    !Array.isArray(value.statuses) ||
    !value.statuses.every(publicationStatus) ||
    !Array.isArray(value.layers) ||
    !Array.isArray(value.unavailable_scores) ||
    !(value.calculation === null || isObject(value.calculation))
  )
    throw invalid();
  if (value.statuses.length !== value.definitions.length) throw invalid();
  const definitions = new Set(value.definitions);
  let previous = "";
  for (const status of value.statuses) {
    if (status.event <= previous || !definitions.delete(status.event))
      throw invalid();
    previous = status.event;
  }
  for (const score of value.scores) {
    if (
      !isObject(score) ||
      typeof score.target !== "string" ||
      !interval(score.support) ||
      !interval(score.opposition) ||
      !interval(score.net) ||
      !Number.isSafeInteger(score.direct_reviewers) ||
      !["active", "deprecated", "conflicted", "unavailable"].includes(
        String(score.status),
      )
    )
      throw invalid();
    if (score.reviewers !== undefined) {
      if (
        !Array.isArray(score.reviewers) ||
        score.reviewers.length > 64 ||
        typeof score.reviewers_complete !== "boolean" ||
        !score.reviewers.every(
          (r) =>
            isObject(r) &&
            identityId(r.identity) &&
            (r.verdict === "bless" || r.verdict === "curse") &&
            (r.weight === null || interval(r.weight)) &&
            (r.root === null || rational(r.root)) &&
            typeof r.blocked === "boolean" &&
            Array.isArray(r.incoming) &&
            r.incoming.every(identityId) &&
            Number.isSafeInteger(r.incoming_count) &&
            typeof r.incoming_complete === "boolean" &&
            typeof r.multiple_routes === "boolean",
        )
      )
        throw invalid();
    }
  }
  for (const layer of value.layers)
    if (!Array.isArray(layer) || !layer.every(eventId)) throw invalid();
  for (const assignment of value.assignments)
    if (
      !isObject(assignment) ||
      typeof assignment.id !== "string" ||
      !Array.isArray(assignment.claims) ||
      !["eligible", "inactive", "unknown"].includes(String(assignment.status))
    )
      throw invalid();
  void id;
  const word = value as unknown as WordResponse;
  // A calculation profile this client does not know gives no scores and no
  // order. The name stays visible, and nothing substitutes another calculation.
  if (word.calculation && !describeProfile(word.calculation.algorithm).known)
    return {
      ...word,
      scores: [],
      layers: [],
      unavailable_scores: [
        ...new Set([
          ...word.unavailable_scores,
          ...word.scores.map((score) => score.target),
        ]),
      ],
    };
  return word;
}
/**
 * The signed view the reader chose by event ID, or null for the server's
 * selected view. Requests that take a view use it unless a caller names one.
 */
let preferredView: string | null = null;
export function setPreferredView(view: string | null) {
  // Saving another setting applies the same view again. Cached word
  // responses stay valid then, so only a new view clears them.
  if (view === preferredView) return;
  preferredView = view;
  wordCache.clear();
}
export function getPreferredView(): string | null {
  return preferredView;
}
const wordCache = new Map<string, Promise<WordResponse>>();
/**
 * A copy of request options for a reader that waits before its request. The
 * peer is copied as well, so a caller that changes its peer object during
 * the wait cannot send the request to another endpoint.
 */
function fixedRequest<T extends RequestOptions>(options: T): T {
  return options.peer
    ? { ...options, peer: { ...options.peer } }
    : { ...options };
}
export function getWord(
  id: string,
  options: RequestOptions & {
    snapshot?: string;
    view?: string;
    fresh?: boolean;
    reviewers?: boolean;
  } = {},
) {
  // Read the pin once. The URL, the cache key and the answer check all use
  // these values, even if the caller changes its options later.
  const snapshot = options.snapshot || null;
  const view = options.view ?? preferredView;
  const query = new URLSearchParams();
  if (snapshot) query.set("snapshot", snapshot);
  if (view) query.set("view", view);
  if (options.reviewers) query.set("reviewers", "1");
  // The request options and the peer are copied too, so the endpoint stays
  // the one that the cache key names after the materialization wait.
  const request = fixedRequest(options);
  const peer = request.peer ?? selfPeer;
  const key = `${peer.id}|${peer.base}|${id}|${query}`;
  if (request.fresh) wordCache.delete(key);
  let pending = wordCache.get(key);
  if (!pending) {
    pending = (async () => {
      if (request.fresh && !snapshot) await waitForMaterialization(request);
      return api<unknown>(
        `/words/${encodeURIComponent(id)}${query.size ? `?${query}` : ""}`,
        request,
      );
    })().then((value) => {
      const word = validateWord(value, id);
      // A pinned read must answer for that pin. Otherwise its evidence
      // links would name another snapshot or view.
      if (
        (snapshot && word.snapshot !== snapshot) ||
        (view && word.view !== view)
      )
        throw new Error(
          "The server answered the word request for another snapshot or view.",
        );
      return word;
    });
    wordCache.set(key, pending);
    pending.catch(() => wordCache.delete(key));
    // Word responses change with new admissions. Keep them briefly.
    setTimeout(() => wordCache.delete(key), 15000);
  }
  // Each caller gets its own copy, so no caller can change the cached
  // answer that a later reader of the same pin receives.
  return pending.then((word) => structuredClone(word));
}
type EvidencePin = Readonly<Pick<WordResponse, "snapshot" | "view">>;

export function validateAccountControl(
  value: unknown,
  account: AccountKey,
  pin: EvidencePin,
): AccountControlResponse {
  if (
    !isObject(value) ||
    Object.keys(value).length !== 12 ||
    typeof value.row_present !== "boolean" ||
    value.snapshot !== pin.snapshot ||
    value.view !== pin.view ||
    value.origin !== account.origin ||
    value.account !== account.account ||
    typeof value.state !== "string" ||
    !["unclaimed", "controlled", "disputed", "unavailable"].includes(
      String(value.state),
    ) ||
    !sortedIds(value.controller_candidates) ||
    !sortedIds(value.current_observations) ||
    !sortedIds(value.chain) ||
    !codes(value.reasons) ||
    !Array.isArray(value.contributions) ||
    !value.contributions.every(
      (row, i, rows) =>
        isObject(row) &&
        Object.keys(row).length === 3 &&
        identityId(row.witness) &&
        (i === 0 || rows[i - 1].witness < row.witness) &&
        sortedIds(row.claims) &&
        sortedIds(row.observations),
    ) ||
    !Array.isArray(value.certificates) ||
    !value.certificates.every(
      (row, i, rows) =>
        isObject(row) &&
        Object.keys(row).length === 3 &&
        eventId(row.policy) &&
        eventId(row.claim) &&
        sortedIds(row.observations) &&
        (i === 0 ||
          rows[i - 1].policy < row.policy ||
          (rows[i - 1].policy === row.policy && rows[i - 1].claim < row.claim)),
    ) ||
    !accountRowFields(value as unknown as AccountRowShape) ||
    (!value.row_present &&
      (value.state !== "unclaimed" ||
        value.contributions.length > 0 ||
        value.certificates.length > 0 ||
        value.controller_candidates.length > 0 ||
        value.current_observations.length > 0 ||
        value.chain.length > 0 ||
        value.reasons.length > 0))
  )
    throw new Error("The server returned invalid account evidence.");
  return value as unknown as AccountControlResponse;
}

interface AccountRowShape {
  state: string;
  controller_candidates: string[];
  current_observations: string[];
  chain: string[];
  contributions: { claims: string[]; observations: string[] }[];
  certificates: { observations: string[] }[];
}
/**
 * The rules that every account row of an available evaluation meets. Each
 * rule names the restore check in crates/jvc-state/src/incremental.rs that
 * guarantees it. Each contribution row is one current witness group.
 *
 * | state       | controller_candidates | contributions               | current_observations                |
 * | ----------- | --------------------- | --------------------------- | ----------------------------------- |
 * | controlled  | exactly 1             | 1 or more, each claims [c]  | first observation of each group     |
 * | disputed    | 2 or more             | any                         | empty                               |
 * | unclaimed   | 0 or 1                | not unanimous for one claim | empty                               |
 * | unavailable | any                   | any                         | empty                               |
 *
 * In every state, the candidates are the union of the group claims, each
 * group claim comes from that group's observations, no observation belongs
 * to two groups, and every certificate has observations. A controlled row
 * has its candidate in the chain.
 */
function accountRowFields(row: AccountRowShape): boolean {
  const groups = row.contributions;
  // incremental.rs:3155: a group's claims are the claims of its own
  // observations, so a group with claims has observations, and each
  // observation names one claim.
  if (
    groups.some(
      (group) =>
        group.claims.length > group.observations.length ||
        (group.observations.length > 0 && group.claims.length === 0),
    )
  )
    return false;
  // incremental.rs:3135: each observation is issued by its group's witness
  // actor, so no observation belongs to two groups.
  const observations = groups.flatMap((group) => group.observations);
  if (new Set(observations).size !== observations.length) return false;
  // incremental.rs:3165: the candidates are the union of the group claims.
  const claimed = [...new Set(groups.flatMap((group) => group.claims))].sort();
  if (
    claimed.length !== row.controller_candidates.length ||
    claimed.some((claim, i) => claim !== row.controller_candidates[i])
  )
    return false;
  // incremental.rs:3221: every certificate has observations.
  if (row.certificates.some((certificate) => !certificate.observations.length))
    return false;
  // incremental.rs:3263: an available account has a controller exactly
  // when every group claims the same single candidate.
  const unanimous =
    row.controller_candidates.length === 1 &&
    groups.length > 0 &&
    groups.every((group) => group.claims.length === 1);
  if (row.state !== "unavailable" && unanimous !== (row.state === "controlled"))
    return false;
  // incremental.rs:3168: more than one candidate is a dispute, unless the
  // account is unavailable.
  if (row.state === "disputed" && row.controller_candidates.length < 2)
    return false;
  if (row.state === "unclaimed" && row.controller_candidates.length > 1)
    return false;
  if (row.state !== "controlled") return row.current_observations.length === 0;
  // incremental.rs:3210: the controller belongs to the chain.
  if (!row.chain.includes(row.controller_candidates[0])) return false;
  // incremental.rs:3300: the selection is the first maximal observation of
  // each group, as a sorted set.
  const selected = [
    ...new Set(groups.map((group) => group.observations[0])),
  ].sort();
  return (
    selected.length === row.current_observations.length &&
    selected.every((id, i) => id === row.current_observations[i])
  );
}

type AccountPinCache = Map<string, Promise<AccountControlResponse>>;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

// Any reader that holds its pin keeps the shared cache for that pin alive.
const ownedAccountPins = new WeakMap<EvidencePin, Set<AccountPinCache>>();
const accountPins = new Map<string, WeakRef<AccountPinCache>>();
const expiredAccountPins = new FinalizationRegistry<{
  key: string;
  reference: WeakRef<AccountPinCache>;
}>(({ key, reference }) => {
  if (accountPins.get(key) === reference) accountPins.delete(key);
});

function accountPinCache(
  peer: Peer,
  pin: EvidencePin,
  scope: { snapshot: string; view: string },
): AccountPinCache {
  const key = JSON.stringify([peer.id, peer.base, scope.snapshot, scope.view]);
  let cache = accountPins.get(key)?.deref();
  if (!cache) {
    cache = new Map();
    const reference = new WeakRef(cache);
    accountPins.set(key, reference);
    expiredAccountPins.register(cache, { key, reference });
  }
  let owned = ownedAccountPins.get(pin);
  if (!owned) ownedAccountPins.set(pin, (owned = new Set()));
  owned.add(cache);
  return cache;
}

function waitForAccount(
  pending: Promise<AccountControlResponse>,
  signal: AbortSignal | null | undefined,
): Promise<AccountControlResponse> {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    void pending.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", cancel);
    });
  });
}

export function getAccountControl(
  account: AccountKey,
  pin: EvidencePin,
  options: RequestOptions = {},
): Promise<AccountControlResponse> {
  // Read the account and the pin once. The URL, the cache key and the
  // answer check all use these copies, even if the caller changes its
  // objects while the request runs.
  const target = { origin: account?.origin, account: account?.account };
  const scope = { snapshot: pin?.snapshot, view: pin?.view };
  if (!accountKey(target) || !hashId(scope.snapshot) || !eventId(scope.view)) {
    return Promise.reject(new Error("The account evidence link is invalid."));
  }
  const exact = scope as { snapshot: string; view: string };
  const { signal, ...request } = options;
  if (signal?.aborted) return Promise.reject(signal.reason);
  const cache = accountPinCache(request.peer ?? selfPeer, pin, exact);
  const key = target.origin + "#" + target.account;
  let pending = cache.get(key);
  if (!pending) {
    const query = new URLSearchParams({
      origin: target.origin,
      account: String(target.account),
      snapshot: exact.snapshot,
      view: exact.view,
    });
    // Every reader of this pin shares the answer, so it is frozen,
    // including its nested evidence lists.
    pending = api<unknown>(`/account-control?${query}`, request).then((value) =>
      deepFreeze(validateAccountControl(value, target, exact)),
    );
    cache.set(key, pending);
    void pending.catch(() => cache.delete(key));
  }
  return waitForAccount(pending, signal);
}

export async function getPublicationEvidence(
  status: PublicationStatus,
  pin: EvidencePin,
  options: RequestOptions = {},
) {
  // Read the publication once, before the network wait. A caller that
  // changes its object while the request runs cannot change this join.
  const publication = {
    reference: status.account_control
      ? {
          origin: status.account_control.origin,
          account: status.account_control.account,
        }
      : null,
    applied: status.account_authority_applied,
    state: status.state,
    claim: status.claim,
    deciding: status.deciding_claim,
    frontier: status.frontier.length,
    pending: status.reasons.includes("carry_or_authority_pending"),
  };
  const account = publication.reference
    ? await getAccountControl(publication.reference, pin, options)
    : null;
  if (account && !account.row_present)
    throw new Error("The publication refers to missing account evidence.");
  const disagreement =
    account && publication.applied ? appliedJoin(publication, account) : null;
  if (disagreement) throw new Error(disagreement);
  return {
    witness_contributions: account?.contributions ?? [],
    controller_candidates: publication.applied
      ? (account?.controller_candidates ?? [])
      : [],
    observations: publication.applied
      ? (account?.current_observations ?? [])
      : [],
  };
}
/**
 * How an applied status disagrees with its account row, or null when it
 * agrees. The browser checks of account rows are partial. Issue #188 tracks
 * the full rule set that checkpoint restore applies.
 */
function appliedJoin(
  publication: {
    state: string;
    claim: string | null;
    deciding: string | null;
    frontier: number;
    pending: boolean;
  },
  account: AccountControlResponse,
): string | null {
  // The account pass copies the account's selected period into the status
  // claim (accounts.rs:819, restore check incremental.rs:2799). Only a
  // controlled row has a selected period, its sole candidate.
  const period =
    account.state === "controlled" ? account.controller_candidates[0] : null;
  if (publication.claim !== period)
    return "The publication and its account evidence name different periods.";
  // An unavailable account makes the publication unavailable before any
  // period decides it (accounts.rs:833, incremental.rs:2816).
  if (
    account.state === "unavailable" &&
    (publication.state !== "unavailable" || publication.frontier > 0)
  )
    return "The publication status does not show that its account evidence is unavailable.";
  // Each frontier action names a period in the account chain. With one
  // candidate and no pending carry, that period is the deciding claim, and
  // it can be an inherited, earlier period (accounts.rs:844,
  // incremental.rs:2856 to 2865). A source-selection conflict can still
  // make the publication unavailable after that decision.
  const decides =
    !publication.pending &&
    account.controller_candidates.length === 1 &&
    publication.frontier > 0;
  if (
    decides
      ? publication.deciding === null ||
        !account.chain.includes(publication.deciding)
      : publication.deciding !== null
  )
    return "The publication's deciding period does not match its account evidence.";
  return null;
}
export function forgetWord(id: string) {
  for (const key of [...wordCache.keys()])
    if (key.includes(`|${id}|`)) wordCache.delete(key);
}
/**
 * Brings the optional row fields of a search preview within the preview
 * bounds (packages/search/src/preview-row.ts), in place. A field the server
 * sent too long is dropped or shortened by the same rule the server applies.
 * A field of the wrong shape is removed, so the row falls back to the
 * per-definition read for it. No row field ever rejects the page.
 */
function boundPreviewRow(preview: Record<string, unknown>) {
  if (preview.rafsi !== undefined) {
    const rafsi = boundedPreviewList(
      preview.rafsi,
      PREVIEW_RAFSI_COUNT,
      PREVIEW_RAFSI_LENGTH,
    );
    if (rafsi) preview.rafsi = rafsi;
    else delete preview.rafsi;
  }
  if (preview.selmaho !== undefined) {
    const selmaho = boundedPreviewList(
      preview.selmaho,
      PREVIEW_SELMAHO_COUNT,
      PREVIEW_SELMAHO_LENGTH,
    );
    if (selmaho) preview.selmaho = selmaho;
    else delete preview.selmaho;
  }
  // The issuer, notes flag and attribution make one attribution line, so
  // they are present together or absent together. Without the attribution,
  // an issuer would draw an imported definition as a native one.
  if (
    preview.issuer === undefined &&
    preview.notes === undefined &&
    preview.attribution === undefined
  )
    return;
  const attribution = boundedPreviewAttribution(preview.attribution);
  if (
    !identityId(preview.issuer) ||
    typeof preview.notes !== "boolean" ||
    attribution === undefined
  ) {
    delete preview.issuer;
    delete preview.notes;
    delete preview.attribution;
  } else preview.attribution = attribution;
}
const validCursor = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;
export function validateHits(hits: unknown, pageLimit: number): SearchHit[] {
  if (Array.isArray(hits) && hits.length > pageLimit)
    throw new Error(
      "Search pagination returned too many results. Start a new search to retry.",
    );
  if (
    !Array.isArray(hits) ||
    !hits.every(
      (hit) =>
        isObject(hit) &&
        wordIdValid(hit.word_id) &&
        isObject(hit.word) &&
        hit.word.language === "jbo" &&
        typeof hit.word.spelling === "string" &&
        matchKinds.includes(hit.match as never) &&
        Array.isArray(hit.definitions) &&
        hit.definitions.every(eventId) &&
        (hit.preview === undefined ||
          (isObject(hit.preview) &&
            typeof hit.preview.event === "string" &&
            hit.definitions.includes(hit.preview.event) &&
            typeof hit.preview.word_kind === "string" &&
            typeof hit.preview.plain_text === "string" &&
            Array.from(hit.preview.plain_text).length <= 240 &&
            typeof hit.preview.status === "string" &&
            hit.preview.status.length > 0)),
    )
  )
    throw new Error(
      "The server returned an invalid search page. Start a new search to retry.",
    );
  for (const hit of hits) if (hit.preview) boundPreviewRow(hit.preview);
  return hits as SearchHit[];
}
/** Searches disclosed meaning text literally in a JSON body. */
export async function remoteDraftSearch(
  query: string,
  language: string,
  pageLimit: number,
  options: RequestOptions = {},
): Promise<SearchResponse> {
  return remoteSearch(
    query,
    language,
    pageLimit,
    null,
    null,
    { ...options, literal: true },
    true,
  );
}
export async function remoteSearch(
  query: string,
  language: string,
  pageLimit: number,
  context: { snapshot: string; view: string } | null,
  after: string | null,
  options: RequestOptions & {
    retired?: boolean;
    literal?: boolean;
    group?: import("../../../../packages/search/src/index.ts").SearchGroup;
  } = {},
  draftBody = false,
): Promise<SearchResponse> {
  const params = new URLSearchParams({
    q: query,
    language,
    limit: String(pageLimit),
  });
  // Retired results are excluded unless the reader asks for them.
  if (options.retired) params.set("retired", "1");
  if (options.literal) params.set("literal", "1");
  if (options.group) params.set("group", options.group);
  // Read the pin once: the context values, or the preferred view.
  const pinnedSnapshot = context ? context.snapshot : null;
  const pinnedView = context ? context.view : preferredView;
  // An explicit context pins both values. A missing one would let the
  // server choose it, so the request does not start. A null context still
  // finds the current snapshot.
  if (context && (!hashId(pinnedSnapshot) || !eventId(pinnedView)))
    throw new Error(
      "The search context is incomplete. Start a new search to retry.",
    );
  if (pinnedSnapshot) params.set("snapshot", pinnedSnapshot);
  if (pinnedView) params.set("view", pinnedView);
  if (after) params.set("after", after);
  const result = draftBody
    ? await api<unknown>("/search", {
        ...options,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...Object.fromEntries(params),
          limit: pageLimit,
        }),
      })
    : await api<unknown>(`/search?${params}`, options);
  if (
    !isObject(result) ||
    !hashId(result.snapshot) ||
    !eventId(result.view) ||
    (pinnedSnapshot && result.snapshot !== pinnedSnapshot) ||
    (pinnedView && result.view !== pinnedView) ||
    !(result.next === null || validCursor(result.next)) ||
    !(
      result.all_lojban === undefined || typeof result.all_lojban === "boolean"
    ) ||
    !(
      result.segmentation === undefined ||
      result.segmentation === "complete" ||
      result.segmentation === "limited"
    )
  )
    throw new Error(
      "The server returned an invalid search page. Start a new search to retry.",
    );
  const hits = validateHits(result.hits, pageLimit);
  return {
    snapshot: result.snapshot as string,
    view: result.view as string,
    query,
    language,
    hits,
    next: result.next as string | null,
    all_lojban: result.all_lojban as boolean | undefined,
    ...(result.segmentation === undefined
      ? {}
      : { segmentation: result.segmentation as "complete" | "limited" }),
  };
}
export interface IdentityHeadsPage {
  snapshot: string;
  identity: string;
  heads: string[];
  next: string | null;
}
export async function identityHeads(
  identity: string,
  snapshot: string | null,
  after: string | null,
  options: RequestOptions = {},
): Promise<IdentityHeadsPage> {
  if (!identityId(identity)) throw new Error("The identity is invalid.");
  const response = JSON.parse(
    new TextDecoder().decode(
      await objectBytes(
        `/identity-heads/${encodeURIComponent(identity)}?limit=256${snapshot ? `&snapshot=${encodeURIComponent(snapshot)}` : ""}${after ? `&after=${encodeURIComponent(after)}` : ""}`,
        65536,
        options,
      ),
    ),
  ) as unknown;
  if (
    !isObject(response) ||
    !hashId(response.snapshot) ||
    (snapshot !== null && response.snapshot !== snapshot) ||
    response.identity !== identity ||
    !Array.isArray(response.heads) ||
    response.heads.length > 256 ||
    !response.heads.every(eventId) ||
    !(response.next === null || eventId(response.next))
  )
    throw new Error("The server returned an invalid own-history page.");
  return response as unknown as IdentityHeadsPage;
}
export async function getIdentity(
  identity: string,
  options: RequestOptions & { snapshot?: string; fresh?: boolean } = {},
): Promise<IdentityResponse> {
  if (!identityId(identity)) throw new Error("The identity is invalid.");
  // Read the snapshot pin and the request options once, for the URL, the
  // request after the materialization wait, and the answer check.
  const request = fixedRequest(options);
  const snapshot = request.snapshot || null;
  if (request.fresh && !snapshot) await waitForMaterialization(request);
  const params = new URLSearchParams();
  if (snapshot) params.set("snapshot", snapshot);
  if (preferredView) params.set("view", preferredView);
  const query = params.size ? `?${params}` : "";
  const value = await api<unknown>(
    `/identities/${encodeURIComponent(identity)}${query}`,
    request,
  );
  if (
    !isObject(value) ||
    !hashId(value.snapshot) ||
    (snapshot && value.snapshot !== snapshot) ||
    value.identity !== identity ||
    !identityId(value.actor) ||
    !isObject(value.profile) ||
    !["none", "known", "conflicted", "unavailable"].includes(
      String(value.profile.state),
    ) ||
    !Array.isArray(value.profile.claims) ||
    !isObject(value.counts)
  )
    throw new Error("The server returned an invalid identity response.");
  return value as unknown as IdentityResponse;
}
export function getActivity(
  identity: string,
  after: string | null,
  options: RequestOptions & {
    snapshot?: string;
    limit?: number;
    accepted: true;
  },
): Promise<Omit<ActivityResponse, "view">>;
export function getActivity(
  identity: string,
  after: string | null,
  options?: RequestOptions & { snapshot?: string; limit?: number },
): Promise<ActivityResponse>;
export async function getActivity(
  identity: string,
  after: string | null,
  options: RequestOptions & {
    snapshot?: string;
    limit?: number;
    accepted?: boolean;
  } = {},
): Promise<Omit<ActivityResponse, "view">> {
  if (!identityId(identity)) throw new Error("The identity is invalid.");
  const query = new URLSearchParams({ limit: String(options.limit ?? 50) });
  if (options.snapshot) query.set("snapshot", options.snapshot);
  if (options.accepted) query.set("accepted", "1");
  if (after) query.set("after", after);
  const value = await api<unknown>(
    `/identities/${encodeURIComponent(identity)}/activity?${query}`,
    options,
  );
  if (
    !isObject(value) ||
    !hashId(value.snapshot) ||
    value.identity !== identity ||
    !Array.isArray(value.items) ||
    !value.items.every(
      (item) =>
        isObject(item) &&
        eventId(item.id) &&
        isObject(item.action) &&
        typeof item.action.kind === "string" &&
        typeof item.interpretation === "string",
    ) ||
    !(value.next === null || eventId(value.next))
  )
    throw new Error("The server returned an invalid activity page.");
  if (options.snapshot !== undefined && value.snapshot !== options.snapshot)
    throw new Error("the activity scan answered for another snapshot");
  if (options.accepted && value.history !== "accepted")
    throw new Error("The server did not confirm accepted history.");
  return value as unknown as Omit<ActivityResponse, "view">;
}
/** Posts one stored transport exactly as signed and returns the validated receipt. */
export async function postEvent(
  transport: string,
  options: RequestOptions = {},
) {
  return validateReceipt(
    await api("/events", {
      ...options,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: transport,
    }),
  );
}
