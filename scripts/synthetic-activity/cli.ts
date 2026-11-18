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
import { mkdir, open, readFile, writeFile, rm, rename, link, stat } from "node:fs/promises";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  initializeCore, identityFromSeed, createEvent, wordId, canonicalize,
  contentHash, utf8, prepareAdmission,
} from "../../packages/core/src/index.ts";

const sha256 = (b: Uint8Array | string) => "sha256:" + createHash("sha256").update(b as never).digest("hex");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
/** Plain text of one rich-text node. An integer is a place, printed as x1, x2, and so on. */
function plainNode(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number" && Number.isInteger(node) && node > 0) return `x${node}`;
  if (Array.isArray(node)) return node.map(plainNode).join("");
  if (node && typeof node === "object") {
    const rec = node as Record<string, unknown>;
    if (typeof rec.label === "string") return rec.label;
    if (typeof rec.code === "string") return rec.code;
    if (typeof rec.operand === "string") return rec.operand;
  }
  return "";
}
/** Plain text of rich text. Paragraphs are arrays of nodes, joined by newlines. */
function plain(rt: unknown): string {
  if (Array.isArray(rt) && rt.every(Array.isArray)) return rt.map((paragraph) => plainNode(paragraph)).join("\n");
  return plainNode(rt);
}
/**
 * A closed output pipe, as when the command is piped to head, must
 * end the process quietly. The pipe error is not a failure of the command.
 * Any other output error is a failure. When the error stream still
 * works, the process prints that error, then exits with status 1.
 */
function exitQuietlyOnEpipe(): void {
  let failing = false;
  const onError = (err: NodeJS.ErrnoException) => {
    if (err?.code === "EPIPE") process.exit(0);
    if (failing) process.exit(1);
    failing = true;
    const line = `error: ${err?.message ?? String(err)}\n`;
    try { process.stderr.write(line, () => process.exit(1)); }
    catch { process.exit(1); }
  };
  process.stdout.on("error", onError);
  process.stderr.on("error", onError);
  process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
    if (err?.code === "EPIPE") process.exit(0);
    console.error(err);
    process.exit(1);
  });
}
exitQuietlyOnEpipe();
const digestIds = (ids: string[]) => sha256([...ids].sort().join("\n"));
/** The service logical-inventory digest: one hash over the sorted
 * retained event IDs, body hashes and import selections. */
function logicalInventoryDigest(events: string[], bodies: string[], selections: string[]): string {
  return contentHash(utf8(canonicalize(utf8(JSON.stringify({
    events: [...events].sort(), bodies: [...bodies].sort(), import_selections: [...selections].sort(),
  })))));
}

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
let markerServerId: string | undefined;
/** The target must prove that it serves a marked disposable copy. */
async function checkMarker(o: Opts): Promise<void> {
  if (markerChecked) return;
  let j: any;
  try {
    const r = await rawFetch(o, o.server + "/synthetic-disposable");
    j = await r.json().catch(() => null);
    if (!r.ok || j?.disposable !== true) throw new Error("bad marker");
  } catch { console.error("refused: server does not prove it holds a disposable copy (missing disposable marker)"); process.exit(3); }
  if (typeof j?.server_id === "string" && /^[0-9a-f]{32}$/.test(j.server_id)) markerServerId = j.server_id;
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

interface Pin { base_snapshot: string; base_inventory: string; base_event_count?: number | null; base_inventory_digest?: string; base_body_count?: number | null; base_body_digest?: string; base_selection_count?: number | null; base_selection_digest?: string; server_id?: string }
interface Identity { seed: string; identity: string; base_snapshot: string; base_inventory: string; base_event_count?: number | null; base_inventory_digest?: string; base_body_count?: number | null; base_body_digest?: string; base_selection_count?: number | null; base_selection_digest?: string; server_id?: string }
/**
 * The pin in use is an input of this command. That pin is the
 * explicit --pin, or the default base-pin.json beside the state
 * folder. Refuse an old pin before the identity is used, so the
 * command cannot post an event or rewrite the identity.
 */
async function refusePinInUse(o: Opts): Promise<void> {
  const path = pinPath(o);
  if (!existsSync(path)) {
    // A named --pin that is not there is a wrong path. The default
    // base-pin.json may be absent: init can create it, and an
    // existing identity keeps the note path.
    if (flag(o, "pin")) {
      console.error(`refused: base pin file not found: ${path} (run pin-base first)`);
      process.exit(3);
    }
    return;
  }
  requirePinServerId(JSON.parse(await readFile(path, "utf8")));
}
async function loadIdentity(o: Opts): Promise<Identity> {
  if (!o.state) { console.error("refused: --state is required"); process.exit(2); }
  const identity = JSON.parse(await readFile(join(o.state, "identity.json"), "utf8"));
  if (!validServerId(identity.server_id)) {
    console.error("refused: identity has no server id; make a new pin and a new state folder");
    process.exit(3);
  }
  await refusePinInUse(o);
  return identity;
}
function pinPath(o: Opts): string {
  return flag(o, "pin") ?? join(dirname(resolve(o.state)), "base-pin.json");
}
const pinIdsPath = (path: string) => path + ".ids";
const pinBodiesPath = (path: string) => path + ".bodies";
const pinSelectionsPath = (path: string) => path + ".selections";
/** A usable pin carries evidence for the whole logical inventory:
 * counts, digests, and the retained lists of all three components. */
function pinHasEvidence(pin: Pin, path: string): boolean {
  return Number.isInteger(pin.base_event_count) && typeof pin.base_inventory_digest === "string"
    && Number.isInteger(pin.base_body_count) && typeof pin.base_body_digest === "string"
    && Number.isInteger(pin.base_selection_count) && typeof pin.base_selection_digest === "string"
    && existsSync(pinIdsPath(path)) && existsSync(pinBodiesPath(path)) && existsSync(pinSelectionsPath(path));
}
/** Store a directory entry update. The caller has already renamed into this directory. */
async function syncDirectory(path: string): Promise<void> {
  const dir = await open(dirname(path), "r");
  try { await dir.sync(); }
  finally { await dir.close(); }
}
/**
 * Write through a temp file and rename, so a crash keeps the old
 * file whole. The temp file is stored before the rename. The
 * directory is stored after the rename. A mode, when given, is the
 * mode of the published file.
 * Test hook: when SYNTHETIC_ACTIVITY_TEST_CRASH names a suffix, a
 * write of a path with that suffix stops after the temp file is
 * stored and before the rename. Normal runs never set it.
 */
async function writeAtomic(path: string, text: string, mode?: number): Promise<void> {
  const tmp = `${path}.tmp-${hex(randomBytes(8))}`;
  const handle = mode === undefined ? await open(tmp, "w") : await open(tmp, "w", mode);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally { await handle.close(); }
  const crash = process.env.SYNTHETIC_ACTIVITY_TEST_CRASH;
  if (crash && path.endsWith(crash)) { console.error("test crash: stopped before publishing the file"); process.exit(86); }
  await rename(tmp, path);
  await syncDirectory(path);
}
/** An empty base has no event, body, or selection that could identify the server. */
function baseIsEmpty(pin: Pin, lists: PinLists): boolean {
  return lists.events.length === 0 && lists.bodies.length === 0 && lists.selections.length === 0
    && pin.base_event_count === 0 && pin.base_body_count === 0 && pin.base_selection_count === 0;
}
function validServerId(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value) ? value : undefined;
}
/** A pin without a server id is from an older kit. Refuse it before any identity or capture is written. */
function requirePinServerId(pin: Pin): string {
  const id = validServerId(pin.server_id);
  if (!id) { console.error("refused: pin has no server id; make a new pin with the current kit"); process.exit(3); }
  return id;
}
/**
 * The capture names the run by the original pin's server id.
 * A later capture on a restored copy keeps that id.
 * Every identity must record that same id.
 */
