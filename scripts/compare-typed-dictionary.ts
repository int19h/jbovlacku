/** Compare independently classified dictionary words through the typed authoring model. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { buildLujvo, initializeCore } from "../packages/core/src/index.ts";
import {
  detectWord,
  typedLujvoRequest,
  typedLujvoState,
} from "../apps/web/src/model/typed-headword.ts";

const [input, output] = process.argv.slice(2);
if (!input || !output)
  throw new Error("Supply the independent oracle JSON and a new report path.");
const bytes = await readFile(input);
const rows: {
  word: string;
  kind: string;
  tree_rule?: string;
  single_word?: boolean;
}[] = JSON.parse(bytes.toString());
await initializeCore(
  await readFile(
    new URL("../packages/core/generated/jvc_runtime_bg.wasm", import.meta.url),
  ),
);
const mismatches: unknown[] = [],
  reconstructionFailures: unknown[] = [];
const expectedCounts: Record<string, number> = {},
  actualCounts: Record<string, number> = {};
let rebuilt = 0,
  expectedBrivla = 0,
  matchedBrivla = 0;
for (const row of rows) {
  const expected = row.kind === "other" ? "unknown" : row.kind;
  const analysis = detectWord(row.word);
  expectedCounts[expected] = (expectedCounts[expected] ?? 0) + 1;
  actualCounts[analysis.kind] = (actualCounts[analysis.kind] ?? 0) + 1;
  const brivla = ["gismu", "lujvo", "fuhivla"].includes(expected);
  if (brivla) expectedBrivla++;
  if (analysis.kind !== expected)
    mismatches.push({
      word: row.word,
      expected,
      actual: analysis.kind,
      tree_rule: row.tree_rule,
      diagnostics: analysis.diagnostics,
    });
  else if (brivla) matchedBrivla++;
  if (analysis.kind !== "lujvo") continue;
  try {
    const state = typedLujvoState(row.word, analysis.readings[0], null);
    if (state.components.some((part) => part.spelling))
      throw new Error("Unresolved source acquired attribution.");
    const result = buildLujvo(typedLujvoRequest(state));
    const candidate =
      result.candidates.length === 1 &&
      result.candidates.find(
        (candidate) =>
          candidate.spelling === row.word &&
          candidate.tokens.join("") === row.word,
      );
    if (!candidate)
      reconstructionFailures.push({
        word: row.word,
        rows: result.rows,
        diagnostics: result.diagnostics,
      });
    else rebuilt++;
  } catch (error) {
    reconstructionFailures.push({ word: row.word, error: String(error) });
  }
}
const report = {
  comparator_sha256: createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex"),
  typed_model_sha256: createHash("sha256")
    .update(
      await readFile(
        new URL("../apps/web/src/model/typed-headword.ts", import.meta.url),
      ),
    )
    .digest("hex"),
  oracle_sha256: createHash("sha256").update(bytes).digest("hex"),
  words: rows.length,
  expectedCounts,
  actualCounts,
  expectedBrivla,
  matchedBrivla,
  rebuilt,
  mismatches,
  reconstructionFailures,
};
await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(
  JSON.stringify({
    words: rows.length,
    expectedBrivla,
    matchedBrivla,
    rebuilt,
    mismatches: mismatches.length,
    reconstructionFailures: reconstructionFailures.length,
  }),
);
