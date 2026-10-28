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
    head:
      process.env.JVC_SEARCH_MEASURE_REVISION ??
      execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    boundary:
      "server lexicalSearch on completed buildPackages output, with eligibility filtering and word grouping; index preparation availability is reported separately",
    entries: entries.length,
    input_sha256: createHash("sha256").update(bytes).digest("hex"),
    corrected_classifications: corrected,
    normalized_sha256: createHash("sha256")
      .update(JSON.stringify(entries))
      .digest("hex"),
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
  const changed = label === "new completed snapshot";
  if (changed) {
    source[0].event = "jve1:" + "0".repeat(63) + "1";
    source[0].body = "sha256:" + "1".repeat(64);
    source[0].plain_text += " Synthetic package revision.";
    evaluation.publications[source[0].event] = {
      ...evaluation.publications[entries[0].event],
    };
    evaluation.receipts[source[0].event] = {
      interpretation: "effective",
      body: "present",
      reasons: [],
    };
  }
  const currentSnapshot = {
    ...snapshot,
    snapshot: "sha256:" + (changed ? "e" : "d").repeat(64),
  };
  const preparation = searchMetrics();
  let preparationStart: NodeJS.CpuUsage,
    preparationCpu: NodeJS.CpuUsage | undefined;
  const projected = records(source);
  let packageWrites = 0,
    packageBytes = 0;
  const buildStart = process.cpuUsage();
  const built = await buildPackages(
    currentSnapshot,
    {
      async get() {
        throw new Error("Trusted projections must not read original objects.");
      },
      async put(_hash, bytes) {
        packageWrites++;
        packageBytes += bytes.length;
      },
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
      snapshot: currentSnapshot.snapshot,
      synthetic_revised_definitions: changed ? 1 : 0,
      package_writes: packageWrites,
      package_bytes: packageBytes,
      boundary:
        "buildPackages from trusted synthetic projections of retained search entries, excluding authentication and evaluation",
      cpu_us: process.cpuUsage(buildStart),
      index_preparation_observed: preparationCpu !== undefined,
      index_preparation_cpu_us: preparationCpu ?? null,
      preparation: preparationCpu === undefined ? null : preparation,
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
        metrics: metrics.queryParses > 0 ? metrics : null,
        metrics_available: metrics.queryParses > 0,
        rss_bytes: process.memoryUsage().rss,
      }),
    );
  }
}
