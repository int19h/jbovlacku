import { compactJson } from "./json.ts";
export { compactJson, jsonParts } from "./json.ts";
import { promptFiles } from "./prompt-bundle.ts";

export type Task =
  | "glosses"
  | "hints"
  | "mappings"
  | "sources"
  | "type"
  | "components"
  | "cmavo-class"
  | "definition"
  | "places";
type JsonObject = Record<string, any>;
export const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export class AssistanceError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
function clientAddress(
  address: string,
): { address: string; groups?: number[] } | undefined {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address)) {
    const parts = address.split(".").map(Number);
    if (
      parts.every(
        (part, index) =>
          part <= 255 && String(part) === address.split(".")[index],
      )
    )
      return { address: parts.join(".") };
    return;
  }
  if (!address.includes(":") || !/^[A-Fa-f0-9:.]+$/.test(address)) return;
  try {
    const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    const [left, right] = canonical.split("::");
    const first = left ? left.split(":") : [];
    const last = right ? right.split(":") : [];
    const groups = (
      right !== undefined
        ? [
            ...first,
            ...Array(8 - first.length - last.length).fill("0"),
            ...last,
          ]
        : first
    ).map((group) => parseInt(group, 16));
    if (groups.length !== 8) return;
    if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 65535)
      return {
        address: [
          groups[6] >> 8,
          groups[6] & 255,
          groups[7] >> 8,
          groups[7] & 255,
        ].join("."),
      };
    return {
      address: groups.map((group) => group.toString(16)).join(":"),
      groups,
    };
  } catch {
    return;
  }
}
/** Network limits group IPv6 clients by /64. Invalid addresses grant no identity. */
export function normalizeClientNetwork(address: string): string {
  const parsed = clientAddress(address);
  return parsed?.groups
    ? `${parsed.groups
        .slice(0, 4)
        .map((group) => group.toString(16))
        .join(":")}::/64`
    : (parsed?.address ?? "");
}
/** A configured proxy must replace a single IP header and be an exact trusted peer. */
export function nodeClientNetwork(
  remote: string,
  forwarded: string | null,
  trusted: string[],
): string {
  const peer = clientAddress(remote);
  if (!peer) return "";
  if (!trusted.length) return normalizeClientNetwork(remote);
  if (
    !trusted.some((address) => clientAddress(address)?.address === peer.address)
  )
    return "";
  return forwarded ? normalizeClientNetwork(forwarded) : "";
}
export function nodeAssistanceIdentityAvailable(
  host: string,
  origin: string | undefined,
  trusted: string[],
): boolean {
  if (trusted.length) return true;
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) return false;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
export function workerClientNetwork(
  address: string | null,
  hasMetadata: boolean,
  trustEdge: boolean,
  local: boolean,
): string {
  if (local) return "local";
  return trustEdge && hasMetadata && address
    ? normalizeClientNetwork(address)
    : "";
}
export interface ProviderConfig {
  baseUrl: string;
  model: string;
  route: string;
  providerName?: string;
  reasoningEffort: string;
  key: () => Promise<string>;
  decisionReports: boolean;
  maxTokens: number;
  timeoutMs: number;
  concurrency: number;
  maxCostUsd?: number;
  maxPrice: number;
  inputPrice: number;
  outputPrice: number;
  hourlyBudgetUsd: number;
  dailyBudgetUsd: number;
  networkHourlyBudgetUsd: number;
  networkDailyBudgetUsd: number;
  onCost?: (reportedUsd: number | null, estimatedUsd: number) => Promise<void>;
  operations: string[];
  maxLogBytes?: number;
  fetch?: typeof fetch;
}
const operations = [
  "type",
  "lujvo",
  "gismu-sources",
  "cmavo-class",
  "definition",
  "places-glosses",
];
export const INFERENCE_RESPONSE_BYTES = 262144;
export const INFERENCE_INITIAL_REQUEST_BYTES = 2097152;
export const INFERENCE_GENERATED_FRAME_BYTES =
  2 * INFERENCE_RESPONSE_BYTES + 4096;
export const INFERENCE_FEEDBACK_BYTES = 32 * 512 * 6 + 4096;
export const INFERENCE_CORRECTION_BYTES =
  2 * INFERENCE_RESPONSE_BYTES + INFERENCE_FEEDBACK_BYTES;
