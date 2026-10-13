import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initializeCore,
  identityFromSeed,
  signHeader,
  canonicalize,
  contentHash,
  utf8,
  type Header,
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
const seed = new Uint8Array(32).fill(19);
const request = (path: string, body?: unknown) =>
  new Request(
    `http://localhost/api/v1${path}`,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
function event(
  kind = "identity.merge",
  body: unknown = null,
  previous: string[] = [],
) {
  const canonical =
    body === null ? null : canonicalize(utf8(JSON.stringify(body)));
  const header: Header = {
    version: 1,
    issuer: identityFromSeed(seed),
    previous,
    nonce: "a".repeat(32),
    action: { kind },
    content:
      canonical === null
        ? null
        : { hash: contentHash(utf8(canonical)), bytes: utf8(canonical).length },
  };
  return { envelope: signHeader(seed, header), body };
}
const cases = new Set<string>();
const coordinators = new Set<SqliteCoordinator>();
afterEach(async () => {
  for (const coordinator of coordinators) coordinator.close();
  coordinators.clear();
  for (const directory of cases)
    await rm(directory, { recursive: true, force: true });
  cases.clear();
});
async function instance(retention = 16) {
  await mkdir(process.env.JVC_TEST_ROOT ?? tmpdir(), {
    recursive: true,
  });
  const directory = await mkdtemp(
    join(process.env.JVC_TEST_ROOT ?? tmpdir(), "jvc-service-case-"),
  );
  cases.add(directory);
  const objects = new FileObjectStore(join(directory, "objects"));
  const coordinator = new SqliteCoordinator(
    join(directory, "coordinator.sqlite"),
    retention,
  );
  coordinators.add(coordinator);
  const options = {
    serverId: "test-node",
    policyUrl: "https://example.invalid/policy",
  };
  return {
    directory,
    objects,
    coordinator,
    service: new DictionaryService(objects, coordinator, options),
    options,
  };
}
test("strict transport rejects duplicate keys and unsafe numbers before JavaScript parsing", async () => {
  const { service, coordinator } = await instance();
  for (const body of [
    '{"envelope":{},"body":null,"body":null}',
    '{"envelope":{},"body":9007199254740993}',
    '{"envelope":{},"body":1.00000000000000001}',
  ]) {
    const response = await service.fetch(
      new Request("http://localhost/api/v1/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    assert.equal(response.status, 400);
  }
  assert.equal((await coordinator.load()).position, 0);
  coordinator.close();
});
test("retry and process storage reopen preserve one receipt and exact snapshot", async () => {
  const instanceA = await instance();
  const entry = event();
  const admitted = await instanceA.service.fetch(request("/events", entry));
  assert.equal(admitted.status, 201);
  const receipt: any = await admitted.json();
  const snapshot = receipt.snapshot;
  const duplicate = await instanceA.service.fetch(request("/events", entry));
  assert.equal(duplicate.status, 200);
  assert.equal(((await duplicate.json()) as any).cursor, receipt.cursor);
  instanceA.coordinator.close();
  const reopened = new SqliteCoordinator(
    join(instanceA.directory, "coordinator.sqlite"),
  );
  coordinators.add(reopened);
  const service = new DictionaryService(
    instanceA.objects,
    reopened,
    instanceA.options,
  );
  const stored = await service.fetch(
    request(`/events/${entry.envelope.id}?snapshot=${snapshot}`),
  );
  assert.equal(stored.status, 200);
  assert.deepEqual(await stored.json(), entry.envelope);
  const changes: any = await (await service.fetch(request("/changes"))).json();
  assert.equal(changes.items.length, 1);
  reopened.close();
});
test("late body completes one event and preserves earlier snapshot", async () => {
  const { service, coordinator } = await instance();
  const entry = event("identity.profile", {
    name: "Synthetic author",
    bio: [],
    links: [],
  });
  const first = await service.fetch(
    request("/events", { ...entry, body: null }),
  );
  assert.equal(first.status, 201);
  const earlier: any = await first.json();
  assert.equal(earlier.body_status, "missing");
  const complete = await service.fetch(request("/events", entry));
  assert.equal(complete.status, 200);
  const later: any = await complete.json();
  assert.equal(later.cursor, earlier.cursor);
  assert.equal(later.body_status, "present");
  assert.notEqual(later.snapshot, earlier.snapshot);
  const oldInventory: any = await (
    await service.fetch(
      request(`/inventory?kind=bodies&snapshot=${earlier.snapshot}`),
    )
  ).json();
  assert.deepEqual(oldInventory.ids, []);
  coordinator.close();
});
test("snapshot interruption keeps prior pointer and retry recovers orphan objects", async () => {
  const { service, objects, coordinator, options } = await instance();
  const before: any = await (await service.fetch(request("/manifest"))).json();
  const failing = new DictionaryService(objects, coordinator, {
    ...options,
    beforeCommit: async () => {
      throw new Error("Synthetic crash before transaction.");
    },
  });
  const entry = event();
  assert.equal((await failing.fetch(request("/events", entry))).status, 503);
  const after: any = await (await service.fetch(request("/manifest"))).json();
  assert.equal(after.snapshot, before.snapshot);
  assert.equal((await coordinator.load()).position, 0);
  assert.equal((await service.fetch(request("/events", entry))).status, 201);
  coordinator.close();
});
test("concurrent duplicate admission commits one receipt", async () => {
  const { service, coordinator } = await instance();
  const entry = event();
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => service.fetch(request("/events", entry))),
  );
  assert.deepEqual(
    responses.map((r) => r.status).sort(),
    [200, 200, 200, 200, 200, 200, 200, 201],
  );
  assert.equal((await coordinator.load()).journal.length, 1);
  coordinator.close();
});
test("snapshot inventory and cursor validation do not silently change context", async () => {
  const { service, coordinator } = await instance();
  await service.fetch(request("/events", event()));
  assert.equal(
    (
      await service.fetch(
        request("/inventory?kind=events&after=sha256:" + "0".repeat(64)),
      )
    ).status,
    400,
  );
  assert.equal((await service.fetch(request("/changes?after="))).status, 400);
  assert.equal(
    (await service.fetch(request("/changes?after=other.0"))).status,
    400,
  );
  assert.equal(
    (
      await service.fetch(
        request("/inventory?kind=events&snapshot=sha256:" + "f".repeat(64)),
      )
    ).status,
    410,
  );
  coordinator.close();
});
test("available bodies fill every matching descriptor and preserve snapshot reads", async () => {
  const { service, coordinator } = await instance();
  const entry = event("identity.profile", {
    name: "Shared body",
    bio: [],
    links: [],
  });
  const second = {
    envelope: signHeader(seed, {
      ...entry.envelope.header,
      nonce: "b".repeat(32),
    }),
    body: null,
  };
  const first: any = await (
    await service.fetch(request("/events", { ...entry, body: null }))
  ).json();
  await service.fetch(request("/events", second));
  const completed: any = await (
    await service.fetch(request("/events", entry))
  ).json();
  const other: any = await (
    await service.fetch(request("/receipts/" + second.envelope.id))
  ).json();
  assert.equal(other.body_status, "present");
  const hash = entry.envelope.header.content.hash;
  assert.equal(
    (await service.fetch(request(`/bodies/${hash}?snapshot=${first.snapshot}`)))
      .status,
    404,
  );
  assert.equal(
    (
      await service.fetch(
        request(`/bodies/${hash}?snapshot=${completed.snapshot}`),
      )
    ).status,
    200,
  );
  const third = {
    envelope: signHeader(seed, {
      ...entry.envelope.header,
      nonce: "d".repeat(32),
    }),
    body: null,
  };
  const thirdReceipt: any = await (
    await service.fetch(request("/events", third))
  ).json();
  assert.equal(thirdReceipt.body_status, "present");
  coordinator.close();
});
test("authenticated unknown action and invalid schema bodies remain stored with diagnostics", async () => {
  const { service, coordinator } = await instance();
  const entry = event("future.unknown", { future: "data" });
  const response = await service.fetch(request("/events", entry));
  assert.equal(response.status, 201);
  const receipt: any = await response.json();
  assert.equal(receipt.interpretation, "inert");
  assert.equal(receipt.body_status, "invalid");
  const bytes = await service.fetch(
    request("/bodies/" + entry.envelope.header.content.hash),
  );
  assert.equal(bytes.status, 200);
  assert.deepEqual(await bytes.json(), entry.body);
  coordinator.close();
});
test("configured public origin allows same-origin writes and rejects untrusted origins", async () => {
  const { objects, coordinator, options } = await instance();
  const service = new DictionaryService(objects, coordinator, {
    ...options,
    publicOrigin: "https://vm.example.ts.net",
  });
  const entry = event();
  const allowed = request("/events", entry);
  allowed.headers.set("origin", "https://vm.example.ts.net");
  assert.equal((await service.fetch(allowed)).status, 201);
  const denied = request("/events", entry);
  denied.headers.set("origin", "https://attacker.example");
  assert.equal((await service.fetch(denied)).status, 403);
  coordinator.close();
});
test("batch validates all carriers before one receipt transaction", async () => {
  const { objects, coordinator, options } = await instance();
  const service = new DictionaryService(objects, coordinator, {
    ...options,
    allowPrototypeBatch: true,
  });
  const first = event();
  const second = {
    envelope: signHeader(seed, {
      ...first.envelope.header,
      nonce: "b".repeat(32),
    }),
    body: null,
  };
  const requestBatch = (body: string) =>
    new Request("http://localhost/api/v1/prototype/batch", {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body,
    });
  assert.equal(
    (
      await service.fetch(
        requestBatch(
          JSON.stringify(first) + '\n{"envelope":{},"body":null,"body":null}\n',
        ),
      )
    ).status,
    400,
  );
  assert.equal((await coordinator.load()).position, 0);
  const response = await service.fetch(
    requestBatch(JSON.stringify(first) + "\n" + JSON.stringify(second) + "\n"),
  );
  assert.equal(response.status, 201);
  assert.equal((await coordinator.load()).position, 2);
  coordinator.close();
});
test("word scores use verified state, preserve exact zero, and disclose conflicts", async () => {
  const { objects, coordinator, options } = await instance();
  const { createEvent, wordId } = await import("../../core/src/index.ts");
  const word = { language: "jbo" as const, spelling: "klama" };
  const body = {
    word,
    language: "en",
    text: [["go"]],
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
      attribution: "Synthetic fixture",
    },
    legacy: null,
  };
  const definition = createEvent(
    seed,
    [],
    "1".repeat(32),
    {
      kind: "definition.publish",
      word: wordId(word),
      language: "en",
      parents: [],
      origin: "native",
    },
    body,
  );
  const policy = {
    name: "Synthetic view",
    description: [],
    roots: [
      { identity: identityFromSeed(seed), q: { numerator: 1, denominator: 1 } },
    ],
    rafsi_threshold: { numerator: 1, denominator: 1 },
    H: { numerator: 3, denominator: 1 },
    alpha: { numerator: 1, denominator: 2 },
    excluded: [],
    calculation: "simple-routes-bounds-v1",
    work: 1000,
    import_sets: [],
    account_witnesses: [],
    account_authority: false,
    notes: [],
  };
  const view = createEvent(
    seed,
    [],
    "2".repeat(32),
    { kind: "view.publish", parents: [] },
    policy,
  );
  const service = new DictionaryService(objects, coordinator, {
    ...options,
    selectedView: view.envelope.id,
  });
  await service.admitMany(
    [definition, view].map((value) => utf8(JSON.stringify(value))),
  );
  const zero: any = await (
    await service.fetch(request("/words/" + wordId(word)))
  ).json();
  assert.equal(zero.calculation.exact, true);
  assert.deepEqual(zero.scores[0].net, [
    { numerator: "0", denominator: "1" },
    { numerator: "0", denominator: "1" },
  ]);
  assert.deepEqual(zero.layers, [[definition.envelope.id]]);
  const judgment = createEvent(
    seed,
    [view.envelope.id],
    "3".repeat(32),
    { kind: "judgment.set", target: definition.envelope.id, value: "bless" },
    null,
  );
  await service.admit(utf8(JSON.stringify(judgment)));
  const blessed: any = await (
    await service.fetch(request("/words/" + wordId(word)))
  ).json();
  assert.deepEqual(blessed.scores[0].net, [
    { numerator: "1", denominator: "1" },
    { numerator: "1", denominator: "1" },
  ]);
  assert.equal(blessed.scores[0].direct_reviewers, 1);
  const active = createEvent(
    seed,
    [judgment.envelope.id],
    "4".repeat(32),
    { kind: "status.set", target: definition.envelope.id, value: "active" },
    null,
  );
  const deprecated = createEvent(
    seed,
    [judgment.envelope.id],
    "5".repeat(32),
    { kind: "status.set", target: definition.envelope.id, value: "deprecated" },
    null,
  );
  await service.admitMany(
    [active, deprecated].map((value) => utf8(JSON.stringify(value))),
  );
  const conflicted: any = await (
    await service.fetch(request("/words/" + wordId(word)))
  ).json();
  assert.equal(conflicted.statuses[0].state, "conflicted");
  assert.deepEqual(conflicted.scores, []);
  assert.deepEqual(conflicted.unavailable_scores, [definition.envelope.id]);
  coordinator.close();
});
test("native author construction rejects invalid schema while replication retains it", async () => {
  const { createEvent, prepareSigning, finishSigning } =
    await import("../../core/src/index.ts");
  assert.throws(() =>
    createEvent(
      seed,
      [],
      "1".repeat(32),
      { kind: "future.unknown" },
      { future: "data" },
    ),
  );
  const prepared = prepareSigning(
    identityFromSeed(seed),
    [],
    "6".repeat(32),
    { kind: "identity.merge" },
    null,
  );
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    Buffer.concat([prefix, seed]),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      key,
      new Uint8Array(prepared.signing_bytes).buffer,
    ),
  );
  const entry = finishSigning(prepared, signature);
  assert.equal(entry.envelope.header.issuer, identityFromSeed(seed));
  assert.deepEqual(entry.envelope, signHeader(seed, prepared.header));
});
test("Wasm malformed overlay matches the native unavailable result", async () => {
  const { evaluate } = await import("../../core/src/index.ts");
  const raw = await readFile(
    new URL(
      "../../../crates/jvc-runtime/tests/invalid-overlay.json",
      import.meta.url,
    ),
  );
  const input = JSON.parse(canonicalize(raw));
  const result = evaluate(input);
  assert.equal(result.available, false);
  assert.ok(result.reasons.includes("invalid_overlay"));
});

