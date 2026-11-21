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
