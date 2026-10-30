import { afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createEvent,
  canonicalize,
  contentHash,
  identityFromSeed,
  initializeCore,
  interpretDefinition,
  prepareSelection,
  rafsiPairId,
  signHeader,
  utf8,
  wordId,
} from "../../core/src/index.ts";
import { DictionaryService, type ServiceOptions } from "../src/service.ts";
import { buildPackages } from "../src/packages.ts";
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
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const publisher = new Uint8Array(32).fill(34);
const word = { language: "jbo" as const, spelling: "klama" };
function signedDefinition(
  previous: string[] = [],
  nonce = "b".repeat(32),
  seed = publisher,
) {
  return createEvent(
    seed,
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
async function fixture(extra: Partial<ServiceOptions> = {}) {
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
  const objects = new FileObjectStore(join(directory, "objects"));
  const options = {
    serverId: "lexical-effective-test",
    selectedView: view.envelope.id,
    policyUrl: "https://example.invalid/local",
    asyncMaterialization: true,
    ...extra,
  };
  let service = new DictionaryService(objects, coordinator, options);
  await service.initialize();
  cleanups.push(() => service.flushMaterialization());
  const restart = async () => {
    await service.prepareEvaluationShutdown();
    service = new DictionaryService(objects, coordinator, options);
    await service.initialize();
    await service.flushMaterialization();
    return service;
  };
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
  const entries = async (snapshot: string, version: 1 | 2) => {
    const manifest = await read(
      `/packages/en?snapshot=${snapshot}&version=${version}`,
    );
    assert.equal(manifest.snapshot, snapshot);
    assert.equal(manifest.version, version);
    const parts = await Promise.all(
      manifest.parts.map((part: { hash: string }) =>
        read("/package-parts/" + part.hash),
      ),
    );
    return parts.flat() as { event: string }[];
  };
  const wordRead = async (snapshot: string, suffix = "") => {
    const result = await read(
      `/words/${wordId(word)}?snapshot=${snapshot}&view=${view.envelope.id}${suffix}`,
    );
    assert.equal(result.snapshot, snapshot);
    assert.equal(result.view, view.envelope.id);
    return result;
  };
  return {
    service,
    view,
    read,
    snapshot,
    search,
    admit,
    entries,
    wordRead,
    restart,
    objects,
    coordinator,
  };
}

function signedTransfer(previous: string[] = []) {
  return createEvent(
    publisher,
    previous,
    "c".repeat(32),
    {
      kind: "identity.transfer",
      successor: identityFromSeed(new Uint8Array(32).fill(35)),
    },
    null,
  );
}

test("definition defaults compose with receipt filtering across package deltas and checkpoint restore", async () => {
  let checkpoint: ServiceCheckpoint | undefined;
  let restores = 0;
  const errors: unknown[] = [];
  const { view, admit, snapshot, entries, wordRead, read, restart, objects } =
    await fixture({
      coreVersion: "defaults-effective-receipts-v2",
      checkpointIntervalMs: 0,
      checkpoints: {
        async load() {
          restores++;
          return checkpoint ? structuredClone(checkpoint) : null;
        },
        async save(_binding, value) {
          checkpoint = structuredClone(value);
        },
      },
      reportError: (error) => errors.push(error),
    });
  const sparse = {
    word,
    language: "en",
    text: [["A traveler goes somewhere by moving."]],
    classification: { kind: "gismu" },
    license: { expression: "CC0-1.0" },
  };
  const definition = (
    body: unknown,
    nonce: string,
    previous: string[] = [],
    seed = publisher,
  ) =>
    createEvent(
      seed,
      previous,
      nonce,
      {
        kind: "definition.publish",
        word: wordId(word),
        language: "en",
        parents: [],
        origin: "native",
      },
      body,
    );
  const retained = definition(sparse, "1".repeat(32));
  const full = interpretDefinition(sparse);
  const fullBytes = utf8(canonicalize(utf8(JSON.stringify(full))));
  const excluded = {
    envelope: signHeader(publisher, {
      ...retained.envelope.header,
      nonce: "2".repeat(32),
      content: { hash: contentHash(fullBytes), bytes: fullBytes.length },
    }),
    body: full,
  };
  const publications = [retained, excluded];
  const verify = async (id: string, visible: string[]) => {
    const expected = visible.toSorted();
    for (const version of [1, 2] as const) {
      const packageEntries = await entries(id, version);
      assert.deepEqual(
        packageEntries.map((entry) => entry.event),
        expected,
      );
      for (const value of packageEntries) {
        const entry = value as Record<string, unknown> & { event: string };
        assert.deepEqual(entry.glosses, []);
        assert.deepEqual(entry.classification, { kind: "gismu", selmaho: [] });
        assert.equal(
          entry.body,
          publications.find(
            (publication) => publication.envelope.id === entry.event,
          )!.envelope.header.content!.hash,
        );
        if (version === 2) {
          assert.equal(entry.notes, false);
          assert.equal(entry.attribution, null);
          assert.deepEqual(entry.rafsi, []);
        }
      }
    }
    const result = await wordRead(id);
    assert.deepEqual(result.definitions, expected);
    assert.deepEqual(
      result.scores.map((score: { target: string }) => score.target).sort(),
      expected,
    );
    assert.deepEqual(result.layers.flat().sort(), expected);
    assert.deepEqual(result.unavailable_scores, []);
  };
  await admit(view, ...publications);
  const prior = await snapshot();
  await verify(
    prior,
    publications.map((publication) => publication.envelope.id),
  );

  // A lifecycle-only delta changes membership while publication bytes stay the same.
  const transfer = signedTransfer([retained.envelope.id]);
  await admit(transfer);
  const transferred = await snapshot();
  await verify(transferred, [retained.envelope.id]);
  const postTransfer = definition(sparse, "3".repeat(32), [
    transfer.envelope.id,
  ]);
  publications.push(postTransfer);
  await admit(postTransfer);
  await verify(await snapshot(), [retained.envelope.id]);
  const independent = definition(
    sparse,
    "4".repeat(32),
    [],
    new Uint8Array(32).fill(36),
  );
  publications.push(independent);
  await admit(independent);
  const current = await snapshot();
  const visible = [retained.envelope.id, independent.envelope.id];
  await verify(current, visible);
  assert.ok(checkpoint);
  await restart();
  assert.equal(restores, 1);
  assert.deepEqual(errors, []);
  await verify(current, visible);
  await verify(transferred, [retained.envelope.id]);
  await verify(prior, [retained.envelope.id, excluded.envelope.id]);
  for (const publication of publications) {
    const hash = publication.envelope.header.content!.hash;
    assert.deepEqual(
      await read(`/bodies/${hash}?snapshot=${current}`),
      publication.body,
    );
    const stored = await objects.get(hash);
    assert.ok(stored);
    assert.deepEqual(
      new Uint8Array(stored),
      utf8(canonicalize(utf8(JSON.stringify(publication.body)))),
    );
  }
  const records = await read(`/records?snapshot=${current}`);
  for (const publication of publications)
    assert.deepEqual(
      records.items.find(
        (item: { id: string }) => item.id === publication.envelope.id,
      ).body,
      publication.body,
    );
});

test("word reads hide inert definition targets across response fields and retain effective deprecated definitions", async () => {
  const { view, admit, snapshot, wordRead } = await fixture();
  const ancestor = signedDefinition([], "e".repeat(32));
  const concurrent = signedDefinition([ancestor.envelope.id]);
  const deprecated = createEvent(
    publisher,
    [ancestor.envelope.id],
    "f".repeat(32),
    { kind: "status.set", target: ancestor.envelope.id, value: "deprecated" },
    null,
  );
  const assignment = rafsiPairId(wordId(word), "kla");
  const claim = createEvent(
    new Uint8Array(32).fill(36),
    [],
    "6".repeat(32),
    { kind: "rafsi.publish", word: wordId(word), assignment, origin: "native" },
    { word, rafsi: "kla", rationale: [], sources: [], legacy: null },
  );
  await admit(view, ancestor, concurrent, deprecated, claim);
  const prior = await snapshot();
  const expectedPrior = [ancestor.envelope.id, concurrent.envelope.id].sort();
  assert.deepEqual((await wordRead(prior)).definitions, expectedPrior);
  const transfer = signedTransfer([deprecated.envelope.id]);
  await admit(transfer);
  const after = signedDefinition([transfer.envelope.id], "d".repeat(32));
  await admit(after);
  const current = await snapshot();
  for (const suffix of ["", "&retired=1", "&reviewers=1"]) {
    const result = await wordRead(current, suffix);
    assert.deepEqual(result.definitions, [ancestor.envelope.id]);
    assert.deepEqual(
      result.statuses.map((status: { event: string; state: string }) => [
        status.event,
        status.state,
      ]),
      [[ancestor.envelope.id, "deprecated"]],
    );
    assert.deepEqual(result.rafsi, [claim.envelope.id]);
    assert.deepEqual(result.assignments, [
      { id: assignment, claims: [claim.envelope.id], status: "inactive" },
    ]);
    assert.ok(
      result.scores.every(
        (score: { target: string }) => score.target !== assignment,
      ),
    );
    assert.ok(!result.unavailable_scores.includes(assignment));
    const visible = new Set([ancestor.envelope.id, assignment]);
    assert.ok(
      result.scores.every((score: { target: string }) =>
        visible.has(score.target),
      ),
    );
    assert.ok(result.layers.flat().every((id: string) => visible.has(id)));
    assert.ok(result.unavailable_scores.every((id: string) => visible.has(id)));
    assert.deepEqual(
      (await wordRead(prior, suffix)).definitions,
      expectedPrior,
    );
  }
});

test("a rafsi assignment stays unknown when every definition is inert", async () => {
  const { view, admit, snapshot, wordRead } = await fixture();
  const definition = signedDefinition();
  const assignment = rafsiPairId(wordId(word), "kla");
  const claim = createEvent(
    new Uint8Array(32).fill(36),
    [],
    "6".repeat(32),
    { kind: "rafsi.publish", word: wordId(word), assignment, origin: "native" },
    { word, rafsi: "kla", rationale: [], sources: [], legacy: null },
  );
  await admit(view, claim, definition, signedTransfer());
  const result = await wordRead(await snapshot());
  assert.deepEqual(result.definitions, []);
  assert.deepEqual(result.statuses, []);
  assert.deepEqual(result.assignments, [
    { id: assignment, claims: [claim.envelope.id], status: "unknown" },
  ]);
  assert.ok(
    result.scores.every(
      (score: { target: string }) => score.target !== assignment,
    ),
  );
  assert.ok(result.unavailable_scores.includes(assignment));
});

test("both package versions update receipt membership after a transfer-only delta and retain historical and deprecated entries", async () => {
  const { view, admit, snapshot, entries } = await fixture();
  const controlSeed = new Uint8Array(32).fill(36);
  const control = signedDefinition([], "e".repeat(32), controlSeed);
  const concurrent = signedDefinition();
  await admit(view, control, concurrent);
  const prior = await snapshot();
  for (const version of [1, 2] as const)
    assert.deepEqual(
      (await entries(prior, version)).map((entry) => entry.event),
      [control.envelope.id, concurrent.envelope.id].sort(),
    );
  const transfer = signedTransfer();
  await admit(transfer);
  const transferred = await snapshot();
  for (const version of [1, 2] as const)
    assert.deepEqual(
      (await entries(transferred, version)).map((entry) => entry.event),
      [control.envelope.id],
    );
  const after = signedDefinition([transfer.envelope.id], "d".repeat(32));
  await admit(after);
  const deprecated = createEvent(
    controlSeed,
    [control.envelope.id],
    "f".repeat(32),
    { kind: "status.set", target: control.envelope.id, value: "deprecated" },
    null,
  );
  await admit(deprecated);
  const current = await snapshot();
  for (const version of [1, 2] as const) {
    assert.deepEqual(
      (await entries(current, version)).map((entry) => entry.event),
      [control.envelope.id],
    );
    assert.deepEqual(
      (await entries(prior, version)).map((entry) => entry.event),
      [control.envelope.id, concurrent.envelope.id].sort(),
    );
  }
});

test("packages rebuild legacy checkpoint bytes and keep receipt filtering after restart and later lifecycle changes", async () => {
  let saved: ServiceCheckpoint | undefined;
  let loads = 0;
  const errors: unknown[] = [];
  const checkpoints = {
    async load() {
      loads++;
      return saved ? structuredClone(saved) : null;
    },
    async save(_binding: unknown, payload: ServiceCheckpoint) {
      saved = structuredClone(payload);
    },
  };
  const { view, admit, snapshot, entries, restart, coordinator, objects } =
    await fixture({
      checkpoints,
      coreVersion: "lexical-package-test",
      checkpointIntervalMs: 0,
      reportError: (error) => errors.push(error),
    });
  const concurrent = signedDefinition();
  await admit(view, concurrent);
  const prior = await snapshot();
  assert.ok(saved);
  await restart();
  await admit(signedTransfer());
  const current = await snapshot();
  assert.notEqual(current, prior);
  assert.ok(saved);
  // Recreate the unfiltered derived packages stored by the earlier service.
  saved.packages = await buildPackages(
    (await coordinator.getSnapshot(current))!,
    objects,
  );
  await restart();
  assert.equal(loads, 2);
  assert.deepEqual(errors, []);
  for (const version of [1, 2] as const) {
    assert.deepEqual(await entries(current, version), []);
    assert.deepEqual(
      (await entries(prior, version)).map((entry) => entry.event),
      [concurrent.envelope.id],
    );
  }
});

test("package discovery without a configured view still filters inert definitions", async () => {
  const { view, admit, snapshot, entries, read } = await fixture({
    selectedView: undefined,
  });
  const definition = signedDefinition();
  await admit(view, definition);
  const prior = await snapshot();
  assert.deepEqual(
    (await entries(prior, 1)).map((entry) => entry.event),
    [definition.envelope.id],
  );
  await admit(signedTransfer());
  const current = await snapshot();
  const manifest = await read("/manifest");
  for (const version of [1, 2] as const) {
    const empty = await read(
      `/packages/en?snapshot=${current}&version=${version}`,
    );
    assert.equal(empty.snapshot, current);
    assert.equal(empty.version, version);
    assert.deepEqual(empty.parts, []);
    const bytes = utf8(canonicalize(utf8(JSON.stringify(empty))));
    const advertised = (
      version === 1 ? manifest.packages : manifest.package_versions
    ).find((pkg: { language: string }) => pkg.language === "en");
    assert.equal(advertised.hash, contentHash(bytes));
    assert.equal(advertised.bytes, bytes.length);
    assert.deepEqual(await entries(current, version), []);
  }
});

test("packages add a pending definition when a later dependency-only delta makes its receipt effective", async () => {
  const { view, admit, snapshot, entries } = await fixture();
  const predecessor = createEvent(
    publisher,
    [],
    "9".repeat(32),
    { kind: "identity.merge" },
    null,
  );
  const definition = signedDefinition([predecessor.envelope.id]);
  await admit(view, definition);
  const prior = await snapshot();
  for (const version of [1, 2] as const)
    assert.deepEqual(await entries(prior, version), []);
  await admit(predecessor);
  const current = await snapshot();
  for (const version of [1, 2] as const) {
    assert.deepEqual(
      (await entries(current, version)).map((entry) => entry.event),
      [definition.envelope.id],
    );
    assert.deepEqual(await entries(prior, version), []);
  }
});

test("package receipt filtering preserves imported entries and alternate-view server reads", async () => {
  const { service, view, admit, snapshot, entries, read } = await fixture();
  const importer = new Uint8Array(32).fill(37);
  const source = "https://source.invalid";
  const imported = createEvent(
    importer,
    [],
    "8".repeat(32),
    {
      kind: "definition.publish",
      word: wordId(word),
      language: "en",
      parents: [],
      origin: "import",
    },
    {
      ...(signedDefinition().body as Record<string, unknown>),
      license: {
        expression: "unknown",
        url: null,
        attribution: "Synthetic source author",
      },
      legacy: {
        source,
        snapshot: "sha256:" + "1".repeat(64),
        extraction: "lexical-test-1",
        record: { kind: "definition", id: 1 },
        locator: "definitions/1",
        original: { definition: "A traveler goes somewhere by moving." },
        attribution: {
          author: "Synthetic source author",
          editor: null,
          author_account: null,
          dates: {},
        },
        conversion: {
          method: "literal",
          tool: "lexical-test",
          version: "1",
          model: null,
          review: "unreviewed",
          mappings: [],
          warnings: [],
        },
        limitations: ["Synthetic fixture."],
      },
    },
  );
  const selection = prepareSelection(
    utf8(JSON.stringify([imported.envelope.id])),
  );
  const response = await service.fetch(
    new Request("http://local.invalid/api/v1/import-selections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: selection.canonical,
    }),
  );
  assert.equal(response.status, 201);
  const alternate = createEvent(
    new Uint8Array(32).fill(38),
    [],
    "7".repeat(32),
    { kind: "view.publish", parents: [] },
    {
      ...(view.body as Record<string, unknown>),
      name: "Imported alternative",
      import_sets: [
        {
          source,
          importer: identityFromSeed(importer),
          selection: selection.hash,
        },
      ],
    },
  );
  await admit(view, alternate, imported);
  const current = await snapshot();
  for (const version of [1, 2] as const)
    assert.deepEqual(
      (await entries(current, version)).map((entry) => entry.event),
      [imported.envelope.id],
    );
  for (const selected of [view, alternate]) {
    const params = new URLSearchParams({
      snapshot: current,
      view: selected.envelope.id,
      language: "en",
      q: "traveler",
    });
    const results = await read("/search?" + params);
    assert.equal(results.snapshot, current);
    assert.equal(results.view, selected.envelope.id);
    assert.deepEqual(
      results.hits.flatMap((hit: { definitions: string[] }) => hit.definitions),
      selected === view ? [] : [imported.envelope.id],
    );
    const result = await read(`/words/${wordId(word)}?${params}`);
    assert.deepEqual(
      result.definitions,
      selected === view ? [] : [imported.envelope.id],
    );
  }
});

test("unavailable receipts keep completed manifest and raw history readable while package downloads report 503", async () => {
  let saved: ServiceCheckpoint | undefined;
  const errors: unknown[] = [];
  const checkpoints = {
    async load() {
      return saved ? structuredClone(saved) : null;
    },
    async save(_binding: unknown, payload: ServiceCheckpoint) {
      saved = structuredClone(payload);
    },
  };
  const {
    service,
    view,
    admit,
    snapshot,
    coordinator,
    read,
    entries,
    restart,
  } = await fixture({
    checkpoints,
    coreVersion: "unavailable-package-test",
    checkpointIntervalMs: 0,
    reportError: (error) => errors.push(error),
  });
  const definition = signedDefinition();
  await admit(view, definition);
  const prior = await snapshot();
  service.options.stateLimits = { events: 2, traversal: 1000, claim_depth: 16 };
  const merge = createEvent(
    publisher,
    [definition.envelope.id],
    "4".repeat(32),
    { kind: "identity.merge" },
    null,
  );
  const admitted = await service.admitMany([utf8(JSON.stringify(merge))]);
  await service.flushMaterialization();
  const metadata = await coordinator.loadMetadata();
  assert.equal(metadata.materialized_snapshot, admitted.snapshot);
  assert.equal(metadata.materialized_position, metadata.position);
  const receipt = await read("/receipts/" + merge.envelope.id);
  assert.equal(receipt.snapshot, admitted.snapshot);
  assert.equal(receipt.interpretation, "unavailable");
  assert.ok(!receipt.reasons.includes("index_lag"));
  assert.ok(!receipt.reasons.includes("evaluation_pending"));
  assert.ok(saved);
  assert.equal(saved.packages.effectiveDefinitions, null);
  assert.deepEqual(
    saved.packages.entries.map((entry) => entry.event),
    [definition.envelope.id],
  );
  const restored = await restart();
  assert.deepEqual(errors, []);
  assert.deepEqual(await read("/receipts/" + merge.envelope.id), receipt);
  const manifest = await read("/manifest");
  assert.equal(manifest.snapshot, admitted.snapshot);
  assert.equal(manifest.view, view.envelope.id);
  assert.equal(manifest.packages_available, false);
  assert.deepEqual(manifest.packages, []);
  assert.deepEqual(manifest.package_versions, []);
  assert.equal(manifest.accepted_cursor, manifest.materialized_cursor);
  const identity = identityFromSeed(publisher);
  for (const path of [
    "/inventory?kind=events",
    "/records",
    `/identity-heads/${identity}`,
    `/identities/${identity}/activity`,
  ]) {
    const result = await read(
      path + `${path.includes("?") ? "&" : "?"}snapshot=${admitted.snapshot}`,
    );
    assert.equal(result.snapshot, admitted.snapshot);
  }
  assert.deepEqual(
    await read(`/events/${view.envelope.id}?snapshot=${admitted.snapshot}`),
    view.envelope,
  );
  assert.deepEqual(
    await read(
      `/bodies/${view.envelope.header.content.hash}?snapshot=${admitted.snapshot}`,
    ),
    view.body,
  );
  const probe = await restored.fetch(
    new Request(`http://local.invalid/api/v1/words/jvw1:${"0".repeat(64)}`),
  );
  assert.equal(probe.status, 503);
  for (const path of ["/packages/en", "/packages/en?version=2"]) {
    const response = await restored.fetch(
      new Request("http://local.invalid/api/v1" + path),
    );
    assert.equal(response.status, 503);
    assert.equal(
      ((await response.json()) as { code: string }).code,
      "resource_unavailable",
    );
  }
  // Another unavailable snapshot can reuse its internal package generation.
  const later = createEvent(
    publisher,
    [merge.envelope.id],
    "5".repeat(32),
    { kind: "identity.merge" },
    null,
  );
  const next = await restored.admitMany([utf8(JSON.stringify(later))]);
  await restored.flushMaterialization();
  assert.equal(
    (await coordinator.loadMetadata()).materialized_snapshot,
    next.snapshot,
  );
  assert.equal(
    (await read("/receipts/" + later.envelope.id)).snapshot,
    next.snapshot,
  );
  assert.equal(saved.packages.effectiveDefinitions, null);
  assert.deepEqual(
    (await entries(prior, 1)).map((entry) => entry.event),
    [definition.envelope.id],
  );
  restored.options.stateLimits = undefined;
  const recovery = createEvent(
    publisher,
    [later.envelope.id],
    "6".repeat(32),
    { kind: "identity.merge" },
    null,
  );
  const recovered = await restored.admitMany([utf8(JSON.stringify(recovery))]);
  await restored.flushMaterialization();
  const recoveredManifest = await read("/manifest");
  assert.equal(recoveredManifest.snapshot, recovered.snapshot);
  assert.equal(recoveredManifest.packages_available, true);
  for (const version of [1, 2] as const)
    assert.deepEqual(
      (await entries(recovered.snapshot, version)).map((entry) => entry.event),
      [definition.envelope.id],
    );
  assert.deepEqual(saved.packages.effectiveDefinitions, [
    definition.envelope.id,
  ]);
});

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

test("group pages bind cursors to the group and report known Lojban queries", async () => {
  const f = await fixture();
  const records = Array.from({ length: 4 }, (_, index) => {
    const spelling = index ? "klama" + index : "klama";
    const word = { language: "jbo" as const, spelling };
    return createEvent(
      publisher,
      [],
      (900 + index).toString(16).padStart(32, "0"),
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
        text: [["klama is in this synthetic definition."]],
        classification: { kind: "other" },
        license: { expression: "CC0-1.0" },
      },
    );
  });
  await f.admit(f.view, ...records);
  const first = await f.read(
    "/search?q=klama&language=en&group=lojban&limit=2",
  );
  assert.equal(first.all_lojban, true);
  assert.equal(first.hits.length, 2);
  assert.ok(first.next);
  assert.ok(
    first.hits.every((hit: any) =>
      ["headword", "headword-prefix"].includes(hit.match),
    ),
  );
  const second = await f.read(
    `/search?q=klama&language=en&group=lojban&limit=2&snapshot=${first.snapshot}&after=${first.next}`,
  );
  assert.equal(second.hits.length, 2);
  assert.equal(second.next, null);
  const definitions = await f.read(
    "/search?q=klama&language=en&group=definitions&limit=2",
  );
  assert.ok(definitions.hits.every((hit: any) => hit.match === "token"));
  const invalid = await f.service.fetch(
    new Request(
      `http://local.invalid/api/v1/search?q=klama&language=en&group=definitions&after=${first.next}`,
    ),
  );
  assert.equal(invalid.status, 400);
  assert.equal(((await invalid.json()) as { code: string }).code, "bad_cursor");
  const badGroup = await f.service.fetch(
    new Request(
      "http://local.invalid/api/v1/search?q=klama&language=en&group=unknown",
    ),
  );
  assert.equal(badGroup.status, 400);
});

