import {
  canonicalize,
  contentHash,
  interpretDefinition,
  utf8,
} from "../../../core/src/index.ts";
import { EMBEDDING_MODEL, EMBEDDING_ROUTE } from "../inference.ts";
import {
  SemanticError,
  type EmbeddingProfile,
  type InputRecipe,
} from "./types.ts";

export const DOCUMENT_RECIPE = "definition-json-v1";
export const QUERY_RECIPE = "literal-query-v1";
export const QUERY_PREFIX =
  "Instruct: Given a meaning, retrieve dictionary definitions with related meanings.\nQuery:";
export const MAX_INPUT_BYTES = 4096;
export const MAX_PROFILE_BYTES = 65536;
export const canonicalBytes = (value: unknown): Uint8Array =>
  utf8(canonicalize(utf8(JSON.stringify(value))));

function freshEpoch(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

/** A new application generation never adopts saved research vectors. */
export function createQwenProfile(
  epoch: string = freshEpoch(),
): EmbeddingProfile {
  if (!/^[a-f0-9]{32}$/.test(epoch))
    throw new SemanticError(400, "profile", "The profile epoch is invalid.");
  return {
    version: 1,
    model: EMBEDDING_MODEL,
    revision: null,
    artifacts: [],
    provider: `openrouter:${EMBEDDING_ROUTE}`,
    runtime: { name: "jbovlacku-openrouter-embeddings", version: "1" },
    epoch,
    dimension: 4096,
    encoding: "f32le",
    normalization: "unit-l2",
    distance: "cosine",
    document: {
      recipe: DOCUMENT_RECIPE,
      task: null,
      prefix: "",
      truncation: "reject",
    },
    query: {
      recipe: QUERY_RECIPE,
      task: null,
      prefix: QUERY_PREFIX,
      truncation: "reject",
    },
    parameters: {
      adapter: "openrouter-embeddings-v1",
      endpoint: "https://openrouter.ai/api/v1/embeddings",
      route: EMBEDDING_ROUTE,
      allow_fallbacks: false,
      encoding_format: "float",
      maximum_input_bytes: MAX_INPUT_BYTES,
      maximum_batch_inputs: 8,
      maximum_batch_input_bytes: 32768,
      local_normalization: "l2-scale-f64-to-f32-v1",
    },
  };
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);
const exactFields = (
  value: Record<string, unknown>,
  fields: readonly string[],
) =>
  Object.keys(value).length === fields.length &&
  fields.every((key) => Object.hasOwn(value, key));
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && validUnicode(value);
const nullableText = (value: unknown) => value === null || nonempty(value);
const versioned = (value: unknown) =>
  nonempty(value) && /^[a-z0-9][a-z0-9-]*-v[1-9][0-9]*$/.test(value);

function jsonValue(value: unknown): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return validUnicode(value);
  if (Array.isArray(value))
    return Object.keys(value).length === value.length && value.every(jsonValue);
  return (
    object(value) &&
    Object.entries(value).every(
      ([key, child]) => validUnicode(key) && jsonValue(child),
    )
  );
}

function validRecipe(value: unknown): boolean {
  return (
    object(value) &&
    exactFields(value, ["recipe", "task", "prefix", "truncation"]) &&
    versioned(value.recipe) &&
    nullableText(value.task) &&
    typeof value.prefix === "string" &&
    validUnicode(value.prefix) &&
    (value.truncation === "reject" || versioned(value.truncation))
  );
}

