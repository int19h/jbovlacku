/** Measure lexicalSearch after materialization, including filtering and grouping. */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  initializeCore,
  wordId,
  type Evaluation,
} from "../packages/core/src/index.ts";
import { searchMetrics } from "../packages/search/src/index.ts";
import { lexicalSearch } from "../packages/service/src/lexical-search.ts";
import {
  buildPackages,
  type PackageRecord,
  type SearchEntry,
} from "../packages/service/src/packages.ts";
const path = process.argv[2];
if (!path) throw new Error("Pass a JSON file with search entries.");
const bytes = await readFile(path);
const entries = JSON.parse(bytes.toString()) as SearchEntry[];
let corrected = 0;
for (const entry of entries) {
  const classification = entry.classification as { kind: string };
  if (classification.kind === "fuivla") {
    classification.kind = "fuhivla";
    corrected++;
  }
}
await initializeCore(
  await readFile(
    new URL("../packages/core/generated/jvc_runtime_bg.wasm", import.meta.url),
  ),
);
const evaluation = {
  publications: Object.fromEntries(
    entries.map((entry) => [
      entry.event,
      { word: wordId(entry.word), eligible: "eligible", status: "active" },
    ]),
  ),
  receipts: Object.fromEntries(
    entries.map((entry) => [entry.event, { interpretation: "effective" }]),
  ),
} as unknown as Evaluation;
console.log(
  JSON.stringify({
    head: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    boundary:
      "server lexicalSearch after actual package construction and index preparation, with eligibility filtering and word grouping",
    entries: entries.length,
    input_sha256: createHash("sha256").update(bytes).digest("hex"),
    corrected_classifications: corrected,
  }),
);
const records = (rows: SearchEntry[]): PackageRecord[] =>
  rows.map((entry) => ({
    id: entry.event,
    issuer: "ed25519:" + "0".repeat(64),
    kind: "definition.publish",
    word: evaluation.publications[entry.event].word,
    body_hash: entry.body,
    body: {
      word: entry.word,
      language: entry.language,
      glosses: entry.glosses,
      text: [[entry.plain_text]],
      classification: entry.classification,
      legacy: null,
      notes: [],
    },
    envelope_hash: "synthetic trusted projection",
    missing: false,
  }));
const snapshot = {
  snapshot: "sha256:" + "d".repeat(64),
  events: {},
  bodies: [],
  import_selections: [],
  logical_inventory: "sha256:" + "e".repeat(64),
  manifest: {},
} as any;
for (const [label, source] of [
  ["cold completed package", entries],
  ["new completed snapshot", structuredClone(entries)],
] as const) {
  const preparation = searchMetrics();
  let preparationStart: NodeJS.CpuUsage,
    preparationCpu: NodeJS.CpuUsage | undefined;
  const projected = records(source);
  const buildStart = process.cpuUsage();
  const built = await buildPackages(
    snapshot,
    {
      async get() {
        throw new Error("Trusted projections must not read original objects.");
      },
      async put() {},
    },
    projected,
    undefined,
    true,
    undefined,
    {
      metrics: preparation,
      start() {
        preparationStart = process.cpuUsage();
      },
      finish() {
        preparationCpu = process.cpuUsage(preparationStart);
      },
    },
  );
  console.log(
    JSON.stringify({
      label: label + " construction",
      boundary:
        "buildPackages from trusted synthetic projections of retained search entries, excluding authentication and evaluation",
      cpu_us: process.cpuUsage(buildStart),
      index_preparation_cpu_us: preparationCpu,
      preparation,
    }),
  );
  if (
    built.entries.length !== source.length ||
    built.entries.some(
      (entry, index) =>
        entry.word.spelling !== source[index].word.spelling ||
        entry.plain_text !== source[index].plain_text,
    )
  )
    throw new Error("Package construction changed retained entry content.");
  for (const temperature of ["first search", "warm search"]) {
    const rows = built.entries;
    const metrics = searchMetrics();
    const start = process.cpuUsage();
    const hits = lexicalSearch(rows, "klama", "en", evaluation, false, metrics);
    console.log(
      JSON.stringify({
        label: label + " " + temperature,
        hits: hits.length,
        cpu_us: process.cpuUsage(start),
        metrics,
        rss_bytes: process.memoryUsage().rss,
      }),
    );
  }
}
