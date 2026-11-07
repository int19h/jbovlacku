import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir, writeFile, cp, readdir } from "node:fs/promises";
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
    // The superset above fails because its count passes the pinned
    // base plus the capture. The exact restored copy passed earlier
    // in this test, before the extra write.
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
    await writeFile(join(a, "lock"), JSON.stringify({ pid: 999999, started_at: new Date(0).toISOString() }));
    const recovered = await cmd(["--server", url, "--state", a, "define", "--word", "locktwo", "--text", "after the crash"]);
    assert.match(recovered, /accepted/);
    assert.match(recovered, /recovered stale lock/);
    // The unlock command also clears a dead owner's lock by hand.
    await writeFile(join(a, "lock"), JSON.stringify({ pid: 999999, started_at: new Date(0).toISOString(), token: "dead-again" }));
    assert.match(await cmd(["--server", url, "--state", a, "unlock"]), /lock cleared/);
    // A lock whose owner process is alive refuses. The owner record
    // carries the sleeper's real process start tick.
    const sleeper = spawn("sleep", ["30"]);
    try {
      const statText = await readFile(`/proc/${sleeper.pid}/stat`, "utf8");
      const ticks = Number(statText.slice(statText.lastIndexOf(")") + 2).split(" ")[19]);
      await writeFile(join(a, "lock"), JSON.stringify({ pid: sleeper.pid, proc_start: ticks, started_at: new Date().toISOString(), token: "live" }));
      assert.match(await cmdFail(["--server", url, "--state", a, "define", "--word", "lockthree", "--text", "blocked"]), /refused: another write is in progress/);
      assert.match(await cmdFail(["--server", url, "--state", a, "unlock"]), /refused: the lock owner process .* is still running/);
    } finally { sleeper.kill(); await rm(join(a, "lock"), { force: true }); }
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
    await writeFile(join(a, "lock"), JSON.stringify({ pid: 999999, proc_start: 1, started_at: new Date(0).toISOString(), token: "dead" }));
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
      await writeFile(join(a, "lock"), JSON.stringify({ pid: sleeper.pid, started_at: new Date(0).toISOString() }));
      assert.match(await cmd(["--server", url, "--state", a, "define", "--word", "raceafter", "--text", "after pid reuse"]), /accepted/);
      // The same reused-PID lock can be cleared by hand.
      await writeFile(join(a, "lock"), JSON.stringify({ pid: sleeper.pid, started_at: new Date(0).toISOString() }));
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
    await writeFile(join(a, "lock"), JSON.stringify({ pid: sleeper.pid, proc_start: 1, started_at: new Date(0).toISOString(), token: "stale-token" }));
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
    let sawWinner = false;
    for (let i = 0; i < 500; i++) {
      try { const owner = JSON.parse(await readFile(join(a, "lock"), "utf8")); if (owner.token !== "stale-token") { sawWinner = true; break; } } catch {}
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(sawWinner, "writer one never owned the lock");
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

test("a writer killed at each lock step leaves a lock the next writer recovers", async () => {
  const root = await rootOf();
  const s = await startServer(join(root, "data"), 8795);
  try {
    const url = "http://127.0.0.1:8795";
    const a = join(root, "a");
    const identity = (await cmd(["--server", url, "--state", a, "init"])).match(/ed25519:[a-f0-9]{64}/)![0];
    await cmd(["--server", url, "--state", a, "define", "--word", "killbase", "--text", "before the kills"]);
    const killWriterAt = async (watch: (names: string[]) => boolean, word: string) => {
      const child = spawn(tsx, [cli, "--server", url, "--state", a, "define", "--word", word, "--text", "killed writer"], { detached: true });
      const done = new Promise((r) => child.on("exit", r));
      const deadline = Date.now() + 30000;
      let matched = false;
      while (Date.now() < deadline) {
        const names = await readdir(a).catch(() => [] as string[]);
        if (watch(names)) { matched = true; break; }
        await new Promise((r) => setTimeout(r, 1));
      }
      assert.ok(matched, `kill point for ${word} was never observed`);
      try { process.kill(-child.pid!, "SIGSTOP"); } catch {}
      try { process.kill(-child.pid!, "SIGKILL"); } catch {}
      await done;
    };
    // The first kill lands at whichever remnant of lock creation
    // exists when the watch fires: the private temp record, or the
    // published lock just after it. The second kill lands on the
    // published lock. Each remnant is one the next writer
    // recovers from.
    await killWriterAt((names) => names.some((n) => n.startsWith("lock.tmp-")) || names.includes("lock"), "killstep1");
    assert.match(await cmd(["--server", url, "--state", a, "define", "--word", "killstep1", "--text", "recovery one"]), /accepted/);
    await killWriterAt((names) => names.includes("lock"), "killstep2");
    assert.match(await cmd(["--server", url, "--state", a, "define", "--word", "killstep2", "--text", "recovery two"]), /accepted/);
    // No fork through any kill point.
    const activity = await (await fetch(`${url}/api/v1/identities/${encodeURIComponent(identity)}/activity?accepted=1&limit=1000`)).json() as any;
    const seen = new Map<string, string>();
    for (const item of activity.items) {
      const env = await (await fetch(`${url}/api/v1/events/${encodeURIComponent(item.id)}`)).json() as any;
      const key = JSON.stringify(env.header.previous);
      assert.ok(!seen.has(key), `shared previous ${key}`);
      seen.set(key, item.id);
    }
    const heads = await (await fetch(`${url}/api/v1/identity-heads/${encodeURIComponent(identity)}?limit=200`)).json() as any;
    assert.equal(heads.heads.length, 1);
  } finally { await s.close(); await rm(root, { recursive: true, force: true }); }
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

test("marker content, capture base proof, pin evidence, manifest fields, unlock, disconnect, history, guard forms", async () => {
  const root = await rootOf();
  const servers: Awaited<ReturnType<typeof startServer>>[] = [];
  try {
    // A marker that says false, and a marker that does not parse, refuse startup.
    for (const [name, content] of [["false", JSON.stringify({ disposable: false })], ["corrupt", "{"]] as const) {
      const dir = join(root, name); await mkdir(join(dir, "objects"), { recursive: true });
      await writeFile(join(dir, "disposable.json"), content);
      await assert.rejects(() => startServer(dir, 8795), /disposable/);
    }
    const s1 = await startServer(join(root, "src"), 8795); servers.push(s1);
    const url = "http://127.0.0.1:8795";
    const a = join(root, "a"), b = join(root, "b");
    await cmd(["--server", url, "--state", a, "init"]);
    await cmd(["--server", url, "--state", b, "init"]);
    const longText = "x1 " + "is a very long rehearsal definition ".repeat(12) + "for x2";
    const defOut = await cmd(["--server", url, "--state", a, "define", "--word", "guardword", "--text", longText, "--gloss", "guard"]);
    const defId = defOut.match(/jve1:[a-f0-9]{64}/)![0];
    await cmd(["--server", url, "--state", b, "define", "--word", "guardtwo", "--text", "second guard word"]);
    // Capture with one folder left out refuses and names the mismatch.
    assert.match(await cmdFail(["--server", url, "capture", "--state", a, "--out", join(root, "capbad")]), /refused: capture base does not match the pin/);
    const cap = join(root, "capture");
    assert.match(await cmd(["--server", url, "capture", "--state", a, "--state", b, "--out", cap]), /captured/);
    // A manifest that misses one required field refuses with no post.
    const broken = join(root, "broken"); await cp(cap, broken, { recursive: true });
    const bm = JSON.parse(await readFile(join(broken, "manifest.json"), "utf8")); delete bm.expected_final_inventory_digest;
    await writeFile(join(broken, "manifest.json"), JSON.stringify(bm, null, 2));
    const s2 = await startServer(join(root, "fresh"), 8796); servers.push(s2);
    assert.match(await cmdFail(["--server", "http://127.0.0.1:8796", "restore", "--capture", broken, "--wait-ms", "200"]), /refused: capture manifest is missing a required field/);
    const freshIds = ((await (await fetch("http://127.0.0.1:8796/api/v1/inventory?kind=events&limit=1000")).json()) as any).ids;
    assert.equal(freshIds.length, 0);
    // A corrupt capture is a reuse failure, not a plain error.
    assert.match(await cmdFail(["--server", "http://127.0.0.1:8796", "reuse-check", "--capture", join(root, "nope")]), /not reusable: capture cannot be read/);
    // An unreadable lock record counts as live unless forced.
    await writeFile(join(a, "lock"), "garbage-not-json");
    assert.match(await cmdFail(["--server", url, "--state", a, "unlock"]), /refused: the lock record cannot be read/);
    assert.match(await cmd(["--server", url, "--state", a, "unlock", "--force"]), /lock cleared/);
    // Truncated pin evidence refuses init and pin-base.
    const pinFile = join(root, "base-pin.json");
    const idsPath = pinFile + ".ids";
    const idsText = await readFile(idsPath, "utf8");
    await writeFile(idsPath, "jve1:" + "0".repeat(64) + "\n");
    const late = join(root, "late");
    assert.match(await cmdFail(["--server", url, "--state", late, "--pin", pinFile, "init"]), /refused: base pin evidence does not match its lists/);
    assert.match(await cmdFail(["--server", url, "--state", a, "--pin", pinFile, "pin-base"]), /refused: base pin evidence does not match its lists/);
    await writeFile(idsPath, idsText);
    // An explicit missing pin refuses init.
    assert.match(await cmdFail(["--server", url, "--state", late, "--pin", join(root, "missing.json"), "init"]), /refused: base pin file not found/);
    // A client that disconnects during its request body does not crash the adapter.
    await new Promise<void>((resolve) => {
      const sock = connect(8795, "127.0.0.1", () => { sock.write("POST /api/v1/events HTTP/1.1\r\nhost: x\r\ncontent-length: 100\r\n\r\n{\"partial\":"); sock.destroy(); resolve(); });
      sock.on("error", () => resolve());
    });
    assert.equal((await fetch(url + "/synthetic-disposable")).status, 200);
    assert.match(await cmd(["--server", url, "--state", a, "define", "--word", "guardthree", "--text", "after the disconnect"]), /accepted/);
    // History prints the latest actions, so the newest event is present.
    let lastId = "";
    for (let i = 0; i < 22; i++) { const out = await cmd(["--server", url, "--state", b, "profile", "--name", `Guard B ${i}`]); lastId = out.match(/jve1:[a-f0-9]{64}/)![0]; }
    const hist = await cmd(["--server", url, "--state", b, "history", "--limit", "5"]);
    assert.equal(hist.trim().split("\n").length, 5, hist);
    assert.ok(hist.includes(lastId), hist);
    // The documented ::1 form passes the loopback guard.
    assert.match(await cmd(["--server", "http://[::1]:8795", "--state", a, "whoami"]), /ed25519:/);
    // An environment proxy setting is refused before any request.
    try { await run(tsx, [cli, "--server", url, "--state", a, "whoami"], { timeout: 60000, env: { ...process.env, NODE_USE_ENV_PROXY: "1", HTTP_PROXY: "http://127.0.0.1:9" } }); assert.fail("proxy run should refuse"); }
    catch (e: any) { assert.match((e.stdout ?? "") + (e.stderr ?? ""), /refused: environment proxy support is on/); }
    // Invalid limits are refused.
    assert.match(await cmdFail(["--server", url, "--state", a, "recent", "--limit", "abc"]), /refused: --limit must be an integer/);
  } finally { for (const s of servers) await s.close(); await rm(root, { recursive: true, force: true }); }
});

test("show --full prints a complete long definition", async () => {
  const root = await rootOf();
  const servers: Awaited<ReturnType<typeof startServer>>[] = [];
  try {
    const s1 = await startServer(join(root, "data"), 8795); servers.push(s1);
    const url = "http://127.0.0.1:8795";
    const a = join(root, "a");
    const idA = (await cmd(["--server", url, "--state", a, "init"])).match(/ed25519:[a-f0-9]{64}/)![0];
    const longText = "x1 " + "is a very long rehearsal definition ".repeat(12) + "for x2";
    await cmd(["--server", url, "--state", a, "define", "--word", "fullword", "--text", longText, "--gloss", "full"]);
    await cmd(["--server", url, "--state", a, "view", "--name", "Full view", "--root", `${idA}=1/1`]);
    const inv = await (await fetch(url + "/api/v1/records?limit=50")).json() as any;
    const viewId = inv.items.find((i: any) => i.envelope.header.action.kind === "view.publish").id;
    await s1.close(); servers.splice(servers.indexOf(s1), 1);
    const s2 = await startServer(join(root, "data"), 8795, viewId); servers.push(s2);
    const short = await cmd(["--server", url, "--state", a, "show", "fullword"]);
    assert.ok(!short.includes(longText), short);
    const full = await cmd(["--server", url, "--state", a, "--full", "show", "fullword"]);
    assert.ok(full.includes(longText), full.slice(0, 400));
  } finally { for (const s of servers) await s.close(); await rm(root, { recursive: true, force: true }); }
});

test("capture takes its snapshot from the admitted inventory, not the lagging manifest", async () => {
  const root = await rootOf();
  const s1 = await startServer(join(root, "data"), 8795);
  try {
    const url = "http://127.0.0.1:8795";
    const a = join(root, "a");
    await cmd(["--server", url, "--state", a, "init"]);
    await cmd(["--server", url, "--state", a, "define", "--word", "lagone", "--text", "first lag event"]);
    const staleManifest = await (await fetch(url + "/api/v1/manifest")).json() as any;
    const second = await cmd(["--server", url, "--state", a, "define", "--word", "lagtwo", "--text", "newest lag event"]);
    const secondId = second.match(/jve1:[a-f0-9]{64}/)![0];
    // A proxy that reports the stale manifest snapshot, as a rich
    // server does while materialization lags admission.
    const proxy = createServer(async (req, res) => {
      if (req.url === "/synthetic-disposable") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ disposable: true })); return; }
      if (req.url === "/api/v1/manifest") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(staleManifest)); return; }
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const upstream = await fetch(`http://127.0.0.1:8795${req.url}`, { method: req.method, headers: { "content-type": "application/json" }, body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : Buffer.concat(chunks) });
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    });
    await new Promise<void>((r) => proxy.listen(8796, "127.0.0.1", r));
    try {
      const cap = join(root, "capture");
      assert.match(await cmd(["--server", "http://127.0.0.1:8796", "capture", "--state", a, "--out", cap]), /captured 2 events/);
      const events = await readFile(join(cap, "events.jsonl"), "utf8");
      assert.ok(events.includes(secondId), events);
    } finally { await new Promise<void>((r) => proxy.close(() => r())); }
  } finally { await s1.close(); await rm(root, { recursive: true, force: true }); }
});

