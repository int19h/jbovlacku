import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { location?: unknown }).location = {
  host: "local.test",
  origin: "http://local.test",
};
const {
  getWord,
  getIdentity,
  getPublicationEvidence,
  validateAccountControl,
  validateWord,
  setPreferredView,
  remoteSearch,
  remoteDraftSearch,
  getAccountControl,
} = await import("../../src/data/api.ts");

const id = (prefix: string, digit: string) => `${prefix}:${digit.repeat(64)}`;
const word = id("jvw1", "0");
const event = id("jve1", "1");
const proof = id("jve1", "2");
const view = id("jve1", "3");
const otherView = id("jve1", "4");
const snapshot = id("sha256", "5");
const otherSnapshot = id("sha256", "6");
const controller = id("ed25519", "7");
const claim = id("jve1", "8");
const account = { origin: "https://source.example", account: 41 };
const status = {
  event,
  state: "active",
  frontier: [],
  reasons: [],
  deciding_claim: null,
  authority: "none",
  controller: null,
  claim: null,
  account_control: account,
  account_authority_applied: true,
};
const wordResponse = (pin: { snapshot: string; view: string }) => ({
  status_version: 2,
  ...pin,
  word: { language: "jbo", spelling: "cukta" },
  definitions: [event],
  rafsi: [],
  assignments: [],
  scores: [],
  statuses: [status],
  layers: [],
  unavailable_scores: [],
  calculation: null,
});
const accountRow = (overrides: Record<string, unknown> = {}) => ({
  ...account,
  row_present: true,
  snapshot,
  view,
  state: "unclaimed",
  controller_candidates: [],
  current_observations: [],
  contributions: [],
  certificates: [],
  reasons: [],
  chain: [],
  ...overrides,
});

function serve(handler: (url: URL) => unknown) {
  const requests: URL[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://local.test");
    requests.push(url);
    return new Response(JSON.stringify(handler(url)));
  }) as typeof fetch;
  return requests;
}