function runSourceId(pin: Pin, identities: Identity[]): string {
  const pinId = requirePinServerId(pin);
  const recorded = identities.map((identity) => validServerId(identity.server_id));
  if (recorded.some((id) => id !== undefined && id !== pinId)) {
    console.error("refused: an identity records a different server id than the base pin");
    process.exit(3);
  }
  if (recorded.some((id) => id !== pinId)) {
    console.error("refused: an identity does not record the base pin's server id; make a new pin and a new state folder");
    process.exit(3);
  }
  return pinId;
}
/**
 * An empty ID list is a subset of every server. The pin's server id,
 * taken from the disposable marker, is what tells the server that
 * made the pin from a larger unrelated server. A target that holds
 * a proven restored copy of that server accepts the same pin.
 */
async function refuseForeignEmptyPin(o: Opts, pin: Pin, lists: PinLists): Promise<void> {
  if (!baseIsEmpty(pin, lists)) return;
  const pinId = requirePinServerId(pin);
  await checkMarker(o);
  if (markerServerId === pinId) return;
  if (await targetHoldsProvenCopy(o, pinId)) return;
  console.error("refused: empty base pin does not match this server; a new base needs a new pin file"); process.exit(3);
}
/** The target recorded this source after a restore proved the inventory, and it still holds those events. */
async function targetHoldsProvenCopy(o: Opts, sourceId: string): Promise<boolean> {
  let body: any;
  try {
    const response = await rawFetch(o, o.server + "/synthetic-restored");
    body = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(body?.runs)) return false;
  } catch { return false; }
  let present: Set<string> | undefined;
  for (const run of body.runs) {
    if (run?.source_server_id !== sourceId || !Array.isArray(run.event_ids) || run.event_ids.length === 0) continue;
    if (!run.event_ids.every((id: unknown) => typeof id === "string")) continue;
    let held = present;
    if (!held) {
      try { held = new Set(await inventoryIds(o)); }
      catch { return false; }
      present = held;
    }
    if (held && run.event_ids.every((id: string) => held.has(id))) return true;
  }
  return false;
}
interface PinLists { events: string[]; bodies: string[]; selections: string[] }
/** Read the three pin lists and check each against its pinned count, digest, and combined base inventory. */
async function readPinEvidence(pin: Pin, path: string): Promise<PinLists> {
  const read = async (p: string) => (await readFile(p, "utf8")).split("\n").filter(Boolean);
  const events = await read(pinIdsPath(path));
  const bodies = await read(pinBodiesPath(path));
  const selections = await read(pinSelectionsPath(path));
  // The three component digests do not determine base_inventory.
  // One edited field is enough to make a capture that restore refuses.
  if (events.length !== pin.base_event_count || digestIds(events) !== pin.base_inventory_digest
    || bodies.length !== pin.base_body_count || digestIds(bodies) !== pin.base_body_digest
    || selections.length !== pin.base_selection_count || digestIds(selections) !== pin.base_selection_digest
    || logicalInventoryDigest(events, bodies, selections) !== pin.base_inventory) {
    console.error("refused: base pin evidence does not match its lists; take a new pin with pin-base"); process.exit(3);
  }
  return { events, bodies, selections };
}
async function loadOrCreatePin(o: Opts): Promise<Pin> {
  const path = pinPath(o);
  if (existsSync(path)) {
    const pin = JSON.parse(await readFile(path, "utf8"));
    if (!pin.base_snapshot || !pin.base_inventory) { console.error(`refused: base pin file has no base: ${path}`); process.exit(3); }
    return pin;
  }
  // Pin the whole logical inventory at one admitted snapshot. The
  // first inventory page names that snapshot; every list below is
  // pinned to it, so the three components describe one point in time.
  let firstPage: any;
  try { firstPage = await api(o, "/inventory?kind=events&limit=1000"); } catch (e: any) { console.error(`refused: cannot read the base pin from the server: ${e.code ? e.code + ": " : ""}${e.message ?? String(e)}`); process.exit(3); }
  const snapshot: string = firstPage.snapshot;
  const ids = await inventoryIds(o, snapshot);
  const bodies = await inventoryList(o, "bodies", snapshot);
  const selections = await inventoryList(o, "import_selections", snapshot);
  const pin: Pin = {
    base_snapshot: snapshot, base_inventory: logicalInventoryDigest(ids, bodies, selections),
    base_event_count: ids.length, base_inventory_digest: digestIds(ids),
    base_body_count: bodies.length, base_body_digest: digestIds(bodies),
    base_selection_count: selections.length, base_selection_digest: digestIds(selections),
    ...(markerServerId ? { server_id: markerServerId } : {}),
  };
  await mkdir(dirname(path), { recursive: true });
  await writeAtomic(pinIdsPath(path), ids.join("\n") + (ids.length ? "\n" : ""));
  await writeAtomic(pinBodiesPath(path), bodies.join("\n") + (bodies.length ? "\n" : ""));
  await writeAtomic(pinSelectionsPath(path), selections.join("\n") + (selections.length ? "\n" : ""));
  await writeAtomic(path, JSON.stringify(pin, null, 2) + "\n");
  return pin;
}

