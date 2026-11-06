import assert from "node:assert/strict";
import { test } from "node:test";
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
  policy: h(6),
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
  const r = c.reserve(word(n), reviewers, now, bytes);
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
  return c.complete(reserve(c, n, now), bytes, now);
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
  const hit = c.reserve(word(1), null, 60001);
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
  assert.equal(c.reserve(word(9), null, 1).status, "ranking_busy");
  for (const t of tickets)
    assert.equal(c.read(t.id, 1)!.bytes.length, L.output);
  c.cancelTicket(tickets[0].id, 1);
  const r = c.reserve(word(9), null, 1);
  assert.equal(r.status, "reserved");
  assert.equal(c.read(tickets[1].id, 1)!.bytes.length, L.output);
  assert.equal(c.statistics().bytes, L.bytes);
});
test("shared pins count bytes once and cancellation affects one consumer", () => {
  const c = cache();
  const first = put(c, 1, new Uint8Array([1, 2, 3]));
  const next = c.reserve(word(1), null, 0);
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
    assert.equal(c.reserve(word(1), null, 0).status, "ready");
  assert.equal(c.statistics().consumers, 64);
  assert.equal(c.reserve(word(1), null, 0).status, "ranking_busy");
  const ready = c.complete(r, new Uint8Array([2]), 0);
  assert.equal(c.statistics().consumers, 64);
  assert.equal(c.read(ready.id, 0)!.bytes[0], 2);
  assert(c.read(first.id, 0));
});
test("output overrun makes a fixed failure and releases both reservations", () => {
  const c = cache();
  const r = reserve(c, 1, 0, 4);
  assert.throws(() => c.complete(r, new Uint8Array(5), 0), /reservation/);
  assert.equal(c.statistics().bytes, 0);
  assert.equal(c.statistics().reservations, 0);
  const cached = c.reserve(word(1), null, 1);
  assert.equal(cached.status, "failure");
  if (cached.status === "failure")
    assert.equal(cached.failure.limit, "output_bytes");
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
  const after = c.reserve(word(1), null, 600000);
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
  assert.equal(c.reserve(word(500), null, 0).status, "ranking_busy");
  assert.equal(c.reserve(word(0), null, 0).status, "failure");
  assert(c.read(t.id, 0));
  assert.equal(c.reserve(word(999), null, 0).status, "ready");
});
test("in-flight work reserves failure slots before dispatch", () => {
  const c = cache();
  for (let n = 0; n < L.consumers; n++) reserve(c, n, 0, 1);
  assert.equal(c.statistics().marker_bytes, L.consumers * L.markerReservation);
  assert.equal(c.reserve(word(1000), null, 0, 1).status, "ranking_busy");
});
test("canceling reservations creates no permanent marker", () => {
  const c = cache();
  const r = reserve(c, 1);
  c.cancelReservation(r);
  assert.equal(c.statistics().markers, 0);
  assert.equal(c.statistics().bytes, 0);
  assert.equal(c.reserve(word(1), null, 0).status, "reserved");
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
  assert.equal(c.reserve(word(1), null, 0).status, "reserved");
  c.bind(identity());
  assert.equal(c.reserve(word(1), null, 0).status, "reserved");
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
    "policy",
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
    assert.equal(c.reserve(word(1), null, 0).status, "reserved", field);
  }
  const c = cache();
  put(c, 1);
  assert.equal(c.reserve(word(1), 0, 0).status, "reserved");
  assert.equal(c.reserve(word(1), 4, 0).status, "reserved");
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
  assert.equal(c.reserve(word(1), null, 0).status, "reserved");
});
test("invalid identities and clocks leave valid delivery intact", () => {
  const c = cache();
  const t = put(c, 1, new Uint8Array([1]), 10);
  assert.throws(() => c.bind({ ...identity(), overlay: h(1) }), /identity/);
  assert.throws(() => c.read(t.id, 9), /clock/);
  assert.throws(() => c.reserve("bad", null, 10), /key/);
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