test("capture refuses when a writer admits after the first inventory page, and writes no files", async () => {
  const root = await rootOf();
  const s1 = await startServer(join(root, "data"), 8795);
  try {
    const url = "http://127.0.0.1:8795";
    const a = join(root, "a");
    await cmd(["--server", url, "--state", a, "init"]);
    await cmd(["--server", url, "--state", a, "define", "--word", "stillone", "--text", "before capture"]);
    // Pre-build a second event from the same identity, to be
    // admitted by the proxy right after capture's first page.
    const identity = JSON.parse(await readFile(join(a, "identity.json"), "utf8"));
    const heads = (await (await fetch(`${url}/api/v1/identity-heads/${encodeURIComponent(identity.identity)}?limit=200`)).json() as any).heads;
    const { createEvent, wordId } = await import("../../packages/core/src/index.ts");
    const body = { word: { language: "jbo", spelling: "stilltwo" }, language: "en", text: [["writer still active"]], frame: null, glosses: [{ language: "en", text: "writer still active", sense: null }], notes: [], classification: { kind: "other", selmaho: [] }, license: { expression: "CC0-1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/", attribution: "" }, legacy: null };
    const late = createEvent(new Uint8Array(Buffer.from(identity.seed, "hex")), heads, "f".repeat(32), { kind: "definition.publish", word: wordId({ language: "jbo", spelling: "stilltwo" }), language: "en", parents: [], origin: "native" }, body);
    let admitted = false;
    const proxy = createServer(async (req, res) => {
      if (req.url === "/synthetic-disposable") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ disposable: true })); return; }
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const upstream = await fetch(`http://127.0.0.1:8795${req.url}`, { method: req.method, headers: { "content-type": "application/json" }, body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : Buffer.concat(chunks) });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      res.end(bytes);
      if (!admitted && req.method === "GET" && req.url?.startsWith("/api/v1/inventory")) {
        admitted = true;
        await fetch("http://127.0.0.1:8795/api/v1/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(late) });
      }
    });
    await new Promise<void>((r) => proxy.listen(8796, "127.0.0.1", r));
    try {
      const cap = join(root, "capture");
      assert.match(await cmdFail(["--server", "http://127.0.0.1:8796", "capture", "--state", a, "--out", cap]), /refused: writers are still active \(the admitted snapshot changed during capture\); stop them and capture again/);
      assert.equal(existsSync(cap), false);
      assert.ok(admitted);
    } finally { await new Promise<void>((r) => proxy.close(() => r())); }
  } finally { await s1.close(); await rm(root, { recursive: true, force: true }); }
});

