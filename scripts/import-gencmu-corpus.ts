/** Import pinned experimental corpus cases. The reference checkout is read only. */
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
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const revision = "0b3da7d2ec2f727a6730d77c775f88214a7ffc89";
const magic = new Set([
  "zo",
  "zoi",
  "la'o",
  "lo'u",
  "le'u",
  "zei",
  "sa",
  "su",
  "si",
  "bu",
]);
const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
type Token = {
  value: string;
  image: string;
  text: string;
  tags: Set<string>;
  source: [number, number];
};
type StoredToken = {
  value: string;
  image: string;
  tags: string[];
  source: [number, number];
  kind: string;
};
const storeToken = (token: Token): StoredToken => ({
  value: token.value,
  image: token.image,
  tags: [...token.tags].sort(),
  source: token.source,
  kind: token.tags.has("Hesitation")
    ? "hesitation"
    : token.tags.has("Cmavo")
      ? "cmavo"
      : token.tags.has("BRIVLA")
        ? "brivla"
        : token.tags.has("CMEVLA")
          ? "cmevla"
          : token.tags.has("FOREIGN")
            ? "foreign"
            : "other",
});

const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  console.log(
    "Usage: node --import tsx scripts/import-gencmu-corpus.ts --gencmu CHECKOUT --out EMPTY_DIR [--resume true]\nThe importer preserves every experimental case, its options, recorded words, and reference classes. Output is corpus.json and a resumable reference-cases.jsonl ledger.",
  );
  process.exit(0);
}
const args = new Map<string, string>();
for (let i = 0; i < argv.length; i += 2) {
  if (!["--gencmu", "--out", "--resume"].includes(argv[i]) || !argv[i + 1])
    throw new Error("Use a known option and its value.");
  args.set(argv[i], argv[i + 1]);
}
const required = (key: string) => {
  const value = args.get(key);
  if (!value) throw new Error(`Missing ${key}.`);
  return resolve(value);
};
if (args.has("--resume") && args.get("--resume") !== "true")
  throw new Error("Use --resume true to continue a saved reference ledger.");
const root = required("--gencmu");
const out = required("--out");
const git = (...values: string[]) =>
  execFileSync("git", ["-C", root, ...values], { encoding: "utf8" }).trim();
if (
  git("rev-parse", "HEAD") !== revision ||
  git("status", "--porcelain", "--untracked-files=no")
)
  throw new Error("Use the clean pinned reference checkout.");
if (existsSync(out) && readdirSync(out).length && !args.has("--resume"))
  throw new Error(
    "Keep earlier evidence. Choose an empty output directory or use --resume true.",
  );
mkdirSync(out, { recursive: true });
const sourceFiles: Record<string, string> = {};
const rows: { file: string; line: number; original: Record<string, any> }[] =
  [];
for (const name of readdirSync(join(root, "tests/corpus"))
  .filter((name) => name.endsWith(".jsonl"))
  .sort()) {
  const relative = `tests/corpus/${name}`;
  const bytes = readFileSync(join(root, relative));
  const cases = bytes
    .toString("utf8")
    .split(/\r?\n/)
    .map((line, index) =>
      line.trim()
        ? { original: JSON.parse(line), line: index + 1, file: relative }
        : null,
    )
    .filter((row) => row?.original.dialect === "experimental") as typeof rows;
  if (cases.length) {
    sourceFiles[relative] = hash(bytes);
    rows.push(...cases);
  }
}
for (const name of [
  "tests/README.md",
  "LICENSE",
  ...git(
    "ls-files",
    "grammars",
    "lib/js/src",
    "lib/js/grammars",
    "lib/js/package.json",
  ).split("\n"),
])
  sourceFiles[name] = hash(readFileSync(join(root, name)));
