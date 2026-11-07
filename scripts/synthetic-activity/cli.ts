/**
 * Generate synthetic local activity for measurement and tests.
 * Each identity is a disposable Ed25519 key in a state folder.
 * Writes go to a local server over HTTP and use its normal event
 * admission path. No store file is written by this tool.
 * The tool only talks to a loopback server that proves it holds a
 * disposable copy. See the README for the marker rule.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, rm, rename, link } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  initializeCore, identityFromSeed, createEvent, wordId, canonicalize,
  contentHash, utf8, prepareAdmission,
} from "../../packages/core/src/index.ts";

const sha256 = (b: Uint8Array | string) => "sha256:" + createHash("sha256").update(b as never).digest("hex");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const plain = (rt: unknown): string => Array.isArray(rt) ? rt.map(plain).join("") : typeof rt === "string" ? rt : "";
const digestIds = (ids: string[]) => sha256([...ids].sort().join("\n"));

interface Opts { server: string; state: string; view?: string; full: boolean; limit: number; args: string[]; flags: Map<string, string>; multi: Map<string, string[]> }
function parse(argv: string[]): Opts {
  const flags = new Map<string, string>(); const multi = new Map<string, string[]>(); const args: string[] = [];
  let server = "http://127.0.0.1:8795", state = "", full = false, limit = 20, view: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--full") full = true;
    else if (a === "--server") server = argv[++i];
    else if (a === "--state") { state = argv[++i]; const l = multi.get("state") ?? []; l.push(state); multi.set("state", l); }
    else if (a === "--view") view = argv[++i];
    else if (a === "--limit") { limit = Number(argv[++i]); if (!Number.isInteger(limit) || limit < 1 || limit > 100000) { console.error("refused: --limit must be an integer from 1 to 100000"); process.exit(3); } }
    else if (a.startsWith("--")) { const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true"; flags.set(a.slice(2), v); const l = multi.get(a.slice(2)) ?? []; l.push(v); multi.set(a.slice(2), l); }
    else args.push(a);
  }
  return { server: server.replace(/\/$/, ""), state, view, full, limit, args, flags, multi };
}
const flag = (o: Opts, n: string, d?: string) => o.flags.get(n) ?? d;

/** Only loopback targets are allowed. This runs before any request. */
function checkServer(server: string): URL {
  // An environment proxy would decide what the loopback name means.
  const proxyOn = /^(1|true)$/i.test(process.env.NODE_USE_ENV_PROXY ?? "") || /--use-env-proxy/.test(process.env.NODE_OPTIONS ?? "") || process.execArgv.some((a) => a.includes("--use-env-proxy"));
  if (proxyOn) { console.error("refused: environment proxy support is on (NODE_USE_ENV_PROXY or --use-env-proxy); a proxy must not route loopback requests"); process.exit(3); }
  let url: URL;
  try { url = new URL(server); } catch { console.error(`refused: server URL is not a valid loopback URL: ${server}`); process.exit(3); }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]" || url.hostname === "localhost";
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !loopback || url.username || url.password) {
    console.error(`refused: server must be a loopback URL (127.0.0.1, ::1 or localhost): ${server}`);
    process.exit(3);
  }
  return url;
}
/** Fetch with manual redirects. A redirect must stay on the same origin. */
async function rawFetch(o: Opts, urlText: string, init?: RequestInit): Promise<Response> {
  let current = urlText;
  for (let hop = 0; hop <= 5; hop++) {
    const r = await fetch(current, { ...init, redirect: "manual", signal: init?.signal ?? AbortSignal.timeout(180000) });
    if (r.status >= 300 && r.status < 400) {
      const location = r.headers.get("location");
      if (!location) return r;
      const next = new URL(location, current);
      const base = new URL(o.server);
      if (next.origin !== base.origin) {
        console.error(`refused: redirect leaves the loopback server: ${next.origin}`);
        process.exit(3);
      }
      current = next.toString();
      continue;
    }
    return r;
  }
  console.error("refused: too many redirects from the loopback server");
  process.exit(3);
}
let markerChecked = false;
/** The target must prove that it serves a marked disposable copy. */
async function checkMarker(o: Opts): Promise<void> {
  if (markerChecked) return;
  let j: any;
  try {
    const r = await rawFetch(o, o.server + "/synthetic-disposable");
    j = await r.json().catch(() => null);
    if (!r.ok || j?.disposable !== true) throw new Error("bad marker");
  } catch { console.error("refused: server does not prove it holds a disposable copy (missing disposable marker)"); process.exit(3); }
  markerChecked = true;
}
async function api(o: Opts, path: string, init?: RequestInit): Promise<any> {
  await checkMarker(o);
  const r = await rawFetch(o, o.server + "/api/v1" + path, init);
  const t = await r.text();
  let j: any; try { j = JSON.parse(t); } catch { j = { message: t }; }
  if (!r.ok) { const e: any = new Error(j.message ?? t); e.code = j.code; e.status = r.status; e.payload = j; throw e; }
  return j;
}
const refused = (e: any): never => { console.error(`refused: ${e.code ? e.code + ": " : ""}${e.message ?? String(e)}`); process.exit(3); };

