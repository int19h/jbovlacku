// A native definition by a signer outside the view roots can carry selma'o
// names of any length. The search preview bounds them, and the browser keeps
// the page and the hit.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initializeCore,
  identityFromSeed,
  utf8,
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
const directories: string[] = [];
after(async () => {
  for (const directory of directories)
    await rm(directory, { recursive: true, force: true });
});
const root = new Uint8Array(32).fill(19);
const stranger = new Uint8Array(32).fill(77);
const request = (path: string) => new Request(`http://localhost/api/v1${path}`);

test("a long selma'o name from a non-root signer does not cost the search page", async () => {
  await mkdir(process.env.JVC_TEST_ROOT ?? tmpdir(), { recursive: true });
  const directory = await mkdtemp(
    join(process.env.JVC_TEST_ROOT ?? tmpdir(), "jvc-preview-bounds-"),
  );
  directories.push(directory);
  const objects = new FileObjectStore(join(directory, "objects"));
  const coordinator = new SqliteCoordinator(
    join(directory, "coordinator.sqlite"),
    16,
  );
  try {
    const { createEvent, wordId } = await import("../../core/src/index.ts");
    const word = { language: "jbo" as const, spelling: "klama" };
    const body = {
      word,
      language: "en",
      text: [["probe movement"]],
      frame: null,
      operands: [],
      glosses: [{ language: "en", text: "movement", sense: null }],
      notes: [],
      etymology: { text: [], formation: null, compound: null },
      examples: [],
      classification: { kind: "gismu", selmaho: ["X".repeat(200), "BAI"] },
      labels: [],
      sources: [],
      license: { expression: "CC0-1.0", url: null, attribution: "probe" },
      legacy: null,
    };
    const action = {
      kind: "definition.publish",
      word: wordId(word),
      language: "en",
      parents: [],
      origin: "native",
    };
    const definition = createEvent(stranger, [], "7".repeat(32), action, body);
    const view = createEvent(
      root,
      [],
      "c".repeat(32),
      { kind: "view.publish", parents: [] },
      {
        name: "Probe view",
        description: [],
        roots: [
          {
            identity: identityFromSeed(root),
            q: { numerator: 1, denominator: 1 },
          },
        ],
        rafsi_threshold: { numerator: 1, denominator: 1 },
        H: { numerator: 1, denominator: 1 },
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
    // The view is rooted on another identity, so the definition's signer
    // is outside the view roots.
    const service = new DictionaryService(objects, coordinator, {
      serverId: "probe",
      policyUrl: "https://example.invalid/policy",
      selectedView: view.envelope.id,
    });
    await service.admitMany(
      [definition, view].map((value) => utf8(JSON.stringify(value))),
    );
    const response = await service.fetch(
      request("/search?q=movement&language=en"),
    );
    assert.equal(response.status, 200, await response.clone().text());
    const page = (await response.json()) as {
      hits: { preview: { selmaho: string[]; issuer?: string } }[];
    };
    assert.equal(page.hits.length, 1);
    // The over-long name is dropped. The short name and the hit stay.
    assert.deepEqual(page.hits[0].preview.selmaho, ["BAI"]);
    assert.equal(page.hits[0].preview.issuer, identityFromSeed(stranger));
    // The browser accepts the page as the server sends it.
    (globalThis as unknown as { location?: URL }).location ??= new URL(
      "http://localhost/",
    );
    const { validateHits } = await import("../../../apps/web/src/data/api.ts");
    const hits = validateHits(page.hits, 100);
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0].preview?.selmaho, ["BAI"]);
  } finally {
    coordinator.close();
  }
});

