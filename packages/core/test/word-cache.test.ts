import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { initializeCore } from "../src/index.ts";
before(async () =>
  initializeCore(
    await readFile(
      new URL("../generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);
import {
  WordResultCache,
  WORD_CACHE_LIMITS as L,
  type WordCacheIdentity,
} from "../src/word-cache.ts";
const h = (n: number) => "sha256:" + n.toString(16).padStart(64, "0");
const word = (n: number) => "jvw1:" + n.toString(16).padStart(64, "0");
const identity = (): WordCacheIdentity => ({
  logical_session: "logical-1",
  snapshot: h(1),
  inventory: h(2),
  input: h(3),
  view: "jve1:" + "4".repeat(64),
  overlay: null,
  mode: "site",
  build: h(5),
  contract: "word-results-v1",
  algorithm: "simple-routes-shun-f64-v1",
});
function cache() {
  const c = new WordResultCache();
  c.bind(identity());
  return c;
}
function reserve(
  c: WordResultCache,
  n: number,
  now = 0,
  bytes = L.output,
  reviewers: number | null = null,
) {
  const r = c.reserve(word(n), { reviewers, output_bytes: bytes }, now);
  assert.equal(r.status, "reserved");
  if (r.status !== "reserved") throw Error("reservation");
  return r.reservation;
}
function put(
  c: WordResultCache,
  n: number,
  bytes = new TextEncoder().encode("{}"),
  now = 0,
) {
  const result = c.complete(reserve(c, n, now), bytes, now);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") throw Error("completion");
  return result.ticket;
}

test("more than sixteen pinned results remain deliverable", () => {
  const c = cache();
  const tickets = Array.from({ length: 24 }, (_, n) =>
    put(c, n, new TextEncoder().encode(String(n))),
  );
  assert.equal(c.statistics().ready, 24);
  assert.equal(c.statistics().pinned, 24);
  for (let n = 0; n < 24; n++)
    assert.equal(
      new TextDecoder().decode(c.read(tickets[n].id, 100)!.bytes),
      String(n),
    );
  for (const t of tickets) c.cancelTicket(t.id, 100);
  assert.equal(c.statistics().pinned, 0);
  assert.equal(c.statistics().ready, 16);
});
test("expiry is fixed for repeated reads and later attachments", () => {
  const c = cache();
  const ticket = put(c, 1, new Uint8Array([1]), 100);
  assert.equal(ticket.expires_at, 60100);
  assert.equal(c.read(ticket.id, 60000)!.expires_at, 60100);
  const hit = c.reserve(word(1), {}, 60001);
  assert.equal(hit.status, "ready");
  if (hit.status !== "ready") throw Error("cache hit");
  assert.equal(hit.ticket.ready_at, 100);
  assert.equal(hit.ticket.expires_at, 60100);
  assert.equal(c.read(ticket.id, 60100), null);
  assert.equal(c.read(hit.ticket.id, 60100), null);
  assert.equal(c.statistics().bytes, 0);
});
test("pinned bytes refuse admissions without eviction or renewal", () => {
  const c = cache();
  const tickets = Array.from({ length: 8 }, (_, n) =>
    put(c, n, new Uint8Array(L.output)),
  );
  assert.equal(c.statistics().bytes, L.bytes);
  assert.equal(c.reserve(word(9), {}, 1).status, "ranking_busy");
  for (const t of tickets)
    assert.equal(c.read(t.id, 1)!.bytes.length, L.output);
  c.cancelTicket(tickets[0].id, 1);
  const r = c.reserve(word(9), {}, 1);
  assert.equal(r.status, "reserved");
  assert.equal(c.read(tickets[1].id, 1)!.bytes.length, L.output);
  assert.equal(c.statistics().bytes, L.bytes);
});
test("shared pins count bytes once and cancellation affects one consumer", () => {
  const c = cache();
  const first = put(c, 1, new Uint8Array([1, 2, 3]));
  const next = c.reserve(word(1), {}, 0);
  assert.equal(next.status, "ready");
  if (next.status !== "ready") throw Error("hit");
  assert.equal(c.statistics().bytes, 3);
  c.cancelTicket(first.id, 0);
  assert.deepEqual(c.read(next.ticket.id, 0)!.bytes, new Uint8Array([1, 2, 3]));
});
test("consumer reservations protect the first delivery slot", () => {
  const c = cache();
  const first = put(c, 1);
  const r = reserve(c, 2);
  for (let n = 0; n < 62; n++)
    assert.equal(c.reserve(word(1), {}, 0).status, "ready");
  assert.equal(c.statistics().consumers, 64);
  assert.equal(c.reserve(word(1), {}, 0).status, "ranking_busy");
  const completed = c.complete(r, new Uint8Array([2]), 0);
  if (completed.status !== "ready") throw Error("completion");
  const ready = completed.ticket;
  assert.equal(c.statistics().consumers, 64);
  assert.equal(c.read(ready.id, 0)!.bytes[0], 2);
  assert(c.read(first.id, 0));
});
test("output overrun returns a retryable failure without a permanent marker", () => {
  const c = cache();
  const r = reserve(c, 1, 0, 4);
  assert.deepEqual(c.complete(r, new Uint8Array(5), 0), {
    status: "failure",
    failure: {
      code: "resource_unavailable",
      limit: "output_bytes",
      retryable: true,
    },
  });
  assert.equal(c.statistics().bytes, 0);
  assert.equal(c.statistics().reservations, 0);
  assert.equal(c.statistics().markers, 0);
  assert.equal(c.reserve(word(1), { output_bytes: 4 }, 1).status, "reserved");
});
test("completion consumes ownership and delivery copies cannot corrupt cached bytes", () => {
  const c = cache();
  const bytes = new Uint8Array([1, 2]);
  const t = put(c, 1, bytes);
  assert.equal(bytes.byteLength, 0);
  c.read(t.id, 0)!.bytes[0] = 99;
  assert.equal(c.read(t.id, 0)!.bytes[0], 1);
  const r = reserve(c, 2);
  assert.throws(
    () => c.complete(r, new Uint8Array(10).subarray(1), 0),
    /owned byte buffer/,
  );
  c.cancelReservation(r);
  assert.equal(c.statistics().reservations, 0);
});
test("fixed deadline markers survive same-identity repair and retain the observation", () => {
  const c = cache();
  const r = reserve(c, 1);
  const failure = c.deadline(r, true, 5000);
  assert.equal(c.bind({ ...identity() }), false);
  const after = c.reserve(word(1), {}, 600000);
  assert.equal(after.status, "failure");
  if (after.status === "failure") assert.deepEqual(after.failure, failure);
  assert.equal(failure.background_evaluation_running_at_expiry, true);
  assert.equal(c.statistics().reservations, 0);
  assert.equal(c.statistics().markers, 1);
});
test("marker saturation refuses new work but leaves cached failures and successes readable", () => {
  const c = cache();
  const t = put(c, 999);
  for (let n = 0; n < L.markers; n++) c.deadline(reserve(c, n), false, 0);
  assert.equal(c.statistics().markers, L.markers);
  assert(c.statistics().marker_bytes <= L.markerBytes);
  assert.equal(c.reserve(word(500), {}, 0).status, "markers_full");
  assert.equal(c.reserve(word(0), {}, 0).status, "failure");
  assert(c.read(t.id, 0));
  assert.equal(c.reserve(word(999), {}, 0).status, "ready");
});
test("in-flight work reserves failure slots before dispatch", () => {
  const c = cache();
  for (let n = 0; n < L.consumers; n++) reserve(c, n, 0, 1);
  assert.equal(c.statistics().marker_bytes, L.consumers * L.markerReservation);
  assert.equal(
    c.reserve(word(1000), { output_bytes: 1 }, 0).status,
    "ranking_busy",
  );
});
test("canceling reservations creates no permanent marker", () => {
  const c = cache();
  const r = reserve(c, 1);
  c.cancelReservation(r);
  assert.equal(c.statistics().markers, 0);
  assert.equal(c.statistics().bytes, 0);
  assert.equal(c.reserve(word(1), {}, 0).status, "reserved");
});
test("binding changes invalidate reuse and markers but preserve promised delivery", () => {
  const c = cache();
  const t = put(c, 1, new Uint8Array([7]));
  const pending = reserve(c, 2);
  c.deadline(reserve(c, 3), false, 0);
  c.bind({ ...identity(), snapshot: h(9) });
  assert.equal(c.statistics().markers, 0);
  assert.equal(c.statistics().reservations, 0);
  assert.throws(() => c.complete(pending, new Uint8Array([1]), 0), /stale/);
  assert.deepEqual(c.read(t.id, 0)!.bytes, new Uint8Array([7]));
  assert.equal(c.reserve(word(1), {}, 0).status, "reserved");
  c.bind(identity());
  assert.equal(c.reserve(word(1), {}, 0).status, "reserved");
  c.cancelTicket(t.id, 0);
  assert.equal(c.statistics().ready, 0);
});
test("every identity ingredient invalidates and reviewer requirements never share entries", () => {
  for (const field of [
    "snapshot",
    "inventory",
    "input",
    "view",
    "overlay",
    "mode",
    "build",
    "contract",
    "algorithm",
    "logical_session",
  ] as const) {
    const c = cache();
    put(c, 1);
    const changed = { ...identity() };
    if (field === "overlay" || field === "mode") {
      changed.mode = "personal";
      changed.overlay = h(10);
    } else if (field === "view") changed.view = "jve1:" + "a".repeat(64);
    else if (["contract", "algorithm", "logical_session"].includes(field))
      changed[field] = "different";
    else changed[field] = h(10);
    assert.equal(c.bind(changed), true, field);
    assert.equal(c.reserve(word(1), {}, 0).status, "reserved", field);
  }
  const c = cache();
  put(c, 1);
  assert.equal(c.reserve(word(1), { reviewers: 0 }, 0).status, "reserved");
  assert.equal(c.reserve(word(1), { reviewers: 4 }, 0).status, "reserved");
});
test("exact diagnostic equality cannot collapse distinct snapshots", () => {
  const c = cache();
  const a = {
    ...identity(),
    algorithm: "simple-routes-bounds-v1",
    input: h(0),
  };
  c.bind(a);
  put(c, 1);
  c.bind({ ...a, snapshot: h(123), inventory: h(124) });
  assert.equal(c.reserve(word(1), {}, 0).status, "reserved");
});
test("invalid identities and clocks leave valid delivery intact", () => {
  const c = cache();
  const t = put(c, 1, new Uint8Array([1]), 10);
  assert.throws(() => c.bind({ ...identity(), overlay: h(1) }), /identity/);
  assert.throws(() => c.read(t.id, 9), /clock/);
  assert.throws(() => c.reserve("bad", {}, 10), /key/);
  assert.equal(c.read(t.id, 10)!.bytes[0], 1);
});
test("a new process has no old tickets and disposal releases all cache storage", () => {
  const c = cache();
  const t = put(c, 1);
  c.deadline(reserve(c, 2), false, 0);
  reserve(c, 3);
  assert.equal(new WordResultCache().read(t.id, 0), null);
  c.dispose();
  c.dispose();
  assert.throws(() => c.read(t.id, 0), /disposed/);
});

test("alternating word policies preserves aggregate and reviewer deadline markers", () => {
  const c = cache();
  const aggregate = {};
  const reviewer = { reviewers: 4 };
  const a = c.reserve(word(1), aggregate, 0);
  if (a.status !== "reserved") throw Error("aggregate");
  c.deadline(a.reservation, true, 1);
  const r = c.reserve(word(1), reviewer, 1);
  if (r.status !== "reserved") throw Error("reviewer");
  c.deadline(r.reservation, false, 2);
  for (let i = 0; i < 10; i++) {
    assert.equal(c.reserve(word(1), aggregate, 2).status, "failure");
    assert.equal(c.reserve(word(1), reviewer, 2).status, "failure");
  }
  assert.equal(c.statistics().markers, 2);
  assert.equal(c.statistics().bytes, 0);
});
test("duplicate admitted policy returns pending and normalized defaults share a key", () => {
  const c = cache();
  reserve(c, 1);
  assert.equal(
    c.reserve(word(1), { reviewers: null, output_bytes: L.output }, 0).status,
    "pending",
  );
  assert.equal(c.statistics().reservations, 1);
});
test("deadline observations are mandatory and exclusive to deadline failures", () => {
  const c = cache();
  const r = reserve(c, 1);
  const before = c.statistics();
  assert.throws(
    () =>
      c.fail(
        r,
        { code: "resource_unavailable", limit: "deadline", retryable: false },
        0,
      ),
    /failure/,
  );
  assert.throws(
    () =>
      c.fail(
        r,
        {
          code: "resource_unavailable",
          limit: "actor_terms",
          retryable: false,
          background_evaluation_running_at_expiry: true,
        },
        0,
      ),
    /failure/,
  );
  assert.throws(
    () =>
      c.fail(
        r,
        {
          code: "numeric_unavailable",
          limit: "deadline",
          retryable: false,
          background_evaluation_running_at_expiry: true,
        },
        0,
      ),
    /failure/,
  );
  assert.deepEqual(c.statistics(), before);
  c.deadline(r, false, 0);
});
test("pinned pressure reports the earliest fixed expiry", () => {
  const c = cache();
  for (let n = 0; n < 8; n++) put(c, n, new Uint8Array(L.output), n * 1000);
  assert.deepEqual(c.reserve(word(9), {}, 7500), {
    status: "ranking_busy",
    retry_after: 53,
  });
});
test("a consumer refusal preserves reusable bytes", () => {
  const c = cache();
  const free = put(c, 0, new Uint8Array(L.output));
  c.cancelTicket(free.id, 0);
  const pinned = Array.from({ length: 7 }, (_, n) =>
    put(c, n + 1, new Uint8Array(L.output)),
  )[0];
  for (let n = 0; n < 57; n++)
    assert.equal(c.reserve(word(1), {}, 0).status, "ready");
  assert.equal(c.statistics().consumers, 64);
  const before = c.statistics();
  assert.equal(c.reserve(word(2), {}, 0).status, "ranking_busy");
  assert.deepEqual(c.statistics(), before);
  c.cancelTicket(pinned.id, 0);
  assert.equal(c.reserve(word(0), {}, 0).status, "ready");
});
test("insufficient total space refuses without deleting reusable entries", () => {
  const c = cache();
  const free = put(c, 0, new Uint8Array(1));
  c.cancelTicket(free.id, 0);
  for (let n = 1; n <= 7; n++) put(c, n, new Uint8Array(L.output));
  const nearlyFull = c.reserve(word(8), { output_bytes: L.output - 1 }, 0);
  if (nearlyFull.status !== "reserved") throw Error("reserve");
  const done = c.complete(
    nearlyFull.reservation,
    new Uint8Array(L.output - 1),
    0,
  );
  assert.equal(done.status, "ready");
  const before = c.statistics();
  assert.equal(c.reserve(word(9), {}, 0).status, "ranking_busy");
  assert.deepEqual(c.statistics(), before);
  assert.equal(c.reserve(word(0), {}, 0).status, "ready");
});

test("reserved marker pressure is transient until its completion", () => {
  const c = cache();
  for (let n = 0; n < 127; n++) c.deadline(reserve(c, n), false, 0);
  const pending = reserve(c, 127);
  assert.deepEqual(c.reserve(word(128), {}, 0), {
    status: "ranking_busy",
    retry_after: 1,
  });
  assert.equal(c.complete(pending, new Uint8Array([1]), 0).status, "ready");
  assert.equal(c.reserve(word(128), {}, 0).status, "reserved");
});
test("the policy output limit belongs to the word key and its reservation", () => {
  const c = cache();
  const small = c.reserve(word(1), { output_bytes: 4 }, 0);
  if (small.status !== "reserved") throw Error("reserve");
  assert.equal(c.statistics().bytes, 4);
  assert.equal(
    c.complete(small.reservation, new Uint8Array(4), 0).status,
    "ready",
  );
  assert.equal(c.reserve(word(1), { output_bytes: 4 }, 0).status, "ready");
  assert.equal(c.reserve(word(1), { output_bytes: 8 }, 0).status, "reserved");
  assert.equal(c.statistics().bytes, 12);
});
