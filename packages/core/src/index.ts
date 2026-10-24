import init, * as wasm from "../generated/jvc_runtime.js";
import { encodeEvaluationRequest } from "./evaluation-request.ts";
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
  JSON.parse(wasm.evaluate_records(encodeEvaluationRequest(input)));
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
export type EvaluationSessionOptions = Omit<
  EvaluationRequest,
  "events" | "bodies"
>;
/** Search fields copied from an authenticated record and its checked body. */
export interface EvaluationPackageRecord {
  id: string;
  issuer: string;
  kind: "definition.publish" | "rafsi.publish";
  word: string;
  body_hash: string | null;
  body: Record<string, unknown> | null;
}
export interface EvaluationSessionHandle {
  readonly state: Evaluation;
  rankWord(word: string, reviewers?: number): any;
  fork(options: EvaluationSessionOptions): EvaluationBuilder;
  checkpoint(binding: string): Uint8Array;
  updateStatistics(): {
    incremental_records: number;
    rebuilt: boolean;
    reason: string | null;
  };
  free(): void;
}
interface SessionBasis {
  state: Evaluation;
  identity: string;
}
interface StateDelta {
  version: 1;
  base_session: string;
  receipts: Evaluation["receipts"];
  registers: Record<string, unknown>;
  judgments: Record<string, Record<string, unknown>>;
  lifecycle: {
    key_actor: Record<string, string>;
    groups: Record<string, string[]>;
  };
}
function freezeState<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeState(child);
  }
  return value;
}
function applyStateDelta(parent: Evaluation, delta: StateDelta): Evaluation {
  const oldJudgments = parent.judgments as StateDelta["judgments"];
  const judgments = { ...oldJudgments };
  for (const [target, actors] of Object.entries(delta.judgments))
    judgments[target] = { ...oldJudgments[target], ...actors };
  const lifecycle = parent.lifecycle as StateDelta["lifecycle"] &
    Record<string, unknown>;
  return {
    ...parent,
    receipts: { ...parent.receipts, ...delta.receipts },
    registers: {
      ...(parent.registers as Record<string, unknown>),
      ...delta.registers,
    },
    judgments,
    lifecycle: {
      ...lifecycle,
      key_actor: { ...lifecycle.key_actor, ...delta.lifecycle.key_actor },
      groups: { ...lifecycle.groups, ...delta.lifecycle.groups },
    },
  };
}
export interface EvaluationBuilder {
  addRecord(
    envelope: Uint8Array,
    body?: Uint8Array,
  ): EvaluationPackageRecord | null;
  removeRecord(id: string): void;
  finish(): EvaluationSessionHandle;
  free(): void;
}
function wrapEvaluationSession(
  session: wasm.EvaluationSession,
  parent?: SessionBasis,
): EvaluationSessionHandle {
  let state: Evaluation;
  let identity: string;
  try {
    identity = session.state_identity();
    const delta = parent
      ? (JSON.parse(session.state_delta()) as StateDelta | null)
      : null;
    state = freezeState(
      delta?.version === 1 && delta.base_session === parent?.identity
        ? applyStateDelta(parent.state, delta)
        : (JSON.parse(session.state()) as Evaluation),
    );
  } catch (error) {
    session.free();
    throw error;
  }
  return {
    get state() {
      return state;
    },
    /**
     * Ranks one word. `reviewers` asks for at most that many reviewer details
     * per score, bounded inside the core. Without it the aggregate lookup does
     * no reviewer-detail work and the scores carry no `reviewers` field.
     */
    rankWord: (word: string, reviewers?: number) =>
      JSON.parse(
        reviewers === undefined
          ? session.rank(word)
          : session.rank_with_reviewers(word, reviewers),
      ),
    fork: (options) =>
      wrapEvaluationBuilder(session.fork(encodeEvaluationRequest(options)), {
        state,
        identity,
      }),
    checkpoint: (binding) => session.checkpoint(binding),
    updateStatistics: () => JSON.parse(session.update_statistics()),
    free: () => session.free(),
  };
}
export function evaluateSession(input: EvaluationRequest) {
  return wrapEvaluationSession(
    new wasm.EvaluationSession(encodeEvaluationRequest(input)),
  );
}
/** Authenticate original record bytes before the core retains their state fields. */
export function createEvaluationSession(options: EvaluationSessionOptions) {
  return wrapEvaluationBuilder(
    new wasm.EvaluationSessionBuilder(encodeEvaluationRequest(options)),
  );
}
function wrapEvaluationBuilder(
  builder: wasm.EvaluationSessionBuilder,
  parent?: SessionBasis,
): EvaluationBuilder {
  let closed = false;
  function requireOpen() {
    if (closed) throw new Error("The evaluation builder is closed.");
  }
  return {
    addRecord(envelope: Uint8Array, body?: Uint8Array) {
      requireOpen();
      return JSON.parse(
        builder.add_record(envelope, body),
      ) as EvaluationPackageRecord | null;
    },
    removeRecord(id: string) {
      requireOpen();
      builder.remove_record(id);
    },
    finish() {
      requireOpen();
      closed = true;
      return wrapEvaluationSession(builder.finish(), parent);
    },
    free() {
      if (!closed) {
        closed = true;
        builder.free();
      }
    },
  };
}
/** Only the host's independently checked checkpoint port calls this function. */
export function restoreHostEvaluationSession(
  bytes: Uint8Array,
  binding: string,
): EvaluationSessionHandle {
  return wrapEvaluationSession(
    wasm.EvaluationSession.restore_host_checkpoint(bytes, binding),
  );
}
export const coreCheckpointVersion = (): string =>
  wasm.evaluation_checkpoint_version();
export const rankWord = (input: EvaluationRequest, word: string) =>
  JSON.parse(wasm.rank_word(encodeEvaluationRequest(input), word));

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
  /** The SHA-256 of the pinned source bytes, as hexadecimal. Additive in morphology version 2. */
  source_digest: string;
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
        ? `${failure.measure} is ${failure.value}, above the limit of ${failure.limit}.${failure.measure === "build recognition work" ? " Lock a component form." : ""}`
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
  /** Version 3 explicit boundary joins. Null means automatic, empty means no join. */
  joins?: (string | null)[];
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
    /** A listed choice or an extended whole-word lock awaiting recognition. */
    lock_valid: boolean;
    /** The whole-word check exhausted its work limit. Listed rafsi remain available. */
    recognition_incomplete: boolean;
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
