import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir, writeFile, utimes, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "./server.ts";
import { initializeCore, createEvent, utf8 } from "../../packages/core/src/index.ts";
const run = promisify(execFile);
const cli = new URL("./cli.ts", import.meta.url).pathname;
const tsx = new URL("../../node_modules/.bin/tsx", import.meta.url).pathname;
before(async () => initializeCore(await readFile(new URL("../../packages/core/generated/jvc_runtime_bg.wasm", import.meta.url))));
async function cmd(args: string[]): Promise<string> {
  const { stdout, stderr } = await run(tsx, [cli, ...args], { timeout: 180000 });
  return stdout + stderr;
}
async function cmdFail(args: string[]): Promise<string> {
  try { await run(tsx, [cli, ...args], { timeout: 180000 }); } catch (e: any) { return (e.stdout ?? "") + (e.stderr ?? ""); }
  throw new Error("expected failure");
}
const rootOf = async () => mkdtemp(join(process.env.JVC_TEST_ROOT ?? tmpdir(), "synthetic-smoke-"));

test("two identities act, capture, restore and reuse-check", async () => {
  const root = await rootOf();
  const servers: Awaited<ReturnType<typeof startServer>>[] = [];
  try {
    const s1 = await startServer(join(root, "base1"), 8795); servers.push(s1);
    const url1 = "http://127.0.0.1:8795";
    const a = join(root, "a"), b = join(root, "b");
    const idA = (await cmd(["--server", url1, "--state", a, "init"])).match(/ed25519:[a-f0-9]{64}/)![0];
    const idB = (await cmd(["--server", url1, "--state", b, "init"])).match(/ed25519:[a-f0-9]{64}/)![0];
    const frame = JSON.stringify({ role: "predicate", arity: { mode: "fixed", count: 3 }, places: [{ index: 1 }, { index: 2 }, { index: 3 }] });
    assert.match(await cmd(["--server", url1, "--state", a, "define", "--word", "smokeone", "--text", "x1 is a smoke test for x2 by x3", "--gloss", "smoke", "--kind", "other", "--frame", frame]), /accepted/);
    const inv = await (await fetch(url1 + "/api/v1/records?limit=50")).json() as any;
    const defId = inv.items.find((i: any) => i.envelope.header.action.kind === "definition.publish").id;
    assert.match(await cmd(["--server", url1, "--state", a, "rafsi", "--word", "smokeone", "--rafsi", "smo"]), /accepted/);
    const inv2 = await (await fetch(url1 + "/api/v1/records?limit=50")).json() as any;
    const pairId = inv2.items.find((i: any) => i.envelope.header.action.kind === "rafsi.publish").envelope.header.action.assignment;
    assert.match(await cmd(["--server", url1, "--state", b, "define", "--word", "smoketwo", "--text", "second smoke word", "--gloss", "smoke2"]), /accepted/);
    assert.match(await cmd(["--server", url1, "--state", b, "judge", "--target", defId, "--value", "bless", "--explain", "good"]), /accepted/);
    const virtualRefusal = await cmdFail(["--server", url1, "--state", b, "judge", "--base", defId, "--conversion", "te", "--value", "bless"]);
    assert.match(virtualRefusal, /refused: Draft does not satisfy version 1 action and body rules\./);
    assert.match(await cmd(["--server", url1, "--state", b, "judge", "--target", pairId, "--value", "curse"]), /accepted/);
    assert.match(await cmd(["--server", url1, "--state", b, "judge", "--target", defId, "--value", "clear"]), /accepted/);
    for (const [value, kind] of [["heed", "*"], ["shun", "definition"], ["clear", "definition"]] as const)
      assert.match(await cmd(["--server", url1, "--state", b, "trust", "--subject", idA, "--value", value, "--scope-kind", kind, "--scope-word", "*", "--scope-language", kind === "*" ? "*" : "en"]), /accepted/);
    assert.match(await cmd(["--server", url1, "--state", b, "profile", "--name", "Smoke B", "--bio", "test user"]), /accepted/);
    assert.match(await cmd(["--server", url1, "--state", b, "report", "--subject", idA, "--category", "spam-flooding", "--value", "report", "--text", "synthetic check"]), /accepted/);
    assert.match(await cmd(["--server", url1, "--state", b, "report", "--subject", idA, "--category", "spam-flooding", "--value", "clear"]), /accepted/);
    assert.match(await cmd(["--server", url1, "--state", b, "view", "--name", "Smoke view", "--root", `${idB}=1/1`]), /accepted/);
    const inv3 = await (await fetch(url1 + "/api/v1/records?limit=100")).json() as any;
    const viewId = inv3.items.find((i: any) => i.envelope.header.action.kind === "view.publish").id;
    assert.match(await cmd(["--server", url1, "--state", a, "define", "--word", "smokeone", "--text", "revised smoke", "--gloss", "smoke", "--parents", defId]), /accepted/);
    assert.match(await cmd(["--server", url1, "--state", a, "status", "--target", defId, "--value", "deprecated"]), /accepted/);
    assert.match(await cmd(["--server", url1, "--state", a, "status", "--target", defId, "--value", "active"]), /accepted/);
    const mergeOut = await cmd(["--server", url1, "--state", a, "merge"]);
    const mergeId = mergeOut.match(/jve1:[a-f0-9]{64}/)![0];
    await s1.close(); servers.splice(servers.indexOf(s1), 1);
    const s1b = await startServer(join(root, "base1"), 8795, viewId); servers.push(s1b);
    // Search prints the full preview event ID and the definition text.
    const searchOut = await cmd(["--server", url1, "--state", a, "--view", viewId, "search", "smokeone"]);
    assert.ok(searchOut.includes(defId), searchOut);
    assert.match(searchOut, /smoke test|revised smoke/);
    assert.ok(!searchOut.includes("…"), searchOut);
    // Show and history print full IDs that other commands can consume.
    const showOut = await cmd(["--server", url1, "--state", a, "--view", viewId, "show", "smokeone"]);
    assert.ok(showOut.includes(defId), showOut);
    assert.ok(showOut.includes(idA), showOut);
    const histOut = await cmd(["--server", url1, "--state", a, "history"]);
    assert.ok(histOut.includes(defId), histOut);
    assert.ok(!histOut.includes("…"), histOut);
    // Recent lists the latest journal entries, not the first page.
    const recentOut = await cmd(["--server", url1, "--state", a, "recent", "--limit", "3"]);
    assert.ok(recentOut.includes(mergeId), recentOut);
    assert.ok(!recentOut.includes("…"), recentOut);
    const bad = await cmdFail(["--server", url1, "--state", b, "judge", "--target", defId, "--value", "bogus"]);
    assert.match(bad, /refused:/);
    const cap = join(root, "capture");
    assert.match(await cmd(["--server", url1, "capture", "--state", a, "--state", b, "--out", cap]), /captured \d+ events/);
    const manifest = JSON.parse(await readFile(join(cap, "manifest.json"), "utf8"));
    assert.ok(manifest.event_count >= 15, String(manifest.event_count));
    assert.equal(manifest.public_keys.length, 2);
    assert.ok(manifest.base_event_count >= 0 && manifest.expected_final_event_count === manifest.base_event_count + manifest.event_count);
    const s2 = await startServer(join(root, "base2"), 8796); servers.push(s2);
    assert.match(await cmd(["--server", "http://127.0.0.1:8796", "restore", "--capture", cap]), /restored/);
    const s3 = await startServer(join(root, "base3"), 8797); servers.push(s3);
    assert.match(await cmd(["--server", "http://127.0.0.1:8797", "reuse-check", "--capture", cap]), /reusable/);
  } finally { for (const s of servers) await s.close(); await rm(root, { recursive: true, force: true }); }
});

