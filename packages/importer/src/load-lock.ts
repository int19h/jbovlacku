import { mkdir, readFile, writeFile, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { durableDirectory, syncDirectory } from "./storage.ts";

/** The Node server and offline loader share one exclusive data directory lock. */
export async function lockDataDirectory(directory: string, role: string) {
  await durableDirectory(directory);
  const path = join(directory, ".node-data-lock");
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "The data directory is locked. Stop its Node server or loader. Settle a stale .node-data-lock before another run.",
      );
    throw error;
  }
  const ownerPath = join(path, "owner.json");
  const owner = JSON.stringify({ token: randomUUID(), pid: process.pid, role });
  try {
    await writeFile(ownerPath, owner, { flag: "wx", mode: 0o600, flush: true });
    await syncDirectory(path);
    await syncDirectory(directory);
  } catch (error) {
    await unlink(ownerPath).catch(() => {});
    await rmdir(path);
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    if ((await readFile(ownerPath, "utf8")) !== owner)
      throw new Error(
        "The data directory lock owner changed. Keep the lock for inspection.",
      );
    await unlink(ownerPath);
    await rmdir(path);
    await syncDirectory(directory);
    released = true;
  };
}
