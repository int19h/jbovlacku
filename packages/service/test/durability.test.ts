import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  durableDirectory,
  FileObjectStore,
} from "../../../apps/server/src/storage.ts";
import {
  countObjectOperation,
  emptyIoCounts,
  totalObjectOperations,
} from "../../../scripts/io-counts.ts";

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

test("object I/O counters count only writes as puts and syncs separately", () => {
  const counts = emptyIoCounts();
  // One new object put, then an identical duplicate put.
  for (const operation of ["write", "sync", "read", "sync"])
    countObjectOperation(counts, operation);
  assert.equal(counts.object_get, 1);
  assert.equal(counts.object_put, 1);
  assert.equal(counts.object_sync, 2);
  assert.equal(totalObjectOperations(counts), 4);
  // A future operation kind cannot change object_put until it is
  // counted on purpose.
  countObjectOperation(counts, "some-future-operation");
  assert.equal(counts.object_put, 1);
  assert.equal(totalObjectOperations(counts), 4);
});

test("file object measurements count writes and the read that confirms an existing object", async () => {
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
    assert.deepEqual(operations, ["write", "sync"]);

    // The identical object already exists, so the second put reads it to
    // confirm the bytes, syncs its directory (a crashed writer may have
    // linked it without syncing the entry), and skips the write and the
    // file sync.
    await objects.put(hash, bytes);
    assert.deepEqual(operations, ["write", "sync", "read", "sync"]);

    await assert.rejects(
      objects.put(hash, new Uint8Array([4, 5, 6])),
      /Object hash collision/,
    );
    assert.deepEqual(operations, ["write", "sync", "read", "sync", "read"]);
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
