import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initializeCore,
  identityFromSeed,
  createEvent,
  interpretDefinition,
  signHeader,
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
async function fixture(
  options: {
    limits?: {
      reviewers?: number;
      profileClaims?: number;
      recordBytes?: number;
    };
    extra?: ReturnType<typeof createEvent>[];
  } = {},
) {
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
    limits: options.limits,
  });
  for (const event of [
    view,
    definition,
    claim,
    profile,
    heed,
    bless,
    selfBless,
    ...(options.extra ?? []),
  ]) {
    const response = await service.fetch(request("/events", event));
    assert.ok(response.ok, await response.text());
  }
  return {
    service,
    objects,
    directory,
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

test("authenticated package projections preserve raw builds and canonical part bytes", async () => {
  const { buildPackages } = await import("../src/packages.ts");
  const imported = importedDefinition();
  const { service, objects } = await fixture({ extra: [imported] });
  const { snapshot } = await (service as any).current();
  const projections = (service as any).packageRecords.get(snapshot.snapshot);
  assert.ok(projections?.length);
  const raw = await buildPackages(snapshot, objects);
  const prepared = await buildPackages(snapshot, objects, projections);
  assert.deepEqual(prepared, raw);
  const fallback = await buildPackages(
    snapshot,
    objects,
    projections.map((record: any) => ({ ...record, missing: true })),
  );
  assert.deepEqual(fallback, raw);
  const compact = projections.map((record: any) => ({
    ...record,
    body: record.body
      ? Object.defineProperty({ ...record.body }, "toJSON", {
          value() {
            throw new Error("Compact fields must not be interpreted again.");
          },
        })
      : null,
  }));
  const trusted = await buildPackages(
    snapshot,
    objects,
    compact,
    undefined,
    true,
  );
  assert.deepEqual(trusted, raw);
  for (const pkg of [
    ...Object.values(prepared.packages),
    ...Object.values(prepared.packages2),
  ]) {
    for (const part of pkg.manifest.parts) {
      const bytes = (await objects.get(part.hash))!;
      const entries = JSON.parse(new TextDecoder().decode(bytes));
      const expected = utf8(canonicalize(utf8(JSON.stringify(entries))));
      assert.deepEqual(new Uint8Array(bytes), expected);
      assert.equal(part.bytes, expected.length);
      assert.equal(part.count, entries.length);
      assert.equal(part.hash, contentHash(expected));
    }
  }
});

/** An imported definition with attribution and source dates. */
function importedDefinition() {
  const importer = new Uint8Array(32).fill(43);
  const importWord = { language: "jbo" as const, spelling: "ckusro" };
  return createEvent(
    importer,
    [],
    "8".repeat(32),
    {
      kind: "definition.publish",
      word: wordId(importWord),
      language: "en",
      parents: [],
      origin: "import",
    },
    {
      ...body("x1 is a library of books x2."),
      word: importWord,
      classification: { kind: "lujvo", selmaho: [] },
      license: {
        expression: "unknown",
        url: null,
        attribution: "Source author unknown",
      },
      legacy: {
        source: "https://lensisku.invalid",
        snapshot: "sha256:" + "a".repeat(64),
        extraction: "reads-test-1",
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
                label: "definition 42 user_id",
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
          tool: "reads-test",
          version: "1",
          model: null,
          review: "unreviewed",
          mappings: [],
          warnings: [],
        },
        limitations: ["Synthetic test record."],
      },
    },
  );
}
const pairIdFor = (pair: { word: string; rafsi: string }) =>
  "jvr1:" +
  contentHash(
    utf8("jbovlacku-rafsi-v1\n" + canonicalize(utf8(JSON.stringify(pair)))),
  ).slice(7);

