import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  initializeCore,
  createEvent,
  wordId,
  identityFromSeed,
  evaluateSession,
  wordResultPolicyBinding,
  canonicalize,
  utf8,
  describeWordResults,
  WordResultCache,
  type EvaluationRequest,
  type EvaluationSessionHandle,
  type WordCacheIdentity,
} from "../src/index.ts";
const hash = (n: number) => "sha256:" + n.toString(16).padStart(64, "0");
before(async () =>
  initializeCore(
    await readFile(
      new URL("../generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);
async function fixture() {
  const seed = (n: number) => new Uint8Array(32).fill(n);
  const rows = JSON.parse(
    await readFile(
      new URL(
        "../../../crates/jvc-runtime/tests/fixtures/host-record-inputs-v8.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const template = rows.find((r: any) => r.name === "f64-contract-0");
  const view = JSON.parse(template.body);
  view.roots = [
    {
      identity: identityFromSeed(seed(1)),
      q: { numerator: 1, denominator: 1 },
    },
  ];
  const v = createEvent(
    seed(20),
    [],
    "1".repeat(32),
    { kind: "view.publish", parents: [] },
    view,
  );
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
  const d = createEvent(
    seed(9),
    [],
    "2".repeat(32),
    {
      kind: "definition.publish",
      word,
      language: "en",
      parents: [],
      origin: "native",
    },
    body,
  );
  const t = createEvent(
    seed(1),
    [],
    "3".repeat(32),
    {
      kind: "trust.set",
      subject: identityFromSeed(seed(2)),
      scope: { kind: "definition", word: "*", language: "en" },
      value: "heed",
    },
    null,
  );
  const j = createEvent(
    seed(2),
    [],
    "4".repeat(32),
    { kind: "judgment.set", target: d.envelope.id, value: "bless" },
    null,
  );
  const input: EvaluationRequest = {
    events: [v, d, t, j].map((r) => JSON.stringify(r.envelope)),
    bodies: {
      [v.envelope.id]: canonicalize(utf8(JSON.stringify(v.body))),
      [d.envelope.id]: canonicalize(utf8(JSON.stringify(d.body))),
    },
    selected_view: v.envelope.id,
    import_selections: {},
  };
  return { input, word };
}
function prepare(
  session: EvaluationSessionHandle,
  word: string,
  reviewers: number | null = null,
) {
  const descriptor = session.rankingDescriptor({ core_binding: hash(5) });
  const prepared = session.prepareRanking({
    owner_session: descriptor.owner_session,
    descriptor_binding: descriptor.binding,
    word,
  });
  const policy = { reviewers };
  return {
    descriptor,
    request: {
      owner_session: descriptor.owner_session,
      descriptor_binding: descriptor.binding,
      preparation_id: prepared.preparation_id,
      policy,
    },
  };
}
test("consuming native delivery stays readable after native disposal without a runtime lease", async () => {
  const { input, word } = await fixture();
  const session = evaluateSession(input);
  const { descriptor, request } = prepare(session, word, 4);
  const identity: WordCacheIdentity = {
    logical_session: "test",
    snapshot: hash(1),
    inventory: hash(2),
    input: descriptor.input_binding,
    view: input.selected_view,
    overlay: null,
    mode: "site",
    build: hash(5),
    contract: descriptor.contract_binding,
    algorithm: descriptor.algorithm!,
  };
  const cache = new WordResultCache();
  cache.bind(identity);
  const admission = cache.reserve(word, request.policy, 0);
  assert.equal(admission.status, "reserved");
  if (admission.status !== "reserved") throw Error("reserve");
  const start = session.startWordResults(request);
  let p = start;
  while (p.phase === "running") p = session.stepWordResults(start.token, 17);
  assert.equal(p.phase, "ready");
  const bytes = session.takeWordResult(start.token);
  assert.equal(session.wordResultProgress(), null);
  const completed = cache.complete(admission.reservation, bytes, 100);
  if (completed.status !== "ready") throw Error("completion");
  const ticket = completed.ticket;
  assert.equal(bytes.byteLength, 0);
  session.free();
  const result = JSON.parse(
    new TextDecoder().decode(cache.read(ticket.id, 101)!.bytes),
  );
  assert.equal(result.numerically_approximate, true);
  assert.equal(result.layers_complete, true);
  assert.equal(result.scores[0].reviewers[0].verdict, "bless");
  assert.equal(cache.read(ticket.id, 60099)!.expires_at, 60100);
  assert.equal(cache.read(ticket.id, 60100), null);
  cache.dispose();
});
test("repair keeps deadline evidence and descriptor refusal preserves evaluation evidence", async () => {
  const { input, word } = await fixture();
  const old = evaluateSession(input);
  const first = prepare(old, word);
  const cache = new WordResultCache();
  const identity: WordCacheIdentity = {
    logical_session: "logical",
    snapshot: hash(1),
    inventory: hash(2),
    input: first.descriptor.input_binding,
    view: input.selected_view,
    overlay: null,
    mode: "site",
    build: hash(5),
    contract: first.descriptor.contract_binding,
    algorithm: first.descriptor.algorithm!,
  };
  cache.bind(identity);
  const r = cache.reserve(word, {}, 0);
  if (r.status !== "reserved") throw Error("reserve");
  cache.deadline(r.reservation, true, 5_000);
  old.free();
  const repaired = evaluateSession(input);
  try {
    const next = prepare(repaired, word);
    assert.equal(next.descriptor.input_binding, identity.input);
    assert.equal(
      cache.bind({ ...identity, input: next.descriptor.input_binding }),
      false,
    );
    assert.equal(cache.reserve(word, {}, 5001).status, "failure");
    assert.equal(repaired.wordResultProgress(), null);
    const evidence = describeWordResults(repaired, {
      core_binding: hash(5),
      limits: { records: 1 },
    });
    assert.equal(evidence.descriptor, null);
    assert.equal(evidence.evaluation.available, true);
    assert.deepEqual(evidence.evaluation.reasons, repaired.state.reasons);
    assert.match(evidence.error!, /resource_unavailable/);
    assert.equal(repaired.state.available, true);
  } finally {
    repaired.free();
    cache.dispose();
  }
});

test("policy identity normalizes defaults and separates reviewer requirements", () => {
  assert.equal(
    wordResultPolicyBinding({}),
    wordResultPolicyBinding({ reviewers: null }),
  );
  assert.notEqual(
    wordResultPolicyBinding({}),
    wordResultPolicyBinding({ reviewers: 0 }),
  );
  assert.notEqual(
    wordResultPolicyBinding({ reviewers: 1 }),
    wordResultPolicyBinding({ reviewers: 2 }),
  );
});
