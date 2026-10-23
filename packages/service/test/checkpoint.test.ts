import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";
import test from "node:test";
import {
  FileCheckpointStore,
  type CheckpointPins,
} from "../../../apps/server/src/checkpoint.ts";
import {
  SqliteCoordinator,
  type CheckpointPin,
} from "../../../apps/server/src/storage.ts";
import type {
  CheckpointBinding,
  ServiceCheckpoint,
} from "../src/checkpoint.ts";

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const hash = (n: number) => "sha256:" + String(n).padStart(64, "0");
const binding: CheckpointBinding = {
  schema: 1,
  snapshot: hash(1),
  logical_inventory: hash(2),
  position: 7,
  view: "jve1:" + "3".repeat(64),
  core_version: "actual-wasm-digest:core-v1:service-v1",
  limits: { events: 200000, traversal: 1000000, claim_depth: 1024 },
};
const payload: ServiceCheckpoint = {
  core: Uint8Array.of(1, 2, 3, 255),
  package_records: [],
  packages: { entries: [], packages: {}, packages2: {} },
  envelopes: [[hash(4), "canonical envelope"]],
};
async function fixture() {
  const root = process.env.JVC_TEST_ROOT ?? tmpdir();
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "checkpoint-"));
  let pin: CheckpointPin | null = null;
  let failure = false;
  let accepted = true;
  const pins: CheckpointPins = {
    checkpointPin: () => pin,
    pinCheckpoint(_binding, value) {
      if (failure) throw new Error("injected pin failure");
      if (!accepted) return false;
      pin = value;
      return true;
    },
  };
  return {
    directory,
    pins,
    store: new FileCheckpointStore(directory, pins),
    pin: () => pin!,
    fail(value: boolean) {
      failure = value;
    },
    accept(value: boolean) {
      accepted = value;
    },
    async close() {
      await rm(directory, { recursive: true });
    },
  };
}

test("checkpoint roundtrip uses a separately stored hash and binds every calculation input", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.store.load(binding), null);
    await f.store.save(binding, payload);
    assert.deepEqual(await f.store.load(binding), payload);
    assert.deepEqual(
      await new FileCheckpointStore(f.directory, f.pins).load(binding),
      payload,
    );
    const changed: CheckpointBinding[] = [
      { ...binding, schema: 2 as 1 },
      { ...binding, snapshot: hash(99) },
      { ...binding, logical_inventory: hash(99) },
      { ...binding, position: 8 },
      { ...binding, view: "other" },
      { ...binding, core_version: "other" },
      { ...binding, limits: null },
      { ...binding, limits: { ...binding.limits!, events: 1 } },
      { ...binding, limits: { ...binding.limits!, traversal: 1 } },
      { ...binding, limits: { ...binding.limits!, claim_depth: 1 } },
    ];
    for (const different of changed)
      assert.equal(await f.store.load(different), null);
    assert.equal(
      f.pin().hash,
      createHash("sha256")
        .update(await readFile(join(f.directory, f.pin().file)))
        .digest("hex"),
    );
  } finally {
    await f.close();
  }
});

test("missing and damaged checkpoints fall back even when a file claims its own valid digest", async () => {
  const f = await fixture();
  try {
    await f.store.save(binding, payload);
    const path = join(f.directory, f.pin().file);
    const original = await readFile(path);
    const decoded = JSON.parse((await decompress(original)).toString("utf8"));
    decoded.payload.core = Buffer.from("forged core state").toString("base64");
    decoded.hash = createHash("sha256")
      .update(JSON.stringify(decoded.payload))
      .digest("hex");
    await writeFile(path, await compress(JSON.stringify(decoded)));
    assert.equal(await f.store.load(binding), null);
    await writeFile(path, original.subarray(0, 12));
    assert.equal(await f.store.load(binding), null);
    await rm(path);
    assert.equal(await f.store.load(binding), null);
  } finally {
    await f.close();
  }
});

test("failed pin commits preserve the previous checkpoint and remove only exact owned files", async () => {
  const f = await fixture();
  try {
    await f.store.save(binding, payload);
    const previous = { ...f.pin() };
    await writeFile(join(f.directory, "keep-other-data.txt"), "retain");
    f.fail(true);
    await assert.rejects(
      f.store.save(binding, { ...payload, core: Uint8Array.of(99) }),
      /injected pin failure/,
    );
    assert.deepEqual(f.pin(), previous);
    assert.deepEqual(await f.store.load(binding), payload);
    assert.deepEqual(
      (await readdir(f.directory)).sort(),
      [previous.file, "keep-other-data.txt"].sort(),
    );
    f.fail(false);
    f.accept(false);
    await f.store.save(binding, { ...payload, core: Uint8Array.of(88) });
    assert.deepEqual(f.pin(), previous);
    assert.deepEqual(await f.store.load(binding), payload);
    f.accept(true);
    const next = { ...payload, core: Uint8Array.of(77) };
    await Promise.all([
      f.store.save(binding, payload),
      f.store.save(binding, next),
    ]);
    assert.deepEqual(await f.store.load(binding), next);
    assert.equal(
      (await readdir(f.directory)).filter((name) => name.endsWith(".json.gz"))
        .length,
      1,
    );
    assert.equal(
      await readFile(join(f.directory, "keep-other-data.txt"), "utf8"),
      "retain",
    );
  } finally {
    await f.close();
  }
});