test("known-word package evidence follows status-only changes, retirement filters, views, and legacy checkpoint upgrade", async () => {
  let saved: ServiceCheckpoint | undefined;
  const f = await fixture({
    coreVersion: "search-status-r2",
    checkpointIntervalMs: 0,
    checkpoints: {
      async load() {
        return saved ? structuredClone(saved) : null;
      },
      async save(_binding, value) {
        saved = structuredClone(value);
      },
    },
  });
  const definition = signedDefinition();
  await f.admit(f.view, definition);
  const prior = await f.snapshot();
  const packageRows = async (snapshot: string) =>
    (await f.entries(snapshot, 2)) as any[];
  assert.deepEqual((await packageRows(prior))[0].search_status, {
    view: f.view.envelope.id,
    status: "active",
  });
  const firstManifest = await f.read(
    `/packages/en?snapshot=${prior}&version=2`,
  );
  const v1 = await f.entries(prior, 1);
  assert.equal("search_status" in v1[0], false);
  assert.ok(saved);
  delete (saved.packages as any).searchDefinitions;
  delete (saved.packages as any).searchView;
  saved.packages = await buildPackages(
    (await f.coordinator.getSnapshot(prior))!,
    f.objects,
    undefined,
    undefined,
    false,
    [definition.envelope.id],
  );
  await f.restart();
  assert.deepEqual((await packageRows(prior))[0].search_status, {
    view: f.view.envelope.id,
    status: "active",
  });
  await f.admit(
    createEvent(
      publisher,
      [definition.envelope.id],
      "c".repeat(32),
      {
        kind: "status.set",
        target: definition.envelope.id,
        value: "deprecated",
      },
      null,
    ),
  );
  const current = await f.snapshot();
  const retiredRows = await packageRows(current);
  assert.deepEqual(retiredRows[0].search_status, {
    view: f.view.envelope.id,
    status: "retired",
  });
  const secondManifest = await f.read(
    `/packages/en?snapshot=${current}&version=2`,
  );
  assert.notEqual(secondManifest.parts[0].hash, firstManifest.parts[0].hash);
  assert.deepEqual((await packageRows(prior))[0].search_status, {
    view: f.view.envelope.id,
    status: "active",
  });
  Object.assign(globalThis, {
    location: new URL("http://local.invalid"),
    history: { state: null },
  });
  const { localSearch } = await import("../../../apps/web/src/data/search.ts");
  for (const includeRetired of [false, true]) {
    const params = new URLSearchParams({
      q: "klama",
      language: "en",
      group: "lojban",
      snapshot: current,
      view: f.view.envelope.id,
    });
    if (includeRetired) params.set("retired", "1");
    const remote = await f.read("/search?" + params);
    const local = localSearch(retiredRows, "klama", undefined, false, {
      includeRetired,
      view: f.view.envelope.id,
    });
    assert.equal(local.allLojban, includeRetired);
    assert.equal(local.allLojban, remote.all_lojban);
  }
  assert.equal(
    localSearch(retiredRows, "klama", undefined, false, {
      includeRetired: true,
      view: "jve1:" + "f".repeat(64),
    }).allLojban,
    false,
  );
  assert.equal(localSearch(v1 as any, "klama").allLojban, false);
});
