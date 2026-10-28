import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { before, test } from "node:test";
import {
  canonicalize,
  contentHash,
  initializeCore,
  utf8,
} from "../../core/src/index.ts";
import {
  rebasePackages,
  type MaterializedPackage,
  type MaterializedPackages,
} from "../src/packages.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const canonical = (value: unknown) =>
  utf8(canonicalize(utf8(JSON.stringify(value))));

function fixture(): MaterializedPackages {
  const packages = (version: 1 | 2) => {
    const result: Record<string, MaterializedPackage> = {};
    for (const language of ["ru", "jbo", "fr", "es", "en", "de"]) {
      const manifest = {
        version,
        language,
        snapshot: "previous",
        parts: [{ hash: "immutable-part", bytes: 41, count: 1 }],
      };
      const bytes = canonical(manifest);
      result[language] = {
        manifest,
        hash: contentHash(bytes),
        bytes: bytes.length,
      };
    }
    return result;
  };
  return { entries: [], packages: packages(1), packages2: packages(2) };
}

test("package rebasing overlaps eight manifest writes across versions with exact output", async () => {
  const previous = fixture();
  const gates = Array.from({ length: 12 }, () => deferred());
  const writes: { hash: string; bytes: Uint8Array }[] = [];
  let active = 0;
  let peak = 0;
  const rebasing = rebasePackages(previous, "next", {
    async get() {
      throw new Error("Rebasing must not read package parts.");
    },
    async put(hash, bytes) {
      const index = writes.length;
      writes.push({ hash, bytes });
      peak = Math.max(peak, ++active);
      try {
        await gates[index].promise;
      } finally {
        active--;
      }
    },
  });
  assert.equal(writes.length, 8);
  assert.deepEqual(
    writes.map(
      ({ bytes }) => JSON.parse(new TextDecoder().decode(bytes)).version,
    ),
    [1, 1, 1, 1, 1, 1, 2, 2],
  );
  let finished = false;
  void rebasing.then(() => {
    finished = true;
  });
  for (let index = gates.length - 1; index >= 0; index--)
    gates[index].resolve();
  assert.equal(finished, false);
  const result = await rebasing;
  assert.equal(active, 0);
  assert.equal(peak, 8);
  assert.equal(result.entries, previous.entries);
  let index = 0;
  for (const field of ["packages", "packages2"] as const) {
    assert.deepEqual(
      Object.keys(result[field]),
      Object.keys(previous[field]).sort(),
    );
    for (const language of Object.keys(previous[field]).sort()) {
      const manifest = {
        ...previous[field][language].manifest,
        snapshot: "next",
      };
      const bytes = canonical(manifest);
      const hash = contentHash(bytes);
      assert.deepEqual(result[field][language], {
        manifest,
        hash,
        bytes: bytes.length,
      });
      assert.deepEqual(writes[index++], { hash, bytes });
    }
  }
  assert.equal(writes.length, 12);
});

test("package rebasing drains its bounded writes and reports the first ordered failure", async () => {
  const gates = Array.from({ length: 8 }, () => deferred());
  const firstError = new Error("First manifest failed.");
  let started = 0;
  let active = 0;
  const rebasing = rebasePackages(fixture(), "next", {
    async get() {
      return null;
    },
    async put() {
      const index = started++;
      active++;
      try {
        await gates[index].promise;
      } finally {
        active--;
      }
    },
  });
  const rejected = assert.rejects(rebasing, (error) => error === firstError);
  gates[3].reject(new Error("Later manifest failed first."));
  gates[0].reject(firstError);
  for (let index = 1; index < 7; index++) gates[index].resolve();
  let settled = false;
  void rejected.then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(active, 1);
  assert.equal(started, 8);
  gates[7].resolve();
  await rejected;
  assert.equal(active, 0);
  assert.equal(started, 8);
});