export const INFERENCE_LOG_BYTES = 64 * 1024 * 1024;
// These caps include a margin above the prompt studies and local live checks.
const taskTokenCaps: Record<Task, number> = {
  glosses: 4096,
  hints: 8192,
  mappings: 6144,
  sources: 8192,
  type: 2048,
  components: 2048,
  "cmavo-class": 2048,
  definition: 6144,
  places: 2048,
};
export const taskMaxTokens = (
  config: Pick<ProviderConfig, "maxTokens">,
  task: Task,
) => Math.min(config.maxTokens, taskTokenCaps[task]);
type ProviderEnv = Partial<
  Record<
    | "JVC_AI_ENABLED"
    | "JVC_AI_BASE_URL"
    | "JVC_AI_MODEL"
    | "JVC_AI_PROVIDER_ROUTE"
    | "JVC_AI_PROVIDER_NAME"
    | "JVC_AI_REASONING_EFFORT"
    | "JVC_AI_DECISION_REPORTS"
    | "JVC_AI_MAX_TOKENS"
    | "JVC_AI_TIMEOUT_MS"
    | "JVC_AI_CONCURRENCY"
    | "JVC_AI_MAX_COST_USD"
    | "JVC_AI_MAX_PRICE"
    | "JVC_AI_INPUT_PRICE"
    | "JVC_AI_OUTPUT_PRICE"
    | "JVC_AI_HOURLY_BUDGET_USD"
    | "JVC_AI_DAILY_BUDGET_USD"
    | "JVC_AI_NETWORK_HOURLY_BUDGET_USD"
    | "JVC_AI_NETWORK_DAILY_BUDGET_USD"
    | "JVC_AI_OPERATIONS",
    string
  >