test("an explicit version 1 request, an import with attribution dates, and a cut rafsi list are served honestly", async () => {
  // 65 claims for one word exceed the per-entry bound of 64.
  const spellings: string[] = [];
  for (let index = 0; spellings.length < 65; index++)
    spellings.push(
      `k${String.fromCharCode(97 + Math.floor(index / 5))}${"aeiou"[index % 5]}`,
    );
  const extraWord = { language: "jbo" as const, spelling: "klaku" };
  const claimant = new Uint8Array(32).fill(44);
  const claims: ReturnType<typeof createEvent>[] = [];
  let previous: string | null = null;
  for (const [index, rafsi] of spellings.entries()) {
    const pair = { word: wordId(extraWord), rafsi };
    const claim = createEvent(
      claimant,
      previous ? [previous] : [],
      (100 + index).toString().padStart(32, "9"),
      {
        kind: "rafsi.publish",
        word: pair.word,
        assignment: pairIdFor(pair),
        origin: "native",
      },
      { word: extraWord, rafsi, rationale: [], sources: [], legacy: null },
    );
    previous = claim.envelope.id;
    claims.push(claim);
  }
  const extraDefinition = createEvent(
    claimant,
    [previous!],
    "c".repeat(32),
    {
      kind: "definition.publish",
      word: wordId(extraWord),
      language: "en",
      parents: [],
      origin: "native",
    },
    { ...body("come"), word: extraWord },
  );
  const { service, definition } = await fixture({
    extra: [importedDefinition(), ...claims, extraDefinition],
  });
  const manifest = await read(await service.fetch(request("/manifest")));
  const explicit = await service.fetch(request("/packages/en?version=1"));
  assert.equal(explicit.status, 200);
  const v1Bytes = new Uint8Array(await explicit.arrayBuffer());
  assert.equal(contentHash(v1Bytes), manifest.packages[0].hash);
  assert.equal(JSON.parse(new TextDecoder().decode(v1Bytes)).version, 1);
  const v2 = await read(await service.fetch(request("/packages/en?version=2")));
  const part = await read(
    await service.fetch(
      request(`/package-parts/${encodeURIComponent(v2.parts[0].hash)}`),
    ),
  );
  const byEvent = Object.fromEntries(part.map((e: any) => [e.event, e]));
  const native = byEvent[definition.envelope.id];
  assert.deepEqual(native.rafsi, ["kla"]);
  assert.equal(native.rafsi_complete, true);
  const imported = part.find((e: any) => e.word.spelling === "ckusro");
  assert.deepEqual(imported.attribution, {
    source: "https://lensisku.invalid",
    author: "arj",
    account: { origin: "https://lensisku.invalid", account: 8 },
    dates: { created_at: "2003-03-12T10:00:00Z" },
  });
  const cut = byEvent[extraDefinition.envelope.id];
  assert.equal(cut.rafsi.length, 64);
  assert.deepEqual(cut.rafsi, [...spellings].sort().slice(0, 64));
  assert.equal(cut.rafsi_complete, false);
  // The exact claim set stays reachable through the word route.
  const wordResponse = await read(
    await service.fetch(request(`/words/${wordId(extraWord)}`)),
  );
  assert.equal(wordResponse.rafsi.length, 65);
});

test("reviewer details are bounded inside the core and flagged incomplete", async () => {
  const { service, definition } = await fixture({ limits: { reviewers: 1 } });
  const detailed = await read(
    await service.fetch(request(`/words/${wordId(word)}?reviewers=1`)),
  );
  const score = detailed.scores.find(
    (s: any) => s.target === definition.envelope.id,
  );
  assert.equal(score.direct_reviewers, 2);
  assert.equal(score.reviewers.length, 1);
  assert.equal(score.reviewers_complete, false);
  const bad = await service.fetch(
    request(`/words/${wordId(word)}?reviewers=2`),
  );
  assert.equal(bad.status, 400);
  assert.equal((await read(bad)).code, "reviewers");
});

