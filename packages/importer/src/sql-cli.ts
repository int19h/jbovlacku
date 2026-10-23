import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { initializeCore } from "../../core/src/index.ts";
import type { ImportOptions } from "./index.ts";
import { parseProtocolJson } from "./storage.ts";
import { importSqlSnapshot } from "./sql.ts";

async function main() {
  const args = process.argv.slice(2);
  const flags = new Map<string, string>();
  let sign = false;
  let checkExisting = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--sign" && !sign) {
      sign = true;
      continue;
    }
    if (args[i] === "--check-existing" && !checkExisting) {
      checkExisting = true;
      continue;
    }
    if (
      !["--source", "--manifest", "--seed", "--roots", "--output"].includes(
        args[i],
      ) ||
      flags.has(args[i]) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    )
      throw new Error(
        "The SQL import command contains an unknown, duplicate, or incomplete flag.",
      );
    flags.set(args[i], args[++i]);
  }
  for (const flag of [
    "--source",
    "--manifest",
    "--seed",
    "--roots",
    "--output",
  ])
    if (!flags.has(flag))
      throw new Error(`The SQL import command requires ${flag}.`);
  if (!sign && !checkExisting)
    throw new Error(
      "This command signs a local proposal. Add --sign to use the supplied disposable seed.",
    );
  const output = resolve(flags.get("--output")!);
  const seedPath = resolve(flags.get("--seed")!);
  if (seedPath === output || seedPath.startsWith(`${output}${sep}`))
    throw new Error(
      "Keep the disposable seed outside the SQL output directory.",
    );
  await initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  );
  const seedText = (await readFile(seedPath, "utf8")).trim();
  if (!/^[0-9a-f]{64}$/.test(seedText))
    throw new Error(
      "The disposable seed file must contain 64 lowercase hexadecimal digits.",
    );
  const roots = parseProtocolJson<ImportOptions["roots"]>(
    await readFile(flags.get("--roots")!),
  );
  const started = performance.now();
  const result = await importSqlSnapshot({
    sourcePath: flags.get("--source")!,
    manifestPath: flags.get("--manifest")!,
    output,
    seed: Buffer.from(seedText, "hex"),
    roots,
    checkExisting,
    estimate: (estimate) =>
      process.stderr.write(
        JSON.stringify({ stage: "before-signing", ...estimate }) + "\n",
      ),
    measurement: (measurement) =>
      process.stderr.write(
        JSON.stringify({ stage: "after-export", ...measurement }) + "\n",
      ),
  });
  process.stdout.write(
    JSON.stringify({
      ...result,
      elapsed_seconds: (performance.now() - started) / 1000,
    }) + "\n",
  );
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});
