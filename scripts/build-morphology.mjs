import { readFile, writeFile } from "node:fs/promises";
import peggy from "peggy";

const grammar = new URL(
  "../packages/morphology/grammar/words.peggy",
  import.meta.url,
);
const output = new URL(
  "../packages/morphology/src/generated-parser.js",
  import.meta.url,
);
const header = await readFile(
  new URL("../packages/morphology/grammar/parser-header.txt", import.meta.url),
  "utf8",
);
const generated =
  header +
  peggy.generate(await readFile(grammar, "utf8"), {
    output: "source",
    format: "es",
    cache: true,
    trace: true,
    allowedStartRules: ["words"],
    grammarSource: "packages/morphology/grammar/words.peggy",
  });
if (process.argv.includes("--check")) {
  if ((await readFile(output, "utf8")) !== generated)
    throw new Error(
      "The generated morphology parser differs. Run npm run build:morphology.",
    );
} else {
  await writeFile(output, generated);
}
