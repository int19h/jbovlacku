import { before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeCore,
  createEvent,
  wordId,
  utf8,
} from "../../core/src/index.ts";
import { searchMetrics, selectMatches } from "../../search/src/index.ts";
import { DictionaryService } from "../src/service.ts";
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

test("GET and POST share segmented ranking, fallback, cursors, and limits in a fixed snapshot", async () => {
  const root = process.env.JVC_TEST_ROOT ?? tmpdir();
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "segmented-service-"));
  const coordinator = new SqliteCoordinator(
    join(directory, "coordinator.sqlite"),
  );
  const seed = new Uint8Array(32).fill(94);
  const view = createEvent(
    seed,
    [],
    "a".repeat(32),
    { kind: "view.publish", parents: [] },
    {
      name: "Synthetic search view",
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
  const longQuery = "i".repeat(129);
  const spellings = [
    "i",
    "je",
    "bo",
    "klama",
    "tai",
    "a",
    "ibo",
    "iboku",
    "iseri'abo",
    "mibo",
    "ba".repeat(128),
    "broda",
    "brode",
  ];
  const definitions = spellings.map((spelling, index) =>
    createEvent(
      seed,
      [],
      (index + 1).toString(16).padStart(32, "0"),
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
        text: [["Synthetic definition."]],
        glosses:
          index >= spellings.length - 2
            ? [{ language: "en", text: longQuery, sense: null }]
            : [],
        classification: { kind: spelling === "klama" ? "gismu" : "cmavo" },
        license: { expression: "CC0-1.0" },
      },
    ),
  );
  const service = new DictionaryService(
    new FileObjectStore(join(directory, "objects")),
    coordinator,
    {
      serverId: "segmented-test",
      selectedView: view.envelope.id,
      policyUrl: "https://example.invalid/policy",
    },
  );
  try {
    await service.initialize();
    await service.admitMany(
      [view, ...definitions].map((record) => utf8(JSON.stringify(record))),
    );
    await service.flushMaterialization();
    const completed = await (service as any).current();
    const built = await (service as any).packages(completed.snapshot);

    const firstSearch = searchMetrics();
    selectMatches(built.entries, "i bo", firstSearch);
    assert.equal(
      firstSearch.headwordsParsed,
      0,
      "A completed package must own a ready lexical index.",
    );
    const get = async (q: string, extras: Record<string, string> = {}) => {
      const response = await service.fetch(
        new Request(
          "http://local.invalid/api/v1/search?" +
            new URLSearchParams({ q, language: "en", ...extras }),
        ),
      );
      assert.equal(response.status, 200, await response.clone().text());
      return response.json() as Promise<any>;
    };
    const search = await get("i bo", { limit: "2" });
    assert.deepEqual(
      search.hits.map((hit: any) => [hit.word.spelling, hit.match]),
      [
        ["ibo", "sequence-exact"],
        ["iseri'abo", "sequence-subsequence"],
      ],
    );
    assert.equal(search.segmentation, "complete");
    const more = await get("i bo", {
      limit: "2",
      after: search.next,
      snapshot: search.snapshot,
      view: search.view,
    });
    assert.equal(more.segmentation, "complete");
    assert.deepEqual(
      more.hits.map((hit: any) => [hit.word.spelling, hit.match]),
      [["iboku", "sequence-subsequence"]],
    );
    assert.equal(more.next, null);
    const post = await service.fetch(
      new Request("http://local.invalid/api/v1/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q: "i bo", language: "en", limit: 2 }),
      }),
    );
    assert.deepEqual(await post.json(), search);
    const invalid = await service.fetch(
      new Request(
        "http://local.invalid/api/v1/search?" +
          new URLSearchParams({
            q: "bo i",
            language: "en",
            after: search.next,
          }),
      ),
    );
    assert.equal(invalid.status, 400);
    for (const query of [
      "i seri'a bo",
      "ise ri'abo",
      "iseri'abo",
      "I SE RÍ’ABO",
      "mi klama i seri'a bo",
    ])
      assert.ok(
        (await get(query)).hits.some(
          (hit: any) => hit.word.spelling === "iseri'abo",
        ),
        query,
      );
    assert.deepEqual(
      (await get("ijebo")).hits.map((hit: any) => hit.word.spelling),
      ["i", "je", "bo"],
    );
    assert.deepEqual(
      (await get("taia")).hits.map((hit: any) => hit.word.spelling),
      ["tai", "a"],
    );
    assert.deepEqual(
      (await get("i klama i")).hits.map((hit: any) => hit.word.spelling),
      ["i", "klama"],
    );
    assert.ok(
      (await get([...Array(99).fill("mi"), "bo"].join(" "))).hits.some(
        (hit: any) => hit.word.spelling === "mibo",
      ),
    );
    assert.ok(
      (await get("ba ba")).hits.some(
        (hit: any) => hit.word.spelling === "ba".repeat(128),
      ),
    );
    const limited = await get(longQuery, { limit: "1" });
    assert.equal(limited.segmentation, "limited");
    assert.equal(limited.hits[0].match, "gloss");
    const limitedMore = await get(longQuery, {
      limit: "1",
      after: limited.next,
      snapshot: limited.snapshot,
      view: limited.view,
    });
    assert.equal(limitedMore.segmentation, "limited");
    assert.equal(limitedMore.next, null);
    assert.notEqual(limitedMore.hits[0].word_id, limited.hits[0].word_id);
  } finally {
    coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});