test("preview rafsi leave out a withdrawn claim and sort as the row does", async () => {
  await mkdir(process.env.JVC_TEST_ROOT ?? tmpdir(), { recursive: true });
  const directory = await mkdtemp(
    join(process.env.JVC_TEST_ROOT ?? tmpdir(), "jvc-preview-rafsi-"),
  );
  directories.push(directory);
  const objects = new FileObjectStore(join(directory, "objects"));
  const coordinator = new SqliteCoordinator(
    join(directory, "coordinator.sqlite"),
    16,
  );
  try {
    const { createEvent, wordId, rafsiPairId } =
      await import("../../core/src/index.ts");
    const b = new Uint8Array(32).fill(37);
    const word = { language: "jbo" as const, spelling: "klama" };
    const definition = createEvent(
      root,
      [],
      "7".repeat(32),
      {
        kind: "definition.publish",
        word: wordId(word),
        language: "en",
        parents: [],
        origin: "native",
      },
      {
        word,
        language: "en",
        text: [["probe movement"]],
        frame: null,
        operands: [],
        glosses: [{ language: "en", text: "movement", sense: null }],
        notes: [],
        etymology: { text: [], formation: null, compound: null },
        examples: [],
        classification: { kind: "gismu", selmaho: [] },
        labels: [],
        sources: [],
        license: { expression: "CC0-1.0", url: null, attribution: "probe" },
        legacy: null,
      },
    );
    const claim = (seed: Uint8Array, rafsi: string, nonce: string) =>
      createEvent(
        seed,
        [],
        nonce,
        {
          kind: "rafsi.publish",
          word: wordId(word),
          assignment: rafsiPairId(wordId(word), rafsi),
          origin: "native",
        },
        { word, rafsi, rationale: [], sources: [], legacy: null },
      );
    // Seven shown rafsi whose pair-ID order differs from their spelling
    // order, and one more that its signer withdraws.
    const names = ["kla", "lam", "ka'a", "kam", "kal", "lama", "mak"];
    const active = names.map((rafsi, index) =>
      claim(
        new Uint8Array(32).fill(40 + index),
        rafsi,
        String(index).repeat(32),
      ),
    );
    const zzz = claim(b, "zzz", "a".repeat(32));
    const withdrawn = createEvent(
      b,
      [zzz.envelope.id],
      "b".repeat(32),
      { kind: "status.set", target: zzz.envelope.id, value: "deprecated" },
      null,
    );
    const view = createEvent(
      root,
      [],
      "c".repeat(32),
      { kind: "view.publish", parents: [] },
      {
        name: "Probe view",
        description: [],
        roots: [
          {
            identity: identityFromSeed(root),
            q: { numerator: 1, denominator: 1 },
          },
        ],
        rafsi_threshold: { numerator: 1, denominator: 1 },
        H: { numerator: 1, denominator: 1 },
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
    const service = new DictionaryService(objects, coordinator, {
      serverId: "probe",
      policyUrl: "https://example.invalid/policy",
      selectedView: view.envelope.id,
    });
    await service.admitMany(
      [definition, view, ...active, zzz, withdrawn].map((value) =>
        utf8(JSON.stringify(value)),
      ),
    );
    const response = await service.fetch(
      request("/search?q=movement&language=en"),
    );
    assert.equal(response.status, 200, await response.clone().text());
    const page = (await response.json()) as {
      hits: { preview: { rafsi?: string[] } }[];
    };
    assert.deepEqual(page.hits[0].preview.rafsi, [
      "ka'a",
      "kal",
      "kam",
      "kla",
      "lam",
      "lama",
      "mak",
    ]);
    // The row on main shows the first claim of each assignment that is not
    // inactive on the word route, sorted by spelling. The preview gives the
    // same list in the same order.
    const wordResponse = (await (
      await service.fetch(request(`/words/${encodeURIComponent(wordId(word))}`))
    ).json()) as {
      assignments: { id: string; claims: string[]; status: string }[];
    };
    const spelling = new Map(
      [...active, zzz].map((event, index) => [
        event.envelope.id,
        [...names, "zzz"][index],
      ]),
    );
    assert.deepEqual(
      wordResponse.assignments
        .filter((assignment) => assignment.status !== "inactive")
        .map((assignment) => spelling.get(assignment.claims[0]))
        .sort(),
      page.hits[0].preview.rafsi,
    );
  } finally {
    coordinator.close();
  }
});

test("a search request reads prepared rafsi, not every claim of a hit's word", async () => {
  await mkdir(process.env.JVC_TEST_ROOT ?? tmpdir(), { recursive: true });
  const directory = await mkdtemp(
    join(process.env.JVC_TEST_ROOT ?? tmpdir(), "jvc-preview-lookups-"),
  );
  directories.push(directory);
  const objects = new FileObjectStore(join(directory, "objects"));
  const coordinator = new SqliteCoordinator(
    join(directory, "coordinator.sqlite"),
    16,
  );
  try {
    const { createEvent, wordId, rafsiPairId } =
      await import("../../core/src/index.ts");
    const word = { language: "jbo" as const, spelling: "klama" };
    const definition = createEvent(
      root,
      [],
      "7".repeat(32),
      {
        kind: "definition.publish",
        word: wordId(word),
        language: "en",
        parents: [],
        origin: "native",
      },
      {
        word,
        language: "en",
        text: [["probe movement"]],
        frame: null,
        operands: [],
        glosses: [{ language: "en", text: "movement", sense: null }],
        notes: [],
        etymology: { text: [], formation: null, compound: null },
        examples: [],
        classification: { kind: "gismu", selmaho: [] },
        labels: [],
        sources: [],
        license: { expression: "CC0-1.0", url: null, attribution: "probe" },
        legacy: null,
      },
    );
    // Forty-eight signers claim the same pair.
    const claims = Array.from({ length: 48 }, (_, index) =>
      createEvent(
        new Uint8Array(32).fill(100 + index),
        [],
        "5".repeat(32),
        {
          kind: "rafsi.publish",
          word: wordId(word),
          assignment: rafsiPairId(wordId(word), "kla"),
          origin: "native",
        },
        { word, rafsi: "kla", rationale: [], sources: [], legacy: null },
      ),
    );
    const claimIds = new Set(claims.map((claim) => claim.envelope.id));
    const view = createEvent(
      root,
      [],
      "c".repeat(32),
      { kind: "view.publish", parents: [] },
      {
        name: "Probe view",
        description: [],
        roots: [
          {
            identity: identityFromSeed(root),
            q: { numerator: 1, denominator: 1 },
          },
        ],
        rafsi_threshold: { numerator: 1, denominator: 1 },
        H: { numerator: 1, denominator: 1 },
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
    const service = new DictionaryService(objects, coordinator, {
      serverId: "probe",
      policyUrl: "https://example.invalid/policy",
      selectedView: view.envelope.id,
    });
    await service.admitMany(
      [definition, view, ...claims].map((value) => utf8(JSON.stringify(value))),
    );
    // Count the reads of claim publications. Each evaluation keeps one
    // counting wrapper, so prepared state stays tied to it.
    let lookups = 0;
    const wrapped = new Map<object, object>();
    const target = service as unknown as {
      evaluation: (...args: unknown[]) => Promise<Record<string, unknown>>;
    };
    const original = target.evaluation.bind(service);
    target.evaluation = async (...args: unknown[]) => {
      const evaluation = await original(...args);
      let proxy = wrapped.get(evaluation);
      if (!proxy) {
        const publications = new Proxy(
          evaluation.publications as Record<string, unknown>,
          {
            get(record, key, receiver) {
              if (typeof key === "string" && claimIds.has(key)) lookups += 1;
              return Reflect.get(record, key, receiver);
            },
          },
        );
        // The evaluation is frozen, so the wrapper is a copy of it with
        // counting publications.
        proxy = { ...evaluation, publications };
        wrapped.set(evaluation, proxy);
      }
      return proxy as Record<string, unknown>;
    };
    const counts: number[] = [];
    for (let request = 0; request < 3; request++) {
      lookups = 0;
      const response = await service.fetch(
        new Request(
          "http://localhost/api/v1/search?q=movement&language=en&limit=1",
        ),
      );
      assert.equal(response.status, 200, await response.clone().text());
      const page = (await response.json()) as {
        hits: { preview: { rafsi?: string[] } }[];
      };
      assert.deepEqual(page.hits[0].preview.rafsi, ["kla"]);
      counts.push(lookups);
    }
    // The first request also builds the snapshot's packages and prepares
    // the rafsi lists, and both passes read the claims. Later requests read
    // the prepared list and no claim publication, whatever the number of
    // claims for the hit's word.
    assert.ok(counts[0] > 0);
    assert.deepEqual(counts.slice(1), [0, 0]);
  } finally {
    coordinator.close();
  }
});