test("existing-identity backfill checks the pin, and a missing pin prints a note", async () => {
  const root = await rootOf();
  const s1 = await startServer(join(root, "data"), 8795);
  try {
    const url = "http://127.0.0.1:8795";
    const a = join(root, "a");
    await cmd(["--server", url, "--state", a, "init"]);
    await cmd(["--server", url, "--state", a, "define", "--word", "backone", "--text", "backfill source"]);
    // An old identity record without the evidence fields.
    const old = JSON.parse(await readFile(join(a, "identity.json"), "utf8"));
    delete old.base_event_count; delete old.base_inventory_digest;
    const b = join(root, "b"); await mkdir(b, { recursive: true });
    await writeFile(join(b, "identity.json"), JSON.stringify(old, null, 2));
    await cmd(["--server", url, "--state", b, "init"]);
    const filled = JSON.parse(await readFile(join(b, "identity.json"), "utf8"));
    assert.ok(Number.isInteger(filled.base_event_count) && typeof filled.base_inventory_digest === "string", JSON.stringify(filled));
    // The backfilled identity joins a capture.
    assert.match(await cmd(["--server", url, "capture", "--state", a, "--state", b, "--out", join(root, "cap")]), /captured/);
    // A missing pin file prints a note instead of skipping silently.
    const c = join(root, "c"); await mkdir(c, { recursive: true });
    await writeFile(join(c, "identity.json"), JSON.stringify(old, null, 2));
    assert.match(await cmd(["--server", url, "--state", c, "--pin", join(root, "missing-pin.json"), "init"]), /note: no base pin file/);
    // A pin that does not match the identity's base refuses.
    const wrong = JSON.parse(await readFile(join(b, "identity.json"), "utf8"));
    wrong.base_snapshot = "sha256:" + "0".repeat(64);
    delete wrong.base_event_count; delete wrong.base_inventory_digest;
    const d = join(root, "d"); await mkdir(d, { recursive: true });
    await writeFile(join(d, "identity.json"), JSON.stringify(wrong, null, 2));
    assert.match(await cmdFail(["--server", url, "--state", d, "init"]), /refused: base pin does not match this identity's recorded base/);
  } finally { await s1.close(); await rm(root, { recursive: true, force: true }); }
});

test("a kit writer that starts during capture is refused, and the capture holds exactly snapshot S", async () => {
  const root = await rootOf();
  const s1 = await startServer(join(root, "data"), 8795);
  try {
    const url = "http://127.0.0.1:8795";
    const a = join(root, "a");
    await cmd(["--server", url, "--state", a, "init"]);
    await cmd(["--server", url, "--state", a, "define", "--word", "capone", "--text", "capture point one"]);
    await cmd(["--server", url, "--state", a, "define", "--word", "captwo", "--text", "capture point two"]);
    // A slow proxy stretches the capture so a writer can start inside it.
    const proxy = createServer(async (req, res) => {
      if (req.url === "/synthetic-disposable") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ disposable: true })); return; }
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const upstream = await fetch(`http://127.0.0.1:8795${req.url}`, { method: req.method, headers: { "content-type": "application/json" }, body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : Buffer.concat(chunks) });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      await new Promise((r) => setTimeout(r, 600));
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      res.end(bytes);
    });
    await new Promise<void>((r) => proxy.listen(8796, "127.0.0.1", r));
    try {
      const cap = join(root, "capture");
      const captureRun = run(tsx, [cli, "--server", "http://127.0.0.1:8796", "capture", "--state", a, "--out", cap], { timeout: 180000 })
        .then((r) => r.stdout + r.stderr).catch((e: any) => (e.stdout ?? "") + (e.stderr ?? ""));
      // Wait until capture holds the state folder lock, then write.
      let locked = false;
      for (let i = 0; i < 500 && !locked; i++) { locked = existsSync(join(a, "lock")); if (!locked) await new Promise((r) => setTimeout(r, 10)); }
      assert.ok(locked, "capture never took the write lock");
      const writerOut = await cmdFail(["--server", url, "--state", a, "define", "--word", "capthree", "--text", "during capture"]);
      assert.match(writerOut, /refused: another write is in progress for this state folder/);
      const captureOut = await captureRun;
      const m = captureOut.match(/captured (\d+) events snapshot=(\S+)/);
      assert.ok(m, captureOut);
      // The capture holds every synthetic event of snapshot S, and only those.
      const identity = JSON.parse(await readFile(join(a, "identity.json"), "utf8"));
      const atS = await (await fetch(`${url}/api/v1/identities/${encodeURIComponent(identity.identity)}/activity?accepted=1&limit=200&snapshot=${encodeURIComponent(m[2])}`)).json() as any;
      const want = atS.items.map((i: any) => i.id).sort();
      const got = (await readFile(join(cap, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l).envelope.id).sort();
      assert.deepEqual(got, want);
      const manifest = JSON.parse(await readFile(join(cap, "manifest.json"), "utf8"));
      assert.equal(manifest.capture_snapshot, m[2]);
      // After capture, the same writer succeeds.
      assert.match(await cmd(["--server", url, "--state", a, "define", "--word", "capthree", "--text", "during capture"]), /accepted/);
    } finally { await new Promise<void>((r) => proxy.close(() => r())); }
  } finally { await s1.close(); await rm(root, { recursive: true, force: true }); }
});

