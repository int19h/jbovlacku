export {
  segmentText,
  TEXT_BYTE_LIMIT,
  TEXT_WORK_LIMIT,
  TEXT_RUN_LIMIT,
  TEXT_RUN_LIMIT_MAX,
} from "./text.ts";
export type {
  TextSegmentation,
  TextSegmentationOptions,
  ForeignRun,
} from "./text.ts";
export type * from "./types.ts";
export { BuilderError } from "./errors.ts";
export { builderPresets } from "./presets.ts";
export { stripAcuteAccents } from "./accents.ts";
import {
  analyzeWord as analyzeLegacyWord,
  buildLujvo as construct,
} from "./lujvo.ts";
import { generateGismu as generate } from "./gismu.ts";
import { analyzePeggyWord } from "./recognize.ts";
import { invalid, requireLimit } from "./errors.ts";
import type {
  MorphologyProfile,
  WordAnalysis,
  LujvoRequest,
  LujvoResult,
  GismuRequest,
  GismuResult,
} from "./types.ts";

export function morphologyProfile(value: {
  id: string;
  version: string;
}): MorphologyProfile {
  const base =
    "https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#";
  if (value.id === base + "cll-lujvo" && value.version === "2") return "cll";
  if (value.id === base + "extended-lujvo") {
    if (value.version === "2") return "extended-v2";
    if (value.version === "3") return "extended";
    if (value.version === "4") return "extended-v4";
  }
  throw new Error(`Unsupported morphology: ${value.id} ${value.version}.`);
}

export function analyzeWord(
  profile: MorphologyProfile,
  spelling: string,
): WordAnalysis {
  if (!["cll", "extended-v2", "extended", "extended-v4"].includes(profile))
    invalid("The profile is cll, extended, extended-v2, or extended-v4.");
  return profile === "extended-v4"
    ? analyzePeggyWord(spelling)
    : analyzeLegacyWord(profile, spelling);
}

/** Preserve the old JSON boundary, including its limit on ignored fields. */
export const BUILDER_INPUT_LIMIT = 64 * 1024 * 1024;
function requestValue<T>(input: T, kind: "lujvo" | "gismu"): T {
  const encoded = JSON.stringify(input);
  requireLimit(
    "request bytes",
    new TextEncoder().encode(encoded).length,
    BUILDER_INPUT_LIMIT,
  );
  if (encoded === undefined)
    invalid("The request is malformed: expected an object.");
  const value = JSON.parse(encoded);
  const malformed = (message: string): never =>
    invalid(`The request is malformed: ${message}`);
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      malformed("expected an object.");
    return value as Record<string, unknown>;
  };
  const array = (value: unknown): unknown[] => {
    if (!Array.isArray(value)) malformed("expected an array.");
    return value as unknown[];
  };
  const string = (value: unknown) => {
    if (typeof value !== "string") malformed("expected a string.");
  };
  const optionalString = (value: unknown) => {
    if (value !== undefined && value !== null) string(value);
  };
  const integer = (value: unknown) => {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 0 ||
      value >= 2 ** 64
    )
      malformed("expected an unsigned integer.");
  };
  const fields = (row: Record<string, unknown>, keys: string[]) => {
    for (const key of keys) {
      if (!(key in row)) malformed(`missing field \`${key}\`.`);
      string(row[key]);
    }
  };
  const inventoryClaim = (value: unknown) =>
    fields(object(value), ["rafsi", "word", "spelling", "pair"]);
  const root = object(value);
  if (kind === "lujvo") {
    if (!("profile" in root)) malformed("missing field `profile`.");
    if (
      !["cll", "extended", "extended-v2", "extended-v4"].includes(
        root.profile as string,
      )
    )
      malformed("unknown morphology profile.");
    if (!("components" in root)) malformed("missing field `components`.");
    for (const value of array(root.components)) {
      const row = object(value);
      fields(row, ["id", "spelling", "kind"]);
      optionalString(row.definition);
      optionalString(row.locked);
      if (row.claims !== undefined)
        for (const claim of array(row.claims))
          fields(object(claim), ["rafsi", "pair"]);
    }
    if (root.joins !== undefined && root.joins !== null)
      for (const join of array(root.joins)) optionalString(join);
    optionalString(root.spelling);
  } else {
    if (!("sources" in root)) malformed("missing field `sources`.");
    for (const value of array(root.sources)) {
      const row = object(value);
      fields(row, ["language", "word"]);
      optionalString(row.input);
    }
    if (
      root.candidates !== undefined &&
      !["source-letters", "all-letters"].includes(root.candidates as string)
    )
      malformed("unknown candidate recipe.");
    if (root.window !== undefined) integer(root.window);
    optionalString(root.manual);
  }
  if (root.inventory !== undefined) {
    const inventory = object(root.inventory);
    optionalString(inventory.snapshot);
    if (inventory.claims !== undefined)
      for (const claim of array(inventory.claims)) inventoryClaim(claim);
    if (kind === "gismu" && inventory.gismu !== undefined)
      for (const row of array(inventory.gismu))
        fields(object(row), ["spelling", "word"]);
  }
  if (root.limits !== undefined) {
    const limits = object(root.limits);
    for (const key of kind === "lujvo"
      ? ["choice_product", "results"]
      : ["work"])
      if (limits[key] !== undefined) integer(limits[key]);
  }
  return value;
}

export function buildLujvo(request: LujvoRequest): LujvoResult {
  return construct(requestValue(request, "lujvo"));
}
export function generateGismu(request: GismuRequest): GismuResult {
  return generate(requestValue(request, "gismu"));
}
