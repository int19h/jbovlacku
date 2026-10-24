import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteCoordinator } from "../../../apps/server/src/storage.ts";

test("backfill refuses missing directories and databases without creating them", async () => {
  const root = await mkdtemp(join(tmpdir(), "jvc-backfill-cli-"));
  const run = (path: string) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "packages/importer/src/backfill-cli.ts",
        "--data",
        path,
      ],
      { encoding: "utf8" },
    );
  try {
    const missing = join(root, "typo");
    assert.notEqual(run(missing).status, 0);
    await assert.rejects(stat(missing), { code: "ENOENT" });
    assert.notEqual(run(root).status, 0);
    assert.deepEqual(await readdir(root), []);
    const coordinator = new SqliteCoordinator(join(root, "coordinator.sqlite"));
    coordinator.close();
    const valid = run(root);
    assert.equal(valid.status, 0, valid.stderr);
    assert.deepEqual(JSON.parse(valid.stdout), { records: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
