import { afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createEvent,
  identityFromSeed,
  initializeCore,
  utf8,
  wordId,
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
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const publisher = new Uint8Array(32).fill(34);
const word = { language: "jbo" as const, spelling: "klama" };
function signedDefinition(previous: string[] = [], nonce = "b".repeat(32)) {
  return createEvent(
    publisher,
    previous,
    nonce,
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
      text: [["A traveler goes somewhere by moving."]],
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
    },
  );
}
async function fixture() {
  const root = process.env.JVC_TEST_ROOT ?? tmpdir();
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "lexical-effective-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const coordinator = new SqliteCoordinator(
    join(directory, "coordinator.sqlite"),
    16,
  );
  cleanups.push(async () => coordinator.close());
  const view = createEvent(
    new Uint8Array(32).fill(31),
    [],
    "a".repeat(32),
    { kind: "view.publish", parents: [] },
    {
      name: "Lexical inert reproducer",
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
  const service = new DictionaryService(
    new FileObjectStore(join(directory, "objects")),
    coordinator,
    {
      serverId: "lexical-effective-test",
      selectedView: view.envelope.id,
      policyUrl: "https://example.invalid/local",
      asyncMaterialization: true,
    },
  );
  await service.initialize();
  cleanups.push(() => service.flushMaterialization());
  const read = async (path: string): Promise<any> => {
    const response = await service.fetch(
      new Request("http://local.invalid/api/v1" + path),
    );
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const snapshot = async (): Promise<string> =>
    (await read("/manifest")).snapshot;
  const search = async (snapshot: string, retired: boolean) => {
    const params = new URLSearchParams({
      q: "traveler",
      language: "en",
      snapshot,
      view: view.envelope.id,
    });
    if (retired) params.set("retired", "1");
    const result = await read("/search?" + params);
    assert.equal(result.snapshot, snapshot);
    assert.equal(result.view, view.envelope.id);
    return result;
  };
  const admit = async (...events: ReturnType<typeof createEvent>[]) => {
    const admitted = await service.admitMany(
      events.map((event) => utf8(JSON.stringify(event))),
    );
    assert.ok(
      admitted.receipts.every((receipt) => receipt.admission === "accepted"),
    );
    await service.flushMaterialization();
    assert.equal(await snapshot(), admitted.snapshot);
    return admitted;
  };
  return { service, view, read, snapshot, search, admit };
}

for (const retired of [false, true]) {
  test(`lexical search excludes concurrent and post-transfer inert definitions (${retired ? "retired=1" : "ordinary"})`, async () => {
    const { view, read, snapshot, search, admit } = await fixture();
    const concurrent = signedDefinition();
    await admit(view, concurrent);
    const prior = await snapshot();
    assert.equal(
      (await read("/receipts/" + concurrent.envelope.id)).interpretation,
      "effective",
    );
    const result = await search(prior, retired);
    assert.deepEqual(result.hits[0].definitions, [concurrent.envelope.id]);
    assert.equal(result.hits[0].preview.status, "active");

    const transfer = createEvent(
      publisher,
      [],
      "c".repeat(32),
      {
        kind: "identity.transfer",
        successor: identityFromSeed(new Uint8Array(32).fill(35)),
      },
      null,
    );
    const after = signedDefinition([transfer.envelope.id], "d".repeat(32));
    await admit(transfer, after);
    const current = await snapshot();
    assert.notEqual(current, prior);
    for (const event of [concurrent, after]) {
      const receipt = await read("/receipts/" + event.envelope.id);
      assert.equal(receipt.snapshot, current);
      assert.equal(receipt.interpretation, "inert");
      assert.ok(receipt.reasons.includes("outside_retained_history"));
      assert.deepEqual(
        await read("/events/" + event.envelope.id + "?snapshot=" + current),
        event.envelope,
      );
    }
    assert.deepEqual((await search(current, retired)).hits, []);
    const retained = await search(prior, retired);
    assert.deepEqual(retained.hits[0].definitions, [concurrent.envelope.id]);
    assert.equal(retained.hits[0].preview.status, "active");
  });
}

test("retired search retains effective deprecated definitions and exact earlier snapshot behavior", async () => {
  const { view, read, snapshot, search, admit } = await fixture();
  const definition = signedDefinition();
  await admit(view, definition);
  const prior = await snapshot();
  const deprecated = createEvent(
    publisher,
    [definition.envelope.id],
    "c".repeat(32),
    {
      kind: "status.set",
      target: definition.envelope.id,
      value: "deprecated",
    },
    null,
  );
  await admit(deprecated);
  const current = await snapshot();
  assert.notEqual(current, prior);
  assert.equal(
    (await read("/receipts/" + definition.envelope.id)).interpretation,
    "effective",
  );
  assert.equal(
    (await read("/receipts/" + deprecated.envelope.id)).interpretation,
    "effective",
  );
  assert.deepEqual((await search(current, false)).hits, []);
  const retired = await search(current, true);
  assert.deepEqual(retired.hits[0].definitions, [definition.envelope.id]);
  assert.equal(retired.hits[0].preview.status, "deprecated");
  for (const includeRetired of [false, true]) {
    const retained = await search(prior, includeRetired);
    assert.deepEqual(retained.hits[0].definitions, [definition.envelope.id]);
    assert.equal(retained.hits[0].preview.status, "active");
  }
});
