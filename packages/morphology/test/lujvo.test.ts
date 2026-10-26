import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type {
  LujvoRequest,
  LujvoComponentRequest,
  MorphologyProfile,
} from "../../core/src/index.ts";
import {
  analyzeWord,
  bond,
  bondProfile,
  buildLujvo,
  buildLujvoWithDetailBudget,
  score,
  tosmabru,
  segmentCll,
  validate,
  validateChecked,
  rowChoices,
  rowChoicesWithParser,
  isBrivlaCore,
  RecognitionBudget,
  addConflictDetails,
  classicTokens,
} from "../src/lujvo.ts";
import type { Part } from "../src/lujvo.ts";
import { BuilderError, resource } from "../src/errors.ts";
import { DetailBudget } from "../src/detail-budget.ts";

const rafsi = (forms: string[]): Part[] =>
  forms.map((text) => ({ text, kind: "rafsi" }));
const core = (text: string): Part => ({ text, kind: "core" });
const component = (
  id: string,
  spelling: string,
  forms: string[] = [],
  kind = "gismu",
): LujvoComponentRequest => ({
  id,
  spelling,
  kind,
  claims: forms.map((rafsi) => ({ rafsi, pair: `pair-${rafsi}` })),
});
const request = (profile: MorphologyProfile = "cll"): LujvoRequest => ({
  profile,
  components: [
    component("a", "cukta", ["cku"]),
    component("b", "sinxa", ["sni"]),
  ],
});
const resourceFailure =
  (measure?: string) =>
  (error: unknown): boolean =>
    error instanceof BuilderError &&
    error.failure.kind === "resource-limit" &&
    (measure === undefined || error.failure.measure === measure);
function rebuild(word: string): LujvoRequest {
  const analysis = analyzeWord("extended", word);
  assert.equal(analysis.kind, "lujvo", `${word}: ${analysis.diagnostics}`);
  const reading = analysis.readings[0];
  return {
    profile: "extended",
    joins: reading.slice(1).map((part) => part.join_before ?? ""),
    components: reading.map((part, index) => ({
      id: String(index),
      spelling: part.text,
      kind: "other",
      locked: part.text,
    })),
  };
}

test("version 2 keeps its base whole-word core", () => {
  const built = buildLujvo({
    profile: "extended-v2",
    components: [
      component("a", "ckusni", [], "lujvo"),
      component("b", "broda"),
    ],
  });
  assert.equal(built.morphology.version, "2");
  assert.equal(built.candidates[0].spelling, "ckusni'ybroda");
  assert.deepEqual(built.candidates[0].tokens, ["ckusni", "'y", "broda"]);
  assert.equal(
    analyzeWord("extended-v2", "ckusni'ybroda").readings[0][0].text,
    "ckusni",
  );
});

test("version 3 keeps the reviewed boundaries and consonantal cores", () => {
  for (const word of [
    "sakli'ybroda",
    "gismu'ybroda",
    "ixla'ybroda",
    "uspi'ybe'a",
    "baibla'ykla",
    "bai'ybla'ykla",
    "saibla'ykla",
    "islenskygu'e",
    "islenskybroda",
    "ibalskybroda",
    "kerlyxambrga",
    "cuktybangrtai",
    "bangu'ybangrtai",
    "bamzda",
    "kamzi'ybroda",
  ]) {
    const built = buildLujvo(rebuild(word));
    assert.ok(built.candidates.length > 0, `${word}: ${JSON.stringify(built)}`);
    assert.equal(built.candidates[0].spelling, word);
  }
  for (const word of [
    "balskybroda",
    "lenskybroda",
    "tenskybroda",
    "bangrybroda",
    "barklysakli",
    "balskykla",
    "bla'ykla",
  ])
    assert.equal(analyzeWord("extended", word).kind, "unknown", word);
  for (const word of [
    "bangrtai",
    "xambrga",
    "cmagnitude",
    "depsnce",
    "regnaftngi",
    "sparnribia",
  ])
    assert.equal(analyzeWord("extended", word).kind, "fuhivla", word);
  assert.equal(analyzeWord("extended", "kamzi").kind, "gismu");
  assert.equal(analyzeWord("extended", "djeimz").kind, "cmevla");
  for (const profile of ["cll", "extended-v2"] as const)
    for (const word of ["kamzi", "bamzda", "djeimz"])
      assert.equal(
        analyzeWord(profile, word).kind,
        "unknown",
        `${profile} ${word}`,
      );
});