/** Validate portable metadata before it receives an identity or enters private storage. */
export function validateProfile(value: unknown): EmbeddingProfile {
  if (
    !object(value) ||
    !exactFields(value, [
      "version",
      "model",
      "revision",
      "artifacts",
      "provider",
      "runtime",
      "epoch",
      "dimension",
      "encoding",
      "normalization",
      "distance",
      "document",
      "query",
      "parameters",
    ]) ||
    value.version !== 1 ||
    !nonempty(value.model) ||
    !nullableText(value.revision) ||
    !nonempty(value.provider) ||
    typeof value.epoch !== "string" ||
    !/^[a-f0-9]{32}$/.test(value.epoch) ||
    !Number.isInteger(value.dimension) ||
    (value.dimension as number) < 1 ||
    (value.dimension as number) > 65536 ||
    value.encoding !== "f32le" ||
    !["unit-l2", "none"].includes(value.normalization as string) ||
    !["cosine", "dot"].includes(value.distance as string) ||
    !validRecipe(value.document) ||
    !validRecipe(value.query) ||
    !Array.isArray(value.artifacts) ||
    !value.artifacts.every(
      (hash, index, all) =>
        typeof hash === "string" &&
        /^sha256:[a-f0-9]{64}$/.test(hash) &&
        (index === 0 || all[index - 1] < hash),
    ) ||
    !(
      value.runtime === null ||
      (object(value.runtime) &&
        exactFields(value.runtime, ["name", "version"]) &&
        nonempty(value.runtime.name) &&
        nonempty(value.runtime.version))
    ) ||
    !object(value.parameters) ||
    !jsonValue(value.parameters)
  )
    throw new SemanticError(
      400,
      "profile",
      "The embedding profile is invalid.",
    );
  const bytes = canonicalBytes(value);
  if (bytes.length > MAX_PROFILE_BYTES)
    throw new SemanticError(413, "profile", "The profile exceeds 64 KiB.");
  return value as unknown as EmbeddingProfile;
}

/** Parse JSON with the core's duplicate-key and Unicode checks. */
export function parseProfile(bytes: Uint8Array): EmbeddingProfile {
  if (bytes.byteLength > MAX_PROFILE_BYTES)
    throw new SemanticError(413, "profile", "The profile exceeds 64 KiB.");
  return validateProfile(JSON.parse(canonicalize(bytes)));
}

/** The entire canonical profile identifies the vector space. */
export function profileId(profile: unknown): string {
  validateProfile(profile);
  const bytes = canonicalBytes(profile);
  return contentHash(bytes);
}

export function validUnicode(text: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
    text,
  );
}

function prefixedInput(
  recipe: InputRecipe,
  name: string,
  text: string,
): Uint8Array {
  if (
    recipe.recipe !== name ||
    recipe.truncation !== "reject" ||
    recipe.task !== null ||
    typeof recipe.prefix !== "string" ||
    !validUnicode(recipe.prefix) ||
    !validUnicode(text)
  )
    throw new SemanticError(
      400,
      "recipe",
      "The input recipe is unsupported or invalid.",
    );
  const bytes = utf8(recipe.prefix + text);
  if (bytes.length > MAX_INPUT_BYTES)
    throw new SemanticError(
      413,
      "input_limit",
      "The profile accepts at most 4096 prefixed input bytes.",
    );
  return bytes;
}

export function queryInput(
  profile: EmbeddingProfile,
  query: string,
): Uint8Array {
  if (typeof query !== "string" || !validUnicode(query) || query.length === 0)
    throw new SemanticError(400, "query", "The query must contain valid text.");
  return prefixedInput(profile.query, QUERY_RECIPE, query);
}

/** The caller supplies an authenticated definition. Defaults never change its signed bytes. */
export function documentInput(
  profile: EmbeddingProfile,
  definition: Record<string, unknown>,
): Uint8Array {
  const body = interpretDefinition(definition);
  const frame = body.frame as Record<string, unknown> | null;
  if (
    typeof body.language !== "string" ||
    !Array.isArray(body.text) ||
    !Array.isArray(body.glosses) ||
    (frame !== null &&
      (typeof frame !== "object" || !Array.isArray(frame.places)))
  )
    throw new SemanticError(
      400,
      "definition",
      "The definition input is invalid.",
    );
  const bytes = canonicalBytes({
    language: body.language,
    text: body.text,
    glosses: body.glosses,
    places: frame === null ? [] : frame.places,
  });
  return prefixedInput(
    profile.document,
    DOCUMENT_RECIPE,
    new TextDecoder().decode(bytes),
  );
}

export const inputHash = (input: Uint8Array): string => contentHash(input);
