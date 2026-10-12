import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initializeCore,
  identityFromSeed,
  createEvent,
  wordId,
  canonicalize,
  utf8,
  contentHash,
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
const cases = new Set<string>();
const coordinators = new Set<SqliteCoordinator>();
afterEach(async () => {
  for (const coordinator of coordinators) coordinator.close();
  coordinators.clear();
  for (const directory of cases)
    await rm(directory, { recursive: true, force: true });
  cases.clear();
});
const read = async (response: Response): Promise<any> => response.json();
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
const author = new Uint8Array(32).fill(41);
const reviewer = new Uint8Array(32).fill(42);
const word = { language: "jbo" as const, spelling: "klama" };
const body = (text: string, notes: unknown[] = []) => ({
  word,
  language: "en",
  text: [[text]],
  frame: null,
  operands: [],
  glosses: [{ language: "en", text: "go", sense: null }],
  notes,
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
});
async function fixture() {
  await mkdir(process.env.JVC_TEST_ROOT ?? tmpdir(), { recursive: true });
  const directory = await mkdtemp(
    join(process.env.JVC_TEST_ROOT ?? tmpdir(), "jvc-reads-case-"),
  );
  cases.add(directory);
  const objects = new FileObjectStore(join(directory, "objects"));
  const coordinator = new SqliteCoordinator(
    join(directory, "coordinator.sqlite"),
    16,
  );
  coordinators.add(coordinator);
  const publish = {
    kind: "definition.publish",
    word: wordId(word),
    language: "en",
    parents: [],
    origin: "native",
  };
  const definition = createEvent(
    author,
    [],
    "1".repeat(32),
    publish,
    body("go", [["A note."]]),
  );
  const pair = { word: wordId(word), rafsi: "kla" };
  const pairId =
    "jvr1:" +
    contentHash(
      utf8("jbovlacku-rafsi-v1\n" + canonicalize(utf8(JSON.stringify(pair)))),
    ).slice(7);
  const claim = createEvent(
    author,
    [definition.envelope.id],
    "2".repeat(32),
    {
      kind: "rafsi.publish",
      word: pair.word,
      assignment: pairId,
      origin: "native",
    },
    { word, rafsi: "kla", rationale: [], sources: [], legacy: null },
  );
  const profile = createEvent(
    author,
    [claim.envelope.id],
    "3".repeat(32),
    { kind: "identity.profile" },
    { name: "la .alis.", bio: [["Test profile."]], links: [] },
  );
  const view = createEvent(
    reviewer,
    [],
    "4".repeat(32),
    { kind: "view.publish", parents: [] },
    {
      name: "Reads view",
      description: [],
      roots: [
        {
          identity: identityFromSeed(reviewer),
          q: { numerator: 1, denominator: 1 },
        },
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
    },
  );
  const heed = createEvent(
    reviewer,
    [view.envelope.id],
    "5".repeat(32),
    {
      kind: "trust.set",
      subject: identityFromSeed(author),
      scope: { kind: "*", word: "*", language: "*" },
      value: "heed",
    },
    null,
  );
  const bless = createEvent(
    reviewer,
    [heed.envelope.id],
    "6".repeat(32),
    { kind: "judgment.set", target: definition.envelope.id, value: "bless" },
    null,
  );
  const selfBless = createEvent(
    author,
    [profile.envelope.id],
    "7".repeat(32),
    { kind: "judgment.set", target: definition.envelope.id, value: "bless" },
    null,
  );
  const service = new DictionaryService(objects, coordinator, {
    serverId: "reads-node",
    policyUrl: "https://example.invalid/policy",
    selectedView: view.envelope.id,
  });
  for (const event of [
    view,
    definition,
    claim,
    profile,
    heed,
    bless,
    selfBless,
  ]) {
    const response = await service.fetch(request("/events", event));
    assert.ok(response.ok, await response.text());
  }
  return {
    service,
    definition,
    claim,
    profile,
    view,
    heed,
    bless,
    selfBless,
    pairId,
  };
}

test("word responses add bounded reviewer details only on request", async () => {
  const { service, definition } = await fixture();
  const plain = await read(
    await service.fetch(request(`/words/${wordId(word)}`)),
  );
  const score = plain.scores.find(
    (s: any) => s.target === definition.envelope.id,
  );
  assert.ok(score);
  assert.equal("reviewers" in score, false);
  assert.equal(score.direct_reviewers, 2);
  const detailed = await read(
    await service.fetch(request(`/words/${wordId(word)}?reviewers=1`)),
  );
  const withDetails = detailed.scores.find(
    (s: any) => s.target === definition.envelope.id,
  );
  assert.equal(withDetails.reviewers_complete, true);
  const byIdentity = Object.fromEntries(
    withDetails.reviewers.map((r: any) => [r.identity, r]),
  );
  const root = byIdentity[identityFromSeed(reviewer)];
  assert.deepEqual(root.root, { numerator: "1", denominator: "1" });
  assert.equal(root.verdict, "bless");
  assert.deepEqual(root.weight, [
    { numerator: "1", denominator: "1" },
    { numerator: "1", denominator: "1" },
  ]);
  assert.equal(root.multiple_routes, false);
  const heeded = byIdentity[identityFromSeed(author)];
  assert.equal(heeded.root, null);
  assert.deepEqual(heeded.incoming, [identityFromSeed(reviewer)]);
  assert.equal(heeded.incoming_count, 1);
  assert.equal(heeded.incoming_complete, true);
  assert.deepEqual(heeded.weight, [
    { numerator: "3", denominator: "1" },
    { numerator: "3", denominator: "1" },
  ]);
  // The aggregate is unchanged: 1 from the root plus 3 through the heed.
  assert.deepEqual(withDetails.support, [
    { numerator: "4", denominator: "1" },
    { numerator: "4", denominator: "1" },
  ]);
});

test("identity reads resolve the profile register and page activity in event order", async () => {
  const { service, profile, definition, claim, selfBless } = await fixture();
  const identity = identityFromSeed(author);
  const response = await service.fetch(
    request(`/identities/${encodeURIComponent(identity)}`),
  );
  assert.equal(response.status, 200);
  const value = await read(response);
  assert.equal(value.identity, identity);
  assert.equal(value.actor, identity);
  assert.equal(value.profile.state, "known");
  assert.equal(value.profile.claims.length, 1);
  assert.equal(value.profile.claims[0].event, profile.envelope.id);
  assert.equal(value.profile.claims[0].body.name, "la .alis.");
  assert.deepEqual(value.counts, {
    definitions: 1,
    rafsi: 1,
    judgments: 1,
    trust: 0,
    reports: 0,
    other: 1,
  });
  assert.equal(value.successor, null);
  assert.equal(value.retired, false);
  const unknown = await read(
    await service.fetch(
      request(`/identities/${encodeURIComponent("ed25519:" + "f".repeat(64))}`),
    ),
  );
  assert.equal(unknown.profile.state, "none");
  assert.deepEqual(unknown.counts, {
    definitions: 0,
    rafsi: 0,
    judgments: 0,
    trust: 0,
    reports: 0,
    other: 0,
  });
  const expected = [definition, claim, profile, selfBless]
    .map((e) => e.envelope.id)
    .sort();
  const first = await read(
    await service.fetch(
      request(`/identities/${encodeURIComponent(identity)}/activity?limit=3`),
    ),
  );
  assert.deepEqual(
    first.items.map((i: any) => i.id),
    expected.slice(0, 3),
  );
  assert.equal(first.next, expected[2]);
  assert.ok(
    first.items.every(
      (i: any) =>
        typeof i.action.kind === "string" && i.interpretation === "effective",
    ),
  );
  assert.ok(first.items.every((i: any) => typeof i.seen === "string"));
  const second = await read(
    await service.fetch(
      request(
        `/identities/${encodeURIComponent(identity)}/activity?limit=3&after=${encodeURIComponent(first.next)}`,
      ),
    ),
  );
  assert.deepEqual(
    second.items.map((i: any) => i.id),
    expected.slice(3),
  );
  assert.equal(second.next, null);
  const bad = await service.fetch(
    request(`/identities/${encodeURIComponent(identity)}/other`),
  );
  assert.equal(bad.status, 404);
});

test("records pages are bounded by count and carry bodies with their status", async () => {
  const { service } = await fixture();
  const all = await read(await service.fetch(request("/records")));
  assert.equal(all.items.length, 7);
  assert.equal(all.next, null);
  const ids = all.items.map((i: any) => i.id);
  assert.deepEqual(ids, [...ids].sort());
  for (const item of all.items) {
    assert.equal(item.envelope.id, item.id);
    if (item.envelope.header.content === null) {
      assert.equal(item.body, null);
      assert.equal(item.body_status, "none");
    } else {
      assert.equal(item.body_status, "present");
      const bytes = utf8(canonicalize(utf8(JSON.stringify(item.body))));
      assert.equal(contentHash(bytes), item.envelope.header.content.hash);
    }
  }
  const page = await read(await service.fetch(request("/records?limit=2")));
  assert.equal(page.items.length, 2);
  assert.equal(page.next, ids[1]);
  const rest = await read(
    await service.fetch(
      request(`/records?limit=200&after=${encodeURIComponent(page.next)}`),
    ),
  );
  assert.deepEqual(
    rest.items.map((i: any) => i.id),
    ids.slice(2),
  );
  assert.equal(rest.next, null);
  const tooMany = await service.fetch(request("/records?limit=201"));
  assert.equal(tooMany.status, 400);
});

test("version 2 search packages add issuer, notes, rafsi, and attribution beside version 1", async () => {
  const { service, definition } = await fixture();
  const manifest = await read(await service.fetch(request("/manifest")));
  assert.equal(manifest.packages.length, 1);
  assert.deepEqual(
    manifest.package_versions.map((p: any) => [p.language, p.version]),
    [["en", 2]],
  );
  const v1 = await read(await service.fetch(request("/packages/en")));
  assert.equal(v1.version, 1);
  const v2Response = await service.fetch(request("/packages/en?version=2"));
  const v2Bytes = new Uint8Array(await v2Response.arrayBuffer());
  assert.equal(contentHash(v2Bytes), manifest.package_versions[0].hash);
  const v2 = JSON.parse(new TextDecoder().decode(v2Bytes));
  assert.equal(v2.version, 2);
  const part = await read(
    await service.fetch(
      request(`/package-parts/${encodeURIComponent(v2.parts[0].hash)}`),
    ),
  );
  assert.equal(part.length, 1);
  assert.equal(part[0].event, definition.envelope.id);
  assert.equal(part[0].issuer, identityFromSeed(author));
  assert.equal(part[0].notes, true);
  assert.deepEqual(part[0].rafsi, ["kla"]);
  assert.equal(part[0].attribution, null);
  const v1Part = await read(
    await service.fetch(
      request(`/package-parts/${encodeURIComponent(v1.parts[0].hash)}`),
    ),
  );
  assert.equal("issuer" in v1Part[0], false);
  const bad = await service.fetch(request("/packages/en?version=3"));
  assert.equal(bad.status, 400);
});