test("exact readings rebuild with optional and extended joins", () => {
  for (const word of [
    "ckusni",
    "cuktysinxa",
    "sairzba",
    "bangu'y'ismu",
    "sakrsakysakli",
    "spageti'ybroda",
    "spageti'ykla",
    "kerlybai'ybroda",
    "kerlybla'ykla",
    "spageiybroda",
    "kerlyfa'u'yiismu",
    "klama'ybroda",
    "aktyiismu",
  ]) {
    const built = buildLujvo(rebuild(word));
    assert.equal(
      built.candidates.length,
      1,
      `${word}: ${JSON.stringify(built.rejected)}`,
    );
    assert.equal(built.candidates[0].spelling, word);
    assert.equal(built.candidates[0].tokens.join(""), word);
    assert.equal(built.morphology.version, "3");
  }
});

test("typed presentation keeps exact bytes and requires the exact parse", () => {
  const input: LujvoRequest = {
    profile: "extended",
    joins: ["r"],
    spelling: "SAI,rZBA",
    components: [
      { id: "a", spelling: "sai", kind: "other", locked: "sai" },
      { id: "b", spelling: "zba", kind: "other", locked: "zba" },
    ],
  };
  const result = buildLujvo(input);
  assert.equal(result.candidates[0].spelling, "SAI,rZBA");
  assert.deepEqual(result.candidates[0].tokens, ["SAI,", "r", "ZBA"]);
  assert.equal(result.candidates[0].score, score(["sai", "r", "zba"]));
  input.spelling = ".SAI,rZBA.";
  const framed = buildLujvo(input);
  assert.equal(framed.candidates[0].tokens.join(""), input.spelling);
  assert.equal(framed.candidates[0].recovered[0].text, "sai");
  for (const spelling of ["..SAI,rZBA.", "ckusni"])
    assert.equal(buildLujvo({ ...input, spelling }).candidates.length, 0);
  assert.throws(
    () => buildLujvo({ ...input, spelling: "b".repeat(129) }),
    resourceFailure("typed spelling bytes"),
  );
  for (const profile of ["cll", "extended-v2"] as const)
    assert.throws(
      () => buildLujvo({ ...input, profile }),
      /typed spelling needs the extended profile/,
    );
  assert.throws(
    () => buildLujvo({ ...input, spelling: " sairzba" }),
    /no outer whitespace/,
  );
});

