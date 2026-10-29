import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { getEventListeners } from "node:events";
import { initializeCore, wordId } from "../../core/src/index.ts";
import { NodePatternScanner } from "../../../apps/server/src/pattern-search.ts";
import { DictionaryService } from "../src/service.ts";
import { lexicalSearch } from "../src/lexical-search.ts";
import { PatternError } from "../../search/src/pattern.ts";
let wasm: Uint8Array;
before(async () => {
  wasm = await readFile(
    new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
  );
  await initializeCore(wasm);
});
function fixture(spellings: string[], scanner?: NodePatternScanner) {
  const entries = spellings.map((spelling, i) => ({
    event: "event" + i,
    word: { language: "jbo" as const, spelling },
    language: "en",
    glosses: [{ text: "c*-algebra" }, { text: "name@example.org" }],
    plain_text: "Synthetic meaning.",
    classification: { kind: "other" },
    body: "",
  }));
  const evaluation: any = {
    available: true,
    publications: Object.fromEntries(
      entries.map((e) => [
        e.event,
        { word: wordId(e.word), eligible: "eligible", status: "active" },
      ]),
    ),
    receipts: Object.fromEntries(
      entries.map((e) => [e.event, { interpretation: "effective" }]),
    ),
  };
  const service = new DictionaryService({} as any, {} as any, {
    serverId: "r2-pattern-probe",
    policyUrl: "https://example.invalid",
    patternScanner: scanner?.scan,
  });
  const internal = service as any;
  internal.interpretedSnapshot = async () => ({
    snapshot: "sha256:" + "a".repeat(64),
    events: {},
  });
  internal.requireView = async () => {};
  internal.packages = async () => ({
    entries,
    searchRafsi: {},
    effectiveDefinitions: entries,
  });
  internal.evaluation = async () => evaluation;
  return { service, internal, entries, evaluation };
}
test("Node service scans patterns off its request thread and refuses expanded repetition", async () => {
  const scanner = new NodePatternScanner(wasm);
  const { service } = fixture(
    Array(1000).fill("ab".repeat(127) + "a"),
    scanner,
  );
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  try {
    const response = await service.fetch(
      new Request(
        "http://local.invalid/api/v1/search?" +
          new URLSearchParams({ q: "/(?:[ab]?){1000}c/", language: "en" }),
      ),
    );
    assert.equal(response.status, 422);
    const error: any = await response.json();
    assert.equal(error.code, "pattern_timeout");
    assert.equal(error.hits, undefined);
    assert.ok(ticks > 0);
  } finally {
    clearInterval(timer);
    await scanner.close();
  }
  assert.equal(scanner.liveWorkers, 0);
});
test("Node pattern workers enforce a real deadline, bounded queues and close cleanup", async () => {
  const scanner = new NodePatternScanner(wasm, {
    workerFactory: () =>
      new Worker(
        "const {parentPort}=require('node:worker_threads');parentPort.on('message',()=>{while(true){}});parentPort.postMessage({ready:true});",
        { eval: true },
      ),
  });
  const jobs = Array.from({ length: 10 }, () =>
    scanner.scan([], "*").catch((error) => error),
  );
  assert.equal(scanner.liveWorkers, 2);
  assert.equal(scanner.queuedRequests, 8);
  await assert.rejects(scanner.scan([], "*"), PatternError);
  const first = await jobs[0];
  assert.equal(first.code, "pattern_timeout");
  await scanner.close();
  const results = await Promise.all(jobs);
  assert.ok(results.every((error) => error.code === "pattern_timeout"));
  assert.equal(scanner.liveWorkers, 0);
  assert.equal(scanner.queuedRequests, 0);
  await assert.rejects(scanner.scan([], "*"), PatternError);
});
test("Node worker construction failures and active or queued aborts settle without leaked workers", async () => {
  const broken = new NodePatternScanner(wasm, {
    workerFactory: () => {
      throw new Error("Synthetic constructor failure");
    },
  });
  await assert.rejects(broken.scan([], "*"), /constructor failure/);
  assert.equal(broken.liveWorkers, 0);
  await broken.close();
  const scanner = new NodePatternScanner(wasm, {
    workerFactory: () => new Worker("while(true){}", { eval: true }),
  });
  const active = new AbortController(),
    queued = new AbortController();
  const jobs = [
    scanner.scan([], "*", active.signal).catch((e) => e),
    scanner.scan([], "*").catch((e) => e),
    scanner.scan([], "*", queued.signal).catch((e) => e),
  ];
  queued.abort();
  assert.equal(scanner.queuedRequests, 0);
  active.abort();
  assert.equal((await jobs[0]).name, "AbortError");
  assert.equal((await jobs[2]).name, "AbortError");
  await scanner.close();
  await jobs[1];
  assert.equal(scanner.liveWorkers, 0);
  assert.equal(getEventListeners(active.signal, "abort").length, 0);
  assert.equal(getEventListeners(queued.signal, "abort").length, 0);
  active.abort();
});
test("server pattern classes use normalized dictionary order and word IDs break ties", () => {
  const { entries, evaluation } = fixture([
    "zabna",
    "bangu",
    "bahi",
    "ba'i",
    "klama",
  ]);
  const hits = lexicalSearch(entries, "*", "en", evaluation);
  assert.deepEqual(
    hits.map((hit) => (hit.word as any).spelling),
    ["ba'i", "bahi"]
      .sort((a, b) =>
        wordId({ language: "jbo", spelling: a }) <
        wordId({ language: "jbo", spelling: b })
          ? -1
          : 1,
      )
      .concat(["bangu", "klama", "zabna"]),
  );
});
test("type assistance retrieves inner pattern punctuation literally", async () => {
  const { internal } = fixture(["r2fixture"]);
  for (const meaning of [
    "x1 is a C*-algebra",
    "x1 writes to name@example.org",
  ]) {
    const result = await internal.typeDictionary(
      { meaning, language: "en", current: {} },
      [],
      new AbortController().signal,
    );
    assert.equal(result.method, "lexical");
    assert.equal(result.related.length, 1);
  }
});