test("identity profiles report conflicted, unavailable, and cut claim states", async () => {
  const identity = identityFromSeed(author);
  const { claim } = await fixture();
  // A second profile claim beside the first one, from the same previous head.
  const rival = createEvent(
    author,
    [claim.envelope.id],
    "d".repeat(32),
    { kind: "identity.profile" },
    { name: "la .bob.", bio: [], links: [] },
  );
  const cut = await fixture({
    extra: [rival],
    limits: { profileClaims: 1 },
  });
  const conflicted = await read(
    await cut.service.fetch(
      request(`/identities/${encodeURIComponent(identity)}`),
    ),
  );
  assert.equal(conflicted.profile.state, "conflicted");
  assert.equal(conflicted.profile.claims_count, 2);
  assert.equal(conflicted.profile.claims.length, 1);
  assert.equal(conflicted.profile.claims_complete, false);
  assert.equal(conflicted.profile.claims[0].body_status, "present");
  const full = await fixture({ extra: [rival] });
  const both = await read(
    await full.service.fetch(
      request(`/identities/${encodeURIComponent(identity)}`),
    ),
  );
  assert.equal(both.profile.state, "conflicted");
  assert.equal(both.profile.claims.length, 2);
  assert.equal(both.profile.claims_complete, true);
  // A retained body that storage cannot return makes the profile unavailable.
  const plain = await fixture();
  const hash = plain.profile.envelope.header.content!.hash;
  await rm(join(plain.directory, "objects", hash.replaceAll(":", "-")));
  const unavailable = await read(
    await plain.service.fetch(
      request(`/identities/${encodeURIComponent(identity)}`),
    ),
  );
  assert.equal(unavailable.profile.state, "unavailable");
  assert.equal(unavailable.profile.claims[0].body, null);
  assert.equal(unavailable.profile.claims[0].body_status, "unavailable");
  assert.equal(unavailable.profile.claims[0].body_hash, hash);
  // Malformed suffixes are refused.
  const deep = await plain.service.fetch(
    request(`/identities/${encodeURIComponent(identity)}/activity/anything`),
  );
  assert.equal(deep.status, 404);
});

test("records keep unretained and unreadable bodies apart, and new routes return 410 for an unknown snapshot", async () => {
  const { service, directory, profile, definition } = await fixture();
  const missing = createEvent(
    author,
    [profile.envelope.id],
    "e".repeat(32),
    { kind: "identity.profile" },
    { name: "Unretained", bio: [], links: [] },
  );
  assert.equal(
    (await service.fetch(request("/events", { ...missing, body: null })))
      .status,
    201,
  );
  const hash = profile.envelope.header.content!.hash;
  await rm(join(directory, "objects", hash.replaceAll(":", "-")));
  const records = await read(await service.fetch(request("/records")));
  const byId = Object.fromEntries(records.items.map((i: any) => [i.id, i]));
  assert.equal(byId[profile.envelope.id].body_status, "unavailable");
  assert.equal(byId[profile.envelope.id].body, null);
  assert.equal(byId[definition.envelope.id].body_status, "present");
  assert.equal(byId[missing.envelope.id].body_status, "missing");
  assert.equal(byId[missing.envelope.id].body, null);
  const identity = await read(
    await service.fetch(request(`/identities/${identityFromSeed(author)}`)),
  );
  assert.equal(identity.profile.state, "known");
  assert.equal(identity.profile.claims[0].event, missing.envelope.id);
  assert.equal(identity.profile.claims[0].body_status, "missing");
  assert.equal(identity.profile.claims[0].body_hash, null);
  assert.equal(identity.profile.claims[0].body, null);
  const expired = "sha256:" + "0".repeat(64);
  for (const path of [
    `/records?snapshot=${expired}`,
    `/identities/${encodeURIComponent(identityFromSeed(author))}?snapshot=${expired}`,
    `/identities/${encodeURIComponent(identityFromSeed(author))}/activity?snapshot=${expired}`,
    `/words/${wordId(word)}?snapshot=${expired}`,
    `/packages/en?version=2&snapshot=${expired}`,
  ]) {
    const response = await service.fetch(request(path));
    assert.equal(response.status, 410, path);
    assert.equal((await read(response)).code, "snapshot_expired");
  }
});

