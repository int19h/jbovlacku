import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  initializeCore,
  createEvent,
  identityFromSeed,
  wordId,
  canonicalize,
  utf8,
  prepareAdmission,
  evaluateSession,
} from "../packages/core/src/index.ts";
await initializeCore(
  await readFile(
    new URL("../packages/core/generated/jvc_runtime_bg.wasm", import.meta.url),
  ),
);
const directory = resolve(process.argv[2] ?? "data/ranked-fixture");
await mkdir(directory, { recursive: true });
// These deterministic keys identify disposable fixtures. They do not represent imported people.
const root = new Uint8Array(32).fill(121);
const reviewer = new Uint8Array(32).fill(122);
const word = { language: "jbo", spelling: "klama" };
const makeBody = (text: string) => ({
  word,
  language: "en",
  text: [[text]],
  frame: null,
  operands: [],
  glosses: [],
  notes: [],
  etymology: { text: [], formation: null, compound: null },
  examples: [],
  classification: { kind: "gismu", selmaho: [] },
  labels: [],
  sources: [],
  license: {
    expression: "CC0-1.0",
    url: null,
    attribution: "Synthetic ranking fixture",
  },
  legacy: null,
});
const action = {
  kind: "definition.publish",
  word: wordId(word),
  language: "en",
  parents: [],
  origin: "native",
};
const first = createEvent(
  root,
  [],
  "1".repeat(32),
  action,
  makeBody("Synthetic definition endorsed through a half-weight route."),
);
const second = createEvent(
  root,
  [first.envelope.id],
  "2".repeat(32),
  action,
  makeBody("Synthetic definition endorsed directly by the view root."),
);
const view = createEvent(
  root,
  [second.envelope.id],
  "3".repeat(32),
  { kind: "view.publish", parents: [] },
  {
    name: "Synthetic trust-weighted ranking",
    description: [],
    roots: [
      { identity: identityFromSeed(root), q: { numerator: 1, denominator: 1 } },
    ],
    rafsi_threshold: { numerator: 1, denominator: 1 },
    H: { numerator: 1, denominator: 2 },
    alpha: { numerator: 1, denominator: 2 },
    excluded: [],
    calculation: "simple-routes-bounds-v1",
    work: 1000,
    import_sets: [],
    account_witnesses: [],
    account_authority: false,
    notes: [],
  },
);
const heed = createEvent(
  root,
  [view.envelope.id],
  "4".repeat(32),
  {
    kind: "trust.set",
    subject: identityFromSeed(reviewer),
    scope: { kind: "*", word: "*", language: "*" },
    value: "heed",
  },
  null,
);
const direct = createEvent(
  root,
  [heed.envelope.id],
  "5".repeat(32),
  { kind: "judgment.set", target: second.envelope.id, value: "bless" },
  null,
);
const delegated = createEvent(
  reviewer,
  [],
  "6".repeat(32),
  { kind: "judgment.set", target: first.envelope.id, value: "bless" },
  null,
);
// A second signed view over the same graph selects the route-refusal profile.
// The reviewer heeds a third key that the root shuns, and that key endorses
// the first definition. The bounds profile counts that route; the refusal
// profile refuses it at the root's shun. The smoke service selects this view.
const third = new Uint8Array(32).fill(123);
const shunView = createEvent(
  root,
  [direct.envelope.id],
  "7".repeat(32),
  { kind: "view.publish", parents: [] },
  {
    name: "Synthetic trust-weighted ranking with route refusal",
    description: [],
    roots: [
      { identity: identityFromSeed(root), q: { numerator: 1, denominator: 1 } },
    ],
    rafsi_threshold: { numerator: 1, denominator: 1 },
    H: { numerator: 1, denominator: 2 },
    alpha: { numerator: 1, denominator: 2 },
    excluded: [],
    calculation: "simple-routes-shun-v1",
    work: 1000,
    import_sets: [],
    account_witnesses: [],
    account_authority: false,
    notes: [],
  },
);
const rootShunsThird = createEvent(
  root,
  [shunView.envelope.id],
  "8".repeat(32),
  {
    kind: "trust.set",
    subject: identityFromSeed(third),
    scope: { kind: "*", word: "*", language: "*" },
    value: "shun",
  },
  null,
);
const reviewerHeedsThird = createEvent(
  reviewer,
  [delegated.envelope.id],
  "9".repeat(32),
  {
    kind: "trust.set",
    subject: identityFromSeed(third),
    scope: { kind: "*", word: "*", language: "*" },
    value: "heed",
  },
  null,
);
const thirdBless = createEvent(
  third,
  [],
  "a".repeat(32),
  { kind: "judgment.set", target: first.envelope.id, value: "bless" },
  null,
);
const events = [
  first,
  second,
  view,
  heed,
  direct,
  delegated,
  shunView,
  rootShunsThird,
  reviewerHeedsThird,
  thirdBless,
];
await writeFile(
  join(directory, "carriers.jsonl"),
  events.map((event) => canonicalize(utf8(JSON.stringify(event)))).join("\n") +
    "\n",
  { flag: "wx" },
);
const expected = {
  view: view.envelope.id,
  shunView: shunView.envelope.id,
  word: wordId(word),
  layers: [[second.envelope.id], [first.envelope.id]],
  // Under the bounds profile the third key's route through the reviewer adds
  // 1/4 to the first definition. The refusal profile refuses that route at
  // the root's shun, so the first definition keeps 1/2.
  scores: { [first.envelope.id]: "3/4", [second.envelope.id]: "1/1" },
  shunScores: { [first.envelope.id]: "1/2", [second.envelope.id]: "1/1" },
  note: "Synthetic signed judgments. Imported historical votes remain unauthenticated and are not used.",
};
await writeFile(
  join(directory, "expected.json"),
  JSON.stringify(expected, null, 2) + "\n",
  { flag: "wx" },
);
console.log(JSON.stringify({ directory, ...expected }));

const prepared = events.map((event) =>
  prepareAdmission(utf8(JSON.stringify(event))),
);
const verified: Record<string, unknown> = {};
for (const [name, selected, scores, algorithm] of [
  ["bounds", view.envelope.id, expected.scores, "simple-routes-bounds-v1"],
  ["shun", shunView.envelope.id, expected.shunScores, "simple-routes-shun-v1"],
] as const) {
  const session = evaluateSession({
    events: prepared.map((event) => event.envelope),
    bodies: Object.fromEntries(
      prepared
        .filter((event) => event.body !== null)
        .map((event) => [event.id, event.body!]),
    ),
    selected_view: selected,
    import_selections: {},
  });
  try {
    const ranking = session.rankWord(expected.word);
    assert.equal(ranking.calculation.algorithm, algorithm);
    assert.deepEqual(ranking.layers, expected.layers);
    for (const score of ranking.scores) {
      assert.deepEqual(score.net[0], score.net[1]);
      assert.equal(
        score.net[0].numerator + "/" + score.net[0].denominator,
        scores[score.target],
      );
    }
    verified[name] = ranking;
  } finally {
    session.free();
  }
}
await writeFile(
  join(directory, "verified-ranking.json"),
  JSON.stringify(verified, null, 2) + "\n",
  { flag: "wx" },
);
