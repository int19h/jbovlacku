import {
  analyzeWord,
  buildLujvo,
  createEvent,
  inspectBody,
  interpretDefinition,
  utf8,
  wordId,
  canonicalize,
  rafsiPairId,
} from "../../core/src/index.ts";
import {
  AssistanceError,
  InferenceRunner,
  isObject,
  jsonParts,
  foldHints,
  newLog,
  promptVersion,
  sourceLanguages,
  estimateInferenceCost,
  normalizeClientNetwork,
  INFERENCE_GENERATED_FRAME_BYTES,
  abortable,
  type ProviderConfig,
  type InferenceLog,
  type Task,
  type TaskCase,
} from "./inference.ts";
import { promptFiles } from "./prompt-bundle.ts";
import { nearbyQuery } from "./nearby.ts";
import {
  prepareEmbedding,
  requestEmbedding,
  type EmbeddingResult,
} from "./embedding.ts";
export { AssistanceError } from "./inference.ts";

type Data = Record<string, any>;
export type Operation =
  | "type"
  | "lujvo"
  | "gismu-sources"
  | "cmavo-class"
  | "definition"
  | "places-glosses";
export interface AssistRequest {
  operation: Operation;
  draft_revision: string;
  language: string;
  meaning: string;
  current: {
    word_type: string | null;
    classification: Data | null;
    spelling: string | null;
    text: unknown[];
    frame: Data | null;
    glosses: unknown[];
    formation: Data | null;
    compound: Data | null;
  };
  context: string[];
  profile: string;
}
export interface ContextDefinition {
  event: string;
  body: Data;
}
export interface TypeDictionary {
  snapshot: string | null;
  query_words: string[];
  related: {
    event: string;
    word: string;
    kind: string;
    definition: string;
    truncated?: true;
  }[];
  /** Exact spellings from real entries in this job's snapshot. */
  entries: Map<string, string>;
}
export interface ExistingWord {
  word: string;
  event: string;
  conversion: "se" | "te" | "ve" | "xe" | null;
  revised_definition: string | null;
}
export interface AssistResult {
  existing?: ExistingWord | null;
  operation: Operation;
  draft_revision: string;
  proposals: { path: string; value: unknown }[];
  explanation: string;
  provenance: {
    provider: string;
    model: string;
    revision: null;
    recipe: string;
    seed: null;
  };
  usage: { input_tokens: number | null; output_tokens: number | null };
  log: InferenceLog;
}
export interface AssistanceOptions {
  provider?: ProviderConfig;
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Lower limits allow deterministic expiry and quota tests. */
  ttlMs?: number;
  sessionTtlMs?: number;
  sessionJobs?: number;
  networkJobs?: number;
  retainedJobs?: number;
  networkRetainedJobs?: number;
  networkSessions?: number;
  terminalReadMs?: number;
  requestBodyTimeoutMs?: number;
  budgetStore?: AssistanceBudgetStore;
}
export interface LegacyAssistanceBudgetEntry {
  id: string;
  at: number;
  reservedUsd: number;
  settledUsd: number;
  active: boolean;
}
export interface AssistanceBudgetEntry extends LegacyAssistanceBudgetEntry {
  networkHashes: string[];
  deadline: number;
  costKnown: boolean;
}
export type AssistanceBudgetSnapshot =
  | { version: 1; entries: LegacyAssistanceBudgetEntry[] }
  | {
      version: 2;
      networkHashKey: string;
      entries: AssistanceBudgetEntry[];
    };
export interface AssistanceBudgetStore {
  load(): Promise<AssistanceBudgetSnapshot | null>;
  save(snapshot: AssistanceBudgetSnapshot): Promise<void>;
}
const allOperations: Operation[] = [
  "type",
  "lujvo",
  "gismu-sources",
  "cmavo-class",
  "definition",
  "places-glosses",
];
const lexicalKinds = [
  "gismu",
  "lujvo",
  "cmavo",
  "fuhivla",
  "cmevla",
  "compound",
  "letteral",
  "other",
];
const errorShape = (code: string, message: string) => ({
  code,
  message,
  event: null,
  field: null,
});
const json = (value: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
function streamedJson(value: unknown) {
  const parts = jsonParts(value);
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        let chunk = "";
        while (chunk.length < 8192) {
          const next = parts.next();
          if (next.done) {
            if (chunk) controller.enqueue(encoder.encode(chunk));
            controller.close();
            return;
          }
          chunk += next.value;
        }
        controller.enqueue(encoder.encode(chunk));
      },
      cancel() {
        parts.return(undefined);
      },
    }),
    {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}