test("non-loopback URLs and redirects that leave the host are refused", async () => {
  assert.match(await cmdFail(["--server", "https://example.com", "--state", "/tmp/x", "whoami"]), /refused: server must be a loopback URL/);
  assert.match(await cmdFail(["--server", "http://192.0.2.10:8795", "--state", "/tmp/x", "whoami"]), /refused: server must be a loopback URL/);
  const redirect = createServer((_req, res) => { res.writeHead(302, { location: "https://example.com/" }); res.end(); });
  await new Promise<void>((r) => redirect.listen(8798, "127.0.0.1", r));
  try {
    assert.match(await cmdFail(["--server", "http://127.0.0.1:8798", "--state", "/tmp/x", "search", "word"]), /refused: redirect leaves the loopback server/);
  } finally { await new Promise<void>((r) => redirect.close(() => r())); }
});

test("a server without the disposable marker is refused, and init fails with no base", async () => {
  const root = await rootOf();
  const s = await startServer(join(root, "data"), 8798, undefined, { marker: false });
  try {
    const state = join(root, "state");
    assert.match(await cmdFail(["--server", "http://127.0.0.1:8798", "--state", state, "init"]), /refused: server does not prove it holds a disposable copy/);
    assert.equal(existsSync(join(state, "identity.json")), false);
  } finally { await s.close(); }
  // No server at all on a loopback port: init fails and writes no identity.
  const state2 = join(root, "state2");
  assert.match(await cmdFail(["--server", "http://127.0.0.1:8799", "--state", state2, "init"]), /refused:/);
  assert.equal(existsSync(join(state2, "identity.json")), false);
  // A data directory with data and no marker is refused at startup.
  await assert.rejects(() => startServer(join(root, "data"), 8798), /no disposable marker/);
  await rm(root, { recursive: true, force: true });
});