/** Process state and start ticks from /proc, or null where /proc is absent. */
async function procStat(pid: number): Promise<{ state: string; ticks: number | null } | null> {
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[19]);
    return { state: fields[0] ?? "", ticks: Number.isSafeInteger(ticks) ? ticks : null };
  } catch { return null; }
}
/** Process start ticks from /proc, or null where /proc is absent. */
async function procStartTicks(pid: number): Promise<number | null> {
  return (await procStat(pid))?.ticks ?? null;
}
/** True only when the recorded owner is the process that now holds the PID.
 * On Linux, state Z is a zombie. A signal probe still succeeds, and the
 * start tick still matches, but the process is dead. */
async function ownerLive(owner: any): Promise<boolean> {
  if (!owner || !Number.isInteger(owner.pid)) return false;
  let denied = false;
  try { process.kill(owner.pid, 0); } catch (e: any) {
    if (e?.code !== "EPERM") return false;
    denied = true;
  }
  const statInfo = await procStat(owner.pid);
  if (statInfo?.state === "Z") return false;
  if (denied) return true;
  const ticks = statInfo?.ticks ?? null;
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
interface LockHandle { release: () => Promise<void>; releaseSync: () => void; verify: () => Promise<boolean> }
/**
 * The lock is one file. Its content is the complete owner record.
 * A writer builds the record in a private temp file, then
 * publishes it with link. Link is atomic and fails when the lock
 * exists, so the lock never exists without its owner record,
 * and no writer can overwrite another owner's record. A writer
 * stopped before the link holds nothing. A writer stopped after
 * it leaves a complete record that recovery can judge.
 */
async function lock(o: Opts, opts?: { throwOnRefusal?: boolean }): Promise<LockHandle> {
  const refuseLock = (): never => {
    rmSync(`${join(o.state, "lock")}.tmp-${token}`, { force: true });
    if (opts?.throwOnRefusal) throw new Error("another write is in progress for this state folder");
    console.error("refused: another write is in progress for this state folder"); process.exit(3);
  };
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
          releaseSync: () => { try { const current = JSON.parse(readFileSync(lockPath, "utf8")); if (current?.token === token) rmSync(lockPath, { force: true }); } catch {} },
          // The holder checks its token at the lock path before it posts.
          // A writer whose lock was claimed stops. It never posts under
          // another writer's lock in normal operation.
          verify: async () => (await readOwner(lockPath))?.token === token,
        };
      }
      const judged = await readOwner(lockPath);
      // The lock file always holds a complete record. An unreadable
      // record is treated as a live lock, never as stale.
      if (!judged || (await ownerLive(judged))) refuseLock();
      await testPause();
      // Read the owner again after the wait. A changed token means a
      // peer recovered first. Do not rename in that case.
      const again = await readOwner(lockPath);
      if ((again?.token ?? null) !== (judged?.token ?? null)) continue;
      if (again && (await ownerLive(again))) continue;
      if (await claimStale(lockPath, token, judged?.token ?? null)) console.error("recovered stale lock from a stopped write");
    }
    refuseLock();
  } finally { await rm(tmp, { force: true }); }
  throw new Error("unreachable");
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
      requirePinServerId(pin);
      await readPinEvidence(pin, pinPath(o));
      console.log(`base_snapshot ${pin.base_snapshot}`);
      console.log(`base_inventory ${pin.base_inventory}`);
    } else if (cmd === "init") {
      if (!o.state) throw new Error("--state is required");
      await mkdir(o.state, { recursive: true });
      const p = join(o.state, "identity.json");
      if (existsSync(p)) {
        const j = await loadIdentity(o);
        // Backfill the base evidence from the pin for identities
        // that were created before capture required it. The
        // backfill runs the same checks as a new identity: the
        // pin evidence must be consistent, it must match this
        // identity's recorded base, and the server must hold
        // every pinned base ID.
        if (j.base_inventory_digest == null || j.base_event_count == null || j.base_body_digest == null || j.base_selection_digest == null) {
          const path = pinPath(o);
          if (!existsSync(path)) {
            console.error(`note: no base pin file at ${path}; this identity has no base evidence for capture`);
          } else {
            const pin = JSON.parse(await readFile(path, "utf8"));
            if (!pinHasEvidence(pin, path)) { console.error("refused: base pin file has no base evidence; a new base needs a new pin file"); process.exit(3); }
            requirePinServerId(pin);
            const lists = await readPinEvidence(pin, path);
            if ((j.base_snapshot && j.base_snapshot !== pin.base_snapshot) || (j.base_inventory && j.base_inventory !== pin.base_inventory)) {
              console.error("refused: base pin does not match this identity's recorded base; start a new state folder"); process.exit(3);
            }
            const serverEvents = new Set(await inventoryIds(o));
            const serverBodies = new Set(await inventoryList(o, "bodies"));
            const serverSelections = new Set(await inventoryList(o, "import_selections"));
            if (!lists.events.every((id) => serverEvents.has(id)) || !lists.bodies.every((h) => serverBodies.has(h)) || !lists.selections.every((s) => serverSelections.has(s))) {
              console.error("refused: base pin does not match this server; a new base needs a new pin file"); process.exit(3);
            }
            await refuseForeignEmptyPin(o, pin, lists);
            j.base_event_count = pin.base_event_count; j.base_inventory_digest = pin.base_inventory_digest;
            j.base_body_count = pin.base_body_count; j.base_body_digest = pin.base_body_digest;
            j.base_selection_count = pin.base_selection_count; j.base_selection_digest = pin.base_selection_digest;
            j.base_snapshot ??= pin.base_snapshot; j.base_inventory ??= pin.base_inventory;
            if (!validServerId(j.server_id)) j.server_id = pin.server_id;
            await writeAtomic(p, JSON.stringify(j, null, 2) + "\n", 0o600);
          }
        } else if (!validServerId(j.server_id)) {
          const path = pinPath(o);
          if (existsSync(path)) {
            const pin = JSON.parse(await readFile(path, "utf8"));
            requirePinServerId(pin);
            if (j.base_snapshot === pin.base_snapshot && j.base_inventory === pin.base_inventory) {
              j.server_id = pin.server_id;
              await writeAtomic(p, JSON.stringify(j, null, 2) + "\n", 0o600);
            }
          }
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
        requirePinServerId(pin);
        let serverIds: string[];
        try { serverIds = await inventoryIds(o); } catch (e: any) { console.error(`refused: cannot check the base pin against the server: ${e.code ? e.code + ": " : ""}${e.message ?? String(e)}`); process.exit(3); }
        const serverSet = new Set(serverIds);
        const lists = await readPinEvidence(pin, pinPath(o));
        if (!lists.events.every((id) => serverSet.has(id))) {
          console.error("refused: base pin does not match this server; a new base needs a new pin file"); process.exit(3);
        }
        await refuseForeignEmptyPin(o, pin, lists);
      }
      const seed = randomBytes(32); const identity = identityFromSeed(new Uint8Array(seed));
      const runId = requirePinServerId(pin);
      const rec: Identity = { seed: hex(new Uint8Array(seed)), identity, base_snapshot: pin.base_snapshot, base_inventory: pin.base_inventory, base_event_count: pin.base_event_count ?? null, base_inventory_digest: pin.base_inventory_digest, base_body_count: pin.base_body_count ?? null, base_body_digest: pin.base_body_digest, base_selection_count: pin.base_selection_count ?? null, base_selection_digest: pin.base_selection_digest, server_id: runId };
      await writeAtomic(p, JSON.stringify(rec, null, 2) + "\n", 0o600);
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
      const body = { name: flag(o, "name", "Synthetic view")!, description: rich(flag(o, "description")), roots, rafsi_threshold: { numerator: 1, denominator: 1 }, H: { numerator: 3, denominator: 1 }, alpha: { numerator: 1, denominator: 2 }, excluded: [], calculation: flag(o, "calculation", "simple-routes-bounds-v1")!, work: Number(flag(o, "work", "1000000")), import_sets: importSets(o), account_witnesses: [], account_authority: false, notes: [] };
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
/** One directory named two ways is one directory. The key is the
 * device and inode after symlink resolution. A relative path, an
 * absolute path, a symlink, and another spelling of that folder
 * collapse, so capture locks the folder once. A missing path stays
 * as its resolved spelling. */
async function distinctStateDirs(states: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const state of states) {
    let key = resolve(state);
    try {
      const info = await stat(state, { bigint: true });
      key = `${info.dev}:${info.ino}`;
    } catch { /* a missing path stays as given */ }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(state);
  }
  return out;
}
interface ImportSet { source: string; importer: string; selection: string }
/** Protocol order is UTF-8 byte order, the same order as a Rust string. */
function utf8Compare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
/** Repeated --import-set values. Each value is source|importer|selection.
 * The result is sorted and unique, as a view body requires. */
function importSets(o: Opts): ImportSet[] {
  const raw = o.multi.get("import-set") ?? [];
  const entries: ImportSet[] = [];
  for (const value of raw) {
    const parts = value.split("|");
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) { console.error("refused: --import-set must be source|importer|selection, and the source must not contain |"); process.exit(3); }
    const [source, importer, selection] = parts;
    if (!/^ed25519:[0-9a-f]{64}$/.test(importer) || !/^sha256:[0-9a-f]{64}$/.test(selection)) { console.error("refused: --import-set importer must be an ed25519 identity and selection must be a sha256 hash"); process.exit(3); }
    entries.push({ source, importer, selection });
  }
  entries.sort((a, b) => utf8Compare(a.source, b.source) || utf8Compare(a.importer, b.importer) || utf8Compare(a.selection, b.selection));
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1];
    if (prev.source === entries[i].source && prev.importer === entries[i].importer && prev.selection === entries[i].selection) { console.error("refused: --import-set values must be unique"); process.exit(3); }
  }
  return entries;
}
/**
 * Capture holds the write lock of every state folder it captures,
 * from before its first read until its files are complete. A kit
 * writer that starts during capture gets the normal lock refusal
 * and retries later. The exit handler releases the locks
 * synchronously when a refusal ends the process, and the finally
 * step releases them on success and on other errors.
 */
