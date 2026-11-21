import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { location?: unknown }).location = {
  origin: "http://local.test",
  host: "local.test",
};
const { validateHits } = await import("../../src/data/api.ts");

const event = "jve1:" + "1".repeat(64);
const issuer = "ed25519:" + "2".repeat(64);
const hit = (preview: Record<string, unknown>) => ({
  word: { language: "jbo", spelling: "cukta" },
  word_id: "jvw1:" + "3".repeat(64),
  match: "gloss",
  definitions: [event],
  preview: {
    event,
    word_kind: "gismu",
    plain_text: "A synthetic book.",
    status: "active",
    ...preview,
  },
});

test("an over-long preview row field is shortened or dropped and the hit stays", () => {
  const [kept] = validateHits(
    [
      hit({
        rafsi: ["r".repeat(65), "cku"],
        selmaho: ["X".repeat(200), "BAI"],
        issuer,
        notes: true,
        attribution: {
          source: "s".repeat(600),
          author: "a".repeat(600),
          account: { origin: "o".repeat(600), account: 7 },
          dates: { ["l".repeat(100)]: "2003", created: "2003-03-01" },
        },
      }),
    ],
    100,
  );
  assert.ok(kept.preview);
  assert.deepEqual(kept.preview.rafsi, ["cku"]);
  assert.deepEqual(kept.preview.selmaho, ["BAI"]);
  assert.equal(kept.preview.issuer, issuer);
  assert.equal(kept.preview.notes, true);
  assert.equal(kept.preview.attribution?.source, "s".repeat(255) + "…");
  assert.equal(kept.preview.attribution?.author, "a".repeat(255) + "…");
  assert.equal(kept.preview.attribution?.account, null);
  assert.deepEqual(kept.preview.attribution?.dates, { created: "2003-03-01" });
});

test("a preview row field of the wrong shape is removed and the hit stays", () => {
  const [kept] = validateHits(
    [
      hit({
        rafsi: "cku",
        selmaho: ["BAI"],
        issuer: "not an identity",
        notes: true,
        attribution: null,
      }),
    ],
    100,
  );
  assert.ok(kept.preview);
  // The row reads these fields from the definition instead.
  assert.equal(kept.preview.rafsi, undefined);
  assert.equal(kept.preview.issuer, undefined);
  assert.equal(kept.preview.notes, undefined);
  assert.equal(kept.preview.attribution, undefined);
  assert.deepEqual(kept.preview.selmaho, ["BAI"]);
  assert.equal(kept.preview.plain_text, "A synthetic book.");
});

test("a signing identity without its attribution is removed, so an import is never drawn as native", () => {
  const [kept] = validateHits([hit({ issuer, notes: false })], 100);
  assert.ok(kept.preview);
  assert.equal(kept.preview.issuer, undefined);
  assert.equal(kept.preview.notes, undefined);
  assert.equal(kept.preview.attribution, undefined);
  const [native] = validateHits(
    [hit({ issuer, notes: false, attribution: null })],
    100,
  );
  assert.equal(native.preview?.issuer, issuer);
  assert.equal(native.preview?.attribution, null);
});
