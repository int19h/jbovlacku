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
    validateAccountControl(accountRow({ contributions }), account, {
      snapshot,
      view,
    }).contributions,
    contributions,
  );
  // A controlled row keeps its selected observation.
  assert.deepEqual(
    validateAccountControl(
      accountRow({
        state: "controlled",
        controller_candidates: [claim],
        current_observations: [proof],
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
