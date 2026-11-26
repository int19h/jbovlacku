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
import { readFileSync } from "node:fs";

/** Rows and statuses copied from real evaluator output (state export version 2). */
const evaluated = JSON.parse(
  readFileSync(
    new URL("./fixtures/evaluator-account-rows.json", import.meta.url),
    "utf8",
  ),
) as Record<string, { source: string; row: any; status?: any }>;

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

test("account and word reads keep the pin that they sent", async () => {
  const real = realRow("controlled");
  // A caller changes its pin while the account request runs.
  const pin = { snapshot, view: real.pin.view };
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const requests: URL[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://local.test");
    requests.push(url);
    await held;
    return new Response(
      JSON.stringify({ ...real.row, snapshot: otherSnapshot }),
    );
  }) as typeof fetch;
  const pending = getAccountControl(real.key, pin, freshPeer());
  (pin as { snapshot: string }).snapshot = otherSnapshot;
  release();
  await assert.rejects(pending, /invalid account evidence/);
  assert.equal(requests[0].searchParams.get("snapshot"), snapshot);

  // A caller cannot change the shared answer for later readers.
  serve(() => real.row);
  const shared = freshPeer();
  const first = await getAccountControl(real.key, real.pin, shared);
  assert.throws(() => {
    (first as { snapshot: string }).snapshot = otherSnapshot;
  });
  assert.throws(() => (first.current_observations as string[]).pop());
  assert.throws(() => (first.contributions[0].observations as string[]).pop());
  const second = await getAccountControl(real.key, { ...real.pin }, shared);
  assert.equal(second.snapshot, snapshot);
  assert.deepEqual(second.current_observations, real.row.current_observations);

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

/** A real row as the account endpoint sends it, with its key and pin. */
function realRow(name: string) {
  const { row } = structuredClone(evaluated[name]);
  return {
    row: { ...row, snapshot, row_present: true },
    key: { origin: row.origin, account: row.account },
    pin: { snapshot, view: row.view },
  };
}

test("account rows that the evaluator wrote pass", () => {
  for (const name of [
    "controlled",
    "disputed",
    "unclaimed_empty",
    "unavailable_candidate",
    "unavailable_empty",
  ]) {
    const { row, key, pin } = realRow(name);
    assert.doesNotThrow(() => validateAccountControl(row, key, pin), name);
  }
});

/** A real applied status with its real row, served to the evidence reader. */
function realJoin(name: string) {
  const { status, row } = structuredClone(evaluated[name]);
  return {
    status,
    row: { ...row, snapshot, row_present: true },
    pin: { snapshot, view: row.view },
  };
}
async function join(
  status: unknown,
  row: unknown,
  pin: { snapshot: string; view: string },
) {
  serve(() => row);
  return getPublicationEvidence(status as never, pin, freshPeer());
}

test("evidence joins accept the statuses and rows that the evaluator wrote", async () => {
  for (const name of [
    "direct",
    "inherited",
    "selection_conflict",
    "applied_unavailable",
    "applied_disputed",
  ]) {
    const { status, row, pin } = realJoin(name);
    const evidence = await join(status, row, pin);
    assert.deepEqual(
      evidence.controller_candidates,
      row.controller_candidates,
      name,
    );
    assert.deepEqual(evidence.observations, row.current_observations, name);
  }
  // An inherited decision names an earlier period of the chain.
  const inherited = realJoin("inherited");
  assert.notEqual(inherited.status.deciding_claim, inherited.status.claim);
  assert.ok(inherited.status.frontier.length > 0);
  assert.ok(inherited.row.chain.includes(inherited.status.deciding_claim));
});

test("evidence joins reject statuses that the account pass cannot write", async () => {
  const ff = "jve1:" + "f".repeat(64);
  const cases: [string, string, (status: any) => void][] = [
    // The status claim is the account's selected period.
    ["another period", "direct", (s) => (s.claim = ff)],
    ["no period with a controller", "direct", (s) => (s.claim = null)],
    [
      "a period without a controller",
      "applied_disputed",
      (s) => (s.claim = ff),
    ],
    // A deciding period belongs to the account chain.
    [
      "deciding period outside the chain",
      "inherited",
      (s) => (s.deciding_claim = ff),
    ],
    [
      "deciding period outside the chain",
      "direct",
      (s) => (s.deciding_claim = ff),
    ],
    // With one candidate and a frontier, a period decides the status.
    ["no deciding period", "direct", (s) => (s.deciding_claim = null)],
    // Without a decision, there is no deciding period.
    [
      "deciding period in a dispute",
      "applied_disputed",
      (s) => (s.deciding_claim = evaluated.applied_disputed.row.chain[0]),
    ],
    ["deciding period without a frontier", "direct", (s) => (s.frontier = [])],
    // An unavailable account makes the publication unavailable.
    [
      "active with an unavailable account",
      "applied_unavailable",
      (s) => (s.state = "active"),
    ],
    [
      "frontier with an unavailable account",
      "applied_unavailable",
      (s) => (s.frontier = [evaluated.direct.status.frontier[0]]),
    ],
  ];
  for (const [label, name, change] of cases) {
    const { status, row, pin } = realJoin(name);
    change(status);
    await assert.rejects(
      join(status, row, pin),
      /different periods/,
      `${label} (${name})`,
    );
  }
});

test("the evidence reader uses the publication that it received", async () => {
  const { status, row, pin } = realJoin("direct");
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  globalThis.fetch = (async () => {
    await held;
    return new Response(JSON.stringify(row));
  }) as typeof fetch;
  const caller = structuredClone(status);
  const pending = getPublicationEvidence(caller, pin, freshPeer());
  // The caller changes its object while the request runs.
  caller.account_authority_applied = false;
  caller.claim = "jve1:" + "f".repeat(64);
  caller.account_control = null;
  release();
  const evidence = await pending;
  assert.deepEqual(evidence.observations, row.current_observations);
  assert.deepEqual(evidence.controller_candidates, row.controller_candidates);
});

test("an explicit search context needs both pins", async () => {
  const requests = serve(() => ({ snapshot, view, hits: [], next: null }));
  for (const context of [
    { snapshot: "", view },
    { snapshot, view: "" },
  ])
    await assert.rejects(
      remoteSearch("cukta", "en", 10, context, null),
      /search context is incomplete|invalid search page/,
      JSON.stringify(context),
    );
  assert.equal(requests.length, 0);
  // A null context still finds the current snapshot.
  serve(() => ({
    snapshot: otherSnapshot,
    view: otherView,
    hits: [],
    next: null,
  }));
  assert.equal(
    (await remoteSearch("cukta", "en", 10, null, null)).snapshot,
    otherSnapshot,
  );
});

test("word and identity reads keep the peer that they started with", async () => {
  const first = {
    id: "first-peer",
    base: "http://first.test/api/v1",
    label: "first",
  };
  const second = {
    id: "second-peer",
    base: "http://second.test/api/v1",
    label: "second",
  };
  let requests = serve(() => wordResponse({ snapshot, view }));
  const options = { fresh: true, view, peer: first };
  const read = getWord(word, options);
  // The caller changes its options during the materialization wait.
  options.peer = second;
  await read;
  assert.equal(requests[0].host, "first.test");
  requests = serve(() => ({
    snapshot,
    view,
    identity: controller,
    actor: controller,
    successor: null,
    retired: false,
    profile: { state: "none", claims: [] },
    counts: {},
  }));
  const identityOptions = { fresh: true, peer: first };
  const identityRead = getIdentity(controller, identityOptions);
  identityOptions.peer = second;
  await identityRead;
  assert.equal(requests[0].host, "first.test");
});