test("CLL examples and version 2 have independent expectations", () => {
  for (const [word, cll, v2] of [
    ["jbogri", "lujvo", "lujvo"],
    ["tolsakli", "lujvo", "lujvo"],
    ["tosymabru", "lujvo", "lujvo"],
    ["ckusni", "lujvo", "lujvo"],
    ["ckusni'ybroda", "unknown", "lujvo"],
    ["spageti'ybroda", "unknown", "lujvo"],
    ["kamzi", "unknown", "unknown"],
    ["bangu", "gismu", "gismu"],
  ]) {
    assert.equal(analyzeWord("cll", word).kind, cll, word);
    assert.equal(analyzeWord("extended-v2", word).kind, v2, word);
  }
  const evidence = JSON.parse(
    readFileSync(
      new URL(
        "../evidence/typed-lujvo.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  for (const item of evidence.cases)
    assert.equal(
      analyzeWord(
        "extended",
        item.kind === "cmevla"
          ? item.word.replace(/^\.+|\.+$/g, "")
          : item.word,
      ).kind,
      item.kind,
      item.word,
    );
});

test("locks reject empty forms and standalone joins at either position", () => {
  for (const locked of ["", "y", "y'", "'y", "'y'", "r", "n"])
    for (const joins of [[], [null], [""], ["y"]])
      for (const position of [0, 1]) {
        const input: LujvoRequest = {
          profile: "extended",
          joins,
          components: [
            { id: "a", spelling: "bau", kind: "other", locked: "bau" },
            { id: "b", spelling: "kla", kind: "other", locked: "kla" },
          ],
        };
        input.components[position].spelling = locked;
        input.components[position].locked = locked;
        assert.throws(() => buildLujvo(input), /component lock/);
      }
});

test("explicit joins reject omitted required joins and invalid join lists", () => {
  for (const joins of [[""], ["r"]])
    assert.equal(
      buildLujvo({
        profile: "extended",
        joins,
        components: [
          { ...component("a", "cukta"), locked: "cukt" },
          { ...component("b", "sinxa"), locked: "sinxa" },
        ],
      }).candidates.length,
      0,
    );
  assert.throws(
    () => buildLujvo({ ...request(), joins: ["y", "y"] }),
    /Explicit joins/,
  );
  for (const joins of [["q"], ["y", "y"]])
    assert.throws(
      () => buildLujvo({ ...request("extended"), joins }),
      /Choose one permitted join/,
    );
});

test("bond inserts the CLL initial CVV and consonant joins", () => {
  for (const [forms, tokens] of [
    [
      ["bau", "gri", "kla"],
      ["bau", "r", "gri", "kla"],
    ],
    [
      ["bau", "rok"],
      ["bau", "n", "rok"],
    ],
    [
      ["sai", "cli"],
      ["sai", "cli"],
    ],
    [
      ["jbon", "bau"],
      ["jbon", "y", "bau"],
    ],
    [
      ["cukt", "sni"],
      ["cukt", "y", "sni"],
    ],
    [
      ["jun", "dji"],
      ["jun", "y", "dji"],
    ],
    [
      ["tos", "mabru"],
      ["tos", "y", "mabru"],
    ],
    [
      ["tol", "sakli"],
      ["tol", "sakli"],
    ],
  ])
    assert.deepEqual(bond(rafsi(forms)), tokens);
  assert.equal(bond(rafsi(["", "jbo"])), null);
  assert.equal(bond(rafsi(["jbo"])), null);
  assert.equal(bond(rafsi(Array(65).fill("jbo"))), null);
  assert.equal(bond(rafsi(["a".repeat(129), "jbo"])), null);
  assert.equal(tosmabru(["tos", "mabru"]), true);
  assert.equal(tosmabru(["tos", "mal", "y", "broda"]), true);
  assert.equal(tosmabru(["tos", "mab"]), false);
  assert.equal(tosmabru([]), false);
});

test("scores match CLL section 4.12 examples", () => {
  for (const [tokens, expected] of [
    [["zba", "sai"], 5847],
    [["nun", "y", "nau"], 6967],
    [["sai", "r", "zba", "ta'u"], 10385],
    [["zba", "zbas", "y", "sarji"], 12976],
  ] as const)
    assert.equal(score(tokens), expected);
});

test("classic segmentation accepts lujvo and rejects other forms", () => {
  for (const word of [
    "jbogri",
    "rokyre'o",
    "basykla",
    "saircli",
    "soirsai",
    "ro'inre'o",
    "ckusni",
    "cuktysni",
    "saicli",
    "tolsakli",
    "tosymabru",
    "bangyjbari",
    "vlaste",
  ])
    assert.ok(segmentCll(word).length > 0, word);
  for (const word of [
    "babau",
    "soisai",
    "xlamkai",
    "xlaglymlu",
    "kerlyu'ukerlo",
    "tosmabru",
    "sakli",
    "cukta",
  ])
    assert.deepEqual(segmentCll(word), [], word);
  assert.deepEqual(segmentCll("cuktysni"), [["cukt", "y", "sni"]]);
  assert.deepEqual(segmentCll("ckusni"), [["cku", "sni"]]);
  assert.deepEqual(segmentCll("bauryo'a"), []);
  assert.deepEqual(segmentCll("ro'inre'o"), [["ro'i", "n", "re'o"]]);
});

test("extended cores require a successful parse back", () => {
  const positives: Part[][] = [
    [...rafsi(["akt"]), core("iismu")],
    [...rafsi(["ful"]), core("ismu")],
    [...rafsi(["gim"]), core("iismu")],
    [...rafsi(["tce", "nel"]), core("iismu")],
    [core("jenjigu"), ...rafsi(["di'e"])],
  ];
  for (const parts of positives) {
    const tokens = bond(parts)!;
    const parsed = validate("extended", parts, tokens);
    assert.deepEqual(
      parsed.map((part) => part.text),
      parts.map((part) => part.text),
    );
    assert.deepEqual(
      analyzeWord("extended", tokens.join("")).readings[0],
      parsed,
    );
    assert.notEqual(analyzeWord("cll", tokens.join("")).kind, "lujvo");
    assert.throws(() => validate("cll", parts, tokens));
  }
  for (const parts of [
    [...rafsi(["bau"]), core("ismu")],
    [...rafsi(["gim"]), core("spageti")],
    [core("leksiko"), core("ismu")],
    [core("fulta"), core("ismu")],
  ])
    assert.throws(() => validate("extended", parts, bond(parts)!));
  assert.equal(bond(positives[0])!.join(""), "aktyiismu");
  assert.equal(bond(positives[1])!.join(""), "fuly'ismu");
  assert.equal(bond(positives[2])!.join(""), "gimyiismu");
  assert.equal(bond(positives[4])!.join(""), "jenjigu'ydi'e");
});

test("builder keeps long choices beside short ones and reports conflicts", () => {
  const input = request();
  input.components[0].claims![0].pair = "jvr1:a";
  input.components[1].claims![0].pair = "jvr1:b";
  input.inventory = {
    claims: [
      { rafsi: "cku", word: "jvw1:x", spelling: "cukta", pair: "jvr1:a" },
      { rafsi: "sni", word: "jvw1:z", spelling: "snime", pair: "jvr1:zz" },
    ],
  };
  const result = buildLujvo(input);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.spelling),
    ["ckusni", "ckusinxa", "cuktysni", "cuktysinxa"],
  );
  assert.equal(result.candidates[0].score, 5858);
  assert.deepEqual(result.candidates[2].tokens, ["cukt", "y", "sni"]);
  assert.equal(result.candidates[0].conflicts.length, 1);
  assert.equal(result.candidates[0].conflicts[0].spelling, "snime");
  assert.deepEqual(result.candidates[0].unlisted, ["sni"]);
  assert.ok(
    result.rows[0].choices.some(
      (choice) => choice.origin === "stem" && choice.form === "cukt",
    ),
  );
  assert.ok(
    result.rows[0].choices.some(
      (choice) => choice.origin === "final" && choice.form === "cukta",
    ),
  );
});

test("locks restrict choices and explain invalid positions", () => {
  const input = request();
  input.components[0].locked = "cukt";
  assert.deepEqual(
    buildLujvo(input).candidates.map((candidate) => candidate.spelling),
    ["cuktysni", "cuktysinxa"],
  );
  input.components[0].locked = "cukta";
  const misplaced = buildLujvo(input);
  assert.equal(misplaced.candidates.length, 0);
  assert.ok(
    misplaced.diagnostics.some((message) =>
      message.includes("cannot stand in position 1"),
    ),
  );
  input.components[0].locked = "zzz";
  const invalid = buildLujvo(input);
  assert.equal(invalid.rows[0].lock_valid, false);
  assert.equal(invalid.candidates.length, 0);
});

test("repeated components stay separate and cmavo need claims", () => {
  const result = buildLujvo({
    profile: "cll",
    components: [
      component("a", "kerlo", ["ker"]),
      component("b", "kerlo", ["ker"]),
    ],
  });
  assert.ok(
    result.candidates.some((candidate) => candidate.spelling === "kerkerlo"),
  );
  assert.ok(
    result.candidates.every((candidate) => candidate.parts.length === 2),
  );
  const cmavo = component("c", "ka", [], "cmavo");
  const row = rowChoices("cll", cmavo);
  assert.equal(row.choices.length, 0);
  assert.match(row.diagnostics[0], /combining form/);
  cmavo.claims = [{ rafsi: "kam", pair: "k" }];
  assert.equal(rowChoices("cll", cmavo).choices.length, 1);
});

test("work limit refuses before enumerating the choice product", () => {
  assert.throws(
    () =>
      buildLujvo({
        profile: "cll",
        components: Array.from({ length: 8 }, (_, index) =>
          component(String(index), "sakli", [
            "kli",
            "sa'i",
            "sai",
            "sak",
            "sal",
            "ska",
          ]),
        ),
        limits: { choice_product: 1000, results: 8 },
      }),
    resourceFailure("choice combinations"),
  );
});

test("analysis keeps word classes, normalized forms, and joins", () => {
  for (const [word, kind] of [
    ["sakli", "gismu"],
    ["ckusni", "lujvo"],
    ["ka'a", "cmavo"],
    ["djan", "cmevla"],
    ["iismu", "fuhivla"],
    ["aaaa", "unknown"],
    ["leksiko", "fuhivla"],
  ])
    assert.equal(analyzeWord("cll", word).kind, kind, word);
  assert.equal(analyzeWord("cll", "djan.").normalized, null);
  assert.deepEqual(
    analyzeWord("cll", "ckusni").readings[0].map((part) => part.text),
    ["cku", "sni"],
  );
  assert.equal(analyzeWord("cll", "cuktysni").readings[0][1].join_before, "y");
});

test("version 2 and CLL keep the mz refusal", () => {
  for (const profile of ["cll", "extended-v2"] as const) {
    for (const word of ["cimza'a", "lemzasli", "kamzu", "mamza", "ka,m,zu"]) {
      const analysis = analyzeWord(profile, word);
      assert.equal(analysis.kind, "unknown", word);
      assert.deepEqual(analysis.readings, []);
      assert.ok(analysis.diagnostics.length > 0);
      assert.equal(isBrivlaCore(word), false);
    }
    const parts = rafsi(["cim", "za'a"]),
      tokens = bond(parts)!;
    assert.deepEqual(tokens, ["cim", "y", "za'a"]);
    assert.doesNotThrow(() => validate(profile, parts, tokens));
    const invalid = [...rafsi(["kam"]), core("kamzu")];
    assert.throws(() => validate(profile, invalid, bond(invalid)!));
    assert.deepEqual(rowChoices(profile, component("mz", "kamzu")).choices, []);
  }
  assert.deepEqual(segmentCll("cimza'a"), []);
  assert.deepEqual(bondProfile("extended", rafsi(["cim", "za'a"])), [
    "cim",
    "za'a",
  ]);
});

test("six-part builds return a sorted parsed window", () => {
  const components = [
    ["sakli", ["sal", "sak", "ska", "sa'i"]],
    ["bridi", ["bri", "bid", "ri'i"]],
    ["klama", ["kla", "lam"]],
    ["blaci", ["bla", "lac", "bai"]],
    ["cukta", ["cku", "cuk"]],
    ["sinxa", ["sni", "sin"]],
  ] as const;
  for (const profile of ["cll", "extended"] as const) {
    const input: LujvoRequest = {
      profile,
      components: components.map(([spelling, forms], index) =>
        component(String(index), spelling, [...forms]),
      ),
    };
    const result = buildLujvo(input);
    assert.equal(result.considered, 1440);
    assert.equal(result.complete, true);
    assert.equal(result.candidates.length, 64);
    for (let index = 1; index < result.candidates.length; index++) {
      const a = result.candidates[index - 1],
        b = result.candidates[index];
      assert.ok(
        a.score < b.score || (a.score === b.score && a.spelling <= b.spelling),
      );
    }
    for (const candidate of result.candidates)
      assert.deepEqual(
        validate(
          profile,
          rafsi(candidate.parts.map((part) => part.form)),
          candidate.tokens,
        ),
        candidate.recovered,
      );
    assert.deepEqual(
      buildLujvo({ ...input, limits: { results: 8 } }).candidates,
      result.candidates.slice(0, 8),
    );
  }
});

test("malformed clusters are neither words nor cores", () => {
  assert.equal(analyzeWord("cll", "sakrsakysakli").kind, "unknown");
  assert.equal(
    analyzeWord("extended", "sakrsakysakli").readings[0][0].text,
    "sakrsak",
  );
  for (const word of [
    "sabkysakli",
    "rsakli",
    "ntadi",
    "leksiko'yismu",
    "fulta'yismu",
  ]) {
    for (const profile of ["cll", "extended"] as const)
      assert.equal(analyzeWord(profile, word).kind, "unknown", word);
    assert.equal(isBrivlaCore(word), false, word);
  }
  assert.equal(analyzeWord("extended", "gimspageti").kind, "fuhivla");
  assert.equal(analyzeWord("extended", "baurismu").kind, "unknown");
});

test("optional hyphens are accepted in analysis and refused by automatic construction", () => {
  assert.deepEqual(segmentCll("sairzba"), [["sai", "r", "zba"]]);
  assert.equal(analyzeWord("cll", "sairzba").kind, "lujvo");
  const parts = rafsi(["sai", "zba"]);
  assert.throws(
    () => validate("cll", parts, ["sai", "r", "zba"]),
    /required construction joins/,
  );
  assert.doesNotThrow(() => validate("cll", parts, bond(parts)!));
});

test("recognition and score inputs have fixed byte and token bounds", () => {
  for (const count of [8, 12, 16, 24, 30]) {
    const analysis = analyzeWord("cll", "sakr".repeat(count) + "sakli");
    assert.equal(analysis.kind, "fuhivla");
    assert.deepEqual(analysis.readings, []);
  }
  assert.throws(
    () => segmentCll("sakr".repeat(40)),
    resourceFailure("word bytes"),
  );
  assert.throws(
    () => score(["a".repeat(2_200_000)]),
    resourceFailure("score bytes"),
  );
  assert.throws(
    () => score(Array(129).fill("a")),
    resourceFailure("score tokens"),
  );
  assert.match(
    analyzeWord("cll", "é".repeat(65)).diagnostics[0],
    /word bytes is 130/,
  );
});

test("retained reference parses keep profile-specific results", () => {
  const evidence = JSON.parse(
    readFileSync(
      new URL(
        "../evidence/word-parses.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  for (const item of evidence.cases)
    for (const [name, profile] of [
      ["cll-ebnf", "cll"],
      ["bpfk", "extended"],
    ] as const) {
      const expected =
        item.jbotci_kind === "lujvo" && item[name].ok === false
          ? "unknown"
          : item.jbotci_kind;
      const analysis = analyzeWord(profile, item.word);
      assert.equal(analysis.kind, expected, `${name} ${item.word}`);
      if (analysis.kind === "lujvo")
        assert.deepEqual(
          analysis.readings[0].flatMap((part) =>
            part.join_before === null
              ? [part.text]
              : [part.join_before, part.text],
          ),
          item.jbotci_tokens,
          `${name} ${item.word}`,
        );
    }
});

test("builder rejects a false extended winner before filling the result window", () => {
  const input: LujvoRequest = {
    profile: "extended",
    components: [
      component("a", "bangu", ["bau", "ban"]),
      component("b", "ismu", [], "fuhivla"),
    ],
    limits: { results: 1 },
  };
  const result = buildLujvo(input);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].spelling, "bany'ismu");
  assert.ok(
    result.rejected.some((candidate) => candidate.spelling === "baurismu"),
  );
  for (const candidate of result.candidates)
    assert.deepEqual(
      candidate.recovered.map((part) => part.text),
      candidate.parts.map((part) => part.form),
    );
});

test("failed candidate recognition charges shared work", () => {
  const parts = [...rafsi(["bau"]), core("ismu")],
    tokens = bond(parts)!,
    budget = new RecognitionBudget();
  assert.throws(() => validateChecked("extended", parts, tokens, budget, true));
  assert.ok(budget.spent > 0);
  budget.spent = 2_000_000;
  assert.throws(
    () => validateChecked("extended", parts, tokens, budget, true),
    resourceFailure("build recognition work"),
  );
});

test("core cache preserves work and resource failures", () => {
  const budget = new RecognitionBudget();
  assert.equal(budget.coreIsBrivla("ismu", "extended-v2"), true);
  assert.ok(budget.spent > 0);
  budget.spent = 2_000_000;
  assert.equal(budget.coreIsBrivla("ismu", "extended-v2"), true);
  assert.equal(budget.spent, 2_000_000);
  assert.throws(
    () => budget.coreIsBrivla("iismu", "extended-v2"),
    (error) =>
      resourceFailure("build recognition work")(error) &&
      (error as Error).message.includes("Lock a component form"),
  );
  assert.equal(budget.cores.has("iismu"), false);
  assert.throws(
    () => budget.coreIsBrivla("a".repeat(129), "extended-v2"),
    resourceFailure("word bytes"),
  );
  assert.equal(budget.cores.has("a".repeat(129)), false);
});

test("classic fu'ivla analysis states its scope", () => {
  for (const word of ["ismu", "leksiko"]) {
    const classic = analyzeWord("cll", word),
      extended = analyzeWord("extended", word);
    assert.equal(classic.kind, "fuhivla");
    assert.equal(extended.kind, "fuhivla");
    assert.ok(
      classic.diagnostics.some(
        (message) =>
          message.includes("extended jbotci lineage") &&
          message.includes("does not establish CLL validity"),
      ),
    );
    assert.deepEqual(extended.diagnostics, []);
  }
});

test("row work exhaustion stays distinct from a linguistic rejection", () => {
  const input = { ...component("a", "ismu", [], "fuhivla"), locked: "ismu" };
  const row = rowChoicesWithParser("extended", input, () =>
    resource("recognition work", 2, 1),
  );
  assert.deepEqual(row.choices, []);
  assert.equal(row.lock_valid, true);
  assert.equal(row.recognition_incomplete, true);
  assert.ok(
    row.diagnostics.some(
      (message) =>
        message.includes("recognition is incomplete") &&
        message.includes("recognition work"),
    ),
  );
  assert.ok(
    row.diagnostics.every(
      (message) =>
        !message.includes("not a brivla") &&
        !message.includes("not one of this component's choices"),
    ),
  );
});

test("component work exhaustion preserves listed locked rafsi", () => {
  for (const profile of ["cll", "extended"] as const) {
    const input: LujvoRequest = {
      profile,
      components: [
        {
          ...component("a", "tca".repeat(40), ["bau"], "lujvo"),
          locked: "bau",
        },
        { ...component("b", "sinxa", ["sni"]), locked: "sni" },
      ],
    };
    const analysis = analyzeWord(profile, input.components[0].spelling);
    assert.equal(analysis.kind, "unknown");
    assert.ok(
      analysis.diagnostics.some((message) =>
        message.includes("recognition work"),
      ),
    );
    const result = buildLujvo(input);
    assert.equal(result.rows[0].lock_valid, true);
    assert.ok(result.rows[0].choices.some((choice) => choice.form === "bau"));
    assert.ok(
      result.rows[0].diagnostics.some((message) =>
        message.includes("recognition is incomplete"),
      ),
    );
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.spelling),
      ["bausni"],
    );
    assert.deepEqual(
      result.candidates[0].recovered.map((part) => part.text),
      ["bau", "sni"],
    );
  }
});

