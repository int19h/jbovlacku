/** Compare extended-v4 with the pinned gencmu experimental FORMS stage.
 * Run with node --import tsx. External sources are read only.
 * Run under /usr/bin/time -v to record process CPU time and peak RSS too.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { analyzeWord } from "../packages/morphology/src/index.ts";

export const REFERENCE_REVISION = "0b3da7d2ec2f727a6730d77c775f88214a7ffc89";
export const RANDOM_SEED = 0x42c0ffee;
const warning = "This form is not valid under the current BPFK morphology.";
export type Word = { text: string; kind: string; warning: boolean };
type Token = { value: string; tags: Set<string>; source: number[] };
export type Reference = {
  ok: boolean;
  words: Word[];
  tokens: { text: string; tags: string[]; source: number[] }[];
};

const digest = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const boundaries = (words: Word[]) =>
  words.map(({ text, kind }) => ({ text, kind }));
const warnings = (words: Word[]) =>
  words.filter((w) => w.warning).map(({ text, kind }) => ({ text, kind }));
const canonical = (text: string) =>
  text
    .toLowerCase()
    .replaceAll("’", "'")
    .replaceAll("h", "'")
    .replaceAll(",", "");

/** This reproduces the reviewer's xorshift32 seed, alphabet, chunks, and draw order. */
export function randomForms(seed = RANDOM_SEED, count = 5000): string[] {
  const random = (limit: number) => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % limit;
  };
  const alphabet = "bcdfgjklmnprstvxzaeiouy',";
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
    "kui",
    "lia",
    "rua",
    "mz",
    "broda",
  ];
  const inputs = new Set<string>();
  for (let i = 0; i < count; i++)
    inputs.add(
      Array.from(
        { length: 1 + random(24) },
        () => alphabet[random(alphabet.length)],
      ).join(""),
    );
  for (let i = 0; i < count; i++)
    inputs.add(
      Array.from(
        { length: 1 + random(6) },
        () => chunks[random(chunks.length)],
      ).join(""),
    );
  return [...inputs];
}

/** Each extra pause must directly follow a falling diphthong and precede a cmavo.
 * The caller must also prove the complete spaced result with gencmu.
 */
export function fallingDiphthongSpacing(
  input: string,
  actual: Word[],
): string | null {
  if (actual.length < 2) return null;
  let cursor = 0;
  let output = "";
  let added = 0;
  for (let i = 0; i < actual.length; i++) {
    const word = actual[i];
    const start = input.indexOf(word.text, cursor);
    if (start < 0 || !/^[.?!\s]*$/.test(input.slice(cursor, start)))
      return null;
    output += input.slice(cursor, start) + word.text;
    cursor = start + word.text.length;
    const next = actual[i + 1];
    if (
      next &&
      word.kind === "cmavo" &&
      next.kind === "cmavo" &&
      /(?:ai|au|ei|oi)$/.test(word.text) &&
      /^[aeiouy]/.test(next.text) &&
      input.startsWith(next.text, cursor)
    ) {
      output += " ";
      added++;
    }
  }
  if (!/^[.?!\s]*$/.test(input.slice(cursor))) return null;
  return added ? output + input.slice(cursor) : null;
}

/** Only contiguous pure-y hesitation tokens form one project cmavo. */
export function projectHesitationWords(reference: Reference): Word[] {
  const result: Word[] = [];
  let previousEnd = -1;
  let previousPureY = false;
  let index = 0;
  for (const token of reference.tokens) {
    if (!token.tags.includes("Word") && !token.tags.includes("Hesitation"))
      continue;
    const word = reference.words[index++];
    const pureY = word.kind === "hesitation" && /^y+$/.test(word.text);
    if (pureY && previousPureY && previousEnd === token.source[0])
      result[result.length - 1].text += word.text;
    else
      result.push({
        ...word,
        kind: word.kind === "hesitation" ? "cmavo" : word.kind,
      });
    previousEnd = token.source[1];
    previousPureY = pureY;
  }
  return result;
}

type ProjectedAnalysis = { normalized: string | null; words: Word[] };