test("transport enclosure accepts a depth32 body and rejects depth33", async () => {
  const { service, coordinator } = await instance();
  let body: unknown = {};
  for (let i = 0; i < 31; i++) body = [body];
  const entry = event("future.unknown", body);
  assert.equal((await service.fetch(request("/events", entry))).status, 201);
  const oversized = JSON.stringify({ envelope: entry.envelope, body: [body] });
  assert.equal(
    (
      await service.fetch(
        new Request("http://localhost/api/v1/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: oversized,
        }),
      )
    ).status,
    400,
  );
  coordinator.close();
});
test("import selection preparation enforces200000 IDs and16 MiB", async () => {
  const { prepareSelection } = await import("../../core/src/index.ts");
  const ids = Array.from(
    { length: 200000 },
    (_, index) => "jve1:" + index.toString(16).padStart(64, "0"),
  );
  assert.equal(prepareSelection(utf8(JSON.stringify(ids))).count, 200000);
  ids.push("jve1:" + (200000).toString(16).padStart(64, "0"));
  assert.throws(() => prepareSelection(utf8(JSON.stringify(ids))));
  assert.throws(() => prepareSelection(new Uint8Array(16 * 1024 * 1024 + 1)));
});

test("unpublished reversed-order batch snapshot stays hidden and retry is deterministic", async () => {
  const { objects, coordinator, options } = await instance();
  const first = event();
  const second = {
    envelope: signHeader(seed, {
      ...first.envelope.header,
      nonce: "b".repeat(32),
    }),
    body: null,
  };
  let failedSnapshot: string | null = null;
  const service = new DictionaryService(objects, coordinator, {
    ...options,
    beforeCommit: async (state) => {
      if (failedSnapshot === null) {
        failedSnapshot = state.snapshot;
        throw new Error("injected before publication");
      }
    },
  });
  await assert.rejects(
    service.admitMany(
      [first, second].map((value) => utf8(JSON.stringify(value))),
    ),
    /injected before publication/,
  );
  assert.equal(
    (
      await service.fetch(
        request(`/inventory?kind=events&snapshot=${failedSnapshot}`),
      )
    ).status,
    410,
  );
  const result = await service.admitMany(
    [second, first].map((value) => utf8(JSON.stringify(value))),
  );
  assert.equal(result.snapshot, failedSnapshot);
  assert.equal(
    (
      await service.fetch(
        request(`/inventory?kind=events&snapshot=${failedSnapshot}`),
      )
    ).status,
    200,
  );
  assert.equal((await coordinator.load()).journal[0].id, second.envelope.id);
  coordinator.close();
});
test("concurrent distinct evaluations stay bounded and same-key work is shared", async () => {
  const { service, objects, coordinator, options } = await instance();
  const entry = event();
  await service.admit(utf8(JSON.stringify(entry)));
  const state = await coordinator.load();
  const snapshot = await coordinator.getSnapshot(state.snapshot!);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const delayed = {
    async get(hash: string) {
      if (hash === state.events[entry.envelope.id].envelope_hash) {
        reads++;
        await gate;
      }
      return objects.get(hash);
    },
    put: objects.put.bind(objects),
  };
  const bounded: any = new DictionaryService(delayed, coordinator, options);
  const first = bounded.evaluation(snapshot, "jve1:" + "1".repeat(64));
  assert.equal(bounded.evaluation(snapshot, "jve1:" + "1".repeat(64)), first);
  const second = bounded.evaluation(snapshot, "jve1:" + "2".repeat(64));
  await assert.rejects(
    bounded.evaluation(snapshot, "jve1:" + "3".repeat(64)),
    (error: any) => error.code === "resource_unavailable",
  );
  assert.equal(reads, 2);
  release();
  await Promise.all([first, second]);
  assert.equal(bounded.sessions.size, 2);
  await bounded.evaluation(snapshot, "jve1:" + "3".repeat(64));
  assert.equal(bounded.sessions.size, 2);
  assert.equal(bounded.evaluationCache.size, 2);
  coordinator.close();
});
test("package builds share work, bound concurrent snapshots, and release failed work", async () => {
  const { service, objects, coordinator, options } = await instance();
  const { createEvent, wordId } = await import("../../core/src/index.ts");
  const word = { language: "jbo" as const, spelling: "klama" };
  const body = {
    word,
    language: "en",
    text: [["Package cache fixture"]],
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
      attribution: "Synthetic fixture",
    },
    legacy: null,
  };
  const snapshots: any[] = [];
  for (const nonce of ["1", "2", "3"]) {
    const entry = createEvent(
      seed,
      [],
      nonce.repeat(32),
      {
        kind: "definition.publish",
        word: wordId(word),
        language: "en",
        parents: [],
        origin: "native",
      },
      body,
    );
    const receipt: any = await (
      await service.admit(utf8(JSON.stringify(entry)))
    ).json();
    snapshots.push(await coordinator.getSnapshot(receipt.snapshot));
  }
  const firstHash =
    snapshots[0].events[Object.keys(snapshots[0].events)[0]].envelope_hash;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  let fail = false;
  const delayed = {
    async get(hash: string) {
      if (hash === firstHash) {
        reads++;
        await gate;
        if (fail) {
          fail = false;
          throw new Error("injected package read failure");
        }
      }
      return objects.get(hash);
    },
    put: objects.put.bind(objects),
  };
  const bounded: any = new DictionaryService(delayed, coordinator, options);
  const first = bounded.packages(snapshots[0]);
  assert.equal(bounded.packages(snapshots[0]), first);
  const second = bounded.packages(snapshots[1]);
  await assert.rejects(
    bounded.packages(snapshots[2]),
    (error: any) =>
      error.status === 503 && error.code === "resource_unavailable",
  );
  assert.equal(reads, 2);
  release();
  const built = await Promise.all([first, second]);
  assert.deepEqual(
    built.map((value) => value.entries.length),
    [1, 2],
  );
  assert.equal(bounded.inFlightPackages.size, 0);
  assert.equal(bounded.packageCache.size, 2);
  fail = true;
  const failed = bounded.packages(snapshots[2]);
  assert.equal(bounded.packages(snapshots[2]), failed);
  await assert.rejects(failed, /injected package read failure/);
  assert.equal(bounded.inFlightPackages.size, 0);
  assert.equal(bounded.packageCache.has(snapshots[2].snapshot), false);
  assert.equal((await bounded.packages(snapshots[2])).entries.length, 3);
  assert.equal(bounded.packageCache.size, 2);
  coordinator.close();
});
test("search preview uses strongest lexical entry with stable ties and active-view status", async () => {
  const { objects, coordinator, options } = await instance();
  const { createEvent, wordId } = await import("../../core/src/index.ts");
  const word = { language: "jbo" as const, spelling: "klama" };
  const baseBody = {
    word,
    language: "en",
    text: [["movement token-only entry"]],
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
      attribution: "Synthetic search fixture",
    },
    legacy: null,
  };
  const action = {
    kind: "definition.publish",
    word: wordId(word),
    language: "en",
    parents: [],
    origin: "native",
  };
  const token = createEvent(seed, [], "7".repeat(32), action, baseBody);
  const glossBody = {
    ...baseBody,
    text: [
      [
        1,
        " goes to a destination. ",
        "😀".repeat(260),
        {
          url: "https://example.invalid/hidden-metadata",
          label: "readable source",
        },
      ],
    ],
    frame: {
      role: "predicate",
      arity: { mode: "fixed", count: 1 },
      places: [
        {
          index: 1,
          glosses: [],
          description: [],
          type_hints: [],
          defaults: [],
          constraints: [],
          derivation: [],
        },
      ],
      tail: null,
      constraints: [],
    },
    glosses: [{ language: "en", text: "movement", sense: null }],
  };
  const glossA = createEvent(seed, [], "8".repeat(32), action, glossBody);
  const glossB = createEvent(seed, [], "9".repeat(32), action, glossBody);
  const view = createEvent(
    seed,
    [],
    "c".repeat(32),
    { kind: "view.publish", parents: [] },
    {
      name: "Synthetic search view",
      description: [],
      roots: [
        {
          identity: identityFromSeed(seed),
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
    ...options,
    selectedView: view.envelope.id,
  });
  await service.admitMany(
    [token, glossA, glossB, view].map((value) => utf8(JSON.stringify(value))),
  );
  const search = () => service.fetch(request("/search?q=movement&language=en"));
  const first: any = await (await search()).json();
  const expected = [glossA.envelope.id, glossB.envelope.id].sort()[0];
  assert.equal(first.hits.length, 1);
  assert.equal(first.hits[0].match, "gloss");
  assert.deepEqual(
    first.hits[0].definitions,
    [token.envelope.id, glossA.envelope.id, glossB.envelope.id].sort(),
  );
  assert.deepEqual(
    { ...first.hits[0].preview, plain_text: undefined },
    {
      event: expected,
      word_kind: "gismu",
      status: "active",
      plain_text: undefined,
    },
  );
  assert.equal(Array.from(first.hits[0].preview.plain_text).length, 240);
  assert.ok(first.hits[0].preview.plain_text.startsWith("① goes"));
  assert.ok(first.hits[0].preview.plain_text.endsWith("…"));
  const deprecated = createEvent(
    seed,
    [view.envelope.id],
    "d".repeat(32),
    { kind: "status.set", target: expected, value: "deprecated" },
    null,
  );
  await service.admit(utf8(JSON.stringify(deprecated)));
  const later: any = await (await search()).json();
  assert.equal(
    later.hits[0].preview.event,
    expected === glossA.envelope.id ? glossB.envelope.id : glossA.envelope.id,
  );
  assert.equal(later.hits[0].preview.status, "active");
  assert.equal(later.hits[0].definitions.includes(expected), false);
  // The retired-results filter includes the deprecated definition with its status.
  const withRetired: any = await (
    await service.fetch(request("/search?q=movement&language=en&retired=1"))
  ).json();
  assert.equal(withRetired.hits[0].definitions.includes(expected), true);
  assert.ok(withRetired.hits[0].definitions.length >= 2);
  assert.ok(
    withRetired.hits.every((hit: any) =>
      ["active", "deprecated"].includes(hit.preview.status),
    ),
  );
  const bad = await service.fetch(
    request("/search?q=movement&language=en&retired=2"),
  );
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as { code: string }).code, "retired");
  coordinator.close();
});
test("search text preserves place markers and readable rich nodes without metadata", async () => {
  const { plainDefinitionText } = await import("../src/packages.ts");
  assert.equal(
    plainDefinitionText([
      [
        1,
        " runs on ",
        20,
        ". ",
        { code: "lo ka ce'u cadzu" },
        " ",
        {
          word: { language: "jbo", spelling: "hidden-spelling" },
          label: "visible word",
        },
        " ",
        { url: "https://example.invalid/hidden-url", label: "visible source" },
        " ",
        { operand: "bridi" },
      ],
      [21, " remains declared."],
      [{ metadata: "hidden metadata" }],
    ]),
    "① runs on ⑳. lo ka ce'u cadzu visible word visible source [operand bridi]\n[place 21] remains declared.\n",
  );
});

