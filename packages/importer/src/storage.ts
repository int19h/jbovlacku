import {
  access,
  link,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { openLedger, journalFromLedger, validateLedger } from "./ledger.ts";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { canonicalize, contentHash, utf8 } from "../../core/src/index.ts";
import {
  canonical,
  type CaptureManifest,
  type ImportResult,
  type Journal,
} from "./index.ts";

/** Protocol-owned JSON crosses the same strict parser as signed records. */
export function parseProtocolJson<T>(bytes: Uint8Array): T {
  return JSON.parse(canonicalize(bytes)) as T;
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function durableDirectory(path: string): Promise<void> {
  const firstCreated = await mkdir(path, { recursive: true });
  if (firstCreated === undefined) return;
  let current = path;
  while (true) {
    await syncDirectory(dirname(current));
    if (current === firstCreated) break;
    current = dirname(current);
  }
}

async function immutableFile(path: string, bytes: Uint8Array): Promise<void> {
  try {
    const existing = await readFile(path);
    if (!existing.equals(Buffer.from(bytes)))
      throw new Error(
        "The existing source archive bytes differ from the pinned artifact.",
      );
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${randomUUID()}.next`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", flush: true });
    // A hard link installs the complete file and refuses an existing hash path.
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await readFile(path)).equals(Buffer.from(bytes)))
        throw new Error(
          "The concurrent source archive bytes differ from the pinned artifact.",
        );
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

async function derivedFile(path: string, text: string): Promise<void> {
  const temporary = `${path}.next`;
  await writeFile(temporary, text);
  await rename(temporary, path);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function readJournal(
  output: string,
): Promise<Journal | undefined> {
  const sqlite = join(output, "journal.sqlite"),
    json = join(output, "journal.json");
  if (await exists(sqlite)) {
    if (await exists(json))
      throw new Error(
        "Both import journals exist. Resolve the two authorities through explicit recovery before another import.",
      );
    const db = new DatabaseSync(sqlite, { readOnly: true });
    try {
      const source = db
        .prepare("SELECT value FROM state WHERE key='source'")
        .get()?.value as string;
      const importer = db
        .prepare("SELECT value FROM state WHERE key='importer'")
        .get()?.value as string;
      if (new URL(source).origin !== source)
        throw new Error(
          "The ledger uses an old source namespace. Explicit recovery must preserve its signed bodies.",
        );
      const result = journalFromLedger(db, source, importer);
      result.ledger_run = Number(
        db.prepare("SELECT value FROM state WHERE key='run'").get()?.value ?? 0,
      );
      return result;
    } finally {
      db.close();
    }
  }
  if (await exists(json)) {
    const journal = parseProtocolJson<Journal>(await readFile(json));
    if (new URL(journal.source).origin !== journal.source)
      throw new Error(
        "The journal uses an old source namespace. Explicit recovery must preserve its signed bodies.",
      );
    journal.ledger_run = 0;
    return journal;
  }
  for (const name of [
    "carriers.jsonl",
    "selected-view.json",
    "proposal.json",
    "journal.json.next",
    "journal.json.migrated",
    "journal.sqlite-journal",
    "import-selection.json",
    "source-archive",
  ])
    if (await exists(join(output, name)))
      throw new Error(
        "The import journal is missing. Rebuild it from retained envelopes before another import.",
      );
  return undefined;
}

async function commitJournal(
  output: string,
  manifest: CaptureManifest,
  result: ImportResult,
): Promise<void> {
  const path = join(output, "journal.sqlite"),
    legacy = join(output, "journal.json");
  const priorExists = await exists(path),
    legacyExists = await exists(legacy);
  if (priorExists && legacyExists)
    throw new Error(
      "Both import journals exist. Resolve the two authorities through explicit recovery before another import.",
    );
  const db = openLedger(path, result.journal.source, result.journal.importer, {
    migrateLegacyJson: !priorExists && legacyExists,
  });
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      validateLedger(db, result.journal.source, result.journal.importer);
      const currentRun = Number(
        db.prepare("SELECT value FROM state WHERE key='run'").get()?.value ?? 0,
      );
      if (currentRun !== (result.journal.ledger_run ?? 0))
        throw new Error(
          "The shared ledger changed after this proposal was read. Rebuild the stale proposal before publication.",
        );
      const retained = new Map(
        result.carriers.map((carrier) => [
          carrier.envelope.id,
          canonical(carrier),
        ]),
      );
      for (const row of db
        .prepare(
          "SELECT event,carrier FROM versions UNION ALL SELECT event,carrier FROM views",
        )
        .iterate())
        if (retained.get(row.event as string) !== row.carrier)
          throw new Error(
            "The proposal omits or changes a retained signed carrier.",
          );
      if (legacyExists) {
        const legacyJournal = parseProtocolJson<Journal>(
          await readFile(legacy),
        );
        for (const entry of Object.values(legacyJournal.entries)) {
          for (const version of entry.versions)
            if (
              retained.get(version.carrier.envelope.id) !==
              canonical(version.carrier)
            )
              throw new Error(
                "The migration omits or changes a retained signed carrier.",
              );
          for (const observation of entry.observations) {
            const recovered = db
              .prepare(
                "INSERT INTO batches(snapshot,manifest,report,view,selection) VALUES(?,?,?,?,?)",
              )
              .run(
                observation.snapshot,
                canonical({
                  recovered_from: "journal.json",
                  snapshot: observation.snapshot,
                }),
                canonical({ recovered: true }),
                null,
                null,
              );
            const recoveredRun = Number(recovered.lastInsertRowid);
            const record = entry.versions[0].carrier.body.legacy.record.id;
            db.prepare("INSERT INTO observations VALUES(?,?,?,?,?,?)").run(
              recoveredRun,
              record,
              observation.snapshot,
              observation.lexical_digest,
              observation.publication,
              observation.disposition,
            );
            db.prepare("INSERT INTO observation_details VALUES(?,?,?)").run(
              recoveredRun,
              record,
              canonical(observation),
            );
          }
        }
        for (const view of legacyJournal.views)
          if (retained.get(view.envelope.id) !== canonical(view))
            throw new Error(
              "The migration omits or changes a retained signed view.",
            );
      }
      const batch = db
        .prepare(
          "INSERT INTO batches(snapshot,manifest,report,view,selection) VALUES(?,?,?,?,?)",
        )
        .run(
          manifest.sha256,
          canonical(manifest),
          canonical(result.report),
          result.view.envelope.id,
          result.selection.canonical,
        );
      const run = Number(batch.lastInsertRowid);
      for (const [record, entry] of Object.entries(result.journal.entries)) {
        for (const version of entry.versions)
          db.prepare(
            "INSERT INTO versions VALUES(?,?,?,?,?) ON CONFLICT(event) DO UPDATE SET digest=excluded.digest,lexical=excluded.lexical",
          ).run(
            Number(record),
            version.digest,
            canonical(version.lexical),
            canonical(version.carrier),
            version.carrier.envelope.id,
          );
        db.prepare("INSERT OR REPLACE INTO entries VALUES(?,?,?)").run(
          Number(record),
          entry.selected,
          canonical(entry.baseline),
        );
        const oldCount = Number(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM observations WHERE record=?",
            )
            .get(Number(record))!.count,
        );
        // Each REST run retains the exact raw observation and its field coverage.
        const observation = entry.observations.at(-1);
        if (observation && entry.observations.length > oldCount) {
          db.prepare("INSERT INTO observations VALUES(?,?,?,?,?,?)").run(
            run,
            Number(record),
            observation.snapshot,
            observation.lexical_digest,
            observation.publication,
            observation.disposition,
          );
          db.prepare("INSERT INTO observation_details VALUES(?,?,?)").run(
            run,
            Number(record),
            canonical(observation),
          );
        }
      }
      for (const view of result.journal.views)
        db.prepare("INSERT OR IGNORE INTO views VALUES(?,?,?)").run(
          view.envelope.id,
          canonical(view.body),
          canonical(view),
        );
      for (const [key, value] of [
        ["head", result.journal.head!],
        ["view", result.view.envelope.id],
        ["snapshot", manifest.sha256],
        ["run", String(run)],
      ])
        db.prepare("INSERT OR REPLACE INTO state VALUES(?,?)").run(key, value);
      validateLedger(db, result.journal.source, result.journal.importer);
      db.exec("COMMIT");
      result.journal.ledger_run = run;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
  if (legacyExists) await rename(legacy, join(output, "journal.json.migrated"));
  await syncDirectory(output);
}

export type PublicationCheckpoint =
  | "source-durable"
  | "journal-durable"
  | "carriers-written";

/** Save source evidence, commit the journal, then replace rebuildable output files. */
export async function publishProposal(
  output: string,
  sourceBytes: Uint8Array,
  manifest: CaptureManifest,
  result: ImportResult,
  checkpoint?: (stage: PublicationCheckpoint) => Promise<void>,
): Promise<void> {
  if (contentHash(sourceBytes) !== manifest.sha256)
    throw new Error("The archived source bytes do not match the manifest.");
  if (result.journal.source !== manifest.source)
    throw new Error(
      "The proposal journal and source manifest name different sources.",
    );
  await durableDirectory(output);
  await syncDirectory(dirname(output));
  const archive = join(output, "source-archive");
  await durableDirectory(archive);
  await syncDirectory(output);
  await immutableFile(
    join(archive, `${manifest.sha256.slice(7)}.json`),
    sourceBytes,
  );
  const manifestBytes = utf8(canonical(manifest));
  await immutableFile(
    join(
      archive,
      `${manifest.sha256.slice(7)}.${contentHash(manifestBytes).slice(7)}.manifest.json`,
    ),
    manifestBytes,
  );
  await syncDirectory(archive);
  await checkpoint?.("source-durable");

  await commitJournal(output, manifest, result);
  await checkpoint?.("journal-durable");

  await derivedFile(
    join(output, "carriers.jsonl"),
    result.carriers.map((carrier) => canonical(carrier) + "\n").join(""),
  );
  await checkpoint?.("carriers-written");
  await derivedFile(
    join(output, "import-selection.json"),
    result.selection.canonical,
  );
  await derivedFile(join(output, "selected-view.json"), canonical(result.view));
  await derivedFile(
    join(output, "proposal.json"),
    canonical({
      source: manifest.source,
      importer: result.journal.importer,
      selected_view: result.view.envelope.id,
      import_selection: result.selection.hash,
      report: result.report,
    }),
  );
}