test("whole-word locks on exhausted recognition preserve listed rafsi", () => {
  for (const profile of ["cll", "extended"] as const) {
    const spelling = "tca".repeat(40);
    const input: LujvoRequest = {
      profile,
      components: [
        { ...component("a", spelling, ["bau"], "lujvo"), locked: spelling },
        { ...component("b", "sinxa", ["sni"]), locked: "sni" },
      ],
    };
    const result = buildLujvo(input),
      row = result.rows[0];
    assert.equal(row.lock_valid, profile === "extended");
    assert.equal(row.recognition_incomplete, true);
    assert.ok(
      row.diagnostics.some((message) =>
        message.includes(
          "Candidates use the listed rafsi until recognition finishes.",
        ),
      ),
    );
    assert.ok(
      row.diagnostics.some((message) =>
        message.includes(
          profile === "extended"
            ? "The whole-word lock waits for complete recognition."
            : "The whole-word lock is invalid under the CLL profile.",
        ),
      ),
    );
    assert.ok(row.choices.every((choice) => choice.form !== spelling));
    assert.equal(input.components[0].locked, spelling);
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.spelling),
      ["bausni"],
    );
    input.components[0].locked = "zzz";
    const invalid = buildLujvo(input);
    assert.equal(invalid.rows[0].lock_valid, false);
    assert.deepEqual(invalid.candidates, []);
    assert.ok(
      invalid.rows[0].diagnostics.some((message) =>
        message.includes("not one of this component's choices"),
      ),
    );
    input.components[0].locked = spelling;
    input.components[1].locked = "sinx";
    const misplaced = buildLujvo(input);
    assert.equal(misplaced.rows[1].lock_valid, true);
    assert.deepEqual(misplaced.candidates, []);
    assert.ok(
      misplaced.diagnostics.some((message) =>
        message.includes("cannot stand in position 2"),
      ),
    );
  }
});

