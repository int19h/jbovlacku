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

test("an unclaimed account row cannot supply a selected observation", async () => {
  assert.throws(
    () =>
      validateAccountControl(
        accountRow({ current_observations: [proof] }),
        account,
        { snapshot, view },
      ),
    /invalid account evidence/,
  );
  // An unclaimed row can still carry witness contributions.
  const contributions = [
    { witness: controller, claims: [claim], observations: [proof] },
  ];
  assert.deepEqual(
    validateAccountControl(
      accountRow({ controller_candidates: [claim], contributions }),
      account,
      { snapshot, view },
    ).contributions,
    contributions,
  );
  // A controlled row keeps its selected observation.
  assert.deepEqual(
    validateAccountControl(
      accountRow({
        state: "controlled",
        controller_candidates: [claim],
        current_observations: [proof],
        contributions,
      }),
      account,
      { snapshot, view },
    ).current_observations,
    [proof],
  );
  serve(() => accountRow({ current_observations: [proof] }));
  await assert.rejects(
    getPublicationEvidence(status as never, { snapshot, view }),
    /invalid account evidence/,
  );
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

test("only a controlled row with one candidate supplies selected observations", async () => {
  const pin = { snapshot, view };
  const other = id("jve1", "9");
  // One witness group for each list of claims. The groups sort by witness.
  const groups = (...claims: string[][]) =>
    claims.map((list, i) => ({
      witness: id("ed25519", String(i + 1)),
      claims: list,
      observations: list.length
        ? [id("jve1", String.fromCharCode(97 + i))]
        : [],
    }));
  const valid = (overrides: Record<string, unknown>) =>
    validateAccountControl(accountRow(overrides), account, pin);
  // Each invalid row breaks one rule and keeps the others.
  for (const overrides of [
    // A dispute or an unavailable account selects no controller.
    {
      state: "disputed",
      controller_candidates: [claim, other],
      contributions: groups([claim], [other]),
      current_observations: [proof],
    },
    {
      state: "unavailable",
      controller_candidates: [claim],
      contributions: groups([claim]),
      current_observations: [proof],
    },
    // The state and the candidate count must agree.
    {
      state: "controlled",
      controller_candidates: [],
      current_observations: [],
    },
    {
      state: "controlled",
      controller_candidates: [claim, other],
      contributions: groups([claim], [other]),
      current_observations: [proof, other],
    },
    {
      state: "disputed",
      controller_candidates: [claim],
      contributions: groups([claim]),
    },
    {
      state: "unclaimed",
      controller_candidates: [claim, other],
      contributions: groups([claim], [other]),
    },
    // Exactly one selected observation for each current witness group.
    {
      state: "controlled",
      controller_candidates: [claim],
      contributions: groups([claim]),
      current_observations: [proof, other],
    },
    {
      state: "controlled",
      controller_candidates: [claim],
      contributions: groups([claim]),
      current_observations: [],
    },
    // The candidates are exactly the contributed claims.
    { state: "disputed", controller_candidates: [claim, other] },
    {
      state: "unavailable",
      controller_candidates: [claim],
      contributions: groups([claim], [other]),
    },
    {
      state: "unclaimed",
      controller_candidates: [claim],
      contributions: groups([]),
    },
    // A controller needs every group to claim it alone.
    {
      state: "controlled",
      controller_candidates: [claim],
      contributions: groups([claim], []),
      current_observations: [proof, other],
    },
    {
      state: "controlled",
      controller_candidates: [claim],
      current_observations: [],
    },
  ])
    assert.throws(
      () => valid(overrides),
      /invalid account evidence/,
      JSON.stringify(overrides),
    );
  for (const overrides of [
    {
      state: "controlled",
      controller_candidates: [claim],
      contributions: groups([claim]),
      current_observations: [proof],
    },
    {
      state: "controlled",
      controller_candidates: [claim],
      contributions: groups([claim], [claim]),
      current_observations: [proof, other],
    },
    {
      state: "disputed",
      controller_candidates: [claim, other],
      contributions: groups([claim, other]),
    },
    {
      state: "disputed",
      controller_candidates: [claim, other],
      contributions: groups([claim], [other], []),
    },
    {
      state: "unavailable",
      controller_candidates: [claim, other],
      contributions: groups([claim], [other]),
    },
    { state: "unavailable" },
    {
      state: "unclaimed",
      controller_candidates: [claim],
      contributions: groups([claim], []),
    },
    { state: "unclaimed", contributions: groups([]) },
  ])
    assert.doesNotThrow(() => valid(overrides), JSON.stringify(overrides));
  serve(() =>
    accountRow({
      state: "disputed",
      controller_candidates: [claim, other],
      contributions: groups([claim], [other]),
      current_observations: [proof],
    }),
  );
  await assert.rejects(
    getPublicationEvidence(status as never, pin),
    /invalid account evidence/,
  );
});

test("an account row agrees with its witness contributions", () => {
  const pin = { snapshot, view };
  const other = id("jve1", "9");
  const row = (overrides: Record<string, unknown>) =>
    validateAccountControl(accountRow(overrides), account, pin);
  const witness = (claims: string[]) => ({
    witness: controller,
    claims,
    observations: [proof],
  });
  // A controlled row without its selected observation.
  assert.throws(
    () =>
      row({
        state: "controlled",
        controller_candidates: [claim],
        contributions: [witness([claim])],
        current_observations: [],
      }),
    /invalid account evidence/,
  );
  // A controlled row whose witness claims another period.
  assert.throws(
    () =>
      row({
        state: "controlled",
        controller_candidates: [claim],
        contributions: [witness([other])],
        current_observations: [proof],
      }),
    /invalid account evidence/,
  );
  // A disputed row with no contributions.
  assert.throws(
    () => row({ state: "disputed", controller_candidates: [claim, other] }),
    /invalid account evidence/,
  );
  assert.equal(
    row({
      state: "controlled",
      controller_candidates: [claim],
      contributions: [witness([claim])],
      current_observations: [proof],
    }).state,
    "controlled",
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
