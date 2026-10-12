/**
 * Seeds a running test service with synthetic signed records. Disposable
 * seeds only. The script prints the fixture as JSON for tests.
 *
 * Usage: node --import tsx apps/web/test/seed.ts http://127.0.0.1:8820 [out.json]
 */
import { readFile, writeFile } from "node:fs/promises";
import {
  initializeCore,
  createEvent,
  identityFromSeed,
  wordId,
  canonicalize,
  utf8,
  contentHash,
  prepareSelection,
} from "../../../packages/core/src/index.ts";

export async function buildFixture(origin: string) {
  const seed = (n: number) => new Uint8Array(32).fill(n);
  const nonce = (n: number) => n.toString(16).padStart(32, "0");
  const rootA = seed(201);
  const rootB = seed(202);
  const curator = seed(203);
  const delegate = seed(204);
  const author = seed(205);
  const importer = seed(206);
  const ids = {
    rootA: identityFromSeed(rootA),
    rootB: identityFromSeed(rootB),
    curator: identityFromSeed(curator),
    delegate: identityFromSeed(delegate),
    author: identityFromSeed(author),
    importer: identityFromSeed(importer),
  };
  const word = (spelling: string) => ({ language: "jbo" as const, spelling });
  const place = (index: number, gloss: string, description: string) => ({
    index,
    glosses: gloss ? [{ language: "en", text: gloss, sense: null }] : [],
    description: description ? [[description]] : [],
    type_hints: [],
    defaults: [],
    constraints: [],
    derivation: [],
  });
  const body = (
    spelling: string,
    text: (string | number)[][],
    options: Partial<Record<string, unknown>> = {},
  ) => ({
    word: word(spelling),
    language: "en",
    text,
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
      url: "https://creativecommons.org/publicdomain/zero/1.0/",
      attribution: "",
    },
    legacy: null,
    ...options,
  });
  const publish = (
    spelling: string,
    parents: string[] = [],
    origin: "native" | "import" = "native",
  ) => ({
    kind: "definition.publish",
    word: wordId(word(spelling)),
    language: "en",
    parents,
    origin,
  });
  let counter = 1;
  const events: { envelope: { id: string }; body: unknown }[] = [];
  function sign(
    key: Uint8Array,
    previous: string[],
    action: Record<string, unknown>,
    content: unknown | null,
  ) {
    const event = createEvent(key, previous, nonce(counter++), action, content);
    events.push(event);
    return event;
  }
  // Three competing definitions of cukta, with places, glosses, and notes.
  const cukta1 = sign(
    curator,
    [],
    publish("cukta"),
    body(
      "cukta",
      [
        [
          1,
          " is a book containing work ",
          2,
          " by author ",
          3,
          " for audience ",
          4,
          " preserved in medium ",
          5,
          ".",
        ],
      ],
      {
        frame: {
          role: "predicate",
          arity: { mode: "fixed", count: 5 },
          places: [
            place(1, "book", "the book"),
            place(2, "work", "the work it contains"),
            place(3, "author", ""),
            place(4, "audience", ""),
            place(5, "medium", ""),
          ],
          tail: null,
          constraints: [],
        },
        glosses: [{ language: "en", text: "book", sense: null }],
        notes: [
          [
            "Not for a notebook. See ",
            { word: word("ckusro"), label: "ckusro" },
            " for a library.",
          ],
        ],
      },
    ),
  );
  const cukta2 = sign(
    delegate,
    [],
    publish("cukta"),
    body(
      "cukta",
      [["Competing meaning: ", 1, " is a written volume about ", 2, "."]],
      {
        frame: {
          role: "predicate",
          arity: { mode: "fixed", count: 2 },
          places: [place(1, "", ""), place(2, "topic", "")],
          tail: null,
          constraints: [],
        },
        glosses: [{ language: "en", text: "volume", sense: "bound" }],
      },
    ),
  );
  const cukta3 = sign(
    author,
    [],
    publish("cukta"),
    body("cukta", [["Third meaning without judgments from anyone trusted."]]),
  );
  // A revision of the first definition by another identity.
  const cuktaRev = sign(
    delegate,
    [cukta2.envelope.id],
    publish("cukta", [cukta1.envelope.id]),
    body(
      "cukta",
      [
        [
          1,
          " is a book containing work ",
          2,
          " by author ",
          3,
          " for audience ",
          4,
          " preserved in medium ",
          5,
          ".",
        ],
      ],
      {
        frame: {
          role: "predicate",
          arity: { mode: "fixed", count: 5 },
          places: [
            place(1, "book", "the book"),
            place(2, "work", "the work it contains"),
            place(3, "author", "the author"),
            place(4, "audience", "the intended audience"),
            place(5, "medium", "the medium"),
          ],
          tail: null,
          constraints: [],
        },
        glosses: [{ language: "en", text: "written work", sense: null }],
      },
    ),
  );
  // A lujvo with compound evidence and a cmavo with selma'o.
  const vlacku = sign(
    curator,
    [cukta1.envelope.id],
    publish("vlacku"),
    body(
      "vlacku",
      [[1, " is a dictionary concerning ", 2, " authored by ", 3, "."]],
      {
        classification: { kind: "lujvo", selmaho: [] },
        frame: {
          role: "predicate",
          arity: { mode: "fixed", count: 3 },
          places: [
            place(1, "dictionary", ""),
            place(2, "subject", ""),
            place(3, "author", ""),
          ],
          tail: null,
          constraints: [],
        },
        glosses: [{ language: "en", text: "dictionary", sense: null }],
        etymology: {
          text: [["From valsi and cukta."]],
          formation: null,
          compound: {
            components: [
              { word: word("valsi"), definition: null, rafsi: "vla" },
              {
                word: word("cukta"),
                definition: cukta1.envelope.id,
                rafsi: "cku",
              },
            ],
            morphology: {
              id: "https://jbovlacku.invalid/morphology/cll",
              version: "test",
            },
            scoring: {
              id: "https://jbovlacku.invalid/scoring/cll",
              version: "test",
            },
            score: 7917,
            notes: [],
          },
        },
      },
    ),
  );
  const lo = sign(
    curator,
    [vlacku.envelope.id],
    publish("lo"),
    body(
      "lo",
      [["Descriptor: the one or more that really are what is described."]],
      {
        classification: { kind: "cmavo", selmaho: ["LE"] },
        glosses: [{ language: "en", text: "the", sense: "veridical" }],
      },
    ),
  );
  // An imported definition with source attribution and unknown rights.
  const imported = sign(
    importer,
    [],
    publish("ckusro", [], "import"),
    body("ckusro", [["x1 is a library of books x2."]], {
      classification: { kind: "lujvo", selmaho: [] },
      glosses: [{ language: "en", text: "library", sense: null }],
      license: {
        expression: "unknown",
        url: null,
        attribution: "Lensisku source author unknown",
      },
      legacy: {
        source: "https://lensisku.invalid",
        snapshot: "sha256:" + "a".repeat(64),
        extraction: "test-extraction-1",
        record: { kind: "definition", id: 42 },
        locator: "definitions/42",
        original: { definition: "x1 is a library of books x2." },
        attribution: {
          author: "arj",
          editor: null,
          author_account: {
            origin: "https://lensisku.invalid",
            account: 8,
            username: "arj",
            evidence: {
              kind: "source-id",
              source: {
                label: "Lensisku API definition 42 user_id",
                url: "https://lensisku.invalid/api/definitions/42",
                event: null,
                locator: "user_id",
              },
            },
          },
          dates: { created_at: "2003-03-12T10:00:00Z" },
        },
        conversion: {
          method: "literal",
          tool: "web-ui-test-seed",
          version: "1",
          model: null,
          review: "unreviewed",
          mappings: [],
          warnings: [],
        },
        limitations: [
          "Synthetic test record. The rights of the source text are not established.",
        ],
      },
    }),
  );
  const selection = prepareSelection(
    utf8(JSON.stringify([imported.envelope.id])),
  );
  // A rafsi claim for cukta.
  const pair = { word: wordId(word("cukta")), rafsi: "cku" };
  const pairId =
    "jvr1:" +
    contentHash(
      utf8("jbovlacku-rafsi-v1\n" + canonicalize(utf8(JSON.stringify(pair)))),
    ).slice(7);
  const claim = sign(
    curator,
    [lo.envelope.id],
    {
      kind: "rafsi.publish",
      word: pair.word,
      assignment: pairId,
      origin: "native",
    },
    {
      word: word("cukta"),
      rafsi: "cku",
      rationale: [["Classic assignment."]],
      sources: [],
      legacy: null,
    },
  );
  // View with two roots. H=3, alpha=1/2.
  const view = sign(
    rootA,
    [],
    { kind: "view.publish", parents: [] },
    {
      name: "Web UI test view",
      description: [["Two roots for browser tests."]],
      roots: [ids.rootA, ids.rootB]
        .sort()
        .map((identity) => ({ identity, q: { numerator: 1, denominator: 1 } })),
      rafsi_threshold: { numerator: 1, denominator: 1 },
      H: { numerator: 3, denominator: 1 },
      alpha: { numerator: 1, denominator: 2 },
      excluded: [],
      calculation: "simple-routes-bounds-v1",
      work: 10000,
      import_sets: [
        {
          source: "https://lensisku.invalid",
          importer: ids.importer,
          selection: selection.hash,
        },
      ],
      account_witnesses: [],
      account_authority: false,
      notes: [],
    },
  );
  const all = { kind: "*", word: "*", language: "*" };
  // Both roots heed the curator. The curator heeds the delegate.
  const heedA = sign(
    rootA,
    [view.envelope.id],
    { kind: "trust.set", subject: ids.curator, scope: all, value: "heed" },
    null,
  );
  const heedB = sign(
    rootB,
    [],
    { kind: "trust.set", subject: ids.curator, scope: all, value: "heed" },
    null,
  );
  const heedDelegate = sign(
    curator,
    [claim.envelope.id],
    { kind: "trust.set", subject: ids.delegate, scope: all, value: "heed" },
    null,
  );
  const blessCurator = sign(
    curator,
    [heedDelegate.envelope.id],
    { kind: "judgment.set", target: cukta1.envelope.id, value: "bless" },
    null,
  );
  const blessPair = sign(
    curator,
    [blessCurator.envelope.id],
    { kind: "judgment.set", target: pairId, value: "bless" },
    null,
  );
  const blessDelegate = sign(
    delegate,
    [cuktaRev.envelope.id],
    { kind: "judgment.set", target: cukta2.envelope.id, value: "bless" },
    null,
  );
  const curseDelegate = sign(
    delegate,
    [blessDelegate.envelope.id],
    { kind: "judgment.set", target: cukta3.envelope.id, value: "curse" },
    null,
  );
  const blessAuthor = sign(
    author,
    [cukta3.envelope.id],
    { kind: "judgment.set", target: cukta3.envelope.id, value: "bless" },
    null,
  );
  void heedA;
  void heedB;
  void blessPair;
  void curseDelegate;
  void blessAuthor;
  void imported;
  const fixture = {
    origin,
    view: view.envelope.id,
    identities: ids,
    words: {
      cukta: wordId(word("cukta")),
      vlacku: wordId(word("vlacku")),
      lo: wordId(word("lo")),
      ckusro: wordId(word("ckusro")),
    },
    definitions: {
      cukta1: cukta1.envelope.id,
      cukta2: cukta2.envelope.id,
      cukta3: cukta3.envelope.id,
      cuktaRev: cuktaRev.envelope.id,
      vlacku: vlacku.envelope.id,
      lo: lo.envelope.id,
      imported: imported.envelope.id,
    },
    pair: pairId,
    claim: claim.envelope.id,
    selection: selection.hash,
  };
  return { events, view, fixture, selection: selection.canonical };
}
export async function admit(
  origin: string,
  events: { envelope: { id: string } }[],
  view: { envelope: { id: string } },
  selection?: string,
) {
  if (selection) {
    const response = await fetch(`${origin}/api/v1/import-selections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: selection,
    });
    if (!response.ok)
      throw new Error(
        `Selection admission failed ${response.status}: ${await response.text()}`,
      );
  }
  const post = async (event: unknown) => {
    const response = await fetch(`${origin}/api/v1/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    if (!response.ok)
      throw new Error(
        `Admission failed ${response.status}: ${await response.text()}`,
      );
    return response.json();
  };
  await post(view);
  for (const event of events) if (event !== view) await post(event);
}
if (process.argv[1]?.endsWith("seed.ts")) {
  await initializeCore(
    await readFile(
      new URL(
        "../../../packages/core/generated/jvc_runtime_bg.wasm",
        import.meta.url,
      ),
    ),
  );
  const origin = process.argv[2] ?? "http://127.0.0.1:8820";
  const out = process.argv[3];
  const { events, view, fixture, selection } = await buildFixture(origin);
  await admit(origin, events, view, selection);
  if (out) await writeFile(out, JSON.stringify(fixture, null, 2));
  console.log(JSON.stringify(fixture));
}
