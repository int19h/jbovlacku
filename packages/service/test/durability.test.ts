import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { durableDirectory } from "../../../apps/server/src/storage.ts";

test("new object directories sync every ancestor before admission can continue", async () => {
  const root = process.env.JVC_TEST_ROOT ?? tmpdir();
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "durability-"));
  try {
    const synced: string[] = [];
    await durableDirectory(join(directory, "data", "objects"), async (path) => {
      synced.push(path);
    });
    assert.deepEqual(synced, [join(directory, "data"), directory]);
    await assert.rejects(
      durableDirectory(join(directory, "next", "objects"), async () => {
        throw new Error("injected directory sync failure");
      }),
      /injected directory sync failure/,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