const sourceDigest = hash(JSON.stringify(sourceFiles));
const manifest = {
  revision,
  dialect: "experimental",
  sourceFiles,
  sourceDigest,
  caseCount: rows.length,
  recordedWordsCount: rows.filter((row) => Object.hasOwn(row.original, "words"))
    .length,
  magicWords: [...magic, "pure-y hesitation"],
  tool: {
    node: process.version,
    package: JSON.parse(readFileSync(join(root, "lib/js/package.json"), "utf8"))
      .version,
  },
};
const manifestFile = join(out, "manifest.json");
if (
  args.has("--resume") &&
  !same(JSON.parse(readFileSync(manifestFile, "utf8")), manifest)
)
  throw new Error(
    "The resume manifest differs from the current reference sources.",
  );
writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
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
const ledger = join(out, "reference-cases.jsonl");
const completed: any[] =
  args.has("--resume") && existsSync(ledger)
    ? readFileSync(ledger, "utf8")
        .split(/\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
for (let i = 0; i < completed.length; i++)
  if (
    completed[i].id !== rows[i].original.id ||
    completed[i].file !== rows[i].file ||
    completed[i].line !== rows[i].line
  )
    throw new Error("The resume case order differs.");
if (!completed.length) writeFileSync(ledger, "");
const { loadDialect } = await import(
  pathToFileURL(join(root, "lib/js/src/node.js")).href
);
const dialect = loadDialect("experimental");
const resumedCaseCount = completed.length;
const cpu = process.cpuUsage();
for (let i = completed.length; i < rows.length; i++) {
  const { file, line, original } = rows[i];
  if (i % 100 === 0 || Buffer.byteLength(original.text) > 128)
    console.error(
      `Case ${i + 1}/${rows.length}: ${original.id} (${Buffer.byteLength(original.text)} bytes)`,
    );
  const options = {
    ...(original.features ? { features: original.features } : {}),
    ...(original.withoutFeatures
      ? { withoutFeatures: original.withoutFeatures }
      : {}),
    until: Object.hasOwn(original, "words") ? "words" : "forms",
  };
  const result = dialect.parse(original.text, options);
  const forms: StoredToken[] = (
    result.stages.find((stage: any) => stage.name === "forms")?.output ?? []
  ).map(storeToken);
  const words: StoredToken[] | null =
    result.stages
      .find((stage: any) => stage.name === "words")
      ?.output?.map(storeToken) ?? null;
  const recorded = Object.hasOwn(original, "words");
  const referenceMismatch =
    recorded &&
    !same(
      original.words,
      words?.map((token) => token.image),
    );
  const triggers = forms
    .filter(
      (token) =>
        (token.tags.includes("Word") && magic.has(token.value.toLowerCase())) ||
        (token.kind === "hesitation" && /^y+$/i.test(token.value)),
    )
    .map((token) => ({
      value: token.value,
      source: token.source,
      reason:
        token.kind === "hesitation"
          ? "A pure y run is an ordinary cmavo in this project."
          : `${token.value} is an ordinary cmavo in this project. Its word operation does not apply.`,
    }));
  const reference = recorded
    ? (words ?? [])
    : forms.filter((token) => token.kind !== "other");
  // Both expectations stay in the fixture. A replacement is explicit and local
  // to this case. Unlisted word operations remain visible in referenceWords.
  const candidateReplacement = forms
    .filter((token) => token.kind !== "other")
    .map((token) =>
      token.kind === "hesitation" && /^y+$/i.test(token.value)
        ? { ...token, kind: "cmavo" }
        : token,
    );
  const replaced =
    triggers.length > 0 && !same(reference, candidateReplacement);
  const row = {
    id: original.id,
    file,
    line,
    text: original.text,
    options,
    original,
    referenceForms: forms,
    referenceWords: words,
    referenceSource: recorded
      ? "recorded-words-with-reference-token-classes"
      : "direct-forms",
    referenceMismatch,
    replacements: replaced
      ? {
          triggers,
          originalExpectation: reference,
          proposedExpectation: candidateReplacement,
          status: "requires-scope-audit",
        }
      : null,
    expected: replaced ? candidateReplacement : reference,
  };
  completed.push(row);
  appendFileSync(ledger, JSON.stringify(row) + "\n");
}
const evidence = { source: manifest, cases: completed };
writeFileSync(
  join(out, "corpus.json"),
  JSON.stringify(evidence, null, 2) + "\n",
);
const summary = {
  cases: completed.length,
  recordedWords: completed.filter((row) =>
    row.referenceSource.startsWith("recorded"),
  ).length,
  directForms: completed.filter((row) => row.referenceSource === "direct-forms")
    .length,
  proposedReplacements: completed.filter((row) => row.replacements).length,
  referenceMismatches: completed
    .filter((row) => row.referenceMismatch)
    .map((row) => row.id),
  cpuMicroseconds: process.cpuUsage(cpu),
  resourceUsage: process.resourceUsage(),
  corpusSha256: hash(readFileSync(join(out, "corpus.json"))),
};
writeFileSync(
  join(out, resumedCaseCount ? "resume-summary.json" : "summary.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.referenceMismatches.length ? 1 : 0;

// Keep the offline fixture smaller than the complete reference ledger. Its
// token classes and coordinates still come only from the reference parser.
const operationTags = new Set([
  "ZO",
  "ZOI",
  "ZOhOI",
  "MEhOI",
  "GOhOI",
  "MUhOI",
  "DOhOI",
  "LOhU",
  "LEhU",
  "FAhO",
  "BU",
  "ZEI",
  "ZEhEI",
  "SI",
  "SA",
  "SU",
  "SUhUhUhUhUhUhUhU",
  "LOhAI",
  "LEhAI",
  "SAhAI",
]);
const coordinate = (text: string, point: number) =>
  Array.from(text).slice(0, point).join("").length;
const project = (
  text: string,
  tokens: StoredToken[],
  ordinary: boolean,
  allForms: StoredToken[],
) => {
  const words: {
    text: string;
    kind: string;
    start: number;
    end: number;
    classEvidence: string[];
    cgvWarning: boolean;
  }[] = [];
  const foreign: { text: string; start: number; end: number }[] = [];
  let adjacentY = false;
  for (const token of tokens) {
    if (token.tags.includes("PAUSE")) {
      adjacentY = false;
      continue;
    }
    const start = coordinate(text, token.source[0]);
    const end = coordinate(text, token.source[1]);
    if (token.kind === "foreign") {
      foreign.push({ text: text.slice(start, end), start, end });
      adjacentY = false;
      continue;
    }
    if (!["cmavo", "brivla", "cmevla", "hesitation"].includes(token.kind)) {
      adjacentY = false;
      continue;
    }
    const pureY = token.kind === "hesitation" && /^y+$/i.test(token.value);
    if (ordinary && pureY && adjacentY) {
      words.at(-1)!.text += token.value.toLowerCase();
      words.at(-1)!.end = end;
    } else {
      words.push({
        text: token.value.toLowerCase(),
        kind: ordinary && token.kind === "hesitation" ? "cmavo" : token.kind,
        start,
        end,
        cgvWarning:
          token.tags.includes("Cgv-Warning") ||
          allForms.some(
            (form) =>
              form.source[0] === token.source[0] &&
              form.source[1] === token.source[1] &&
              form.value === token.value &&
              form.kind === token.kind &&
              form.tags.includes("Cgv-Warning"),
          ),
        classEvidence: token.tags.filter((tag) =>
          ["Cmavo", "BRIVLA", "CMEVLA", "Hesitation"].includes(tag),
        ),
      });
    }
    adjacentY = ordinary && pureY;
  }
  return { words, foreign };
};
const equalProjection = (
  a: ReturnType<typeof project>,
  b: ReturnType<typeof project>,
) =>
  same(
    {
      words: a.words.map(({ classEvidence, ...word }) => word),
      foreign: a.foreign,
    },
    {
      words: b.words.map(({ classEvidence, ...word }) => word),
      foreign: b.foreign,
    },
  );
const fixtureCases = completed.map((row) => {
  const reference = project(
    row.text,
    row.referenceSource.startsWith("recorded")
      ? (row.referenceWords ?? [])
      : row.referenceForms,
    false,
    row.referenceForms,
  );
  const ordinary = project(
    row.text,
    row.referenceForms,
    true,
    row.referenceForms,
  );
  const triggers = row.referenceForms.filter(
    (token: StoredToken) =>
      (magic.has(token.value.toLowerCase()) && token.kind === "cmavo") ||
      (token.kind === "hesitation" && /^y+$/i.test(token.value)),
  );
  const unlisted = row.referenceForms.filter(
    (token: StoredToken) =>
      !magic.has(token.value.toLowerCase()) &&
      ((token.kind === "hesitation" && !/^y+$/i.test(token.value)) ||
        token.tags.some((tag) => operationTags.has(tag)) ||
        ["lo'ai", "sa'ai", "le'ai"].includes(token.value.toLowerCase())),
  );
  const changed = !equalProjection(reference, ordinary);
  const allowed = changed && triggers.length > 0 && unlisted.length === 0;
  const knownDiphthong = row.id === "i212.r8.ieho.quote-gap";
  let expected = allowed ? ordinary : reference;
  if (knownDiphthong)
    expected = {
      words: [
        {
          text: "zoi",
          kind: "cmavo",
          start: 0,
          end: 3,
          classEvidence: ["Cmavo"],
          cgvWarning: false,
        },
        {
          text: "e'o",
          kind: "cmavo",
          start: 3,
          end: 6,
          classEvidence: ["Cmavo"],
          cgvWarning: false,
        },
        {
          text: "mi",
          kind: "cmavo",
          start: 7,
          end: 9,
          classEvidence: ["Cmavo"],
          cgvWarning: false,
        },
      ],
      foreign: [],
    };
  return {
    id: row.id,
    file: row.file,
    line: row.line,
    text: row.text,
    features: row.options.features ?? [],
    withoutFeatures: row.options.withoutFeatures ?? [],
    referenceSource: row.referenceSource,
    ...(row.original.words ? { recordedWords: row.original.words } : {}),
    reference,
    ordinaryForms: ordinary,
    expected,
    replacements:
      allowed || knownDiphthong
        ? {
            reason: knownDiphthong
              ? "The approved falling-diphthong preference reads zoi + e'o + mi. ZOI has no quotation operation in this project."
              : "Each listed magic word is an ordinary cmavo. Its word operation does not apply. Surrounding text uses the independently parsed ordinary forms.",
            tokens: triggers.map((token: StoredToken) => ({
              text: token.value,
              source: token.source,
            })),
            originalExpectation: reference,
          }
        : null,
    unresolved:
      changed && !allowed && !knownDiphthong
        ? {
            reason:
              "The recorded WORDS expectation differs from ordinary forms through an operation outside the authorized magic-word list. The policy decision is pending.",
            operations: unlisted.map((token: StoredToken) => ({
              text: token.value,
              tags: token.tags,
              source: token.source,
            })),
          }
        : null,
  };
});
const fixture = {
  source: manifest,
  policy: {
    allowedMagicWords: [...magic, "pure-y hesitation"],
    replacementRule:
      "Only cases whose changed expectation involves listed magic words and no unlisted operation receive a replacement. Other cases retain the recorded expectation and an unresolved finding.",
    explicitCaseOverrides: ["i212.r8.ieho.quote-gap"],
  },
  cases: fixtureCases,
};
writeFileSync(
  join(out, "fixture.json"),
  JSON.stringify({ source: fixture.source, policy: fixture.policy }).slice(
    0,
    -1,
  ) +
    ',\n"cases":[\n' +
    fixture.cases.map((row) => JSON.stringify(row)).join(",\n") +
    "\n]}\n",
);
writeFileSync(
  join(out, "fixture-summary.json"),
  JSON.stringify(
    {
      cases: fixtureCases.length,
      replacements: fixtureCases.filter((row) => row.replacements).length,
      unresolved: fixtureCases.filter((row) => row.unresolved).length,
    },
    null,
    2,
  ) + "\n",
);