interface Pin { base_snapshot: string; base_inventory: string; base_event_count?: number | null; base_inventory_digest?: string }
interface Identity { seed: string; identity: string; base_snapshot: string; base_inventory: string; base_event_count?: number | null; base_inventory_digest?: string }
async function loadIdentity(o: Opts): Promise<Identity> {
  if (!o.state) { console.error("refused: --state is required"); process.exit(2); }
  return JSON.parse(await readFile(join(o.state, "identity.json"), "utf8"));
}
function pinPath(o: Opts): string {
  return flag(o, "pin") ?? join(dirname(resolve(o.state)), "base-pin.json");
}
const pinIdsPath = (path: string) => path + ".ids";
/** A usable pin carries its base evidence: count, ID digest, and the ID list. */
function pinHasEvidence(pin: Pin, path: string): boolean {
  return Number.isInteger(pin.base_event_count) && typeof pin.base_inventory_digest === "string" && existsSync(pinIdsPath(path));
}
/** Write through a temp file and rename, so a crash keeps the old file whole. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp-${hex(randomBytes(8))}`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}
/** Read the pin ID list and check it against the pinned count and digest. */
async function readPinEvidence(pin: Pin, path: string): Promise<string[]> {
  const ids = (await readFile(pinIdsPath(path), "utf8")).split("\n").filter(Boolean);
  if (ids.length !== pin.base_event_count || digestIds(ids) !== pin.base_inventory_digest) {
    console.error("refused: base pin evidence does not match its ID list; take a new pin with pin-base"); process.exit(3);
  }
  return ids;
}
async function loadOrCreatePin(o: Opts): Promise<Pin> {
  const path = pinPath(o);
  if (existsSync(path)) {
    const pin = JSON.parse(await readFile(path, "utf8"));
    if (!pin.base_snapshot || !pin.base_inventory) { console.error(`refused: base pin file has no base: ${path}`); process.exit(3); }
    return pin;
  }
  let m: any;
  try { m = await api(o, "/manifest"); } catch (e: any) { console.error(`refused: cannot read the base pin from the server: ${e.code ? e.code + ": " : ""}${e.message ?? String(e)}`); process.exit(3); }
  if (!m.snapshot || !m.logical_inventory) { console.error("refused: server manifest has no snapshot or logical inventory for the base pin"); process.exit(3); }
  const ids = await inventoryIds(o, m.snapshot);
  const pin: Pin = { base_snapshot: m.snapshot, base_inventory: m.logical_inventory, base_event_count: ids.length, base_inventory_digest: digestIds(ids) };
  await mkdir(dirname(path), { recursive: true });
  await writeAtomic(pinIdsPath(path), ids.join("\n") + (ids.length ? "\n" : ""));
  await writeAtomic(path, JSON.stringify(pin, null, 2) + "\n");
  return pin;
}

/** Process start ticks from /proc, or null where /proc is absent. */
async function procStartTicks(pid: number): Promise<number | null> {
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[19]);
    return Number.isSafeInteger(ticks) ? ticks : null;
  } catch { return null; }
}
/** True only when the recorded owner is the process that now holds the PID. */
async function ownerLive(owner: any): Promise<boolean> {
  if (!owner || !Number.isInteger(owner.pid)) return false;
  try { process.kill(owner.pid, 0); } catch (e: any) { return e?.code === "EPERM"; }
  const ticks = await procStartTicks(owner.pid);
  if (ticks === null) return true; // No start identity to compare. Stay safe.
  if (Number.isSafeInteger(owner.proc_start)) return owner.proc_start === ticks;
  // Locks without a recorded start tick: compare the wall-clock start
  // with the process start time. A reused PID starts at another time.
  try {
    const boot = Number((await readFile("/proc/stat", "utf8")).match(/^btime (\d+)$/m)?.[1]);
    const startedMs = Date.parse(owner.started_at ?? "");
    if (!Number.isSafeInteger(boot) || !Number.isFinite(startedMs)) return true;
    return Math.abs(boot * 1000 + (ticks / 100) * 1000 - startedMs) <= 20000;
  } catch { return true; }
}
async function readOwner(ownerPath: string): Promise<any> {
  try { return JSON.parse(await readFile(ownerPath, "utf8")); } catch { return null; }
}
/**
 * Test hook. When SYNTHETIC_ACTIVITY_TEST_PAUSE names a file, a
 * recoverer that has judged a lock stale waits until that file is
 * gone before it acts. Tests use it to force two recoverers into
 * the same window. Normal runs never set it.
 */
