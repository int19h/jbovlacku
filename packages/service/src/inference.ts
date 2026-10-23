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
  maxCostUsd: number;
  maxPrice: number;
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
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    model: env.JVC_AI_MODEL ?? "meta/muse-spark-1.3-contributor",
    route: env.JVC_AI_PROVIDER_ROUTE ?? "meta",
    providerName: env.JVC_AI_PROVIDER_NAME ?? "OpenRouter",
    reasoningEffort: effort,
    key,
    decisionReports: env.JVC_AI_DECISION_REPORTS === "enabled",
    maxTokens: Math.floor(number("JVC_AI_MAX_TOKENS", 16384, 128, 32768)),
    timeoutMs: Math.floor(number("JVC_AI_TIMEOUT_MS", 120000, 10, 900000)),
    concurrency: Math.floor(number("JVC_AI_CONCURRENCY", 2, 1, 4)),
    maxCostUsd: number("JVC_AI_MAX_COST_USD", 2, 0.001, 10),
    maxPrice: number("JVC_AI_MAX_PRICE", 10, 0.001, 100),
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
  definitionLabels?: string[];
  language?: string;
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
    for (const key of schema.required ?? [])
      if (!Object.hasOwn(value, key))
        problems.push(`${path}.${key} is missing.`);
    for (const [key, child] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties ?? {}, key))
        problems.push(`${path}.${key} is not allowed.`);
      else
        problems.push(
          ...shapeProblems(schema.properties[key], child, `${path}.${key}`),
        );
    }
  }
  if (Array.isArray(value)) {
    if (
      value.length < (schema.minItems ?? 0) ||
      value.length > (schema.maxItems ?? 256)
    )
      problems.push(`${path} has an invalid number of entries.`);
    value.forEach((item, index) =>
      problems.push(...shapeProblems(schema.items, item, `${path}[${index}]`)),
    );
  }
  return problems;
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
        if (
          ![...(spec.components ?? []), "none", "unclear"].includes(
            entry.component,
          )
        )
          problems.push(
            `${key}: ${entry.component} is not a supplied component place.`,
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
      ["word_ipa", "ipa", "sounds"].some((field) => value[field] !== null)
    )
      problems.push("stem is null, so every later field must be null.");
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
function publicResponse(value: unknown, key: string, depth = 0): unknown {
  if (depth > 64) return "[depth limit]";
  if (typeof value === "string")
    return value
      .split(key)
      .join("[redacted]")
      .replace(/sk-(?:or-v1-|proj-)?[A-Za-z0-9_-]{8,}/g, "[redacted]");
  if (Array.isArray(value))
    return value
      .filter(
        (entry) => !isObject(entry) || entry.type !== "reasoning.encrypted",
      )
      .map((entry) => publicResponse(entry, key, depth + 1));
  if (isObject(value)) {
    if (value.type === "reasoning.encrypted") return null;
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([name]) =>
            !["encrypted", "encrypted_content", "authorization"].includes(
              name.toLowerCase(),
            ),
        )
        .map(([name, entry]) => [
          String(publicResponse(name, key, depth + 1)),
          publicResponse(entry, key, depth + 1),
        ]),
    );
  }
  return value;
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
      if (bytes > 262144)
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
export class InferenceRunner {
  private reservedCost = 0;
  constructor(
    private config: ProviderConfig,
    public log: InferenceLog,
    private signal: AbortSignal,
    private progress: (task: Task, attempt: number) => void = () => {},
  ) {}
  async run(spec: TaskCase): Promise<JsonObject> {
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
      if (this.config.decisionReports) files.push("explain.txt");
      files.push(`languages/${language}.txt`);
    } else if (this.config.decisionReports) files.push("explain.txt");
    for (const file of files)
      if (!this.log.prompt_files.includes(`/api/v1/assist/prompts/${file}`))
        this.log.prompt_files.push(`/api/v1/assist/prompts/${file}`);
    const system = files.map((file) => promptFiles[file].trim()).join("\n\n");
    const legend = spec.keys?.length
      ? `\n\nIn submit_answer, use these keys: ${spec.keys.map((key) => (key === "word" ? "word for the whole word" : `${key} for place ${key.slice(1)}`)).join(", ")}.`
      : "";
    const input = spec.input + legend;
    const exchange: ExchangeLog = {
      task: spec.task,
      system_prompt: system,
      request: input,
      attempts: [],
    };
    this.log.exchanges.push(exchange);
    const messages: JsonObject[] = [
      { role: "system", content: system },
      { role: "user", content: input },
    ];
    const tool = {
      type: "function",
      function: {
        name: "submit_answer",
        description:
          "Submit the complete answer. The tool checks it and reports every problem to fix.",
        parameters: schemaFor(spec),
      },
    };
    for (let attempt = 1; attempt <= 3; attempt++) {
      this.signal.throwIfAborted();
      this.progress(spec.task, attempt);
      // UTF-8 bytes conservatively reserve input tokens, including tool metadata.
      const inputBound =
        new TextEncoder().encode(JSON.stringify({ messages, tools: [tool] }))
          .byteLength + 1024;
      const tokenBudget =
        Math.floor(
          ((this.config.maxCostUsd - this.reservedCost) * 1000000) /
            this.config.maxPrice,
        ) - inputBound;
      const maxTokens = Math.min(this.config.maxTokens, tokenBudget);
      if (maxTokens < 128)
        throw new AssistanceError(
          429,
          "billing_limit",
          "The inference budget is exhausted.",
        );
      this.reservedCost +=
        ((inputBound + maxTokens) * this.config.maxPrice) / 1000000;
      const body: JsonObject = {
        model: this.config.model,
        stream: false,
        usage: { include: true },
        max_tokens: maxTokens,
        reasoning: { effort: this.config.reasoningEffort },
        provider: {
          only: [this.config.route],
          allow_fallbacks: false,
          max_price: {
            prompt: this.config.maxPrice,
            completion: this.config.maxPrice,
          },
        },
        tools: [tool],
        tool_choice: "auto",
        parallel_tool_calls: false,
        messages: structuredClone(messages),
      };
      // Reserve space for the complete bounded response and the visible fields
      // that also appear separately in the log. Never discard an admitted turn.
      const logLimit = Math.min(this.config.maxLogBytes ?? 2097152, 2097152);
      const encodeSize = (value: unknown) =>
        new TextEncoder().encode(JSON.stringify(value)).byteLength;
      if (
        encodeSize(this.log) + encodeSize(body) + 5 * 262144 + 8192 >
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
      const entry: AttemptLog = {
        attempt,
        reasoning_summary: null,
        text: "",
        tool_calls: [],
        check: { accepted: false, problems: [] },
        usage: null,
        cost_usd: null,
        request: body,
        response: null,
      };
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
              body: JSON.stringify(body),
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
        value = publicResponse(JSON.parse(raw), key) as JsonObject;
      } catch {
        entry.response = publicResponse(raw, key);
        unknown("The provider returned invalid JSON.");
        throw new AssistanceError(
          502,
          "provider_error",
          "The provider returned invalid JSON.",
        );
      }
      entry.response = value;
      if (!isObject(value)) {
        unknown("The provider response must contain a JSON object.");
        throw new AssistanceError(
          502,
          "provider_error",
          "The provider response must contain a JSON object.",
        );
      }
      const usage = isObject(value.usage) ? value.usage : null;
      entry.usage = usage;
      const cost =
        typeof usage?.cost === "number" &&
        Number.isFinite(usage.cost) &&
        usage.cost >= 0
          ? usage.cost
          : null;
      entry.cost_usd = cost;
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
      if ((this.log.cost_usd ?? 0) > this.config.maxCostUsd) {
        entry.check.problems = [
          "The provider reported a cost above the inference budget.",
        ];
        throw new AssistanceError(
          429,
          "billing_limit",
          "The provider reported a cost above the inference budget.",
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
      entry.reasoning_summary = summary(message);
      entry.text = typeof message.content === "string" ? message.content : "";
      const calls: JsonObject[] = Array.isArray(message.tool_calls)
        ? message.tool_calls
        : [];
      entry.tool_calls = calls;
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
        } catch {
          problems = ["The tool arguments must contain valid JSON."];
        }
      }
      if (choice?.finish_reason === "length")
        problems.push("The answer reached the output token limit.");
      entry.check = { accepted: problems.length === 0, problems };
      if (!problems.length) return answer as JsonObject;
      if (attempt === 3)
        throw new AssistanceError(
          422,
          "invalid_answer",
          "No usable answer after 3 tries. Try again or fill the rows in by hand.",
        );
      this.log.corrections++;
      const echo: JsonObject = { role: "assistant", content: entry.text };
      if (Array.isArray(message.reasoning_details))
        echo.reasoning_details = message.reasoning_details;
      const safeCalls: JsonObject[] = calls
        .filter(
          (call) =>
            typeof call?.id === "string" &&
            isObject(call.function) &&
            call.function.name === "submit_answer",
        )
        .map((call) => {
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
        echo.tool_calls = safeCalls;
        messages.push(
          echo,
          ...safeCalls.map((call) => ({
            role: "tool",
            tool_call_id: call.id,
            content: feedback,
          })),
        );
      } else messages.push(echo, { role: "user", content: feedback });
    }
    throw new Error("Unreachable inference state.");
  }
}
