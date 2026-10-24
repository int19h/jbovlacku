/**
 * Typed HTTP client for one dictionary peer. Every response is bounded,
 * validated, and authenticated where the format permits.
 */
import { describeProfile } from "../model/profiles.ts";
import {
  canonicalize,
  contentHash,
  inspectBody,
  utf8,
  verifyEnvelope,
} from "../../../../packages/core/src/browser.ts";
import {
  eventId,
  hashId,
  identityId,
  languageTag,
  matchKinds,
  wordIdValid,
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

export async function readBounded(
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
      if (length > limit)
        throw new Error("The response exceeds the browser byte limit.");
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
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
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
    if ((error as { name?: string } | null)?.name === "TimeoutError")
      throw new TransportError("The server did not answer in time.", "timeout");
    if (options.signal?.aborted) throw error;
    throw new TransportError("No connection to the server.", "offline");
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBounded(response, limit, signal);
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "TimeoutError")
      throw new TransportError("The server did not answer in time.", "timeout");
    if (options.signal?.aborted) throw error;
    if (error instanceof TypeError)
      throw new TransportError("No connection to the server.", "offline");
    throw error;
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
      parseRetryAfter(response.headers.get("retry-after")),
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
        } catch (error) {
          body = null;
          bodyError =
            error instanceof Error ? error.message : "The body is unavailable.";
          if (error instanceof TransportError) recordCache.delete(key);
        }
      }
      return { envelope, body, bodyError };
    })();
    recordCache.set(key, pending);
    pending.catch(() => recordCache.delete(key));
  }
  return pending as Promise<LoadedRecord<B>>;
}
export const loadDefinition = (id: string, snapshot?: string) =>
  loadRecord<DefinitionBody>(id, snapshot);
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
const viewPending = (receipt: Receipt) =>
  receipt.reasons.some((reason) =>
    ["index_lag", "evaluation_pending"].includes(reason),
  );
const localPeer = (peer: Peer = selfPeer) =>
  peer.id === selfPeer.id &&
  new URL(peer.base, location.origin).href.replace(/\/$/, "") ===
    new URL(selfPeer.base, location.origin).href.replace(/\/$/, "");

/** Call only after delivery confirms the signed envelope and required body. */
export function rememberAcceptedReceipt(receipt: Receipt, peer: Peer) {
  if (!localPeer(peer)) return;
  if (viewPending(receipt)) acceptedAwaitingView.set(receipt.id, receipt);
  else {
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
/** Wait for local accepted records, without changing their delivery state. */
async function waitForMaterialization(options: RequestOptions) {
  if (!localPeer(options.peer) || !hasPendingMaterialization()) return;
  const timeout = AbortSignal.timeout(15000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  try {
    while (hasPendingMaterialization()) {
      signal.throwIfAborted();
      for (const [id, accepted] of [...acceptedAwaitingView]) {
        let receipt: Receipt;
        try {
          receipt = await getReceipt(id, {
            ...options,
            signal,
            cache: "no-store",
          });
        } catch (error) {
          signal.throwIfAborted();
          if (
            error instanceof TransportError ||
            (error instanceof RequestError &&
              error.status >= 500 &&
              error.status < 600)
          )
            continue;
          throw error;
        }
        if (
          receipt.id === id &&
          receipt.admission !== "refused" &&
          receipt.envelope_hash === accepted.envelope_hash &&
          receipt.body_hash === accepted.body_hash &&
          receipt.body_status === accepted.body_status &&
          receipt.cursor === accepted.cursor &&
          receipt.snapshot !== null &&
          !viewPending(receipt) &&
          acceptedAwaitingView.get(id) === accepted
        )
          acceptedAwaitingView.delete(id);
      }
      if (!hasPendingMaterialization()) return;
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
export function validateWord(value: unknown, id: string): WordResponse {
  const invalid = () =>
    new Error("The server returned an invalid word response.");
  if (
    !isObject(value) ||
    !hashId(value.snapshot) ||
    !eventId(value.view) ||
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
    !Array.isArray(value.layers) ||
    !Array.isArray(value.unavailable_scores) ||
    !(value.calculation === null || isObject(value.calculation))
  )
    throw invalid();
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
  preferredView = view;
  wordCache.clear();
}
export function getPreferredView(): string | null {
  return preferredView;
}
const wordCache = new Map<string, Promise<WordResponse>>();
export function getWord(
  id: string,
  options: RequestOptions & {
    snapshot?: string;
    view?: string;
    fresh?: boolean;
    reviewers?: boolean;
  } = {},
) {
  const query = new URLSearchParams();
  if (options.snapshot) query.set("snapshot", options.snapshot);
  const view = options.view ?? preferredView;
  if (view) query.set("view", view);
  if (options.reviewers) query.set("reviewers", "1");
  const key = `${options.peer?.id ?? "self"}|${id}|${query}`;
  if (options.fresh) wordCache.delete(key);
  let pending = wordCache.get(key);
  if (!pending) {
    pending = (async () => {
      if (options.fresh && !options.snapshot)
        await waitForMaterialization(options);
      return api<unknown>(
        `/words/${encodeURIComponent(id)}${query.size ? `?${query}` : ""}`,
        options,
      );
    })().then((value) => validateWord(value, id));
    wordCache.set(key, pending);
    pending.catch(() => wordCache.delete(key));
    // Word responses change with new admissions. Keep them briefly.
    setTimeout(() => wordCache.delete(key), 15000);
  }
  return pending;
}
export function forgetWord(id: string) {
  for (const key of [...wordCache.keys()])
    if (key.includes(`|${id}|`)) wordCache.delete(key);
}
const validCursor = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;
export function validateHits(hits: unknown, pageLimit: number): SearchHit[] {
  if (
    !Array.isArray(hits) ||
    hits.length > pageLimit ||
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
  return hits as SearchHit[];
}
/** Sends a disclosed draft query in a JSON body. */
export async function remoteDraftSearch(
  query: string,
  language: string,
  pageLimit: number,
  options: RequestOptions = {},
): Promise<SearchResponse> {
  return remoteSearch(query, language, pageLimit, null, null, options, true);
}
export async function remoteSearch(
  query: string,
  language: string,
  pageLimit: number,
  context: { snapshot: string; view: string } | null,
  after: string | null,
  options: RequestOptions & { retired?: boolean } = {},
  draftBody = false,
): Promise<SearchResponse> {
  const params = new URLSearchParams({
    q: query,
    language,
    limit: String(pageLimit),
  });
  // Retired results are excluded unless the reader asks for them.
  if (options.retired) params.set("retired", "1");
  if (context) {
    params.set("snapshot", context.snapshot);
    params.set("view", context.view);
  } else if (preferredView) params.set("view", preferredView);
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
    (context &&
      (result.snapshot !== context.snapshot || result.view !== context.view)) ||
    !(result.next === null || validCursor(result.next))
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
  if (options.fresh && !options.snapshot) await waitForMaterialization(options);
  const params = new URLSearchParams();
  if (options.snapshot) params.set("snapshot", options.snapshot);
  if (preferredView) params.set("view", preferredView);
  const query = params.size ? `?${params}` : "";
  const value = await api<unknown>(
    `/identities/${encodeURIComponent(identity)}${query}`,
    options,
  );
  if (
    !isObject(value) ||
    !hashId(value.snapshot) ||
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
