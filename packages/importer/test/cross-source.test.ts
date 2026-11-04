import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { contentHash, initializeCore, utf8 } from "../../core/src/index.ts";
import {
  canonical,
  importCapture,
  type CaptureManifest,
} from "../src/index.ts";
import { importSqlSnapshot } from "../src/sql.ts";
import { publishProposal, readJournal } from "../src/storage.ts";

const directories: string[] = [];
const seed = new Uint8Array(32).fill(42);
after(async () => {
  for (const path of directories)
    await rm(path, { recursive: true, force: true });
});
before(async () => {
  await initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "jvc-cross-source-"));
  directories.push(root);
  const sourcePath = join(root, "source.sql"),
    manifestPath = join(root, "manifest.json"),
    output = join(root, "proposal");
  const bytes = await readFile(
    new URL("../fixtures/lensisku-sql-sample.sql", import.meta.url),
  );
  const manifest = JSON.parse(
    await readFile(
      new URL("../fixtures/lensisku-sql-sample.manifest.json", import.meta.url),
      "utf8",
    ),
  );
  await writeFile(sourcePath, bytes);
  await writeFile(manifestPath, canonical(manifest));
  const captureBytes = await readFile(
    new URL("../fixtures/lensisku-sample.json", import.meta.url),
  );
  const rows = JSON.parse(captureBytes.toString()).definitions.slice(0, 1);
  const captureManifest: CaptureManifest = JSON.parse(
    await readFile(
      new URL("../fixtures/lensisku-sample.manifest.json", import.meta.url),
      "utf8",
    ),
  );
  const restBytes = utf8(JSON.stringify({ definitions: rows }));
  const restManifest = {
    ...captureManifest,
    expected_rows: 1,
    sha256: contentHash(restBytes),
  };
  return {
    root,
    sourcePath,
    manifestPath,
    output,
    restBytes,
    restManifest,
    rows,
  };
}
async function rest(
  f: Awaited<ReturnType<typeof fixture>>,
  bytes = f.restBytes,
  manifest = f.restManifest,
) {
  const result = importCapture({
    sourceBytes: bytes,
    manifest,
    seed,
    roots: [],
    journal: await readJournal(f.output),
  });
  await publishProposal(f.output, bytes, manifest, result);
  return result;
}

test("SQL then compatible REST share one source record and retained signed history", async () => {
  const f = await fixture();
  const sql = await importSqlSnapshot({ ...f, seed, roots: [] });
  const journal = await readJournal(f.output);
  assert.ok(journal, "REST must read the SQL ledger");
  const original = journal.entries["4"].selected;
  const result = await rest(f);
  assert.equal(result.report.added, 0);
  assert.equal(result.report.revised, 0);
  assert.equal(result.journal.entries["4"].selected, original);
  assert.equal(result.journal.entries["4"].versions.length, 1);
  assert.equal(result.journal.source, "https://lensisku.lojban.org");
  assert.ok(
    result.carriers.some((carrier) => carrier.envelope.id === sql.view),
  );
});

test("REST then SQL enrich one record without another publication", async () => {
  const f = await fixture();
  const first = await rest(f);
  const original = first.journal.entries["4"].selected;
  const sql = await importSqlSnapshot({ ...f, seed, roots: [] });
  const journal = (await readJournal(f.output))!;
  assert.equal(sql.report.added, 3);
  assert.equal(sql.report.revised, 0);
  assert.equal(journal.entries["4"].selected, original);
  assert.equal(journal.entries["4"].versions.length, 1);
  assert.ok("known" in journal.entries["4"].baseline.place_keyword_indices);
});

