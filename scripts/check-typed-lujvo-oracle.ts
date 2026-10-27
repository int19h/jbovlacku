/** Compare exact typed lujvo with an explicitly supplied, read-only gencmu checkout. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  detectWord,
  typedLujvoState,
  typedLujvoRequest,
} from "../apps/web/src/model/typed-headword.ts";
import { buildLujvo, initializeCore } from "../packages/core/src/index.ts";

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
  "sakli'ybroda",
  "gismu'ybroda",
  "ixla'ybroda",
  "uspi'ybe'a",
  "baibla'ykla",
  "bai'ybla'ykla",
  "saibla'ykla",
  "islenskygu'e",
  "islenskybroda",
  "ibalskybroda",
  "kerlyxambrga",
  "cuktybangrtai",
  "bangu'ybangrtai",
];
const negatives = [
  "bla'ykla",
  "bla'ykuiska",
  "kla'ykuiska",
  "bla'ytcuiska",
  "spagetiybroda",
  "spagekuykla",
  "balskybroda",
  "lenskybroda",
  "tenskybroda",
  "bangrybroda",
  "barklysakli",
  "balskykla",
];
const otherWords = [
  "kamzi",
  "bamzda",
  ".djeimz.",
  "bangrtai",
  "xambrga",
  "cmagnitude",
  "depsnce",
  "regnaftngi",
  "sparnribia",
];
const cases = [];
for (const word of [...positives, ...negatives, ...otherWords]) {
  const result = dialect.parse(word, { until: "forms" });
  const forms = result.stages.find((stage: any) => stage.name === "forms");
  const tokens = forms?.output ?? [];
  const tags = tokens.map((token: any) => [...token.tags].sort());
  const lexical = tokens.filter((token: any) => !token.tags.has("PAUSE"));
  const single = lexical.length === 1 && !lexical[0].tags.has("FOREIGN");
  let rule: string | null = null;
  function visit(node: any) {
    if (
      node?.rule === "brivla-word" &&
      node.source[0] === lexical[0]?.source[0] &&
      node.source[1] === lexical[0]?.source[1]
    )
      rule =
        node.children.find((child: any) =>
          ["gismu", "lujvo", "fuhivla"].includes(child.rule),
        )?.rule ?? null;
    for (const child of node?.children ?? []) visit(child);
  }
  if (single) visit(forms.tree);
  const kind = !single
    ? "unknown"
    : (rule ??
      (lexical[0].tags.has("CMEVLA")
        ? "cmevla"
        : lexical[0].tags.has("Cmavo")
          ? "cmavo"
          : "unknown"));
  const analysis = detectWord(word);
  let rebuilt: string | null = null;
  if (positives.includes(word)) {
    assert.equal(kind, "lujvo", `Oracle does not read ${word} as one lujvo`);
    assert.equal(analysis.kind, "lujvo", word);
    const reading = analysis.readings[0];
    const built = buildLujvo(
      typedLujvoRequest(typedLujvoState(word, reading, null)),
    );
    assert.equal(built.candidates.length, 1, word);
    rebuilt = built.candidates[0].spelling;
    assert.equal(rebuilt, word);
    assert.equal(built.candidates[0].tokens.join(""), word);
  } else if (negatives.includes(word)) {
    assert.equal(kind, "unknown", word);
    assert.equal(analysis.kind, "unknown", word);
  }
  assert.equal(analysis.kind, kind, word);
  cases.push({
    word,
    oracle_tags: tags,
    kind,
    tree_rule: rule,
    rebuilt,
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
  criterion:
    "One lexical token, optional PAUSE tokens, exact brivla-word tree child",
  sources,
  cases,
};
await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(
  `${positives.length} lujvo reproduced, ${negatives.length} negatives refused, ${otherWords.length} other words classified.`,
);