test("foreign base, tampered inventory and superset are refused; a partial restore resumes", async () => {
  const root = await rootOf();
  const servers: Awaited<ReturnType<typeof startServer>>[] = [];
  try {
    const s1 = await startServer(join(root, "src"), 8795); servers.push(s1);
    const a = join(root, "a");
    await cmd(["--server", "http://127.0.0.1:8795", "--state", a, "init"]);
    await cmd(["--server", "http://127.0.0.1:8795", "--state", a, "define", "--word", "foreignone", "--text", "first entry"]);
    await cmd(["--server", "http://127.0.0.1:8795", "--state", a, "profile", "--name", "A"]);
    const cap = join(root, "capture");
    await cmd(["--server", "http://127.0.0.1:8795", "capture", "--state", a, "--out", cap]);
    // Foreign base: another server with one unrelated event and no synthetic events.
    const foreign = await startServer(join(root, "foreign"), 8796); servers.push(foreign);
    const fstate = join(root, "foreign-state");
    await cmd(["--server", "http://127.0.0.1:8796", "--state", fstate, "init"]);
    await cmd(["--server", "http://127.0.0.1:8796", "--state", fstate, "define", "--word", "foreigntwo", "--text", "unrelated entry"]);
    assert.match(await cmdFail(["--server", "http://127.0.0.1:8796", "restore", "--capture", cap]), /refused: base inventory does not match the capture pin; refusing to write/);
    assert.match(await cmdFail(["--server", "http://127.0.0.1:8796", "reuse-check", "--capture", cap]), /not reusable: base inventory does not match the capture pin; refusing to write/);
    // Tampered base inventory on a fresh server.
    const tampered = join(root, "tampered"); await cp(cap, tampered, { recursive: true });
    const tm = JSON.parse(await readFile(join(tampered, "manifest.json"), "utf8")); tm.base_inventory = "sha256:" + "0".repeat(64);
    await writeFile(join(tampered, "manifest.json"), JSON.stringify(tm, null, 2));
    const s2 = await startServer(join(root, "fresh2"), 8797); servers.push(s2);
    assert.match(await cmdFail(["--server", "http://127.0.0.1:8797", "restore", "--capture", tampered, "--wait-ms", "200"]), /refused: base inventory mismatch/);
    // Partial restore: post only the first captured event, then resume.
    const s3 = await startServer(join(root, "fresh3"), 8798); servers.push(s3);
    const lines = (await readFile(join(cap, "events.jsonl"), "utf8")).trim().split("\n");
    const firstPost = await fetch("http://127.0.0.1:8798/api/v1/events", { method: "POST", headers: { "content-type": "application/json" }, body: lines[0] });
    assert.ok(firstPost.ok);
    assert.match(await cmd(["--server", "http://127.0.0.1:8798", "restore", "--capture", cap]), /restored .* resumed=1/);
    // Superset: one more unrelated event, then the reuse check must fail.
    const extra = join(root, "extra-state");
    await cmd(["--server", "http://127.0.0.1:8798", "--state", extra, "init"]);
    await cmd(["--server", "http://127.0.0.1:8798", "--state", extra, "define", "--word", "foreignthree", "--text", "extra entry"]);
    assert.match(await cmdFail(["--server", "http://127.0.0.1:8798", "reuse-check", "--capture", cap]), /not reusable: already restored inventory is not the pinned base plus the capture/);
    // The exact restored copy (s3 before the extra write would pass; the
    // tampered and foreign cases above prove the pin checks run first).
  } finally { for (const s of servers) await s.close(); await rm(root, { recursive: true, force: true }); }
});

