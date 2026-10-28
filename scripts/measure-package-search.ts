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
import type { SearchEntry } from "../packages/service/src/packages.ts";
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
      "server lexicalSearch after materialization, with eligibility filtering and word grouping",
    entries: entries.length,
    input_sha256: createHash("sha256").update(bytes).digest("hex"),
    corrected_classifications: corrected,
  }),
);
for (const [label, rows] of [
  ["cold", entries],
  ["warm", entries],
  ["new snapshot objects", structuredClone(entries)],
] as const) {
  const metrics = searchMetrics();
  const start = process.cpuUsage();
  const hits = lexicalSearch(rows, "klama", "en", evaluation, false, metrics);
  console.log(
    JSON.stringify({
      label,
      hits: hits.length,
      cpu_us: process.cpuUsage(start),
      metrics,
      rss_bytes: process.memoryUsage().rss,
    }),
  );
}
