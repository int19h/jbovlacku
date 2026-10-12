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
/** The rafsi pair ID of a word ID and NFC rafsi spelling, per the format specification. */
export const rafsiPairId = (word: string, rafsi: string): string =>
  "jvr1:" +
  contentHash(
    utf8(
      "jbovlacku-rafsi-v1\n" +
        canonicalize(utf8(JSON.stringify({ word, rafsi }))),
    ),
  ).slice(7);

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

/** Word-form tools from the shared morphology crate. See docs/morphology.md. */
export type MorphologyProfile = "cll" | "extended";
export interface BuilderPreset {
  id: string;
  label: string;
  description: string;
  source_url: string;
  reference_url: string | null;
  denominator: number;
  languages: { language: string; name: string; numerator: number }[];
}
export interface BuilderFailure {
  kind: "invalid" | "resource-limit";
  message?: string;
  measure?: string;
  value?: number;
  limit?: number;
}
export class BuilderError extends Error {
  constructor(public failure: BuilderFailure) {
    super(
      failure.kind === "resource-limit"
        ? `${failure.measure} is ${failure.value}, above the limit of ${failure.limit}.`
        : (failure.message ?? "The builder request failed."),
    );
  }
}
function builderCall<T>(run: () => string): T {
  try {
    return JSON.parse(run()) as T;
  } catch (error) {
    if (typeof error === "string") {
      try {
        const failure = JSON.parse(error) as BuilderFailure;
        if (failure && typeof failure === "object" && "kind" in failure)
          throw new BuilderError(failure);
      } catch (inner) {
        if (inner instanceof BuilderError) throw inner;
      }
      throw new Error(error);
    }
    throw error;
  }
}
export const builderPresets = (): BuilderPreset[] =>
  builderCall(() => wasm.builder_presets());
export interface RecoveredPart {
  text: string;
  kind: "rafsi" | "core";
  join_before: string | null;
}
export interface WordAnalysis {
  original: string;
  normalized: string | null;
  kind: "gismu" | "lujvo" | "cmavo" | "fuivla" | "cmevla" | "unknown";
  readings: RecoveredPart[][];
  diagnostics: string[];
  morphology: { id: string; version: string };
}
export const analyzeWord = (
  profile: MorphologyProfile,
  spelling: string,
): WordAnalysis => builderCall(() => wasm.analyze_word(profile, spelling));
export interface LujvoComponentRequest {
  id: string;
  spelling: string;
  kind: string;
  definition?: string | null;
  claims?: { rafsi: string; pair: string }[];
  locked?: string | null;
}
export interface RafsiInventoryClaim {
  rafsi: string;
  word: string;
  spelling: string;
  pair: string;
}
export interface LujvoRequest {
  profile: MorphologyProfile;
  components: LujvoComponentRequest[];
  inventory?: { snapshot?: string | null; claims?: RafsiInventoryClaim[] };
  limits?: { choice_product?: number; results?: number };
}
export interface LujvoChoice {
  form: string;
  origin: "claim" | "stem" | "final" | "core";
  shape: string;
  position: "any" | "nonfinal" | "final";
  pair: string | null;
}
export interface LujvoCandidate {
  spelling: string;
  parts: {
    id: string;
    form: string;
    origin: LujvoChoice["origin"];
    pair: string | null;
  }[];
  tokens: string[];
  score: number;
  recovered: RecoveredPart[];
  conflicts: {
    rafsi: string;
    id: string;
    word: string;
    spelling: string;
    pair: string;
  }[];
  unlisted: string[];
}
export interface LujvoResult {
  rows: {
    id: string;
    normalized: string;
    choices: LujvoChoice[];
    lock_valid: boolean;
    diagnostics: string[];
  }[];
  candidates: LujvoCandidate[];
  complete: boolean;
  considered: number;
  rejected: { spelling: string; parts: string[]; reason: string }[];
  morphology: { id: string; version: string };
  scoring: { id: string; version: string };
  diagnostics: string[];
}
export const buildLujvo = (request: LujvoRequest): LujvoResult =>
  builderCall(() => wasm.build_lujvo(utf8(JSON.stringify(request))));
export interface CalculatedRational {
  numerator: string;
  denominator: string;
}
export interface GismuSourceRow {
  language: string;
  word: string;
  input: string | null;
  weight: { numerator: string | number; denominator: string | number } | null;
}
export interface GismuRequest {
  sources: GismuSourceRow[];
  candidates?: "source-letters" | "all-letters";
  inventory?: {
    snapshot?: string | null;
    gismu?: { spelling: string; word: string }[];
    claims?: RafsiInventoryClaim[];
  };
  window?: number;
  manual?: string | null;
  limits?: { work?: number };
}
export interface GismuCandidate {
  form: string;
  score: CalculatedRational;
  rank: number | null;
  contributions: {
    language: string;
    input: string;
    matched: number;
    length: number;
    weighted: CalculatedRational;
  }[];
  short_rafsi: string[];
  conflicts: { word: string; spelling: string; rule: string }[];
  rafsi_conflicts: RafsiInventoryClaim[];
}
export interface GismuResult {
  languages: {
    language: string;
    weight: CalculatedRational;
    normalized: CalculatedRational;
    inputs: string[];
  }[];
  considered: number;
  complete: boolean;
  candidates: GismuCandidate[];
  manual: GismuCandidate | null;
  algorithm: { id: string; version: string };
  parameters: {
    weighting: string;
    matching: string;
    transliteration: string;
    candidates: string;
    aggregation: string;
  };
  diagnostics: string[];
}
export const generateGismu = (request: GismuRequest): GismuResult =>
  builderCall(() => wasm.generate_gismu(utf8(JSON.stringify(request))));
