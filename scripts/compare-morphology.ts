/** Compare the retained TypeScript profiles with the pinned native Rust oracle.
 * External dictionary and corpus files are read only. Evidence stays in --out.
 * Run under /usr/bin/time -v -o OUT/process-time.txt to include the full process tree.
 */
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  analyzeWord,
  buildLujvo,
  score,
  segmentCll,
} from "../packages/morphology/src/lujvo.ts";
import { generateGismu } from "../packages/morphology/src/gismu.ts";
import { builderPresets } from "../packages/morphology/src/presets.ts";
import { isShortRafsiForm } from "../packages/morphology/src/rafsi.ts";
import { BuilderError } from "../packages/morphology/src/errors.ts";
import type {
  GismuRequest,
  GismuResult,
  GismuCandidate,
  GismuSourceRow,
  LujvoRequest,
  MorphologyProfile,
  RecoveredPart,
  WordAnalysis,
} from "../packages/morphology/src/types.ts";

type LegacyProfile = Exclude<MorphologyProfile, "extended-v4">;
export type Request =
  | { op: "analyze"; profile: LegacyProfile; word: string }
  | { op: "build"; request: LujvoRequest }
  | { op: "generate"; request: GismuRequest }
  | { op: "score"; tokens: string[] }
  | { op: "segment"; word: string }
  | { op: "presets" };
type Result = { ok: unknown } | { error: unknown };
const profiles: LegacyProfile[] = ["cll", "extended-v2", "extended"];
const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
// Object key order is irrelevant to JSON objects. Array order remains exact.
export function canonicalJson(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, canonical(v)]),
      );
    return input;
  };
  return JSON.stringify(canonical(value));
}
export interface ExplanationDifference {
  path: string;
  before: GismuCandidate["contributions"][number];
  after: GismuCandidate["contributions"][number];
}
// Independent CLL matcher for the explanation allowance. Do not reuse the scorer.
function referenceMatch(form: string, input: string): number {
  let longest = 0;
  for (let mask = 1; mask < 1 << form.length; mask++) {
    let position = -1,
      length = 0;
    for (let i = 0; i < form.length; i++) {
      if (!(mask & (1 << i))) continue;
      position = input.indexOf(form[i], position + 1);
      if (position < 0) {
        length = 0;
        break;
      }
      length++;
    }
    longest = Math.max(longest, length);
  }
  if (longest >= 3) return longest;
  if (longest !== 2) return 0;
  for (let gap = 1; gap <= 2; gap++)
    for (let i = 0; i + gap < form.length; i++)
      for (let j = 0; j + gap < input.length; j++)
        if (form[i] === input[j] && form[i + gap] === input[j + gap]) return 2;
  return 0;
}
/** Allow only the documented source explanation fix, then compare complete JSON. */
export function compareResults(
  request: Request,
  rust: Result,
  actual: Result,
): {
  matches: boolean;
  approvedDifferences: ExplanationDifference[];
} {
  const rejected = { matches: false, approvedDifferences: [] };
  if (canonicalJson(rust) === canonicalJson(actual))
    return { matches: true, approvedDifferences: [] };
  if (request.op !== "generate" || !("ok" in rust) || !("ok" in actual))
    return rejected;
  const expected = structuredClone(rust) as { ok: GismuResult };
  const differences: ExplanationDifference[] = [];
  try {
    const candidates = expected.ok.candidates.map((candidate, index) => ({
      candidate,
      path: `ok.candidates[${index}]`,
    }));
    if (expected.ok.manual !== null)
      candidates.push({ candidate: expected.ok.manual, path: "ok.manual" });
    for (const { candidate, path } of candidates) {
      // The reference matcher enumerates at most 31 nonempty subsequences.
      if (!/^[a-z]{5}$/.test(candidate.form)) return rejected;
      for (let l = 0; l < expected.ok.languages.length; l++) {
        const language = expected.ok.languages[l];
        const inputs = language.inputs;
        if (inputs.length < 2) continue;
        const zero = language.normalized.numerator === "0";
        const matched = inputs.map((input) =>
          referenceMatch(candidate.form, input),
        );
        let old = 0,
          chosen = 0;
        const weightedOrder = (a: number, b: number) =>
          zero
            ? 0
            : matched[a] * inputs[b].length - matched[b] * inputs[a].length;
        for (let a = 1; a < inputs.length; a++) {
          if (weightedOrder(a, old) > 0) old = a;
          const order = weightedOrder(a, chosen);
          if (order > 0 || (order === 0 && matched[a] > matched[chosen]))
            chosen = a;
        }
        if (chosen === old) continue;
        if (weightedOrder(chosen, old) !== 0 || matched[chosen] <= matched[old])
          return rejected;
        let numerator =
          BigInt(language.normalized.numerator) * BigInt(matched[old]);
        let denominator =
          BigInt(language.normalized.denominator) * BigInt(inputs[old].length);
        let a = numerator,
          b = denominator;
        while (b !== 0n) [a, b] = [b, a % b];
        numerator /= a;
        denominator /= a;
        const before = {
          language: language.language,
          input: inputs[old],
          matched: matched[old],
          length: inputs[old].length,
          weighted: {
            numerator: String(numerator),
            denominator: String(denominator),
          },
        };
        if (canonicalJson(candidate.contributions[l]) !== canonicalJson(before))
          return rejected;
        const after = {
          ...before,
          input: inputs[chosen],
          matched: matched[chosen],
          length: inputs[chosen].length,
        };
        candidate.contributions[l] = after;
        differences.push({
          path: `${path}.contributions[${l}]`,
          before,
          after,
        });
      }
    }
  } catch {
    return rejected;
  }
  return differences.length > 0 &&
    canonicalJson(expected) === canonicalJson(actual)
    ? { matches: true, approvedDifferences: differences }
    : rejected;
}
export function callTypeScript(input: Request): Result {
  try {
    switch (input.op) {
      case "analyze":
        return { ok: analyzeWord(input.profile, input.word) };
      case "build":
        return { ok: buildLujvo(input.request) };
      case "generate":
        return { ok: generateGismu(input.request) };
      case "score":
        return { ok: score(input.tokens) };
      case "segment":
        return { ok: segmentCll(input.word) };
      case "presets":
        return { ok: builderPresets() };
    }
  } catch (error) {
    if (error instanceof BuilderError) return { error: error.failure };
    throw error;
  }
}
export function lockedRequest(
  profile: LegacyProfile,
  word: string,
  reading: RecoveredPart[],
): LujvoRequest {
  // These claims exist only in the synthetic request. They assert no dictionary attribution.
  const request: LujvoRequest = {
    profile,
    components: reading.map((part, index) => ({
      id: `synthetic-row-${index}`,
      spelling: part.text,
      kind: "other",
      locked: part.text,
      claims: isShortRafsiForm(part.text)
        ? [{ rafsi: part.text, pair: `synthetic-claim-${index}` }]
        : [],
    })),
  };
  if (profile === "extended") {
    request.spelling = word;
    request.joins = reading.slice(1).map((part) => part.join_before ?? "");
  }
  return request;
}