test("known REST edits parent the SQL publication and share the signed frontier", async () => {
  const f = await fixture();
  await importSqlSnapshot({ ...f, seed, roots: [] });
  const prior = (await readJournal(f.output))!;
  f.rows[0].definition = "A changed source definition.";
  const bytes = utf8(JSON.stringify({ definitions: f.rows }));
  const result = await rest(f, bytes, {
    ...f.restManifest,
    sha256: contentHash(bytes),
  });
  assert.equal(result.report.revised, 1);
  const carrier = result.journal.entries["4"].versions.at(-1)!.carrier;
  assert.deepEqual(carrier.envelope.header.action.parents, [
    prior.entries["4"].selected,
  ]);
  assert.deepEqual(carrier.envelope.header.previous, [prior.head]);
});

test("a stale REST proposal cannot replace a later shared ledger selection", async () => {
  const f = await fixture();
  await rest(f);
  const stale = importCapture({
    sourceBytes: f.restBytes,
    manifest: f.restManifest,
    seed,
    roots: [],
    journal: await readJournal(f.output),
  });
  await importSqlSnapshot({ ...f, seed, roots: [] });
  await assert.rejects(
    publishProposal(f.output, f.restBytes, f.restManifest, stale),
    /changed|stale/i,
  );
  assert.equal(Object.keys((await readJournal(f.output))!.entries).length, 4);
});

test("REST rejects a broken shared signed frontier", async () => {
  const f = await fixture();
  await rest(f);
  const db = new DatabaseSync(join(f.output, "journal.sqlite"));
  db.prepare("UPDATE state SET value=? WHERE key='head'").run(
    "jve1:" + "0".repeat(64),
  );
  db.close();
  await assert.rejects(readJournal(f.output), /head|frontier/i);
});

test("canonical JSON journals migrate with every retained envelope and observation", async () => {
  const f = await fixture();
  const first = importCapture({
    sourceBytes: f.restBytes,
    manifest: f.restManifest,
    seed,
    roots: [],
  });
  f.rows[0].definition = "A historical revision.";
  const bytes = utf8(JSON.stringify({ definitions: f.rows }));
  const second = importCapture({
    sourceBytes: bytes,
    manifest: { ...f.restManifest, sha256: contentHash(bytes) },
    seed,
    roots: [],
    journal: first.journal,
  });
  const { mkdir } = await import("node:fs/promises");
  await mkdir(f.output);
  await writeFile(join(f.output, "journal.json"), canonical(second.journal));
  const migrated = await rest(f);
  const stored = (await readJournal(f.output))!;
  assert.equal(stored.entries["4"].versions.length, 2);
  assert.equal(stored.entries["4"].observations.length, 3);
  assert.equal(
    stored.entries["4"].selected,
    first.journal.entries["4"].selected,
  );
  for (const carrier of second.carriers)
    assert.ok(
      migrated.carriers.some(
        (retained) => canonical(retained) === canonical(carrier),
      ),
    );
  await assert.rejects(readFile(join(f.output, "journal.json")), {
    code: "ENOENT",
  });
  assert.equal(
    await readFile(join(f.output, "journal.json.migrated"), "utf8"),
    canonical(second.journal),
  );
});

test("two active journal authorities require explicit recovery", async () => {
  const f = await fixture();
  const first = await rest(f);
  await writeFile(join(f.output, "journal.json"), canonical(first.journal));
  await assert.rejects(readJournal(f.output), /Both import journals/);
  await assert.rejects(
    publishProposal(f.output, f.restBytes, f.restManifest, first),
    /Both import journals/,
  );
});

test("an old SQL source namespace requires recovery without rewriting signed bodies", async () => {
  const f = await fixture();
  await rest(f);
  const db = new DatabaseSync(join(f.output, "journal.sqlite"));
  db.prepare("UPDATE state SET value=? WHERE key='source'").run(
    "https://lensisku.lojban.org/source/sql-snapshot",
  );
  db.close();
  await assert.rejects(readJournal(f.output), /old source namespace/);
});

