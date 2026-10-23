import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalize,
  contentHash,
  prepareAdmission,
  utf8,
} from "../../core/src/index.ts";
import {
  canonical,
  type Carrier,
  type Journal,
  type Lexical,
} from "./index.ts";

export const LEDGER_FORMAT = "jbovlacku-import-ledger-v1";
const parse = <T>(text: string): T => JSON.parse(canonicalize(utf8(text))) as T;
const digest = (value: unknown) => contentHash(utf8(canonical(value)));

/** Both extraction paths retain the same envelopes and signed frontier. */
function initializeRuns(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(batches)").all();
  const legacy =
    columns.length > 0 && !columns.some((column) => column.name === "run");
  if (legacy)
    db.exec(
      "ALTER TABLE batches RENAME TO batches_v1; ALTER TABLE observations RENAME TO observations_v1;",
    );
  db.exec(
    "CREATE TABLE IF NOT EXISTS batches(run INTEGER PRIMARY KEY AUTOINCREMENT,snapshot TEXT,manifest TEXT,report TEXT,view TEXT,selection TEXT); CREATE INDEX IF NOT EXISTS batch_snapshots ON batches(snapshot,run); CREATE TABLE IF NOT EXISTS observations(run INTEGER,record INTEGER,snapshot TEXT,digest TEXT,event TEXT,disposition TEXT,PRIMARY KEY(run,record)); CREATE TABLE IF NOT EXISTS observation_details(run INTEGER,record INTEGER,details TEXT,PRIMARY KEY(run,record));",
  );
  if (legacy) {
    for (const batch of db
      .prepare("SELECT * FROM batches_v1 ORDER BY rowid")
      .all()) {
      const run = db
        .prepare(
          "INSERT INTO batches(snapshot,manifest,report,view,selection) VALUES(?,?,?,?,?)",
        )
        .run(
          batch.snapshot,
          batch.manifest,
          batch.report,
          batch.view,
          batch.selection,
        ).lastInsertRowid;
      db.prepare(
        "INSERT INTO observations SELECT ?,record,snapshot,digest,event,disposition FROM observations_v1 WHERE snapshot=?",
      ).run(run, batch.snapshot);
      const snapshot = db
        .prepare("SELECT value FROM state WHERE key='snapshot'")
        .get()?.value;
      if (batch.snapshot === snapshot)
        db.prepare("INSERT OR REPLACE INTO state VALUES('run',?)").run(
          String(run),
        );
    }
  }
}