test("full base proof: missing or added base bodies and selections refuse before any post", async () => {
  const root = await rootOf();
  const servers: Awaited<ReturnType<typeof startServer>>[] = [];
  const post = async (port: number, ev: any) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ev) });
    assert.ok(r.ok, await r.text());
  };
  const eventCount = async (port: number) => ((await (await fetch(`http://127.0.0.1:${port}/api/v1/inventory?kind=events&limit=1000`)).json() as any).ids as string[]).length;
  try {
    // Source: one base profile with body and selection, then two
    // synthetic profiles with bodies of their own.
    const base = createEvent(new Uint8Array(32).fill(103), [], "1".repeat(32), { kind: "identity.profile" }, { name: "Base profile", bio: [], links: [] });
    const s1 = await startServer(join(root, "src"), 8795); servers.push(s1);
    await post(8795, base);
    const sel = await fetch("http://127.0.0.1:8795/api/v1/import-selections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([base.envelope.id]) });
    assert.ok(sel.ok, await sel.text());
    const a = join(root, "persona");
    await cmd(["--server", "http://127.0.0.1:8795", "--state", a, "init"]);
    await cmd(["--server", "http://127.0.0.1:8795", "--state", a, "profile", "--name", "Synthetic one"]);
    await cmd(["--server", "http://127.0.0.1:8795", "--state", a, "profile", "--name", "Synthetic two"]);
    const cap = join(root, "capture");
    assert.match(await cmd(["--server", "http://127.0.0.1:8795", "capture", "--state", a, "--out", cap]), /captured 2 events/);
    const transports = (await readFile(join(cap, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const baseHash = base.envelope.header.content.hash;

    // Partial restore, base body missing: refuse, and post nothing.
    const s2 = await startServer(join(root, "missing-body"), 8796); servers.push(s2);
    await post(8796, { ...base, body: null });
    const selM = await fetch("http://127.0.0.1:8796/api/v1/import-selections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([base.envelope.id]) });
    assert.ok(selM.ok, await selM.text());
    await post(8796, transports[0]);
    const beforeMissing = await eventCount(8796);
    assert.match(await cmdFail(["--server", "http://127.0.0.1:8796", "reuse-check", "--capture", cap]), /not reusable: base bodies do not match the pin/);
    assert.equal(await eventCount(8796), beforeMissing);
    // Completed restore, base body missing: refuse too.
    await post(8796, transports[1]);
    assert.match(await cmdFail(["--server", "http://127.0.0.1:8796", "reuse-check", "--capture", cap]), /not reusable: base bodies do not match the pin/);
    assert.equal((await fetch(`http://127.0.0.1:8796/api/v1/bodies/${baseHash}`)).status, 404);

    // Partial restore, base selection missing: refuse, post nothing.
    const s3 = await startServer(join(root, "missing-selection"), 8797); servers.push(s3);
    await post(8797, base);
    await post(8797, transports[0]);
    const beforeSel = await eventCount(8797);
    assert.match(await cmdFail(["--server", "http://127.0.0.1:8797", "reuse-check", "--capture", cap]), /not reusable: base import selections do not match the pin/);
    assert.equal(await eventCount(8797), beforeSel);
    // Completed restore, base selection missing: refuse too.
    for (const t of transports.slice(1)) await post(8797, t);
    assert.match(await cmdFail(["--server", "http://127.0.0.1:8797", "reuse-check", "--capture", cap]), /not reusable: base import selections do not match the pin/);

    // Missing captured bodies stay repairable when the base is exact.
    const s4 = await startServer(join(root, "repair"), 8798); servers.push(s4);
    await post(8798, base);
    const sel2 = await fetch("http://127.0.0.1:8798/api/v1/import-selections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([base.envelope.id]) });
    assert.ok(sel2.ok, await sel2.text());
    for (const t of transports) await post(8798, { ...t, body: null });
    assert.match(await cmd(["--server", "http://127.0.0.1:8798", "reuse-check", "--capture", cap]), /^reusable$/m);
    assert.equal((await fetch(`http://127.0.0.1:8798/api/v1/bodies/${baseHash}`)).status, 200);

    // Shared body hash: a synthetic profile with the same body as the
    // base. A target that holds the envelopes without any of the
    // bodies is repaired by the repost, shared hash included.
    const base2 = createEvent(new Uint8Array(32).fill(105), [], "3".repeat(32), { kind: "identity.profile" }, { name: "Base profile", bio: [], links: [] });
    const s5 = await startServer(join(root, "shared-src"), 8799); servers.push(s5);
    await post(8799, base2);
    const e = join(root, "shared-run", "persona");
    await cmd(["--server", "http://127.0.0.1:8799", "--state", e, "init"]);
    await cmd(["--server", "http://127.0.0.1:8799", "--state", e, "profile", "--name", "Base profile"]);
    await cmd(["--server", "http://127.0.0.1:8799", "--state", e, "profile", "--name", "Shared other"]);
    const sharedCap = join(root, "shared-capture");
    assert.match(await cmd(["--server", "http://127.0.0.1:8799", "capture", "--state", e, "--out", sharedCap]), /captured 2 events/);
    const sharedTransports = (await readFile(join(sharedCap, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(sharedTransports.some((t: any) => t.envelope.header?.content?.hash === base2.envelope.header.content.hash), "no captured event shares the base body hash");
    await s5.close(); servers.splice(servers.indexOf(s5), 1);
    const s6 = await startServer(join(root, "shared-repair"), 8799); servers.push(s6);
    await post(8799, { ...base2, body: null });
    for (const t of sharedTransports) await post(8799, { ...t, body: null });
    assert.match(await cmd(["--server", "http://127.0.0.1:8799", "reuse-check", "--capture", sharedCap]), /^reusable$/m);
    assert.equal((await fetch(`http://127.0.0.1:8799/api/v1/bodies/${base2.envelope.header.content.hash}`)).status, 200);
  } finally { for (const s of servers) await s.close(); await rm(root, { recursive: true, force: true }); }
});

test("changed base before capture refuses, added base body refuses restore, empty capture enforces the pin", async () => {
  const root = await rootOf();
  const servers: Awaited<ReturnType<typeof startServer>>[] = [];
  const post = async (port: number, ev: any) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ev) });
    assert.ok(r.ok, await r.text());
  };
  try {
    const base = createEvent(new Uint8Array(32).fill(104), [], "2".repeat(32), { kind: "identity.profile" }, { name: "Base profile", bio: [], links: [] });
    // Base body supplied after the pin: capture must refuse.
    const s1 = await startServer(join(root, "late-body"), 8795); servers.push(s1);
    await post(8795, { ...base, body: null });
    const a = join(root, "run-a", "persona");
    await cmd(["--server", "http://127.0.0.1:8795", "--state", a, "init"]);
    await post(8795, base);
    await cmd(["--server", "http://127.0.0.1:8795", "--state", a, "profile", "--name", "Late body synthetic"]);
    const lateCap = join(root, "late-capture");
    assert.match(await cmdFail(["--server", "http://127.0.0.1:8795", "capture", "--state", a, "--out", lateCap]), /refused: capture base bodies do not match the pin/);
    assert.equal(existsSync(join(lateCap, "manifest.json")), false);

    // Capture from the envelope-only base, then a target that holds
    // the base body the pin does not have: refuse before any post.
    const s2 = await startServer(join(root, "env-base"), 8796); servers.push(s2);
    await post(8796, { ...base, body: null });
    const b = join(root, "run-b", "persona");
    await cmd(["--server", "http://127.0.0.1:8796", "--state", b, "init"]);
    await cmd(["--server", "http://127.0.0.1:8796", "--state", b, "profile", "--name", "Env base synthetic"]);
    const cap = join(root, "capture");
    assert.match(await cmd(["--server", "http://127.0.0.1:8796", "capture", "--state", b, "--out", cap]), /captured 1 events/);
    const transports = (await readFile(join(cap, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const s3 = await startServer(join(root, "added-body"), 8797); servers.push(s3);
    await post(8797, base);
    await post(8797, transports[0]);
    assert.match(await cmdFail(["--server", "http://127.0.0.1:8797", "reuse-check", "--capture", cap]), /not reusable: base bodies do not match the pin/);

    // Base selection added after the pin: capture must refuse.
    const s4 = await startServer(join(root, "late-selection"), 8798); servers.push(s4);
    await post(8798, base);
    const c = join(root, "run-c", "persona");
    await cmd(["--server", "http://127.0.0.1:8798", "--state", c, "init"]);
    const sel = await fetch("http://127.0.0.1:8798/api/v1/import-selections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([base.envelope.id]) });
    assert.ok(sel.ok, await sel.text());
    await cmd(["--server", "http://127.0.0.1:8798", "--state", c, "profile", "--name", "Late selection synthetic"]);
    assert.match(await cmdFail(["--server", "http://127.0.0.1:8798", "capture", "--state", c, "--out", join(root, "sel-capture")]), /refused: capture base import selections do not match the pin/);

    // Empty capture: no synthetic events, still the full pin proof.
    const s5 = await startServer(join(root, "empty-src"), 8799); servers.push(s5);
    await post(8799, base);
    const selE = await fetch("http://127.0.0.1:8799/api/v1/import-selections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([base.envelope.id]) });
    assert.ok(selE.ok, await selE.text());
    const d = join(root, "run-d", "persona");
    await cmd(["--server", "http://127.0.0.1:8799", "--state", d, "init"]);
    const emptyCap = join(root, "empty-capture");
    assert.match(await cmd(["--server", "http://127.0.0.1:8799", "capture", "--state", d, "--out", emptyCap]), /captured 0 events/);
    await s5.close(); servers.splice(servers.indexOf(s5), 1);
    const s6 = await startServer(join(root, "empty-exact"), 8799); servers.push(s6);
    await post(8799, base);
    const selE2 = await fetch("http://127.0.0.1:8799/api/v1/import-selections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([base.envelope.id]) });
    assert.ok(selE2.ok, await selE2.text());
    assert.match(await cmd(["--server", "http://127.0.0.1:8799", "reuse-check", "--capture", emptyCap]), /^reusable$/m);
    await s6.close(); servers.splice(servers.indexOf(s6), 1);
    const s7 = await startServer(join(root, "empty-wrong"), 8799); servers.push(s7);
    await post(8799, { ...base, body: null });
    const selE3 = await fetch("http://127.0.0.1:8799/api/v1/import-selections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([base.envelope.id]) });
    assert.ok(selE3.ok, await selE3.text());
    assert.match(await cmdFail(["--server", "http://127.0.0.1:8799", "reuse-check", "--capture", emptyCap]), /not reusable: base bodies do not match the pin/);
  } finally { for (const s of servers) await s.close(); await rm(root, { recursive: true, force: true }); }
});
