import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  canonicalize,
  createEvent,
  evaluateSession,
  identityFromSeed,
  initializeCore,
  utf8,
  wordId,
  type EvaluationRequest,
} from "../../../../packages/core/src/browser.ts";
import type { EvaluationWorker } from "../../src/workers/evaluate.ts";

const seed = (n: number) => new Uint8Array(32).fill(n);

async function fixture() {
  const viewBody = JSON.parse(
    await readFile(
      new URL(
        "../../../../crates/jvc-runtime/tests/fixtures/host-record-inputs-v8.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ).find((row: { name: string }) => row.name === "f64-contract-0").body;
  const roots = JSON.parse(viewBody);
  roots.calculation = "simple-routes-shun-v1";
  roots.roots = [
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
    roots,
  );
  const definitionBody = JSON.parse(
    await readFile(
      new URL(
        "../../../../crates/jvc-core/tests/fixtures/definition.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const word = wordId({ language: "jbo", spelling: "banli" });
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
    definitionBody,
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
    events: [v, d, t, j].map((row) => JSON.stringify(row.envelope)),
    bodies: {
      [v.envelope.id]: canonicalize(utf8(JSON.stringify(v.body))),
      [d.envelope.id]: canonicalize(utf8(JSON.stringify(d.body))),
    },
    selected_view: v.envelope.id,
    import_selections: {},
  };
  return { input, word, target: d.envelope.id };
}

function delta(input: EvaluationRequest, envelope: unknown): EvaluationRequest {
  return {
    events: [JSON.stringify(envelope)],
    bodies: {},
    selected_view: input.selected_view,
    import_selections: input.import_selections,
  };
}

async function worker(): Promise<EvaluationWorker> {
  const { EvaluationWorker } = await import("../../src/workers/evaluate.ts");
  return new EvaluationWorker();
}

before(async () => {
  await initializeCore(
    await readFile(
      new URL(
        "../../../../packages/core/generated/jvc_runtime_bg.wasm",
        import.meta.url,
      ),
    ),
  );
  (globalThis as { self?: unknown }).self = {
    postMessage: () => {},
    onmessage: null,
  };
});

test("a judgment advance equals full evaluation and replaces the session key", async () => {
  const { input, word, target } = await fixture();
  const added = createEvent(
    seed(2),
    [],
    "5".repeat(32),
    { kind: "judgment.set", target, value: "curse" },
    null,
  );
  const fullInput = {
    ...input,
    events: [...input.events, JSON.stringify(added.envelope)],
  };
  const expected = evaluateSession(fullInput);
  const actual = await worker();
  try {
    actual.load({ type: "load", id: 1, session: "before", input });
    const loaded = actual.advance({
      type: "advance",
      id: 2,
      base: "before",
      session: "after",
      input: delta(input, added.envelope),
    });
    assert.equal(loaded.events, fullInput.events.length);
    assert.deepEqual(actual.currentSession?.state, expected.state);
    assert.deepEqual(
      actual.currentSession?.state.receipts,
      expected.state.receipts,
    );
    assert.deepEqual(actual.currentSession?.updateStatistics(), {
      incremental_records: 1,
      rebuilt: false,
      reason: null,
    });
    assert.deepEqual(
      actual.rank({
        type: "rank",
        id: 3,
        session: "after",
        word,
        reviewers: 64,
      }).result,
      expected.rankWord(word, 64),
    );
    assert.throws(
      () => actual.rank({ type: "rank", id: 4, session: "before", word }),
      /requested evaluation session is not loaded/,
    );
  } finally {
    actual.currentSession?.free();
    expected.free();
  }
});

test("a global action rebuilds through advance with full state and ranking parity", async () => {
  const { input, word } = await fixture();
  const added = createEvent(
    seed(1),
    [],
    "6".repeat(32),
    {
      kind: "trust.set",
      subject: identityFromSeed(seed(3)),
      scope: { kind: "definition", word: "*", language: "en" },
      value: "heed",
    },
    null,
  );
  const fullInput = {
    ...input,
    events: [...input.events, JSON.stringify(added.envelope)],
  };
  const expected = evaluateSession(fullInput);
  const actual = await worker();
  try {
    actual.load({ type: "load", id: 1, session: "before", input });
    actual.advance({
      type: "advance",
      id: 2,
      base: "before",
      session: "after",
      input: delta(input, added.envelope),
    });
    assert.equal(actual.currentSession?.updateStatistics().rebuilt, true);
    assert.equal(
      actual.currentSession?.updateStatistics().reason,
      "global_action",
    );
    assert.deepEqual(actual.currentSession?.state, expected.state);
    assert.deepEqual(
      actual.rank({
        type: "rank",
        id: 3,
        session: "after",
        word,
        reviewers: 64,
      }).result,
      expected.rankWord(word, 64),
    );
    actual.load({ type: "load", id: 4, session: "snapshot", input: fullInput });
    assert.deepEqual(actual.currentSession?.state, expected.state);
    assert.throws(
      () => actual.rank({ type: "rank", id: 5, session: "after", word }),
      /requested evaluation session is not loaded/,
    );
  } finally {
    actual.currentSession?.free();
    expected.free();
  }
});

test("changed limits rebuild to the same unavailable result as full evaluation", async () => {
  const { input, word, target } = await fixture();
  const added = createEvent(
    seed(2),
    [],
    "7".repeat(32),
    { kind: "judgment.set", target, value: "bless" },
    null,
  );
  const limited = {
    ...delta(input, added.envelope),
    limits: { events: 200_000, traversal: 0, claim_depth: 1024 },
  };
  const fullInput = {
    ...input,
    events: [...input.events, JSON.stringify(added.envelope)],
    limits: limited.limits,
  };
  const expected = evaluateSession(fullInput);
  const actual = await worker();
  try {
    actual.load({ type: "load", id: 1, session: "before", input });
    actual.advance({
      type: "advance",
      id: 2,
      base: "before",
      session: "limited",
      input: limited,
    });
    assert.equal(actual.currentSession?.updateStatistics().rebuilt, true);
    assert.equal(
      actual.currentSession?.updateStatistics().reason,
      "configuration_changed",
    );
    assert.deepEqual(actual.currentSession?.state, expected.state);
    assert.deepEqual(
      actual.rank({ type: "rank", id: 3, session: "limited", word }).result,
      expected.rankWord(word),
    );
  } finally {
    actual.currentSession?.free();
    expected.free();
  }
});

test("an advance with the wrong base keeps the loaded session", async () => {
  const { input, word } = await fixture();
  const actual = await worker();
  try {
    actual.load({ type: "load", id: 1, session: "before", input });
    const state = actual.currentSession?.state;
    assert.throws(
      () =>
        actual.advance({
          type: "advance",
          id: 2,
          base: "wrong",
          session: "after",
          input: { ...input, events: [], bodies: {} },
        }),
      /base evaluation session is not loaded/,
    );
    assert.equal(actual.currentSession?.state, state);
    assert.equal(
      actual.rank({ type: "rank", id: 3, session: "before", word }).session,
      "before",
    );
  } finally {
    actual.currentSession?.free();
  }
});

test("a body-bearing definition advance equals full evaluation", async () => {
  const { input, word } = await fixture();
  const definitionBody = JSON.parse(
    await readFile(
      new URL(
        "../../../../crates/jvc-core/tests/fixtures/definition.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const added = createEvent(
    seed(11),
    [],
    "8".repeat(32),
    {
      kind: "definition.publish",
      word,
      language: "en",
      parents: [],
      origin: "native",
    },
    definitionBody,
  );
  const body = canonicalize(utf8(JSON.stringify(added.body)));
  const fullInput = {
    ...input,
    events: [...input.events, JSON.stringify(added.envelope)],
    bodies: { ...input.bodies, [added.envelope.id]: body },
  };
  const expected = evaluateSession(fullInput);
  const actual = await worker();
  try {
    actual.load({ type: "load", id: 1, session: "before", input });
    actual.advance({
      type: "advance",
      id: 2,
      base: "before",
      session: "after",
      input: {
        ...delta(input, added.envelope),
        bodies: { [added.envelope.id]: body },
      },
    });
    assert.equal(actual.currentSession?.updateStatistics().rebuilt, false);
    assert.deepEqual(actual.currentSession?.state, expected.state);
    assert.deepEqual(
      actual.rank({
        type: "rank",
        id: 3,
        session: "after",
        word,
        reviewers: 64,
      }).result,
      expected.rankWord(word, 64),
    );
  } finally {
    actual.currentSession?.free();
    expected.free();
  }
});

test("an overlay delta rebuilds to the same state as full evaluation", async () => {
  const { input, word, target } = await fixture();
  const overlay = {
    version: 2 as const,
    public_shun_issuer: null,
    base_view: input.selected_view,
    root_changes: [],
    trust: [],
    blocked: [],
    work: 1000,
  };
  const added = createEvent(
    seed(2),
    [],
    "9".repeat(32),
    { kind: "judgment.set", target, value: "bless" },
    null,
  );
  const fullInput = {
    ...input,
    events: [...input.events, JSON.stringify(added.envelope)],
    overlay,
  };
  const expected = evaluateSession(fullInput);
  const actual = await worker();
  try {
    actual.load({ type: "load", id: 1, session: "before", input });
    actual.advance({
      type: "advance",
      id: 2,
      base: "before",
      session: "after",
      input: { ...delta(input, added.envelope), overlay },
    });
    assert.equal(
      actual.currentSession?.updateStatistics().reason,
      "configuration_changed",
    );
    assert.deepEqual(actual.currentSession?.state, expected.state);
    assert.deepEqual(
      actual.rank({
        type: "rank",
        id: 3,
        session: "after",
        word,
        reviewers: 64,
      }).result,
      expected.rankWord(word, 64),
    );
  } finally {
    actual.currentSession?.free();
    expected.free();
  }
});

test("a failure after release leaves no session and a full load recovers", async () => {
  const { input, target } = await fixture();
  const added = createEvent(
    seed(2),
    [],
    "a".repeat(32),
    { kind: "judgment.set", target, value: "bless" },
    null,
  );
  const tampered = JSON.parse(JSON.stringify(added.envelope));
  tampered.header.nonce = "b".repeat(32);
  const fullInput = {
    ...input,
    events: [...input.events, JSON.stringify(added.envelope)],
  };
  const expected = evaluateSession(fullInput);
  const actual = await worker();
  try {
    actual.load({ type: "load", id: 1, session: "before", input });
    assert.throws(() =>
      actual.advance({
        type: "advance",
        id: 2,
        base: "before",
        session: "bad",
        input: delta(input, tampered),
      }),
    );
    assert.equal(actual.currentSession?.state, undefined);
    actual.load({
      type: "load",
      id: 3,
      session: "recovered",
      input: fullInput,
    });
    assert.deepEqual(actual.currentSession?.state, expected.state);
  } finally {
    actual.currentSession?.free();
    expected.free();
  }
});