>;
export function providerConfig(
  env: ProviderEnv,
  key: () => Promise<string>,
): ProviderConfig | undefined {
  if (env.JVC_AI_ENABLED !== "enabled") return;
  const baseUrl = env.JVC_AI_BASE_URL ?? "https://openrouter.ai/api/v1";
  const url = new URL(baseUrl);
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "AI provider URL must use HTTPS or loopback HTTP without credentials or query fields.",
    );
  const number = (
    name: keyof ProviderEnv,
    fallback: number,
    min: number,
    max: number,
  ) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isFinite(value) || value < min || value > max)
      throw new Error(`Invalid ${name}.`);
    return value;
  };
  const configured = (env.JVC_AI_OPERATIONS ?? operations.join(","))
    .split(",")
    .filter(Boolean);
  if (configured.some((name) => !operations.includes(name)))
    throw new Error("Unknown AI operation.");
  const effort = env.JVC_AI_REASONING_EFFORT ?? "medium";
  if (!["none", "minimal", "low", "medium", "high", "xhigh"].includes(effort))
    throw new Error("Unknown AI reasoning effort.");
  const maxTokens = Math.floor(number("JVC_AI_MAX_TOKENS", 16384, 128, 32768));
  const maxPrice = number("JVC_AI_MAX_PRICE", 10, 0.001, 100);
  const hourlyBudgetUsd = number(
    "JVC_AI_HOURLY_BUDGET_USD",
    32,
    0.000001,
    10000,
  );
  const dailyBudgetUsd = number(
    "JVC_AI_DAILY_BUDGET_USD",
    160,
    0.000001,
    100000,
  );
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    model: env.JVC_AI_MODEL ?? "meta/muse-spark-1.3-contributor",
    route: env.JVC_AI_PROVIDER_ROUTE ?? "meta",
    providerName: env.JVC_AI_PROVIDER_NAME ?? "OpenRouter",
    reasoningEffort: effort,
    key,
    decisionReports: env.JVC_AI_DECISION_REPORTS === "enabled",
    maxTokens,
    timeoutMs: Math.floor(number("JVC_AI_TIMEOUT_MS", 120000, 10, 540000)),
    concurrency: Math.floor(number("JVC_AI_CONCURRENCY", 2, 1, 4)),
    maxCostUsd:
      env.JVC_AI_MAX_COST_USD === undefined
        ? undefined
        : number("JVC_AI_MAX_COST_USD", 0, 0.000001, 10000),
    maxPrice,
    inputPrice: number("JVC_AI_INPUT_PRICE", 0.1, 0, 1000),
    outputPrice: number("JVC_AI_OUTPUT_PRICE", 0.2, 0, 1000),
    hourlyBudgetUsd,
    dailyBudgetUsd,
    networkHourlyBudgetUsd: number(
      "JVC_AI_NETWORK_HOURLY_BUDGET_USD",
      hourlyBudgetUsd / 4,
      0.00000025,
      10000,
    ),
    networkDailyBudgetUsd: number(
      "JVC_AI_NETWORK_DAILY_BUDGET_USD",
      dailyBudgetUsd / 4,
      0.00000025,
      100000,
    ),
    operations: configured,
  };
}
const obj = (properties: JsonObject): JsonObject => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const str = { type: "string", minLength: 1 };
const shapes = JSON.parse(promptFiles["answer-shapes.json"]).value_shape;
export interface TaskCase {
  task: Task;
  input: string;
  keys?: string[];
  components?: string[];
  ambiguousComponents?: string[];
  definitionLabels?: string[];
  language?: string;
  word?: string;
  check?: (answer: JsonObject) => string[];
}
export const sourceLanguages: Record<string, string> = {
  en: "english",
  zh: "mandarin-chinese",
  hi: "hindi",
  es: "spanish",
  ru: "russian",
  ar: "arabic",
  bn: "bengali",
  pt: "portuguese",
  fr: "french",
  ms: "malay",
  de: "german",
  ja: "japanese",
  eng: "english",
  cmn: "mandarin-chinese",
  hin: "hindi",
  spa: "spanish",
  rus: "russian",
  ara: "arabic",
  ben: "bengali",
  por: "portuguese",
  fra: "french",
  msa: "malay",
  deu: "german",
  jpn: "japanese",
};
const permittedComponents = (spec: TaskCase) => {
  const ambiguous = new Set(spec.ambiguousComponents ?? []);
  return [...new Set(spec.components ?? [])].filter(
    (name) => !ambiguous.has(name),
  );
};
export function schemaFor(spec: TaskCase): JsonObject {
  if (["glosses", "hints", "mappings"].includes(spec.task))
    return obj(
      Object.fromEntries(
        (spec.keys ?? []).map((key) => [key, shapes[spec.task]]),
      ),
    );
  if (spec.task === "sources") return shapes.sources;
  if (spec.task === "type")
    return obj({
      word_type: {
        type: "string",
        enum: [
          "gismu",
          "lujvo",
          "cmavo",
          "fuivla",
          "cmevla",
          "compound",
          "letteral",
          "other",
        ],
      },
      reason: str,
    });
  if (spec.task === "components")
    return obj({
      components: {
        type: "array",
        minItems: 2,
        maxItems: 8,
        items: obj({
          spelling: str,
          definition: {
            type: ["string", "null"],
            enum: [...(spec.definitionLabels ?? []), null],
          },
        }),
      },
      reason: str,
    });
  if (spec.task === "cmavo-class")
    return obj({
      selmaho: { type: "array", minItems: 1, maxItems: 16, items: str },
      reason: str,
    });
  if (spec.task === "places")
    return obj({
      places: { type: "array", maxItems: 16, items: obj({ description: str }) },
      reason: str,
    });
  return obj({ text: str, reason: str });
}
/** This local checker supports every keyword in the bundled answer schemas. */
function shapeProblems(
  schema: JsonObject,
  value: unknown,
  path = "answer",
): string[] {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type =
    value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (!types.includes(type))
    return [`${path} must have type ${types.join(" or ")}.`];
  const problems: string[] = [];
  if (schema.enum && !schema.enum.includes(value))
    problems.push(`${path} must be one of ${schema.enum.join(", ")}.`);
  if (
    typeof value === "string" &&
    value.trim().length < (schema.minLength ?? 0)
  )
    problems.push(`${path} must be nonempty text.`);
  if (isObject(value)) {
    const properties = schema.properties ?? {};
    const unknown = Object.keys(value).filter(
      (key) => !Object.hasOwn(properties, key),
    );
    // Reserve space for both missing and unknown fields in the correction.
    for (const key of schema.required ?? []) {
      if (problems.length >= 32 - Math.min(unknown.length, 8)) break;
      if (!Object.hasOwn(value, key))
        problems.push(`${path}.${key} is missing.`);
    }
    for (const key of unknown.slice(0, 8))
      problems.push(
        `${path}.${key.slice(0, 64)}${key.length > 64 ? "..." : ""} is not allowed.`,
      );
    for (const [key, child] of Object.entries(value)) {
      if (problems.length >= 32) break;
      if (Object.hasOwn(properties, key))
        problems.push(
          ...shapeProblems(properties[key], child, `${path}.${key}`),
        );
    }
  }

  if (Array.isArray(value)) {
    if (
      value.length < (schema.minItems ?? 0) ||
      value.length > (schema.maxItems ?? 256)
    )
      return [`${path} has an invalid number of entries.`];
    for (let index = 0; index < value.length && problems.length < 32; index++)
      problems.push(
        ...shapeProblems(schema.items, value[index], `${path}[${index}]`),
      );
  }
  return problems.slice(0, 32);
}
export function checkAnswer(spec: TaskCase, value: unknown): string[] {
  const problems = shapeProblems(schemaFor(spec), value);
  if (problems.length || !isObject(value)) return problems;
  if (spec.task === "glosses") {
    for (const [key, row] of Object.entries(value)) {
      if (!row.gloss.trim()) problems.push(`${key}.gloss must be nonempty.`);
      if (
        row.sense.trim() &&
        row.gloss.trim().toLowerCase() === row.sense.trim().toLowerCase()
      )
        problems.push(`${key}.sense repeats the gloss.`);
      if (key === "word" && !row.sense.trim())
        problems.push("word.sense must state the defining condition.");
    }
  } else if (spec.task === "hints") {
    for (const [key, row] of Object.entries(value)) {
      if (row.some((entry: JsonObject) => !entry.reason.trim()))
        problems.push(`${key} needs a reason for every alternative.`);
      if (
        row.some((entry: JsonObject) => entry.type === "unclear") &&
        row.some((entry: JsonObject) => entry.type !== "unclear")
      )
        problems.push(`${key}: unclear must stand alone.`);
    }
  } else if (spec.task === "mappings") {
    const permitted = permittedComponents(spec);
    const examples: string[] = [];
    for (const name of permitted) {
      if (examples.length === 4 || [...examples, name].join(", ").length > 300)
        break;
      examples.push(name);
    }
    const guidance = examples.length
      ? `${examples.join(", ")}${examples.length < permitted.length ? ", other unique permitted places" : ""}, none, or unclear`
      : permitted.length
        ? "a unique name from the permitted list, none, or unclear"
        : "none or unclear";
    for (const [key, row] of Object.entries(value)) {
      const names = row.map((entry: JsonObject) => entry.component);
      if (!row.length) problems.push(`${key} must be a nonempty array.`);
      if (new Set(names).size !== names.length)
        problems.push(`${key} lists the same component place twice.`);
      if (
        names.some((name: string) => ["none", "unclear"].includes(name)) &&
        names.length > 1
      )
        problems.push(`${key}: none and unclear must stand alone.`);
      for (const entry of row) {
        if (![...permitted, "none", "unclear"].includes(entry.component))
          problems.push(
            `${key}: ${entry.component.slice(0, 64)} is not a unique supplied component place. Use ${guidance}.`,
          );
        const sentinel = ["none", "unclear"].includes(entry.component);
        const kinds = sentinel
          ? [entry.component]
          : ["direct", "merged", "distributed", "functional"];
        const prefix = kinds.find((kind) =>
          entry.reason.startsWith(`${kind}: `),
        );
        const explanation = prefix ? entry.reason.slice(prefix.length + 2) : "";
        if (
          !prefix ||
          !/^\S/u.test(explanation) ||
          !/[\p{L}\p{N}]/u.test(explanation)
        )
          problems.push(
            `${key}: ${entry.component} needs a reason that starts with ${kinds.map((kind) => `"${kind}: "`).join(" or ")}, followed by an explanation.`,
          );
      }
    }
  } else if (spec.task === "sources") {
    const fields = ["word", "sense", "stem", "word_ipa", "ipa", "sounds"];
    for (const field of fields)
      if (value[field] !== null && !value[field].trim())
        problems.push(`${field} must be nonempty or null.`);
    if (
      value.word === null &&
      fields.slice(1).some((field) => value[field] !== null)
    )
      problems.push("word is null, so every later field must be null.");
    if (
      value.sense === null &&
      fields.slice(2).some((field) => value[field] !== null)
    )
      problems.push("sense is null, so every later field must be null.");
    if (
      value.stem === null &&
      ["ipa", "sounds"].some((field) => value[field] !== null)
    )
      problems.push("stem is null, so ipa and sounds must be null.");
    if (
      value.word_ipa === null &&
      (value.ipa !== null || value.sounds !== null)
    )
      problems.push("word_ipa is null, so ipa and sounds must be null.");
    if (value.ipa === null && value.sounds !== null)
      problems.push("ipa is null, so sounds must be null.");
    if (fields.some((field) => value[field] === null) && !value.note.trim())
      problems.push("A field is null, so note must explain what is unknown.");
    if (value.word !== null && /\s/u.test(value.word.trim()))
      problems.push("word must contain one word.");
    for (const field of ["word_ipa", "ipa"])
      if (value[field] !== null && /[\s.]/u.test(value[field]))
        problems.push(`${field} must have no space or dot.`);
    if (
      value.sounds !== null &&
      !/^[abcdefgijklmnoprstuvxz]{1,64}$/.test(value.sounds)
    )
      problems.push(
        "sounds must have 1 through 64 scoring letters, with no separators.",
      );
    if (
      value.word !== null &&
      value.stem !== null &&
      value.word.trim() === value.stem.trim() &&
      !value.note.trim()
    )
      problems.push(
        "The stem is the whole word, so note must explain why nothing is removable.",
      );
  }
  return problems.concat(spec.check?.(value) ?? []);
}
export function foldHints(rows: { type: string; reason: string }[]) {
  const types = new Set(rows.map((row) => row.type));
  return rows.filter(
    (row, index) =>
      rows.findIndex((other) => other.type === row.type) === index &&
      (types.has("referent")
        ? row.type === "referent"
        : !(types.has("event") && ["state", "process"].includes(row.type))),
  );
}
export interface AttemptLog {
  attempt: number;
  reasoning_summary: string | null;
  text: string;
  tool_calls: unknown[];
  check: { accepted: boolean; problems: string[] };
  usage: JsonObject | null;
  cost_usd: number | null;
  request: JsonObject;
  response: unknown;
}
export interface ExchangeLog {
  task: Task;
  system_prompt: string;
  request: string;
  attempts: AttemptLog[];
}
export interface InferenceLog {
  operation: string;
  model: string;
  reasoning_effort: string;
  provider: string;
  prompt_version: string;
  prompt_files: string[];
  started_at: string;
  duration_ms: number;
  answers: number;
  corrections: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  unknown_cost_attempts: number;
  exchanges: ExchangeLog[];
}
export async function promptVersion(): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(promptFiles)),
  );
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
export function newLog(
  operation: string,
  config: ProviderConfig,
  version: string,
): InferenceLog {
  return {
    operation,
    model: config.model,
    reasoning_effort: config.reasoningEffort,
    provider: config.route,
    prompt_version: version,
    prompt_files: [],
    started_at: new Date().toISOString(),
    duration_ms: 0,
    answers: 0,
    corrections: 0,
    input_tokens: null,
    output_tokens: null,
    cost_usd: null,
    unknown_cost_attempts: 0,
    exchanges: [],
  };
}
/** Encrypted reasoning never leaves the server or enters a correction request. */
function publicResponse(
  value: unknown,
  key: string,
  copies = new WeakMap<object, unknown>(),
): unknown {
  const text = (value: string) => {
    const exact = value.includes(key)
      ? value
          .split(key)
          .join(key.length < 10 ? "*".repeat(key.length) : "[redacted]")
      : value;
    const pattern =
      /(?<![A-Za-z0-9_-])sk-(?:or-v1-|proj-)?[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g;
    return pattern.test(exact) ? exact.replace(pattern, "[redacted]") : exact;
  };
  const pending: {
    source: JsonObject | unknown[];
    target: JsonObject | unknown[];
  }[] = [];
  const copy = (value: unknown): unknown => {
    if (typeof value === "string") return text(value);
    if (typeof value !== "object" || value === null) return value;
    if (copies.has(value)) return copies.get(value);
    if (isObject(value) && value.type === "reasoning.encrypted") return null;
    const target = Array.isArray(value) ? [] : {};
    copies.set(value, target);
    pending.push({ source: value, target });
    return target;
  };
  const result = copy(value);
  while (pending.length) {
    const { source, target } = pending.pop()!;
    if (Array.isArray(source)) {
      for (const entry of source)
        if (!isObject(entry) || entry.type !== "reasoning.encrypted")
          (target as unknown[]).push(copy(entry));
    } else {
      for (const name of Object.keys(source)) {
        if (["encrypted", "encrypted_content"].includes(name.toLowerCase()))
          continue;
        Object.defineProperty(target, text(name), {
          value: copy(source[name]),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
  }
  return result;
}
/** Keep untrusted response graphs as JSON bytes. Reads preserve their public shape. */
function compactField(target: object, field: string, value: unknown): void {
  const encoded = compactJson(value);
  Object.defineProperty(target, field, {
    enumerable: true,
    configurable: true,
    get: () => JSON.parse(encoded),
  });
}
function summary(message: JsonObject): string | null {
  const details = Array.isArray(message.reasoning_details)
    ? message.reasoning_details
    : [];
  const text = details
    .filter(
      (item: unknown) => isObject(item) && item.type === "reasoning.summary",
    )
    .map((item: JsonObject) => item.summary ?? item.text)
    .filter((item: unknown) => typeof item === "string")
    .join("\n");
  return text || null;
}
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
const sum = (old: number | null, value: number | null) =>
  old === null || value === null || !Number.isSafeInteger(old + value)
    ? null
    : old + value;
const costSum = (old: number | null, value: number | null) =>
  old === null || value === null || !Number.isFinite(old + value)
    ? null
    : old + value;
export function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
async function boundedResponse(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body)
    throw new AssistanceError(
      502,
      "provider_error",
      "The provider returned no response body.",
    );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > INFERENCE_RESPONSE_BYTES)
        throw new AssistanceError(
          502,
          "provider_size",
          "The provider response exceeded the byte limit.",
        );
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}
export function taskMessages(
  config: Pick<ProviderConfig, "decisionReports">,
  spec: TaskCase,
) {
  const files = ["common.system.txt", `${spec.task}.task.txt`];
  if (spec.task === "sources") {
    const language =
      sourceLanguages[spec.language?.toLowerCase().split("-")[0] ?? ""];
    if (!language)
      throw new AssistanceError(
        400,
        "language",
        "No source prompt is available for this language.",
      );
    files.push("sound-guide.txt");
    if (config.decisionReports) files.push("explain.txt");
    files.push(`languages/${language}.txt`);
  } else if (config.decisionReports) files.push("explain.txt");
  const system = files.map((file) => promptFiles[file].trim()).join("\n\n");
  const legend = spec.keys?.length
    ? `\n\nIn submit_answer, use these keys: ${spec.keys.map((key) => (key === "word" ? `word for ${spec.word ?? "the whole word"}` : spec.word ? `${key} for ${spec.word}[${key.slice(1)}]` : `${key} for place ${key.slice(1)}`)).join(", ")}.`
    : "";
  const groupPlaces = (components: string[]) => {
    const grouped = new Map<string, string[]>();
    for (const component of components) {
      const match = /^(.*)\[(\d+)\]$/.exec(component);
      if (match)
        grouped.set(match[1], [...(grouped.get(match[1]) ?? []), match[2]]);
    }
    return Array.from(
      grouped,
      ([spelling, indices]) => `${spelling}[${indices.join(",")}]`,
    ).join("; ");
  };
  const ambiguous = new Set(spec.ambiguousComponents ?? []);
  const unique = permittedComponents(spec);
  const ambiguityLegend = ambiguous.size
    ? ` Ambiguous component places: ${groupPlaces([...ambiguous])}. Each listed name refers to more than one selected definition. Do not use these names. Use unclear for an unresolved mapping.`
    : "";
  const componentLegend =
    spec.task === "mappings" && spec.components?.length
      ? unique.length
        ? `\n\nPermitted component places: ${groupPlaces(unique)}. Each listed index names a separate place. Use one full spelling and index in each entry, for example ${unique[0]}.${ambiguityLegend}`
        : `\n\nNo component place has a unique selected definition. Use unclear for each mapping, for example unclear.${ambiguityLegend}`
      : "";
  const input = spec.input + legend + componentLegend;
  return {
    files,
    system,
    input,
    messages: [
      { role: "system", content: system },
      { role: "user", content: input },
    ] as JsonObject[],
  };
}
function answerTool(spec: TaskCase): JsonObject {
  return {
    type: "function",
    function: {
      name: "submit_answer",
      description:
        "Submit the complete answer. The tool checks it and reports every problem to fix.",
      parameters: schemaFor(spec),
    },
  };
}
function inferenceBody(
  config: ProviderConfig,
  messages: JsonObject[],
  tool: JsonObject,
  task: Task,
): JsonObject {
  return {
    model: config.model,
    stream: false,
    usage: { include: true },
    max_tokens: taskMaxTokens(config, task),
    reasoning: { effort: config.reasoningEffort },
    provider: {
      only: [config.route],
      allow_fallbacks: false,
      max_price: { prompt: config.maxPrice, completion: config.maxPrice },
    },
    tools: [tool],
    tool_choice: "auto",
    parallel_tool_calls: false,
    messages: messages.slice(),
  };
}
function prepareInference(
  config: ProviderConfig,
  spec: TaskCase,
  extraInputAllowance = 0,
) {
  const prepared = taskMessages(config, spec);
  const tool = answerTool(spec);
  const bytes = new TextEncoder().encode(
    compactJson(inferenceBody(config, prepared.messages, tool, spec.task)),
  ).byteLength;
  if (bytes > INFERENCE_INITIAL_REQUEST_BYTES + extraInputAllowance)
    throw new AssistanceError(
      413,
      "size",
      "The inference request exceeded its initial byte limit.",
    );
  return { ...prepared, tool, bytes };
}
/** Each UTF-8 request byte reserves one input token. The safety margin is two. */
export function inferenceTurnCost(
  config: ProviderConfig,
  requestBytes: number,
  outputTokens = config.maxTokens,
): number {
  return (
    (2 *
      (requestBytes * config.inputPrice + outputTokens * config.outputPrice)) /
    1000000
  );
}
/** Reserve three answers, with full responses and bounded feedback for corrections. */
export function estimateInferenceCost(
  config: ProviderConfig,
  spec: TaskCase,
  extraInputBytes = 0,
): number {
  const initialBytes = prepareInference(config, spec).bytes + extraInputBytes;
  return [0, 1, 2].reduce(
    (total, priorAnswers) =>
      total +
      inferenceTurnCost(
        config,
        initialBytes + priorAnswers * INFERENCE_CORRECTION_BYTES,
        taskMaxTokens(config, spec.task),
      ),
    0,
  );
}
export class InferenceRunner {
  private publicCopies = new WeakMap<object, unknown>();
  private publicKey = "";
  // Metadata and number growth fit inside this fixed allowance.
  private logBytes = 65536;
  constructor(
    private config: ProviderConfig,
    public log: InferenceLog,
    private signal: AbortSignal,
    private progress: (task: Task, attempt: number) => void = () => {},
  ) {}
  async run(spec: TaskCase, extraInputAllowance = 0): Promise<JsonObject> {
    const { files, system, input, messages, tool } = prepareInference(
      this.config,
      spec,
      extraInputAllowance,
    );
    for (const file of files)
      if (!this.log.prompt_files.includes(`/api/v1/assist/prompts/${file}`))
        this.log.prompt_files.push(`/api/v1/assist/prompts/${file}`);
    const exchange: ExchangeLog = {
      task: spec.task,
      system_prompt: system,
      request: input,
      attempts: [],
    };
    this.log.exchanges.push(exchange);
    const encodeSize = (value: unknown) =>
      new TextEncoder().encode(compactJson(value)).byteLength;
    this.logBytes += encodeSize(exchange) + 1;
    for (let attempt = 1; attempt <= 3; attempt++) {
      this.signal.throwIfAborted();
      this.progress(spec.task, attempt);
      const body = inferenceBody(this.config, messages, tool, spec.task);
      const turnEstimate = inferenceTurnCost(
        this.config,
        encodeSize(body),
        taskMaxTokens(this.config, spec.task),
      );
      // Reserve space for the complete bounded response and the visible fields
      // that also appear separately in the log. Never discard an admitted turn.
      const logLimit = Math.min(
        this.config.maxLogBytes ?? INFERENCE_LOG_BYTES,
        INFERENCE_LOG_BYTES,
      );
      if (
        this.logBytes +
          encodeSize(body) +
          5 * INFERENCE_RESPONSE_BYTES +
          INFERENCE_FEEDBACK_BYTES +
          8192 >
        logLimit
      )
        throw new AssistanceError(
          429,
          "log_limit",
          "The private inference log reached its byte limit. Continue by hand or start a new request.",
        );
      const key = (await abortable(this.config.key(), this.signal)).trim();
      if (!key || /\s/.test(key))
        throw new AssistanceError(
          503,
          "provider_credentials",
          "The provider key is unavailable.",
        );
      if (key !== this.publicKey) {
        this.publicCopies = new WeakMap();
        this.publicKey = key;
      }
      const entry: AttemptLog = {
        attempt,
        reasoning_summary: null,
        text: "",
        tool_calls: [],
        check: { accepted: false, problems: [] },
        usage: null,
        cost_usd: null,
        request: publicResponse(body, key, this.publicCopies) as JsonObject,
        response: null,
      };
      // These fields share the same immutable strings as the request snapshots.
      exchange.system_prompt = entry.request.messages[0].content;
      exchange.request = entry.request.messages[1].content;
      exchange.attempts.push(entry);
      this.log.answers++;
      const unknown = (message: string) => {
        entry.check.problems = [message];
        this.log.input_tokens = null;
        this.log.output_tokens = null;
        this.log.cost_usd = null;
        this.log.unknown_cost_attempts++;
      };
      let raw: string;
      let response: Response;
      let costRecorded = false;
      const recordCost = async (cost: number | null) => {
        if (costRecorded) return;
        costRecorded = true;
        await this.config.onCost?.(cost, turnEstimate);
      };
      try {
        response = await abortable(
          (this.config.fetch ?? fetch)(
            `${this.config.baseUrl}/chat/completions`,
            {
              method: "POST",
              redirect: "manual",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${key}`,
              },
              body: compactJson(body),
              signal: this.signal,
            },
          ),
          this.signal,
        );
        raw = await boundedResponse(response, this.signal);
      } catch (error) {
        unknown(
          this.signal.aborted
            ? "The provider request stopped before usage was reported."
            : "The provider request failed.",
        );
        await recordCost(null);
        this.signal.throwIfAborted();
        if (error instanceof AssistanceError) throw error;
        entry.check.problems = ["The provider request failed."];
        throw new AssistanceError(
          502,
          "provider_error",
          "The provider request failed.",
        );
      }
      let value: JsonObject;
      try {
        value = JSON.parse(raw) as JsonObject;
      } catch {
        entry.response = publicResponse(raw, key);
        unknown("The provider returned invalid JSON.");
        await recordCost(null);
        throw new AssistanceError(
          502,
          "provider_error",
          "The provider returned invalid JSON.",
        );
      }
      const visible = publicResponse(value, key) as JsonObject;
      compactField(entry, "response", visible);
      if (!isObject(value)) {
        unknown("The provider response must contain a JSON object.");
        await recordCost(null);
        throw new AssistanceError(
          502,
          "provider_error",
          "The provider response must contain a JSON object.",
        );
      }
      const usage = isObject(value.usage) ? value.usage : null;
      compactField(entry, "usage", publicResponse(usage, key));
      const cost =
        typeof usage?.cost === "number" &&
        Number.isFinite(usage.cost) &&
        usage.cost >= 0
          ? usage.cost
          : null;
      entry.cost_usd = cost;
      await recordCost(cost);
      this.log.input_tokens = sum(
        this.log.answers === 1 ? 0 : this.log.input_tokens,
        count(usage?.prompt_tokens),
      );
      this.log.output_tokens = sum(
        this.log.answers === 1 ? 0 : this.log.output_tokens,
        count(usage?.completion_tokens),
      );
      this.log.cost_usd = costSum(
        this.log.answers === 1 ? 0 : this.log.cost_usd,
        cost,
      );
      if (cost === null) this.log.unknown_cost_attempts++;
      if (!response.ok || !isObject(value) || value.error) {
        entry.check.problems = [
          `The provider returned HTTP ${response.status}.`,
        ];
        throw new AssistanceError(
          502,
          "provider_error",
          `The provider returned HTTP ${response.status}.`,
        );
      }
      const choice = Array.isArray(value.choices) ? value.choices[0] : null;
      if (!isObject(choice) || !isObject(choice.message)) {
        entry.check.problems = [
          "The provider response contains no assistant answer.",
        ];
        throw new AssistanceError(
          502,
          "provider_error",
          "The provider response contains no assistant answer.",
        );
      }
      const message = isObject(choice?.message) ? choice.message : {};
      const visibleMessage = visible.choices?.[0]?.message ?? {};
      entry.reasoning_summary = summary(visibleMessage);
      entry.text =
        typeof visibleMessage.content === "string"
          ? visibleMessage.content
          : "";
      const calls: JsonObject[] = Array.isArray(message.tool_calls)
        ? message.tool_calls
        : [];
      compactField(
        entry,
        "tool_calls",
        Array.isArray(visibleMessage.tool_calls)
          ? visibleMessage.tool_calls
          : [],
      );
      let answer: unknown;
      let problems: string[] = [];
      if (
        calls.length !== 1 ||
        calls[0]?.function?.name !== "submit_answer" ||
        typeof calls[0]?.id !== "string" ||
        !calls[0]?.id
      )
        problems = [
          "Call submit_answer exactly once with the complete answer.",
        ];
      else {
        try {
          if (typeof calls[0].function.arguments !== "string")
            throw new Error("Tool arguments must be a JSON string.");
          answer = JSON.parse(calls[0].function.arguments);
          problems = checkAnswer(spec, answer);
          if (compactJson(answer) !== compactJson(publicResponse(answer, key)))
            problems.push(
              "The answer contains private credential data. Remove it.",
            );
        } catch {
          problems = ["The tool arguments must contain valid JSON."];
        }
      }
      if (choice?.finish_reason === "length")
        problems.push("The answer reached the output token limit.");
      problems = (publicResponse(problems.slice(0, 32), key) as string[]).map(
        (problem) => problem.slice(0, 512),
      );
      entry.check = { accepted: problems.length === 0, problems };
      this.logBytes += encodeSize(entry) + 1;
      if (!problems.length) return answer as JsonObject;
      if (attempt === 3)
        throw new AssistanceError(
          422,
          "invalid_answer",
          "No usable answer after 3 tries. Try again or fill the rows in by hand.",
        );
      this.log.corrections++;
      const echo: JsonObject = { role: "assistant", content: entry.text };
      if (Array.isArray(visibleMessage.reasoning_details))
        compactField(
          echo,
          "reasoning_details",
          visibleMessage.reasoning_details,
        );
      const safeCalls: JsonObject[] = (
        calls.length === 1 ? (visibleMessage.tool_calls ?? []) : []
      )
        .filter(
          (call: JsonObject) =>
            typeof call?.id === "string" &&
            isObject(call.function) &&
            call.function.name === "submit_answer",
        )
        .map((call: JsonObject) => {
          let args = call.function.arguments;
          try {
            if (typeof args !== "string")
              throw new Error("Tool arguments must be a JSON string.");
            JSON.parse(args);
          } catch {
            args = "{}";
          }
          return { ...call, function: { ...call.function, arguments: args } };
        });
      const feedback =
        "The answer was not accepted. Fix every problem and call submit_answer with the complete corrected answer.\n" +
        problems.join("\n");
      if (safeCalls.length) {
        compactField(echo, "tool_calls", safeCalls);
        this.publicCopies.set(echo, echo);
        messages.push(
          echo,
          ...safeCalls.map((call) => ({
            role: "tool",
            tool_call_id: call.id,
            content: feedback,
          })),
        );
      } else {
        this.publicCopies.set(echo, echo);
        messages.push(echo, { role: "user", content: feedback });
      }
    }
    throw new Error("Unreachable inference state.");
  }
}
