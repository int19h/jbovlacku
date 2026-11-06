import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  initializeCore,
  createEvent,
  evaluateSession,
  restoreHostEvaluationSession,
  wordId,
  type EvaluationRequest,
  type RankingPreparationPolicy,
} from "../src/index.ts";
import { evaluateSession as browserSession } from "../src/browser.ts";

before(async () => {
  await initializeCore(
    await readFile(
      new URL("../generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  );
});
const policy: RankingPreparationPolicy = {
  core_binding: "sha256:" + "a".repeat(64),
};
async function fixture(): Promise<{ input: EvaluationRequest; word: string }> {
  const rows: { name: string; envelope: string; body: string }[] = JSON.parse(
    await readFile(
      new URL(
        "../../../crates/jvc-runtime/tests/fixtures/host-record-inputs-v8.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const view = rows.find((r) => r.name === "f64-contract-0")!;
  const selected = JSON.parse(view.envelope).id;
  const word = wordId({ language: "jbo", spelling: "banli" });
  const body = JSON.parse(
    await readFile(
      new URL(
        "../../../crates/jvc-core/tests/fixtures/definition.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const publication = createEvent(
    new Uint8Array(32).fill(9),
    [],
    "1".repeat(32),
    {
      kind: "definition.publish",
      word,
      language: "en",
      parents: [],
      origin: "native",
    },
    body,
  );
  return {
    word,
    input: {
      events: [view.envelope, JSON.stringify(publication.envelope)],
      bodies: {
        [selected]: view.body,
        [publication.envelope.id]: JSON.stringify(publication.body),
      },
      selected_view: selected,
      import_selections: {},
    },
  };
}

test("preparation shares the frozen state and never enters checkpoints or forks", async () => {
  const { input, word } = await fixture();
  const session = evaluateSession(input);
  const state = session.state;
  const saved = session.checkpoint("preparation-test");
  const child = session
    .fork({ selected_view: input.selected_view, import_selections: {} })
    .finish();
  const restored = restoreHostEvaluationSession(saved, "preparation-test");
  try {
    assert.equal(session.rankingPreparation(), null);
    const descriptor = session.rankingDescriptor(policy);
    assert.equal(descriptor.available, true);
    const request = {
      owner_session: descriptor.owner_session,
      descriptor_binding: descriptor.binding,
      word,
    };
    const summary = session.prepareRanking(request);
    assert.equal(summary.targets.length, 1);
    assert.equal(summary.contexts[0].available, true);
    assert.equal(session.rankingPreparation()!.retained_graphs, 1);
    assert.equal(session.state, state);
    assert(Object.isFrozen(state));
    assert.deepEqual(session.checkpoint("preparation-test"), saved);
    assert.throws(() => session.rankWord(word), /unsupported_calculation/);
    for (const other of [child, restored]) {
      assert.equal(other.rankingPreparation(), null);
      const d = other.rankingDescriptor(policy);
      assert.equal(d.binding, descriptor.binding);
      assert.notEqual(d.owner_session, descriptor.owner_session);
      assert.throws(() => other.prepareRanking(request), /stale_binding/);
      const prepared = other.prepareRanking({
        ...request,
        owner_session: d.owner_session,
      });
      assert.equal(prepared.binding, summary.binding);
    }
    const before = session.rankingPreparation();
    assert.throws(
      () => session.prepareRanking({ ...request, descriptor_binding: "stale" }),
      /stale_binding/,
    );
    assert.deepEqual(session.rankingPreparation(), before);
    session.clearRankingPreparation();
    session.clearRankingPreparation();
    assert.equal(session.rankingPreparation()!.retained_graphs, 0);
    assert.equal(session.rankingPreparation()!.prepared, null);
  } finally {
    session.free();
    child.free();
    restored.free();
  }
});

test("the browser exposes authenticated preparation without host restore or insertion", async () => {
  const { input, word } = await fixture();
  const session = browserSession(input);
  try {
    assert.deepEqual(
      Object.keys(session).sort(),
      [
        "state",
        "rankWord",
        "rankingDescriptor",
        "prepareRanking",
        "rankingPreparation",
        "clearRankingPreparation",
        "startWordResults",
        "stepWordResults",
        "wordResultProgress",
        "takeWordResult",
        "cancelWordResults",
        "free",
      ].sort(),
    );
    const d = session.rankingDescriptor(policy);
    const summary = session.prepareRanking({
      owner_session: d.owner_session,
      descriptor_binding: d.binding,
      word,
    });
    assert.equal(summary.contexts[0].available, true);
    assert.equal("scores" in summary, false);
    assert.equal("layers" in summary, false);
    const changed = session.rankingDescriptor({
      ...policy,
      limits: { contexts: 2 },
    });
    assert.notEqual(changed.binding, d.binding);
    assert.equal(session.rankingPreparation()!.retained_graphs, 0);
    assert.throws(
      () =>
        session.prepareRanking({
          owner_session: d.owner_session,
          descriptor_binding: d.binding,
          word,
        }),
      /stale_binding/,
    );
  } finally {
    session.free();
  }
});