const exact = (value: unknown, keys: string[]) =>
  isObject(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const nonempty = (value: unknown, max: number) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  new TextEncoder().encode(value).byteLength <= max;
function schemaFrame(value: Data | null) {
  if (!value) return null;
  const frame: Data = {
    places: [],
    tail: null,
    constraints: [],
    ...structuredClone(value),
  };
  frame.places = frame.places.map((place: Data) => ({
    glosses: [],
    description: [],
    type_hints: [],
    defaults: [],
    constraints: [],
    derivation: [],
    ...place,
  }));
  return frame;
}
export function parseAssistRequest(value: unknown): AssistRequest {
  if (
    !exact(value, [
      "operation",
      "draft_revision",
      "language",
      "meaning",
      "current",
      "context",
      "profile",
    ])
  )
    throw new AssistanceError(
      400,
      "assist_request",
      "The assistance request has invalid fields.",
    );
  const request = value as AssistRequest;
  if (
    !allOperations.includes(request.operation) ||
    !nonempty(request.draft_revision, 128) ||
    !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(request.language) ||
    !nonempty(request.meaning, 16384) ||
    !["default", "components", "lujvo"].includes(request.profile) ||
    (request.profile !== "default" && request.operation !== "lujvo")
  )
    throw new AssistanceError(
      400,
      "assist_request",
      "The operation, revision, language, meaning or profile is invalid.",
    );
  if (
    !Array.isArray(request.context) ||
    request.context.length > 32 ||
    new Set(request.context).size !== request.context.length ||
    request.context.some(
      (event) =>
        typeof event !== "string" || !/^jve1:[a-f0-9]{64}$/.test(event),
    )
  )
    throw new AssistanceError(
      400,
      "context",
      "Context must name at most 32 distinct exact definition events.",
    );
  const current = request.current;
  if (
    !exact(current, [
      "word_type",
      "classification",
      "spelling",
      "text",
      "frame",
      "glosses",
      "formation",
      "compound",
    ]) ||
    (current.word_type !== null && !lexicalKinds.includes(current.word_type)) ||
    (current.spelling !== null &&
      (typeof current.spelling !== "string" ||
        current.spelling.length > 256)) ||
    !Array.isArray(current.text) ||
    !Array.isArray(current.glosses) ||
    [
      current.frame,
      current.classification,
      current.formation,
      current.compound,
    ].some((field) => field !== null && !isObject(field))
  )
    throw new AssistanceError(
      400,
      "current",
      "The current draft has invalid fields.",
    );
  if (
    current.classification &&
    (!lexicalKinds.includes(current.classification.kind) ||
      (current.word_type && current.word_type !== current.classification.kind))
  )
    throw new AssistanceError(
      400,
      "classification",
      "The draft type and classification must agree.",
    );
  if (
    request.operation === "cmavo-class" &&
    current.classification?.kind !== "cmavo"
  )
    throw new AssistanceError(
      400,
      "classification",
      "Choose the cmavo classification before requesting selma'o.",
    );
  if (request.operation === "gismu-sources") {
    if (
      !current.formation ||
      !Array.isArray(current.formation.sources) ||
      current.formation.sources.length !== 1 ||
      !isObject(current.formation.sources[0])
    )
      throw new AssistanceError(
        400,
        "formation",
        "A source request needs a formation object with exactly one language row.",
      );
    if (
      !sourceLanguages[
        String(current.formation.sources[0].language)
          .toLowerCase()
          .split("-")[0]
      ]
    )
      throw new AssistanceError(
        400,
        "language",
        "No source prompt is available for this language.",
      );
  }
  if (
    Array.isArray(current.formation?.sources) &&
    current.formation.sources.some(
      (row: unknown) =>
        isObject(row) &&
        (Object.hasOwn(row, "stem") || Object.hasOwn(row, "ipa")),
    )
  )
    throw new AssistanceError(
      400,
      "current",
      "Formation sources cannot contain private stem or ipa fields.",
    );
  // A synthetic body runs the shared schema and reference checks. Draft-only
  // empty source spellings remain editable, so the check uses a placeholder.
  try {
    const formation: Data | null = current.formation
      ? {
          algorithm: null,
          sources: [],
          weights_profile: null,
          generated: null,
          selected_score: null,
          selected_rank: null,
          selection_reason: [],
          candidates: [],
          conflicts: [],
          ...structuredClone(current.formation),
        }
      : null;
    if (Array.isArray(formation?.sources))
      for (const row of formation.sources)
        if (row.word === "") row.word = "unknown";
    const compound: Data | null = current.compound
      ? { score: null, notes: [], ...structuredClone(current.compound) }
      : null;
    if (Array.isArray(compound?.components))
      for (const row of compound.components)
        if (row.rafsi === "") row.rafsi = "unknown";
    // An editor can hold fewer parts than a published compound. Padding stays
    // inside this throwaway schema carrier. The provider sees the exact draft.
    if (Array.isArray(compound?.components)) {
      while (compound.components.length < 2)
        compound.components.push({
          word: { language: "jbo", spelling: "broda" },
          definition: null,
          rafsi: "broda",
        });
    }
    const body = {
      word: { language: "jbo" as const, spelling: "broda" },
      language: request.language,
      text: current.text,
      frame: schemaFrame(current.frame),
      glosses: current.glosses,
      operands: [],
      notes: [],
      examples: [],
      labels: [],
      sources: [],
      legacy: null,
      etymology: { text: [], formation, compound },
      classification: current.classification ?? { kind: "other", selmaho: [] },
      license: {
        expression: "CC0-1.0",
        url: "https://creativecommons.org/publicdomain/zero/1.0/",
        attribution: "",
      },
    };
    const record = createEvent(
      new Uint8Array(32),
      [],
      "00".repeat(16),
      {
        kind: "definition.publish",
        word: wordId(body.word),
        language: request.language,
        parents: [],
        origin: "native",
      },
      body,
    );
    const checked = inspectBody(
      utf8(JSON.stringify(record.envelope)),
      utf8(canonicalize(utf8(JSON.stringify(record.body)))),
    );
    if (checked.availability !== "valid")
      throw new Error("Invalid current fields.");
  } catch {
    throw new AssistanceError(
      400,
      "current",
      "The draft fields do not satisfy the definition schema and place references.",
    );
  }
  const interpreted = interpretDefinition<Data>({
    classification: current.classification,
    text: current.text,
    frame: current.frame,
    glosses: current.glosses,
    etymology: { formation: current.formation, compound: current.compound },
  });
  return {
    ...request,
    current: {
      ...current,
      classification: interpreted.classification,
      frame: interpreted.frame,
      glosses: interpreted.glosses,
      formation: interpreted.etymology.formation,
      compound: interpreted.etymology.compound,
    },
  };
}
function placeKeys(frame: Data | null): string[] {
  return (frame?.places ?? []).map((place: Data) => `x${place.index}`);
}
function caseText(
  request: AssistRequest,
  context: ContextDefinition[],
): string {
  return JSON.stringify({
    meaning: request.meaning,
    language: request.language,
    current: request.current,
    definitions: context,
  });
}
const promptKind = (kind: unknown) => (kind === "fuhivla" ? "fuivla" : kind);
const appKind = (kind: string) => (kind === "fuivla" ? "fuhivla" : kind);
const typeLabel = (kind: string) =>
  kind === "fuivla" ? "fu'ivla" : kind === "compound" ? "compound cmavo" : kind;
/** Compound parts come only from the application's morphology API. */
export function typeSpellingFields(analysis: {
  kind: string;
  parts?: string[];
}) {
  if (analysis.kind === "compound")
    return analysis.parts && analysis.parts.length >= 2
      ? { spelling_form: "compound", spelling_parts: analysis.parts }
      : { spelling_form: "unknown" };
  return { spelling_form: promptKind(analysis.kind) };
}
/** The frozen prompt uses fuivla. Signed records use fuhivla. */
function typeCase(
  request: AssistRequest,
  context: ContextDefinition[],
  dictionary: TypeDictionary,
) {
  const current = structuredClone(request.current);
  current.word_type = promptKind(current.word_type) as string | null;
  if (current.classification)
    current.classification.kind = promptKind(current.classification.kind);
  const input: Data = {
    meaning: request.meaning,
    language: request.language,
    current,
    definitions: context.map((entry) => ({
      ...entry,
      body: {
        ...entry.body,
        classification: {
          ...entry.body.classification,
          kind: promptKind(entry.body.classification.kind),
        },
      },
    })),
    related: dictionary.related.map(({ event, kind, ...entry }, index) => ({
      ref: `r${index + 1}`,
      ...entry,
      kind: promptKind(kind),
    })),
  };
  let morphology: { id: string; version: string } | undefined;
  if (request.current.spelling?.trim()) {
    try {
      const analysis = analyzeWord("extended", request.current.spelling);
      morphology = analysis.morphology;
      Object.assign(input, typeSpellingFields(analysis));
    } catch {
      input.spelling_form = "unknown";
    }
  }
  return { input, morphology };
}
function checkType(
  answer: Data,
  spellingForm: unknown,
  supplied: Map<string, { event: string; word: string }>,
  dictionary: TypeDictionary,
): string[] {
  const problems: string[] = [];
  if (answer.alternative !== null && answer.alternative === answer.word_type)
    problems.push("alternative must differ from word_type.");
  if (
    answer.word_type === null &&
    (answer.alternative !== null || answer.existing !== null)
  )
    problems.push(
      "A null word_type has no alternative and no existing word. Set alternative, alternative_reason and existing to null.",
    );
  if ((answer.alternative === null) !== (answer.alternative_reason === null))
    problems.push(
      "When alternative is a type, give alternative_reason. Otherwise set both to null.",
    );
  if (!answer.reason.trim()) problems.push("Write a reason.");
  if (
    typeof answer.alternative_reason === "string" &&
    !answer.alternative_reason.trim()
  )
    problems.push(
      "Write alternative_reason, or set alternative and alternative_reason to null.",
    );
  if (answer.existing) {
    const entry = supplied.get(answer.existing.ref);
    if (!entry || entry.word !== answer.existing.word)
      problems.push(
        "existing.ref must name a supplied entry, and existing.word must be its word. Name only a word that related or definitions shows, or set existing to null.",
      );
    if (!entry || dictionary.entries.get(entry.event) !== answer.existing.word)
      problems.push(
        "existing.word is not a dictionary entry. Name only a word that related or definitions shows, or set existing to null.",
      );
    if (
      typeof answer.existing.revised_definition === "string" &&
      !answer.existing.revised_definition.trim()
    )
      problems.push("Write the revised definition, or set it to null.");
  }
  if (
    ["cmavo", "compound"].includes(answer.word_type) &&
    ["cmavo", "compound"].includes(spellingForm as string) &&
    answer.word_type !== spellingForm
  )
    problems.push(
      "The application's analysis of the spelling decides between cmavo and compound. Use the type that spelling_form shows.",
    );
  return problems;
}
function validateProposedFrame(
  request: AssistRequest,
  frame: Data,
  glosses: unknown[],
): string[] {
  try {
    parseAssistRequest({
      ...request,
      current: { ...request.current, frame, glosses },
    });
    return [];
  } catch {
    return [
      "The proposed frame must satisfy the definition schema and every place reference.",
    ];
  }
}
function checkComponentContext(
  request: AssistRequest,
  context: ContextDefinition[],
) {
  if (request.operation !== "lujvo") return;
  const byEvent = new Map(context.map((entry) => [entry.event, entry]));
  for (const component of request.current.compound?.components ?? []) {
    if (component.definition === null) continue;
    const supplied = byEvent.get(component.definition);
    if (
      !supplied ||
      supplied.body.word?.language !== component.word?.language ||
      supplied.body.word?.spelling !== component.word?.spelling
    )
      throw new AssistanceError(
        400,
        "component_context",
        "Each selected component definition must be supplied for that exact word.",
      );
  }
}
function mappingMetadata(request: AssistRequest, context: ContextDefinition[]) {
  const componentByPlace = new Map<
    string,
    { component: Data; place: number }[]
  >();
  const definitions = (request.current.compound?.components ?? []).map(
    (component: Data) => {
      const source = context.find(
        (entry) =>
          entry.event === component.definition &&
          entry.body.word?.language === component.word?.language &&
          entry.body.word?.spelling === component.word?.spelling,
      );
      const places = (source?.body.frame?.places ?? []).map(
        (place: Data) => place.index,
      );
      for (const place of places) {
        const name = `${component.word.spelling}[${place}]`;
        const candidates = componentByPlace.get(name) ?? [];
        if (
          !candidates.some(
            (entry) => entry.component.definition === component.definition,
          )
        )
          candidates.push({ component, place });
        componentByPlace.set(name, candidates);
      }
      return { word: component.word, definition: component.definition, places };
    },
  );
  return {
    componentByPlace,
    definitions,
    components: [...componentByPlace.keys()],
    ambiguousComponents: [...componentByPlace]
      .filter(([, candidates]) => candidates.length > 1)
      .map(([name]) => name),
  };
}
/** Estimate all possible tasks before the service admits a paid job. */
export function estimateAssistanceCost(
  request: AssistRequest,
  context: ContextDefinition[],
  config: ProviderConfig,
): number {
  // Reserve every related slot, including JSON escaping and maximum word bytes.
  const input =
    request.operation === "type"
      ? JSON.stringify({
          ...JSON.parse(caseText(request, context)),
          related: Array.from({ length: 30 }, (_, i) => ({
            ref: `r${i + 1}`,
            word: "w".repeat(256),
            kind: "compound",
            definition: "\u0000".repeat(500),
            truncated: true,
          })),
          spelling_form: "compound",
          spelling_parts: Array(256).fill("\u0000"),
        })
      : caseText(request, context);
  const cases: { spec: TaskCase; extra?: number }[] = [];
  if (request.operation === "places-glosses") {
    const generated = request.current.frame === null;
    if (generated) cases.push({ spec: { task: "places", input } });
    const keys = generated
      ? Array.from({ length: 16 }, (_, index) => `x${index + 1}`)
      : placeKeys(request.current.frame);
    // A generated frame can use the full output allowance. Its descriptions
    // pass through two JSON string layers in the following task requests.
    const extra = generated ? INFERENCE_GENERATED_FRAME_BYTES : 0;
    const common = { input, word: request.current.spelling || undefined };
    cases.push({
      spec: { ...common, task: "glosses", keys: ["word", ...keys] },
      extra,
    });
    if (keys.length)
      cases.push({ spec: { ...common, task: "hints", keys }, extra });
    const metadata = mappingMetadata(request, context);
    if (keys.length && metadata.components.length)
      cases.push({
        spec: {
          ...common,
          task: "mappings",
          input: JSON.stringify({
            ...JSON.parse(input),
            component_places: metadata.definitions,
          }),
          keys,
          components: metadata.components,
          ambiguousComponents: metadata.ambiguousComponents,
        },
        extra,
      });
  } else if (request.operation === "lujvo") {
    const definitions = context.map((entry, index) => ({
      ...entry,
      label: `d${index + 1}`,
    }));
    const byEvent = new Map(definitions.map((entry) => [entry.event, entry]));
    const labeled = structuredClone(request);
    for (const component of labeled.current.compound?.components ?? [])
      if (component.definition !== null)
        component.definition = byEvent.get(component.definition)!.label;
    cases.push({
      spec: {
        task: "components",
        input: caseText(labeled, definitions),
        definitionLabels: definitions.map((entry) => entry.label),
      },
    });
  } else
    cases.push({
      spec: {
        task:
          request.operation === "gismu-sources" ? "sources" : request.operation,
        input,
        language:
          request.operation === "gismu-sources"
            ? request.current.formation!.sources[0].language
            : undefined,
      },
    });
  return cases.reduce(
    (total, { spec, extra }) =>
      total + estimateInferenceCost(config, spec, extra),
    0,
  );
}
/** Use the smallest draft shapes that each operation accepts. */
export function minimumAssistanceCost(
  config: ProviderConfig,
  operation: Operation,
): number {
  const request: AssistRequest = {
    operation,
    draft_revision: "a",
    language: "aa",
    meaning: "a",
    current: {
      word_type: null,
      classification: null,
      spelling: "",
      text: [],
      frame: null,
      glosses: [],
      formation: null,
      compound: null,
    },
    context: [],
    profile: "default",
  };
  if (operation === "cmavo-class")
    request.current.classification = { kind: "cmavo", selmaho: [] };
  if (operation === "places-glosses")
    request.current.frame = { role: "predicate", arity: { mode: "context" } };
  if (operation === "gismu-sources") {
    return Math.min(
      ...Object.keys(sourceLanguages)
        .filter((language) => language.length === 2)
        .map((language) => {
          request.current.formation = {
            method: "unknown",
            sources: [
              { language, word: "", input: null, weight: null, notes: [] },
            ],
          };
          return estimateAssistanceCost(request, [], config);
        }),
    );
  }
  return estimateAssistanceCost(request, [], config);
}
function fitsEmptyAllowance(config: ProviderConfig, estimate: number) {
  return (
    estimate <=
    Math.min(
      config.hourlyBudgetUsd,
      config.dailyBudgetUsd,
      config.networkHourlyBudgetUsd,
      config.networkDailyBudgetUsd,
      config.maxCostUsd ?? Infinity,
    )
  );
}
/** The caller owns the log. This function does not persist draft data. */
export async function runAssistance(
  request: AssistRequest,
  config: ProviderConfig,
  context: ContextDefinition[],
  signal: AbortSignal,
  log: InferenceLog,
  progress: (task: Task, attempt: number) => void,
  typeDictionary: TypeDictionary = {
    snapshot: null,
    query_words: nearbyQuery(request.meaning),
    related: [],
    entries: new Map(),
  },
): Promise<AssistResult> {
  checkComponentContext(request, context);
  if (
    config.maxCostUsd !== undefined &&
    estimateAssistanceCost(request, context, config) > config.maxCostUsd
  )
    throw new AssistanceError(
      429,
      "billing_limit",
      "The complete inference job exceeds the configured budget.",
    );
  const runner = new InferenceRunner(config, log, signal, progress);
  const input = caseText(request, context);
  const proposals: AssistResult["proposals"] = [];
  const explanations: string[] = [];
  let existing: ExistingWord | null = null;
  if (request.operation === "type") {
    const type = typeCase(request, context, typeDictionary);
    log.related = {
      method: "lexical",
      query_words: typeDictionary.query_words,
      snapshot: typeDictionary.snapshot,
      events: typeDictionary.related.map((entry) => entry.event),
    };
    if (type.morphology) log.morphology = type.morphology;
    const supplied = new Map(
      context.map((entry) => [
        entry.event,
        { event: entry.event, word: entry.body.word.spelling },
      ]),
    );
    typeDictionary.related.forEach((entry, index) =>
      supplied.set(`r${index + 1}`, entry),
    );
    const answer = await runner.run({
      task: "type",
      input: JSON.stringify(type.input),
      check: (answer) =>
        checkType(answer, type.input.spelling_form, supplied, typeDictionary),
    });
    if (answer.word_type !== null)
      proposals.push({ path: "/word_type", value: appKind(answer.word_type) });
    explanations.push(answer.reason);
    if (answer.alternative !== null)
      explanations.push(
        `Also possible: ${typeLabel(answer.alternative)}. ${answer.alternative_reason}`,
      );
    if (answer.existing) {
      const { ref, ...rest } = answer.existing;
      existing = { ...rest, event: supplied.get(ref)!.event } as ExistingWord;
    }
  } else if (request.operation === "cmavo-class") {
    const answer = await runner.run({
      task: "cmavo-class",
      input,
      check: (answer) =>
        new Set(answer.selmaho).size === answer.selmaho.length
          ? []
          : ["Do not repeat a selma'o."],
    });
    proposals.push({ path: "/classification/selmaho", value: answer.selmaho });
    explanations.push(answer.reason);
  } else if (request.operation === "definition") {
    const answer = await runner.run({ task: "definition", input });
    proposals.push({ path: "/text", value: [[answer.text]] });
    explanations.push(answer.reason);
  } else if (request.operation === "gismu-sources") {
    const row = request.current.formation!.sources[0];
    const answer = await runner.run({
      task: "sources",
      language: row.language,
      input,
    });
    proposals.push({
      path: "/formation/sources",
      value: [
        {
          ...Object.fromEntries(
            ["word", "word_ipa", "stem", "ipa"]
              .filter((name) => answer[name] !== null)
              .map((name) => [name, answer[name]]),
          ),
          ...(answer.sounds === null
            ? {}
            : { input: { format: "lojbanized", text: answer.sounds } }),
          notes: [
            ...(answer.sense?.trim() ? [[`Sense: ${answer.sense}`]] : []),
            ...(answer.note.trim() ? [[`Note: ${answer.note}`]] : []),
          ],
        },
      ],
    });
    explanations.push(
      answer.note ||
        "Review the source word, its pronunciation, stem and scoring letters.",
    );
  } else if (request.operation === "lujvo") {
    // Labels belong to this request only. Keep event metadata in the request
    // log so the author can trace each label to its exact supplied definition.
    const definitions = context.map((entry, index) => ({
      ...entry,
      label: `d${index + 1}`,
    }));
    const byLabel = new Map(definitions.map((entry) => [entry.label, entry]));
    const byEvent = new Map(definitions.map((entry) => [entry.event, entry]));
    const labeledRequest = structuredClone(request);
    for (const component of labeledRequest.current.compound?.components ?? [])
      if (component.definition !== null) {
        const supplied = byEvent.get(component.definition)!;
        component.definition = supplied.label;
      }
    let constructed: ReturnType<typeof buildLujvo> | undefined;
    let resolvedComponents: Data[] = [];
    const answer = await runner.run({
      task: "components",
      input: caseText(labeledRequest, definitions),
      definitionLabels: definitions.map((entry) => entry.label),
      check(answer) {
        try {
          if (
            answer.components.some(
              (component: Data) =>
                component.definition !== null &&
                byLabel.get(component.definition)?.body.word?.spelling !==
                  component.spelling,
            )
          )
            return [
              "Every component definition must name a supplied definition label for that word, or null.",
            ];
          const components = answer.components.map((component: Data) => ({
            ...component,
            definition:
              component.definition === null
                ? null
                : byLabel.get(component.definition)!.event,
          }));
          const fixedByIndex = new Map<number, Data>();
          let nextIndex = 0;
          for (const fixed of request.current.compound?.components ?? []) {
            const index = components.findIndex(
              (component: Data, index: number) =>
                index >= nextIndex &&
                component.spelling === fixed.word?.spelling &&
                (fixed.definition === null ||
                  component.definition === fixed.definition),
            );
            if (index < 0) return ["Keep the declared component constraints."];
            fixedByIndex.set(index, fixed);
            nextIndex = index + 1;
          }
          const result = buildLujvo({
            profile: "extended",
            components: components.map((component: Data, index: number) => {
              const analysis = analyzeWord("extended", component.spelling);
              const fixed = fixedByIndex.get(index);
              return {
                id: String(index),
                spelling: component.spelling,
                kind: analysis.kind,
                definition: component.definition,
                locked: fixed?.rafsi || null,
                // This is the author's explicit draft choice. It does not
                // assert accepted assignment standing or an endorsement.
                claims: fixed?.rafsi
                  ? [
                      {
                        rafsi: fixed.rafsi,
                        pair: rafsiPairId(
                          wordId({
                            language: "jbo",
                            spelling: component.spelling,
                          }),
                          fixed.rafsi,
                        ),
                      },
                    ]
                  : [],
              };
            }),
            limits: { choice_product: 4096, results: 1 },
          });
          if (!result.candidates.length)
            return [
              "The deterministic builder could not construct and recover these components. Choose supported component forms.",
            ];
          constructed = result;
          resolvedComponents = components;
          return [];
        } catch {
          return [
            "The deterministic builder could not analyse the proposed components. Choose supported component words.",
          ];
        }
      },
    });
    const built = constructed!;
    const candidate = built.candidates[0];
    const compound = {
      components: resolvedComponents.map((component: Data, index: number) => ({
        word: { language: "jbo", spelling: component.spelling },
        definition: component.definition,
        rafsi: candidate.parts[index].form,
      })),
      morphology: built.morphology,
      scoring: built.scoring,
      score: candidate.score,
      notes: [[answer.reason]],
    };
    proposals.push({ path: "/compound", value: compound });
    if (request.profile !== "components")
      proposals.push({ path: "/spelling", value: candidate.spelling });
    explanations.push(answer.reason);
  } else {
    const generatedFrameBytes =
      request.current.frame === null ? INFERENCE_GENERATED_FRAME_BYTES : 0;
    let frame = request.current.frame
      ? structuredClone(request.current.frame)
      : null;
    if (frame === null) {
      const answer = await runner.run({
        task: "places",
        input,
        check(answer) {
          const proposed = {
            role: "predicate",
            arity: { mode: "fixed", count: answer.places.length },
            places: answer.places.map((place: Data, index: number) => ({
              index: index + 1,
              description: [[place.description]],
            })),
            tail: null,
            constraints: [],
          };
          return validateProposedFrame(
            request,
            proposed,
            request.current.glosses,
          );
        },
      });
      frame = {
        role: "predicate",
        arity: { mode: "fixed", count: answer.places.length },
        places: answer.places.map((place: Data, index: number) => ({
          index: index + 1,
          description: [[place.description]],
          glosses: [],
          type_hints: [],
          defaults: [],
          constraints: [],
          derivation: [],
        })),
        tail: null,
        constraints: [],
      };
      explanations.push(answer.reason);
    }
    const keys = placeKeys(frame);
    const placeInput = caseText(
      { ...request, current: { ...request.current, frame } },
      context,
    );
    const glosses = await runner.run(
      {
        task: "glosses",
        word: request.current.spelling || undefined,
        input: placeInput,
        keys: ["word", ...keys],
      },
      generatedFrameBytes,
    );
    const hints = keys.length
      ? await runner.run(
          {
            task: "hints",
            word: request.current.spelling || undefined,
            input: placeInput,
            keys,
          },
          generatedFrameBytes,
        )
      : {};
    const metadata = mappingMetadata(request, context);
    const { componentByPlace } = metadata;
    const mappings =
      keys.length && metadata.components.length
        ? await runner.run(
            {
              task: "mappings",
              word: request.current.spelling || undefined,
              input: JSON.stringify({
                ...JSON.parse(placeInput),
                component_places: metadata.definitions,
              }),
              keys,
              components: metadata.components,
              ambiguousComponents: metadata.ambiguousComponents,
              check(answer) {
                const problems: string[] = [];
                for (const [key, rows] of Object.entries(answer))
                  for (const entry of rows)
                    if (
                      (componentByPlace.get(entry.component)?.length ?? 0) > 1
                    )
                      problems.push(
                        `${key}: ${entry.component} refers to distinct selected definitions. Use unclear for this mapping.`,
                      );
                return problems;
              },
            },
            generatedFrameBytes,
          )
        : {};
    for (const place of frame!.places ?? []) {
      const key = `x${place.index}`;
      place.glosses = [
        ...(place.glosses ?? []).filter(
          (entry: Data) => entry.language !== "en",
        ),
        {
          language: "en",
          text: glosses[key].gloss,
          sense: glosses[key].sense || null,
        },
      ];
      const alternatives = foldHints(hints[key]);
      place.type_hints =
        alternatives[0]?.type === "unclear"
          ? []
          : [
              {
                alternatives: alternatives.map((entry) => ({
                  tags: [entry.type],
                  abstractor: null,
                  relation_arity: null,
                })),
                note: alternatives.map((entry) => [
                  `${entry.type}: ${entry.reason}`,
                ]),
              },
            ];
      if (alternatives[0]?.type === "unclear")
        explanations.push(`Place ${place.index}: ${alternatives[0].reason}`);
      if (mappings[key])
        place.derivation = mappings[key]
          .filter(
            (entry: Data) => !["none", "unclear"].includes(entry.component),
          )
          .map((entry: Data) => {
            const [{ component, place }] = componentByPlace.get(
              entry.component,
            )!;
            return {
              word: component.word,
              definition: component.definition,
              place,
              explanation: [[entry.reason]],
            };
          });
    }
    const wordGlosses = [
      ...request.current.glosses.filter(
        (entry) => isObject(entry) && entry.language !== "en",
      ),
      { language: "en", text: glosses.word.gloss, sense: glosses.word.sense },
    ];
    if (validateProposedFrame(request, frame!, wordGlosses).length)
      throw new AssistanceError(
        422,
        "invalid_answer",
        "The suggested places did not satisfy the frame and reference rules.",
      );
    proposals.push(
      { path: "/frame", value: frame },
      { path: "/glosses", value: wordGlosses },
    );
    explanations.push(
      "Review the places, glosses, type hints and component correspondences. English glosses retain their own language.",
    );
  }
  signal.throwIfAborted();
  return {
    ...(request.operation === "type" ? { existing } : {}),
    operation: request.operation,
    draft_revision: request.draft_revision,
    proposals,
    explanation: explanations.join("\n\n"),
    provenance: {
      provider: config.route,
      model: config.model,
      revision: null,
      recipe: log.prompt_version,
      seed: null,
    },
    usage: { input_tokens: log.input_tokens, output_tokens: log.output_tokens },
    log,
  };
}
interface Session {
  network: string;
  quotaExpires: number;
  touched: number;
  csrf: string;
  expires: number;
  count: number;
}
interface Job {
  reserved: boolean;
  discarded: boolean;
  networkUnits: string[];
  readUntil: number;
  budgetId: string;
  costReports: number;
  owner: string;
  network: string;
  deadline: number;
  expires: number;
  state:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancel_requested"
    | "canceled";
  result: AssistResult | null;
  error: (ReturnType<typeof errorShape> & { log?: InferenceLog }) | null;
  progress: { task: Task | null; attempt: number; max_attempts: 3 };
  controller: AbortController;
}
/** These callers are host services. No public request can select an operator. */
export type EmbeddingCaller =
  | { kind: "query"; network: string }
  | { kind: "index" | "probe" };
export interface EmbeddingOperation {
  id: string;
  kind: EmbeddingCaller["kind"];
  deadline: number;
  state:
    | "preparing"
    | "sent"
    | "completed"
    | "failed"
    | "timed_out"
    | "retained";
  transportPending: boolean;
  error: string | null;
}
export class AssistanceService {
  private sessions = new Map<string, Session>();
  private admitting = new Map<string, number>();
  private jobs = new Map<string, Job>();
  private expiredJobs = new Map<string, { owner: string; expires: number }>();
  private network = new Map<string, { expires: number; count: number }>();
  private running = 0;
  private embeddingWork = new Map<string, EmbeddingOperation>();
  private embeddingSlots = new Map<string, number>();
  private embeddingFailedWaits = new Set<string>();
  private embeddingSettled = new Map<
    string,
    {
      reservedUsd: number;
      chargedUsd: number;
      costKnown: boolean;
      summary: string | null;
    }
  >();
  private budgetEntries = new Map<string, AssistanceBudgetEntry>();
  private networkHashKey = "";
  private budgetLoaded = false;
  private budgetUnavailable = false;
  private budgetTail: Promise<void> = Promise.resolve();
  private version = promptVersion();
  constructor(
    private options: AssistanceOptions,
    private server: string,
    private context: (events: string[]) => Promise<ContextDefinition[]>,
    private typeDictionary?: (
      request: AssistRequest,
      context: ContextDefinition[],
      signal: AbortSignal,
    ) => Promise<TypeDictionary>,
  ) {}
  /** Detaching a caller never cancels or repeats an admitted provider request. */
  async embed(
    inputs: readonly Uint8Array[],
    caller: EmbeddingCaller,
    callerSignal?: AbortSignal,
  ): Promise<EmbeddingResult & { operation: string }> {
    callerSignal?.throwIfAborted();
    const config = this.options.provider;
    if (!config)
      throw new AssistanceError(
        503,
        "feature_disabled",
        "Embedding inference is disabled on this server.",
      );
    if (
      !["query", "index", "probe"].includes(caller.kind) ||
      (caller.kind === "query" &&
        (typeof caller.network !== "string" ||
          (caller.network !== "local" &&
            !normalizeClientNetwork(caller.network) &&
            !(
              caller.network.endsWith("/64") &&
              normalizeClientNetwork(caller.network.slice(0, -3)) ===
                caller.network
            ))))
    )
      throw new AssistanceError(
        400,
        "embedding_network",
        "An embedding query requires a client network.",
      );
    const deadline = Date.now() + config.timeoutMs;
    const prepared = prepareEmbedding(inputs, config);
    let operationId: string | undefined;
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new AssistanceError(
            504,
            "embedding_timeout",
            "The embedding request reached its time limit. Read its operation status before another attempt.",
          ),
        ),
      Math.max(1, deadline - Date.now()),
    );
    const signal = controller.signal;
    const admission = this.budgetLock(async () => {
      callerSignal?.throwIfAborted();
      signal.throwIfAborted();
      if (this.budgetUnavailable) await this.saveBudget();
      if (this.running >= config.concurrency)
        throw new AssistanceError(
          429,
          "embedding_busy",
          "The shared inference execution slots are full. Wait for active work to finish.",
        );
      const hashes = await this.networkHashes(
        caller.kind === "query"
          ? this.networkUnits(caller.network)
          : ["operator"],
      );
      const limit = this.spendingLimit(
        prepared.estimatedUsd,
        config,
        caller.kind === "query" ? hashes : [],
      );
      if (limit) {
        const failure = (await limit.json()) as {
          code: string;
          message: string;
        };
        throw new AssistanceError(limit.status, failure.code, failure.message);
      }
      signal.throwIfAborted();
      callerSignal?.throwIfAborted();
      const id = `embedding:${caller.kind}:${crypto.randomUUID()}`;
      operationId = id;
      this.budgetEntries.set(id, {
        id,
        at: Date.now(),
        reservedUsd: prepared.estimatedUsd,
        settledUsd: 0,
        active: true,
        networkHashes: hashes,
        deadline,
        costKnown: true,
      });
      try {
        await this.saveBudget();
        if (signal.aborted || callerSignal?.aborted) {
          this.budgetEntries.delete(id);
          await this.saveBudget();
          signal.throwIfAborted();
          callerSignal?.throwIfAborted();
        }
      } catch (failure) {
        this.budgetEntries.delete(id);
        throw failure;
      }
      const operation: EmbeddingOperation = {
        id,
        kind: caller.kind,
        deadline,
        state: "preparing",
        transportPending: false,
        error: null,
      };
      this.embeddingWork.set(id, operation);
      this.embeddingSlots.set(id, deadline);
      this.running++;
      return operation;
    });
    const work = admission
      .then((operation) =>
        this.executeEmbedding(operation, prepared, config, signal),
      )
      .finally(() => clearTimeout(timer));
    // Both hosts retain their existing background-work policy.
    this.options.waitUntil?.(work.catch(() => {}));
    try {
      return await abortable(
        work,
        callerSignal ? AbortSignal.any([signal, callerSignal]) : signal,
      );
    } catch (failure) {
      if (!operationId) throw failure;
      if (this.embeddingWork.has(operationId))
        this.embeddingFailedWaits.add(operationId);
      if (failure instanceof AssistanceError) {
        const error = new AssistanceError(
          failure.status,
          failure.code,
          failure.message,
          operationId,
        );
        error.name = failure.name;
        throw error;
      }
      throw new AssistanceError(
        callerSignal?.aborted ? 499 : 502,
        callerSignal?.aborted ? "embedding_canceled" : "embedding_provider",
        callerSignal?.aborted
          ? "The caller stopped waiting. Read its operation status before another attempt."
          : "The embedding provider request failed.",
        operationId,
      );
    }
  }

  /** Bounded diagnostics contain no inputs, vectors, network addresses, or keys. */
  async embeddingOperations() {
    return this.budgetLock(async () => {
      const entries = [...this.budgetEntries.values()].filter((entry) =>
        /^embedding:(query|index|probe):/.test(entry.id),
      );
      const ids = new Set([
        ...entries.map((entry) => entry.id),
        ...this.embeddingWork.keys(),
      ]);
      return [...ids]
        .map((id) => {
          const entry = this.budgetEntries.get(id);
          const work = this.embeddingWork.get(id);
          const settled = this.embeddingSettled.get(id);
          return {
            ...(work ?? {
              id,
              kind: id.split(":")[1] as EmbeddingCaller["kind"],
              deadline: entry!.deadline,
              state: "retained" as const,
              transportPending: false,
              error: null,
            }),
            active: entry?.active ?? false,
            reservedUsd: entry?.reservedUsd ?? settled?.reservedUsd ?? 0,
            chargedUsd: entry?.settledUsd ?? settled?.chargedUsd ?? 0,
            costKnown: entry?.costKnown ?? settled?.costKnown ?? true,
            summary: settled?.summary ?? null,
            aggregated: /^embedding:(index|probe):summary:/.test(id),
          };
        })
        .sort(
          (a, b) =>
            Number(b.active || b.transportPending) -
              Number(a.active || a.transportPending) ||
            b.deadline - a.deadline ||
            a.id.localeCompare(b.id),
        )
        .slice(0, 64);
    });
  }

  private async executeEmbedding(
    operation: EmbeddingOperation,
    prepared: ReturnType<typeof prepareEmbedding>,
    config: ProviderConfig,
    signal: AbortSignal,
  ): Promise<EmbeddingResult & { operation: string }> {
    let sent = false;
    let recorded = false;
    let finished = false;
    let released = false;
    const release = () => {
      if (!finished || operation.transportPending || released) return;
      released = true;
      this.embeddingSlots.delete(operation.id);
      this.running--;
      const terminal = [...this.embeddingWork.values()].filter(
        (item) =>
          !item.transportPending && !["preparing", "sent"].includes(item.state),
      );
      for (const old of terminal.slice(0, Math.max(0, terminal.length - 64))) {
        this.embeddingWork.delete(old.id);
        this.embeddingSettled.delete(old.id);
        this.embeddingFailedWaits.delete(old.id);
      }
    };
    try {
      const result = await requestEmbedding(prepared, config, signal, {
        sent: () => {
          sent = true;
          operation.state = "sent";
          operation.transportPending = true;
        },
        transportEnded: () => {
          operation.transportPending = false;
          release();
        },
        cost: async (usage) => {
          if (recorded) return;
          recorded = true;
          await this.settleCost(
            operation.id,
            usage.costUsd,
            prepared.estimatedUsd,
          );
        },
      });
      operation.state = "completed";
      return { ...result, operation: operation.id };
    } catch (failure) {
      operation.state = signal.aborted ? "timed_out" : "failed";
      operation.error = signal.aborted
        ? "embedding_timeout"
        : failure instanceof AssistanceError
          ? failure.code
          : "embedding_provider";
      if (sent && !recorded) {
        recorded = true;
        await this.settleCost(operation.id, null, prepared.estimatedUsd);
      }
      throw new AssistanceError(
        signal.aborted
          ? 504
          : failure instanceof AssistanceError
            ? failure.status
            : 502,
        operation.error,
        signal.aborted
          ? "The embedding request reached its time limit. Its sent charge remains reserved."
          : failure instanceof AssistanceError
            ? failure.message
            : "The embedding provider request failed.",
      );
    } finally {
      try {
        await this.budgetLock(async () => {
          const entry = this.budgetEntries.get(operation.id);
          if (!entry) return;
          entry.active = false;
          if (!sent || (recorded && entry.costKnown)) entry.reservedUsd = 0;
          this.embeddingSettled.set(operation.id, {
            reservedUsd: entry.reservedUsd,
            chargedUsd: entry.settledUsd,
            costKnown: entry.costKnown,
            summary: null,
          });
          if (!entry.reservedUsd && !entry.settledUsd)
            this.budgetEntries.delete(operation.id);
          await this.saveBudget();
        });
      } catch {
        this.budgetUnavailable = true;
      }
      finished = true;
      release();
    }
  }
  private async budgetLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.budgetTail;
    let release!: () => void;
    this.budgetTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (!this.budgetLoaded) {
        const snapshot = await this.options.budgetStore?.load();
        let migrated = false;
        if (snapshot !== null && snapshot !== undefined) {
          if (
            !isObject(snapshot) ||
            ![1, 2].includes(snapshot.version) ||
            Object.keys(snapshot).sort().join(",") !==
              (snapshot.version === 1
                ? "entries,version"
                : "entries,networkHashKey,version") ||
            !Array.isArray(snapshot.entries) ||
            snapshot.entries.length > 16384 ||
            (snapshot.version === 2 &&
              (typeof snapshot.networkHashKey !== "string" ||
                !/^[a-f0-9]{64}$/.test(snapshot.networkHashKey)))
          )
            throw new Error("Invalid private spending state.");
          const entries = new Map<string, AssistanceBudgetEntry>();
          for (const rawEntry of snapshot.entries) {
            const entry: Record<string, any> = rawEntry;
            if (
              !isObject(entry) ||
              Object.keys(entry).sort().join(",") !==
                (snapshot.version === 1
                  ? "active,at,id,reservedUsd,settledUsd"
                  : "active,at,costKnown,deadline,id,networkHashes,reservedUsd,settledUsd") ||
              typeof entry.id !== "string" ||
              !entry.id ||
              entry.id.length > 128 ||
              entries.has(entry.id) ||
              typeof entry.active !== "boolean" ||
              !Number.isSafeInteger(entry.at) ||
              entry.at < 0 ||
              ![entry.reservedUsd, entry.settledUsd].every(
                (value) =>
                  typeof value === "number" &&
                  Number.isFinite(value) &&
                  value >= 0,
              ) ||
              (snapshot.version === 2 &&
                (!Number.isSafeInteger(entry.deadline) ||
                  entry.deadline < 0 ||
                  typeof entry.costKnown !== "boolean" ||
                  !Array.isArray(entry.networkHashes) ||
                  entry.networkHashes.length > 2 ||
                  new Set(entry.networkHashes).size !==
                    entry.networkHashes.length ||
                  !entry.networkHashes.every(
                    (hash: unknown) =>
                      typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash),
                  )))
            )
              throw new Error("Invalid private spending state.");
            // A restart loses private jobs. Keep their full outstanding charge.
            entries.set(entry.id, {
              id: entry.id,
              reservedUsd: entry.reservedUsd,
              settledUsd: entry.active
                ? Math.max(entry.reservedUsd, entry.settledUsd)
                : entry.settledUsd,
              networkHashes:
                snapshot.version === 2 ? [...entry.networkHashes] : [],
              deadline: snapshot.version === 2 ? entry.deadline : entry.at,
              costKnown:
                !entry.active && snapshot.version === 2
                  ? entry.costKnown
                  : false,
              at: entry.active
                ? Math.max(
                    entry.at,
                    Date.now(),
                    snapshot.version === 2 ? entry.deadline : 0,
                  )
                : entry.at,
              active: false,
            });
          }
          this.budgetEntries = entries;
          if (snapshot.version === 2)
            this.networkHashKey = snapshot.networkHashKey;
          migrated =
            snapshot.version === 1 ||
            snapshot.entries.some((entry) => entry.active);
        }
        if (!this.networkHashKey) {
          this.networkHashKey = [...crypto.getRandomValues(new Uint8Array(32))]
            .map((value) => value.toString(16).padStart(2, "0"))
            .join("");
          migrated = true;
        }
        if (migrated) await this.saveBudget();
        this.budgetLoaded = true;
      }
      return await operation();
    } catch (error) {
      if (error instanceof AssistanceError) throw error;
      throw new AssistanceError(
        503,
        "billing_unavailable",
        "The server cannot read or save its private spending limits. Try again later.",
      );
    } finally {
      release();
    }
  }
  private async saveBudget() {
    try {
      await this.options.budgetStore?.save({
        version: 2,
        networkHashKey: this.networkHashKey,
        entries: [...this.budgetEntries.values()].map((entry) => ({
          ...entry,
          networkHashes: [...entry.networkHashes],
        })),
      });
      this.budgetUnavailable = false;
    } catch (error) {
      this.budgetUnavailable = true;
      throw error;
    }
  }
  private networkUnits(network: string): string[] {
    const normalized =
      normalizeClientNetwork(network.replace(/\/64$/, "")) || network;
    return normalized.endsWith("/64")
      ? [normalized, `${normalized.split(":").slice(0, 3).join(":")}::/48`]
      : [normalized];
  }
  private async networkHashes(units: string[]): Promise<string[]> {
    const bytes = Uint8Array.from(this.networkHashKey.match(/../g)!, (pair) =>
      parseInt(pair, 16),
    );
    const key = await crypto.subtle.importKey(
      "raw",
      bytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return Promise.all(
      units.map(async (unit) => {
        const signature = await crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(`jbovlacku-assistance-network-v1\n${unit}`),
        );
        return [...new Uint8Array(signature)]
          .map((value) => value.toString(16).padStart(2, "0"))
          .join("");
      }),
    );
  }
  private spendingLimit(
    estimate: number,
    config: ProviderConfig,
    networkHashes: string[],
  ): Response | null {
    const now = Date.now();
    for (const [id, entry] of this.budgetEntries)
      if (!entry.active && entry.at + 86400000 <= now)
        this.budgetEntries.delete(id);
    this.compactOperatorCosts();
    const scopes = [
      { hash: null, hour: config.hourlyBudgetUsd, day: config.dailyBudgetUsd },
      ...networkHashes.map((hash) => ({
        hash,
        hour: config.networkHourlyBudgetUsd,
        day: config.networkDailyBudgetUsd,
      })),
    ];
    if (
      estimate >
      Math.min(
        config.hourlyBudgetUsd,
        config.dailyBudgetUsd,
        networkHashes.length ? config.networkHourlyBudgetUsd : Infinity,
        networkHashes.length ? config.networkDailyBudgetUsd : Infinity,
        config.maxCostUsd ?? Infinity,
      )
    )
      return json(
        errorShape(
          "billing_request_too_large",
          "This request exceeds an inference spending limit even with no earlier charges. Reduce the request or ask the operator to raise the limit.",
        ),
        429,
      );
    const releases: number[] = [];
    let pending = false;
    for (const scope of scopes) {
      for (const [window, limit] of [
        [3600000, scope.hour],
        [86400000, scope.day],
      ]) {
        const entries = [...this.budgetEntries.values()].filter(
          (entry) =>
            (entry.active || entry.at + window > now) &&
            (scope.hash === null ||
              !entry.networkHashes.length ||
              entry.networkHashes.includes(scope.hash)),
        );
        let total = entries.reduce(
          (sum, entry) => sum + Math.max(entry.reservedUsd, entry.settledUsd),
          0,
        );
        if (total + estimate <= limit) continue;
        if (
          entries.some((entry) => {
            const job = this.jobs.get(entry.id);
            return entry.active && (!job || this.activeJob(job));
          })
        )
          pending = true;
        const events: { at: number; release: number }[] = [];
        for (const entry of entries) {
          const charged = Math.max(entry.reservedUsd, entry.settledUsd);
          const afterDeadline = entry.costKnown ? entry.settledUsd : charged;
          if (entry.active) {
            // Known charges can move to the last answer at the deadline.
            events.push({
              at: Math.max(now, entry.deadline),
              release: charged - afterDeadline,
            });
            events.push({
              at: Math.max(entry.at, entry.deadline) + window,
              release: afterDeadline,
            });
          } else events.push({ at: entry.at + window, release: charged });
        }
        events.sort((a, b) => a.at - b.at);
        for (const event of events) {
          total -= event.release;
          if (total + estimate <= limit) {
            releases.push(event.at);
            break;
          }
        }
      }
    }
    if (this.budgetEntries.size >= 16384)
      releases.push(
        Math.min(
          ...[...this.budgetEntries.values()].map(
            (entry) =>
              (entry.active ? Math.max(entry.at, entry.deadline) : entry.at) +
              86400000,
          ),
        ),
      );
    if (pending)
      return json(
        errorShape(
          "billing_pending",
          "Active inference work holds this allowance while its final costs are unknown. Wait for that work to finish, then request the suggestion again.",
        ),
        429,
      );
    return releases.length
      ? this.retry(
          "The inference spending allowance cannot cover this job yet.",
          [Math.max(...releases)],
          "billing_limit",
        )
      : null;
  }
  /** Successful operator batches share a conservative charge row for each hour. */
  private compactOperatorCosts() {
    for (const operation of this.embeddingWork.values()) {
      if (
        operation.kind === "query" ||
        operation.state !== "completed" ||
        this.embeddingFailedWaits.has(operation.id) ||
        this.embeddingSlots.has(operation.id)
      )
        continue;
      const entry = this.budgetEntries.get(operation.id);
      if (
        !entry ||
        entry.active ||
        !entry.costKnown ||
        entry.reservedUsd !== 0 ||
        entry.networkHashes.length !== 1
      )
        continue;
      const id = `embedding:${operation.kind}:summary:${Math.floor(entry.at / 3600000)}`;
      const previous = this.budgetEntries.get(id);
      if (
        previous &&
        (previous.active ||
          !previous.costKnown ||
          previous.reservedUsd !== 0 ||
          previous.networkHashes.length !== 1 ||
          previous.networkHashes[0] !== entry.networkHashes[0])
      )
        continue;
      const total = (previous?.settledUsd ?? 0) + entry.settledUsd;
      if (!Number.isFinite(total)) continue;
      this.budgetEntries.set(id, {
        ...entry,
        id,
        at: Math.max(entry.at, previous?.at ?? 0),
        deadline: Math.max(entry.deadline, previous?.deadline ?? 0),
        settledUsd: total,
      });
      this.budgetEntries.delete(operation.id);
      const diagnostic = this.embeddingSettled.get(operation.id);
      if (diagnostic) diagnostic.summary = id;
    }
  }
  private async settleCost(
    id: string,
    reported: number | null,
    estimate: number,
  ) {
    try {
      await this.budgetLock(async () => {
        const entry = this.budgetEntries.get(id);
        if (!entry) return;
        entry.settledUsd += reported ?? estimate;
        if (reported === null) entry.costKnown = false;
        // Keep all charges for a full window after the latest paid answer.
        entry.at = Math.max(entry.at, Date.now());
        await this.saveBudget();
      });
    } catch {
      // Keep admitted work running. Later admissions fail closed until saving works.
      this.budgetUnavailable = true;
    }
  }
  private releaseRetained(job: Job) {
    job.reserved = false;
    job.discarded = true;
    job.result = null;
    if (job.error) delete job.error.log;
  }
  private terminalReadMs() {
    return Math.min(this.options.terminalReadMs ?? 120000, 120000);
  }
  private retainedRelease(job: Job) {
    return ["queued", "running", "cancel_requested"].includes(job.state)
      ? Math.min(job.expires, job.deadline + this.terminalReadMs())
      : Math.min(job.readUntil, job.expires);
  }
  capabilities() {
    const provider = this.options.provider;
    if (!provider || !provider.operations.length) return [];
    const operations = provider.operations.filter((operation) =>
      fitsEmptyAllowance(
        provider,
        minimumAssistanceCost(provider, operation as Operation),
      ),
    );
    if (!operations.length) return [];
    const name = `${provider.providerName ?? "OpenRouter"} (${provider.route})`;
    const disclosure = `Server ${this.server} sends draft fields to ${name}. These include your original meaning, definition language and current definition. They also include word type, classification, spelling, places and glosses. Formation, components and selected exact source definitions are also sent. These fields cover all declared tasks: ${operations.join(", ")}. Private jobs expire after ten minutes or service restart. Results and logs remain available for two minutes after completion unless you dismiss them sooner. Cancel cannot reverse a provider charge.`;
    return [
      "default",
      ...(operations.includes("lujvo") ? ["components", "lujvo"] : []),
    ].map((id) => ({
      id,
      label:
        id === "components"
          ? "Suggest components"
          : id === "lujvo"
            ? "Suggest a lujvo"
            : "AI assistance",
      provider: name,
      model: provider.model,
      operations: id === "default" ? operations : ["lujvo"],
      disclosure,
    }));
  }
  private ttl() {
    return Math.min(this.options.ttlMs ?? 600000, 600000);
  }
  private sessionBusy(owner: string) {
    return (
      this.admitting.has(owner) ||
      [...this.jobs.values()].some(
        (job) => job.owner === owner && (this.activeJob(job) || job.reserved),
      )
    );
  }
  private sessionRelease(owner: string, session: Session) {
    if (this.admitting.has(owner)) return session.expires;
    const busy = [...this.jobs.values()].filter(
      (job) => job.owner === owner && (this.activeJob(job) || job.reserved),
    );
    return busy.length
      ? Math.max(...busy.map((job) => this.retainedRelease(job)))
      : Date.now();
  }
  private activeJob(job: Job) {
    return ["queued", "running", "cancel_requested"].includes(job.state);
  }
  private evictSession(owner: string) {
    this.sessions.delete(owner);
    for (const [id, marker] of this.expiredJobs)
      if (marker.owner === owner) this.expiredJobs.delete(id);
    for (const [id, job] of this.jobs) {
      if (job.owner === owner) {
        job.controller.abort();
        this.releaseRetained(job);
        this.jobs.delete(id);
      }
    }
  }
  private expireJob(id: string, job: Job) {
    if (this.jobs.get(id) !== job) return;
    job.controller.abort();
    this.releaseRetained(job);
    job.error = null;
    this.jobs.delete(id);
    if (!this.sessions.has(job.owner) || job.expires + 3600000 <= Date.now())
      return;
    this.expiredJobs.set(id, { owner: job.owner, expires: job.expires });
    const own = [...this.expiredJobs.entries()]
      .filter(([, marker]) => marker.owner === job.owner)
      .sort(
        ([leftId, left], [rightId, right]) =>
          left.expires - right.expires ||
          (leftId < rightId ? -1 : leftId > rightId ? 1 : 0),
      );
    for (const [oldest] of own.slice(0, Math.max(0, own.length - 128)))
      this.expiredJobs.delete(oldest);
  }
  private sweep() {
    const now = Date.now();
    for (const [id, session] of this.sessions)
      if (session.expires <= now) {
        this.evictSession(id);
      }
    for (const [id, job] of this.jobs) {
      if (!this.activeJob(job) && !job.discarded && job.readUntil <= now)
        this.releaseRetained(job);
      if (job.expires <= now) {
        this.expireJob(id, job);
      }
    }
    for (const [id, marker] of this.expiredJobs)
      if (marker.expires + 3600000 <= now) this.expiredJobs.delete(id);
    for (const [key, quota] of this.network)
      if (quota.expires <= now) this.network.delete(key);
  }
  private session(request: Request, csrf = false): [string, Session] {
    const id = /(?:^|;\s*)__Host-jvc-assist=([a-f0-9-]+)/.exec(
      request.headers.get("cookie") ?? "",
    )?.[1];
    const value = id ? this.sessions.get(id) : null;
    if (!id || !value || value.expires <= Date.now())
      throw new AssistanceError(
        401,
        "session",
        "Start a new private session before requesting assistance.",
      );
    if (csrf && request.headers.get("x-csrf-token") !== value.csrf)
      throw new AssistanceError(
        403,
        "csrf",
        "The private session token is missing or invalid.",
      );
    return [id, value];
  }
  private sessionTtl() {
    return Math.min(this.options.sessionTtlMs ?? 3600000, 3600000);
  }
  private cookie(id: string, session: Session) {
    const seconds = Math.max(
      1,
      Math.ceil((session.expires - Date.now()) / 1000),
    );
    return `__Host-jvc-assist=${id}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${seconds}`;
  }
  private retry(message: string, releases: number[], code = "quota") {
    const seconds = Math.max(
      1,
      Math.ceil((Math.min(...releases) - Date.now()) / 1000),
    );
    return json(
      errorShape(
        code,
        code === "billing_limit"
          ? `${message} Retry in ${seconds} seconds.`
          : message,
      ),
      429,
      {
        "retry-after": String(seconds),
      },
    );
  }
  private admissionLimit(
    owner: string,
    session: Session,
    network: string,
    config: ProviderConfig,
  ) {
    const now = Date.now();
    if (session.quotaExpires <= now) {
      session.count = 0;
      session.quotaExpires = now + 3600000;
    }
    const quota = this.network.get(network);
    const limits: number[] = [];
    if (session.count >= (this.options.sessionJobs ?? 12))
      limits.push(session.quotaExpires);
    if (
      quota &&
      quota.expires > now &&
      quota.count >= (this.options.networkJobs ?? 48)
    )
      limits.push(quota.expires);
    const jobs = [...this.jobs.values()];
    const ownJobs = jobs.filter((job) => job.owner === owner);
    if (ownJobs.length >= 128)
      return this.retry(
        "This private session retains the maximum number of jobs. Wait for the earliest job to expire.",
        [Math.min(...ownJobs.map((job) => job.expires))],
        "session_job_limit",
      );
    const retained = jobs.filter((job) => job.reserved);
    for (const unit of this.networkUnits(network)) {
      const own = retained.filter((job) => job.networkUnits.includes(unit));
      if (own.length >= (this.options.networkRetainedJobs ?? 1))
        limits.push(Math.min(...own.map((job) => this.retainedRelease(job))));
    }
    if (retained.length >= Math.min(this.options.retainedJobs ?? 4, 4))
      limits.push(
        Math.min(...retained.map((job) => this.retainedRelease(job))),
      );
    if (this.running >= config.concurrency) {
      const running = jobs.filter((job) =>
        ["queued", "running", "cancel_requested"].includes(job.state),
      );
      const deadlines = [
        ...running.map((job) => job.deadline),
        ...this.embeddingSlots.values(),
      ].filter(Number.isFinite);
      limits.push(
        Math.max(
          now + 1000,
          deadlines.length ? Math.min(...deadlines) : now + 1000,
        ),
      );
    }
    // Every exhausted limit must clear before a retry can be admitted.
    return limits.length
      ? this.retry(
          "The private inference quota is exhausted. Save or dismiss earlier results, then try again.",
          [Math.max(...limits)],
        )
      : null;
  }
  async route(
    request: Request,
    path: string,
    readBody: (signal?: AbortSignal) => Promise<Uint8Array>,
    network = "local",
    publicOrigin?: string,
  ): Promise<Response | null> {
    if (
      !(
        path === "/session" ||
        path === "/assist" ||
        path.startsWith("/jobs/") ||
        path.startsWith("/assist/prompts/")
      )
    )
      return null;
    this.sweep();
    if (request.method === "GET" && path.startsWith("/assist/prompts/")) {
      const file = path.slice("/assist/prompts/".length);
      if (!Object.hasOwn(promptFiles, file))
        throw new AssistanceError(
          404,
          "missing",
          "The prompt file is unavailable.",
        );
      return new Response(promptFiles[file], {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }
    const config = this.options.provider;
    if (!config || !config.operations.length)
      throw new AssistanceError(
        503,
        "feature_disabled",
        "AI assistance is not available on this server.",
      );
    if (!network)
      throw new AssistanceError(
        503,
        "feature_disabled",
        "AI assistance needs a trusted client network address on this server.",
      );
    // Private jobs are same-origin even when public dictionary CORS is enabled.
    const origin = request.headers.get("origin");
    const appOrigin = publicOrigin ?? new URL(request.url).origin;
    if (
      (origin && origin !== appOrigin) ||
      (["POST", "DELETE"].includes(request.method) && origin !== appOrigin) ||
      request.headers.get("sec-fetch-site") === "cross-site"
    )
      throw new AssistanceError(
        403,
        "origin",
        "Private assistance requires the app origin.",
      );
    if (request.method === "GET" && path === "/session") {
      let id = /(?:^|;\s*)__Host-jvc-assist=([a-f0-9-]+)/.exec(
        request.headers.get("cookie") ?? "",
      )?.[1];
      let session = id ? this.sessions.get(id) : null;
      const now = Date.now();
      if (!session) {
        const own = [...this.sessions.values()].filter(
          (value) => value.network === network,
        );
        if (own.length >= (this.options.networkSessions ?? 8)) {
          const idle = [...this.sessions.entries()]
            .filter(
              ([sessionId, value]) =>
                value.network === network && !this.sessionBusy(sessionId),
            )
            .sort((a, b) => a[1].touched - b[1].touched)[0];
          if (idle) this.evictSession(idle[0]);
          else
            return this.retry(
              "Private sessions for this network are at capacity.",
              [...this.sessions.entries()]
                .filter(([, value]) => value.network === network)
                .map(([owner, value]) => this.sessionRelease(owner, value)),
            );
        }
        if (this.sessions.size >= 128) {
          const idle = [...this.sessions.entries()]
            .filter(([owner]) => !this.sessionBusy(owner))
            .sort((a, b) => a[1].touched - b[1].touched)[0];
          if (idle) this.evictSession(idle[0]);
          else
            return this.retry(
              "Private sessions are at capacity.",
              [...this.sessions.entries()].map(([owner, value]) =>
                this.sessionRelease(owner, value),
              ),
            );
        }
        id = crypto.randomUUID();
        session = {
          network,
          csrf: crypto.randomUUID(),
          expires: now + this.sessionTtl(),
          quotaExpires: now + 3600000,
          touched: now,
          count: 0,
        };
        this.sessions.set(id, session);
      }
      session.expires = Math.max(session.expires, now + this.sessionTtl());
      session.touched = now;
      return json({ csrf: session.csrf }, 200, {
        "set-cookie": this.cookie(id!, session),
      });
    }
    const [owner, session] = this.session(
      request,
      ["POST", "DELETE"].includes(request.method),
    );
    if (request.method === "POST" && path === "/assist") {
      if (new URL(request.url).search)
        throw new AssistanceError(
          400,
          "query",
          "Private draft fields belong in the request body.",
        );
      const bodyController = new AbortController();
      let bodyTimer: ReturnType<typeof setTimeout> | undefined;
      let fields: unknown;
      try {
        const timeout = new Promise<never>((_, reject) => {
          bodyTimer = setTimeout(
            () => {
              const error = new AssistanceError(
                408,
                "request_timeout",
                "The assistance request body exceeded its time limit.",
              );
              reject(error);
              bodyController.abort(error);
            },
            Math.max(
              1,
              Math.min(this.options.requestBodyTimeoutMs ?? 10000, 10000),
            ),
          );
        });
        const body = await Promise.race([
          readBody(bodyController.signal),
          timeout,
        ]);
        if (body.byteLength > 262144)
          throw new AssistanceError(
            413,
            "size",
            "Request exceeds the byte limit.",
          );
        fields = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(body),
        );
      } catch (error) {
        if (
          error instanceof AssistanceError ||
          (isObject(error) && typeof error.status === "number")
        )
          throw error;
        throw new AssistanceError(
          400,
          "assist_request",
          "The assistance body must contain JSON.",
        );
      } finally {
        clearTimeout(bodyTimer);
      }
      const input = parseAssistRequest(fields);
      this.session(request, true);
      this.admitting.set(owner, (this.admitting.get(owner) ?? 0) + 1);
      try {
        if (!config.operations.includes(input.operation))
          throw new AssistanceError(
            503,
            "feature_disabled",
            "This AI action is disabled on this server.",
          );
        const context = await this.context(input.context);
        if (
          new TextEncoder().encode(JSON.stringify(context)).byteLength > 131072
        )
          throw new AssistanceError(
            413,
            "size",
            "Selected definition context exceeds the byte limit.",
          );
        checkComponentContext(input, context);
        const estimate = estimateAssistanceCost(input, context, config);
        return await this.budgetLock(async () => {
          this.sweep();
          this.session(request, true);
          if (this.budgetUnavailable) await this.saveBudget();
          // One lock covers durable spending, quotas, retained slots and execution slots.
          const limited = this.admissionLimit(owner, session, network, config);
          if (limited) return limited;
          const units = this.networkUnits(network);
          const hashes = await this.networkHashes(units);
          const spending = this.spendingLimit(estimate, config, hashes);
          if (spending) return spending;
          const now = Date.now();
          const id = crypto.randomUUID();
          const deadline =
            now +
            Math.min(
              config.timeoutMs,
              this.ttl() - Math.min(60000, this.ttl() / 4),
            );
          this.budgetEntries.set(id, {
            id,
            at: now,
            reservedUsd: estimate,
            settledUsd: 0,
            active: true,
            networkHashes: hashes,
            deadline,
            costKnown: true,
          });
          try {
            await this.saveBudget();
            try {
              this.session(request, true);
            } catch (error) {
              this.budgetEntries.delete(id);
              await this.saveBudget();
              throw error;
            }
          } catch (error) {
            this.budgetEntries.delete(id);
            throw error;
          }
          const previousQuota = this.network.get(network);
          const quota =
            previousQuota && previousQuota.expires > now
              ? previousQuota
              : { expires: now + 3600000, count: 0 };
          quota.count++;
          session.count++;
          this.network.set(network, quota);
          const job: Job = {
            reserved: true,
            discarded: false,
            networkUnits: units,
            readUntil: Infinity,
            budgetId: id,
            costReports: 0,
            owner,
            network,
            deadline,
            expires: now + this.ttl(),
            state: "queued",
            result: null,
            error: null,
            progress: { task: null, attempt: 0, max_attempts: 3 },
            controller: new AbortController(),
          };
          session.expires = Math.max(
            session.expires,
            now + this.sessionTtl(),
            job.expires,
          );
          session.touched = now;
          this.jobs.set(id, job);
          const expiry = setTimeout(
            () => {
              this.expireJob(id, job);
            },
            Math.max(0, job.expires - Date.now()),
          );
          expiry.unref?.();
          this.running++;
          const work = this.execute(
            job,
            input,
            {
              ...config,
              onCost: async (reported, estimated) => {
                job.costReports++;
                await this.settleCost(id, reported, estimated);
              },
            },
            context,
          );
          if (this.options.waitUntil) this.options.waitUntil(work);
          else void work;
          return json(
            {
              job: id,
              expires_at: new Date(job.expires)
                .toISOString()
                .replace(/\.\d{3}Z$/, "Z"),
              poll_after_ms: 100,
            },
            202,
            { "set-cookie": this.cookie(owner, session) },
          );
        });
      } finally {
        const pending = (this.admitting.get(owner) ?? 1) - 1;
        if (pending) this.admitting.set(owner, pending);
        else this.admitting.delete(owner);
      }
    }
    if (
      path.startsWith("/jobs/") &&
      ["GET", "DELETE"].includes(request.method)
    ) {
      const id = path.slice("/jobs/".length);
      const job = this.jobs.get(id);
      if (!job) {
        if (this.expiredJobs.get(id)?.owner === owner)
          throw new AssistanceError(
            410,
            "job_expired",
            "This private job expired.",
          );
        throw new AssistanceError(
          404,
          "missing",
          "The private job is unavailable.",
        );
      }
      if (job.owner !== owner)
        throw new AssistanceError(
          404,
          "missing",
          "The private job is unavailable.",
        );
      if (request.method === "GET" && job.discarded)
        throw new AssistanceError(
          410,
          "result_discarded",
          "This private result and its log were discarded. Request a new suggestion to continue.",
        );
      if (request.method === "DELETE") {
        job.reserved = false;
        if (["queued", "running", "cancel_requested"].includes(job.state)) {
          job.state = job.state === "queued" ? "canceled" : "cancel_requested";
          job.controller.abort();
        } else {
          this.releaseRetained(job);
        }
      }
      return streamedJson({
        state: job.state,
        result: job.result,
        error: job.error,
        expires_at: new Date(job.expires)
          .toISOString()
          .replace(/\.\d{3}Z$/, "Z"),
        progress: job.progress,
      });
    }
    throw new AssistanceError(
      405,
      "method",
      "This private job method is not supported.",
    );
  }
  private async execute(
    job: Job,
    request: AssistRequest,
    config: ProviderConfig,
    context: ContextDefinition[],
  ) {
    const started = Date.now();
    let log: InferenceLog | undefined;
    const timeout = AbortSignal.timeout(
      Math.max(1, Math.floor(job.deadline - Date.now())),
    );
    const signal = AbortSignal.any([job.controller.signal, timeout]);
    try {
      log = newLog(request.operation, config, await this.version);
      signal.throwIfAborted();
      job.state = "running";
      const dictionary =
        request.operation === "type"
          ? await this.typeDictionary?.(request, context, signal)
          : undefined;
      signal.throwIfAborted();
      job.result = await runAssistance(
        request,
        config,
        context,
        signal,
        log,
        (task, attempt) => {
          job.progress = { task, attempt, max_attempts: 3 };
        },
        dictionary,
      );
      signal.throwIfAborted();
      job.state = "completed";
    } catch (error) {
      job.result = null;
      if (job.controller.signal.aborted) {
        job.state = "canceled";
        job.error = null;
      } else {
        job.state = "failed";
        job.error = timeout.aborted
          ? errorShape(
              "provider_timeout",
              "The assistant reached the time limit. Try again or continue by hand.",
            )
          : error instanceof AssistanceError
            ? errorShape(error.code, error.message)
            : errorShape(
                "provider_error",
                "The assistant could not complete the request.",
              );
        if (log) job.error.log = log;
      }
    } finally {
      if (log) log.duration_ms = Date.now() - started;
      if (!log?.answers) job.reserved = false;
      const terminalReadMs = this.terminalReadMs();
      job.readUntil = Math.min(
        job.expires,
        Date.now() + terminalReadMs,
        job.deadline + terminalReadMs,
      );
      const discard = setTimeout(
        () => this.releaseRetained(job),
        Math.max(0, job.readUntil - Date.now()),
      );
      discard.unref?.();
      this.running--;
      try {
        await this.budgetLock(async () => {
          const entry = this.budgetEntries.get(job.budgetId);
          if (!entry) return;
          entry.active = false;
          if (entry.costKnown && job.costReports === (log?.answers ?? 0))
            entry.reservedUsd = 0;
          if (entry.settledUsd === 0 && entry.reservedUsd === 0)
            this.budgetEntries.delete(job.budgetId);
          await this.saveBudget();
        });
      } catch {
        this.budgetUnavailable = true;
      }
    }
  }
}