test("only shared build recognition failures give lock advice", () => {
  for (const measure of ["recognition work", "build recognition work"]) {
    try {
      resource(measure, 2, 1);
      assert.fail();
    } catch (error) {
      assert.equal(
        (error as Error).message.includes("Lock a component form."),
        measure === "build recognition work",
      );
      assert.equal((error as Error).message.includes("fewer results"), false);
    }
  }
});

test("apostrophe-y-apostrophe is one extended join", () => {
  for (const first of ["bangu", "fulta", "leksiko", "spageti"]) {
    const word = `${first}'y'ismu`,
      analysis = analyzeWord("extended", word);
    assert.equal(analysis.kind, "lujvo", word);
    assert.equal(analysis.readings.length, 1);
    assert.equal(analysis.readings[0].length, 2);
    assert.deepEqual(
      analysis.readings[0].map((part) => [part.text, part.join_before]),
      [
        [first, null],
        ["ismu", "'y'"],
      ],
    );
    assert.equal(analyzeWord("cll", word).kind, "unknown");
    assert.deepEqual(segmentCll(word), []);
  }
  assert.equal(classicTokens(["bau", "'y'", "sakli"]), false);
});

test("extended part kinds depend on the final component position", () => {
  for (const [word, first, last, join] of [
    ["bangu'ysakli", "bangu", "sakli", "'y"],
    ["gerku'ymlatu", "gerku", "mlatu", "'y"],
    ["bangu'y'ismu", "bangu", "ismu", "'y'"],
  ]) {
    const analysis = analyzeWord("extended", word);
    assert.equal(analysis.kind, "lujvo");
    assert.deepEqual(analysis.readings[0][0], {
      text: first,
      kind: "core",
      join_before: null,
    });
    assert.deepEqual(analysis.readings[0].at(-1), {
      text: last,
      kind: last === "ismu" ? "core" : "rafsi",
      join_before: join,
    });
  }
  assert.ok(
    analyzeWord("cll", "cuktysinxa").readings[0].every(
      (part) => part.kind === "rafsi",
    ),
  );
});