test("an identity read without an evaluation is 503, not a definite absence", async () => {
  const { service } = await fixture();
  // The evaluation helper reports an unavailable evaluation, as it does when
  // the core hits its resource limit.
  const original = (service as any).evaluation;
  (service as any).evaluation = async (...args: unknown[]) => {
    const evaluation = await original.apply(service, args);
    return {
      ...evaluation,
      available: false,
      // Resource exhaustion can retain inert receipts in the core result.
      receipts: Object.fromEntries(
        Object.keys(evaluation.receipts).map((id) => [
          id,
          { interpretation: "inert" },
        ]),
      ),
    };
  };
  const identity = encodeURIComponent(identityFromSeed(author));
  const response = await service.fetch(request(`/identities/${identity}`));
  assert.equal(response.status, 503);
  assert.equal((await read(response)).code, "resource_unavailable");
  const wordResponse = await service.fetch(request(`/words/${wordId(word)}`));
  assert.equal(wordResponse.status, 503);
  // Activity still answers, with an explicit unavailable interpretation per item.
  const activity = await service.fetch(
    request(`/identities/${identity}/activity?limit=2`),
  );
  assert.equal(activity.status, 200);
  const items = (await read(activity)).items;
  assert.ok(items.length > 0);
  assert.ok(items.every((i: any) => i.interpretation === "unavailable"));
});

test("identity claims separate invalid bytes from storage failures", async () => {
  const { service, objects, profile } = await fixture();
  const path = `/identities/${identityFromSeed(author)}`;
  assert.equal((await service.fetch(request(path))).status, 200);
  const get = objects.get.bind(objects);
  objects.get = async (hash) =>
    hash === profile.envelope.header.content!.hash ? utf8("{}") : get(hash);
  const value = await read(await service.fetch(request(path)));
  assert.equal(value.profile.state, "known");
  assert.equal(value.profile.claims[0].body_status, "invalid");
  assert.equal(value.profile.claims[0].body, null);
});

test("activity survives busy evaluation slots without hiding storage errors", async () => {
  const { service } = await fixture();
  const path = `/identities/${identityFromSeed(author)}`;
  (service as any).evaluationCache.clear();
  (service as any).inFlightEvaluations = new Set(["busy-a", "busy-b"]);
  assert.equal((await service.fetch(request(path))).status, 503);
  const response = await service.fetch(request(`${path}/activity`));
  assert.equal(response.status, 200);
  const activity = await read(response);
  assert.ok(activity.items.length > 0);
  assert.ok(
    activity.items.every((item: any) => item.interpretation === "unavailable"),
  );
  (service as any).evaluation = async () => {
    throw new Error("storage failed");
  };
  assert.equal((await service.fetch(request(`${path}/activity`))).status, 503);
});

test("records count brackets and commas and keep pages strictly below the byte bound", async () => {
  const { service } = await fixture();
  const full = await read(await service.fetch(request("/records")));
  const firstTwoBytes = utf8(JSON.stringify(full.items.slice(0, 2))).length;
  // A sum of item sizes misses three array bytes. Equality also requires a cut.
  for (const bound of [firstTwoBytes - 1, firstTwoBytes]) {
    service.options.limits = { recordBytes: bound };
    const page = await read(await service.fetch(request("/records")));
    assert.equal(page.items.length, 1);
    assert.equal(page.next, full.items[0].id);
    assert.ok(utf8(JSON.stringify(page.items)).length < bound);
    const rest = await read(
      await service.fetch(request(`/records?after=${page.next}`)),
    );
    assert.equal(rest.items[0].id, full.items[1].id);
  }
  service.options.limits = { recordBytes: 1 };
  assert.equal(
    (await read(await service.fetch(request("/records")))).items.length,
    1,
  );
});

test("search cursors bind the retired filter in both directions", async () => {
  const another = createEvent(
    author,
    [],
    "f".repeat(32),
    {
      kind: "definition.publish",
      word: wordId({ ...word, spelling: "klaku" }),
      language: "en",
      parents: [],
      origin: "native",
    },
    { ...body("go"), word: { ...word, spelling: "klaku" } },
  );
  const { service } = await fixture({ extra: [another] });
  for (const retired of [false, true]) {
    const page = await read(
      await service.fetch(
        request(
          `/search?q=go&language=en&limit=1${retired ? "&retired=1" : ""}`,
        ),
      ),
    );
    assert.ok(page.next);
    const response = await service.fetch(
      request(
        `/search?q=go&language=en&after=${page.next}${retired ? "" : "&retired=1"}`,
      ),
    );
    assert.equal(response.status, 400);
    assert.equal((await read(response)).code, "bad_cursor");
  }
});

