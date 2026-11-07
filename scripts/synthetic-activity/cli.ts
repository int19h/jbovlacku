/**
 * Generate synthetic local activity for measurement and tests.
 * Each identity is a disposable Ed25519 key in a state folder.
 * Writes go to a local server over HTTP and use its normal event
 * admission path. No store file is written by this tool.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readFile as rf } from "node:fs/promises";
import {
  initializeCore, identityFromSeed, createEvent, wordId, canonicalize,
  contentHash, utf8, prepareAdmission,
} from "../../packages/core/src/index.ts";

const sha256 = (b: Uint8Array | string) => "sha256:" + createHash("sha256").update(b as never).digest("hex");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const short = (id: string) => id.length > 20 ? id.slice(0, 13) + "…" + id.slice(-6) : id;
const plain = (rt: unknown): string => Array.isArray(rt) ? rt.map(plain).join("") : typeof rt === "string" ? rt : typeof rt === "number" ? "" : "";

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
    else if (a === "--limit") limit = Number(argv[++i]);
    else if (a.startsWith("--")) { const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true"; flags.set(a.slice(2), v); const l = multi.get(a.slice(2)) ?? []; l.push(v); multi.set(a.slice(2), l); }
    else args.push(a);
  }
  return { server: server.replace(/\/$/, ""), state, view, full, limit, args, flags, multi };
}
const flag = (o: Opts, n: string, d?: string) => o.flags.get(n) ?? d;
async function api(o: Opts, path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(o.server + "/api/v1" + path, init);
  const t = await r.text();
  let j: any; try { j = JSON.parse(t); } catch { j = { message: t }; }
  if (!r.ok) { const e: any = new Error(j.message ?? t); e.code = j.code; e.status = r.status; e.payload = j; throw e; }
  return j;
}
const refused = (e: any): never => { console.error(`refused: ${e.code ? e.code + ": " : ""}${e.message ?? String(e)}`); process.exit(3); };

interface Identity { seed: string; identity: string; base_snapshot: string; base_inventory: string }
async function loadIdentity(o: Opts): Promise<Identity> {
  if (!o.state) { console.error("refused: --state is required"); process.exit(2); }
  return JSON.parse(await readFile(join(o.state, "identity.json"), "utf8"));
}
async function lock(o: Opts): Promise<() => Promise<void>> {
  const dir = join(o.state, "lock");
  try { await mkdir(dir); } catch { console.error(`refused: another write is in progress for this state folder`); process.exit(3); }
  return async () => rm(dir, { recursive: true, force: true });
}
async function heads(o: Opts, identity: string): Promise<string[]> {
  const j = await api(o, `/identity-heads/${encodeURIComponent(identity)}?limit=64`);
  return j.heads ?? [];
}
async function writeEvent(o: Opts, action: Record<string, unknown>, body: unknown | null): Promise<void> {
  const idn = await loadIdentity(o); const release = await lock(o);
  try {
    const seed = unhex(idn.seed);
    const prev = await heads(o, idn.identity);
    const nonce = hex(randomBytes(16));
    let ev: any;
    ev = createEvent(seed, prev, nonce, action, body);
    const started = Date.now();
    const r = await api(o, "/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ev) });
    console.log(`accepted ${r.id ?? ev.envelope.id} admission=${r.admission ?? "accepted"} snapshot=${short(r.snapshot ?? "")} ms=${Date.now() - started}`);
  } finally { await release(); }
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
  await initializeCore(await rf(new URL("../../packages/core/generated/jvc_runtime_bg.wasm", import.meta.url)));
  const o = parse(process.argv.slice(2));
  const [cmd, ...rest] = o.args;
  try {
    if (cmd === "init") {
      if (!o.state) throw new Error("--state is required");
      await mkdir(o.state, { recursive: true });
      const p = join(o.state, "identity.json");
      if (existsSync(p)) { const j = JSON.parse(await readFile(p, "utf8")); console.log(`identity ${j.identity}`); return; }
      const seed = randomBytes(32); const identity = identityFromSeed(new Uint8Array(seed));
      let base_snapshot = "", base_inventory = "";
      try { const m = await api(o, "/manifest"); base_snapshot = m.snapshot; base_inventory = m.logical_inventory ?? m.snapshot; } catch {}
      const rec: Identity = { seed: hex(new Uint8Array(seed)), identity, base_snapshot, base_inventory };
      await writeFile(p, JSON.stringify(rec, null, 2) + "\n", { mode: 0o600 });
      console.log(`identity ${identity}`); console.log(`state ${resolve(o.state)}`);
    } else if (cmd === "whoami") { const j = await loadIdentity(o); console.log(j.identity); }
    else if (cmd === "search") {
      const q = rest.join(" "); const v = o.view ? `&view=${encodeURIComponent(o.view)}` : "";
      const j = await api(o, `/search?q=${encodeURIComponent(q)}&language=${encodeURIComponent(flag(o, "language", "en")!)}&limit=${o.limit}${v}`);
      if (o.full) { console.log(JSON.stringify(j, null, 2)); return; }
      for (const h of (j.hits ?? []).slice(0, o.limit)) console.log(`${h.event ?? h.id ?? ""} ${h.word?.spelling ?? h.spelling ?? ""} ${plain(h.text ?? h.plain_text ?? "").slice(0, 120)}`);
      if (!(j.hits ?? []).length) console.log("no hits");
    } else if (cmd === "show") {
      const spelling = rest.join(" "); const wid = wordId({ language: "jbo", spelling });
      const v = o.view ? `?view=${encodeURIComponent(o.view)}` : "";
      const j = await api(o, `/words/${wid}${v}`);
      if (o.full) { console.log(JSON.stringify(j, null, 2)); return; }
      console.log(`word ${spelling} ${wid}`);
      if (j.word) console.log(`spelling ${j.word.spelling ?? spelling}`);
      for (const id of (j.definitions ?? [])) {
        const env = await api(o, `/events/${encodeURIComponent(id)}`);
        let text = "", issuer = env.header?.issuer ?? "";
        if (env.header?.content) { try { const b = await api(o, `/bodies/${encodeURIComponent(env.header.content.hash)}`); text = plain(b.text); } catch {} }
        const score = (j.scores ?? []).find((s: any) => s.target === id);
        console.log(`${short(id)} by ${short(issuer)} ${text.slice(0, 160)}`);
        if (score) console.log(`  score support=${JSON.stringify(score.support)} opposition=${JSON.stringify(score.opposition)} reviewers=${score.direct_reviewers ?? "?"}`);
      }
      for (const a of (j.assignments ?? [])) console.log(`rafsi ${a.id} status=${a.status} claims=${(a.claims ?? []).join(",")}`);
      for (const s of (j.scores ?? []).filter((s: any) => !(j.definitions ?? []).includes(s.target))) console.log(`target ${short(s.target)} support=${JSON.stringify(s.support)} opposition=${JSON.stringify(s.opposition)}`);
      if (!(j.definitions ?? []).length) console.log("no definitions");
    } else if (cmd === "recent") {
      const j = await api(o, `/changes?limit=${o.limit}`);
      for (const it of (j.items ?? [])) { let kind = "?"; try { const e = await api(o, `/events/${encodeURIComponent(it.id)}`); kind = e.header?.action?.kind ?? "?"; } catch {} console.log(`${it.cursor} ${short(it.id)} ${kind}`); }
    } else if (cmd === "history") {
      const idn = await loadIdentity(o); const target = flag(o, "identity", idn.identity)!;
      const j = await api(o, `/identities/${encodeURIComponent(target)}/activity?accepted=1&limit=${o.limit}`);
      for (const it of (j.items ?? [])) console.log(`${short(it.id)} ${it.action?.kind ?? "?"} ${JSON.stringify(it.action ?? {}).slice(0, o.full ? 500 : 120)}`);
      if (!(j.items ?? []).length) console.log("no actions");
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
    else { console.error("usage: init|whoami|search|show|recent|history|define|rafsi|judge|trust|status|profile|report|view|merge|capture|restore|reuse-check (see README)"); process.exit(2); }
  } catch (e: any) { if (cmd && ["define","rafsi","judge","trust","status","profile","report","view","merge"].includes(cmd)) refused(e); console.error(`error: ${e.code ? e.code + ": " : ""}${e.message ?? String(e)}`); process.exit(1); }
}

async function collectSynthetic(o: Opts, states: string[]): Promise<{ transports: any[]; identities: Identity[] }> {
  const identities: Identity[] = [];
  for (const s of [...new Set(states)]) identities.push(JSON.parse(await readFile(join(s, "identity.json"), "utf8")));
  const byId = new Map<string, any>();
  for (const idn of identities) {
    let after: string | null = null;
    for (;;) {
      const j: any = await api(o, `/identities/${encodeURIComponent(idn.identity)}/activity?accepted=1&limit=200${after ? `&after=${encodeURIComponent(after)}` : ""}`);
      for (const it of (j.items ?? [])) {
        const env = await api(o, `/events/${encodeURIComponent(it.id)}`);
        let body = null;
        if (env.header?.content) body = await api(o, `/bodies/${encodeURIComponent(env.header.content.hash)}`);
        byId.set(it.id, { envelope: env, body });
      }
      if (!j.next) break; after = j.next;
    }
  }
  // topological order by own predecessors
  const out: any[] = []; const done = new Set<string>(); const pending = new Map(byId);
  while (pending.size) { let progress = false; for (const [id, t] of pending) { const prev: string[] = t.envelope.header.previous ?? []; if (prev.every((p) => !byId.has(p) || done.has(p))) { out.push(t); done.add(id); pending.delete(id); progress = true; } } if (!progress) throw new Error("synthetic events have an unresolved predecessor cycle"); }
  return { transports: out, identities };
}
async function capture(o: Opts): Promise<void> {
  const outDir = flag(o, "out"); if (!outDir) { console.error("refused: --out is required"); process.exit(2); }
  const states = o.multi.get("state") ?? []; if (!states.length) { console.error("refused: --state is required (repeat for each identity)"); process.exit(2); }
  const { transports, identities: rawIdentities } = await collectSynthetic(o, states);
  const identities = rawIdentities.filter((v, i, a) => a.findIndex((x) => x.identity === v.identity) === i);
  const bases = new Set(identities.map((i) => i.base_snapshot)); if (bases.size > 1) { console.error("refused: state folders do not share one base snapshot"); process.exit(3); }
  await mkdir(outDir, { recursive: true });
  const lines = transports.map((t) => canonicalize(utf8(JSON.stringify(t))));
  const bytes = utf8(lines.join("\n") + (lines.length ? "\n" : ""));
  await writeFile(join(outDir, "events.jsonl"), bytes);
  const byKind: Record<string, number> = {}, byIssuer: Record<string, number> = {};
  for (const t of transports) { const k = t.envelope.header.action.kind; byKind[k] = (byKind[k] ?? 0) + 1; const iss = t.envelope.header.issuer; byIssuer[iss] = (byIssuer[iss] ?? 0) + 1; }
  let kit_revision = "unknown"; try { kit_revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch {}
  const manifest = { format: 1, base_snapshot: identities[0].base_snapshot, base_inventory: identities[0].base_inventory, kit_revision, event_count: transports.length, by_kind: byKind, by_issuer: byIssuer, public_keys: identities.map((i) => i.identity), event_file_sha256: sha256(bytes) };
  await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const keys: Record<string, string> = {}; for (const i of identities) keys[i.identity] = i.seed;
  await writeFile(join(outDir, "keys.json"), JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 });
  console.log(`captured ${transports.length} events sha256=${manifest.event_file_sha256}`);
}
async function inventoryIds(o: Opts): Promise<string[]> {
  const ids: string[] = []; let after: string | null = null;
  for (;;) { const j: any = await api(o, `/inventory?kind=events&limit=1000${after ? `&after=${encodeURIComponent(after)}` : ""}`); ids.push(...(j.ids ?? [])); if (!j.next) break; after = j.next; }
  return ids.sort();
}
async function restore(o: Opts, checkOnly: boolean): Promise<void> {
  const dir = flag(o, "capture"); if (!dir) { console.error("refused: --capture is required"); process.exit(2); }
  const fail = (reason: string): never => { if (checkOnly) console.log(`not reusable: ${reason}`); else console.error(`refused: ${reason}`); process.exit(3); };
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  const bytes = await readFile(join(dir, "events.jsonl"));
  if (sha256(bytes) !== manifest.event_file_sha256) fail(`event file hash does not match manifest`);
  const lines = new TextDecoder().decode(bytes).trim().split("\n").filter(Boolean);
  if (lines.length !== manifest.event_count) fail(`event count ${lines.length} does not match manifest ${manifest.event_count}`);
  const transports = lines.map((l) => JSON.parse(l));
  for (const t of transports) { try { const p = prepareAdmission(utf8(JSON.stringify(t))); if (!p.action_valid || p.body_status === "invalid") fail(`current code refuses event ${t.envelope?.id ?? "?"}: invalid action or body`); } catch (e: any) { fail(`current code refuses event ${t.envelope?.id ?? "?"}: ${e.message ?? String(e)}`); } }
  let before: string[] = [];
  try { const m = await api(o, "/manifest"); before = await inventoryIds(o); const synthetic = new Set(transports.map((t: any) => t.envelope.id)); const already = synthetic.size && [...synthetic].every((id) => before.includes(id)); if (m.snapshot !== manifest.base_snapshot && !already) fail(`base snapshot mismatch: server ${m.snapshot} capture base ${manifest.base_snapshot}`); } catch (e: any) { if ((e as any).exit) throw e; fail(`cannot read server manifest: ${e.message ?? String(e)}`); }
  for (const t of transports) { try { await api(o, "/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(t) }); } catch (e: any) { fail(`server refuses event ${t.envelope.id}: ${e.code ? e.code + ": " : ""}${e.message ?? String(e)}`); } }
  const afterIds = await inventoryIds(o);
  const expected = [...new Set([...before, ...transports.map((t: any) => t.envelope.id)])].sort();
  const digest = (ids: string[]) => sha256(ids.join("\n"));
  if (digest(afterIds) !== digest(expected)) fail(`final inventory digest does not match expected digest`);
  if (checkOnly) console.log("reusable");
  else console.log(`restored ${transports.length} events inventory=${afterIds.length} digest=${digest(afterIds)}`);
}
main();