test("candidate work exhaustion refuses the complete build", () => {
  for (const profile of ["cll", "extended"] as const)
    assert.throws(
      () =>
        buildLujvo({
          profile,
          components: Array.from({ length: 40 }, (_, index) => ({
            ...component(String(index), "ta", ["tca"], "cmavo"),
            locked: "tca",
          })),
        }),
      (error) =>
        resourceFailure("recognition work")(error) &&
        (error as BuilderError).failure.value === 50_001 &&
        (error as BuilderError).failure.limit === 50_000,
    );
});

function conflictRequest(): LujvoRequest {
  return {
    ...request(),
    inventory: {
      claims: Array.from({ length: 2 }, (_, index) => ({
        rafsi: "cku",
        word: `word-${index}`,
        spelling: "test",
        pair: `other-${index}`,
      })),
    },
    limits: { choice_product: 20_000, results: 1 },
  };
}

test("conflicts are copied only for selected candidates", () => {
  const input = conflictRequest();
  const result = buildLujvoWithDetailBudget(
    input,
    new DetailBudget(100, 2, 1000),
  );
  assert.equal(result.considered, 4);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].conflicts.length, 2);
  input.limits!.results = 2;
  assert.throws(
    () => buildLujvoWithDetailBudget(input, new DetailBudget(100, 2, 1000)),
    resourceFailure("conflict detail rows"),
  );
});