test("a pinned word read rejects an answer for another snapshot or view", async () => {
  const pin = { snapshot, view };
  for (const answer of [
    { snapshot: otherSnapshot, view },
    { snapshot, view: otherView },
    { snapshot: otherSnapshot, view: otherView },
  ]) {
    const requests = serve((url) =>
      url.pathname.endsWith("/account-control")
        ? accountRow(answer)
        : wordResponse(answer),
    );
    await assert.rejects(
      getWord(word, { ...pin, fresh: true }),
      /another snapshot or view/,
    );
    assert.equal(requests.length, 1);
    assert.match(requests[0].pathname, /\/words\//);
  }
  // A rejected answer leaves no cached word behind.
  const requests = serve(() => wordResponse(pin));
  const accepted = await getWord(word, pin);
  assert.deepEqual([accepted.snapshot, accepted.view], [snapshot, view]);
  assert.equal(requests.length, 1);
});

test("a word read without a pin uses the returned snapshot and view", async () => {
  setPreferredView(null);
  serve(() => wordResponse({ snapshot: otherSnapshot, view: otherView }));
  const accepted = await getWord(word, { fresh: true });
  assert.deepEqual(
    [accepted.snapshot, accepted.view],
    [otherSnapshot, otherView],
  );
});

test("the preferred view pins a word read", async () => {
  setPreferredView(view);
  try {
    serve(() => wordResponse({ snapshot, view: otherView }));
    await assert.rejects(getWord(word), /another snapshot or view/);
    serve(() => wordResponse({ snapshot, view }));
    assert.equal((await getWord(word)).view, view);
  } finally {
    setPreferredView(null);
  }
});

test("a native status cannot carry an account reference or account fields", () => {
  const native = {
    ...status,
    authority: "native",
    controller,
    account_control: null,
    account_authority_applied: false,
  };
  const pin = { snapshot, view };
  assert.equal(
    validateWord({ ...wordResponse(pin), statuses: [native] }, word).statuses[0]
      .authority,
    "native",
  );
  for (const change of [
    { account_control: account, account_authority_applied: true },
    { account_control: account },
    { claim },
    { deciding_claim: claim },
  ])
    assert.throws(
      () =>
        validateWord(
          { ...wordResponse(pin), statuses: [{ ...native, ...change }] },
          word,
        ),
      /invalid word response/,
    );
});

test("a pinned identity read rejects an answer for another snapshot", async () => {
  const identity = {
    view,
    identity: controller,
    actor: controller,
    successor: null,
    retired: false,
    profile: { state: "none", claims: [] },
    counts: {},
  };
  serve(() => ({ ...identity, snapshot: otherSnapshot }));
  await assert.rejects(
    getIdentity(controller, { snapshot }),
    /invalid identity response/,
  );
  serve(() => ({ ...identity, snapshot }));
  assert.equal(
    (await getIdentity(controller, { snapshot })).snapshot,
    snapshot,
  );
});

test("a search for the preferred view rejects an answer for another view", async () => {
  const page = (answer: { snapshot: string; view: string }) => ({
    ...answer,
    hits: [],
    next: null,
  });
  setPreferredView(view);
  try {
    let requests = serve(() => page({ snapshot, view: otherView }));
    await assert.rejects(
      remoteSearch("cukta", "en", 10, null, null),
      /invalid search page/,
    );
    assert.equal(requests[0].searchParams.get("view"), view);
    serve(() => page({ snapshot, view: otherView }));
    await assert.rejects(
      remoteDraftSearch("cukta", "en", 10),
      /invalid search page/,
    );
    requests = serve(() => page({ snapshot: otherSnapshot, view }));
    const accepted = await remoteSearch("cukta", "en", 10, null, null);
    assert.deepEqual([accepted.snapshot, accepted.view], [otherSnapshot, view]);
  } finally {
    setPreferredView(null);
  }
  // Without a pin, the page names the view of the answer.
  serve(() => page({ snapshot, view: otherView }));
  assert.equal(
    (await remoteSearch("cukta", "en", 10, null, null)).view,
    otherView,
  );
  // A context pins both values.
  serve(() => page({ snapshot: otherSnapshot, view }));
  await assert.rejects(
    remoteSearch("cukta", "en", 10, { snapshot, view }, null),
    /invalid search page/,
  );
});

test("status account fields follow the authority and the account pass", () => {
  const pin = { snapshot, view };
  const check = (fields: Record<string, unknown>) =>
    validateWord(
      { ...wordResponse(pin), statuses: [{ ...status, ...fields }] },
      word,
    );
  const base = {
    account_control: null,
    account_authority_applied: false,
    controller: null,
    claim: null,
    deciding_claim: null,
  };
  const valid = [
    { ...base, authority: "native", controller },
    { ...base, authority: "none" },
    { ...base, authority: "none", account_control: account },
    { ...base, authority: "uncertain" },
    {
      ...base,
      authority: "source-account",
      account_control: account,
      account_authority_applied: true,
      controller,
      claim,
    },
    {
      ...base,
      authority: "source-account",
      account_control: account,
      account_authority_applied: true,
      controller,
      claim,
      deciding_claim: claim,
    },
    {
      ...base,
      authority: "none",
      account_control: account,
      account_authority_applied: true,
    },
    {
      ...base,
      authority: "none",
      account_control: account,
      account_authority_applied: true,
      claim,
      deciding_claim: claim,
    },
    {
      ...base,
      authority: "uncertain",
      account_control: account,
      account_authority_applied: true,
    },
    {
      ...base,
      authority: "uncertain",
      account_control: account,
      account_authority_applied: true,
      controller,
      claim,
    },
  ];
  const invalid = [
    // Without the account pass.
    { ...base, authority: "native" },
    { ...base, authority: "none", controller },
    { ...base, authority: "none", account_control: account, claim },
    {
      ...base,
      authority: "none",
      account_control: account,
      deciding_claim: claim,
    },
    { ...base, authority: "uncertain", controller },
    { ...base, authority: "uncertain", account_control: account },
    { ...base, authority: "source-account" },
    {
      ...base,
      authority: "source-account",
      account_control: account,
      controller,
      claim,
    },
    // With the account pass.
    {
      ...base,
      authority: "source-account",
      account_authority_applied: true,
      controller,
      claim,
    },
    {
      ...base,
      authority: "source-account",
      account_control: account,
      account_authority_applied: true,
      claim,
    },
    {
      ...base,
      authority: "source-account",
      account_control: account,
      account_authority_applied: true,
      controller,
    },
    {
      ...base,
      authority: "none",
      account_control: account,
      account_authority_applied: true,
      controller,
    },
    {
      ...base,
      authority: "native",
      account_control: account,
      account_authority_applied: true,
      controller,
    },
    { ...base, authority: "uncertain", account_authority_applied: true },
    // After the account pass, a controller always comes with its period.
    {
      ...base,
      authority: "uncertain",
      account_control: account,
      account_authority_applied: true,
      controller,
    },
  ];
  for (const fields of valid)
    assert.doesNotThrow(() => check(fields), JSON.stringify(fields));
  for (const fields of invalid)
    assert.throws(
      () => check(fields),
      /invalid word response/,
      JSON.stringify(fields),
    );
});

const other = id("jve1", "9");
const obs = (digit: string) => id("jve1", digit);
const group = (n: number, claims: string[], observations: string[]) => ({
  witness: id("ed25519", String(n)),
  claims,
  observations,
});
/** A row as the evaluator writes it for one controller and two witnesses. */
const controlledRow = (): Record<string, any> => ({
  state: "controlled",
  controller_candidates: [claim],
  chain: [claim],
  contributions: [
    group(1, [claim], [obs("a"), obs("b")]),
    group(2, [claim], [obs("c")]),
  ],
  current_observations: [obs("a"), obs("c")],
  certificates: [{ policy: view, claim, observations: [obs("d")] }],
});
const pinFor = { snapshot, view };
const checkRow = (overrides: Record<string, unknown>) =>
  validateAccountControl(accountRow(overrides), account, pinFor);
let peerNumber = 0;
/** A fresh peer, so the account cache never serves an earlier case. */
const freshPeer = () => ({
  peer: {
    id: `case-${++peerNumber}`,
    base: "http://local.test/api/v1",
    label: "case",
  },
});

test("account rows that the evaluator can write pass", () => {
  const rows: Record<string, unknown>[] = [
    controlledRow(),
    { ...controlledRow(), certificates: [] },
    {
      state: "disputed",
      controller_candidates: [claim, other],
      contributions: [
        group(1, [claim], [obs("a")]),
        group(2, [other], [obs("c")]),
      ],
    },
    {
      state: "disputed",
      controller_candidates: [claim, other],
      contributions: [group(1, [claim, other], [obs("a"), obs("b")])],
    },
    {
      state: "unclaimed",
      controller_candidates: [claim],
      contributions: [group(1, [claim], [obs("a")]), group(2, [], [])],
    },
    { state: "unclaimed", contributions: [group(1, [], [])] },
    { state: "unclaimed" },
    {
      state: "unavailable",
      controller_candidates: [claim],
      contributions: [group(1, [claim], [obs("a")])],
    },
    {
      state: "unavailable",
      controller_candidates: [claim, other],
      contributions: [
        group(1, [claim], [obs("a")]),
        group(2, [other], [obs("c")]),
      ],
    },
    { state: "unavailable" },
  ];
  for (const row of rows)
    assert.doesNotThrow(() => checkRow(row), JSON.stringify(row));
});

test("account rows that the evaluator cannot write fail", () => {
  const base = controlledRow();
  const [first, second] = base.contributions;
  const cases: [string, Record<string, unknown>][] = [
    // Selected observations exist only for a controller.
    [
      "unclaimed selection",
      { state: "unclaimed", current_observations: [proof] },
    ],
    [
      "disputed selection",
      {
        state: "disputed",
        controller_candidates: [claim, other],
        contributions: [
          group(1, [claim], [obs("a")]),
          group(2, [other], [obs("c")]),
        ],
        current_observations: [obs("a")],
      },
    ],
    [
      "unavailable selection",
      {
        state: "unavailable",
        controller_candidates: [claim],
        contributions: [group(1, [claim], [obs("a")])],
        current_observations: [obs("a")],
      },
    ],
    // Candidate counts for each state.
    [
      "controlled without a candidate",
      { ...base, controller_candidates: [], chain: [] },
    ],
    [
      "disputed with one candidate",
      {
        state: "disputed",
        controller_candidates: [claim],
        contributions: [group(1, [claim], [obs("a")]), group(2, [], [])],
      },
    ],
    [
      "unclaimed with two candidates",
      {
        state: "unclaimed",
        controller_candidates: [claim, other],
        contributions: [
          group(1, [claim], [obs("a")]),
          group(2, [other], [obs("c")]),
        ],
      },
    ],
    // The candidates are the union of the group claims.
    [
      "disputed without contributions",
      { state: "disputed", controller_candidates: [claim, other] },
    ],
    [
      "candidate that no group claims",
      { ...base, controller_candidates: [claim, other] },
    ],
    // A group's claims come from its own observations.
    [
      "claim without observations",
      {
        ...base,
        contributions: [group(1, [claim], []), second],
        current_observations: [obs("c")],
      },
    ],
    // Each observation belongs to one witness.
    [
      "shared observation",
      {
        ...base,
        contributions: [first, group(2, [claim], [obs("a")])],
        current_observations: [obs("a")],
      },
    ],
    // An available unanimous set selects its candidate.
    [
      "unanimous but unclaimed",
      { ...base, state: "unclaimed", current_observations: [] },
    ],
    // A controller needs every group to claim it alone.
    [
      "controlled with an empty group",
      {
        ...base,
        contributions: [first, group(2, [], [])],
        current_observations: [obs("a")],
      },
    ],
    [
      "controlled with another period",
      { ...base, contributions: [first, group(2, [other], [obs("c")])] },
    ],
    [
      "controlled without groups",
      { ...base, contributions: [], current_observations: [] },
    ],
    // The controller belongs to the chain.
    ["controller outside the chain", { ...base, chain: [] }],
    // Every certificate has evidence.
    [
      "empty certificate",
      { ...base, certificates: [{ policy: view, claim, observations: [] }] },
    ],
    // The selection is the first maximal observation of each group.
    ["missing selection", { ...base, current_observations: [obs("a")] }],
    ["no selection", { ...base, current_observations: [] }],
    [
      "second observation selected",
      { ...base, current_observations: [obs("b"), obs("c")] },
    ],
    [
      "selection outside every group",
      { ...base, current_observations: [obs("a"), obs("e")] },
    ],
  ];
  for (const [name, row] of cases)
    assert.throws(() => checkRow(row), /invalid account evidence/, name);
});

test("evidence for an applied status names the account's selected period", async () => {
  const applied = {
    ...status,
    authority: "source-account",
    controller,
    claim,
  };
  serve(() => accountRow(controlledRow()));
  const evidence = await getPublicationEvidence(
    applied as never,
    pinFor,
    freshPeer(),
  );
  assert.deepEqual(evidence.controller_candidates, [claim]);
  assert.deepEqual(evidence.observations, [obs("a"), obs("c")]);
  // A status for another period than the controller.
  serve(() => accountRow(controlledRow()));
  await assert.rejects(
    getPublicationEvidence(
      { ...applied, claim: other } as never,
      pinFor,
      freshPeer(),
    ),
    /different periods/,
  );
  // A status without a period while the account has a controller.
  serve(() => accountRow(controlledRow()));
  await assert.rejects(
    getPublicationEvidence(
      { ...applied, authority: "none", controller: null, claim: null } as never,
      pinFor,
      freshPeer(),
    ),
    /different periods/,
  );
  // A status with a period while the account has no controller.
  const disputed = {
    state: "disputed",
    controller_candidates: [claim, other],
    contributions: [
      group(1, [claim], [obs("a")]),
      group(2, [other], [obs("c")]),
    ],
  };
  serve(() => accountRow(disputed));
  await assert.rejects(
    getPublicationEvidence(
      { ...applied, authority: "none", controller: null } as never,
      pinFor,
      freshPeer(),
    ),
    /different periods/,
  );
  // An inherited deciding claim may differ from the period.
  serve(() => accountRow(controlledRow()));
  await getPublicationEvidence(
    { ...applied, deciding_claim: other } as never,
    pinFor,
    freshPeer(),
  );
  // Without the account pass, the status claim is not compared.
  serve(() => accountRow(disputed));
  const unapplied = await getPublicationEvidence(
    { ...status, account_authority_applied: false } as never,
    pinFor,
    freshPeer(),
  );
  assert.deepEqual(unapplied.observations, []);
  assert.equal(unapplied.witness_contributions.length, 2);
});

test("account and word reads keep the pin that they sent", async () => {
  // A caller changes its pin while the account request runs.
  const pin = { snapshot, view };
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const requests: URL[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://local.test");
    requests.push(url);
    await held;
    return new Response(
      JSON.stringify(
        accountRow({ ...controlledRow(), snapshot: otherSnapshot }),
      ),
    );
  }) as typeof fetch;
  const peer = freshPeer();
  const pending = getAccountControl(account, pin, peer);
  (pin as { snapshot: string }).snapshot = otherSnapshot;
  release();
  await assert.rejects(pending, /invalid account evidence/);
  assert.equal(requests[0].searchParams.get("snapshot"), snapshot);

  // A caller cannot change the shared answer for later readers.
  serve(() => accountRow(controlledRow()));
  const shared = freshPeer();
  const first = await getAccountControl(account, { snapshot, view }, shared);
  assert.throws(() => {
    (first as { snapshot: string }).snapshot = otherSnapshot;
  });
  assert.throws(() => (first.current_observations as string[]).pop());
  assert.throws(() => (first.contributions[0].observations as string[]).pop());
  const second = await getAccountControl(account, { snapshot, view }, shared);
  assert.equal(second.snapshot, snapshot);
  assert.deepEqual(second.current_observations, [obs("a"), obs("c")]);

  // A word read keeps its snapshot option, and callers get separate copies.
  const options = { snapshot, view, fresh: true };
  let answer = wordResponse({ snapshot: otherSnapshot, view });
  serve(() => answer);
  const read = getWord(word, options);
  options.snapshot = otherSnapshot;
  await assert.rejects(read, /another snapshot or view/);
  answer = wordResponse({ snapshot, view });
  serve(() => answer);
  const one = await getWord(word, { snapshot, view });
  one.statuses.length = 0;
  (one as { snapshot: string }).snapshot = otherSnapshot;
  const two = await getWord(word, { snapshot, view });
  assert.equal(two.snapshot, snapshot);
  assert.equal(two.statuses.length, 1);

  // A search keeps its context snapshot.
  const context = { snapshot, view };
  serve(() => ({ snapshot: otherSnapshot, view, hits: [], next: null }));
  const search = remoteSearch("cukta", "en", 10, context, null);
  context.snapshot = otherSnapshot;
  await assert.rejects(search, /invalid search page/);

  // An identity read keeps its snapshot option.
  const identityOptions = { snapshot };
  serve(() => ({
    snapshot: otherSnapshot,
    view,
    identity: controller,
    actor: controller,
    successor: null,
    retired: false,
    profile: { state: "none", claims: [] },
    counts: {},
  }));
  const identityRead = getIdentity(controller, identityOptions);
  identityOptions.snapshot = otherSnapshot;
  await assert.rejects(identityRead, /invalid identity response/);
});
