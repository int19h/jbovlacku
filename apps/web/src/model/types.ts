/** Shared record and API shapes. Field names follow the format and frontend specifications. */
import type { Interval, Rational } from "../lib/format.ts";

export type RichNode =
  | string
  | number
  | { operand: string }
  | { code: string }
  | { word: WordObject; label: string }
  | { url: string; label: string };
export type RichText = RichNode[][];
export interface WordObject {
  language: "jbo";
  spelling: string;
}
export interface Gloss {
  language: string;
  text: string;
  sense: string | null;
}
export type Arity =
  | { mode: "fixed"; count: number }
  | { mode: "variadic"; minimum: number }
  | { mode: "context" };
export interface TypeAlternative {
  tags: string[];
  abstractor: string | null;
  relation_arity: Arity | null;
}
export interface TypeHint {
  alternatives: TypeAlternative[];
  note: RichText;
}
export interface Default {
  kind: "conventional" | "suggested";
  value:
    | { format: "lojban"; text: string }
    | { format: "prose"; language: string; text: string };
  condition: RichText;
  explanation: RichText;
}
export interface Derivation {
  word: WordObject;
  definition: string | null;
  place: number;
  explanation: RichText;
}
export interface Place {
  index: number;
  glosses: Gloss[];
  description: RichText;
  type_hints: TypeHint[];
  defaults: Default[];
  constraints: RichText[];
  derivation: Derivation[];
}
export interface Tail {
  from: number;
  description: RichText;
  type_hints: TypeHint[];
}
export interface Frame {
  role: "predicate" | "constructed-predicate";
  arity: Arity;
  places: Place[];
  tail: Tail | null;
  constraints: RichText[];
}
export interface Operand {
  id: string;
  category: string;
  description: RichText;
  cardinality: { minimum: number; maximum: number | null };
}
export interface Example {
  language: string;
  text: string;
  translation: RichText;
  notes: RichText;
}
export interface SourceReference {
  label: string;
  url: string | null;
  event: string | null;
  locator: string | null;
}
export interface FormationSource {
  language: string;
  word: string;
  /** Optional source evidence. Absent or null values mean unknown. */
  word_ipa?: string | null;
  input: { format: "lojbanized" | "ipa"; text: string } | null;
  weight: Rational | null;
  notes: RichText;
}
export interface Formation {
  method: "algorithmic" | "non-algorithmic" | "unknown";
  algorithm: {
    id: string;
    version: string;
    implementation: SourceReference | null;
    parameters: {
      weighting: string;
      matching: string;
      transliteration: string;
      candidates: string;
      aggregation: string;
    };
  } | null;
  sources: FormationSource[];
  weights_profile: {
    name: string | null;
    source: SourceReference | null;
  } | null;
  generated: string | null;
  selected_score: Rational | null;
  selected_rank: number | null;
  selection_reason: RichText;
  candidates: { form: string; score: Rational | null; rank: number | null }[];
  conflicts: {
    word: string;
    rule: "identical" | "final-vowel" | "similar-consonant";
    snapshot: string;
  }[];
}
export interface Compound {
  components: { word: WordObject; definition: string | null; rafsi: string }[];
  morphology: { id: string; version: string };
  scoring: { id: string; version: string };
  score: number | null;
  notes: RichText;
}
export type LexicalKind =
  | "gismu"
  | "cmavo"
  | "lujvo"
  | "fuhivla"
  | "cmevla"
  | "compound"
  | "letteral"
  | "other";