test("conflict preflight refuses before copying any result details", () => {
  const input = conflictRequest(),
    result = buildLujvo(input);
  for (const candidate of result.candidates) {
    candidate.conflicts = [];
    candidate.unlisted = [];
  }
  for (const budget of [
    new DetailBudget(100, 1, 1000),
    new DetailBudget(100, 10, 1),
    new DetailBudget(1, 10, 1000),
  ]) {
    assert.throws(
      () => addConflictDetails(result.candidates, input.inventory!, budget),
      resourceFailure(),
    );
    assert.ok(
      result.candidates.every(
        (candidate) =>
          candidate.conflicts.length === 0 && candidate.unlisted.length === 0,
      ),
    );
  }
});

test("rows normalize claims, reject unsupported shapes, and retain first claim identity", () => {
  const row = rowChoices(
    "cll",
    component("row", "CU,KTA", ["CKU", "cku", "q", "cukta", "cua"]),
  );
  assert.equal(row.normalized, "cukta");
  assert.equal(row.choices.filter((choice) => choice.form === "cku").length, 1);
  assert.equal(
    row.choices.find((choice) => choice.form === "cku")!.pair,
    "pair-CKU",
  );
  assert.ok(
    row.diagnostics.some((message) =>
      message.includes('"q" is not Lojban letters'),
    ),
  );
  assert.ok(
    row.diagnostics.some((message) =>
      message.includes('"cukta" is not a short rafsi shape'),
    ),
  );
  assert.ok(
    row.diagnostics.some((message) =>
      message.includes('"cua" is not a short rafsi shape'),
    ),
  );
  assert.equal(
    rowChoices("cll", component("a", "broda")).choices.some(
      (choice) => choice.form === "brod",
    ),
    false,
  );
  assert.ok(
    rowChoices("cll", component("a", "not-a-word")).diagnostics.some(
      (message) => message.includes("outside Lojban letters"),
    ),
  );
  assert.ok(
    rowChoices("cll", component("a", "kamzu")).diagnostics.some((message) =>
      message.includes("no automatic long forms"),
    ),
  );
  assert.ok(
    rowChoices("cll", component("a", "djan", [], "cmevla")).diagnostics.some(
      (message) => message.includes("A name has no combining form"),
    ),
  );
  assert.ok(
    rowChoices(
      "cll",
      component("a", "leksiko", [], "fuhivla"),
    ).diagnostics.some((message) =>
      message.includes("only under the extended profile"),
    ),
  );
  assert.equal(
    rowChoices("extended-v2", component("a", "leksiko", [], "fuhivla"))
      .choices[0].origin,
    "core",
  );
});