test("snapshot cache bounds history, expires old IDs, and survives restart without wrapper objects", async () => {
  const { service, objects, coordinator, directory, options } =
    await instance(3);
  const originalPut = objects.put.bind(objects);
  const keys: string[] = [];
  objects.put = async (key, bytes) => {
    keys.push(key);
    await originalPut(key, bytes);
  };
  const receipts: any[] = [];
  const entries = Array.from({ length: 7 }, (_, index) => ({
    envelope: signHeader(seed, {
      ...event().envelope.header,
      nonce: index.toString(16).repeat(32),
    }),
    body: null,
  }));
  for (const entry of entries)
    receipts.push(
      await (await service.admit(utf8(JSON.stringify(entry)))).json(),
    );
  const state = await coordinator.load();
  assert.equal(state.snapshots.length, 3);
  assert(keys.every((key) => !key.startsWith("snapshot")));
  assert.equal(
    (
      await service.fetch(
        request(`/inventory?kind=events&snapshot=${receipts[0].snapshot}`),
      )
    ).status,
    410,
  );
  assert.equal(
    (
      await service.fetch(
        request(`/inventory?kind=events&snapshot=${receipts[4].snapshot}`),
      )
    ).status,
    200,
  );
  const retry: any = await (
    await service.admit(utf8(JSON.stringify(entries[6])))
  ).json();
  assert.equal(retry.snapshot, receipts[6].snapshot);
  assert.equal((await coordinator.load()).snapshots.length, 3);
  coordinator.close();
  const reopened = new SqliteCoordinator(
    join(directory, "coordinator.sqlite"),
    3,
  );
  coordinators.add(reopened);
  const restarted = new DictionaryService(objects, reopened, options);
  assert.equal(
    (
      await restarted.fetch(
        request(`/inventory?kind=events&snapshot=${receipts[0].snapshot}`),
      )
    ).status,
    410,
  );
  const oldRetry: any = await (
    await restarted.admit(utf8(JSON.stringify(entries[0])))
  ).json();
  assert.equal(oldRetry.cursor, receipts[0].cursor);
  assert.equal(oldRetry.snapshot, receipts[6].snapshot);
});