test("startup removes orphan checkpoint files and leaves unrelated files in place", async () => {
  const f = await fixture();
  try {
    await f.store.save(binding, payload);
    await writeFile(
      join(f.directory, "evaluation-" + "a".repeat(64) + ".json.gz"),
      "orphan",
    );
    await writeFile(
      join(
        f.directory,
        ".evaluation-pending-00000000-0000-0000-0000-000000000000",
      ),
      "pending",
    );
    await writeFile(
      join(f.directory, "evaluation-operator-notes.json.gz"),
      "retain",
    );
    const reopened = new FileCheckpointStore(f.directory, f.pins);
    assert.deepEqual(await reopened.load(binding), payload);
    assert.deepEqual(
      (await readdir(f.directory)).sort(),
      [f.pin().file, "evaluation-operator-notes.json.gz"].sort(),
    );
  } finally {
    await f.close();
  }
});

test("SQLite pins permit only the exact last materialized snapshot", async () => {
  const f = await fixture();
  const coordinator = new SqliteCoordinator(
    join(f.directory, "coordinator.sqlite"),
  );
  try {
    const state = await coordinator.load();
    const accepted = {
      ...state,
      revision: 1,
      position: 8,
      snapshot: hash(8),
      materialized_snapshot: binding.snapshot,
      materialized_position: binding.position,
    };
    assert.equal(await coordinator.compareAndSwap(0, accepted), true);
    const pin = {
      binding: "trusted binding",
      hash: "a".repeat(64),
      file: "evaluation-" + "a".repeat(64) + ".json.gz",
    };
    assert.equal(coordinator.pinCheckpoint(binding, pin), true);
    assert.deepEqual(coordinator.checkpointPin(), pin);
    assert.equal(
      coordinator.pinCheckpoint(
        { ...binding, snapshot: hash(5) },
        { ...pin, hash: "b".repeat(64) },
      ),
      false,
    );
    assert.deepEqual(coordinator.checkpointPin(), pin);
    assert.equal(
      coordinator.pinCheckpoint(
        { ...binding, snapshot: accepted.snapshot, position: 8 },
        { ...pin, hash: "c".repeat(64) },
      ),
      false,
    );
    assert.equal(
      await coordinator.markMaterialized(binding.snapshot, binding.position),
      false,
    );
    assert.equal(
      await coordinator.markMaterialized(accepted.snapshot, 8),
      true,
    );
  } finally {
    coordinator.close();
    await f.close();
  }
});

test("checkpoint bytes and the independent SQLite pin survive closing and reopening storage", async () => {
  const f = await fixture();
  const path = join(f.directory, "persistent-coordinator.sqlite");
  let coordinator = new SqliteCoordinator(path);
  try {
    const state = await coordinator.load();
    assert.equal(
      await coordinator.compareAndSwap(0, {
        ...state,
        revision: 1,
        position: binding.position,
        snapshot: binding.snapshot,
        materialized_snapshot: binding.snapshot,
        materialized_position: binding.position,
      }),
      true,
    );
    const directory = join(f.directory, "evaluation-cache");
    await new FileCheckpointStore(directory, coordinator).save(
      binding,
      payload,
    );
    const trustedPin = coordinator.checkpointPin();
    coordinator.close();
    coordinator = new SqliteCoordinator(path);
    assert.deepEqual(coordinator.checkpointPin(), trustedPin);
    assert.deepEqual(
      await new FileCheckpointStore(directory, coordinator).load(binding),
      payload,
    );
  } finally {
    coordinator.close();
    await f.close();
  }
});

test("a failed immutable file write preserves the previous checkpoint pin and bytes", async () => {
  const f = await fixture();
  const other = await fixture();
  try {
    await f.store.save(binding, payload);
    const previous = { ...f.pin() };
    const next = { ...payload, core: Uint8Array.of(91) };
    await other.store.save(binding, next);
    const obstruction = join(f.directory, other.pin().file);
    await mkdir(obstruction);
    await assert.rejects(f.store.save(binding, next));
    assert.deepEqual(f.pin(), previous);
    assert.deepEqual(await f.store.load(binding), payload);
    await rm(obstruction, { recursive: true });
    assert.deepEqual(await readdir(f.directory), [previous.file]);
  } finally {
    await f.close();
    await other.close();
  }
});
