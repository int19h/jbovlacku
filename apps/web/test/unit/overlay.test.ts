import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The data modules read the page at load time. Give them one before importing.
(globalThis as { location?: unknown }).location = {
  origin: "http://peer.test",
  host: "peer.test",
};
(globalThis as { window?: unknown }).window = globalThis;
const core = await import("../../../../packages/core/src/index.ts");
const { effectiveOverlay, overlayDigest, nullOverlayDigest } =
  await import("../../src/data/personal.ts");
const { emptyOverlay } = await import("../../src/data/store.ts");
const { routeNote, influenceText } =
  await import("../../src/model/reviewers.ts");

before(async () =>
  core.initializeCore(
    await readFile(
      new URL(
        "../../../../packages/core/generated/jvc_runtime_bg.wasm",
        import.meta.url,
      ),
    ),
  ),
);
const me = "ed25519:" + "a".repeat(64);
const other = "ed25519:" + "b".repeat(64);
const view = "jve1:" + "c".repeat(64);
const all = { kind: "*" as const, word: "*" as const, language: "*" as const };
const saved = () => ({
  ...emptyOverlay(),
  blocked: [{ identity: other, scope: all }],
  work: 2000,
});

test("a personal calculation gets a version 2 overlay that names the session identity as the public shun issuer", () => {
  const stored = saved();
  const before = JSON.stringify(stored);
  const overlay = effectiveOverlay(stored, view, { identity: me }, []);
  assert.deepEqual(Object.keys(overlay).sort(), [
    "base_view",
    "blocked",
    "public_shun_issuer",
    "root_changes",
    "trust",
    "version",
    "work",
  ]);
  assert.equal(overlay.version, 2);
  assert.equal(overlay.public_shun_issuer, me);
  assert.equal(overlay.base_view, view);
  assert.equal(overlay.work, 2000);
  // The identity is a root with q=1 when the view names no allocation for it.
  assert.deepEqual(overlay.root_changes, [
    { identity: me, q: { numerator: 1, denominator: 1 } },
  ]);
  // Only the saved private blocks are blocks. Nothing is derived here.
  assert.deepEqual(overlay.blocked, [{ identity: other, scope: all }]);
  // The saved preferences stay version 1 and unchanged.
  assert.equal(JSON.stringify(stored), before);
  assert.equal(stored.version, 1);
});

test("an anonymous session names no issuer and adds no root", () => {
  const overlay = effectiveOverlay(saved(), view, { identity: null }, []);
  assert.equal(overlay.version, 2);
  assert.equal(overlay.public_shun_issuer, null);
  assert.deepEqual(overlay.root_changes, []);
});

test("a view root is not added again, and a malformed identity names no issuer", () => {
  const rooted = effectiveOverlay(saved(), view, { identity: me }, [me]);
  assert.deepEqual(rooted.root_changes, []);
  assert.equal(rooted.public_shun_issuer, me);
  const odd = effectiveOverlay(saved(), view, { identity: "not-a-key" }, []);
  assert.equal(odd.public_shun_issuer, null);
});

test("the overlay digest covers the issuer, so two identities and an anonymous session never share a digest", () => {
  const mine = overlayDigest(
    effectiveOverlay(saved(), view, { identity: me }, [me]),
  );
  const theirs = overlayDigest(
    effectiveOverlay(saved(), view, { identity: other }, [other]),
  );
  const nobody = overlayDigest(
    effectiveOverlay(saved(), view, { identity: null }, []),
  );
  assert.notEqual(mine, theirs);
  assert.notEqual(mine, nobody);
  assert.notEqual(theirs, nobody);
  assert.notEqual(nobody, nullOverlayDigest());
  // The same input gives the same digest.
  assert.equal(
    mine,
    overlayDigest(effectiveOverlay(saved(), view, { identity: me }, [me])),
  );
});

const reviewer = (
  fields: Partial<import("../../src/model/types.ts").ReviewerDetail>,
) => ({
  identity: other,
  verdict: "bless" as const,
  weight: null,
  root: null,
  blocked: false,
  incoming: [],
  incoming_count: 0,
  incoming_complete: true,
  multiple_routes: false,
  ...fields,
});

test("route notes follow the reasons that the result supplies, and nothing else", () => {
  assert.equal(
    routeNote(reviewer({ blocked: true, public_shun_block: true })),
    "blocked in your personal view by your public shun",
  );
  assert.equal(
    routeNote(reviewer({ blocked: true, private_block: true })),
    "blocked by your private choice",
  );
  assert.equal(
    routeNote(
      reviewer({ blocked: true, public_shun_block: true, private_block: true }),
    ),
    "blocked in your personal view by your public shun and blocked by your private choice",
  );
  assert.equal(routeNote(reviewer({ blocked: true })), "blocked in this view");
  assert.equal(routeNote(reviewer({})), "no route in this view");
  assert.equal(influenceText(reviewer({ blocked: true })), "0");
  assert.equal(influenceText(reviewer({})), "unavailable");
});

test("an allocation or removal for a continuity group prevents an automatic personal root", () => {
  const predecessor = other;
  const context = {
    identity: me,
    actors: { [me]: predecessor, [predecessor]: predecessor },
  };
  assert.deepEqual(
    effectiveOverlay(saved(), view, context, [predecessor]).root_changes,
    [],
  );
  for (const q of [
    null,
    { numerator: 0, denominator: 1 },
    { numerator: 1, denominator: 2 },
  ]) {
    const overlay = {
      ...saved(),
      root_changes: [{ identity: predecessor, q }],
    };
    assert.deepEqual(
      effectiveOverlay(overlay, view, context, []).root_changes,
      overlay.root_changes,
    );
  }
  // A later snapshot without accepted continuity treats the keys separately.
  assert.equal(
    effectiveOverlay(saved(), view, { identity: me, actors: {} }, [predecessor])
      .root_changes.length,
    1,
  );
});
