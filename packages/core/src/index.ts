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
/** One linear-time matcher with a cumulative work budget. Call free after use. */
export const createSearchPattern = (source: string) =>
  new wasm.SearchPattern(source);
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

/** Derive definition defaults in a separate reader value after authentication. */
export const interpretDefinition = <T = Record<string, unknown>>(
  body: unknown,
): T => JSON.parse(wasm.definition_interpret(utf8(JSON.stringify(body))));
/** Omit definition defaults in a new body. Imported source evidence stays exact. */
export const omitDefinitionDefaults = (body: unknown): unknown =>
  JSON.parse(wasm.definition_omit_defaults(utf8(JSON.stringify(body))));

export function createEvent(
  seed: Uint8Array,
  previous: string[],
  nonce: string,
  action: Record<string, unknown>,
  body: unknown | null,
) {
  if (action.kind === "definition.publish" && body !== null)
    body = omitDefinitionDefaults(body);
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
  if (action.kind === "definition.publish" && body !== null)
    body = omitDefinitionDefaults(body);
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
  checkpoint(binding: string, resultsOnly?: boolean): Uint8Array;
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
/** Host-only projections never establish browser trust. */
export interface HostVerifiedRecord {
  version: number;
  id: string;
  state: unknown;
  package: EvaluationPackageRecord | null;
  body_status: "none" | "missing" | "present" | "invalid";
  action_valid: boolean;
}
/** Semantic evidence has its own private row and never enters evaluation records. */
export interface HostSemanticRecord {
  version: number;
  id: string;
  kind: string;
  body_hash: string | null;
  semantic: (EvaluationPackageRecord & { kind: "definition.publish" }) | null;
  body_status: "none" | "missing" | "present" | "invalid";
  action_valid: boolean;
}
export const semanticProjectionVersion = (): number =>
  wasm.semantic_projection_version();
export const extractHostSemanticRecord = (
  envelope: Uint8Array,
  body?: Uint8Array,
): string =>
  new TextDecoder().decode(wasm.extract_host_semantic_record(envelope, body));
export const checkHostSemanticRecord = (record: string): string =>
  wasm.check_host_semantic_record(utf8(record));
export const hostRecordVersion = (): number => wasm.host_record_version();
/** Decode private projection fields without record verification. */
export const checkHostVerifiedRecord = (record: string): string =>
  wasm.check_host_verified_record(utf8(record));
/** Parse only bytes from the host's private, already admitted record store. */
export const extractHostVerifiedRecord = (
  envelope: Uint8Array,
  body?: Uint8Array,
): string =>
  new TextDecoder().decode(wasm.extract_host_verified_record(envelope, body));
export const inspectHostStoredBody = (
  header: Header,
  body: Uint8Array | null,
): { availability: string; body?: unknown; reason?: string } =>
  JSON.parse(
    wasm.inspect_host_stored_body(
      utf8(JSON.stringify(header)),
      body ?? undefined,
    ),
  );

export interface EvaluationBuilder {
  addHostVerifiedRecord(record: string): EvaluationPackageRecord | null;
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
    checkpoint: (binding, resultsOnly = false) =>
      resultsOnly
        ? session.result_checkpoint(binding)
        : session.checkpoint(binding),
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
    addHostVerifiedRecord(record: string) {
      requireOpen();
      return JSON.parse(
        builder.add_host_verified_record(utf8(record)),
      ) as EvaluationPackageRecord | null;
    },
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
  records?: string[],
): EvaluationSessionHandle {
  return wrapEvaluationSession(
    records
      ? wasm.EvaluationSession.restore_host_result_checkpoint(
          bytes,
          binding,
          utf8("[" + records.join(",") + "]"),
        )
      : wasm.EvaluationSession.restore_host_checkpoint(bytes, binding),
  );
}
export const coreCheckpointVersion = (): string =>
  wasm.evaluation_checkpoint_version();
export const rankWord = (input: EvaluationRequest, word: string) =>
  JSON.parse(wasm.rank_word(encodeEvaluationRequest(input), word));

/** Canonical local wrappers allow enclosing containers around validated records. */
export const canonicalizeStorageWrapper = (bytes: Uint8Array): string =>
  wasm.canonicalize_storage_wrapper(bytes);

/** Word tools use TypeScript independently of WebAssembly initialization. */
export type * from "../../morphology/src/types.ts";
export {
  morphologyProfile,
  BuilderError,
  builderPresets,
  analyzeWord,
  stripAcuteAccents,
  buildLujvo,
  generateGismu,
} from "../../morphology/src/index.ts";
