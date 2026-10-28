import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initializeCore } from "../../core/src/index.ts";
import { loadImportProposal } from "./load.ts";
import { stateTraversalLimit } from "./load-config.ts";

async function main() {
  const args = process.argv.slice(2);
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    if (
      !["--proposal", "--data", "--state-traversal-limit"].includes(args[i]) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--") ||
      flags.has(args[i])
    )
      throw new Error(
        "The load command contains an unknown, duplicate, or incomplete flag.",
      );
    flags.set(args[i], args[++i]);
  }
  for (const required of ["--proposal", "--data"])
    if (!flags.has(required))
      throw new Error(`The load command requires ${required}.`);
  await initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  );
  const result = await loadImportProposal({
    proposal: resolve(flags.get("--proposal")!),
    directory: resolve(flags.get("--data")!),
    stateTraversalLimit: stateTraversalLimit(
      flags.get("--state-traversal-limit"),
    ),
  });
  process.stdout.write(JSON.stringify(result) + "\n");
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});
