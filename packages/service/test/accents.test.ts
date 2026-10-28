import { before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initializeCore,
  createEvent,
  utf8,
  wordId,
  contentHash,
  canonicalize,
  extractHostVerifiedRecord,
  extractHostSemanticRecord,
} from "../../core/src/index.ts";
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

test("admission, compact records, packages, and search preserve definition-specific name display", async () => {
  const root = process.env.JVC_TEST_ROOT ?? tmpdir();
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "accent-service-"));
  const coordinator = new SqliteCoordinator(
    join(directory, "coordinator.sqlite"),
  );
  const seed = new Uint8Array(32).fill(93);
  const view = createEvent(
    seed,
    [],
    "a".repeat(32),
    { kind: "view.publish", parents: [] },
    {
      name: "Synthetic accent view",
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
  const definitions = ["djan", "dján"].map((spelling, index) =>
    createEvent(
      seed,
      [],
      String(index + 1).repeat(32),
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
        text: [["A synthetic name."]],
        classification: { kind: "cmevla" },
        license: { expression: "CC0-1.0" },
      },
    ),
  );
  const service = new DictionaryService(
    new FileObjectStore(join(directory, "objects")),
    coordinator,
    {
      serverId: "accents",
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
    const read = async (path: string): Promise<any> => {
      const response = await service.fetch(
        new Request("http://local.invalid/api/v1" + path),
      );
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const id = wordId({ language: "jbo", spelling: "djan" });
    const word = await read(`/words/${id}`);
    assert.equal(word.definitions.length, 2);
    const selected = definitions
      .slice()
      .sort((a, b) => a.envelope.id.localeCompare(b.envelope.id))[0];
    for (const query of ["djan", "dján", "dja\u0301n", "DJÁN"]) {
      const result = await read(
        `/search?language=en&q=${encodeURIComponent(query)}`,
      );
      assert.equal(result.hits.length, 1);
      assert.equal(result.hits[0].word_id, id);
      assert.equal(result.hits[0].preview.event, selected.envelope.id);
      assert.equal(
        result.hits[0].word.spelling,
        (selected.body as { word: { spelling: string } }).word.spelling,
      );
    }
    assert.deepEqual(
      (await read(`/search?language=en&q=${encodeURIComponent("\u0301")}`))
        .hits,
      [],
    );
    for (const version of [1, 2]) {
      const manifest = await read(`/packages/en?version=${version}`);
      const entries = (
        await Promise.all(
          manifest.parts.map((part: { hash: string }) =>
            read(`/package-parts/${part.hash}`),
          ),
        )
      ).flat();
      assert.deepEqual(
        entries.map((entry) => entry.word.spelling).sort(),
        ["djan", "dján"].sort(),
      );
    }
    const marked = definitions[1];
    const envelope = utf8(canonicalize(utf8(JSON.stringify(marked.envelope))));
    const body = utf8(canonicalize(utf8(JSON.stringify(marked.body))));
    const compact = JSON.parse(extractHostVerifiedRecord(envelope, body));
    const semantic = JSON.parse(extractHostSemanticRecord(envelope, body));
    assert.equal(compact.package.body.word.spelling, "dján");
    assert.equal(semantic.semantic.body.word.spelling, "dján");
    assert.equal(marked.envelope.header.action.word, id);
    assert.equal(contentHash(body), marked.envelope.header.content!.hash);
    assert.equal(
      (await read(`/bodies/${contentHash(body)}`)).word.spelling,
      "dján",
    );
  } finally {
    await service.prepareEvaluationShutdown();
    coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});