test("cached wrapper chunks preserve a non-BMP character at the chunk boundary and refresh republished IDs", async () => {
  const { coordinator } = await instance(2);
  const { canonicalizeStorageWrapper } =
    await import("../../core/src/index.ts");
  const state = await coordinator.load();
  const hash = "sha256:" + "1".repeat(64);
  const emptyHash = "sha256:" + "0".repeat(64);
  const fixture: any = {
    snapshot: hash,
    logical_inventory: hash,
    manifest: {
      version: 1,
      events: { count: 0, hash: emptyHash },
      bodies: { count: 0, hash: emptyHash },
      import_selections: { count: 0, hash: emptyHash },
    },
    events: {},
    bodies: [],
    import_selections: [],
    padding: "",
  };
  const canonical = canonicalizeStorageWrapper(utf8(JSON.stringify(fixture)));
  const start = canonical.indexOf('"padding":"') + '"padding":"'.length;
  fixture.padding = "x".repeat(199_999 - start) + "😀" + "y".repeat(20);
  assert.equal(
    canonicalizeStorageWrapper(utf8(JSON.stringify(fixture))).charCodeAt(
      199_999,
    ),
    0xd83d,
  );
  assert(
    await coordinator.compareAndSwap(
      state.revision,
      { ...state, revision: 1, snapshot: hash },
      fixture,
    ),
  );
  assert.deepEqual(await coordinator.getSnapshot(hash), fixture);
  const snapshots = [
    fixture,
    { ...fixture, snapshot: "sha256:" + "2".repeat(64) },
    { ...fixture, snapshot: "sha256:" + "3".repeat(64) },
  ];
  for (const snapshot of [snapshots[1], snapshots[0], snapshots[2]]) {
    const current = await coordinator.load();
    assert(
      await coordinator.compareAndSwap(
        current.revision,
        {
          ...current,
          revision: current.revision + 1,
          snapshot: snapshot.snapshot,
        },
        snapshot,
      ),
    );
  }
  assert(await coordinator.getSnapshot(hash));
  assert.equal(await coordinator.getSnapshot(snapshots[1].snapshot), null);
  const before = await coordinator.load();
  assert.equal(
    await coordinator.compareAndSwap(
      before.revision - 1,
      {
        ...before,
        revision: before.revision + 1,
        snapshot: snapshots[1].snapshot,
      },
      snapshots[1],
    ),
    false,
  );
  assert.equal(await coordinator.getSnapshot(snapshots[1].snapshot), null);
});

