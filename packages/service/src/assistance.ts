import {
  analyzeWord,
  buildLujvo,
  createEvent,
  inspectBody,
  utf8,
  wordId,
  canonicalize,
  rafsiPairId,
} from "../../core/src/index.ts";
import {
  AssistanceError,
  InferenceRunner,
  isObject,
  foldHints,
  newLog,
  promptVersion,
  sourceLanguages,
  type ProviderConfig,
  type InferenceLog,
  type Task,
} from "./inference.ts";
import { promptFiles } from "./prompt-bundle.ts";
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
export interface AssistResult {
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
  "fuivla",
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
      utf8(canonicalize(utf8(JSON.stringify(body)))),
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
  return request;
}
function placeKeys(frame: Data | null): string[] {
  return (frame?.places ?? []).map((place: Data) => `x${place.index}`);
}
function caseText(
  request: AssistRequest,
  context: ContextDefinition[],
): string {
  return JSON.stringify(
    {
      meaning: request.meaning,
      language: request.language,
      current: request.current,
      definitions: context,
    },
    null,
    2,
  );
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
/** The caller owns the log. This function does not persist draft data. */
export async function runAssistance(
  request: AssistRequest,
  config: ProviderConfig,
  context: ContextDefinition[],
  signal: AbortSignal,
  log: InferenceLog,
  progress: (task: Task, attempt: number) => void,
): Promise<AssistResult> {
  const runner = new InferenceRunner(config, log, signal, progress);
  const input = caseText(request, context);
  const proposals: AssistResult["proposals"] = [];
  const explanations: string[] = [];
  if (request.operation === "type") {
    const answer = await runner.run({ task: "type", input });
    proposals.push({ path: "/word_type", value: answer.word_type });
    explanations.push(answer.reason);
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
          ...row,
          word: answer.word ?? "",
          word_ipa: answer.word_ipa,
          stem: answer.stem,
          ipa: answer.ipa,
          input:
            answer.sounds === null
              ? null
              : { format: "lojbanized", text: answer.sounds },
          notes: [
            ...(row.notes ?? []),
            [`Sense: ${answer.sense ?? ""}`],
            [`Note: ${answer.note}`],
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
    const glosses = await runner.run({
      task: "glosses",
      input: placeInput,
      keys: ["word", ...keys],
    });
    const hints = keys.length
      ? await runner.run({ task: "hints", input: placeInput, keys })
      : {};
    const suppliedComponents = request.current.compound?.components ?? [];
    const componentPlaces = suppliedComponents.flatMap((component: Data) => {
      const source = context.find(
        (entry) =>
          entry.event === component.definition &&
          entry.body.word?.spelling === component.word?.spelling,
      );
      return (source?.body.frame?.places ?? []).map(
        (place: Data) => `${component.word.spelling}[${place.index}]`,
      );
    });
    const mappings =
      keys.length && componentPlaces.length
        ? await runner.run({
            task: "mappings",
            input: placeInput,
            keys,
            components: componentPlaces,
          })
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
            const match = /^(.*)\[(\d+)\]$/.exec(entry.component)!;
            const component = suppliedComponents.find(
              (component: Data) => component.word.spelling === match[1],
            );
            return {
              word: component.word,
              definition: component.definition,
              place: Number(match[2]),
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
  csrf: string;
  expires: number;
  count: number;
}
interface Job {
  reserved: boolean;
  owner: string;
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
export class AssistanceService {
  private sessions = new Map<string, Session>();
  private jobs = new Map<string, Job>();
  private network = new Map<string, { expires: number; count: number }>();
  private running = 0;
  private version = promptVersion();
  constructor(
    private options: AssistanceOptions,
    private server: string,
    private context: (events: string[]) => Promise<ContextDefinition[]>,
  ) {}
  capabilities() {
    const provider = this.options.provider;
    if (!provider || !provider.operations.length) return [];
    const name = `${provider.providerName ?? "OpenRouter"} (${provider.route})`;
    const disclosure = `Server ${this.server} sends draft fields to ${name}. These include your original meaning, definition language and current definition. They also include word type, classification, spelling, places and glosses. Formation, components and selected exact source definitions are also sent. These fields cover all declared tasks: ${provider.operations.join(", ")}. Private jobs expire after ten minutes or service restart. Cancel cannot reverse a provider charge.`;
    return [
      "default",
      ...(provider.operations.includes("lujvo") ? ["components", "lujvo"] : []),
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
      operations: id === "default" ? provider.operations : ["lujvo"],
      disclosure,
    }));
  }
  private ttl() {
    return Math.min(this.options.ttlMs ?? 600000, 600000);
  }
  private sweep() {
    const now = Date.now();
    for (const [id, session] of this.sessions)
      if (session.expires <= now) {
        this.sessions.delete(id);
        for (const [jobId, job] of this.jobs)
          if (job.owner === id) {
            job.controller.abort();
            this.jobs.delete(jobId);
          }
      }
    for (const [id, job] of this.jobs)
      if (job.expires <= now) {
        job.controller.abort();
        this.jobs.delete(id);
      }
    for (const [key, quota] of this.network)
      if (quota.expires <= now) this.network.delete(key);
  }
  private session(request: Request, csrf = false): [string, Session] {
    const id = /(?:^|;\s*)__Host-jvc-assist=([a-f0-9-]+)/.exec(
      request.headers.get("cookie") ?? "",
    )?.[1];
    const value = id ? this.sessions.get(id) : null;
    if (!id || !value)
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
  private privateCapacity() {
    return (
      [...this.jobs.values()].filter((job) => job.reserved).length <
      Math.min(this.options.retainedJobs ?? 4, 4)
    );
  }
  async route(
    request: Request,
    path: string,
    readBody: () => Promise<Uint8Array>,
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
      if (!session) {
        if (this.sessions.size >= 128)
          throw new AssistanceError(
            429,
            "quota",
            "Private sessions are at capacity.",
          );
        id = crypto.randomUUID();
        session = {
          csrf: crypto.randomUUID(),
          expires:
            Date.now() +
            Math.min(this.options.sessionTtlMs ?? 3600000, 3600000),
          count: 0,
        };
        this.sessions.set(id, session);
      }
      return json({ csrf: session.csrf }, 200, {
        "set-cookie": `__Host-jvc-assist=${id}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=3600`,
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
      if (this.running >= config.concurrency || !this.privateCapacity())
        return json(
          errorShape(
            "quota",
            "All private inference slots are in use. Save or dismiss earlier results, then try again.",
          ),
          429,
          { "retry-after": "1" },
        );
      const quota = this.network.get(network) ?? {
        expires: Date.now() + 3600000,
        count: 0,
      };
      this.network.set(network, quota);
      if (
        session.count >= (this.options.sessionJobs ?? 12) ||
        quota.count >= (this.options.networkJobs ?? 48) ||
        this.jobs.size >= 128
      )
        return json(
          errorShape("quota", "The private inference quota is exhausted."),
          429,
          {
            "retry-after": String(
              Math.max(1, Math.ceil((quota.expires - Date.now()) / 1000)),
            ),
          },
        );
      let fields: unknown;
      try {
        fields = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(await readBody()),
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
      }
      const input = parseAssistRequest(fields);
      if (!config.operations.includes(input.operation))
        throw new AssistanceError(
          503,
          "feature_disabled",
          "This AI action is disabled on this server.",
        );
      const context = await this.context(input.context);
      if (new TextEncoder().encode(JSON.stringify(context)).byteLength > 131072)
        throw new AssistanceError(
          413,
          "size",
          "Selected definition context exceeds the byte limit.",
        );
      // Recheck after asynchronous context reads so concurrent submissions cannot
      // both reserve the final slot or quota allocation.
      if (this.running >= config.concurrency || !this.privateCapacity())
        return json(
          errorShape(
            "quota",
            "All private inference slots are in use. Save or dismiss earlier results, then try again.",
          ),
          429,
          { "retry-after": "1" },
        );
      if (
        session.count >= (this.options.sessionJobs ?? 12) ||
        quota.count >= (this.options.networkJobs ?? 48)
      )
        return json(
          errorShape("quota", "The private inference quota is exhausted."),
          429,
          { "retry-after": "3600" },
        );
      quota.count++;
      session.count++;
      this.network.set(network, quota);
      const id = crypto.randomUUID();
      const job: Job = {
        reserved: true,
        owner,
        expires: Math.floor((Date.now() + this.ttl()) / 1000) * 1000,
        state: "queued",
        result: null,
        error: null,
        progress: { task: null, attempt: 0, max_attempts: 3 },
        controller: new AbortController(),
      };
      this.jobs.set(id, job);
      const expiry = setTimeout(
        () => {
          job.controller.abort();
          job.result = null;
          job.error = null;
          this.jobs.delete(id);
        },
        Math.max(0, job.expires - Date.now()),
      );
      expiry.unref?.();
      this.running++;
      const work = this.execute(job, input, config, context);
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
      );
    }
    if (
      path.startsWith("/jobs/") &&
      ["GET", "DELETE"].includes(request.method)
    ) {
      const id = path.slice("/jobs/".length);
      const job = this.jobs.get(id);
      if (!job)
        throw new AssistanceError(
          410,
          "job_expired",
          "This private job expired or the service restarted.",
        );
      if (job.owner !== owner)
        throw new AssistanceError(
          404,
          "missing",
          "The private job is unavailable.",
        );
      if (request.method === "DELETE") {
        job.reserved = false;
        if (["queued", "running", "cancel_requested"].includes(job.state)) {
          job.state = job.state === "queued" ? "canceled" : "cancel_requested";
          job.controller.abort();
        } else {
          job.result = null;
          if (job.error) delete job.error.log;
        }
      }
      return json({
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
    const timeout = AbortSignal.timeout(Math.min(config.timeoutMs, this.ttl()));
    const signal = AbortSignal.any([job.controller.signal, timeout]);
    try {
      log = newLog(request.operation, config, await this.version);
      signal.throwIfAborted();
      job.state = "running";
      job.result = await runAssistance(
        request,
        config,
        context,
        signal,
        log,
        (task, attempt) => {
          job.progress = { task, attempt, max_attempts: 3 };
        },
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
      this.running--;
    }
  }
}
