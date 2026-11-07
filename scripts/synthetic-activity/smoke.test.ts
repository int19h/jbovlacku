import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "./server.ts";
const run = promisify(execFile);
const cli = new URL("./cli.ts", import.meta.url).pathname;
const tsx = new URL("../../node_modules/.bin/tsx", import.meta.url).pathname;
async function cmd(args: string[]): Promise<string> {
  const { stdout, stderr } = await run(tsx, [cli, ...args], { timeout: 120000 });
  return stdout + stderr;
}
async function cmdFail(args: string[]): Promise<string> {
  try { await run(tsx, [cli, ...args], { timeout: 120000 }); } catch (e: any) { return (e.stdout ?? "") + (e.stderr ?? ""); }
  throw new Error("expected failure");
}
test("two identities act, capture, restore and reuse-check", async () => {
  const root = await mkdtemp(join(process.env.JVC_TEST_ROOT ?? tmpdir(), "synthetic-smoke-"));
  const servers: Awaited<ReturnType<typeof startServer>>[] = [];
  try {
    const s1 = await startServer(join(root, "base1"), 8795); servers.push(s1);
    const url1 = "http://127.0.0.1:8795";
    const a = join(root, "a"), b = join(root, "b");
    const idA = (await cmd(["--server", url1, "--state", a, "init"])).match(/ed25519:[a-f0-9]{64}/)![0];
    const idB = (await cmd(["--server", url1, "--state", b, "init"])).match(/ed25519:[a-f0-9]{64}/)![0];
    const frame = JSON.stringify({ role: "predicate", arity: { mode: "fixed", count: 3 }, places: [{ index: 1 }, { index: 2 }, { index: 3 }] });
    const outA = await cmd(["--server", url1, "--state", a, "define", "--word", "smokeone", "--text", "x1 is a smoke test for x2 by x3", "--gloss", "smoke", "--kind", "other", "--frame", frame]);
    assert.match(outA, /accepted/);
    // find definition id via history / search
    const histA = await cmd(["--server", url1, "--state", a, "history", "--full"]);
    // definition id is obtained from server records through show search: use recent
    // Get event ids via capture-like API directly
    const inv = await (await fetch(url1 + "/api/v1/records?limit=50")).json() as any;
    const def = inv.items.find((i: any) => i.envelope.header.action.kind === "definition.publish");
    const defId = def.id;
    const rafsiOut = await cmd(["--server", url1, "--state", a, "rafsi", "--word", "smokeone", "--rafsi", "smo"]);
    assert.match(rafsiOut, /accepted/);
    const inv2 = await (await fetch(url1 + "/api/v1/records?limit=50")).json() as any;
    const claim = inv2.items.find((i: any) => i.envelope.header.action.kind === "rafsi.publish");
    const pairId = claim.envelope.header.action.assignment;
    // B actions of each kind
    assert.match(await cmd(["--server", url1, "--state", b, "define", "--word", "smoketwo", "--text", "second smoke word", "--gloss", "smoke2"]), /accepted/);
    assert.match(await cmd(["--server", url1, "--state", b, "judge", "--target", defId, "--value", "bless", "--explain", "good"]), /accepted/);
    // The format allows virtual targets, but the current product validator
    // refuses them. The kit builds the spec form and shows the exact refusal.
    const virtualRefusal = await cmdFail(["--server", url1, "--state", b, "judge", "--base", defId, "--conversion", "te", "--value", "bless"]);
    assert.match(virtualRefusal, /refused: Draft does not satisfy version 1 action and body rules\./);
    assert.match(await cmd(["--server", url1, "--state", b, "judge", "--target", pairId, "--value", "curse"]), /accepted/);
    assert.match(await cmd(["--server", url1, "--state", b, "judge", "--target", defId, "--value", "clear"]), /accepted/);
    assert.match(await cmd(["--server", url1, "--state", b, "trust", "--subject", idA, "--value", "heed", "--scope-kind", "*", "--scope-word", "*", "--scope-language", "*"]), /accepted/);
    assert.match(await cmd(["--server", url1, "--state", b, "trust", "--subject", idA, "--value", "shun", "--scope-kind", "definition", "--scope-word", "*", "--scope-language", "en"]), /accepted/);
    assert.match(await cmd(["--server", url1, "--state", b, "trust", "--subject", idA, "--value", "clear", "--scope-kind", "definition", "--scope-word", "*", "--scope-language", "en"]), /accepted/);
    assert.match(await cmd(["--server", url1, "--state", b, "profile", "--name", "Smoke B", "--bio", "test user"]), /accepted/);
    assert.match(await cmd(["--server", url1, "--state", b, "report", "--subject", idA, "--category", "spam-flooding", "--value", "report", "--text", "synthetic check"]), /accepted/);
    assert.match(await cmd(["--server", url1, "--state", b, "report", "--subject", idA, "--category", "spam-flooding", "--value", "clear"]), /accepted/);
    const viewOut = await cmd(["--server", url1, "--state", b, "view", "--name", "Smoke view", "--root", `${idB}=1/1`]);
    assert.match(viewOut, /accepted/);
    const inv3 = await (await fetch(url1 + "/api/v1/records?limit=100")).json() as any;
    const viewId = inv3.items.find((i: any) => i.envelope.header.action.kind === "view.publish").id;
    // A revises, sets status, merges
    assert.match(await cmd(["--server", url1, "--state", a, "define", "--word", "smokeone", "--text", "revised smoke", "--gloss", "smoke", "--parents", defId]), /accepted/);
    assert.match(await cmd(["--server", url1, "--state", a, "status", "--target", defId, "--value", "deprecated"]), /accepted/);
    assert.match(await cmd(["--server", url1, "--state", a, "status", "--target", defId, "--value", "active"]), /accepted/);
    assert.match(await cmd(["--server", url1, "--state", a, "merge"]), /accepted/);
    // reads: restart the test server with the published view selected,
    // as a deployed server selects its view at startup
    await s1.close(); servers.splice(servers.indexOf(s1), 1);
    const s1b = await startServer(join(root, "base1"), 8795, viewId); servers.push(s1b);
    assert.match(await cmd(["--server", url1, "--state", a, "--view", viewId, "search", "smokeone"]), /smoke|no hits/);
    assert.match(await cmd(["--server", url1, "--state", a, "--view", viewId, "show", "smokeone"]), /smokeone/);
    assert.match(await cmd(["--server", url1, "--state", a, "recent"]), /definition\.publish|view\.publish/);
    assert.match(await cmd(["--server", url1, "--state", b, "history"]), /judgment\.set/);
    // refused write shows exact error
    const bad = await cmdFail(["--server", url1, "--state", b, "judge", "--target", defId, "--value", "bogus"]);
    assert.match(bad, /refused:/);
    // capture
    const cap = join(root, "capture");
    const capOut = await cmd(["--server", url1, "--state", a, "--state", b, "capture", "--out", cap]);
    assert.match(capOut, /captured \d+ events/);
    const manifest = JSON.parse(await readFile(join(cap, "manifest.json"), "utf8"));
    assert.ok(manifest.event_count >= 15, String(manifest.event_count));
    assert.equal(manifest.public_keys.length, 2);
    assert.ok(manifest.by_kind["definition.publish"] >= 2);
    assert.ok(manifest.by_kind["judgment.set"] >= 3);
    assert.ok(manifest.by_kind["trust.set"] >= 3);
    assert.ok(manifest.by_kind["view.publish"] >= 1);
    // restore on fresh server
    const s2 = await startServer(join(root, "base2"), 8796); servers.push(s2);
    const restoreOut = await cmd(["--server", "http://127.0.0.1:8796", "restore", "--capture", cap]);
    assert.match(restoreOut, /restored/);
    // reuse-check on another fresh server
    const s3 = await startServer(join(root, "base3"), 8797); servers.push(s3);
    const reuseOut = await cmd(["--server", "http://127.0.0.1:8797", "reuse-check", "--capture", cap]);
    assert.match(reuseOut, /reusable/);
  } finally { for (const s of servers) await s.close(); await rm(root, { recursive: true, force: true }); }
});
