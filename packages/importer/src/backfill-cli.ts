import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { initializeCore } from "../../core/src/index.ts";
import { backfillVerifiedRecords } from "../../service/src/verified-records.ts";
import {
  FileObjectStore,
  SqliteCoordinator,
} from "../../../apps/server/src/storage.ts";
import { lockDataDirectory } from "./load-lock.ts";

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length !== 2 ||
    args[0] !== "--data" ||
    !args[1] ||
    args[1].startsWith("--")
  )
    throw new Error("The backfill command requires --data DIRECTORY.");
  await initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  );
  const directory = resolve(args[1]);
  if (!(await stat(directory)).isDirectory())
    throw new Error("The backfill data directory must already exist.");
  if (!(await stat(join(directory, "coordinator.sqlite"))).isFile())
    throw new Error("The backfill coordinator database must already exist.");
  const release = await lockDataDirectory(
    directory,
    "verified-record-backfill",
  );
  let coordinator: SqliteCoordinator | undefined;
  try {
    coordinator = new SqliteCoordinator(join(directory, "coordinator.sqlite"));
    const records = await backfillVerifiedRecords(
      coordinator,
      new FileObjectStore(join(directory, "objects")),
    );
    process.stdout.write(JSON.stringify({ records }) + "\n");
  } finally {
    coordinator?.close();
    await release();
  }
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});