test("a crash-remnant lock recovers, a live lock refuses, and a late init joins the capture", async () => {
  const root = await rootOf();
  const s = await startServer(join(root, "data"), 8795);
  try {
    const url = "http://127.0.0.1:8795";
    const a = join(root, "a"), b = join(root, "b");
    await cmd(["--server", url, "--state", a, "init"]);
    await cmd(["--server", url, "--state", a, "define", "--word", "lockone", "--text", "before the crash"]);
    // Crash remnant with a dead owner process.
    await mkdir(join(a, "lock"), { recursive: true });
    await writeFile(join(a, "lock", "owner.json"), JSON.stringify({ pid: 999999, started_at: new Date(0).toISOString() }));
    const recovered = await cmd(["--server", url, "--state", a, "define", "--word", "locktwo", "--text", "after the crash"]);
    assert.match(recovered, /accepted/);
    assert.match(recovered, /recovered stale lock/);
    // Crash remnant with no owner file and an old directory time.
    await mkdir(join(a, "lock"), { recursive: true });
    const old = new Date(Date.now() - 60000); await utimes(join(a, "lock"), old, old);
    assert.match(await cmd(["--server", url, "--state", a, "profile", "--name", "Recovered"]), /accepted/);
    // A lock whose owner process is alive refuses. The owner record
    // carries the sleeper's real process start tick.
    const sleeper = spawn("sleep", ["30"]);
    try {
      const statText = await readFile(`/proc/${sleeper.pid}/stat`, "utf8");
      const ticks = Number(statText.slice(statText.lastIndexOf(")") + 2).split(" ")[19]);
      await mkdir(join(a, "lock"), { recursive: true });
      await writeFile(join(a, "lock", "owner.json"), JSON.stringify({ pid: sleeper.pid, proc_start: ticks, started_at: new Date().toISOString(), token: "live" }));
      assert.match(await cmdFail(["--server", url, "--state", a, "define", "--word", "lockthree", "--text", "blocked"]), /refused: another write is in progress/);
      assert.match(await cmdFail(["--server", url, "--state", a, "unlock"]), /refused: the lock owner process .* is still running/);
    } finally { sleeper.kill(); await rm(join(a, "lock"), { recursive: true, force: true }); }
    // Late init: B starts after A has written, and still joins the capture.
    await cmd(["--server", url, "--state", b, "init"]);
    await cmd(["--server", url, "--state", b, "define", "--word", "lockfour", "--text", "late starter"]);
    const cap = join(root, "capture");
    assert.match(await cmd(["--server", url, "capture", "--state", a, "--state", b, "--out", cap]), /captured/);
    const manifest = JSON.parse(await readFile(join(cap, "manifest.json"), "utf8"));
    const idA = JSON.parse(await readFile(join(a, "identity.json"), "utf8"));
    assert.equal(manifest.base_snapshot, idA.base_snapshot);
    assert.equal(manifest.public_keys.length, 2);
  } finally { await s.close(); await rm(root, { recursive: true, force: true }); }
});

test("recent and history page past one server page, and heads past 64 merge", async () => {
  const root = await rootOf();
  const s = await startServer(join(root, "data"), 8795);
  try {
    const url = "http://127.0.0.1:8795";
    // Seed 1,005 chained merge events in one batch admission.
    const seed = new Uint8Array(32).fill(77);
    const events: any[] = []; let prev: string[] = [];
    for (let i = 0; i < 1005; i++) {
      const ev = createEvent(seed, prev, String(i).padStart(32, "0"), { kind: "identity.merge" }, null);
      events.push(ev); prev = [ev.envelope.id];
    }
    const lastId = events.at(-1).envelope.id;
    await s.service.admitMany(events.map((e) => utf8(JSON.stringify(e))));
    // Seed 65 concurrent heads for a second identity.
    const seed2 = new Uint8Array(32).fill(78);
    const headsEvents = Array.from({ length: 65 }, (_, i) => createEvent(seed2, [], String(10000 + i).padStart(32, "0"), { kind: "identity.merge" }, null));
    await s.service.admitMany(headsEvents.map((e) => utf8(JSON.stringify(e))));
    // A state folder for the seeded identity continues it through the CLI.
    const { identityFromSeed } = await import("../../packages/core/src/index.ts");
    const seededState = join(root, "seeded");
    await mkdir(seededState, { recursive: true });
    // recent keeps the tail of a journal longer than one 1,000 item page.
    const state = join(root, "reader");
    await cmd(["--server", url, "--state", state, "init"]);
    const recentOut = await cmd(["--server", url, "--state", state, "recent", "--limit", "5"]);
    // The true journal tail is the last admitted head event. Read it from the API.
    let tailId = ""; let after: string | null = null;
    for (;;) { const page: any = await (await fetch(url + `/api/v1/changes?limit=1000${after ? `&after=${encodeURIComponent(after)}` : ""}`)).json(); tailId = page.items.at(-1)?.id ?? tailId; if (page.caught_up) break; after = page.next; }
    assert.ok(recentOut.includes(tailId), recentOut.slice(-500));
    assert.ok(!recentOut.includes(events[0].envelope.id), recentOut);
    assert.equal(recentOut.trim().split("\n").length, 5);
    // history pages past one 200 item page for the seeded identity.
    const m = await (await fetch(url + "/api/v1/manifest")).json() as any;
    await writeFile(join(seededState, "identity.json"), JSON.stringify({ seed: Buffer.from(seed).toString("hex"), identity: identityFromSeed(seed), base_snapshot: m.snapshot, base_inventory: m.logical_inventory }, null, 2));
    const histOut = await cmd(["--server", url, "--state", seededState, "history", "--limit", "1005"]);
    assert.equal(histOut.trim().split("\n").length, 1005, histOut.slice(0, 300));
    assert.ok(histOut.includes(lastId));
    // A write with 65 heads first combines them in batches of 64.
    const headState = join(root, "heads");
    await mkdir(headState, { recursive: true });
    await writeFile(join(headState, "identity.json"), JSON.stringify({ seed: Buffer.from(seed2).toString("hex"), identity: identityFromSeed(seed2), base_snapshot: m.snapshot, base_inventory: m.logical_inventory }, null, 2));
    assert.match(await cmd(["--server", url, "--state", headState, "define", "--word", "headsword", "--text", "after many heads"]), /accepted/);
  } finally { await s.close(); await rm(root, { recursive: true, force: true }); }
});