/** Prove pause removal alone, or pause removal followed by the narrow cmavo split. */
export function apostrophePauseProof(
  input: string,
  original: Reference,
  analyze: (input: string) => ProjectedAnalysis,
  reference: (input: string) => Reference,
) {
  if (!original.ok) return null;
  const chars = Array.from(input);
  let changed = false;
  for (const token of original.tokens) {
    const slice = chars.slice(token.source[0], token.source[1]).join("");
    if (
      token.tags.includes("PAUSE") &&
      /['’]/.test(slice) &&
      /^[,.'’?!\s]+$/.test(slice)
    ) {
      chars.splice(
        token.source[0],
        token.source[1] - token.source[0],
        ...Array(token.source[1] - token.source[0]).fill(" "),
      );
      changed = true;
    }
  }
  if (!changed) return null;
  const adjustedInput = chars.join("");
  const adjusted = analyze(adjustedInput);
  if (same(projectHesitationWords(original), adjusted.words))
    return { input: adjustedInput, actual: adjusted.words, spacing: null };
  if (adjusted.normalized === null) return null;
  const unspaced = reference(adjustedInput);
  // Removing a reference pause must preserve all its words and warnings.
  if (!unspaced.ok || !same(original.words, unspaced.words)) return null;
  const spaced = fallingDiphthongSpacing(adjusted.normalized, adjusted.words);
  if (spaced === null) return null;
  const spacedReference = reference(spaced);
  if (
    !spacedReference.ok ||
    !same(projectHesitationWords(spacedReference), adjusted.words)
  )
    return null;
  return {
    input: adjustedInput,
    actual: adjusted.words,
    spacing: {
      input: spaced,
      reference: spacedReference,
      unspacedReference: unspaced,
    },
  };
}

/** Compare every pause-delimited run with the same reference input and token offsets. */
export function foreignRunProof(
  input: string,
  reference: Reference,
  analyze: (input: string) => ProjectedAnalysis,
) {
  if (
    !reference.ok ||
    !reference.tokens.some((token) => token.tags.includes("FOREIGN"))
  )
    return null;
  const chars = Array.from(input);
  const runs: { input: string; actual: Word[] }[] = [];
  let start = 0;
  for (const pause of [
    ...reference.tokens.filter((token) => token.tags.includes("PAUSE")),
    { source: [chars.length, chars.length] },
  ]) {
    const run = chars.slice(start, pause.source[0]).join("");
    if (run) runs.push({ input: run, actual: analyze(run).words });
    start = pause.source[1];
  }
  return same(
    projectHesitationWords(reference),
    runs.flatMap((run) => run.actual),
  )
    ? { input, reference, runs }
    : null;
}

/** The JS package must use the exact grammar bytes pinned by the root manifest. */
export function assertBundledGrammarIdentity(
  rootHashes: Record<string, string>,
  bundledHashes: Record<string, string>,
): void {
  if (!Object.keys(bundledHashes).length)
    throw new Error("The bundled grammar manifest is empty.");
  for (const [file, hash] of Object.entries(bundledHashes)) {
    if (rootHashes[`grammars/${file}`] !== hash)
      throw new Error(
        `Bundled grammar differs from the pinned root source: ${file}`,
      );
  }
}

export function assertCacheIdentity(
  summary: {
    reference: { revision: string; sourceHashes: Record<string, string> };
    inputsSha256: string;
    resultsSha256?: string;
  },
  sourceHashes: Record<string, string>,
  inputsSha256: string,
  resultsSha256: string,
): void {
  if (
    summary.reference.revision !== REFERENCE_REVISION ||
    !same(summary.reference.sourceHashes, sourceHashes) ||
    summary.inputsSha256 !== inputsSha256
  )
    throw new Error(
      "The cached reference sources or inputs differ from this run.",
    );
  if (summary.resultsSha256 && summary.resultsSha256 !== resultsSha256)
    throw new Error(
      "The cached reference results digest differs from its manifest.",
    );
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    console.log(
      `Usage: node --import tsx scripts/compare-gencmu-morphology.ts --gencmu PATH --dictionary-words JSON --out DIR [--baseline-module FILE] [--seed NUMBER] [--draws 5000] [--reference-cache DIR]\nThe JSON must contain the 31,668 extracted dictionary headwords. Each random distribution uses --draws inputs before deduplication. --baseline-module selects a separately restored morphology index.ts. --reference-cache reuses completed reference results only after all source and input digests match. No source file is changed. Every input and mismatch is retained. Classifications describe observed scope differences, not approved corpus exceptions. Exit status reports classification completeness, not corpus parity.`,
    );
    return;
  }
  const options = new Map<string, string>();
  const allowed = new Set([
    "--gencmu",
    "--dictionary-words",
    "--out",
    "--baseline-module",
    "--seed",
    "--draws",
    "--reference-cache",
  ]);
  for (let i = 0; i < argv.length; i += 2) {
    if (!allowed.has(argv[i]) || !argv[i + 1])
      throw new Error("Every option requires a value.");
    options.set(argv[i], argv[i + 1]);
  }
  const required = (key: string) => {
    const value = options.get(key);
    if (!value) throw new Error(`Missing ${key}.`);
    return resolve(value);
  };
  const root = required("--gencmu");
  const dictionaryFile = required("--dictionary-words");
  const out = required("--out");
  if (existsSync(out) && readdirSync(out).length)
    throw new Error(
      "The output directory must be empty. Keep earlier evidence in place.",
    );
  mkdirSync(out, { recursive: true });
  const scriptBytes = readFileSync(fileURLToPath(import.meta.url));
  const scriptSha256 = digest(scriptBytes);
  writeFileSync(join(out, "script.ts"), scriptBytes);
  writeFileSync(
    join(out, "command.json"),
    JSON.stringify(
      {
        executable: process.execPath,
        execArgv: process.execArgv,
        argv: process.argv,
        cwd: process.cwd(),
      },
      null,
      2,
    ) + "\n",
  );
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  const revision = git(root, "rev-parse", "HEAD");
  if (
    revision !== REFERENCE_REVISION ||
    git(root, "status", "--porcelain", "--untracked-files=no")
  )
    throw new Error(
      "The reference checkout must be clean at the pinned revision.",
    );
  const { loadDialect, bundledGrammarsDirectory } = await import(
    pathToFileURL(join(root, "lib/js/src/node.js")).href
  );
  const dialect = loadDialect("experimental");
  const grammarDirectory: string = bundledGrammarsDirectory();
  const analyze: typeof analyzeWord = options.has("--baseline-module")
    ? (await import(pathToFileURL(required("--baseline-module")).href))
        .analyzeWord
    : analyzeWord;
  const referenceCache = new Map<string, Reference>();
  let cacheEvidence: unknown = null;
  const reference = (input: string): Reference => {
    const cached = referenceCache.get(input);
    if (cached) return cached;
    const result = dialect.parse(input, { until: "forms" });
    const tokens: Token[] =
      result.stages.findLast((s: { name: string }) => s.name === "forms")
        ?.output ?? [];
    return {
      ok: result.ok,
      words: tokens
        .filter((t) => t.tags.has("Word") || t.tags.has("Hesitation"))
        .map((t) => ({
          text: canonical(t.value),
          kind: t.tags.has("Hesitation")
            ? "hesitation"
            : t.tags.has("Cmavo")
              ? "cmavo"
              : t.tags.has("BRIVLA")
                ? "brivla"
                : t.tags.has("CMEVLA")
                  ? "cmevla"
                  : "other",
          warning: t.tags.has("Cgv-Warning"),
        })),
      tokens: tokens.map((t) => ({
        text: t.value,
        tags: [...t.tags].sort(),
        source: t.source,
      })),
    };
  };
  const dictionaryBytes = readFileSync(dictionaryFile);
  const dictionary: string[] = JSON.parse(dictionaryBytes.toString("utf8"));
  const provenancePath = join(
    dirname(dictionaryFile),
    "dictionary-provenance.json",
  );
  const dictionaryProvenance = existsSync(provenancePath)
    ? JSON.parse(readFileSync(provenancePath, "utf8"))
    : null;
  if (
    dictionaryProvenance &&
    dictionaryProvenance.words_sha256 !== digest(dictionaryBytes)
  )
    throw new Error(
      "The dictionary provenance digest differs from the supplied words.",
    );
  if (dictionaryProvenance)
    writeFileSync(
      join(out, "dictionary-provenance.json"),
      JSON.stringify(dictionaryProvenance, null, 2) + "\n",
    );
  if (
    dictionary.length !== 31668 ||
    new Set(dictionary).size !== dictionary.length ||
    dictionary.some((word) => typeof word !== "string")
  )
    throw new Error("Expected exactly 31,668 unique dictionary headwords.");
  const seed = Number(options.get("--seed") ?? RANDOM_SEED);
  const draws = Number(options.get("--draws") ?? 5000);
  if (
    !Number.isSafeInteger(seed) ||
    seed < 0 ||
    seed > 0xffffffff ||
    !Number.isSafeInteger(draws) ||
    draws < 5000
  )
    throw new Error(
      "Use a uint32 seed and at least 5,000 draws per distribution.",
    );
  const inputs = dictionary.map((input) => ({ input, source: "dictionary" }));
  const primaryRandom = randomForms(seed, draws);
  const supplementalSeed = (seed + 1) >>> 0;
  const supplementalRandom = randomForms(supplementalSeed, 500).filter(
    (input) => !primaryRandom.includes(input),
  );
  inputs.push(
    ...primaryRandom.map((input) => ({ input, source: "seeded-random" })),
  );
  inputs.push(
    ...supplementalRandom.map((input) => ({
      input,
      source: "supplemental-random",
    })),
  );
  const corpusFiles = readdirSync(join(root, "tests/corpus"))
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  const corpus = new Map<string, string>();
  for (const file of corpusFiles)
    for (const line of readFileSync(join(root, "tests/corpus", file), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)) {
      const row = JSON.parse(line);
      if (row.dialect !== "experimental") continue;
      for (const input of [row.text, ...(row.words ?? [])])
        if (typeof input === "string") corpus.set(input, `${file}:${row.id}`);
    }
  inputs.push(
    ...[...corpus].map(([input, id]) => ({
      input,
      source: `gencmu-corpus:${id}`,
    })),
  );
  inputs.push(
    ...[
      "baoz",
      "uylaolje",
      "taia",
      "i'ecu'i",
      "BROdaku",
      "KLAmabroda",
      "SAIrzbaku",
    ].map((input) => ({ input, source: "review-control" })),
  );
  writeFileSync(
    join(out, "inputs.json"),
    JSON.stringify(inputs, null, 2) + "\n",
  );
  const sourceHashes: Record<string, string> = {};
  for (const file of git(
    root,
    "ls-files",
    "grammars",
    "lib/js/src",
    "lib/js/package.json",
  ).split("\n"))
    sourceHashes[file] = digest(readFileSync(join(root, file)));
  const bundledHashes: Record<string, string> = {};
  for (const file of git(root, "ls-files", "lib/js/grammars").split("\n"))
    bundledHashes[file.slice("lib/js/grammars/".length)] = digest(
      readFileSync(join(root, file)),
    );
  assertBundledGrammarIdentity(sourceHashes, bundledHashes);
  const implementationRoot = options.has("--baseline-module")
    ? resolve(required("--baseline-module"), "..", "..", "..", "..")
    : fileURLToPath(new URL("..", import.meta.url));
  const implementationHashes: Record<string, string> = {};
  for (const dir of ["packages/morphology/src", "packages/morphology/grammar"])
    for (const name of readdirSync(join(implementationRoot, dir)).sort())
      implementationHashes[`${dir}/${name}`] = digest(
        readFileSync(join(implementationRoot, dir, name)),
      );
  if (options.has("--reference-cache")) {
    const cacheRoot = required("--reference-cache");
    const summaryBytes = readFileSync(join(cacheRoot, "summary.json"));
    const cachedSummary = JSON.parse(summaryBytes.toString("utf8"));
    const resultsBytes = readFileSync(join(cacheRoot, "results.jsonl"));
    assertCacheIdentity(
      cachedSummary,
      sourceHashes,
      digest(readFileSync(join(out, "inputs.json"))),
      digest(resultsBytes),
    );
    const rows = resultsBytes
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    if (rows.length !== inputs.length)
      throw new Error("The reference cache is incomplete.");
    for (const [index, row] of rows.entries()) {
      if (
        row.index !== index ||
        row.input !== inputs[index].input ||
        row.source !== inputs[index].source
      )
        throw new Error("A cached input differs from this run.");
      if (row.reference) referenceCache.set(row.input, row.reference);
      else if (Buffer.byteLength(row.input) <= 128)
        throw new Error("A reference result is missing from the cache.");
    }
    cacheEvidence = {
      directory: cacheRoot,
      summarySha256: digest(summaryBytes),
      resultsSha256: digest(resultsBytes),
      referenceCpuMicroseconds: cachedSummary.cpuMicroseconds,
      referenceResourceUsage: cachedSummary.resourceUsage,
    };
  }
  const mismatches: unknown[] = [];
  const resourceScopeDifferences: unknown[] = [];
  const resultsFile = join(out, "results.jsonl");
  writeFileSync(resultsFile, "");
  const counts: Record<string, number> = {};
  let unclassifiedWarningDifferences = 0;
  let rawBoundaryDifferences = 0;
  let rawWarningDifferences = 0;
  const bySource: Record<
    string,
    {
      inputs: number;
      resourceScopeDifferences: number;
      boundaryDifferences: number;
      warningDifferences: number;
      unclassifiedDifferences: number;
      referenceNoWords: number;
      actualNoWords: number;
    }
  > = {};
  let unclassifiedDifferences = 0;
  const baselineFalseWarnings: unknown[] = [];
  const started = process.cpuUsage();
  for (const [index, entry] of inputs.entries()) {
    const { input, source } = entry;
    const sourceGroup = source.split(":")[0];
    const stats = (bySource[sourceGroup] ??= {
      inputs: 0,
      resourceScopeDifferences: 0,
      boundaryDifferences: 0,
      warningDifferences: 0,
      unclassifiedDifferences: 0,
      referenceNoWords: 0,
      actualNoWords: 0,
    });
    stats.inputs++;
    if (index % 5000 === 0) console.error(`Compared ${index}/${inputs.length}`);
    if (Buffer.byteLength(input) > 128) {
      const row = {
        index,
        ...entry,
        reason: "documented-128-byte-limit",
        bytes: Buffer.byteLength(input),
        analysis: analyze("extended-v4", input),
      };
      resourceScopeDifferences.push(row);
      stats.resourceScopeDifferences++;
      appendFileSync(resultsFile, JSON.stringify(row) + "\n");
      continue;
    }
    const ref = reference(input);
    const analysis = analyze("extended-v4", input);
    const actual = (analysis.words ?? []).map((w) => ({
      text: w.text,
      kind: ["gismu", "lujvo", "fuhivla"].includes(w.kind) ? "brivla" : w.kind,
      warning: w.diagnostics.includes(warning),
    }));
    const boundaryDiff = !same(boundaries(ref.words), boundaries(actual));
    const warningDiff = !same(warnings(ref.words), warnings(actual));
    if (boundaryDiff) {
      rawBoundaryDifferences++;
      stats.boundaryDifferences++;
    }
    if (warningDiff) {
      rawWarningDifferences++;
      stats.warningDifferences++;
    }
    if (!ref.words.length) stats.referenceNoWords++;
    if (!actual.length) stats.actualNoWords++;
    if (
      source === "dictionary" &&
      actual.some((w) => w.warning) &&
      !ref.words.some((w) => w.warning)
    )
      baselineFalseWarnings.push({ input, reference: ref, actual });
    appendFileSync(
      resultsFile,
      JSON.stringify({
        index,
        ...entry,
        reference: ref,
        actual,
        normalized: analysis.normalized,
        diagnostics: analysis.diagnostics,
        boundaryDiff,
        warningDiff,
      }) + "\n",
    );
    if (!boundaryDiff && !warningDiff) continue;
    const reasons: string[] = [];
    let effective = ref;
    const counterfactuals: unknown[] = [];
    // Prove spelling effects by running the reference on precisely the API's normalized input.
    if (analysis.normalized !== null && input !== analysis.normalized) {
      const caseKept = input
        .replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "")
        .replaceAll("’", "'")
        .replace(/[hH]/g, "'")
        .replaceAll(",", "")
        .replace(/^\.|\.$/g, "");
      const spellingReference = reference(caseKept);
      if (
        !same(
          boundaries(effective.words),
          boundaries(spellingReference.words),
        ) ||
        !same(warnings(effective.words), warnings(spellingReference.words))
      ) {
        reasons.push("orthography-normalization");
        counterfactuals.push({
          reason: "orthography-normalization",
          input: caseKept,
          reference: spellingReference,
        });
      }
      effective = reference(analysis.normalized);
      if (
        !same(
          boundaries(spellingReference.words),
          boundaries(effective.words),
        ) ||
        !same(warnings(spellingReference.words), warnings(effective.words))
      ) {
        reasons.push("author-headword-lowercasing");
        counterfactuals.push({
          reason: "author-headword-lowercasing",
          input: analysis.normalized,
          reference: effective,
        });
      }
    }
    const withHesitation = projectHesitationWords;
    if (effective.words.some((w) => w.kind === "hesitation"))
      reasons.push("hesitation-as-cmavo");
    if (withHesitation(effective).length !== effective.words.length)
      reasons.push("whole-hesitation-run");
    let explainedBoundary = same(
      boundaries(withHesitation(effective)),
      boundaries(actual),
    );
    const spaced =
      analysis.normalized === null
        ? null
        : fallingDiphthongSpacing(analysis.normalized, actual);
    let counterfactual: Reference | undefined;
    if (!explainedBoundary && spaced !== null) {
      counterfactual = reference(spaced);
      if (
        same(boundaries(withHesitation(counterfactual)), boundaries(actual))
      ) {
        explainedBoundary = true;
        reasons.push("falling-diphthong-cmavo-pause");
        effective = counterfactual;
      }
    }
    let explainedWarning = same(warnings(effective.words), warnings(actual));
    if (
      analysis.normalized === null &&
      analysis.diagnostics.some((d) => d.includes("characters outside Lojban"))
    ) {
      explainedBoundary = true;
      explainedWarning = true;
      reasons.push("orthography-outside-api-alphabet");
    }
    // Experimental q/w are marked glide letters. The project excludes them.
    // Require the reference to use the letter inside an accepted word token.
    const markedGlideTokens = ref.tokens.filter(
      (token) =>
        (token.tags.includes("Word") || token.tags.includes("Hesitation")) &&
        /[qw]/i.test(
          Array.from(input).slice(token.source[0], token.source[1]).join(""),
        ),
    );
    if (!actual.length && markedGlideTokens.length) {
      explainedBoundary = true;
      explainedWarning = true;
      reasons.push("orthography-marked-glide-letters");
      counterfactuals.push({
        reason: "orthography-marked-glide-letters",
        tokens: markedGlideTokens,
      });
    }
    const projectedAnalysis = (input: string): ProjectedAnalysis => {
      const result = analyze("extended-v4", input);
      return {
        normalized: result.normalized,
        words: (result.words ?? []).map((word) => ({
          text: word.text,
          kind: ["gismu", "lujvo", "fuhivla"].includes(word.kind)
            ? "brivla"
            : word.kind,
          warning: word.diagnostics.includes(warning),
        })),
      };
    };
    if (!explainedBoundary && actual.length === 0) {
      const proof = apostrophePauseProof(
        input,
        ref,
        projectedAnalysis,
        reference,
      );
      if (proof !== null) {
        explainedBoundary = true;
        explainedWarning = true;
        reasons.push("orthography-apostrophe-pause");
        if (proof.spacing !== null)
          reasons.push("falling-diphthong-cmavo-pause");
        counterfactuals.push({
          reason: "orthography-apostrophe-pause",
          ...proof,
        });
      }
    }
    if (!explainedBoundary && actual.length === 0) {
      // Normalization can close comma gaps within a pure-y run. Keep its reference
      // tokens and offsets paired with that exact normalized input.
      const proof =
        foreignRunProof(input, ref, projectedAnalysis) ??
        foreignRunProof(
          analysis.normalized ?? input,
          effective,
          projectedAnalysis,
        );
      if (proof !== null) {
        explainedBoundary = true;
        explainedWarning = true;
        reasons.push("reference-foreign-run-recovery");
        counterfactuals.push({
          reason: "reference-foreign-run-recovery",
          ...proof,
        });
      }
    }
    if (!explainedBoundary) reasons.push("unclassified-boundaries-or-classes");
    if (!explainedWarning) {
      reasons.push("unclassified-cgv-warning");
      unclassifiedWarningDifferences++;
    }
    if (!explainedBoundary || !explainedWarning) {
      unclassifiedDifferences++;
      stats.unclassifiedDifferences++;
    }
    for (const reason of reasons) counts[reason] = (counts[reason] ?? 0) + 1;
    const mismatch = {
      index,
      ...entry,
      normalized: analysis.normalized,
      boundaryDiff,
      warningDiff,
      reasons,
      reference: ref,
      actual,
      diagnostics: analysis.diagnostics,
      ...(counterfactual
        ? { counterfactualInput: spaced, counterfactual }
        : {}),
      counterfactuals,
    };
    mismatches.push(mismatch);
    appendFileSync(
      join(out, "mismatches.jsonl"),
      JSON.stringify(mismatch) + "\n",
    );
  }
  writeFileSync(
    join(out, "resource-scope-differences.json"),
    JSON.stringify(resourceScopeDifferences, null, 2) + "\n",
  );
  writeFileSync(
    join(out, "mismatches.json"),
    JSON.stringify(mismatches, null, 2) + "\n",
  );
  writeFileSync(
    join(out, "false-warning-headwords.json"),
    JSON.stringify(baselineFalseWarnings, null, 2) + "\n",
  );
  const summary = {
    scope:
      "Diagnostic comparison of the headword API with the gencmu forms stage. This is not the full corpus parity test.",
    classificationMeaning:
      "Classifications describe observed differences. They do not approve exceptions to the corpus requirements.",
    fullCorpusParityTested: false,
    classificationComplete: unclassifiedDifferences === 0,
    rawComparableMatches:
      inputs.length - resourceScopeDifferences.length - mismatches.length,
    classifiedDifferenceCount: mismatches.length - unclassifiedDifferences,
    reference: {
      revision,
      dialect: "experimental",
      stage: "forms",
      grammarDirectory,
      bundledHashes,
      packageVersion: JSON.parse(
        readFileSync(join(root, "lib/js/package.json"), "utf8"),
      ).version,
      sourceHashes,
    },
    implementation: {
      revision: git(process.cwd(), "rev-parse", "HEAD"),
      sourceHashes: implementationHashes,
    },
    node: process.version,
    toolVersions: JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ).devDependencies,
    cacheEvidence,
    scriptSha256,
    dictionary: {
      count: dictionary.length,
      sha256: digest(dictionaryBytes),
      provenance: dictionaryProvenance,
    },
    seed,
    drawsPerDistribution: draws,
    randomCount: primaryRandom.length,
    supplementalSeed,
    supplementalDrawsPerDistribution: 500,
    supplementalRandomCount: supplementalRandom.length,
    totalRandomCount: primaryRandom.length + supplementalRandom.length,
    resourceScopeDifferenceCount: resourceScopeDifferences.length,
    inputCount: inputs.length,
    inputsSha256: digest(readFileSync(join(out, "inputs.json"))),
    resultsSha256: digest(readFileSync(resultsFile)),
    bySource,
    rawBoundaryDifferences,
    rawWarningDifferences,
    mismatchCount: mismatches.length,
    unclassifiedDifferences,
    unclassifiedWarningDifferences,
    baselineFalseWarningCount: baselineFalseWarnings.length,
    counts,
    cpuMicroseconds: process.cpuUsage(started),
    resourceUsage: process.resourceUsage(),
  };
  writeFileSync(
    join(out, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        fullCorpusParityTested: false,
        classificationComplete: unclassifiedDifferences === 0,
        inputCount: inputs.length,
        resourceScopeDifferenceCount: resourceScopeDifferences.length,
        rawComparableMatches:
          inputs.length - resourceScopeDifferences.length - mismatches.length,
        mismatchCount: mismatches.length,
        unclassifiedDifferences,
        counts,
        unclassifiedWarningDifferences,
        falseWarningHeadwords: baselineFalseWarnings.length,
      },
      null,
      2,
    ),
  );
  process.exitCode = unclassifiedDifferences ? 1 : 0;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
