import init, * as wasm from "../generated/jvc_runtime.js";
const encoder = new TextEncoder();
export const utf8 = (value: string) => encoder.encode(value);
let ready: Promise<unknown> | undefined;
export function initializeCore(
  module?: WebAssembly.Module | BufferSource,
): Promise<unknown> {
  ready ??= module ? init({ module_or_path: module }) : init();
  return ready!;
}
export interface Header {
  version: number;
  issuer: string;
  previous: string[];
  nonce: string;
  action: Record<string, unknown>;
  content: { hash: string; bytes: number } | null;
}
export interface PreparedAdmission {
  id: string;
  envelope: string;
  envelope_hash: string;
  header: Header;
  signature_bytes: number[];
  body: string | null;
  body_status: "none" | "present" | "missing" | "invalid";
  action_valid: boolean;
}
export interface Publication {
  id: string;
  issuer: string;
  kind: string;
  word: string;
  language: string | null;
  assignment: string | null;
  imported: boolean;
  content_available: boolean;
  eligible: string;
  status: string;
  reasons: string[];
}
export interface Evaluation {
  selected_view: string;
  available: boolean;
  reasons: string[];
  receipts: Record<
    string,
    { interpretation: string; body: string; reasons: string[] }
  >;
  publications: Record<string, Publication>;
  accounts: Record<string, unknown>;
  publication_statuses: Record<string, Record<string, unknown>>;
  account_controls: Record<string, Record<string, unknown>>;
  policy: unknown;
  lifecycle: unknown;
  registers: unknown;
  judgments: unknown;
}
export const canonicalize = (bytes: Uint8Array): string =>
  wasm.runtime_canonicalize(bytes);
export const contentHash = (bytes: Uint8Array): string =>
  wasm.content_hash(bytes);
export const prepareAdmission = (bytes: Uint8Array): PreparedAdmission =>
  JSON.parse(wasm.prepare_admission(bytes));
export const verifyEnvelope = (bytes: Uint8Array) =>
  JSON.parse(wasm.runtime_verify_record(bytes));
export const prepareSelection = (
  bytes: Uint8Array,
): {
  hash: string;
  bytes: number;
  count: number;
  canonical: string;
  ids: string[];
} => JSON.parse(wasm.prepare_selection(bytes));
export const evaluate = (input: {
  events: string[];
  bodies: Record<string, string>;
  selected_view: string;
  import_selections: Record<string, string[]>;
  overlay?: unknown;
  limits?: { events: number; traversal: number; claim_depth: number };
}): Evaluation =>
  JSON.parse(wasm.evaluate_records(utf8(JSON.stringify(input))));
export const signHeader = (seed: Uint8Array, header: Header) =>
  JSON.parse(wasm.sign_record(seed, utf8(JSON.stringify(header))));
export const identityFromSeed = (seed: Uint8Array): string =>
  wasm.identity(seed);

export function createEvent(
  seed: Uint8Array,
  previous: string[],
  nonce: string,
  action: Record<string, unknown>,
  body: unknown | null,
) {
  const encoded =
    body === null ? null : utf8(canonicalize(utf8(JSON.stringify(body))));
  const header: Header = {
    version: 1,
    issuer: identityFromSeed(seed),
    previous: [...previous].sort(),
    nonce,
    action,
    content:
      encoded === null
        ? null
        : { hash: contentHash(encoded), bytes: encoded.length },
  };
  const envelope = signHeader(seed, header);
  const prepared = prepareAdmission(utf8(JSON.stringify({ envelope, body })));
  if (!prepared.action_valid || prepared.body_status === "invalid")
    throw new Error("Draft does not satisfy version 1 action and body rules.");
  return { envelope, body };
}
export const wordId = (word: { language: "jbo"; spelling: string }): string =>
  wasm.runtime_word_identifier(utf8(JSON.stringify(word)));

export const validateAction = (envelopeBytes: Uint8Array): boolean =>
  wasm.check_action(envelopeBytes);
export const inspectBody = (
  envelopeBytes: Uint8Array,
  bodyBytes: Uint8Array | null,
): { availability: string; body?: unknown; reason?: string } =>
  JSON.parse(wasm.check_body(envelopeBytes, bodyBytes ?? undefined));

export function prepareSigning(
  identity: string,
  previous: string[],
  nonce: string,
  action: Record<string, unknown>,
  body: unknown | null,
) {
  const encoded =
    body === null ? null : utf8(canonicalize(utf8(JSON.stringify(body))));
  const header: Header = {
    version: 1,
    issuer: identity,
    previous: [...previous].sort(),
    nonce,
    action,
    content:
      encoded === null
        ? null
        : { hash: contentHash(encoded), bytes: encoded.length },
  };
  return {
    header,
    body,
    signing_bytes: wasm.prepare_signing(utf8(JSON.stringify(header))),
  };
}
export function finishSigning(
  prepared: ReturnType<typeof prepareSigning>,
  signature: Uint8Array,
) {
  const envelope = JSON.parse(
    wasm.finish_signing(utf8(JSON.stringify(prepared.header)), signature),
  );
  const transport = { envelope, body: prepared.body };
  const result = prepareAdmission(utf8(JSON.stringify(transport)));
  if (!result.action_valid || result.body_status === "invalid")
    throw new Error("Draft does not satisfy version 1 action and body rules.");
  return transport;
}

export type EvaluationRequest = Parameters<typeof evaluate>[0];
export function evaluateSession(input: EvaluationRequest) {
  const session = new wasm.EvaluationSession(utf8(JSON.stringify(input)));
  return {
    state: JSON.parse(session.state()) as Evaluation,
    rankWord: (word: string) => JSON.parse(session.rank(word)),
    free: () => session.free(),
  };
}
export const rankWord = (input: EvaluationRequest, word: string) =>
  JSON.parse(wasm.rank_word(utf8(JSON.stringify(input)), word));

/** Canonical local wrappers allow enclosing containers around validated records. */
export const canonicalizeStorageWrapper = (bytes: Uint8Array): string =>
  wasm.canonicalize_storage_wrapper(bytes);