test("repeat persisted REST runs retain separate observations and original batches", async () => {
  const f = await fixture();
  await rest(f);
  await rest(f);
  const stored = (await readJournal(f.output))!;
  assert.equal(stored.entries["4"].observations.length, 2);
  assert.equal(stored.entries["4"].observations[1].disposition, "reused");
  const db = new DatabaseSync(join(f.output, "journal.sqlite"), {
    readOnly: true,
  });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM batches").get()!.count,
    2,
  );
  assert.deepEqual(
    db
      .prepare("SELECT disposition FROM observations ORDER BY run")
      .all()
      .map((row) => row.disposition),
    ["added", "reused"],
  );
  db.close();
});

test("the shared ledger rejects retained events with a missing predecessor", async () => {
  const f = await fixture();
  await rest(f);
  const db = new DatabaseSync(join(f.output, "journal.sqlite"));
  db.prepare("DELETE FROM versions WHERE record=4").run();
  db.close();
  await assert.rejects(readJournal(f.output), /predecessor/);
});

test("a later observation invalidates stale proposals even when the signed head stays unchanged", async () => {
  const f = await fixture();
  await rest(f);
  const prior = (await readJournal(f.output))!;
  const stale = importCapture({
    sourceBytes: f.restBytes,
    manifest: f.restManifest,
    seed,
    roots: [],
    journal: prior,
  });
  await rest(f);
  assert.equal((await readJournal(f.output))!.head, prior.head);
  await assert.rejects(
    publishProposal(f.output, f.restBytes, f.restManifest, stale),
    /changed.*stale|stale.*changed/i,
  );
  assert.equal(
    (await readJournal(f.output))!.entries["4"].observations.length,
    2,
  );
});

test("a new REST revision leaves SQL-only index evidence unknown in its own body and observation", async () => {
  const f = await fixture();
  await importSqlSnapshot({ ...f, seed, roots: [] });
  f.rows[0].definition = "New REST source text with no index evidence.";
  const bytes = utf8(JSON.stringify({ definitions: f.rows }));
  const result = await rest(f, bytes, {
    ...f.restManifest,
    sha256: contentHash(bytes),
  });
  const entry = result.journal.entries["4"],
    latest = entry.versions.at(-1)!;
  assert.deepEqual(latest.lexical.place_keyword_indices, { unknown: true });
  assert.equal(
    entry.observations.at(-1)!.coverage.includes("place_keyword_indices"),
    false,
  );
  assert.equal(
    Object.hasOwn(latest.carrier.body.legacy.original, "keywordmapping"),
    false,
  );
});

test("REST revisions return to the latest retained parent in the same context", async () => {
  const f = await fixture();
  const first = await rest(f);
  f.rows[0].valsiword = "cadzu";
  let bytes = utf8(JSON.stringify({ definitions: f.rows }));
  await rest(f, bytes, { ...f.restManifest, sha256: contentHash(bytes) });
  f.rows[0].valsiword = "bajra";
  f.rows[0].definition = "A changed definition in the original word context.";
  bytes = utf8(JSON.stringify({ definitions: f.rows }));
  const final = await rest(f, bytes, {
    ...f.restManifest,
    sha256: contentHash(bytes),
  });
  assert.deepEqual(
    final.journal.entries["4"].versions.at(-1)!.carrier.envelope.header.action
      .parents,
    [first.journal.entries["4"].selected],
  );
});

test("a context return parents the latest observed reversion instead of the last created version", async () => {
  const f = await fixture();
  const first = await rest(f);
  const originalText = f.rows[0].definition;
  const change = async (text: string, word = "bajra") => {
    f.rows[0].definition = text;
    f.rows[0].valsiword = word;
    const bytes = utf8(JSON.stringify({ definitions: f.rows }));
    return rest(f, bytes, { ...f.restManifest, sha256: contentHash(bytes) });
  };
  await change("An intermediate version.");
  await change(originalText);
  await change("A version in another word context.", "cadzu");
  const result = await change(
    "A new version after returning to the first context.",
  );
  assert.deepEqual(
    result.journal.entries["4"].versions.at(-1)!.carrier.envelope.header.action
      .parents,
    [first.journal.entries["4"].selected],
  );
});