export function openLedger(
  path: string,
  source: string,
  importer: string,
  options: { migrateLegacyJson?: boolean } = {},
): DatabaseSync {
  if (
    !existsSync(path) &&
    existsSync(join(dirname(path), "journal.json.migrated"))
  )
    throw new Error(
      "The import journal is missing. Recover the retained migrated journal before another import.",
    );
  if (
    existsSync(join(dirname(path), "journal.json")) &&
    !options.migrateLegacyJson
  )
    throw new Error(
      "An active JSON journal exists. Migrate it through the REST importer or resolve both authorities through explicit recovery.",
    );
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=-8192; CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      const stored = db
        .prepare("SELECT value FROM state WHERE key='source'")
        .get();
      if (stored && stored.value !== source)
        throw new Error(
          "The ledger source differs. Old source namespaces require explicit recovery without rewriting signed bodies.",
        );
      const oldFormat = db
        .prepare("SELECT value FROM state WHERE key='format'")
        .get()?.value;
      if (oldFormat === "jbovlacku-sql-import-journal-v1")
        db.prepare("UPDATE state SET value=? WHERE key='format'").run(
          LEDGER_FORMAT,
        );
      for (const [key, value] of [
        ["format", LEDGER_FORMAT],
        ["source", source],
        ["importer", importer],
      ]) {
        db.prepare("INSERT OR IGNORE INTO state VALUES(?,?)").run(key, value);
        if (
          db.prepare("SELECT value FROM state WHERE key=?").get(key)?.value !==
          value
        )
          throw new Error(
            "The ledger belongs to another format, source, or importer.",
          );
      }
      db.exec(
        "CREATE TABLE IF NOT EXISTS versions(record INTEGER,digest TEXT,lexical TEXT,carrier TEXT,event TEXT PRIMARY KEY); CREATE INDEX IF NOT EXISTS versions_record ON versions(record,digest); CREATE TABLE IF NOT EXISTS entries(record INTEGER PRIMARY KEY,selected TEXT,baseline TEXT); CREATE TABLE IF NOT EXISTS views(event TEXT PRIMARY KEY,body TEXT,carrier TEXT); CREATE TABLE IF NOT EXISTS unresolved(snapshot TEXT,record INTEGER,locator TEXT,reason TEXT);",
      );
      initializeRuns(db);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function validateLedger(
  db: DatabaseSync,
  source: string,
  importer: string,
): void {
  for (const [key, value] of [
    ["format", LEDGER_FORMAT],
    ["source", source],
    ["importer", importer],
  ])
    if (
      db.prepare("SELECT value FROM state WHERE key=?").get(key)?.value !==
      value
    )
      throw new Error(
        "The ledger belongs to another format, source, or importer.",
      );
  const ids = new Set<string>(),
    previous: string[] = [];
  for (const item of db
    .prepare(
      "SELECT record,digest,lexical,carrier,event,NULL AS view_body FROM versions UNION ALL SELECT NULL,NULL,NULL,carrier,event,body FROM views",
    )
    .iterate()) {
    const text = item.carrier as string,
      carrier = parse<Carrier>(text);
    const admission = prepareAdmission(utf8(text));
    if (
      !admission.action_valid ||
      admission.body_status !== "present" ||
      carrier.envelope.header.issuer !== importer ||
      carrier.envelope.id !== item.event ||
      canonical(carrier) !== text
    )
      throw new Error("The ledger contains an invalid signed carrier.");
    ids.add(carrier.envelope.id);
    previous.push(...carrier.envelope.header.previous);
    if (item.record !== null) {
      if (
        digest(parse(item.lexical as string)) !== item.digest ||
        carrier.body.legacy?.source !== source ||
        carrier.body.legacy?.record?.id !== item.record ||
        carrier.envelope.header.action.kind !== "definition.publish"
      )
        throw new Error(
          "The ledger source record or lexical digest is inconsistent.",
        );
    } else if (
      carrier.envelope.header.action.kind !== "view.publish" ||
      item.view_body !== canonical(carrier.body)
    )
      throw new Error("The ledger contains an invalid view record.");
  }
  if (previous.some((id) => !ids.has(id)))
    throw new Error("The ledger lacks a retained predecessor envelope.");
  const head = db
    .prepare("SELECT value FROM state WHERE key='head'")
    .get()?.value;
  const predecessors = new Set(previous),
    maxima = [...ids].filter((id) => !predecessors.has(id));
  if (
    maxima.length !== (ids.size ? 1 : 0) ||
    (maxima.length && maxima[0] !== head)
  )
    throw new Error(
      "The ledger head does not name its complete signed frontier.",
    );
  if (
    db
      .prepare(
        "SELECT entries.record FROM entries LEFT JOIN versions ON entries.selected=versions.event WHERE versions.event IS NULL OR entries.record<>versions.record LIMIT 1",
      )
      .get()
  )
    throw new Error("The ledger selection lacks its original source envelope.");
}

/** SQL can carry a richer extraction while REST leaves omitted fields unknown. */
export function normalizeLexical(lexical: Lexical, carrier: Carrier): Lexical {
  const value = structuredClone(lexical);
  if ("known" in value.language) {
    const language = value.language.known as any;
    if (!language || typeof language !== "object" || !("source_id" in language))
      value.language = {
        known: { source_id: language, tag: carrier.body.language },
      };
  }
  return value;
}

export function journalFromLedger(
  db: DatabaseSync,
  source: string,
  importer: string,
): Journal {
  validateLedger(db, source, importer);
  const journal: Journal = {
    format: "jbovlacku-import-journal-v1",
    source,
    importer,
    head:
      (db.prepare("SELECT value FROM state WHERE key='head'").get()
        ?.value as string) ?? null,
    entries: {},
    views: [],
  };
  for (const row of db
    .prepare("SELECT * FROM entries ORDER BY record")
    .iterate()) {
    const versions = db
      .prepare("SELECT * FROM versions WHERE record=? ORDER BY rowid")
      .all(row.record)
      .map((version) => {
        const carrier = parse<Carrier>(version.carrier as string);
        const lexical = normalizeLexical(
          parse<Lexical>(version.lexical as string),
          carrier,
        );
        return { lexical, digest: digest(lexical), carrier };
      });
    const selected = versions.find(
      (version) => version.carrier.envelope.id === row.selected,
    )!;
    journal.entries[String(row.record)] = {
      selected: row.selected as string,
      baseline: normalizeLexical(
        parse<Lexical>(row.baseline as string),
        selected.carrier,
      ),
      versions,
      observations: db
        .prepare(
          "SELECT observations.*,observation_details.details FROM observations LEFT JOIN observation_details USING(run,record) WHERE record=? ORDER BY run",
        )
        .all(row.record)
        .map((observation) =>
          observation.details
            ? parse(observation.details as string)
            : {
                snapshot: observation.snapshot as string,
                lexical_digest: observation.digest as string,
                coverage: [],
                publication: observation.event as string,
                disposition: observation.disposition as string,
                original: null,
              },
        ),
    };
  }
  journal.views = db
    .prepare("SELECT carrier FROM views ORDER BY rowid")
    .all()
    .map((row) => parse<Carrier>(row.carrier as string));
  return journal;
}