test("many recoverers of one stale lock stay one writer, and a reused PID does not block", async () => {
  const root = await rootOf();
  const s = await startServer(join(root, "data"), 8795);
  try {
    const url = "http://127.0.0.1:8795";
    const a = join(root, "a");
    const identity = (await cmd(["--server", url, "--state", a, "init"])).match(/ed25519:[a-f0-9]{64}/)![0];
    await cmd(["--server", url, "--state", a, "define", "--word", "raceone", "--text", "before the race"]);
    // One dead-owner lock, eight writers at the same time.
    await mkdir(join(a, "lock"), { recursive: true });
    await writeFile(join(a, "lock", "owner.json"), JSON.stringify({ pid: 999999, proc_start: 1, started_at: new Date(0).toISOString(), token: "dead" }));
    const runs = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      run(tsx, [cli, "--server", url, "--state", a, "define", "--word", `race${i}`, "--text", "race write"], { timeout: 180000 })
        .then((r) => (r.stdout + r.stderr)).catch((e: any) => (e.stdout ?? "") + (e.stderr ?? ""))));
    const accepted = runs.filter((r) => r.includes("accepted"));
    assert.ok(accepted.length >= 1 && accepted.length < 8, runs.join("\n"));
    const heads = await (await fetch(`${url}/api/v1/identity-heads/${encodeURIComponent(identity)}?limit=200`)).json() as any;
    assert.equal(heads.heads.length, 1, JSON.stringify(heads));
    // A live PID with an old start time is a reused PID, not the owner.
    const sleeper = spawn("sleep", ["30"]);
    try {
      await mkdir(join(a, "lock"), { recursive: true });
      await writeFile(join(a, "lock", "owner.json"), JSON.stringify({ pid: sleeper.pid, started_at: new Date(0).toISOString() }));
      assert.match(await cmd(["--server", url, "--state", a, "define", "--word", "raceafter", "--text", "after pid reuse"]), /accepted/);
      // The same reused-PID lock can be cleared by hand.
      await mkdir(join(a, "lock"), { recursive: true });
      await writeFile(join(a, "lock", "owner.json"), JSON.stringify({ pid: sleeper.pid, started_at: new Date(0).toISOString() }));
      assert.match(await cmd(["--server", url, "--state", a, "unlock"]), /lock cleared/);
    } finally { sleeper.kill(); }
  } finally { await s.close(); await rm(root, { recursive: true, force: true }); }
});

