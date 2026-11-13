import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  canonicalize,
  createEvaluationSession,
  createEvent,
  evaluateSession,
  identityFromSeed,
  initializeCore,
  projectRecord,
  utf8,
  wordId,
  type EvaluationRequest,
} from "../../../../packages/core/src/index.ts";
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
  return { input, word, target: d.envelope.id, previous: j.envelope.id };
}

function delta(input: EvaluationRequest, envelope: unknown): EvaluationRequest {
  return {
    events: [JSON.stringify(envelope)],
    bodies: {},
    selected_view: input.selected_view,
    import_selections: input.import_selections,
  };
}

type TestWorker = EvaluationWorker & {
  load(message: any): Promise<any>;
};
let loading: EvaluationRequest | null = null;
async function worker(): Promise<TestWorker> {
  const { EvaluationWorker } = await import("../../src/workers/evaluate.ts");
  const actual = new EvaluationWorker(
    async (_source, builder) => {
      const input = loading!;
      for (const envelope of input.events)
        builder.addRecordText(envelope, input.bodies[JSON.parse(envelope).id]);
      return { count: input.events.length, bytesRead: 0, digest: "test" };
    },
    createEvaluationSession,
    async () => {},
  );
  return new Proxy(actual, {
    get(target, property, receiver) {
      if (property === "load")
        return async (message: any) => {
          const { events, bodies, ...options } =
            message.input as EvaluationRequest;
          loading = message.input;
          return target.load({
            ...message,
            source: {
              database: "test",
              snapshot: message.session,
              events_digest: "test",
              count: events.length,
            },
            options,
          });
        };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as TestWorker;
}
function assertSession(
  actual: EvaluationWorker,
  expected: ReturnType<typeof evaluateSession>,
) {
  assert.deepEqual(
    (actual.currentSession as unknown as { state: unknown } | undefined)?.state,
    expected.state,
  );
  assert.deepEqual(actual.currentSession?.summary(), {
    available: expected.state.available,
    reasons: expected.state.reasons,
    selected_view: expected.state.selected_view,
    events: expected.summary().events,
  });
  assert.deepEqual(
    actual.currentSession?.actors(),
    (expected.state.lifecycle as { key_actor: Record<string, string> })
      .key_actor,
  );
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
  const { input, word, target, previous } = await fixture();
  const added = createEvent(
    seed(2),
    [previous],
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
    await actual.load({ type: "load", id: 1, session: "before", input });
    const projected = projectRecord(utf8(JSON.stringify(added.envelope)));
    const loaded = await actual.advance({
      type: "advance",
      id: 2,
      base: "before",
      session: "after",
      input: { ...delta(input, added.envelope), events: [] },
      source: {
        database: "test",
        snapshot: "test",
        events_digest: "test",
        count: fullInput.events.length,
      },
      rows: [{ id: added.envelope.id, row: projected.row, bodyRetained: true }],
    });
    assert.equal(loaded.events, fullInput.events.length);
    assertSession(actual, expected);
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

test("a layout-split advance refreshes the full state and ranking without a delta", async () => {
  const { input, word, target } = await fixture();
  const added = createEvent(
    seed(2),
    [],
    "d".repeat(32),
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
    await actual.load({ type: "load", id: 1, session: "before", input });
    const previousSummary = actual.currentSession?.summary();
    const previousRank = actual.rank({
      type: "rank",
      id: 2,
      session: "before",
      word,
      reviewers: 64,
    }).result;
    await actual.advance({
      type: "advance",
      id: 3,
      base: "before",
      session: "after",
      input: delta(input, added.envelope),
    });
    assert.deepEqual(actual.currentSession?.updateStatistics(), {
      incremental_records: 0,
      rebuilt: true,
      reason: "layout_split",
    });
    assert.notDeepEqual(actual.currentSession?.summary(), previousSummary);
    assertSession(actual, expected);
    const refreshedRank = actual.rank({
      type: "rank",
      id: 4,
      session: "after",
      word,
      reviewers: 64,
    }).result;
    assert.deepEqual(refreshedRank, expected.rankWord(word, 64));
    assert.notDeepEqual(refreshedRank, previousRank);
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
    await actual.load({ type: "load", id: 1, session: "before", input });
    await actual.advance({
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
    assertSession(actual, expected);
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
    await actual.load({
      type: "load",
      id: 4,
      session: "snapshot",
      input: fullInput,
    });
    assertSession(actual, expected);
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
    await actual.load({ type: "load", id: 1, session: "before", input });
    await actual.advance({
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
    assertSession(actual, expected);
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
    await actual.load({ type: "load", id: 1, session: "before", input });
    const summary = actual.currentSession?.summary();
    await assert.rejects(
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
    assert.deepEqual(actual.currentSession?.summary(), summary);
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
    await actual.load({ type: "load", id: 1, session: "before", input });
    await actual.advance({
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
    assertSession(actual, expected);
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
    await actual.load({ type: "load", id: 1, session: "before", input });
    await actual.advance({
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
    assertSession(actual, expected);
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
    await actual.load({ type: "load", id: 1, session: "before", input });
    await assert.rejects(() =>
      actual.advance({
        type: "advance",
        id: 2,
        base: "before",
        session: "bad",
        input: delta(input, tampered),
      }),
    );
    assert.equal(actual.currentSession, null);
    await actual.load({
      type: "load",
      id: 3,
      session: "recovered",
      input: fullInput,
    });
    assertSession(actual, expected);
  } finally {
    actual.currentSession?.free();
    expected.free();
  }
});

test("an unchanged overlay keeps a judgment advance on the fast path", async () => {
  const { input, word, target, previous } = await fixture();
  const overlay = {
    version: 2 as const,
    public_shun_issuer: null,
    base_view: input.selected_view,
    root_changes: [],
    trust: [],
    blocked: [],
    work: 1000,
  };
  const baseInput = { ...input, overlay };
  const added = createEvent(
    seed(2),
    [previous],
    "c".repeat(32),
    { kind: "judgment.set", target, value: "curse" },
    null,
  );
  const fullInput = {
    ...baseInput,
    events: [...baseInput.events, JSON.stringify(added.envelope)],
  };
  const expected = evaluateSession(fullInput);
  const actual = await worker();
  try {
    await actual.load({
      type: "load",
      id: 1,
      session: "before",
      input: baseInput,
    });
    await actual.advance({
      type: "advance",
      id: 2,
      base: "before",
      session: "after",
      input: { ...delta(baseInput, added.envelope), overlay },
    });
    assert.deepEqual(actual.currentSession?.updateStatistics(), {
      incremental_records: 1,
      rebuilt: false,
      reason: null,
    });
    assertSession(actual, expected);
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

test("a WebAssembly RuntimeError is fatal and an ordinary Error is not", async () => {
  const { workerErrorResponse } = await import("../../src/workers/evaluate.ts");
  const fatal = workerErrorResponse(1, new WebAssembly.RuntimeError("trap"));
  assert.equal(fatal.type, "error");
  assert.equal(fatal.fatal, true);
  assert.equal(workerErrorResponse(2, new Error("ordinary")).fatal, false);
});

test("setImportSelection on load and omitted import_selections on fork preserve import selections across advance", async () => {
  const { input, word, target, previous } = await fixture();
  const selectionCanonical = canonicalize(utf8(JSON.stringify([target])));
  const selectionHash =
    "sha256:" +
    (
      await import("../../../../packages/core/src/index.ts")
    )
      .contentHash(utf8(selectionCanonical))
      .slice(7);
  const added = createEvent(
    seed(2),
    [previous],
    "e".repeat(32),
    { kind: "judgment.set", target, value: "curse" },
    null,
  );
  const fullInput = {
    ...input,
    events: [...input.events, JSON.stringify(added.envelope)],
    import_selections: { [selectionHash]: [target] },
  };
  const expected = evaluateSession(fullInput);
  const builder = createEvaluationSession({
    selected_view: input.selected_view,
  });
  let baseSession: ReturnType<typeof evaluateSession> | null = null;
  let advancedSession: ReturnType<typeof evaluateSession> | null = null;
  try {
    builder.setImportSelection(selectionHash, selectionCanonical);
    for (const envelope of input.events) {
      const id = (JSON.parse(envelope) as { id: string }).id;
      builder.addRecordText(envelope, input.bodies[id], id);
    }
    baseSession = builder.finish();
    const forkBuilder = baseSession.fork({
      selected_view: input.selected_view,
    });
    try {
      forkBuilder.addRecordText(
        JSON.stringify(added.envelope),
        undefined,
        added.envelope.id,
      );
      advancedSession = forkBuilder.finish();
    } finally {
      forkBuilder.free();
    }
    assert.deepEqual(advancedSession.updateStatistics(), {
      incremental_records: 1,
      rebuilt: false,
      reason: null,
    });
    assert.deepEqual(advancedSession.state, expected.state);
    assert.deepEqual(
      advancedSession.rankWord(word, 64),
      expected.rankWord(word, 64),
    );
  } finally {
    builder.free();
    baseSession?.free();
    advancedSession?.free();
    expected.free();
  }
});