test("version 2 rafsi inventories reuse verified claims while original bodies are unavailable", async () => {
  const { service, objects, claim, definition } = await fixture();
  const get = objects.get.bind(objects);
  const claimHash = claim.envelope.header.content!.hash;
  let outage: "missing" | "error" | null = "missing";
  let originalReads = 0;
  objects.get = async (hash) => {
    if (hash === claimHash) {
      originalReads++;
      if (outage === "missing") return null;
      if (outage === "error") throw new Error("Synthetic body storage outage.");
    }
    return get(hash);
  };
  const entry = async () => {
    const pkg = await read(
      await service.fetch(request("/packages/en?version=2")),
    );
    const entries = await read(
      await service.fetch(request(`/package-parts/${pkg.parts[0].hash}`)),
    );
    return entries.find((entry: any) => entry.event === definition.envelope.id);
  };
  const complete = await entry();
  assert.deepEqual(complete.rafsi, ["kla"]);
  assert.equal(complete.rafsi_complete, true);
  assert.equal(
    originalReads,
    0,
    "Package construction must use private compact records.",
  );
  assert.equal(
    (await service.fetch(request(`/bodies/${claimHash}`))).status,
    503,
  );
  outage = "error";
  (service as any).packageCache.clear();
  originalReads = 0;
  assert.deepEqual(await entry(), complete);
  assert.equal(originalReads, 0);
  assert.equal(
    (await service.fetch(request(`/bodies/${claimHash}`))).status,
    503,
  );
  outage = null;
  (service as any).packageCache.clear();
  assert.deepEqual(await entry(), complete);
  const restored = await service.fetch(request(`/bodies/${claimHash}`));
  assert.equal(restored.status, 200);
  assert.deepEqual(await restored.json(), claim.body);
});