test("a paused recoverer does not steal a lock won during its wait", async () => {
  const root = await rootOf();
  const s = await startServer(join(root, "data"), 8795);
  const sleeper = spawn("sleep", ["60"]);
  try {
    const url = "http://127.0.0.1:8795";
    const a = join(root, "a");
    const identity = (await cmd(["--server", url, "--state", a, "init"])).match(/ed25519:[a-f0-9]{64}/)![0];
    await cmd(["--server", url, "--state", a, "define", "--word", "pauseone", "--text", "before the pause"]);
    // Stale lock: a live process whose start tick does not match.
    await mkdir(join(a, "lock"), { recursive: true });
    await writeFile(join(a, "lock", "owner.json"), JSON.stringify({ pid: sleeper.pid, proc_start: 1, started_at: new Date(0).toISOString(), token: "stale-token" }));
    // Writer two judges the lock stale, then pauses on the test hook.
    const pauseFile = join(root, "pause");
    await writeFile(pauseFile, "pause");
    const w2 = spawn(tsx, [cli, "--server", url, "--state", a, "define", "--word", "pausedword", "--text", "paused writer"], { env: { ...process.env, SYNTHETIC_ACTIVITY_TEST_PAUSE: pauseFile } });
    let w2Out = ""; w2.stdout.on("data", (d) => (w2Out += d)); w2.stderr.on("data", (d) => (w2Out += d));
    const w2Done = new Promise((r) => w2.on("exit", r));
    await new Promise((r) => setTimeout(r, 2000));
    // Writer one recovers the same lock and holds it.
    const w1 = spawn(tsx, [cli, "--server", url, "--state", a, "define", "--word", "winnerword", "--text", "winning writer"]);
    let w1Out = ""; w1.stdout.on("data", (d) => (w1Out += d)); w1.stderr.on("data", (d) => (w1Out += d));
    const w1Done = new Promise((r) => w1.on("exit", r));
    // Wait until writer one's token owns the lock, then release writer two.
    for (let i = 0; i < 200; i++) {
      try { const owner = JSON.parse(await readFile(join(a, "lock", "owner.json"), "utf8")); if (owner.token !== "stale-token") break; } catch {}
      await new Promise((r) => setTimeout(r, 10));
    }
    await rm(pauseFile, { force: true });
    const w1Code = await w1Done;
    const w2Code = await w2Done;
    assert.equal(w1Code, 0, w1Out);
    assert.match(w1Out, /accepted/);
    // Writer two either refused or wrote after writer one. Never both at once.
    assert.ok(w2Code === 0 || w2Code === 3, w2Out);
    // No two events of this identity share one previous list.
    const activity = await (await fetch(`${url}/api/v1/identities/${encodeURIComponent(identity)}/activity?accepted=1&limit=1000`)).json() as any;
    const own = [];
    for (const item of activity.items) own.push({ id: item.id, envelope: await (await fetch(`${url}/api/v1/events/${encodeURIComponent(item.id)}`)).json() });
    const seen = new Map<string, string>();
    for (const item of own) {
      const key = JSON.stringify(item.envelope.header.previous);
      assert.ok(!seen.has(key), `shared previous ${key} by ${seen.get(key)} and ${item.id}`);
      seen.set(key, item.id);
    }
    const heads = await (await fetch(`${url}/api/v1/identity-heads/${encodeURIComponent(identity)}?limit=200`)).json() as any;
    assert.equal(heads.heads.length, 1);
  } finally { sleeper.kill(); await s.close(); await rm(root, { recursive: true, force: true }); }
});

test("a pin without evidence and a larger unrelated server are refused at init", async () => {
  const root = await rootOf();
  const s1 = await startServer(join(root, "one"), 8795);
  const s2 = await startServer(join(root, "two"), 8796);
  try {
    const a = join(root, "a");
    await cmd(["--server", "http://127.0.0.1:8795", "--state", a, "init"]);
    await cmd(["--server", "http://127.0.0.1:8795", "--state", a, "define", "--word", "evidone", "--text", "base event one"]);
    await cmd(["--server", "http://127.0.0.1:8795", "--state", a, "define", "--word", "evidtwo", "--text", "base event two"]);
    const pinFile = join(root, "pins", "base-pin.json");
    await cmd(["--server", "http://127.0.0.1:8795", "--state", a, "--pin", pinFile, "pin-base"]);
    // The second server holds more events, and none of the pinned base.
    const b = join(root, "b");
    await cmd(["--server", "http://127.0.0.1:8796", "--state", b, "init"]);
    for (const w of ["unrelone", "unreltwo", "unrelthree"]) await cmd(["--server", "http://127.0.0.1:8796", "--state", b, "define", "--word", w, "--text", "unrelated event"]);
    const c = join(root, "c");
    assert.match(await cmdFail(["--server", "http://127.0.0.1:8796", "--state", c, "--pin", pinFile, "init"]), /refused: base pin does not match this server/);
    assert.equal(existsSync(join(c, "identity.json")), false);
    // A pin file with no base evidence is refused as well.
    const barePin = join(root, "pins", "bare.json");
    await mkdir(join(root, "pins"), { recursive: true });
    await writeFile(barePin, JSON.stringify({ base_snapshot: "sha256:" + "0".repeat(64), base_inventory: "sha256:" + "0".repeat(64) }));
    const d = join(root, "d");
    assert.match(await cmdFail(["--server", "http://127.0.0.1:8795", "--state", d, "--pin", barePin, "init"]), /refused: base pin file has no base evidence/);
    assert.equal(existsSync(join(d, "identity.json")), false);
  } finally { await s1.close(); await s2.close(); await rm(root, { recursive: true, force: true }); }
});