test("known REST gloss words without per-keyword languages do not invent a SQL language revision", async () => {
  const f = await fixture();
  f.rows[0].gloss_keywords = [{ word: "run", meaning: null }];
  const bytes = utf8(JSON.stringify({ definitions: f.rows }));
  const manifest = {
    ...f.restManifest,
    sha256: contentHash(bytes),
    unavailable_fields: f.restManifest.unavailable_fields.filter(
      (field) => field !== "gloss_keywords",
    ),
  };
  const first = await rest(f, bytes, manifest);
  const sql = await importSqlSnapshot({ ...f, seed, roots: [] });
  assert.equal(sql.report.revised, 0);
  assert.equal(
    (await readJournal(f.output))!.entries["4"].selected,
    first.journal.entries["4"].selected,
  );
});

test("a retained migrated JSON journal blocks a fresh ledger after SQLite loss", async () => {
  const f = await fixture();
  const first = importCapture({
    sourceBytes: f.restBytes,
    manifest: f.restManifest,
    seed,
    roots: [],
  });
  const { mkdir } = await import("node:fs/promises");
  await mkdir(f.output);
  await writeFile(
    join(f.output, "journal.json.migrated"),
    canonical(first.journal),
  );
  await assert.rejects(readJournal(f.output), /journal is missing/);
  await assert.rejects(
    importSqlSnapshot({ ...f, seed, roots: [] }),
    /journal is missing/,
  );
});

test("SQL rejects a second active JSON authority beside the shared ledger", async () => {
  const f = await fixture();
  const first = await rest(f);
  await writeFile(join(f.output, "journal.json"), canonical(first.journal));
  await assert.rejects(
    importSqlSnapshot({ ...f, seed, roots: [] }),
    /JSON journal|authorities/,
  );
});

test("observation lookups use a record-first index on fresh and reopened ledgers", async () => {
  const f = await fixture();
  const result = await rest(f);
  const { openLedger } = await import("../src/ledger.ts");
  let db = new DatabaseSync(join(f.output, "journal.sqlite"));
  const plans = () =>
    [
      "SELECT * FROM observations WHERE record=? ORDER BY run",
      "SELECT observations.*,observation_details.details FROM observations LEFT JOIN observation_details USING(run,record) WHERE record=? ORDER BY run",
      "SELECT event FROM observations WHERE record=? ORDER BY run DESC",
    ].map((sql) =>
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(4)
        .map((row) => row.detail)
        .join("\n"),
    );
  assert.deepEqual(
    db
      .prepare("PRAGMA index_info(observations_record)")
      .all()
      .map((row) => row.name),
    ["record", "run"],
  );
  for (const plan of plans())
    assert.match(
      plan,
      /SEARCH observations USING (?:COVERING )?INDEX observations_record/,
    );
  db.exec("DROP INDEX observations_record");
  db.close();
  db = openLedger(
    join(f.output, "journal.sqlite"),
    result.journal.source,
    result.journal.importer,
  );
  for (const plan of plans())
    assert.match(
      plan,
      /SEARCH observations USING (?:COVERING )?INDEX observations_record/,
    );
  db.close();
});

test("REST commits count retained observations in one grouped query", async (context) => {
  const f = await fixture();
  await rest(f);
  const result = importCapture({
    sourceBytes: f.restBytes,
    manifest: f.restManifest,
    seed,
    roots: [],
    journal: await readJournal(f.output),
  });
  const queries: string[] = [];
  const original = DatabaseSync.prototype.prepare;
  context.mock.method(
    DatabaseSync.prototype,
    "prepare",
    function (this: DatabaseSync, sql: string) {
      queries.push(sql);
      return original.call(this, sql);
    },
  );
  await publishProposal(f.output, f.restBytes, f.restManifest, result);
  assert.equal(
    queries.filter((sql) =>
      /SELECT COUNT\(\*\).*FROM observations WHERE record/i.test(sql),
    ).length,
    0,
  );
  assert.equal(
    queries.filter((sql) => /FROM observations GROUP BY record/i.test(sql))
      .length,
    1,
  );
});

