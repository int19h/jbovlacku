import { readFile, mkdir, rmdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { initializeCore } from "../../core/src/index.ts";
import {
  importCapture,
  type CaptureManifest,
  type ImportOptions,
} from "./index.ts";
import {
  durableDirectory,
  parseProtocolJson,
  publishProposal,
  readJournal,
} from "./storage.ts";

async function main() {
  const args = process.argv.slice(2);
  const flags = new Map<string, string>();
  let sign = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--sign") {
      sign = true;
      continue;
    }
    if (
      !["--source", "--manifest", "--seed", "--roots", "--output"].includes(
        args[i],
      ) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--") ||
      flags.has(args[i])
    )
      throw new Error(
        "The import command contains an unknown, duplicate, or incomplete flag.",
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
      throw new Error(`The import command requires ${flag}.`);
  if (!sign)
    throw new Error(
      "This command signs a local proposal. Add --sign to authorize signing with the supplied disposable seed.",
    );
  const output = resolve(flags.get("--output")!);
  const sourcePath = resolve(flags.get("--source")!);
  const seedPath = resolve(flags.get("--seed")!);
  if (
    seedPath === join(output, "journal.json") ||
    seedPath.startsWith(`${output}/`)
  )
    throw new Error(
      "Keep the disposable seed outside the import output directory.",
    );
  await initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  );
  const manifest = parseProtocolJson<CaptureManifest>(
    await readFile(flags.get("--manifest")!),
  );
  const roots = parseProtocolJson<ImportOptions["roots"]>(
    await readFile(flags.get("--roots")!),
  );
  const seedText = (await readFile(seedPath, "utf8")).trim();
  if (!/^[0-9a-f]{64}$/.test(seedText))
    throw new Error(
      "The disposable seed file must contain 64 lowercase hexadecimal digits.",
    );
  await durableDirectory(output);
  const lock = join(output, ".import-lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "The output directory is locked. Settle the prior import before another run.",
      );
    throw error;
  }
  try {
    const journal = await readJournal(output);
    const sourceBytes = await readFile(sourcePath);
    const result = importCapture({
      sourceBytes,
      manifest,
      seed: Buffer.from(seedText, "hex"),
      roots,
      journal,
    });
    await publishProposal(output, sourceBytes, manifest, result);
    process.stdout.write(
      JSON.stringify({
        output,
        view: result.view.envelope.id,
        selection: result.selection.hash,
        ...result.report,
      }) + "\n",
    );
  } finally {
    await rmdir(lock);
  }
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});
