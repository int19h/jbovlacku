import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  durableDirectory,
  FileObjectStore,
} from "../../../apps/server/src/storage.ts";

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

test("file object measurements count real writes and collision reads without adding I/O", async () => {
  const root = process.env.JVC_TEST_ROOT ?? tmpdir();
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "object-io-"));
  try {
    const operations: string[] = [];
    const objects = new FileObjectStore(directory, (operation) => {
      operations.push(operation);
    });
    const hash = "sha256:" + "a".repeat(64);
    const bytes = new Uint8Array([1, 2, 3]);

    await objects.put(hash, bytes);
    assert.deepEqual(operations, ["write"]);

    await objects.put(hash, bytes);
    assert.deepEqual(operations, ["write", "write", "read"]);

    await assert.rejects(
      objects.put(hash, new Uint8Array([4, 5, 6])),
      /Object hash collision/,
    );
    assert.deepEqual(operations, ["write", "write", "read", "write", "read"]);
    assert.deepEqual(await objects.get(hash), Buffer.from(bytes));
    assert.equal(await objects.get("sha256:" + "b".repeat(64)), null);
    assert.deepEqual(operations.slice(-2), ["read", "read"]);
    assert.equal(operations.length, 7);
    assert.deepEqual(await readdir(directory), [hash.replaceAll(":", "-")]);

    await assert.rejects(objects.get("invalid"), /Invalid object key/);
    assert.equal(operations.length, 7);
  } finally {
    await rm(directory, { recursive: true });
  }
});