test("default ledger reads stay read only and explicit metadata migration installs the record index", async () => {
  const f = await fixture();
  const original = await rest(f);
  let db = new DatabaseSync(join(f.output, "journal.sqlite"));
  db.exec("DROP INDEX observations_record");
  db.close();
  assert.equal((await readJournal(f.output))!.head, original.journal.head);
  db = new DatabaseSync(join(f.output, "journal.sqlite"), { readOnly: true });
  assert.equal(
    db
      .prepare("PRAGMA index_list(observations)")
      .all()
      .some((row) => row.name === "observations_record"),
    false,
  );
  db.close();
  assert.equal(
    (await readJournal(f.output, { migrateMetadata: true }))!.head,
    original.journal.head,
  );
  db = new DatabaseSync(join(f.output, "journal.sqlite"), { readOnly: true });
  assert.deepEqual(
    db
      .prepare("PRAGMA index_info(observations_record)")
      .all()
      .map((row) => row.name),
    ["record", "run"],
  );
  db.close();
});

test("new REST observations reference the exact archive instead of copying derived viewer values", async () => {
  const f = await fixture();
  f.rows[0].embedding = [0.1, 0.2];
  f.rows[0].user_vote = 1;
  const bytes = utf8(JSON.stringify({ definitions: f.rows }));
  const manifest = { ...f.restManifest, sha256: contentHash(bytes) };
  const result = await rest(f, bytes, manifest);
  const observation = (await readJournal(f.output))!.entries[
    "4"
  ].observations.at(-1)!;
  assert.deepEqual(observation.original, {
    archive: manifest.sha256,
    locator: "definitions/definitionid=4",
  });
  assert.equal(observation.extraction, "lensisku-list-fidelity-v3");
  assert.deepEqual(
    await readFile(
      join(f.output, "source-archive", `${manifest.sha256.slice(7)}.json`),
    ),
    Buffer.from(bytes),
  );
  assert.equal(
    Object.hasOwn(
      result.journal.entries["4"].versions[0].carrier.body.legacy.original,
      "embedding",
    ),
    false,
  );
});

test("REST and SQL rafsi retain separate evidence through a shared journal", async () => {
  const f = await fixture();
  const sql = await importSqlSnapshot({ ...f, seed, roots: [] });
  const before = (await readJournal(f.output))!;
  const wordClaims = before.rafsi_claims!.filter(
    (item) => item.body.rafsi === "baj",
  );
  assert.equal(wordClaims.length, 1);
  f.rows[0].official_rafsi = "baj";
  const bytes = utf8(JSON.stringify({ definitions: f.rows }));
  const result = await rest(f, bytes, {
    ...f.restManifest,
    sha256: contentHash(bytes),
    unavailable_fields: f.restManifest.unavailable_fields.filter(
      (field) => field !== "official_rafsi",
    ),
  });
  const claims = result.journal.rafsi_claims!.filter(
    (item) => item.body.rafsi === "baj",
  );
  assert.equal(claims.length, 2);
  assert.deepEqual(
    new Set(claims.map((item) => item.body.legacy.record.kind)),
    new Set(["word", "definition"]),
  );
  assert.equal(
    claims[0].envelope.header.action.assignment,
    claims[1].envelope.header.action.assignment,
  );
  assert.notEqual(claims[0].body.legacy.locator, claims[1].body.legacy.locator);
  assert.ok(
    result.carriers.some(
      (item) => canonical(item) === canonical(wordClaims[0]),
    ),
  );
  const repeated = await importSqlSnapshot({ ...f, seed, roots: [] });
  const after = (await readJournal(f.output))!;
  for (const claim of claims)
    assert.ok(
      after.rafsi_claims!.some((item) => canonical(item) === canonical(claim)),
    );
  assert.ok(repeated.report.fidelity.official_rafsi_claims > 0);
  assert.ok(sql.report.fidelity.official_rafsi_claims > 0);
});