async function testPause(): Promise<void> {
  const path = process.env.SYNTHETIC_ACTIVITY_TEST_PAUSE;
  if (!path) return;
  const deadline = Date.now() + 120000;
  while (existsSync(path) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
}
/**
 * Claim a stale lock file by renaming it to a private name, then
 * verify what was claimed. Only one recoverer wins the rename.
 * If the moved token is not the stale token that was judged, a
 * peer published a new lock during the wait: link it back, and
 * start again. A claim deletes only the judged stale record.
 */
async function claimStale(lockPath: string, myToken: string, judgedToken: string | null): Promise<boolean> {
  const trash = `${lockPath}.stale-${myToken}`;
  try { await rename(lockPath, trash); } catch { return false; }
  const moved = await readOwner(trash);
  if ((moved?.token ?? null) === judgedToken) {
    await rm(trash, { force: true });
    return true;
  }
  try { await link(trash, lockPath); } catch {}
  await rm(trash, { force: true });
  return false;
}
interface LockHandle { release: () => Promise<void>; verify: () => Promise<boolean> }
/**
 * The lock is one file. Its content is the complete owner record.
 * A writer builds the record in a private temp file, then
 * publishes it with link. Link is atomic and fails when the lock
 * exists, so the lock never exists without its owner record,
 * and no writer can overwrite another owner's record. A writer
 * stopped before the link holds nothing. A writer stopped after
 * it leaves a complete record that recovery can judge.
 */
async function lock(o: Opts): Promise<LockHandle> {
  const lockPath = join(o.state, "lock");
  const token = hex(randomBytes(16));
  const owner = { pid: process.pid, proc_start: await procStartTicks(process.pid), started_at: new Date().toISOString(), token };
  const tmp = `${lockPath}.tmp-${token}`;
  try {
    await writeFile(tmp, JSON.stringify(owner) + "\n");
  } catch (e: any) { console.error(`error: cannot write the lock owner: ${e?.code ?? ""} ${e?.message ?? String(e)}`); process.exit(1); }
  const publish = async (): Promise<boolean> => {
    try { await link(tmp, lockPath); return true; }
    catch (e: any) {
      if (e?.code === "EEXIST") return false;
      await rm(tmp, { force: true });
      console.error(`error: cannot create the write lock: ${e?.code ?? ""} ${e?.message ?? String(e)}`); process.exit(1);
    }
  };
  try {
    for (let attempt = 0; attempt < 16; attempt++) {
      if (await publish()) {
        return {
          // Release only our own lock. A recoverer may own the path by then.
          release: async () => { const current = await readOwner(lockPath); if (current?.token === token) await rm(lockPath, { force: true }); },
          // The holder checks its token at the lock path before it posts.
          // A writer whose lock was claimed stops. It never posts under
          // another writer's lock in normal operation.
          verify: async () => (await readOwner(lockPath))?.token === token,
        };
      }
      const judged = await readOwner(lockPath);
      // The lock file always holds a complete record. An unreadable
      // record is treated as a live lock, never as stale.
      if (!judged || (await ownerLive(judged))) { rmSync(tmp, { force: true }); console.error("refused: another write is in progress for this state folder"); process.exit(3); }
      await testPause();
      // Read the owner again after the wait. A changed token means a
      // peer recovered first. Do not rename in that case.
      const again = await readOwner(lockPath);
      if ((again?.token ?? null) !== (judged?.token ?? null)) continue;
      if (again && (await ownerLive(again))) continue;
      if (await claimStale(lockPath, token, judged?.token ?? null)) console.error("recovered stale lock from a stopped write");
    }
    rmSync(tmp, { force: true });
    console.error("refused: another write is in progress for this state folder");
    process.exit(3);
  } finally { await rm(tmp, { force: true }); }
}
async function heads(o: Opts, identity: string): Promise<string[]> {
  const out: string[] = []; let after: string | null = null;
  for (;;) {
    const j: any = await api(o, `/identity-heads/${encodeURIComponent(identity)}?limit=200${after ? `&after=${encodeURIComponent(after)}` : ""}`);
    out.push(...(j.heads ?? []));
    if (!j.next) break; after = j.next;
  }
  return out;
}
async function postEvent(o: Opts, seed: Uint8Array, prev: string[], action: Record<string, unknown>, body: unknown | null, verify?: () => Promise<boolean>): Promise<any> {
  // A writer whose lock was moved never posts. This check and the
  // post are the last step under the lock, so a second writer can
  // only start after this post or after this writer stops here.
  if (verify && !(await verify())) { console.error("refused: the write lock was taken by another writer; this write did not post"); process.exit(3); }
  const ev = createEvent(seed, [...prev].sort(), hex(randomBytes(16)), action, body);
  const r = await api(o, "/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ev) });
  return { ev, receipt: r };
}
/** Combine heads in batches of 64 until the frontier fits one event. */
async function fitHeads(o: Opts, seed: Uint8Array, identity: string, verify?: () => Promise<boolean>): Promise<string[]> {
  let current = await heads(o, identity);
  while (current.length > 64) {
    await postEvent(o, seed, current.slice(0, 64), { kind: "identity.merge" }, null, verify);
    current = await heads(o, identity);
  }
  return current;
}
async function writeEvent(o: Opts, action: Record<string, unknown>, body: unknown | null): Promise<void> {
  const idn = await loadIdentity(o); const handle = await lock(o);
  try {
    const seed = unhex(idn.seed);
    const prev = await fitHeads(o, seed, idn.identity, handle.verify);
    const started = Date.now();
    const { ev, receipt: r } = await postEvent(o, seed, prev, action, body, handle.verify);
    const reasons = Array.isArray(r.reasons) && r.reasons.length ? ` reasons=${r.reasons.join(",")}` : "";
    console.log(`accepted ${r.id ?? ev.envelope.id} admission=${r.admission ?? "accepted"} interpretation=${r.interpretation ?? "unknown"}${reasons} ms=${Date.now() - started}`);
  } finally { await handle.release(); }
}
const rich = (text?: string) => text ? [[text]] : [];
function defBody(o: Opts): any {
  const spelling = flag(o, "word"); if (!spelling) { console.error("refused: --word is required"); process.exit(2); }
  const text = flag(o, "text", `${spelling} (synthetic test definition)`)!;
  return {
    word: { language: "jbo", spelling }, language: flag(o, "language", "en"),
    text: [[text]], frame: flag(o, "frame") ? JSON.parse(flag(o, "frame")!) : null,
    glosses: [{ language: flag(o, "language", "en"), text: flag(o, "gloss", text), sense: null }],
    notes: flag(o, "notes") ? [[flag(o, "notes")!]] : [], classification: { kind: flag(o, "kind", "other"), selmaho: [] },
    license: { expression: "CC0-1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/", attribution: "" }, legacy: null,
  };
}
function virtualId(descriptor: any): string {
  return "jvv1:" + contentHash(utf8("jbovlacku-virtual-definition-v1\n" + canonicalize(utf8(JSON.stringify(descriptor))))).slice(7);
}
async function main(): Promise<void> {
  const o = parse(process.argv.slice(2));
  // The loopback test runs before the core loads and before any request.
  checkServer(o.server);
  await initializeCore(await readFile(new URL("../../packages/core/generated/jvc_runtime_bg.wasm", import.meta.url)));
  const [cmd, ...rest] = o.args;
  try {
    if (cmd === "pin-base") {
      if (!o.state && !flag(o, "pin")) throw new Error("--pin or --state is required");
      const pin = await loadOrCreatePin(o);
      if (!pinHasEvidence(pin, pinPath(o))) { console.error("refused: base pin file has no base evidence; delete it or use a new --pin path, then run pin-base again"); process.exit(3); }
      await readPinEvidence(pin, pinPath(o));
      console.log(`base_snapshot ${pin.base_snapshot}`);
      console.log(`base_inventory ${pin.base_inventory}`);
    } else if (cmd === "init") {
      if (!o.state) throw new Error("--state is required");
      await mkdir(o.state, { recursive: true });
      const p = join(o.state, "identity.json");
      if (existsSync(p)) {
        const j = JSON.parse(await readFile(p, "utf8"));
        // Backfill the base evidence from the pin for identities
        // that were created before capture required it.
        if (j.base_inventory_digest == null || j.base_event_count == null) {
          try {
            const path = pinPath(o);
            if (existsSync(path)) {
              const pin = JSON.parse(await readFile(path, "utf8"));
              if (pin.base_inventory_digest && Number.isInteger(pin.base_event_count)) {
                j.base_event_count = pin.base_event_count; j.base_inventory_digest = pin.base_inventory_digest;
                j.base_snapshot ??= pin.base_snapshot; j.base_inventory ??= pin.base_inventory;
                await writeFile(p, JSON.stringify(j, null, 2) + "\n", { mode: 0o600 });
              }
            }
          } catch {}
        }
        console.log(`identity ${j.identity}`); return;
      }
      // One pin serves the whole run. A late identity reads the same file.
      // An explicit --pin that does not exist is a wrong path, not a
      // new pin. Only the default pin path may be created by init.
      if (flag(o, "pin") && !existsSync(pinPath(o))) { console.error(`refused: base pin file not found: ${pinPath(o)} (run pin-base first)`); process.exit(3); }
      const pinExisted = existsSync(pinPath(o));
      const pin = await loadOrCreatePin(o);
      if (pinExisted) {
        // Compare base evidence, not only a count. The server must
        // hold every pinned base ID. A server that grew past the pin
        // holds the base plus this run's later events, which the
        // capture checks prove. A pin without evidence is refused.
        if (!pinHasEvidence(pin, pinPath(o))) {
          console.error("refused: base pin file has no base evidence; take a new pin with pin-base"); process.exit(3);
        }
        let serverIds: string[];
        try { serverIds = await inventoryIds(o); } catch (e: any) { console.error(`refused: cannot check the base pin against the server: ${e.code ? e.code + ": " : ""}${e.message ?? String(e)}`); process.exit(3); }
        const serverSet = new Set(serverIds);
        const baseIds = await readPinEvidence(pin, pinPath(o));
        if (!baseIds.every((id) => serverSet.has(id))) {
          console.error("refused: base pin does not match this server; a new base needs a new pin file"); process.exit(3);
        }
      }
      const seed = randomBytes(32); const identity = identityFromSeed(new Uint8Array(seed));
      const rec: Identity = { seed: hex(new Uint8Array(seed)), identity, base_snapshot: pin.base_snapshot, base_inventory: pin.base_inventory, base_event_count: pin.base_event_count ?? null, base_inventory_digest: pin.base_inventory_digest };
      await writeFile(p, JSON.stringify(rec, null, 2) + "\n", { mode: 0o600 });
      console.log(`identity ${identity}`); console.log(`state ${resolve(o.state)}`);
    } else if (cmd === "unlock") {
      if (!o.state) throw new Error("--state is required");
      const lockPath = join(o.state, "lock");
      const owner = await readOwner(lockPath);
      // An unreadable record counts as live, as on the write path.
      if (!owner && existsSync(lockPath) && flag(o, "force") !== "true") {
        console.error("refused: the lock record cannot be read; it counts as a live lock (use --force to clear it)"); process.exit(3);
      }
      if ((await ownerLive(owner)) && flag(o, "force") !== "true") {
        console.error(`refused: the lock owner process ${owner.pid} is still running`); process.exit(3);
      }
      if (existsSync(lockPath) && !(await claimStale(lockPath, hex(randomBytes(16)), owner?.token ?? null))) {
        console.error("refused: the lock changed while it was being cleared; try again"); process.exit(3);
      }
      console.log("lock cleared");
    } else if (cmd === "whoami") { const j = await loadIdentity(o); console.log(j.identity); }
    else if (cmd === "search") {
      const q = rest.join(" "); const v = o.view ? `&view=${encodeURIComponent(o.view)}` : "";
      const j = await api(o, `/search?q=${encodeURIComponent(q)}&language=${encodeURIComponent(flag(o, "language", "en")!)}&limit=${o.limit}${v}`);
      if (o.full) { console.log(JSON.stringify(j, null, 2)); return; }
      for (const h of (j.hits ?? []).slice(0, o.limit)) {
        const definitions = (h.definitions ?? []).join(",");
        console.log(`${h.preview?.event ?? ""} ${h.word?.spelling ?? ""} word=${h.word_id ?? ""} definitions=${definitions} ${(h.preview?.plain_text ?? "").slice(0, 160)}`);
      }
      if (!(j.hits ?? []).length) console.log("no hits");
    } else if (cmd === "show") {
      const spelling = rest.join(" "); const wid = wordId({ language: "jbo", spelling });
      const v = o.view ? `?view=${encodeURIComponent(o.view)}` : "";
      const j = await api(o, `/words/${wid}${v}`);
      // With --full, the listing below prints each definition's
      // complete text instead of the 160 character preview.
      console.log(`word ${spelling} ${wid}`);
      if (j.word) console.log(`spelling ${j.word.spelling ?? spelling}`);
      for (const id of (j.definitions ?? [])) {
        const env = await api(o, `/events/${encodeURIComponent(id)}`);
        let text = "", issuer = env.header?.issuer ?? "";
        if (env.header?.content) { try { const b = await api(o, `/bodies/${encodeURIComponent(env.header.content.hash)}`); text = plain(b.text); } catch {} }
        const score = (j.scores ?? []).find((s: any) => s.target === id);
        console.log(`${id} by ${issuer} ${o.full ? text : text.slice(0, 160)}`);
        if (score) console.log(`  score support=${JSON.stringify(score.support)} opposition=${JSON.stringify(score.opposition)} reviewers=${score.direct_reviewers ?? "?"}`);
      }
      for (const a of (j.assignments ?? [])) console.log(`rafsi ${a.id} status=${a.status} claims=${(a.claims ?? []).join(",")}`);
      for (const s of (j.scores ?? []).filter((s: any) => !(j.definitions ?? []).includes(s.target))) console.log(`target ${s.target} support=${JSON.stringify(s.support)} opposition=${JSON.stringify(s.opposition)}`);
      if (!(j.definitions ?? []).length) console.log("no definitions");
    } else if (cmd === "recent") {
      // Page the whole journal and keep the tail. One page is the oldest part.
      const tail: any[] = []; let after: string | null = null;
      for (;;) {
        const j: any = await api(o, `/changes?limit=1000${after ? `&after=${encodeURIComponent(after)}` : ""}`);
        for (const it of (j.items ?? [])) { tail.push(it); if (tail.length > o.limit) tail.shift(); }
        if (j.caught_up || !j.items?.length) break; after = j.next;
      }
      for (const it of tail) { let kind = "?"; try { const e = await api(o, `/events/${encodeURIComponent(it.id)}`); kind = e.header?.action?.kind ?? "?"; } catch {} console.log(`${it.cursor} ${it.id} ${kind}`); }
      if (!tail.length) console.log("no events");
    } else if (cmd === "history") {
      const idn = await loadIdentity(o); const target = flag(o, "identity", idn.identity)!;
      // Activity pages come in event-ID order. Page all of it, order by
      // the receipt position, and print the latest --limit actions.
      const all: any[] = []; let after: string | null = null;
      for (;;) {
        const j: any = await api(o, `/identities/${encodeURIComponent(target)}/activity?accepted=1&limit=200${after ? `&after=${encodeURIComponent(after)}` : ""}`);
        all.push(...(j.items ?? []));
        if (!j.next || !(j.items ?? []).length) break; after = j.next;
      }
      const seenOf = (it: any) => { const n = Number(String(it.seen ?? "").split(".").at(-1)); return Number.isFinite(n) ? n : 0; };
      all.sort((x, y) => seenOf(x) - seenOf(y));
      const items = all.slice(-o.limit);
      for (const it of items) console.log(`${it.id} ${it.action?.kind ?? "?"} ${JSON.stringify(it.action ?? {}).slice(0, o.full ? 500 : 120)}`);
      if (!items.length) console.log("no actions");
    }
    // writes
    else if (cmd === "define") {
      const body = defBody(o); const wid = wordId(body.word);
      const parents = (flag(o, "parents", "") ?? "").split(",").filter(Boolean);
      await writeEvent(o, { kind: "definition.publish", word: wid, language: body.language, parents, origin: "native" }, body);
    } else if (cmd === "rafsi") {
      const spelling = flag(o, "word")!, rafsiS = flag(o, "rafsi")!;
      const wid = wordId({ language: "jbo", spelling });
      const pairId = "jvr1:" + contentHash(utf8("jbovlacku-rafsi-v1\n" + canonicalize(utf8(JSON.stringify({ word: wid, rafsi: rafsiS }))))).slice(7);
      await writeEvent(o, { kind: "rafsi.publish", word: wid, assignment: pairId, origin: "native" }, { word: { language: "jbo", spelling }, rafsi: rafsiS, rationale: rich(flag(o, "rationale")), sources: [], legacy: null });
    } else if (cmd === "judge") {
      const value = flag(o, "value", "bless")!; let target = flag(o, "target")!; const action: any = { kind: "judgment.set", target, value };
      if (flag(o, "conversion") || flag(o, "base")) { const d = { base: flag(o, "base")!, conversion: flag(o, "conversion", "te")!, rule: "place-conversion-v1" }; action.virtual = d; action.target = virtualId(d); }
      await writeEvent(o, action, flag(o, "explain") ? { text: rich(flag(o, "explain")) } : null);
    } else if (cmd === "trust") {
      const scope = { kind: flag(o, "scope-kind", "*"), word: flag(o, "scope-word", "*"), language: flag(o, "scope-language", "*") };
      await writeEvent(o, { kind: "trust.set", subject: flag(o, "subject")!, scope, value: flag(o, "value", "heed")! }, flag(o, "explain") ? { text: rich(flag(o, "explain")) } : null);
    } else if (cmd === "status") {
      await writeEvent(o, { kind: "status.set", target: flag(o, "target")!, value: flag(o, "value", "active")! }, flag(o, "explain") ? { text: rich(flag(o, "explain")) } : null);
    } else if (cmd === "profile") {
      await writeEvent(o, { kind: "identity.profile" }, { name: flag(o, "name", "Synthetic user")!, bio: rich(flag(o, "bio")), links: (flag(o, "link", "") ?? "").split(",").filter(Boolean) });
    } else if (cmd === "report") {
      const value = flag(o, "value", "report")!;
      await writeEvent(o, { kind: "report.set", subject: flag(o, "subject")!, category: flag(o, "category", "spam-flooding")!, value }, value === "report" ? { text: rich(flag(o, "text", "Synthetic test report")) } : (flag(o, "text") ? { text: rich(flag(o, "text")) } : null));
    } else if (cmd === "view") {
      const idn = await loadIdentity(o);
      const rootsRaw = o.multi.get("root") ?? [`${idn.identity}=1/1`];
      const roots = rootsRaw.map((r) => { const [identity, q] = r.split("="); const [n, d] = (q ?? "1/1").split("/"); return { identity, q: { numerator: Number(n), denominator: Number(d ?? 1) } }; }).sort((a, b) => a.identity.localeCompare(b.identity));
      const body = { name: flag(o, "name", "Synthetic view")!, description: rich(flag(o, "description")), roots, rafsi_threshold: { numerator: 1, denominator: 1 }, H: { numerator: 3, denominator: 1 }, alpha: { numerator: 1, denominator: 2 }, excluded: [], calculation: flag(o, "calculation", "simple-routes-bounds-v1")!, work: Number(flag(o, "work", "1000000")), import_sets: [], account_witnesses: [], account_authority: false, notes: [] };
      await writeEvent(o, { kind: "view.publish", parents: (flag(o, "parents", "") ?? "").split(",").filter(Boolean) }, body);
    } else if (cmd === "merge") { await writeEvent(o, { kind: "identity.merge" }, null); }
    else if (cmd === "capture") { await capture(o); }
    else if (cmd === "restore") { await restore(o, false); }
    else if (cmd === "reuse-check") { await restore(o, true); }
    else { console.error("usage: pin-base|init|unlock|whoami|search|show|recent|history|define|rafsi|judge|trust|status|profile|report|view|merge|capture|restore|reuse-check (see README)"); process.exit(2); }
  } catch (e: any) {
    if (e?.name === "TimeoutError") { console.error("error: the server did not answer in time (check history before you retry)"); process.exit(1); }
    const network = /fetch failed|ECONNREFUSED/i.test(String(e?.message ?? e)) && !e?.code;
    if (cmd && ["define","rafsi","judge","trust","status","profile","report","view","merge"].includes(cmd) && !network) refused(e);
    if (network) { console.error(`error: cannot reach the server: ${e.message ?? String(e)}`); process.exit(1); }
    console.error(`error: ${e.code ? e.code + ": " : ""}${e.message ?? String(e)}`); process.exit(1);
  }
}

async function collectSynthetic(o: Opts, states: string[], snapshot?: string): Promise<{ transports: any[]; identities: Identity[] }> {
  const identities: Identity[] = [];
  for (const s of [...new Set(states)]) identities.push(JSON.parse(await readFile(join(s, "identity.json"), "utf8")));
  const byId = new Map<string, any>();
  const snap = snapshot ? `&snapshot=${encodeURIComponent(snapshot)}` : "";
  for (const idn of identities) {
    let after: string | null = null;
    for (;;) {
      const j: any = await api(o, `/identities/${encodeURIComponent(idn.identity)}/activity?accepted=1&limit=200${snap}${after ? `&after=${encodeURIComponent(after)}` : ""}`);
      for (const it of (j.items ?? [])) {
        const env = await api(o, `/events/${encodeURIComponent(it.id)}`);
        let body = null;
        if (env.header?.content) body = await api(o, `/bodies/${encodeURIComponent(env.header.content.hash)}`);
        byId.set(it.id, { envelope: env, body });
      }
      if (!j.next) break; after = j.next;
    }
  }
  const out: any[] = []; const done = new Set<string>(); const pending = new Map(byId);
  while (pending.size) { let progress = false; for (const [id, t] of pending) { const prev: string[] = t.envelope.header.previous ?? []; if (prev.every((p) => !byId.has(p) || done.has(p))) { out.push(t); done.add(id); pending.delete(id); progress = true; } } if (!progress) throw new Error("synthetic events have an unresolved predecessor cycle"); }
  return { transports: out, identities };
}
async function capture(o: Opts): Promise<void> {
  const outDir = flag(o, "out"); if (!outDir) { console.error("refused: --out is required"); process.exit(2); }
  const states = o.multi.get("state") ?? []; if (!states.length) { console.error("refused: --state is required (repeat for each identity)"); process.exit(2); }
  // Take the capture snapshot from the first unpinned inventory
  // page. That page names the admitted snapshot, which holds every
  // event the server has admitted. The manifest names the last
  // materialized snapshot instead, and that one can lag admission.
  // Every later read is pinned to the admitted snapshot, so the
  // capture is one point in time and no admitted event is missing.
  // A write that lands after that page is after the capture point.
  const firstPage = await api(o, "/inventory?kind=events&limit=1000");
  const sourceSnapshot: string = firstPage.snapshot;
  const { transports, identities: rawIdentities } = await collectSynthetic(o, states, sourceSnapshot);
  const identities = rawIdentities.filter((v, i, a) => a.findIndex((x) => x.identity === v.identity) === i);
  if (!identities[0]?.base_snapshot || !identities[0]?.base_inventory) { console.error("refused: identity has no base pin; run init again with a base pin"); process.exit(3); }
  const bases = new Set(identities.map((i) => i.base_snapshot + "|" + i.base_inventory)); if (bases.size > 1) { console.error("refused: state folders do not share one base pin; use one --pin file for the whole run"); process.exit(3); }
  // The derived base must equal the pin evidence. Otherwise a state
  // folder is missing, or an event outside the given folders is
  // being absorbed into the base, and the capture could not restore.
  if (!identities[0].base_inventory_digest || !Number.isInteger(identities[0].base_event_count)) { console.error("refused: identity has no base evidence; run init once to backfill it, or start a new state folder"); process.exit(3); }
  const allIds = await inventoryIds(o, sourceSnapshot);
  const synthetic = new Set(transports.map((t) => t.envelope.id));
  const baseIds = allIds.filter((id) => !synthetic.has(id));
  if (baseIds.length !== identities[0].base_event_count || digestIds(baseIds) !== identities[0].base_inventory_digest) {
    console.error(`refused: capture base does not match the pin: derived base ${baseIds.length} events digest ${digestIds(baseIds)}, pin ${identities[0].base_event_count} events digest ${identities[0].base_inventory_digest}; a state folder may be missing, or a write landed during capture`);
    process.exit(3);
  }
  await mkdir(outDir, { recursive: true });
  const lines = transports.map((t) => canonicalize(utf8(JSON.stringify(t))));
  const bytes = utf8(lines.join("\n") + (lines.length ? "\n" : ""));
  await writeFile(join(outDir, "events.jsonl"), bytes);
  const byKind: Record<string, number> = {}, byIssuer: Record<string, number> = {};
  for (const t of transports) { const k = t.envelope.header.action.kind; byKind[k] = (byKind[k] ?? 0) + 1; const iss = t.envelope.header.issuer; byIssuer[iss] = (byIssuer[iss] ?? 0) + 1; }
  let kit_revision = "unknown"; try { kit_revision = execFileSync("git", ["-C", resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch {}
  const manifest = {
    format: 1, base_snapshot: identities[0].base_snapshot, base_inventory: identities[0].base_inventory, kit_revision,
    event_count: transports.length, by_kind: byKind, by_issuer: byIssuer, public_keys: identities.map((i) => i.identity),
    event_file_sha256: sha256(bytes), base_event_count: baseIds.length, base_inventory_digest: digestIds(baseIds),
    expected_final_event_count: baseIds.length + transports.length, expected_final_inventory_digest: digestIds(allIds),
  };
  await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const keys: Record<string, string> = {}; for (const i of identities) keys[i.identity] = i.seed;
  await writeFile(join(outDir, "keys.json"), JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 });
  console.log(`captured ${transports.length} events sha256=${manifest.event_file_sha256}`);
}
async function inventoryIds(o: Opts, snapshot?: string): Promise<string[]> {
  const ids: string[] = []; let after: string | null = null;
  const snap = snapshot ? `&snapshot=${encodeURIComponent(snapshot)}` : "";
  for (;;) { const j: any = await api(o, `/inventory?kind=events&limit=1000${snap}${after ? `&after=${encodeURIComponent(after)}` : ""}`); ids.push(...(j.ids ?? [])); if (!j.next) break; after = j.next; }
  return ids.sort();
}
async function restore(o: Opts, checkOnly: boolean): Promise<void> {
  const dir = flag(o, "capture"); if (!dir) { console.error("refused: --capture is required"); process.exit(2); }
  const fail = (reason: string): never => { if (checkOnly) console.log(`not reusable: ${reason}`); else console.error(`refused: ${reason}`); process.exit(3); };
  let manifest: any = {}; let bytes: Buffer = Buffer.alloc(0);
  try {
    manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
    bytes = await readFile(join(dir, "events.jsonl"));
  } catch (e: any) { fail(`capture cannot be read: ${e.message ?? String(e)}`); }
  if (!manifest.base_snapshot || !manifest.base_inventory || !Number.isInteger(manifest.base_event_count) || !manifest.base_inventory_digest || !Number.isInteger(manifest.expected_final_event_count) || !manifest.expected_final_inventory_digest || !manifest.event_file_sha256 || !Number.isInteger(manifest.event_count)) fail(`capture manifest is missing a required field`);
  if (sha256(bytes) !== manifest.event_file_sha256) fail(`event file hash does not match manifest`);
  const lines = new TextDecoder().decode(bytes).trim().split("\n").filter(Boolean);
  if (lines.length !== manifest.event_count) fail(`event count ${lines.length} does not match manifest ${manifest.event_count}`);
  const transports = lines.map((l) => JSON.parse(l));
  const synthetic = new Set<string>(transports.map((t: any) => t.envelope.id));
  if (synthetic.size !== transports.length) fail(`capture holds a duplicate event id`);
  for (const t of transports) { try { const p = prepareAdmission(utf8(JSON.stringify(t))); if (!p.action_valid || p.body_status === "invalid") fail(`current code refuses event ${t.envelope?.id ?? "?"}: invalid action or body`); } catch (e: any) { fail(`current code refuses event ${t.envelope?.id ?? "?"}: ${e.message ?? String(e)}`); } }
  // Prove the exact inventory from event IDs before any post. The
  // manifest can lag behind the admitted inventory, so it never
  // decides the case. It only confirms a fresh copy, with a wait.
  let before: string[] = [];
  try { before = await inventoryIds(o); } catch (e: any) { fail(`cannot read server inventory: ${e.code ? e.code + ": " : ""}${e.message ?? String(e)}`); }
  const beforeSet = new Set(before);
  const present = transports.filter((t: any) => beforeSet.has(t.envelope.id));
  let resumed = 0;
  if (present.length === transports.length) {
    // Already restored. The ID set must be exactly the pinned base
    // plus the capture. Bodies are proved after the repost below.
    if (digestIds(before) !== manifest.expected_final_inventory_digest)
      fail(`already restored inventory is not the pinned base plus the capture: ${before.length} events, expected ${manifest.expected_final_event_count}`);
    resumed = present.length;
  } else if (present.length > 0) {
    // Partial restore. The other IDs must be exactly the pinned base.
    const rest = before.filter((id) => !synthetic.has(id));
    if (digestIds(rest) !== manifest.base_inventory_digest)
      fail(`partial restore does not hold the pinned base; refusing to write`);
    resumed = present.length;
  } else {
    if (digestIds(before) !== manifest.base_inventory_digest)
      fail(`base inventory does not match the capture pin; refusing to write`);
    // Fresh copy. Give a lagged manifest a bounded time to reach the pin.
    const waitMs = Number(flag(o, "wait-ms", "10000"));
    const deadline = Date.now() + (Number.isFinite(waitMs) && waitMs >= 0 ? waitMs : 10000);
    let matched = false; let last: any = null;
    for (;;) {
      try { last = await api(o, "/manifest"); } catch (e: any) { fail(`cannot read server manifest: ${e.code ? e.code + ": " : ""}${e.message ?? String(e)}`); }
      if (last.snapshot === manifest.base_snapshot && last.logical_inventory === manifest.base_inventory) { matched = true; break; }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!matched) {
      if (last?.snapshot === manifest.base_snapshot)
        fail(`base inventory mismatch: server ${last.logical_inventory} capture base ${manifest.base_inventory}`);
      fail(`base snapshot mismatch: server ${last?.snapshot} capture base ${manifest.base_snapshot}`);
    }
    // Read the inventory again after the wait. It must still be the
    // pinned base before anything posts.
    const waitedIds = await inventoryIds(o).catch((e: any) => fail(`cannot read server inventory: ${e.code ? e.code + ": " : ""}${e.message ?? String(e)}`));
    if (digestIds(waitedIds as string[]) !== manifest.base_inventory_digest)
      fail(`inventory changed while waiting for the manifest; refusing to write`);
  }
  // Post every captured transport, not only the missing ones. A
  // repost is idempotent. It makes the server validate each captured
  // representation and supplies any body that an earlier admission
  // left out.
  for (const t of transports) { try { await api(o, "/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(t) }); } catch (e: any) { fail(`server refuses event ${t.envelope.id}: ${e.code ? e.code + ": " : ""}${e.message ?? String(e)}`); } }
  const afterIds = await inventoryIds(o);
  if (afterIds.length !== manifest.expected_final_event_count || digestIds(afterIds) !== manifest.expected_final_inventory_digest)
    fail(`final inventory is not the pinned base plus the capture: ${afterIds.length} events, expected ${manifest.expected_final_event_count}`);
  // An event ID alone is not reusable. The envelope must match the
  // capture, and every captured body must be present.
  for (const t of transports) {
    let env: any;
    try { env = await api(o, `/events/${encodeURIComponent(t.envelope.id)}`); } catch (e: any) { fail(`captured event ${t.envelope.id} is not readable after restore: ${e.code ? e.code + ": " : ""}${e.message ?? String(e)}`); }
    if (canonicalize(utf8(JSON.stringify(env))) !== canonicalize(utf8(JSON.stringify(t.envelope))))
      fail(`captured envelope ${t.envelope.id} does not match the restored copy`);
    if (t.body !== null && t.body !== undefined) {
      const hash = t.envelope.header?.content?.hash;
      let fetched: any;
      try { fetched = await api(o, `/bodies/${encodeURIComponent(hash)}`); } catch { fail(`captured body for event ${t.envelope.id} is missing after restore`); }
      if (canonicalize(utf8(JSON.stringify(fetched))) !== canonicalize(utf8(JSON.stringify(t.body))))
        fail(`captured body for event ${t.envelope.id} does not match the restored copy`);
    }
  }
  if (checkOnly) console.log("reusable");
  else console.log(`restored ${transports.length} events resumed=${resumed} inventory=${afterIds.length} digest=${digestIds(afterIds)}`);
}
main();