const extractor = String.raw`
import hashlib,json,sqlite3,sys
from pathlib import Path
source=Path(sys.argv[1]).resolve()
output=Path(sys.argv[2]).resolve()
def db(name):return sqlite3.connect(f"file:{source/name}?mode=ro&immutable=1",uri=True)
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
before={name:digest(source/name) for name in ['coordinator.sqlite','indexes.sqlite']}
indexed=set()
with db('indexes.sqlite') as connection:
 for (value,) in connection.execute('SELECT value FROM search_entries'):
  indexed.add(json.loads(value)['word']['spelling'])
raw=set();seen=set();events=0
body_hashes=hashlib.sha256()
with db('coordinator.sqlite') as connection:
 for (value,) in connection.execute('SELECT value FROM events'):
  event=json.loads(value)
  if event['header']['action']['kind']!='definition.publish':continue
  events+=1;body_hash=event['body_hash']
  if body_hash in seen:continue
  seen.add(body_hash)
  data=(source/'objects'/body_hash.replace(':','-')).read_bytes()
  assert 'sha256:'+hashlib.sha256(data).hexdigest()==body_hash,body_hash
  raw.add(json.loads(data)['word']['spelling'])
for body_hash in sorted(seen):body_hashes.update((body_hash+'\n').encode())
after={name:digest(source/name) for name in before}
assert before==after,'Dictionary changed during extraction'
words=sorted(raw|indexed)
data=(json.dumps(words,ensure_ascii=False,indent=2)+'\n').encode()
(output/'dictionary-words.json').write_bytes(data)
print(json.dumps({'source':str(source),'access':'SQLite mode=ro and immutable=1; object files read only; no server','definition_events':events,'distinct_definition_bodies':len(seen),'raw_headwords':len(raw),'indexed_headwords':len(indexed),'union_headwords':len(words),'raw_only':sorted(raw-indexed),'index_only':sorted(indexed-raw),'database_sha256':before,'sorted_body_hashes_sha256':body_hashes.hexdigest(),'words_sha256':hashlib.sha256(data).hexdigest()}))
`;
interface Options {
  oracle: string;
  data: string;
  typedData: string;
  gencmu: string;
  out: string;
  random: number;
  combinations: number;
  wordLimit: number | null;
}
function options(argv: string[]): Options {
  const fields = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined)
      throw Error(
        "Use --oracle PATH --data PATH --typed-data PATH --gencmu PATH --out PATH. Optional: --random N --combinations N --word-limit N.",
      );
    fields.set(argv[i].slice(2), argv[i + 1]);
  }
  const required = (name: string, env?: string): string => {
    const value = fields.get(name) ?? (env ? process.env[env] : undefined);
    if (!value) throw Error(`Missing --${name}.`);
    return resolve(value);
  };
  const count = (name: string, fallback: number): number => {
    const value = Number(fields.get(name) ?? fallback);
    if (!Number.isSafeInteger(value) || value < 0)
      throw Error(`--${name} needs a nonnegative safe integer.`);
    return value;
  };
  const allowed = new Set([
    "oracle",
    "data",
    "typed-data",
    "gencmu",
    "out",
    "random",
    "combinations",
    "word-limit",
  ]);
  for (const name of fields.keys())
    if (!allowed.has(name)) throw Error(`Unknown option --${name}.`);
  return {
    oracle: required("oracle", "JVC_MORPHOLOGY_ORACLE"),
    data: required("data"),
    typedData: required("typed-data"),
    gencmu: required("gencmu"),
    out: required("out"),
    random: count("random", 10000),
    combinations: count("combinations", 5000),
    wordLimit: fields.has("word-limit") ? count("word-limit", 0) : null,
  };
}
async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function source(
  language: string,
  input: string,
  numerator: string | number = 1,
  denominator: string | number = 1,
): GismuSourceRow {
  return { language, word: input, input, weight: { numerator, denominator } };
}
function baseBuild(profile: LegacyProfile): LujvoRequest {
  return {
    profile,
    components: [
      {
        id: "synthetic-a",
        spelling: "cukta",
        kind: "gismu",
        claims: [{ rafsi: "cku", pair: "synthetic-cku" }],
      },
      {
        id: "synthetic-b",
        spelling: "sinxa",
        kind: "gismu",
        claims: [{ rafsi: "sni", pair: "synthetic-sni" }],
      },
    ],
  };
}
export function boundaryRequests(): Request[] {
  const output: Request[] = [{ op: "presets" }];
  for (const tokens of [
    [],
    ["cku", "sni"],
    ["sai", "r", "zba"],
    ["ro'i", "n", "re'o"],
    ["klama", "'y'", "broda"],
    ["📘", "y", "á"],
    Array(128).fill(""),
    Array(129).fill(""),
    ["a".repeat(129)],
    ["á".repeat(65)],
  ])
    output.push({ op: "score", tokens });
  for (const word of [
    "",
    "sakli",
    "y".repeat(128),
    "á".repeat(65),
    "tca".repeat(40),
    "📘klam",
    "\u0085sakli\u0085",
    "\uFEFFsakli\uFEFF",
    "djan.",
    "Sakli",
    "sákli",
  ]) {
    output.push({ op: "segment", word });
    for (const profile of profiles)
      output.push({ op: "analyze", profile, word });
  }
  for (const profile of profiles) {
    const base = baseBuild(profile);
    const add = (request: LujvoRequest) =>
      output.push({ op: "build", request });
    add(base);
    add({ ...base, limits: { results: 0 } });
    add({ ...base, limits: { results: 1 } });
    add({ ...base, limits: { choice_product: 0 } });
    add({ ...base, components: [] });
    add({ ...base, components: [base.components[0]] });
    add({
      ...base,
      components: Array.from({ length: 65 }, (_, i) => ({
        ...base.components[0],
        id: `row-${i}`,
      })),
    });
    add({ ...base, spelling: "ckusni" });
    add({ ...base, spelling: " ckusni" });
    add({ ...base, spelling: "a".repeat(129) });
    for (const joins of [[""], ["y"], ["'y'"], ["bad"], ["", null]] as (
      | string
      | null
    )[][])
      add({ ...base, joins });
    add({
      ...base,
      components: [
        { ...base.components[0], spelling: "a".repeat(129) },
        base.components[1],
      ],
    });
    add({
      ...base,
      components: [
        { ...base.components[0], locked: "a".repeat(129) },
        base.components[1],
      ],
    });
    add({
      ...base,
      components: [{ ...base.components[0], locked: "" }, base.components[1]],
    });
    add({
      ...base,
      components: [{ ...base.components[0], locked: "y" }, base.components[1]],
    });
    add({
      ...base,
      components: [
        {
          ...base.components[0],
          claims: Array.from({ length: 65 }, () => ({
            rafsi: "cku",
            pair: "synthetic",
          })),
        },
        base.components[1],
      ],
    });
    add({
      ...base,
      components: [
        {
          ...base.components[0],
          claims: [{ rafsi: "a".repeat(129), pair: "synthetic" }],
        },
        base.components[1],
      ],
    });
    add({
      ...base,
      components: [
        {
          id: "synthetic-a",
          spelling: "tca".repeat(40),
          kind: "lujvo",
          claims: [{ rafsi: "bau", pair: "synthetic-bau" }],
          locked: "bau",
        },
        { ...base.components[1], locked: "sni" },
      ],
    });
    add({
      ...base,
      inventory: {
        snapshot: "synthetic-snapshot",
        claims: [
          {
            rafsi: "cku",
            word: "synthetic-other",
            spelling: "synthetic",
            pair: "synthetic-other-pair",
          },
          {
            rafsi: "sni",
            word: "synthetic-third",
            spelling: "synthetic",
            pair: "synthetic-third-pair",
          },
        ],
      },
    });
    add({
      ...base,
      inventory: {
        claims: Array.from({ length: 20001 }, () => ({
          rafsi: "cku",
          word: "synthetic",
          spelling: "synthetic",
          pair: "synthetic",
        })),
      },
    });
    add({
      profile,
      components: Array.from({ length: 10 }, (_, i) => ({
        id: `synthetic-${i}`,
        spelling: "klama",
        kind: "gismu",
        claims: ["kla", "kam", "ka'a"].map((rafsi) => ({
          rafsi,
          pair: `synthetic-${rafsi}`,
        })),
      })),
    });
  }
  const baseline: GismuRequest = {
    sources: [source("eng", "makrum")],
    manual: "makru",
    window: 4,
  };
  const add = (request: GismuRequest) =>
    output.push({ op: "generate", request });
  add(baseline);
  add({ ...baseline, sources: [] });
  add({
    ...baseline,
    sources: Array.from({ length: 65 }, (_, i) => source(`l${i}`, "banta")),
  });
  for (const sources of [
    [
      source("eng", "makrum", 2),
      source("spa", "ongo"),
      source("deu", "pilts", 0),
    ],
    [source("eng", "mukrom"), source("eng", "makrum"), source("spa", "ongo")],
    [source("eng", "mukrom"), source("eng", "makrum", 2)],
    [source("eng", "makrum", 1, 2), source("eng", "makrum", 2, 4)],
    [
      source("eng", "makrum", "9".repeat(64), "9".repeat(64)),
      source("spa", "ongo", 2, 2),
    ],
    [
      source("eng", "makrum"),
      source("deu", "abc", 0),
      source("deu", "makrum", 0),
    ],
    [
      source("eng", "makrum"),
      source("deu", "makrum", 0),
      source("deu", "abc", 0),
    ],
    [
      source("eng", "makrum"),
      source("deu", "mak", 0),
      source("deu", "makrum", 0),
    ],
    [
      source("eng", "makrum"),
      source("deu", "makrum", 0),
      source("deu", "mak", 0),
    ],
    [source("eng", "mak"), source("eng", "makru")],
    [source("eng", "makru"), source("eng", "mak")],
    [
      source("eng", "makrum"),
      source("deu", "makrum", 0),
      source("deu", "makruz", 0),
    ],
    [
      source("eng", "makrum"),
      source("deu", "makruz", 0),
      source("deu", "makrum", 0),
    ],
    [source("eng", "makrum", 0)],
    [source(" ", "a")],
    [source("é".repeat(33), "a")],
    [{ ...source("eng", "a"), word: "é".repeat(129) }],
    [source("eng", "a".repeat(257))],
    [source("eng", "'.,")],
    [source("eng", "a".repeat(65))],
    [source("eng", "é")],
    [source(" eng ", " MA,K.R'UM ")],
    [{ ...source("eng", "a"), input: null }],
    [{ ...source("eng", "a"), weight: null }],
  ])
    add({ ...baseline, sources });
  for (const numerator of [
    "00",
    "01",
    "-1",
    "1.0",
    "1e2",
    "",
    -1,
    1.5,
    1e22,
    "1".repeat(65),
  ])
    add({ ...baseline, sources: [source("eng", "makrum", numerator)] });
  add({ ...baseline, sources: [source("eng", "makrum", 1, 0)] });
  add({
    ...baseline,
    sources: Array.from({ length: 64 }, (_, i) =>
      source(`l${i}`, "banta", 1, String(10n ** 63n + BigInt(2 * i + 1))),
    ),
  });
  for (const manual of [
    "zbasu",
    "   ",
    "sákli",
    "coi",
    "SA,KLI",
    "\u0085sakli\u0085",
    "\uFEFFsakli\uFEFF",
    "a".repeat(129),
  ])
    add({ ...baseline, manual });
  for (const window of [0, 1, 32, 512, 513]) add({ ...baseline, window });
  add({
    ...baseline,
    candidates: "all-letters",
    window: 0,
    limits: { work: 1000 },
  });
  add({ ...baseline, limits: { work: 0 } });
  add({
    ...baseline,
    inventory: {
      gismu: Array.from({ length: 20001 }, () => ({
        spelling: "sakli",
        word: "synthetic",
      })),
    },
  });
  const conflicts: NonNullable<GismuRequest["inventory"]> = {
    snapshot: "synthetic-snapshot",
    gismu: [
      { spelling: "klama", word: "synthetic-1" },
      { spelling: "plami", word: "synthetic-2" },
      { spelling: "klamu", word: "synthetic-3" },
      { spelling: "klama", word: "synthetic-duplicate" },
      { spelling: "klama", word: "synthetic-1" },
    ],
    claims: [
      {
        rafsi: "kla",
        word: "synthetic-1",
        spelling: "klama",
        pair: "synthetic-p1",
      },
      {
        rafsi: "kla",
        word: "synthetic-9",
        spelling: "klaku",
        pair: "synthetic-p9",
      },
    ],
  };
  for (const manual of ["klama", "glama", "plama"])
    add({
      ...baseline,
      sources: [source("eng", "come")],
      candidates: "all-letters",
      window: 1,
      manual,
      inventory: conflicts,
    });
  return output;
}