test("SQL claim planning includes retained upgrade selections and excludes replaced ones", async () => {
  for (const scenario of ["absent", "replaced", "invalid"]) {
    const f = await fixture();
    f.rows[0].official_rafsi = "baj bajr";
    const bytes = utf8(JSON.stringify({ definitions: f.rows }));
    const manifest = { ...f.restManifest, sha256: contentHash(bytes) };
    const legacy = importCapture({
      sourceBytes: bytes,
      manifest,
      seed,
      roots: [],
    });
    // Earlier journals kept known rafsi without separate claim publications.
    const entry = legacy.journal.entries["4"];
    entry.baseline.official_rafsi = entry.versions[0].lexical.official_rafsi = {
      known: ["baj", "bajr"],
    };
    entry.versions[0].digest = contentHash(
      utf8(canonical(entry.versions[0].lexical)),
    );
    await publishProposal(f.output, bytes, manifest, legacy);
    const before = (await readJournal(f.output))!;
    assert.equal(before.rafsi_claims?.length ?? 0, 0);
    let inDefinitions = false;
    let sql = (await readFile(f.sourcePath, "utf8"))
      .split("\r\n")
      .filter((line) => {
        if (line.startsWith("COPY "))
          inDefinitions = line.startsWith("COPY public.definitions ");
        if (line === "\\.") inDefinitions = false;
        return (
          scenario !== "absent" || !inDefinitions || line.split("\t")[3] !== "4"
        );
      })
      .map((line) => {
        if (line.startsWith("COPY "))
          inDefinitions = line.startsWith("COPY public.definitions ");
        if (line === "\\.") inDefinitions = false;
        if (
          scenario === "invalid" &&
          inDefinitions &&
          line.split("\t")[3] === "4"
        ) {
          const fields = line.split("\t");
          fields[25] = "már";
          return fields.join("\t");
        }
        return line;
      })
      .join("\r\n");
    if (scenario === "replaced") sql = sql.replace("\tbaj bajr\t", "\tbaj\t");
    const source = Buffer.from(sql);
    const sqlManifest = JSON.parse(await readFile(f.manifestPath, "utf8"));
    sqlManifest.sha256 = contentHash(source);
    sqlManifest.bytes = source.length;
    if (scenario === "absent") sqlManifest.expected_rows.definitions = 3;
    await writeFile(f.sourcePath, source);
    await writeFile(f.manifestPath, canonical(sqlManifest));
    const result = await importSqlSnapshot({ ...f, seed, roots: [] });
    const after = (await readJournal(f.output))!;
    const growth =
      after.rafsi_claims!.length - (before.rafsi_claims?.length ?? 0);
    assert.equal(growth, scenario === "replaced" ? 4 : 5, scenario);
    assert.equal(result.size_estimate.new_rafsi_claim_count, growth, scenario);
    assert.equal(
      result.size_estimate.new_publication_count,
      result.report.added + result.report.revised,
      scenario,
    );
    if (scenario === "absent") assert.equal(result.report.unresolved.length, 0);
    if (scenario === "invalid")
      assert.deepEqual(
        result.report.unresolved.map((issue) => issue.record),
        [4],
      );
    const repeated = await importSqlSnapshot({ ...f, seed, roots: [] });
    assert.equal(repeated.size_estimate.new_rafsi_claim_count, 0);
    assert.equal(
      (await readJournal(f.output))!.rafsi_claims!.length,
      after.rafsi_claims!.length,
    );
  }
});
