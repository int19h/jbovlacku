/** Compare exact typed lujvo with an explicitly supplied, read-only gencmu checkout. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  analyzeWord,
  buildLujvo,
  initializeCore,
} from "../packages/core/src/index.ts";

const reference = process.argv[2];
const output = process.argv[3];
if (!reference || !output)
  throw new Error("Supply the gencmu checkout and a new report file.");
const { loadDialect } = await import(
  pathToFileURL(resolve(reference, "lib/js/src/node.js")).href
);
const dialect = loadDialect("experimental");
await initializeCore(
  await readFile(
    new URL("../packages/core/generated/jvc_runtime_bg.wasm", import.meta.url),
  ),
);
const positives = [
  "ckusni",
  "cuktysinxa",
  "sairzba",
  "bangu'y'ismu",
  "sakrsakysakli",
  "spageti'ybroda",
  "spageti'ykla",
  "kerlybai'ybroda",
  "kerlybla'ykla",
  "klama'ybroda",
  "spageiybroda",
  "aktyiismu",
  "kerlyfa'u'yiismu",
];
const negatives = [
  "bla'ykla",
  "bla'ykuiska",
  "kla'ykuiska",
  "bla'ytcuiska",
  "spagetiybroda",
  "spagekuykla",
];
const decisions = ["kamzi", "bamzda", ".djeimz."];
const cases = [];
for (const word of [...positives, ...negatives, ...decisions]) {
  const result = dialect.parse(word, { until: "forms" });
  const tokens =
    result.stages.find((stage: any) => stage.name === "forms")?.output ?? [];
  const tags = tokens.map((token: any) => [...token.tags].sort());
  const brivla =
    tokens.length === 1 &&
    tags[0].includes("BRIVLA") &&
    !tags[0].includes("FOREIGN");
  const analysis = analyzeWord("extended", word);
  let rebuilt: string | null = null;
  if (positives.includes(word)) {
    assert.equal(brivla, true, `Oracle does not read ${word} as one BRIVLA`);
    assert.equal(analysis.kind, "lujvo", word);
    const reading = analysis.readings[0];
    const built = buildLujvo({
      profile: "extended",
      joins: reading.slice(1).map((part) => part.join_before ?? ""),
      components: reading.map((part, index) => ({
        id: String(index),
        spelling: part.text,
        kind: "other",
        locked: part.text,
      })),
    });
    assert.equal(built.candidates.length, 1, word);
    rebuilt = built.candidates[0].spelling;
    assert.equal(rebuilt, word);
    assert.equal(built.candidates[0].tokens.join(""), word);
  } else if (negatives.includes(word)) {
    assert.equal(brivla, false, word);
    assert.equal(analysis.kind, "unknown", word);
  }
  cases.push({
    word,
    oracle_tags: tags,
    kind: analysis.kind,
    rebuilt,
    decision: decisions.includes(word)
      ? "The mz pair remains forbidden here."
      : null,
  });
}
const sources = {} as Record<string, string>;
for (const file of [
  "grammars/dialects/experimental.md",
  "grammars/words/experimental.md",
  "grammars/words/bpfk.md",
  "grammars/words/forms.md",
  "grammars/words/shapes.md",
])
  sources[file] = createHash("sha256")
    .update(await readFile(resolve(reference, file)))
    .digest("hex");
const report = {
  reference: "https://github.com/int19h/gencmu",
  revision: execFileSync("git", ["-C", reference, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  dialect: "experimental",
  stage: "forms",
  criterion: "Exactly one BRIVLA token with no FOREIGN tag",
  sources,
  cases,
};
await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(
  `${positives.length} lujvo reproduced, ${negatives.length} negatives refused, ${decisions.length} mz decisions recorded.`,
);