async function main(): Promise<void> {
  if (process.argv.slice(2).includes("--help")) {
    console.log(`Compare the retained TypeScript morphology profiles with the native Rust oracle.

Usage: npx tsx scripts/compare-morphology.ts [options]

Required options:
  --oracle PATH       Native morphology-oracle executable.
                      JVC_MORPHOLOGY_ORACLE can supply this path instead.
  --data PATH         Dictionary directory with SQLite databases and objects.
  --typed-data PATH   PR #31 directory with words.json and gencmu-oracle.json.
  --gencmu PATH       Read-only gencmu checkout with tests/corpus/*.jsonl.
  --out PATH          New evidence directory. Existing summaries are preserved.

Optional options:
  --random N          Deterministic random forms. Default: 10000.
  --combinations N    Deterministic rafsi and core combinations. Default: 5000.
  --word-limit N      Limit words for a diagnostic run. The report marks it partial.
  --help             Print this help without reading data or writing evidence.

For full process CPU and peak RSS, run with:
  /usr/bin/time -v -o OUT/process-time.txt npx tsx scripts/compare-morphology.ts [options]

The harness also records TypeScript CPU and peak RSS and native oracle timing.
It records approved source-explanation changes with both complete raw results.
It stops at the first unexpected mismatch and writes the complete request and both results.`);
    return;
  }
  const configuration = options(process.argv.slice(2));
  mkdirSync(configuration.out, { recursive: true });
  if (existsSync(join(configuration.out, "summary.json")))
    throw Error(
      "Choose a new --out directory. Existing evidence must remain intact.",
    );
  const started = new Date().toISOString(),
    cpuStart = process.cpuUsage();
  const metadata: Record<string, unknown> = {
    configuration,
    started,
    seed: "0x12345678",
    comparison: "Complete JSON, sorted object keys, exact array order",
    explanation_allowance:
      "Equal weighted values prefer the larger matched-letter count. Complete ties retain source order. All other JSON must match.",
    scope:
      "Retained CLL, extended version 2, and extended version 3 only. Gencmu inputs supply no syntax expectations.",
  };
  const inputFiles: Record<string, string> = {};
  const addInput = async (path: string): Promise<void> => {
    inputFiles[path] = await fileDigest(path);
  };
  await addInput(configuration.oracle);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  for (const path of [
    "scripts/compare-morphology.ts",
    "scripts/morphology-oracle.rs",
    ...readdirSync(join(root, "packages/morphology/src"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => `packages/morphology/src/${name}`),
  ])
    await addInput(join(root, path));
  console.log(
    "Extracting dictionary headwords with immutable read-only SQLite.",
  );
  const dictionary = JSON.parse(
    execFileSync(
      "python3",
      ["-c", extractor, configuration.data, configuration.out],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    ),
  );
  metadata.dictionary = dictionary;
  writeFileSync(
    join(configuration.out, "dictionary-provenance.json"),
    JSON.stringify(dictionary, null, 2) + "\n",
  );
  const wordSources = new Map<string, Set<string>>();
  const counts: Record<string, number> = {};
  const addWord = (word: unknown, source: string): void => {
    if (typeof word !== "string") throw Error(`Non-string word from ${source}`);
    const sources = wordSources.get(word) ?? new Set<string>();
    sources.add(source);
    wordSources.set(word, sources);
  };
  const dictionaryWords = JSON.parse(
    readFileSync(join(configuration.out, "dictionary-words.json"), "utf8"),
  ) as string[];
  for (const word of dictionaryWords) addWord(word, "dictionary");
  counts.dictionary_headwords = dictionaryWords.length;
  for (const name of ["words.json", "gencmu-oracle.json"]) {
    const path = join(configuration.typedData, name);
    await addInput(path);
    const rows = JSON.parse(readFileSync(path, "utf8")) as unknown[];
    for (const row of rows)
      addWord(
        typeof row === "string" ? row : (row as { word: string }).word,
        `pr31-${name}`,
      );
    counts[`pr31_${name}_rows`] = rows.length;
  }
  let experimentalRows = 0,
    corpusFiles = 0;
  for (const name of readdirSync(join(configuration.gencmu, "tests/corpus"))
    .filter((name) => name.endsWith(".jsonl"))
    .sort()) {
    const path = join(configuration.gencmu, "tests/corpus", name);
    await addInput(path);
    corpusFiles++;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as {
        dialect?: string;
        text?: string;
        words?: string[];
      };
      if (row.dialect !== "experimental") continue;
      experimentalRows++;
      if (typeof row.text === "string")
        addWord(row.text, "gencmu-experimental-full-text");
      for (const word of row.words ?? [])
        addWord(word, "gencmu-experimental-word");
    }
  }
  counts.gencmu_corpus_files = corpusFiles;
  counts.gencmu_experimental_rows = experimentalRows;
  const referencePath = join(
    root,
    "packages/morphology/evidence/word-parses.json",
  );
  if (existsSync(referencePath)) {
    await addInput(referencePath);
    for (const row of JSON.parse(readFileSync(referencePath, "utf8")).cases)
      addWord(row.word, "retained-reference");
  }
  for (const word of [
    "sakli",
    "ckusni",
    "ka'a",
    "djan",
    "djan.",
    "iismu",
    "aaaa",
    "leksiko",
    "cuktysni",
    "gimspageti",
    "kamzu",
    "mamza",
    "cimza'a",
    "lemzasli",
    "ka,m,zu",
    "sakrsakysakli",
    "sabkysakli",
    "rsakli",
    "ntadi",
    "leksiko'yismu",
    "fulta'yismu",
    "baurismu",
    "y",
    "yyy",
    "ie'o",
    "taia",
    "i'ecu'i",
    "zo,is",
    "zoi,s",
    "i,aii",
    "íaií",
    "📘klam",
    "𝑎klam",
    "a".repeat(129),
    "á".repeat(65),
    "tca".repeat(40),
  ])
    addWord(word, "fixed-boundary");
  let seed = 0x12345678;
  const random = (limit: number): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % limit;
  };
  const alphabet = Array.from("bcdfgjklmnprstvxzaeiouy',ĭŭáéíóúý09");
  for (let index = 0; index < configuration.random; index++)
    addWord(
      Array.from(
        { length: random(32) },
        () => alphabet[random(alphabet.length)],
      ).join(""),
      "random-form",
    );
  const chunks = [
    "jbo",
    "bau",
    "bla",
    "zba",
    "kam",
    "kar",
    "tce",
    "sel",
    "xam",
    "sni",
    "ka'a",
    "ba'u",
    "klam",
    "klama",
    "y",
    "'y",
    "y'",
    "'y'",
    "leksiko",
    "spageti",
    "iismu",
    "ismu",
    "no",
    "pa",
    "ai",
    "ia",
  ];
  for (let index = 0; index < configuration.combinations; index++)
    addWord(
      Array.from(
        { length: 1 + random(6) },
        () => chunks[random(chunks.length)],
      ).join(""),
      "random-combination",
    );
  counts.unique_words = wordSources.size;
  const allWords = [...wordSources.keys()].sort();
  const words =
    configuration.wordLimit === null
      ? allWords
      : allWords.slice(0, configuration.wordLimit);
  counts.tested_words = words.length;
  metadata.input_sha256 = inputFiles;
  metadata.coverage = counts;
  metadata.full = configuration.wordLimit === null;
  writeFileSync(
    join(configuration.out, "input-provenance.json"),
    JSON.stringify(metadata, null, 2) + "\n",
  );
  writeFileSync(
    join(configuration.out, "word-sources.json"),
    JSON.stringify(
      [...wordSources].map(([word, sources]) => ({
        word,
        sources: [...sources].sort(),
      })),
    ) + "\n",
  );
  console.log(
    `Loaded ${counts.unique_words} unique words. Comparing ${words.length} words across all retained profiles.`,
  );
  const native = spawn(
    "/usr/bin/time",
    [
      "-v",
      "-o",
      join(configuration.out, "oracle-time.txt"),
      configuration.oracle,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  native.stderr.setEncoding("utf8");
  native.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const nativeExit = once(native, "close");
  const reader = createInterface({ input: native.stdout });
  const answers = reader[Symbol.asyncIterator]();
  const ledger = createWriteStream(
    join(configuration.out, "comparison-ledger.jsonl"),
    { flags: "wx" },
  );
  const approvedFile = "approved-explanation-differences.jsonl";
  const approvedLedger = createWriteStream(
    join(configuration.out, approvedFile),
    { flags: "wx" },
  );
  const requestDigest = createHash("sha256"),
    rustDigest = createHash("sha256"),
    typescriptDigest = createHash("sha256");
  const operationCounts: Record<string, number> = {},
    groupCounts: Record<string, number> = {};
  let comparisons = 0,
    approvedComparisons = 0,
    approvedDifferences = 0,
    mismatch: unknown = null,
    failure: unknown = null,
    lastProgress = Date.now();
  const compare = async (request: Request, group: string): Promise<Result> => {
    const input = JSON.stringify(request) + "\n";
    if (!native.stdin.write(input)) await once(native.stdin, "drain");
    const next = await answers.next();
    if (next.done)
      throw Error(`Oracle ended before response ${comparisons + 1}: ${stderr}`);
    const rust = JSON.parse(next.value) as Result;
    const actual = callTypeScript(request);
    const canonicalRequest = canonicalJson(request),
      canonicalRust = canonicalJson(rust),
      canonicalActual = canonicalJson(actual);
    const comparison = compareResults(request, rust, actual);
    requestDigest.update(canonicalRequest + "\n");
    rustDigest.update(canonicalRust + "\n");
    typescriptDigest.update(canonicalActual + "\n");
    comparisons++;
    operationCounts[request.op] = (operationCounts[request.op] ?? 0) + 1;
    groupCounts[group] = (groupCounts[group] ?? 0) + 1;
    const entry = {
      id: comparisons,
      group,
      request_sha256: sha256(canonicalRequest),
      rust_sha256: sha256(canonicalRust),
      typescript_sha256: sha256(canonicalActual),
      comparison: !comparison.matches
        ? "unexpected-difference"
        : comparison.approvedDifferences.length
          ? "approved-explanation-difference"
          : "identical",
      approved_explanation_differences: comparison.approvedDifferences.length,
    };
    if (!ledger.write(JSON.stringify(entry) + "\n"))
      await once(ledger, "drain");
    if (comparison.approvedDifferences.length > 0) {
      approvedComparisons++;
      approvedDifferences += comparison.approvedDifferences.length;
      if (
        !approvedLedger.write(
          JSON.stringify({
            ...entry,
            request,
            rust,
            typescript: actual,
            differences: comparison.approvedDifferences,
          }) + "\n",
        )
      )
        await once(approvedLedger, "drain");
    }
    if (!comparison.matches) {
      mismatch = {
        request,
        rust,
        typescript: actual,
        ...entry,
      };
      writeFileSync(
        join(configuration.out, "mismatch.json"),
        JSON.stringify(mismatch, null, 2) + "\n",
      );
      throw Error(
        `Compatibility mismatch ${comparisons}: ${request.op}. See ${join(configuration.out, "mismatch.json")}.`,
      );
    }
    if (Date.now() - lastProgress > 20000) {
      console.log(
        `${comparisons} comparisons pass: ${JSON.stringify(operationCounts)}`,
      );
      lastProgress = Date.now();
    }
    return rust;
  };
  const derived = new Map<string, Request>();
  const queue = (request: Request): void => {
    const key = canonicalJson(request);
    if (!derived.has(key)) derived.set(key, request);
  };
  const gismu = new Set<string>();
  try {
    for (const request of boundaryRequests())
      await compare(request, "boundaries");
    for (const word of words) {
      for (const profile of profiles) {
        const result = await compare(
          { op: "analyze", profile, word },
          "analysis",
        );
        if (!("ok" in result))
          throw Error("Analysis must return a structured result.");
        const analysis = result.ok as WordAnalysis;
        if (analysis.kind === "gismu" && analysis.normalized !== null)
          gismu.add(analysis.normalized);
        if (analysis.kind !== "lujvo") continue;
        queue({ op: "segment", word });
        for (const reading of analysis.readings) {
          const tokens = reading.flatMap((part) =>
            part.join_before === null
              ? [part.text]
              : [part.join_before, part.text],
          );
          queue({ op: "score", tokens });
          for (const target of profiles)
            queue({
              op: "build",
              request: lockedRequest(
                target,
                analysis.normalized ?? word,
                reading,
              ),
            });
        }
      }
    }
    counts.derived_requests = derived.size;
    counts.recognized_gismu = gismu.size;
    console.log(
      `Analysis passes. Comparing ${derived.size} segmentation, score, and locked construction requests.`,
    );
    for (const request of derived.values())
      await compare(request, "derived-lujvo");
    for (const word of [...gismu].sort())
      await compare(
        {
          op: "generate",
          request: {
            sources: [source("synthetic-source", word)],
            manual: word,
            window: 8,
          },
        },
        "dictionary-gismu",
      );
    for (let index = 0; index < 128; index++) {
      const letters = "bcdfgjklmnprstvxzaeiou";
      const input = Array.from(
        { length: 2 + random(16) },
        () => letters[random(letters.length)],
      ).join("");
      const other = Array.from(
        { length: 2 + random(16) },
        () => letters[random(letters.length)],
      ).join("");
      await compare(
        {
          op: "generate",
          request: {
            sources: [
              source("synthetic-a", input, 1 + random(50), 1 + random(50)),
              source("synthetic-b", other, random(50), 1 + random(50)),
            ],
            manual: ["sakli", "makru", "zbasu"][random(3)],
            window: random(9),
          },
        },
        "random-gismu",
      );
    }
  } catch (error) {
    failure =
      error instanceof Error
        ? { message: error.message, stack: error.stack }
        : String(error);
  } finally {
    native.stdin.end();
    const [nativeCode, nativeSignal] = await nativeExit;
    if (nativeCode !== 0 && failure === null) {
      failure = {
        message: `Oracle exited with code ${nativeCode} and signal ${nativeSignal}.`,
      };
    }
    ledger.end();
    await once(ledger, "finish");
    approvedLedger.end();
    await once(approvedLedger, "finish");
    writeFileSync(join(configuration.out, "oracle-stderr.txt"), stderr);
    const cpu = process.cpuUsage(cpuStart),
      usage = process.resourceUsage();
    const summary = {
      ...metadata,
      finished: new Date().toISOString(),
      comparisons,
      operation_counts: operationCounts,
      group_counts: groupCounts,
      coverage: counts,
      request_sha256: requestDigest.digest("hex"),
      rust_results_sha256: rustDigest.digest("hex"),
      typescript_results_sha256: typescriptDigest.digest("hex"),
      approved_explanation_comparisons: approvedComparisons,
      approved_explanation_differences: approvedDifferences,
      approved_explanation_file: approvedFile,
      passed: failure === null,
      mismatches: mismatch === null ? 0 : 1,
      failure,
      typescript_cpu_microseconds: cpu,
      typescript_max_rss_kib: usage.maxRSS,
      native_time_file: "oracle-time.txt",
      process_tree_time_file: "process-time.txt",
    };
    writeFileSync(
      join(configuration.out, "summary.json"),
      JSON.stringify(summary, null, 2) + "\n",
    );
    console.log(
      JSON.stringify(
        {
          passed: failure === null,
          comparisons,
          operationCounts,
          approved_explanation_comparisons: approvedComparisons,
          approved_explanation_differences: approvedDifferences,
          coverage: counts,
          evidence: configuration.out,
          failure,
        },
        null,
        2,
      ),
    );
  }
  if (failure !== null) process.exitCode = 1;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