export const lexicalKinds: LexicalKind[] = [
  "gismu",
  "cmavo",
  "lujvo",
  "fuhivla",
  "cmevla",
  "compound",
  "letteral",
  "other",
];
/** The human spelling of a lexical kind. Stored values stay unchanged. */
export function kindLabel(kind: string): string {
  return kind === "fuhivla" ? "fu'ivla" : kind;
}
/** Interpreted definition content. Retained signed JSON can omit optional fields. */
export interface DefinitionBody {
  word: WordObject;
  language: string;
  text: RichText;
  frame: Frame | null;
  operands: Operand[];
  glosses: Gloss[];
  notes: RichText;
  etymology: {
    text: RichText;
    formation: Formation | null;
    compound: Compound | null;
  };
  examples: Example[];
  classification: { kind: LexicalKind; selmaho: string[] };
  labels: string[];
  sources: SourceReference[];
  license: { expression: string; url: string | null; attribution: string };
  legacy: Record<string, unknown> | null;
}
export interface RafsiBody {
  word: WordObject;
  rafsi: string;
  rationale: RichText;
  sources: SourceReference[];
  legacy: Record<string, unknown> | null;
}
export interface ProfileBody {
  name: string;
  bio: RichText;
  links: string[];
}
export interface Header {
  version: 1;
  issuer: string;
  previous: string[];
  nonce: string;
  action: Record<string, unknown> & { kind: string };
  content: { hash: string; bytes: number } | null;
}
export interface Envelope {
  id: string;
  header: Header;
  signature: string;
}
export interface Transport {
  envelope: Envelope;
  body: unknown | null;
}
export interface Receipt {
  id: string;
  admission: "accepted" | "duplicate" | "refused";
  interpretation:
    | "effective"
    | "pending"
    | "suspended"
    | "inert"
    | "unavailable";
  body_status: "none" | "present" | "missing" | "withheld" | "invalid";
  cursor: string | null;
  snapshot: string | null;
  view: string;
  reasons: string[];
  envelope_hash?: string | null;
  body_hash?: string | null;
}
export interface Calculation {
  incomplete_identities: string[];
  suspensions: { identity: string; cause: string; reason: string }[];
  algorithm: string;
  budget: number;
  completed: number;
  exact: boolean;
  overlay: string;
  inventory: string;
  logical_inventory: string;
}
export interface ReviewerDetail {
  identity: string;
  verdict: "bless" | "curse";
  weight: Interval | null;
  /** Starting allowance when the reviewer is a root of the view. */
  root: Rational | null;
  blocked: boolean;
  /**
   * Reasons for a block, supplied only by a version 2 local calculation.
   * Absent means that the response gives no such reason. Both can apply.
   */
  public_shun_block?: true;
  private_block?: true;
  /** Identities whose resolved heed reaches this reviewer directly, bounded. */
  incoming: string[];
  incoming_count: number;
  incoming_complete: boolean;
  multiple_routes: boolean;
}
export interface ScoreRecord {
  target: string;
  support: Interval;
  opposition: Interval;
  net: Interval;
  direct_reviewers: number;
  status: "active" | "deprecated" | "conflicted" | "unavailable";
  /** Present only when the request asked for reviewer details. */
  reviewers?: ReviewerDetail[];
  reviewers_complete?: boolean;
}
export interface IdentityResponse {
  snapshot: string;
  view: string;
  identity: string;
  actor: string;
  successor: string | null;
  retired: boolean;
  compromised: boolean;
  suspended: boolean;
  profile: {
    state: "none" | "known" | "conflicted" | "unavailable";
    claims: {
      event: string;
      issuer: string | null;
      body_hash: string | null;
      body: ProfileBody | null;
      /** Distinguishes snapshot absence, invalid bytes, storage failure, and size cuts. */
      body_status?:
        | "present"
        | "missing"
        | "invalid"
        | "unavailable"
        | "omitted";
    }[];
    /** The number of concurrent claims the server knows. */
    claims_count?: number;
    /** False when the list or a body was cut by the response bounds. */
    claims_complete?: boolean;
  };
  counts: {
    definitions: number;
    rafsi: number;
    judgments: number;
    trust: number;
    reports: number;
    other: number;
  };
}
export interface ActivityItem {
  id: string;
  action: Record<string, unknown> & { kind: string };
  interpretation: string;
  seen: string | null;
}
export interface ActivityResponse {
  snapshot: string;
  view: string;
  identity: string;
  items: ActivityItem[];
  next: string | null;
}
export interface PackageEntryV2 extends PackageEntry {
  issuer: string;
  notes: boolean;
  rafsi: string[];
  /** False when the server cut the rafsi list at its bound. Older servers omit it. */
  rafsi_complete?: boolean;
  attribution: {
    source: string;
    author: string | null;
    account: { origin: string; account: number } | null;
    dates: Record<string, string>;
  } | null;
}
export interface PublicationStatus {
  event: string;
  state: "active" | "deprecated" | "conflicted" | "uncertain" | "unavailable";
  frontier: string[];
  reasons: string[];
  controller_candidates: string[];
  deciding_claim: string | null;
  witness_contributions: unknown[];
  authority: "native" | "source-account" | "none" | "uncertain";
  controller: string | null;
  claim: string | null;
  observations: string[];
}
export interface WordResponse {
  snapshot: string;
  view: string;
  calculation: Calculation | null;
  word: WordObject | null;
  definitions: string[];
  rafsi: string[];
  assignments: {
    id: string;
    claims: string[];
    status: "eligible" | "inactive" | "unknown";
  }[];
  scores: ScoreRecord[];
  statuses: PublicationStatus[];
  layers: string[][];
  unavailable_scores: string[];
}
export interface SearchHit {
  word: WordObject;
  word_id: string;
  match: MatchKind;
  definitions: string[];
  preview?: {
    event: string;
    word_kind: string;
    plain_text: string;
    status: string;
  };
}
export type MatchKind =
  | "headword"
  | "gloss"
  | "alias"
  | "headword-prefix"
  | "gloss-prefix"
  | "token";