test("an inventory that changes during the manifest wait is refused with no post", async () => {
  const root = await rootOf();
  const servers: Awaited<ReturnType<typeof startServer>>[] = [];
  try {
    const s1 = await startServer(join(root, "src"), 8795); servers.push(s1);
    const a = join(root, "a");
    await cmd(["--server", "http://127.0.0.1:8795", "--state", a, "init"]);
    await cmd(["--server", "http://127.0.0.1:8795", "--state", a, "define", "--word", "waitone", "--text", "waiting capture"]);
    const cap = join(root, "capture");
    await cmd(["--server", "http://127.0.0.1:8795", "capture", "--state", a, "--out", cap]);
    const target = await startServer(join(root, "target"), 8796); servers.push(target);
    const pinManifest = await (await fetch("http://127.0.0.1:8796/api/v1/manifest")).json();
    const staleManifest = { ...pinManifest, snapshot: "sha256:" + "f".repeat(64) };
    let manifestReads = 0;
    const proxy = createServer(async (req, res) => {
      if (req.url === "/synthetic-disposable") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ disposable: true })); return; }
      if (req.url === "/api/v1/manifest") { manifestReads++; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(manifestReads < 6 ? staleManifest : pinManifest)); return; }
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const upstream = await fetch(`http://127.0.0.1:8796${req.url}`, { method: req.method, headers: { "content-type": "application/json" }, body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : Buffer.concat(chunks) });
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    });
    await new Promise<void>((r) => proxy.listen(8797, "127.0.0.1", r));
    try {
      const restore = run(tsx, [cli, "--server", "http://127.0.0.1:8797", "restore", "--capture", cap], { timeout: 180000 }).then((r) => r.stdout + r.stderr).catch((e: any) => (e.stdout ?? "") + (e.stderr ?? ""));
      // Land a foreign event on the target while the restore waits.
      await new Promise((r) => setTimeout(r, 400));
      const f = join(root, "f");
      await cmd(["--server", "http://127.0.0.1:8796", "--state", f, "init"]);
      await cmd(["--server", "http://127.0.0.1:8796", "--state", f, "define", "--word", "waitforeign", "--text", "lands during the wait"]);
      assert.match(await restore, /refused: inventory changed while waiting for the manifest; refusing to write/);
      const ids = ((await (await fetch("http://127.0.0.1:8796/api/v1/inventory?kind=events&limit=1000")).json()) as any).ids;
      assert.equal(ids.length, 1);
    } finally { await new Promise<void>((r) => proxy.close(() => r())); }
  } finally { for (const s of servers) await s.close(); await rm(root, { recursive: true, force: true }); }
});