test("POST search uses the same fields, results, validation, and cursors as GET", async () => {
  const secondWord = { ...word, spelling: "blanu" };
  const second = createEvent(
    author,
    [],
    "ab".repeat(16),
    {
      kind: "definition.publish",
      word: wordId(secondWord),
      language: "en",
      parents: [],
      origin: "native",
    },
    { ...body("go"), word: secondWord },
  );
  const { service } = await fixture({ extra: [second] });
  const query = { q: "go", language: "en", limit: 1, retired: "1" };
  const get = await read(
    await service.fetch(request("/search?q=go&language=en&limit=1&retired=1")),
  );
  const post = await service.fetch(request("/search", query));
  assert.equal(post.status, 200);
  assert.deepEqual(await read(post), get);
  assert.ok(get.next);
  const continuation = {
    ...query,
    snapshot: get.snapshot,
    view: get.view,
    after: get.next,
  };
  const nextPost = await service.fetch(request("/search", continuation));
  assert.equal(nextPost.status, 200);
  const nextGet = await service.fetch(
    request(
      `/search?${new URLSearchParams(Object.entries(continuation).map(([key, value]) => [key, String(value)]))}`,
    ),
  );
  const next = await read(nextPost);
  assert.deepEqual(next, await read(nextGet));
  assert.notEqual(next.hits[0].word_id, get.hits[0].word_id);
  assert.equal(next.next, null);
  assert.equal(
    (await service.fetch(request("/search?q=private", query))).status,
    400,
  );
  for (const invalid of [
    null,
    [],
    { ...query, q: 3 },
    { ...query, retired: true },
    { ...query, limit: 0 },
    { ...query, surprise: "text" },
  ]) {
    assert.equal(
      (await service.fetch(request("/search", invalid))).status,
      400,
    );
  }
  const malformed = new Request("http://localhost/api/v1/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal((await service.fetch(malformed)).status, 400);
  assert.equal(
    (
      await service.fetch(
        request("/search", { ...query, q: "a".repeat(16385) }),
      )
    ).status,
    400,
  );
});

test("search packages derive omitted defaults while body reads and retries retain original bytes", async () => {
  const sparse = {
    word,
    language: "en",
    text: [["Sparse package definition."]],
    classification: { kind: "gismu" },
    license: { expression: "CC0-1.0" },
  };
  const publication = createEvent(
    new Uint8Array(32).fill(43),
    [],
    "8".repeat(32),
    {
      kind: "definition.publish",
      word: wordId(word),
      language: "en",
      parents: [],
      origin: "native",
    },
    sparse,
  );
  const { service } = await fixture({ extra: [publication] });
  const expected = canonicalize(utf8(JSON.stringify(sparse)));
  const response = await service.fetch(
    request(
      `/bodies/${encodeURIComponent(publication.envelope.header.content.hash)}`,
    ),
  );
  assert.equal(await response.text(), expected);
  const records = await read(await service.fetch(request("/records")));
  assert.deepEqual(
    records.items.find((item: any) => item.id === publication.envelope.id).body,
    sparse,
  );
  const retry = await read(
    await service.fetch(request("/events", publication)),
  );
  assert.equal(retry.admission, "duplicate");
  assert.equal(retry.id, publication.envelope.id);
  const manifest = await read(await service.fetch(request("/packages/en")));
  const part = await read(
    await service.fetch(
      request(`/package-parts/${encodeURIComponent(manifest.parts[0].hash)}`),
    ),
  );
  const entry = part.find(
    (item: any) => item.event === publication.envelope.id,
  );
  assert.deepEqual(entry.glosses, []);
  assert.deepEqual(entry.classification, { kind: "gismu", selmaho: [] });
  assert.equal(entry.body, publication.envelope.header.content.hash);
});

test("equivalent defaults keep separate publications and judgments, and a sparse revision inherits no notes", async () => {
  const { service, definition, bless } = await fixture();
  const sparse = {
    word,
    language: "en",
    text: [["Independent defaults fixture."]],
    classification: { kind: "gismu" },
    license: { expression: "CC0-1.0" },
  };
  const seed = new Uint8Array(32).fill(44);
  const action = {
    kind: "definition.publish",
    word: wordId(word),
    language: "en",
    parents: [],
    origin: "native",
  };
  const omitted = createEvent(seed, [], "9".repeat(32), action, sparse);
  const full = interpretDefinition(sparse);
  const bytes = utf8(canonicalize(utf8(JSON.stringify(full))));
  const explicit = {
    envelope: signHeader(seed, {
      ...omitted.envelope.header,
      content: { hash: contentHash(bytes), bytes: bytes.length },
    }),
    body: full,
  };
  for (const publication of [omitted, explicit]) {
    const response = await service.fetch(request("/events", publication));
    assert.ok(response.ok, await response.text());
  }
  assert.notEqual(omitted.envelope.id, explicit.envelope.id);
  const judgment = createEvent(
    reviewer,
    [bless.envelope.id],
    "a".repeat(32),
    { kind: "judgment.set", target: omitted.envelope.id, value: "bless" },
    null,
  );
  const response = await service.fetch(request("/events", judgment));
  assert.ok(response.ok, await response.text());
  const result = await read(
    await service.fetch(request(`/words/${encodeURIComponent(wordId(word))}`)),
  );
  assert.ok(result.definitions.includes(omitted.envelope.id));
  assert.ok(result.definitions.includes(explicit.envelope.id));
  const byTarget = new Map(
    result.scores.map((score: any) => [score.target, score]),
  );
  assert.notEqual(
    (byTarget.get(omitted.envelope.id) as any).net[0].numerator,
    "0",
  );
  assert.equal(
    (byTarget.get(explicit.envelope.id) as any).net[0].numerator,
    "0",
  );
  const revision = createEvent(
    seed,
    [omitted.envelope.id, explicit.envelope.id],
    "b".repeat(32),
    { ...action, parents: [definition.envelope.id] },
    sparse,
  );
  const revisionResponse = await service.fetch(request("/events", revision));
  assert.ok(revisionResponse.ok, await revisionResponse.text());
  const raw = await read(
    await service.fetch(
      request(
        `/bodies/${encodeURIComponent(revision.envelope.header.content.hash)}`,
      ),
    ),
  );
  assert.ok(!Object.hasOwn(raw, "notes"));
  assert.deepEqual(interpretDefinition<any>(raw).notes, []);
  const parent = await read(
    await service.fetch(
      request(
        `/bodies/${encodeURIComponent(definition.envelope.header.content.hash)}`,
      ),
    ),
  );
  assert.deepEqual(parent.notes, [["A note."]]);
});