test("construction and validation preserve each resource diagnostic", () => {
  assert.throws(
    () => buildLujvo({ profile: "cll", components: [] }),
    /2 through 64/,
  );
  assert.throws(
    () =>
      buildLujvo({
        ...request(),
        components: [component("a", "a".repeat(129)), component("b", "sinxa")],
      }),
    resourceFailure("component bytes"),
  );
  assert.throws(
    () =>
      buildLujvo({
        ...request(),
        components: [
          component("a", "cukta", Array(65).fill("cku")),
          component("b", "sinxa"),
        ],
      }),
    resourceFailure("component claims"),
  );
  assert.throws(
    () =>
      buildLujvo({
        ...request(),
        components: [
          { ...component("a", "cukta"), locked: "a".repeat(129) },
          component("b", "sinxa"),
        ],
      }),
    resourceFailure("locked rafsi bytes"),
  );
  assert.throws(
    () =>
      buildLujvo({
        ...request(),
        components: [
          component("a", "cukta", ["a".repeat(129)]),
          component("b", "sinxa"),
        ],
      }),
    resourceFailure("rafsi bytes"),
  );
  assert.throws(
    () =>
      buildLujvo({
        ...request(),
        inventory: {
          claims: Array(20_001).fill({
            rafsi: "cku",
            word: "w",
            spelling: "cukta",
            pair: "p",
          }),
        },
      }),
    resourceFailure("inventory claims"),
  );
  assert.throws(
    () => validate("cll", rafsi(Array(65).fill("cku")), []),
    resourceFailure("validation parts"),
  );
  assert.throws(
    () => validate("cll", [], Array(129).fill("cku")),
    resourceFailure("validation tokens"),
  );
  assert.throws(
    () => validate("cll", rafsi(["a".repeat(129)]), []),
    resourceFailure("component bytes"),
  );
  assert.throws(
    () => validate("cll", [], ["a".repeat(129)]),
    resourceFailure("token bytes"),
  );
  const overlong = rafsi(Array(40).fill("cku"));
  overlong.push(...rafsi(["sni", "sni", "sni"]));
  assert.throws(
    () => validate("cll", overlong, bond(overlong)!),
    resourceFailure("word bytes"),
  );
  assert.equal(
    rowChoices("cll", component("a", "a".repeat(129))).lock_valid,
    false,
  );
  assert.equal(
    buildLujvo({ ...request(), limits: { results: 0 } }).considered,
    4,
  );
  assert.deepEqual(
    buildLujvo({ ...request(), limits: { results: 0 } }).candidates,
    [],
  );
  assert.throws(
    () => buildLujvo({ ...rebuild("sairzba"), spelling: "\u0085sairzba" }),
    /no outer whitespace/,
  );
  assert.equal(
    buildLujvo({ ...rebuild("sairzba"), spelling: "\ufeffsairzba" }).candidates
      .length,
    0,
  );
});