test("migration retains only the matching current snapshot and rejects corrupt pointers", async () => {
  const { service, coordinator, objects, options, directory } =
    await instance();
  const entry = event();
  const receipt: any = await (
    await service.admit(utf8(JSON.stringify(entry)))
  ).json();
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(join(directory, "coordinator.sqlite"));
  database.exec(
    "DELETE FROM cached_snapshot_chunks; DELETE FROM cached_snapshots;",
  );
  const migrated = new DictionaryService(objects, coordinator, options);
  assert.equal(
    (await migrated.fetch(request("/inventory?kind=events"))).status,
    200,
  );
  assert.deepEqual((await coordinator.load()).snapshots, [receipt.snapshot]);
  database.exec(
    "DELETE FROM cached_snapshot_chunks; DELETE FROM cached_snapshots;",
  );
  const state = await coordinator.load();
  const bad = {
    ...state,
    revision: state.revision + 1,
    snapshot: "sha256:" + "f".repeat(64),
  };
  assert(await coordinator.compareAndSwap(state.revision, bad));
  assert.equal(
    (await migrated.fetch(request("/inventory?kind=events"))).status,
    503,
  );
  assert.equal((await coordinator.load()).snapshot, bad.snapshot);
  database.close();
});

test("current snapshot reads retry if its wrapper expires after the pointer read", async () => {
  const { service, coordinator, objects, options } = await instance(1);
  await service.admit(utf8(JSON.stringify(event())));
  let changed = false;
  const racing = {
    load: coordinator.load.bind(coordinator),
    compareAndSwap: coordinator.compareAndSwap.bind(coordinator),
    async getSnapshot(id: string) {
      if (!changed) {
        changed = true;
        const entry = {
          envelope: signHeader(seed, {
            ...event().envelope.header,
            nonce: "b".repeat(32),
          }),
          body: null,
        };
        await service.admit(utf8(JSON.stringify(entry)));
      }
      return coordinator.getSnapshot(id);
    },
  };
  const reader = new DictionaryService(objects, racing, options);
  const response = await reader.fetch(request("/inventory?kind=events"));
  assert.equal(response.status, 200);
  const inventory: any = await response.json();
  assert.equal(inventory.snapshot, (await coordinator.load()).snapshot);
});

