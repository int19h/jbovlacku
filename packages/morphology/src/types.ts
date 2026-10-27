export type MorphologyProfile =
  | "cll"
  | "extended"
  | "extended-v2"
  | "extended-v4";

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

export interface RecoveredPart {
  text: string;
  kind: "rafsi" | "core";
  join_before: string | null;
}

export interface WordAnalysis {
  original: string;
  normalized: string | null;
  kind:
    | "gismu"
    | "lujvo"
    | "cmavo"
    | "fuhivla"
    | "cmevla"
    | "compound"
    | "unknown";
  /** Word spans are present only for the Peggy profile. */
  words?: MorphologyWord[];
  readings: RecoveredPart[][];
  diagnostics: string[];
  morphology: { id: string; version: string };
}

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
  /** Explicit boundary joins. Version 4 also permits an all-" zei " chain. */
  joins?: (string | null)[];
  /** Exact presentation, required to normalize to the parsed candidate. */
  spelling?: string;
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

export interface MorphologyWord {
  text: string;
  kind: Exclude<WordAnalysis["kind"], "compound" | "unknown">;
  start: number;
  end: number;
  diagnostics: string[];
}
