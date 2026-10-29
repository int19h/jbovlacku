import { before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeCore,
  createEvent,
  wordId,
  rafsiPairId,
  utf8,
} from "../../core/src/index.ts";
import { DictionaryService } from "../src/service.ts";
import type { ServiceCheckpoint } from "../src/checkpoint.ts";
import {
  FileObjectStore,
  SqliteCoordinator,
} from "../../../apps/server/src/storage.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);
test("GET and POST patterns keep ranking, rafsi, cursors, retirement, deltas, and checkpoint recovery", async () => {
  const root = process.env.JVC_TEST_ROOT ?? tmpdir();
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "pattern-service-"));
  const coordinator = new SqliteCoordinator(
    join(directory, "coordinator.sqlite"),
  );
  const objects = new FileObjectStore(join(directory, "objects"));
  const seed = new Uint8Array(32).fill(95);
  let serial = 0,
    checkpoint: ServiceCheckpoint | undefined,
    restores = 0;
  const signed = (
    action: Record<string, unknown>,
    body: unknown,
    previous: string[] = [],
  ) =>
    createEvent(
      seed,
      previous,
      (++serial).toString(16).padStart(32, "0"),
      action,
      body,
    );
  const view = signed(
    { kind: "view.publish", parents: [] },
    {
      name: "Pattern fixture",
      description: [],
      notes: [],
      roots: [],
      rafsi_threshold: { numerator: 1, denominator: 1 },
      H: { numerator: 3, denominator: 1 },
      alpha: { numerator: 1, denominator: 2 },
      excluded: [],
      calculation: "simple-routes-bounds-v1",
      work: 1000,
      import_sets: [],
      account_witnesses: [],
      account_authority: false,
    },
  );
  const spellings = [
    "bangu",
    "barda",
    "vecnu",
    "nu",
    "uen",
    "yen",
    "papa",
    "baba",
    "ba'i",
    "dján",
    "cukta",
  ];
  const definitions = spellings.map((spelling) =>
    signed(
      {
        kind: "definition.publish",
        word: wordId({ language: "jbo", spelling }),
        language: "en",
        parents: [],
        origin: "native",
      },
      {
        word: { language: "jbo", spelling },
        language: "en",
        text: [["Synthetic pattern fixture."]],
        classification: { kind: spelling === "dján" ? "cmevla" : "other" },
        license: { expression: "CC0-1.0" },
      },
    ),
  );
  const word = { language: "jbo" as const, spelling: "cukta" };
  const claim = (rafsi: string) =>
    signed(
      {
        kind: "rafsi.publish",
        word: wordId(word),
        assignment: rafsiPairId(wordId(word), rafsi),
        origin: "native",
      },
      { word, rafsi, rationale: [], sources: [], legacy: null },
    );
  const options = {
    serverId: "pattern-test",
    selectedView: view.envelope.id,
    policyUrl: "https://example.invalid/policy",
    asyncMaterialization: true,
    coreVersion: "pattern-test-core",
    checkpointIntervalMs: 0,
    checkpoints: {
      async load() {
        restores++;
        return checkpoint ? structuredClone(checkpoint) : null;
      },
      async save(_binding: unknown, value: ServiceCheckpoint) {
        checkpoint = structuredClone(value);
      },
    },
  };
  let service = new DictionaryService(objects, coordinator, options);
  const admit = async (...records: ReturnType<typeof createEvent>[]) => {
    const admitted = await service.admitMany(
      records.map((record) => utf8(JSON.stringify(record))),
    );
    assert.ok(
      admitted.receipts.every((receipt) => receipt.admission === "accepted"),
    );
    await service.flushMaterialization();
  };
  const request = (q: string, extra: Record<string, string> = {}) =>
    new Request(
      "http://local.invalid/api/v1/search?" +
        new URLSearchParams({ q, language: "en", ...extra }),
    );
  const get = async (q: string, extra: Record<string, string> = {}) => {
    const response = await service.fetch(request(q, extra));
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<any>;
  };
  const restart = async () => {
    await service.prepareEvaluationShutdown();
    service = new DictionaryService(objects, coordinator, options);
    await service.initialize();
    await service.flushMaterialization();
  };
  try {
    await service.initialize();
    await admit(
      view,
      ...definitions,
      ...["ban", "nu", "uen", "papa", "ba'i"].map(claim),
    );
    for (const [q, heads] of [
      ["/^ba/", ["bangu", "barda", "baba", "ba'i"]],
      ["/nu$/", ["vecnu", "nu"]],
      ["ba*", ["bangu", "barda", "baba", "ba'i"]],
      ["@@$", ["uen", "yen"]],
      ["?a?a", ["papa", "baba"]],
      ["*'i", ["ba'i"]],
      ["*hi", ["ba'i"]],
    ] as [string, string[]][]) {
      const first = await get(q, { limit: "2" });
      const post = await service.fetch(
        new Request("http://local.invalid/api/v1/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ q, language: "en", limit: 2 }),
        }),
      );
      assert.deepEqual(await post.json(), first);
      const hits = [...first.hits];
      let next = first.next;
      while (next) {
        const page = await get(q, {
          limit: "2",
          after: next,
          snapshot: first.snapshot,
          view: first.view,
        });
        hits.push(...page.hits);
        next = page.next;
      }
      assert.deepEqual(
        hits
          .filter((hit) => hit.match === "headword-pattern")
          .map((hit) => hit.word.spelling),
        heads.sort((a, b) =>
          wordId({ language: "jbo", spelling: a }).localeCompare(
            wordId({ language: "jbo", spelling: b }),
          ),
        ),
      );
      assert.equal(hits.at(-1).word.spelling, "cukta");
      assert.equal(hits.at(-1).match, "rafsi-pattern");
      assert.equal(first.segmentation, "complete");
    }
    assert.equal((await get("/^DJÁN$/")).hits[0].word.spelling, "dján");
    for (const q of [
      "/[/",
      "//",
      "/(?=a)/",
      "/(a)\\1/",
      "ba* word",
      "*".repeat(257),
    ]) {
      const response = await service.fetch(request(q));
      assert.equal(response.status, 400);
      assert.equal(((await response.json()) as any).code, "pattern_invalid");
    }
    const first = await get("ba*", { limit: "1" });
    const wrong = await service.fetch(request("/ba/", { after: first.next }));
    assert.equal(wrong.status, 400);
    await admit(
      signed(
        {
          kind: "status.set",
          target: definitions[1].envelope.id,
          value: "deprecated",
        },
        null,
        [definitions[1].envelope.id],
      ),
    );
    assert.ok(
      !(await get("ba*")).hits.some(
        (hit: any) => hit.word.spelling === "barda",
      ),
    );
    assert.ok(
      (await get("ba*", { retired: "1" })).hits.some(
        (hit: any) => hit.word.spelling === "barda",
      ),
    );
    await admit(
      signed(
        { kind: "identity.profile" },
        { name: "Pattern author", bio: [], links: [] },
      ),
    );
    assert.equal((await get("ban*")).hits[0].word.spelling, "bangu");
    assert.equal((await get("ban*")).hits.at(-1).word.spelling, "cukta");
    await admit(claim("cab"));
    assert.equal((await get("ca*")).hits[0].match, "rafsi-pattern");
    await restart();
    assert.ok(restores > 0);
    assert.equal((await get("ca*")).hits[0].word.spelling, "cukta");
    // An older checkpoint lacks the new private index. Restore rebuilds it.
    await service.prepareEvaluationShutdown();
    delete checkpoint!.packages.searchRafsi;
    service = new DictionaryService(objects, coordinator, options);
    await service.initialize();
    await service.flushMaterialization();
    assert.equal((await get("ca*")).hits[0].word.spelling, "cukta");

    // Exercise the shared HTTP boundary with legal long spellings and an
    // oversized derived fixture, without signing thousands of duplicate bodies.
    const long = "a".repeat(254) + "b";
    const entries = Array.from({ length: 25_000 }, (_, index) => ({
      event: String(index),
      word: { language: "jbo", spelling: long },
      language: "en",
      glosses: [],
      plain_text: "",
      classification: { kind: "other" },
      body: "",
    }));
    const evaluation = {
      available: true,
      publications: Object.fromEntries(
        entries.map((entry) => [
          entry.event,
          { word: "long", eligible: "eligible", status: "active" },
        ]),
      ),
      receipts: Object.fromEntries(
        entries.map((entry) => [entry.event, { interpretation: "effective" }]),
      ),
    };
    const internal = service as any,
      packages = internal.packages,
      evaluate = internal.evaluation;
    internal.packages = async () => ({ entries, searchRafsi: {} });
    internal.evaluation = async () => evaluation;
    try {
      const response = await service.fetch(request("/(a+)+$/"));
      assert.equal(response.status, 422);
      const error = (await response.json()) as any;
      assert.equal(error.code, "pattern_timeout");
      assert.match(error.message, /time or work limit/);
      assert.equal(error.hits, undefined);
    } finally {
      internal.packages = packages;
      internal.evaluation = evaluate;
    }
    assert.equal((await get("ca*")).hits[0].word.spelling, "cukta");
  } finally {
    await service.prepareEvaluationShutdown();
    coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});