test("same-origin writes work with the default standalone configuration", async () => {
  const { service, coordinator } = await instance();
  for (const origin of ["http://localhost", "https://container.example"]) {
    const value = new Request(`${origin}/api/v1/events`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(event()),
    });
    assert([200, 201].includes((await service.fetch(value)).status));
  }
  const denied = request("/events", event());
  denied.headers.set("origin", "https://attacker.example");
  assert.equal((await service.fetch(denied)).status, 403);
  coordinator.close();
});

function viewFixture(nonce: string) {
  return {
    envelope: signHeader(seed, {
      ...event("view.publish", {
        name: "Synthetic preflight view " + nonce,
        description: [],
        roots: [],
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
      }).envelope.header,
      nonce: nonce.repeat(32),
      action: { kind: "view.publish", parents: [] },
    }),
    body: {
      name: "Synthetic preflight view " + nonce,
      description: [],
      roots: [],
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
  };
}

test("view preflight rejects invented, wrong-kind, absent, and invalid views without evicting the configured view", async () => {
  const { objects, coordinator, options } = await instance();
  const views = [viewFixture("1"), viewFixture("2"), viewFixture("3")];
  const absent = { ...viewFixture("4"), body: null };
  const invalidBase = event("view.publish", {});
  const invalid = {
    ...invalidBase,
    envelope: signHeader(seed, {
      ...invalidBase.envelope.header,
      action: { kind: "view.publish", parents: [] },
    }),
  };
  const plain = event();
  let reads = 0;
  const counted = {
    get(hash: string) {
      reads++;
      return objects.get(hash);
    },
    put: objects.put.bind(objects),
  };
  const service: any = new DictionaryService(counted, coordinator, {
    ...options,
    selectedView: views[0].envelope.id,
  });
  const admitted = await service.admitMany(
    [...views, absent, invalid, plain].map((entry) =>
      utf8(JSON.stringify(entry)),
    ),
  );
  const key = admitted.snapshot + "|" + views[0].envelope.id;
  const cached = service.evaluationCache.get(key);
  assert(cached);
  reads = 0;
  for (const view of ["jve1:" + "f".repeat(64), plain.envelope.id])
    assert.equal(
      (await service.fetch(request(`/search?q=klama&language=en&view=${view}`)))
        .status,
      404,
    );
  assert.equal(reads, 0);
  for (const view of [absent.envelope.id, invalid.envelope.id])
    assert.equal(
      (await service.fetch(request(`/search?q=klama&language=en&view=${view}`)))
        .status,
      422,
    );
  assert.equal(reads, 2);
  for (const view of views.slice(1))
    assert.equal(
      (
        await service.fetch(
          request(`/search?q=klama&language=en&view=${view.envelope.id}`),
        )
      ).status,
      200,
    );
  assert.equal(service.evaluationCache.get(key), cached);
  assert.equal(service.sessions.size, 2);
});

test("committed admission returns a durable receipt while evaluation slots are busy", async () => {
  const { service, objects, coordinator, options } = await instance();
  await service.admit(utf8(JSON.stringify(event())));
  const snapshot = await coordinator.getSnapshot(
    (await coordinator.load()).snapshot!,
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const delayed = {
    async get(hash: string) {
      if (reads++ < 2) await gate;
      return objects.get(hash);
    },
    put: objects.put.bind(objects),
  };
  const bounded: any = new DictionaryService(delayed, coordinator, options);
  const first = bounded.evaluation(snapshot, "jve1:" + "1".repeat(64));
  const second = bounded.evaluation(snapshot, "jve1:" + "2".repeat(64));
  const entry = {
    envelope: signHeader(seed, {
      ...event().envelope.header,
      nonce: "b".repeat(32),
    }),
    body: null,
  };
  const response = await bounded.admit(utf8(JSON.stringify(entry)));
  assert.equal(response.status, 201);
  const receipt: any = await response.json();
  assert.equal(receipt.interpretation, "unavailable");
  assert.deepEqual(receipt.reasons, ["evaluation_resource_unavailable"]);
  assert.equal((await coordinator.load()).position, 2);
  release();
  await Promise.all([first, second]);
  const duplicate: any = await (
    await bounded.admit(utf8(JSON.stringify(entry)))
  ).json();
  assert.equal(duplicate.cursor, receipt.cursor);
  assert.equal(duplicate.admission, "duplicate");
});

test("alternate views evict older configured snapshots while preserving the latest configured evaluation", async () => {
  const { objects, coordinator, options } = await instance();
  const configured = viewFixture("1");
  const alternate = viewFixture("2");
  const service: any = new DictionaryService(objects, coordinator, {
    ...options,
    selectedView: configured.envelope.id,
  });
  await service.admitMany(
    [configured, alternate].map((entry) => utf8(JSON.stringify(entry))),
  );
  const extra = event();
  const receipt: any = await (
    await service.admit(utf8(JSON.stringify(extra)))
  ).json();
  const currentKey = receipt.snapshot + "|" + configured.envelope.id;
  const current = service.evaluationCache.get(currentKey);
  assert(current);
  assert.equal(service.evaluationCache.size, 2);
  assert(
    [...service.evaluationCache.keys()].every((key: any) =>
      key.endsWith("|" + configured.envelope.id),
    ),
  );
  assert.equal(
    (
      await service.fetch(
        request(`/search?q=klama&language=en&view=${alternate.envelope.id}`),
      )
    ).status,
    200,
  );
  assert.equal(service.evaluationCache.get(currentKey), current);
  assert.equal(
    (await service.fetch(request("/search?q=klama&language=en"))).status,
    200,
  );
  assert.equal(service.evaluationCache.get(currentKey), current);
  assert.equal(service.evaluationCache.size, 2);
});

test("private snapshot serialization matches existing Rust rows for difficult keys and numbers", async () => {
  const { serializeSnapshotCache } = await import("../src/snapshot-cache.ts");
  const { canonicalizeStorageWrapper } =
    await import("../../core/src/index.ts");
  const difficult: any = JSON.parse(
    '{"2":{"10":1,"2":2,"1":3,"__proto__":{"😀":"astral 😀"}},"10":10000000,"1":1000000,"😀":9007199254740991,"𐀀":-9007199254740991,"zero":-0,"integer":1}',
  );
  const serialized = serializeSnapshotCache(difficult);
  assert.equal(
    serialized,
    canonicalizeStorageWrapper(utf8(JSON.stringify(difficult))),
  );
  assert.deepEqual(
    JSON.parse(serialized),
    JSON.parse(canonicalizeStorageWrapper(utf8(JSON.stringify(difficult)))),
  );
  assert(serialized.includes('"__proto__"'));
  for (const value of [0.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(
      () => serializeSnapshotCache({ value } as any),
      /Invalid derived snapshot cache value/,
    );
  assert(serialized.indexOf('"1"') < serialized.indexOf('"10"'));
  assert(serialized.indexOf('"10"') < serialized.indexOf('"2"'));
});

test("all early request rejections cancel unread uploads without touching consumed streams", async () => {
  const { service } = await instance();
  const cases: [string, string, Record<string, string>, number][] = [
    ["/events", "POST", { "content-type": "text/plain" }, 400],
    [
      "/events",
      "POST",
      { "content-type": "application/json", "content-encoding": "gzip" },
      400,
    ],
    [
      "/events",
      "POST",
      { "content-type": "application/json", "content-length": "99999999" },
      413,
    ],
    ["/unknown", "POST", { "content-type": "application/json" }, 405],
    ["/events", "PATCH", { "content-type": "application/json" }, 405],
    [
      "/events",
      "POST",
      {
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      403,
    ],
  ];
  for (const [path, method, headers, status] of cases) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const value = new Request("http://localhost/api/v1" + path, {
      method,
      headers,
      body,
      duplex: "half",
    } as RequestInit);
    assert.equal((await service.fetch(value)).status, status);
    assert(cancelled, path + " " + JSON.stringify(headers));
  }
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(utf8('{"invalid":true}'));
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const value = new Request("http://localhost/api/v1/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit);
  assert.equal((await service.fetch(value)).status, 400);
  assert.equal(cancelled, false);
});

test("a signed view selects its calculation profile, and the bounds view keeps its results beside a refusal view over the same graph", async () => {
  const { buildFixture } = await import("../../../apps/web/test/seed.ts");
  const { service } = await instance(64);
  const { events, view, fixture, selection } =
    await buildFixture("http://localhost");
  const selectionResponse = await service.fetch(
    new Request("http://localhost/api/v1/import-selections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: selection,
    }),
  );
  assert.ok(selectionResponse.ok, await selectionResponse.text());
  assert.ok((await service.fetch(request("/events", view))).ok);
  for (const admitted of events)
    if (admitted !== view) {
      const response = await service.fetch(request("/events", admitted));
      assert.ok(response.ok, await response.text());
    }
  const rank = async (chosen: string): Promise<any> =>
    (
      await service.fetch(
        request(
          `/words/${encodeURIComponent(fixture.words.dunda)}?view=${encodeURIComponent(chosen)}&reviewers=1`,
        ),
      )
    ).json();
  const fraction = (value: { numerator: string; denominator: string }) =>
    `${value.numerator}/${value.denominator}`;
  const weights = (word: any, target: string) =>
    Object.fromEntries(
      word.scores
        .find((s: any) => s.target === target)
        .reviewers.map((r: any) => [
          Object.entries(fixture.identities).find(
            ([, id]) => id === r.identity,
          )?.[0],
          r.weight ? fraction(r.weight[0]) : null,
        ]),
    );
  const shun = await rank(fixture.views.shun);
  const bounds = await rank(fixture.views.shunGraphBounds);
  assert.equal(shun.calculation.algorithm, "simple-routes-shun-v1");
  assert.equal(bounds.calculation.algorithm, "simple-routes-bounds-v1");
  assert.equal(shun.calculation.exact, true);
  assert.equal(bounds.calculation.exact, true);
  // Root C shuns delegate2: the route C -> curator2 -> delegate2 is refused,
  // and D -> curator2 -> delegate2 survives. Curator2 shuns outcast: the route
  // through delegate2 is refused, while D's direct heed and outcast's own
  // allowance survive. Scoped is reached through delegate2 only, and D's
  // cleared shun leaves no refusal. Loner has no route and weight 0.
  assert.deepEqual(weights(shun, fixture.definitions.dunda1), {
    delegate2: "3/4",
    outcast: "7/4",
    loner: "0/1",
  });
  assert.deepEqual(weights(bounds, fixture.definitions.dunda1), {
    delegate2: "9/4",
    outcast: "37/16",
    loner: "0/1",
  });
  assert.deepEqual(weights(shun, fixture.definitions.dunda2), {
    curator2: "9/2",
    scoped: "3/16",
    outcast: "7/4",
  });
  assert.deepEqual(weights(bounds, fixture.definitions.dunda2), {
    curator2: "9/2",
    scoped: "9/16",
    outcast: "37/16",
  });
  for (const word of [shun, bounds])
    for (const score of word.scores) assert.equal(score.direct_reviewers, 3);
  // The server's selected bounds view is unchanged by the scenario.
  const cukta: any = await (
    await service.fetch(
      request(
        `/words/${encodeURIComponent(fixture.words.cukta)}?view=${encodeURIComponent(fixture.views.bounds)}`,
      ),
    )
  ).json();
  assert.equal(cukta.calculation.algorithm, "simple-routes-bounds-v1");
  assert.deepEqual(
    cukta.scores.map((s: any) => fraction(s.net[0])),
    ["3/1", "-3/1", "6/1", "0/1", "6/1"],
  );
});