test("GET and POST literal search preserve meaning punctuation and reject invalid flags", async () => {
  const { service } = fixture(["r2literalone", "r2literaltwo"]);
  const request = (method: string, fields: Record<string, unknown>) =>
    service.fetch(
      new Request(
        "http://local.invalid/api/v1/search" +
          (method === "GET"
            ? "?" + new URLSearchParams(fields as Record<string, string>)
            : ""),
        method === "GET"
          ? undefined
          : {
              method,
              headers: { "content-type": "application/json" },
              body: JSON.stringify(fields),
            },
      ),
    );
  for (const method of ["GET", "POST"]) {
    for (const q of ["c*-algebra", "name@example.org"]) {
      const response = await request(method, {
        q,
        language: "en",
        literal: "1",
      });
      assert.equal(response.status, 200);
      const result: any = await response.json();
      assert.equal(result.hits.length, 2);
      assert.ok(result.hits.every((hit: any) => hit.match === "gloss"));
    }
    for (const literal of ["", "0", "true", "2"]) {
      const response = await request(method, {
        q: "r2",
        language: "en",
        literal,
      });
      assert.equal(response.status, 400);
      assert.equal(((await response.json()) as any).code, "literal");
    }
    const pattern = await request(method, { q: "r2*", language: "en" });
    assert.equal(pattern.status, 200);
    assert.equal(((await pattern.json()) as any).hits.length, 2);
    for (const literal of [false, true]) {
      const fields = {
        q: "r2",
        language: "en",
        limit: "1",
        ...(literal ? { literal: "1" } : {}),
      };
      const first = await request(method, fields);
      assert.equal(first.status, 200);
      const { next } = (await first.json()) as any;
      assert.equal(typeof next, "string");
      const same = await request(method === "GET" ? "POST" : "GET", {
        ...fields,
        after: next,
      });
      assert.equal(same.status, 200);
      const mixed = await request(method, {
        q: "r2",
        language: "en",
        limit: "1",
        after: next,
        ...(!literal ? { literal: "1" } : {}),
      });
      assert.equal(mixed.status, 400);
      assert.equal(((await mixed.json()) as any).code, "bad_cursor");
    }
  }
  for (const literal of [true, 1, null]) {
    const response = await request("POST", {
      q: "r2",
      language: "en",
      literal,
    });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as any).code, "query");
  }
});