export const matchKinds: MatchKind[] = [
  "headword",
  "gloss",
  "headword-prefix",
  "gloss-prefix",
  "token",
];
export interface SearchResponse {
  snapshot: string;
  view: string;
  query: string;
  language: string;
  hits: SearchHit[];
  next: string | null;
}
export interface Capabilities {
  versions: number[];
  max_envelope_bytes: number;
  max_body_bytes: number;
  max_request_bytes: number;
  server_id: string;
  policy_url: string;
  cors_origins: string[];
  body_kinds: string[];
  features: {
    semantic_search: boolean;
    assistance: boolean;
    account_observation: boolean;
    lensisku_bridge: boolean;
    derived_exchange: boolean;
  };
  embedding_profiles: string[];
  assistance_profiles: unknown[];
  git_mirror: string | null;
  account_witness_service: string | null;
}
export interface Manifest {
  snapshot: string;
  /** Absent on older servers. This is the declared selection, without an evaluation claim. */
  view?: string;
  packages_available?: boolean;
  logical_inventory: string;
  manifest: unknown;
  accepted_cursor: string;
  materialized_cursor: string;
  packages: { language: string; hash: string; bytes: number }[];
  package_versions?: {
    language: string;
    version: number;
    hash: string;
    bytes: number;
  }[];
}
export interface PackageEntry {
  event: string;
  word: WordObject;
  language: string;
  glosses: Gloss[];
  plain_text: string;
  classification: { kind: LexicalKind; selmaho: string[] };
  body: string | null;
}
export interface ViewBody {
  name: string;
  description: RichText;
  roots: { identity: string; q: Rational }[];
  rafsi_threshold: Rational;
  H: Rational;
  alpha: Rational;
  excluded: { identity: string; evidence: string[] }[];
  calculation: string;
  work: number;
  import_sets: { source: string; importer: string; selection: string }[];
  account_witnesses: string[];
  account_authority: boolean;
  notes: RichText;
}
export interface TrustScope {
  kind: "definition" | "rafsi" | "*";
  word: string;
  language: string;
}
export type JudgmentValue = "bless" | "curse" | "clear";
export type TrustValue = "heed" | "shun" | "clear";
export const allScope: TrustScope = { kind: "*", word: "*", language: "*" };
export const eventId = (value: unknown): value is string =>
  typeof value === "string" && /^jve1:[0-9a-f]{64}$/.test(value);
export const wordIdValid = (value: unknown): value is string =>
  typeof value === "string" && /^jvw1:[0-9a-f]{64}$/.test(value);
export const pairIdValid = (value: unknown): value is string =>
  typeof value === "string" && /^jvr1:[0-9a-f]{64}$/.test(value);
export const hashId = (value: unknown): value is string =>
  typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
export const identityId = (value: unknown): value is string =>
  typeof value === "string" && /^ed25519:[0-9a-f]{64}$/.test(value);
export const languageTag = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 63 &&
  /^[a-z]{1,8}(?:-[a-z0-9]{1,8})*$/.test(value);