test("envelope-only inventory is repaired and proved, foreign partial writes nothing, delayed manifest resumes", async () => {
  const root = await rootOf();
  const servers: Awaited<ReturnType<typeof startServer>>[] = [];
  try {
    const s1 = await startServer(join(root, "src"), 8795); servers.push(s1);
    const a = join(root, "a");
    await cmd(["--server", "http://127.0.0.1:8795", "--state", a, "init"]);
    await cmd(["--server", "http://127.0.0.1:8795", "--state", a, "define", "--word", "bodyone", "--text", "a body that must be present"]);
    await cmd(["--server", "http://127.0.0.1:8795", "--state", a, "profile", "--name", "Body A"]);
    const cap = join(root, "capture");
    await cmd(["--server", "http://127.0.0.1:8795", "capture", "--state", a, "--out", cap]);
    const transports = (await readFile(join(cap, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const defTransport = transports.find((t: any) => t.envelope.header.action.kind === "definition.publish");
    // Envelope-only target: same IDs, no bodies.
    const s2 = await startServer(join(root, "envonly"), 8796); servers.push(s2);
    await s2.service.admitMany(transports.map((t: any) => utf8(JSON.stringify({ envelope: t.envelope, body: null }))));
    const hash = defTransport.envelope.header.content.hash;
    assert.equal((await fetch(`http://127.0.0.1:8796/api/v1/bodies/${encodeURIComponent(hash)}`)).status, 404);
    // The reuse check reposts the full transports, then proves bodies.
    assert.match(await cmd(["--server", "http://127.0.0.1:8796", "reuse-check", "--capture", cap]), /^reusable$/m);
    assert.equal((await fetch(`http://127.0.0.1:8796/api/v1/bodies/${encodeURIComponent(hash)}`)).status, 200);
    // Foreign partial: a foreign event and one captured event. No write may happen.
    const s3 = await startServer(join(root, "foreign"), 8797); servers.push(s3);
    const f = join(root, "f");
    await cmd(["--server", "http://127.0.0.1:8797", "--state", f, "init"]);
    await cmd(["--server", "http://127.0.0.1:8797", "--state", f, "define", "--word", "foreignword", "--text", "not the base"]);
    assert.ok((await fetch("http://127.0.0.1:8797/api/v1/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(transports[0]) })).ok);
    const countBefore = ((await (await fetch("http://127.0.0.1:8797/api/v1/inventory?kind=events&limit=1000")).json()) as any).ids.length;
    assert.match(await cmdFail(["--server", "http://127.0.0.1:8797", "restore", "--capture", cap]), /refused: partial restore does not hold the pinned base; refusing to write/);
    const idsAfter = ((await (await fetch("http://127.0.0.1:8797/api/v1/inventory?kind=events&limit=1000")).json()) as any).ids;
    assert.equal(idsAfter.length, countBefore);
    assert.ok(!idsAfter.includes(transports[1].envelope.id));
    // Delayed manifest: a proxy reports the pinned base manifest while
    // the target already holds one captured event.
    const s4 = await startServer(join(root, "delayed"), 8798); servers.push(s4);
    const baseManifest = await (await fetch("http://127.0.0.1:8798/api/v1/manifest")).json();
    assert.ok((await fetch("http://127.0.0.1:8798/api/v1/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(transports[0]) })).ok);
    const proxy = createServer(async (req, res) => {
      if (req.url === "/synthetic-disposable") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ disposable: true })); return; }
      if (req.url === "/api/v1/manifest") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(baseManifest)); return; }
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const upstream = await fetch(`http://127.0.0.1:8798${req.url}`, { method: req.method, headers: { "content-type": "application/json" }, body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : Buffer.concat(chunks) });
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    });
    await new Promise<void>((r) => proxy.listen(8799, "127.0.0.1", r));
    try {
      assert.match(await cmd(["--server", "http://127.0.0.1:8799", "restore", "--capture", cap]), /restored .* resumed=1/);
    } finally { await new Promise<void>((r) => proxy.close(() => r())); }
  } finally { for (const s of servers) await s.close(); await rm(root, { recursive: true, force: true }); }
});

test("a bad loaded-view file and a pin for another server are refused", async () => {
  const root = await rootOf();
  // Unparsable loaded-view file.
  const bad = join(root, "bad"); await mkdir(bad, { recursive: true });
  await writeFile(join(bad, "disposable.json"), JSON.stringify({ disposable: true }));
  await writeFile(join(bad, "loaded-view.json"), "{");
  await assert.rejects(() => startServer(bad, 8795));
  // A loaded view that names no retained event or selection.
  const ghost = join(root, "ghost"); await mkdir(ghost, { recursive: true });
  await writeFile(join(ghost, "disposable.json"), JSON.stringify({ disposable: true }));
  await writeFile(join(ghost, "loaded-view.json"), JSON.stringify({ version: 1, view: "jve1:" + "0".repeat(64), selection: "sha256:" + "0".repeat(64) }));
  await assert.rejects(() => startServer(ghost, 8795), /not retained|invalid/);
  // Two servers on one data directory: the second start is refused.
  const s = await startServer(join(root, "data"), 8795);
  try {
    await assert.rejects(() => startServer(join(root, "data"), 8796), /locked/);
    // A pin taken on one server refuses a fresh identity on another.
    // The pin is taken after a first event, so its snapshot differs
    // from a fresh empty server.
    const a = join(root, "run", "a");
    await cmd(["--server", "http://127.0.0.1:8795", "--state", a, "init"]);
    await cmd(["--server", "http://127.0.0.1:8795", "--state", a, "define", "--word", "pinone", "--text", "pin source event"]);
    const pinFile = join(root, "run", "base-pin2.json");
    await cmd(["--server", "http://127.0.0.1:8795", "--state", a, "--pin", pinFile, "pin-base"]);
    const s2 = await startServer(join(root, "other"), 8796);
    try {
      const b = join(root, "run2", "b");
      assert.match(await cmdFail(["--server", "http://127.0.0.1:8796", "--state", b, "--pin", pinFile, "init"]), /refused: base pin does not match this server/);
      assert.equal(existsSync(join(b, "identity.json")), false);
    } finally { await s2.close(); }
  } finally { await s.close(); await rm(root, { recursive: true, force: true }); }
});