async function capture(o: Opts): Promise<void> {
  const states = await distinctStateDirs(o.multi.get("state") ?? []);
  o.multi.set("state", states);
  const handles: LockHandle[] = [];
  process.on("exit", () => { for (const h of handles) { try { h.releaseSync(); } catch {} } });
  try {
    for (const s of states) handles.push(await lock({ ...o, state: s }, { throwOnRefusal: true }));
  } catch (e: any) {
    for (const h of handles) await h.release();
    console.error(`refused: ${e.message ?? String(e)}`); process.exit(3);
  }
  try { await captureBody(o); }
  finally { for (const h of handles) await h.release(); }
}
async function captureBody(o: Opts): Promise<void> {
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
  if (!identities[0].base_inventory_digest || !Number.isInteger(identities[0].base_event_count)) { console.error("refused: identity has no base evidence; make a new pin and a new state folder"); process.exit(3); }
  // The full base proof needs the pin lists themselves, beside the
  // state folders (or at --pin). An identity record carries only the
  // digests, which cannot separate base bodies from captured ones.
  const capturePinPath = flag(o, "pin") ?? join(dirname(resolve(states[0])), "base-pin.json");
  if (!existsSync(capturePinPath)) { console.error(`refused: capture needs the base pin file with its full evidence lists (expected ${capturePinPath}); run pin-base for this run first`); process.exit(3); }
  const capturePin: Pin = JSON.parse(await readFile(capturePinPath, "utf8"));
  if (!pinHasEvidence(capturePin, capturePinPath)) { console.error("refused: base pin file has no full base evidence; take a new pin with pin-base"); process.exit(3); }
  requirePinServerId(capturePin);
  const pinLists = await readPinEvidence(capturePin, capturePinPath);
  if (capturePin.base_snapshot !== identities[0].base_snapshot || capturePin.base_inventory !== identities[0].base_inventory
    || identities.some((i) => i.base_body_digest !== capturePin.base_body_digest || i.base_selection_digest !== capturePin.base_selection_digest)) {
    console.error("refused: state folders do not match the base pin file; use the pin file of this run"); process.exit(3);
  }
  const allIds = await inventoryIds(o, sourceSnapshot);
  const allBodies = await inventoryList(o, "bodies", sourceSnapshot);
  const allSelections = await inventoryList(o, "import_selections", sourceSnapshot);
  const synthetic = new Set(transports.map((t) => t.envelope.id));
  const syntheticBodies = new Set<string>();
  for (const t of transports) { const h = t.envelope.header?.content?.hash; if (t.body != null && typeof h === "string") syntheticBodies.add(h); }
  const baseIds = allIds.filter((id) => !synthetic.has(id));
  if (baseIds.length !== identities[0].base_event_count || digestIds(baseIds) !== identities[0].base_inventory_digest) {
    console.error(`refused: capture base does not match the pin: derived base ${baseIds.length} events digest ${digestIds(baseIds)}, pin ${identities[0].base_event_count} events digest ${identities[0].base_inventory_digest}; a state folder may be missing, or a write landed during capture`);
    process.exit(3);
  }
  // Bodies and selections get the same proof as events. The expected
  // body set is the pinned base bodies plus the captured bodies; a
  // hash that both share is one set member, so this compare is exact.
  const expectedBodies = [...new Set([...pinLists.bodies, ...syntheticBodies])].sort();
  if (digestIds(allBodies) !== digestIds(expectedBodies)) {
    console.error(`refused: capture base bodies do not match the pin: server holds ${allBodies.length} bodies digest ${digestIds(allBodies)}, pin plus capture holds ${expectedBodies.length} digest ${digestIds(expectedBodies)}; a base body changed after the pin`);
    process.exit(3);
  }
  if (digestIds(allSelections) !== capturePin.base_selection_digest) {
    console.error(`refused: capture base import selections do not match the pin: server holds ${allSelections.length} selections digest ${digestIds(allSelections)}, pin holds ${capturePin.base_selection_count} digest ${capturePin.base_selection_digest}; a base selection changed after the pin`);
    process.exit(3);
  }
  // Read the admitted snapshot once more. If it moved, a writer is
  // still active and this capture would omit its event. Refuse and
  // write no capture files.
  const nowPage = await api(o, "/inventory?kind=events&limit=1");
  if (nowPage.snapshot !== sourceSnapshot) {
    console.error("refused: writers are still active (the admitted snapshot changed during capture); stop them and capture again");
    process.exit(3);
  }
  // Name the run before any capture file is written. A mismatch here
  // is a capture this kit would refuse on restore.
  const sourceId = runSourceId(capturePin, identities);
  await mkdir(outDir, { recursive: true });
  const lines = transports.map((t) => canonicalize(utf8(JSON.stringify(t))));
  const bytes = utf8(lines.join("\n") + (lines.length ? "\n" : ""));
  await writeFile(join(outDir, "events.jsonl"), bytes);
  const byKind: Record<string, number> = {}, byIssuer: Record<string, number> = {};
  for (const t of transports) { const k = t.envelope.header.action.kind; byKind[k] = (byKind[k] ?? 0) + 1; const iss = t.envelope.header.issuer; byIssuer[iss] = (byIssuer[iss] ?? 0) + 1; }
  let kit_revision = "unknown"; try { kit_revision = execFileSync("git", ["-C", resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch {}
  const manifest = {
    format: 1, capture_snapshot: sourceSnapshot, base_snapshot: identities[0].base_snapshot, base_inventory: identities[0].base_inventory, kit_revision,
    ...(sourceId ? { source_server_id: sourceId } : {}),
    identity_states: identities.map((identity) => ({ identity: identity.identity, base_snapshot: identity.base_snapshot, base_inventory: identity.base_inventory, ...(validServerId(identity.server_id) ? { server_id: identity.server_id } : {}) })),
    event_count: transports.length, by_kind: byKind, by_issuer: byIssuer, public_keys: identities.map((i) => i.identity),
    event_file_sha256: sha256(bytes), base_event_count: baseIds.length, base_inventory_digest: digestIds(baseIds),
    base_body_count: pinLists.bodies.length, base_body_digest: digestIds(pinLists.bodies),
    base_selection_count: pinLists.selections.length, base_selection_digest: digestIds(pinLists.selections),
    base_minus_captured_body_digest: digestIds(pinLists.bodies.filter((h) => !syntheticBodies.has(h))),
    expected_final_event_count: baseIds.length + transports.length, expected_final_inventory_digest: digestIds(allIds),
    expected_final_body_count: allBodies.length, expected_final_body_digest: digestIds(allBodies),
    expected_final_selection_count: allSelections.length, expected_final_selection_digest: digestIds(allSelections),
    expected_final_logical_inventory: logicalInventoryDigest(allIds, allBodies, allSelections),
  };
  await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const keys: Record<string, string> = {}; for (const i of identities) keys[i.identity] = i.seed;
  await writeFile(join(outDir, "keys.json"), JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 });
  console.log(`captured ${transports.length} events snapshot=${sourceSnapshot} sha256=${manifest.event_file_sha256}`);
}
async function inventoryList(o: Opts, kind: string, snapshot?: string): Promise<string[]> {
  const ids: string[] = []; let after: string | null = null;
  const snap = snapshot ? `&snapshot=${encodeURIComponent(snapshot)}` : "";
  for (;;) { const j: any = await api(o, `/inventory?kind=${kind}&limit=1000${snap}${after ? `&after=${encodeURIComponent(after)}` : ""}`); ids.push(...(j.ids ?? [])); if (!j.next) break; after = j.next; }
  return ids.sort();
}
async function inventoryIds(o: Opts, snapshot?: string): Promise<string[]> {
  return inventoryList(o, "events", snapshot);
}
async function restore(o: Opts, checkOnly: boolean): Promise<void> {
  const dir = flag(o, "capture"); if (!dir) { console.error("refused: --capture is required"); process.exit(2); }
  const fail = (reason: string): never => { if (checkOnly) console.log(`not reusable: ${reason}`); else console.error(`refused: ${reason}`); process.exit(3); };
  let manifest: any = {}; let bytes: Buffer = Buffer.alloc(0);
  const identityByKey = new Map<string, any>();
  try {
    manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
    bytes = await readFile(join(dir, "events.jsonl"));
  } catch (e: any) { fail(`capture cannot be read: ${e.message ?? String(e)}`); }
  if (!manifest.base_snapshot || !manifest.base_inventory || !Number.isInteger(manifest.base_event_count) || !manifest.base_inventory_digest || !Number.isInteger(manifest.expected_final_event_count) || !manifest.expected_final_inventory_digest || !manifest.event_file_sha256 || !Number.isInteger(manifest.event_count)
    || !Number.isInteger(manifest.base_body_count) || !manifest.base_body_digest || !Number.isInteger(manifest.base_selection_count) || !manifest.base_selection_digest || !manifest.base_minus_captured_body_digest
    || !Number.isInteger(manifest.expected_final_body_count) || !manifest.expected_final_body_digest || !Number.isInteger(manifest.expected_final_selection_count) || !manifest.expected_final_selection_digest || !manifest.expected_final_logical_inventory) fail(`capture manifest is missing a required field`);
  // Each captured identity states the manifest base and the source
  // id. One edited field is a mismatch. A capture with no such
  // records is from an older kit and must be captured again.
  if (!Array.isArray(manifest.identity_states))
    fail("capture has no identity records; capture it again with the current kit");
  const publicKeys = manifest.public_keys;
  if (!Array.isArray(publicKeys) || publicKeys.length !== manifest.identity_states.length || new Set(publicKeys).size !== publicKeys.length)
    fail("capture does not have one identity record for each captured identity; capture it again with the current kit");
  for (const state of manifest.identity_states) {
    const id = state?.identity;
    if (typeof id !== "string" || identityByKey.has(id))
      fail("capture does not have one identity record for each captured identity; capture it again with the current kit");
    identityByKey.set(id, state);
  }
  for (const key of publicKeys) {
    if (typeof key !== "string" || !identityByKey.has(key))
      fail("capture does not have one identity record for each captured identity; capture it again with the current kit");
  }
  if (!validServerId(manifest.source_server_id))
    fail("capture has no source server id; capture it again with the current kit");
  for (const state of manifest.identity_states) {
    if (state?.base_snapshot !== manifest.base_snapshot)
      fail("identity base_snapshot does not match the manifest base_snapshot");
    if (state?.base_inventory !== manifest.base_inventory)
      fail("identity base_inventory does not match the manifest base_inventory");
    if (state?.server_id !== manifest.source_server_id)
      fail("source server id does not match the captured identity base");
  }
  if (sha256(bytes) !== manifest.event_file_sha256) fail(`event file hash does not match manifest`);
  const lines = new TextDecoder().decode(bytes).trim().split("\n").filter(Boolean);
  if (lines.length !== manifest.event_count) fail(`event count ${lines.length} does not match manifest ${manifest.event_count}`);
  const transports = lines.map((l) => JSON.parse(l));
  const synthetic = new Set<string>(transports.map((t: any) => t.envelope.id));
  if (synthetic.size !== transports.length) fail(`capture holds a duplicate event id`);
  for (const t of transports) {
    if (!identityByKey.has(t.envelope?.header?.issuer))
      fail("capture does not have one identity record for each captured identity; capture it again with the current kit");
  }
  for (const t of transports) { try { const p = prepareAdmission(utf8(JSON.stringify(t))); if (!p.action_valid || p.body_status === "invalid") fail(`current code refuses event ${t.envelope?.id ?? "?"}: invalid action or body`); } catch (e: any) { fail(`current code refuses event ${t.envelope?.id ?? "?"}: ${e.message ?? String(e)}`); } }
  // Prove the whole logical inventory before any post: retained
  // events, bodies and import selections, each read at one pinned
  // admitted snapshot. Event IDs alone are not proof. The manifest
  // can lag behind the admitted inventory, so it never decides the
  // case. It only confirms a fresh copy, with a wait.
  const capturedBodies = new Set<string>();
  for (const t of transports) { const h = t.envelope.header?.content?.hash; if (t.body != null && typeof h === "string") capturedBodies.add(h); }
  let before: string[] = []; let beforeBodies: string[] = []; let beforeSelections: string[] = [];
  try {
    const firstPage = await api(o, "/inventory?kind=events&limit=1000");
    before = await inventoryIds(o, firstPage.snapshot);
    beforeBodies = await inventoryList(o, "bodies", firstPage.snapshot);
    beforeSelections = await inventoryList(o, "import_selections", firstPage.snapshot);
  } catch (e: any) { fail(`cannot read server inventory: ${e.code ? e.code + ": " : ""}${e.message ?? String(e)}`); }
  const beforeSet = new Set(before);
  const present = transports.filter((t: any) => beforeSet.has(t.envelope.id));
  let resumed = 0;
  {
    // Events outside the capture must be exactly the pinned base.
    // A wrong set is refused below. A matching digest does not
    // imply the manifest base count, so the count is checked too.
    const rest = before.filter((id) => !synthetic.has(id));
    const baseCountMismatch = rest.length !== manifest.base_event_count;
    if (digestIds(rest) !== manifest.base_inventory_digest) {
      if (present.length === transports.length && transports.length > 0)
        fail(`already restored inventory is not the pinned base plus the capture: ${before.length} events, expected ${manifest.expected_final_event_count}`);
      if (present.length > 0)
        fail(`partial restore does not hold the pinned base; refusing to write`);
      fail(`base inventory does not match the capture pin; refusing to write`);
    }
    if (baseCountMismatch)
      fail(`base event count does not match the capture pin: server holds ${rest.length} events outside the capture, manifest says ${manifest.base_event_count}; refusing to write`);
    // Bodies outside the capture must be exactly the pinned base
    // bodies that the capture does not itself carry. A captured body
    // may share its hash with a base body; the set difference keeps
    // that case repairable, while a missing or added base body
    // changes this digest.
    const restBodies = beforeBodies.filter((h) => !capturedBodies.has(h));
    if (digestIds(restBodies) !== manifest.base_minus_captured_body_digest)
      fail(`base bodies do not match the pin: server holds ${restBodies.length} non-captured bodies digest ${digestIds(restBodies)}, expected digest ${manifest.base_minus_captured_body_digest}; refusing to write`);
    if (digestIds(beforeSelections) !== manifest.base_selection_digest)
      fail(`base import selections do not match the pin: server holds ${beforeSelections.length} selections digest ${digestIds(beforeSelections)}, expected ${manifest.base_selection_count} digest ${manifest.base_selection_digest}; refusing to write`);
    resumed = present.length;
  }
  if (present.length === 0) {
    if (digestIds(before) !== manifest.base_inventory_digest)
      fail(`base inventory does not match the capture pin; refusing to write`);
    // A fresh target must match the pinned base in every component.
    // A missing base body is refused here even when a captured event
    // shares its hash. Repair of a missing captured body applies
    // only to a restore that already started on a correct base: the
    // partial and already-restored cases above.
    if (digestIds(beforeBodies) !== manifest.base_body_digest)
      fail(`base bodies do not match the pin: server holds ${beforeBodies.length} bodies digest ${digestIds(beforeBodies)}, expected ${manifest.base_body_count} digest ${manifest.base_body_digest}; refusing to write`);
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
    // Read the whole inventory again after the wait, at one pinned
    // snapshot. It must still be the pinned base before anything posts.
    let waitedIds: string[] = []; let waitedBodies: string[] = []; let waitedSelections: string[] = [];
    try {
      const waitedPage = await api(o, "/inventory?kind=events&limit=1000");
      waitedIds = await inventoryIds(o, waitedPage.snapshot);
      waitedBodies = await inventoryList(o, "bodies", waitedPage.snapshot);
      waitedSelections = await inventoryList(o, "import_selections", waitedPage.snapshot);
    } catch (e: any) { fail(`cannot read server inventory: ${e.code ? e.code + ": " : ""}${e.message ?? String(e)}`); }
    // This is the fresh case, so the waited body set must equal
    // the pinned base bodies exactly, as in the first fresh
    // check. The set-difference comparison belongs to the
    // partial and already-restored cases only. Name each
    // component that differs, with both counts and both digests.
    const changed: string[] = [];
    if (digestIds(waitedIds) !== manifest.base_inventory_digest)
      changed.push(`events: server holds ${waitedIds.length} digest ${digestIds(waitedIds)}, expected ${manifest.base_event_count} digest ${manifest.base_inventory_digest}`);
    if (digestIds(waitedBodies) !== manifest.base_body_digest)
      changed.push(`bodies: server holds ${waitedBodies.length} digest ${digestIds(waitedBodies)}, expected ${manifest.base_body_count} digest ${manifest.base_body_digest}`);
    if (digestIds(waitedSelections) !== manifest.base_selection_digest)
      changed.push(`import selections: server holds ${waitedSelections.length} digest ${digestIds(waitedSelections)}, expected ${manifest.base_selection_count} digest ${manifest.base_selection_digest}`);
    if (changed.length) fail(`inventory changed while waiting for the manifest: ${changed.join("; ")}; refusing to write`);
  }
  // Post every captured transport, not only the missing ones. A
  // repost is idempotent. It makes the server validate each captured
  // representation and supplies any body that an earlier admission
  // left out.
  for (const t of transports) { try { await api(o, "/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(t) }); } catch (e: any) { fail(`server refuses event ${t.envelope.id}: ${e.code ? e.code + ": " : ""}${e.message ?? String(e)}`); } }
  const afterPage = await api(o, "/inventory?kind=events&limit=1000");
  const afterIds = await inventoryIds(o, afterPage.snapshot);
  const afterBodies = await inventoryList(o, "bodies", afterPage.snapshot);
  const afterSelections = await inventoryList(o, "import_selections", afterPage.snapshot);
  if (afterIds.length !== manifest.expected_final_event_count || digestIds(afterIds) !== manifest.expected_final_inventory_digest)
    fail(`final inventory is not the pinned base plus the capture: ${afterIds.length} events, expected ${manifest.expected_final_event_count}`);
  if (afterBodies.length !== manifest.expected_final_body_count || digestIds(afterBodies) !== manifest.expected_final_body_digest)
    fail(`final bodies are not the pinned base plus the capture: ${afterBodies.length} bodies, expected ${manifest.expected_final_body_count}`);
  if (afterSelections.length !== manifest.expected_final_selection_count || digestIds(afterSelections) !== manifest.expected_final_selection_digest)
    fail(`final import selections are not the pinned base plus the capture: ${afterSelections.length} selections, expected ${manifest.expected_final_selection_count}`);
  if (logicalInventoryDigest(afterIds, afterBodies, afterSelections) !== manifest.expected_final_logical_inventory)
    fail(`final logical inventory is not the pinned base plus the capture`);
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
  if (!checkOnly && typeof manifest.source_server_id === "string" && /^[0-9a-f]{32}$/.test(manifest.source_server_id) && afterIds.length > 0) {
    const recorded = await rawFetch(o, o.server + "/synthetic-restored", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source_server_id: manifest.source_server_id, event_ids: afterIds }) });
    if (!recorded.ok) fail(`cannot record the proven copy on the target: ${await recorded.text()}`);
  }
  if (checkOnly) console.log("reusable");
  else console.log(`restored ${transports.length} events resumed=${resumed} inventory=${afterIds.length} digest=${digestIds(afterIds)}`);
}
main();
