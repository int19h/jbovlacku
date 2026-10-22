import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  contentHash,
  createEvent,
  identityFromSeed,
  prepareAdmission,
  prepareSelection,
  utf8,
  wordId,
} from "../../core/src/index.ts";
import { canonical, type Carrier, type ImportOptions } from "./index.ts";
import { parseProtocolJson, syncDirectory } from "./storage.ts";
import { encodeOriginal, parseSourceJson } from "./source-json.ts";
import { hashFile, readCopyRows, type CopyRow } from "./sql-copy.ts";

export const SQL_EXTRACTION = "lensisku-sql-literal-v1";
export const SQL_SOURCE = "https://lensisku.lojban.org/source/sql-snapshot";
export const SQL_ACCOUNT_ORIGIN = "https://lensisku.lojban.org";
export interface SqlManifest {
  source: string;
  url: string;
  account_origin: string;
  retrieved_at: string;
  sha256: string;
  bytes: number;
  extraction: typeof SQL_EXTRACTION;
  recipe: "lensisku-sql-copy-v1";
  expected_rows: Record<string, number>;
  notes: string[];
}
interface Unresolved {
  record: number | null;
  locator: string;
  reason: string;
}
export interface SqlReport {
  source_rows: number;
  added: number;
  revised: number;
  reused: number;
  reverted: number;
  enriched: number;
  duplicates: number;
  conflicts: number[];
  incomplete: boolean;
  unresolved: Unresolved[];
  unresolved_by_reason: Record<string, number>;
  omitted: number[];
  notices: string[];
  table_rows: Record<string, number>;
  declared_rows: Record<string, number>;
  languages: Record<string, number>;
}
export interface SqlImportOptions {
  sourcePath: string;
  manifestPath: string;
  output: string;
  seed: Uint8Array;
  roots: ImportOptions["roots"];
  /** This test hook runs after durable state changes. */
  checkpoint?: (
    stage: "source-durable" | "journal-durable" | "carriers-written",
  ) => Promise<void>;
  estimate?: (value: {
    stage_bytes: number;
    estimated_total_bytes: number;
    definition_rows: number;
  }) => void;
}
const TABLES = new Set([
  "languages",
  "valsitypes",
  "valsi",
  "definitions",
  "definition_versions",
  "natlangwords",
  "keywordmapping",
  "natlangwordbestplaces",
  "etymology",
  "example",
]);
const FIELDS = [
  "word",
  "language",
  "text",
  "notes",
  "etymology",
  "classification",
  "labels",
  "glosses",
  "place_keywords",
  "place_keyword_indices",
  "official_rafsi",
  "experimental_rafsi",
] as const;
type Lexical = Record<
  (typeof FIELDS)[number],
  { known: unknown } | { unknown: true }
>;
type Row = Record<string, any>;
const numeric = new Set([
  "langid",
  "valsiid",
  "typeid",
  "userid",
  "time",
  "source_langid",
  "cached_source_langid",
  "cached_typeid",
  "definitionnum",
  "definitionid",
  "version_id",
  "definition_id",
  "user_id",
  "mw_revid",
  "wordid",
  "meaningnum",
  "natlangwordid",
  "place",
  "score",
  "etymologyid",
  "exampleid",
  "examplenum",
]);
const bools = new Set(["owner_only"]);
const jsonFields = new Set(["metadata", "gloss_keywords", "place_keywords"]);
const known = (value: unknown) => ({ known: value });
const digest = (value: unknown) => contentHash(utf8(canonical(value)));
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const text = (value: unknown): string | null => {
  if (value === null) return null;
  if (typeof value !== "string")
    throw new Error("A source text field must contain a string or null.");
  return value;
};
const integer = (value: any, positive = true): number => {
  const token = value?.$source_number;
  if (typeof token !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(token))
    throw new Error("A source integer field lacks an exact integer token.");
  const result = Number(token);
  if (!Number.isSafeInteger(result) || (positive && result <= 0))
    throw new Error("A source integer is outside the supported range.");
  return result;
};
const literal = (value: string | null) =>
  value === null || value === "" ? [] : [[value]];
const sorted = <T>(items: T[]) =>
  items.sort((a, b) =>
    Buffer.compare(Buffer.from(canonical(a)), Buffer.from(canonical(b))),
  );
const tokens = (value: unknown) =>
  [
    ...new Set((text(value) ?? "").split(/[\t\n\r\f\v ]+/).filter(Boolean)),
  ].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

/** Read the pinned archive manifest without treating TOML as executable input. */
export function parseSqlManifest(
  bytes: Uint8Array,
  sourcePath: string,
): SqlManifest {
  const input = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (input.trimStart().startsWith("{"))
    return parseProtocolJson<SqlManifest>(bytes);
  const required = (pattern: RegExp) => {
    const match = pattern.exec(input);
    if (!match)
      throw new Error("The SQL archive manifest lacks a required field.");
    return match[1];
  };
  const counts: Record<string, number> = {};
  const section = required(/\[coverage\.counts\]([^]*?)(?=\n\[|$)/);
  for (const line of section.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^"([a-z_]+)"\s*=\s*(\d+)\s*$/.exec(line);
    if (!match)
      throw new Error(
        "The SQL archive manifest contains an unsupported count.",
      );
    counts[match[1]] = Number(match[2]);
  }
  return {
    source: SQL_SOURCE,
    url: `file://${resolve(sourcePath)}`,
    account_origin: SQL_ACCOUNT_ORIGIN,
    retrieved_at: required(/^fetched_at\s*=\s*(\S+)\s*$/m),
    sha256: `sha256:${required(/^sha256\s*=\s*"([0-9a-f]{64})"\s*$/m)}`,
    bytes: Number(required(/^bytes\s*=\s*(\d+)\s*$/m)),
    extraction: SQL_EXTRACTION,
    recipe: "lensisku-sql-copy-v1",
    expected_rows: counts,
    notes: [required(/^notes\s*=\s*"(.*)"\s*$/m)],
  };
}

function originalRow(row: CopyRow): Row {
  const result: Row = Object.create(null);
  for (let i = 0; i < row.columns.length; i++) {
    const key = row.columns[i];
    const value = row.values[i];
    if (value === null) result[key] = null;
    else if (numeric.has(key)) {
      if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(value))
        throw new Error(
          `The numeric SQL column ${key} contains an invalid number token.`,
        );
      result[key] = { $source_number: value };
    } else if (bools.has(key)) {
      if (value !== "t" && value !== "f")
        throw new Error(`The SQL boolean ${key} is invalid.`);
      result[key] = value === "t";
    } else if (jsonFields.has(key))
      result[key] = encodeOriginal(parseSourceJson(value));
    else result[key] = value;
  }
  return result;
}

function report(): SqlReport {
  return {
    source_rows: 0,
    added: 0,
    revised: 0,
    reused: 0,
    reverted: 0,
    enriched: 0,
    duplicates: 0,
    conflicts: [],
    incomplete: false,
    unresolved: [],
    unresolved_by_reason: {},
    omitted: [],
    notices: [],
    table_rows: {},
    declared_rows: {},
    languages: {},
  };
}
function unresolved(
  report: SqlReport,
  record: number | null,
  locator: string,
  reason: string,
) {
  report.incomplete = true;
  report.unresolved.push({ record, locator, reason });
  report.unresolved_by_reason[reason] =
    (report.unresolved_by_reason[reason] ?? 0) + 1;
}

function initializeStage(db: DatabaseSync) {
  db.exec(
    "PRAGMA journal_mode=DELETE; PRAGMA synchronous=OFF; PRAGMA cache_size=-16384; PRAGMA temp_store=FILE; CREATE TABLE rows (table_name TEXT, source_id INTEGER, owner INTEGER, language INTEGER, position INTEGER, data TEXT); CREATE INDEX by_id ON rows(table_name,source_id); CREATE INDEX by_owner ON rows(table_name,owner,language);",
  );
}
const stageId = (table: string, row: Row) => {
  const key = (
    {
      languages: "langid",
      valsitypes: "typeid",
      valsi: "valsiid",
      definitions: "definitionid",
      definition_versions: "version_id",
      natlangwords: "wordid",
      keywordmapping: "natlangwordid",
      natlangwordbestplaces: "wordid",
      etymology: "etymologyid",
      example: "exampleid",
    } as Record<string, string>
  )[table];
  return integer(row[key], false);
};
function ownerId(table: string, row: Row): number {
  const key = (
    {
      definition_versions: "definition_id",
      keywordmapping: "definitionid",
      natlangwordbestplaces: "definitionid",
      etymology: "valsiid",
      example: "definitionid",
    } as Record<string, string>
  )[table];
  return key ? integer(row[key], false) : 0;
}
async function stageSource(path: string, db: DatabaseSync, output: SqlReport) {
  initializeStage(db);
  const insert = db.prepare("INSERT INTO rows VALUES(?,?,?,?,?,?)");
  db.exec("BEGIN");
  let count = 0;
  const nonlexical = new Set<number>();
  try {
    for await (const copy of readCopyRows(path, TABLES, (table, rows) => {
      output.table_rows[table] = rows;
    })) {
      const locator = `${copy.table}/COPY-row=${copy.row}/line=${copy.line}`;
      let id: number | null = null;
      try {
        if (copy.error) throw new Error(copy.error);
        const row = originalRow(copy);
        id = stageId(copy.table, row);
        if (copy.table === "definitions") {
          const word = getRows(
            db,
            "valsi",
            "source_id",
            integer(row.valsiid),
          )[0];
          const type =
            word &&
            getRows(
              db,
              "valsitypes",
              "source_id",
              integer(word.typeid, false),
            )[0];
          if (type && ["wiki", "phrase", "nalvla"].includes(type.descriptor))
            nonlexical.add(id);
        }
        if (
          copy.table === "definition_versions" &&
          nonlexical.has(integer(row.definition_id))
        )
          continue;
        insert.run(
          copy.table,
          id,
          ownerId(copy.table, row),
          row.langid == null ? 0 : integer(row.langid, false),
          copy.row,
          JSON.stringify(row),
        );
      } catch (error) {
        unresolved(
          output,
          copy.table === "definitions" ? id : null,
          locator,
          error instanceof Error ? error.message : String(error),
        );
      }
      if (++count % 1000 === 0) db.exec("COMMIT; BEGIN");
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function getRows(
  stage: DatabaseSync,
  table: string,
  column: "source_id" | "owner",
  value: number,
  language?: number,
): Row[] {
  const sql = `SELECT data FROM rows WHERE table_name=? AND ${column}=?${language === undefined ? "" : " AND language=?"} ORDER BY position`;
  const args =
    language === undefined ? [table, value] : [table, value, language];
  return stage
    .prepare(sql)
    .all(...args)
    .map((item) => JSON.parse(item.data as string));
}
function one(stage: DatabaseSync, table: string, id: number): Row {
  const rows = getRows(stage, table, "source_id", id);
  if (rows.length !== 1)
    throw new Error(
      `The ${table} reference ${id} has ${rows.length} source rows.`,
    );
  return rows[0];
}
function language(row: Row): string {
  const tag = text(row.tag);
  if (tag === null || tag === "")
    throw new Error("The source language lacks a language tag.");
  return tag.toLowerCase();
}

function extract(
  stage: DatabaseSync,
  row: Row,
  manifest: SqlManifest,
  output: SqlReport,
): { body: Row; lexical: Lexical } {
  const id = integer(row.definitionid);
  const word = one(stage, "valsi", integer(row.valsiid));
  const type = one(stage, "valsitypes", integer(word.typeid, false));
  const kind = text(type.descriptor);
  if (kind === null || kind === "")
    throw new Error("The source grammatical class is unavailable.");
  if (["wiki", "phrase", "nalvla"].includes(kind))
    throw new Error(`The source type ${kind} is outside the lexical import.`);
  const lang = one(stage, "languages", integer(row.langid, false));
  const sourceLang = one(
    stage,
    "languages",
    integer(word.source_langid, false),
  );
  if (language(sourceLang) !== "jbo")
    throw new Error("The source word language is not Lojban.");
  const spelling = text(word.word);
  if (spelling === null) throw new Error("The source spelling is unavailable.");
  const definitionLanguage = language(lang);
  const mappings = getRows(stage, "keywordmapping", "owner", id).map(
    (mapping) => {
      const keyword = one(
        stage,
        "natlangwords",
        integer(mapping.natlangwordid, false),
      );
      const keywordLanguage = one(
        stage,
        "languages",
        integer(keyword.langid, false),
      );
      const place = integer(mapping.place, false);
      if (place < 0)
        throw new Error("A SQL place keyword has a negative index.");
      const value = text(keyword.word);
      if (value === null) throw new Error("A SQL keyword lacks a word.");
      return {
        mapping,
        keyword,
        language: language(keywordLanguage),
        place,
        word: value,
        meaning: text(keyword.meaning),
      };
    },
  );
  const glosses = sorted(
    mappings
      .filter((item) => item.place === 0)
      .map(({ word, meaning }) => ({ word, meaning })),
  );
  const places = sorted(
    mappings
      .filter((item) => item.place > 0)
      .map(({ word, meaning }) => ({ word, meaning })),
  );
  const indices = mappings
    .filter((item) => item.place > 0)
    .map(({ place, word, meaning }) => ({ place, word, meaning }))
    .sort(
      (a, b) =>
        a.place - b.place ||
        Buffer.compare(Buffer.from(canonical(a)), Buffer.from(canonical(b))),
    );
  const lexical: Lexical = {
    word: known(word.word),
    language: known(row.langid),
    text: known(row.definition),
    notes: known(row.notes),
    etymology: known(row.etymology),
    classification: known({ kind, selmaho: row.selmaho }),
    labels: known(row.jargon),
    glosses: known(glosses),
    place_keywords: known(places),
    place_keyword_indices: known(indices),
    official_rafsi: known(tokens(word.rafsi)),
    experimental_rafsi: known(tokens(row.rafsi)),
  };
  const history = getRows(stage, "definition_versions", "owner", id);
  const wordEtymology = getRows(
    stage,
    "etymology",
    "owner",
    integer(row.valsiid),
    integer(row.langid, false),
  );
  const scores = getRows(stage, "natlangwordbestplaces", "owner", id);
  const examples = getRows(stage, "example", "owner", id);
  const locator = `definitions/definitionid=${id}`;
  const source = {
    label: "Pinned Lensisku SQL snapshot",
    url: manifest.url.startsWith("https://") ? manifest.url : null,
    event: null,
    locator,
  };
  const username = text(row.cached_username);
  const account = row.userid === null ? null : integer(row.userid, false);
  const rawKind = kind.replace(/^(experimental|obsolete) /, "");
  const mapped =
    (
      {
        "cmavo-compound": "compound",
        "bu-letteral": "letteral",
        "fu'ivla": "fuivla",
        "zei-lujvo": "lujvo",
        "non-canonical lujvo": "lujvo",
      } as Record<string, string>
    )[rawKind] ?? rawKind;
  const supported = new Set([
    "gismu",
    "cmavo",
    "lujvo",
    "fuivla",
    "cmevla",
    "compound",
    "letteral",
    "other",
  ]);
  const mappedKind = supported.has(mapped) ? mapped : "other";
  const limitations = [
    "This SQL file omits definition aggregate scores and authenticated individual votes. Keyword best-place scores remain distinct source evidence.",
    "Available version rows identify editors. They do not establish original authors or complete historical coverage.",
    "Text remains literal. Exact SQL place keyword indices remain source evidence without an inferred frame.",
    "Word-level rafsi and definition-level rafsi remain distinct source evidence. This extraction publishes no rafsi claims.",
    "The source contains no rights statement. Rights remain unknown.",
    "The exact source remains at the verified external archive path. Keep that file and the original manifest available.",
    ...manifest.notes,
  ];
  if (mappedKind !== kind)
    limitations.push(`Source classification ${kind} maps to ${mappedKind}.`);
  const warnings: string[] = [];
  for (const field of ["official_rafsi", "experimental_rafsi"] as const) {
    const value = lexical[field];
    if (
      "known" in value &&
      (value.known as string[]).some((token) =>
        /[\p{White_Space}\ufeff]/u.test(token),
      )
    )
      warnings.push(
        `${field} contains non-ASCII whitespace inside a preserved source token.`,
      );
  }
  output.notices.push(
    ...warnings.map((warning) => `Definition ${id}: ${warning}`),
  );
  const body: Row = {
    word: { language: "jbo", spelling: spelling.normalize("NFC") },
    language: definitionLanguage,
    text: literal(text(row.definition)),
    frame: null,
    operands: [],
    examples: [],
    glosses: [],
    notes: [],
    etymology: { text: [], formation: null, compound: null },
    ...(glosses.length
      ? {
          glosses: mappings
            .filter((item) => item.place === 0)
            .map((item) => ({
              language: item.language,
              text: item.word,
              sense: item.meaning,
            })),
        }
      : {}),
    ...(row.notes === null || row.notes === ""
      ? {}
      : { notes: literal(text(row.notes)) }),
    ...(row.etymology === null || row.etymology === ""
      ? {}
      : {
          etymology: {
            text: literal(text(row.etymology)),
            formation: null,
            compound: null,
          },
        }),
    classification: {
      kind: mappedKind,
      selmaho:
        row.selmaho === null || row.selmaho === "" ? [] : [text(row.selmaho)],
    },
    labels: [
      ...(kind.startsWith("experimental ") ? ["experimental"] : []),
      ...(kind.startsWith("obsolete ") ? ["obsolete"] : []),
      ...(rawKind === "non-canonical lujvo" ? ["non-canonical"] : []),
      ...(rawKind === "zei-lujvo" ? ["zei-lujvo"] : []),
    ].sort(),
    sources: [source],
    license: {
      expression: "unknown",
      url: null,
      attribution:
        username === null
          ? "Lensisku source author unknown"
          : `Lensisku source author: ${username}`,
    },
    legacy: {
      source: manifest.source,
      snapshot: manifest.sha256,
      extraction: manifest.extraction,
      record: { kind: "definition", id },
      locator,
      original: {
        definitions: row,
        valsi: word,
        valsitypes: type,
        languages: lang,
        source_language: sourceLang,
        keywordmapping: mappings.map(({ mapping, keyword }) => ({
          ...mapping,
          natlangword: keyword,
        })),
        definition_versions: history,
        etymology: wordEtymology,
        examples,
        scores,
      },
      attribution: {
        author: username,
        editor: null,
        author_account:
          account === null || account <= 0
            ? null
            : {
                origin: manifest.account_origin,
                account,
                username,
                evidence: { kind: "source-id", source },
              },
        dates: {
          ...(typeof row.created_at === "string"
            ? { created_at: row.created_at }
            : {}),
        },
      },
      conversion: {
        method: "literal",
        tool: "jbovlacku-lensisku-import",
        version: manifest.extraction,
        model: null,
        review: "unreviewed",
        mappings: [],
        warnings,
      },
      limitations,
    },
  };
  return { body, lexical };
}

function openJournal(
  path: string,
  source: string,
  importer: string,
): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=-8192; CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS versions(record INTEGER,digest TEXT,lexical TEXT,carrier TEXT,event TEXT PRIMARY KEY); CREATE INDEX IF NOT EXISTS versions_record ON versions(record,digest); CREATE TABLE IF NOT EXISTS entries(record INTEGER PRIMARY KEY,selected TEXT,baseline TEXT); CREATE TABLE IF NOT EXISTS observations(record INTEGER,snapshot TEXT,digest TEXT,event TEXT,disposition TEXT,PRIMARY KEY(record,snapshot,digest)); CREATE TABLE IF NOT EXISTS views(event TEXT PRIMARY KEY,body TEXT,carrier TEXT); CREATE TABLE IF NOT EXISTS unresolved(snapshot TEXT,record INTEGER,locator TEXT,reason TEXT); CREATE TABLE IF NOT EXISTS batches(snapshot TEXT PRIMARY KEY,manifest TEXT,report TEXT,view TEXT,selection TEXT);",
  );
  const get = db.prepare("SELECT value FROM state WHERE key=?");
  const set = db.prepare("INSERT OR IGNORE INTO state VALUES(?,?)");
  for (const [key, value] of [
    ["format", "jbovlacku-sql-import-journal-v1"],
    ["source", source],
    ["importer", importer],
  ]) {
    set.run(key, value);
    if ((get.get(key) as any)?.value !== value) {
      db.close();
      throw new Error(
        "The SQL journal belongs to another format, source, or importer.",
      );
    }
  }
  return db;
}
function validateJournal(db: DatabaseSync, source: string, importer: string) {
  const ids = new Set<string>();
  const previous: string[] = [];
  for (const item of db
    .prepare(
      "SELECT record,digest,lexical,carrier,event,NULL AS view_body FROM versions UNION ALL SELECT NULL,NULL,NULL,carrier,event,body FROM views",
    )
    .iterate()) {
    const carrier = parseProtocolJson<Carrier>(utf8(item.carrier as string));
    const admission = prepareAdmission(utf8(item.carrier as string));
    if (
      !admission.action_valid ||
      admission.body_status !== "present" ||
      carrier.envelope.header.issuer !== importer ||
      carrier.envelope.id !== item.event ||
      canonical(carrier) !== item.carrier
    )
      throw new Error("The SQL journal contains an invalid signed carrier.");
    ids.add(carrier.envelope.id);
    previous.push(...carrier.envelope.header.previous);
    if (item.record !== null) {
      if (
        digest(JSON.parse(item.lexical as string)) !== item.digest ||
        carrier.body.legacy?.source !== source ||
        carrier.body.legacy?.record?.id !== item.record ||
        carrier.envelope.header.action.kind !== "definition.publish"
      )
        throw new Error(
          "The SQL journal source record or lexical digest is inconsistent.",
        );
    } else if (
      carrier.envelope.header.action.kind !== "view.publish" ||
      item.view_body !== canonical(carrier.body)
    )
      throw new Error("The SQL journal contains an invalid view record.");
  }
  if (previous.some((id) => !ids.has(id)))
    throw new Error("The SQL journal lacks a retained predecessor envelope.");
  const head = (
    db.prepare("SELECT value FROM state WHERE key='head'").get() as any
  )?.value;
  if (head && !ids.has(head))
    throw new Error("The SQL journal lacks its original head envelope.");
  const predecessors = new Set(previous);
  const maxima = [...ids].filter((id) => !predecessors.has(id));
  if (
    maxima.length !== (ids.size ? 1 : 0) ||
    (maxima.length && maxima[0] !== head)
  )
    throw new Error(
      "The SQL journal head does not name its complete signed frontier.",
    );
  if (
    db
      .prepare(
        "SELECT entries.record FROM entries LEFT JOIN versions ON entries.selected=versions.event WHERE versions.event IS NULL OR entries.record<>versions.record LIMIT 1",
      )
      .get()
  )
    throw new Error(
      "The SQL journal selection lacks its original source envelope.",
    );
}
function sign(
  db: DatabaseSync,
  seed: Uint8Array,
  action: Row,
  body: Row,
): Carrier {
  const head = (
    db.prepare("SELECT value FROM state WHERE key='head'").get() as any
  )?.value;
  const carrier = createEvent(
    seed,
    head ? [head] : [],
    randomBytes(16).toString("hex"),
    action,
    body,
  ) as Carrier;
  const prepared = prepareAdmission(utf8(canonical(carrier)));
  if (!prepared.action_valid || prepared.body_status !== "present")
    throw new Error("The extracted publication failed the core schema.");
  db.prepare("INSERT OR REPLACE INTO state VALUES('head',?)").run(
    carrier.envelope.id,
  );
  return carrier;
}
function publishView(
  db: DatabaseSync,
  options: SqlImportOptions,
  manifest: SqlManifest,
  importer: string,
  selection: string,
): string {
  const body = {
    name: "Pinned Lensisku SQL import",
    description: [["Literal extraction from the pinned local SQL snapshot."]],
    roots: [...options.roots].sort((a, b) =>
      a.identity.localeCompare(b.identity),
    ),
    rafsi_threshold: { numerator: 1, denominator: 1 },
    H: { numerator: 3, denominator: 1 },
    alpha: { numerator: 1, denominator: 2 },
    excluded: [],
    calculation: "simple-routes-bounds-v1",
    work: 1_000_000,
    import_sets: [{ source: manifest.source, importer, selection }],
    account_witnesses: [],
    account_authority: false,
    notes: [
      ["The operator chose these roots. Legacy scores grant no influence."],
    ],
  };
  const bodyText = canonical(body);
  const oldView = db
    .prepare("SELECT * FROM views WHERE body=?")
    .get(bodyText) as any;
  if (oldView) return oldView.event;
  const prior = db
    .prepare("SELECT value FROM state WHERE key='view'")
    .get() as any;
  const carrier = sign(
    db,
    options.seed,
    { kind: "view.publish", parents: prior ? [prior.value] : [] },
    body,
  );
  db.prepare("INSERT INTO views VALUES(?,?,?)").run(
    carrier.envelope.id,
    bodyText,
    canonical(carrier),
  );
  db.prepare("INSERT OR REPLACE INTO state VALUES('view',?)").run(
    carrier.envelope.id,
  );
  return carrier.envelope.id;
}
async function writeDerived(output: string, name: string, value: unknown) {
  const temporary = join(output, `${name}.next`);
  await writeFile(temporary, canonical(value));
  await rename(temporary, join(output, name));
}
async function exportProposal(
  db: DatabaseSync,
  output: string,
  snapshot: string,
  importer: string,
  checkpoint?: SqlImportOptions["checkpoint"],
) {
  const batch = db
    .prepare("SELECT * FROM batches WHERE snapshot=?")
    .get(snapshot) as any;
  if (!batch) throw new Error("The committed SQL batch is missing.");
  const handle = await open(join(output, "carriers.jsonl.next"), "w");
  try {
    for (const row of db
      .prepare(
        "SELECT event,carrier FROM versions UNION ALL SELECT event,carrier FROM views ORDER BY event",
      )
      .iterate())
      await handle.write(`${row.carrier}\n`);
  } finally {
    await handle.close();
  }
  await rename(
    join(output, "carriers.jsonl.next"),
    join(output, "carriers.jsonl"),
  );
  await checkpoint?.("carriers-written");
  await writeDerived(
    output,
    "import-selection.json",
    JSON.parse(batch.selection),
  );
  const selected = db
    .prepare("SELECT carrier FROM views WHERE event=?")
    .get(batch.view) as any;
  await writeDerived(
    output,
    "selected-view.json",
    JSON.parse(selected.carrier),
  );
  const selection = prepareSelection(utf8(batch.selection));
  const parsedReport = JSON.parse(batch.report) as SqlReport;
  const manifest = JSON.parse(batch.manifest) as SqlManifest;
  await writeDerived(output, "proposal.json", {
    source: manifest.source,
    importer,
    selected_view: batch.view,
    import_selection: selection.hash,
    report: parsedReport,
  });
  return {
    output,
    view: batch.view as string,
    selection: selection.hash,
    report: parsedReport,
  };
}

/** Stage joins on disk, retain signed envelopes, then write one carrier at a time. */
export async function importSqlSnapshot(options: SqlImportOptions) {
  const output = resolve(options.output);
  const sourcePath = resolve(options.sourcePath);
  const manifestPath = resolve(options.manifestPath);
  const manifestBytes = await readFile(manifestPath);
  const manifest = parseSqlManifest(manifestBytes, sourcePath);
  if (
    manifest.extraction !== SQL_EXTRACTION ||
    manifest.recipe !== "lensisku-sql-copy-v1" ||
    manifest.source !== SQL_SOURCE ||
    manifest.account_origin !== SQL_ACCOUNT_ORIGIN
  )
    throw new Error(
      "The SQL extraction recipe or source identity is unsupported.",
    );
  if (
    !Number.isSafeInteger(manifest.bytes) ||
    manifest.bytes <= 0 ||
    !Number.isFinite(Date.parse(manifest.retrieved_at))
  )
    throw new Error("The SQL manifest size or retrieval date is invalid.");
  const sourceStat = await stat(sourcePath);
  const pinned = await hashFile(sourcePath);
  if (pinned.sha256 !== manifest.sha256 || pinned.bytes !== manifest.bytes)
    throw new Error(
      "The SQL source does not match the pinned digest and byte length.",
    );
  const importer = identityFromSeed(options.seed);
  await mkdir(output, { recursive: true });
  await mkdir(join(output, ".import-lock"));
  let journal: DatabaseSync | undefined;
  let stage: DatabaseSync | undefined;
  const stagePath = join(output, `.sql-stage-${randomUUID()}.sqlite`);
  try {
    const journalPath = join(output, "journal.sqlite");
    let exists = false;
    try {
      await access(journalPath);
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!exists) {
      for (const name of [
        "carriers.jsonl",
        "selected-view.json",
        "proposal.json",
        "import-selection.json",
        "source-archive",
      ]) {
        let leftover = false;
        try {
          await access(join(output, name));
          leftover = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (leftover)
          throw new Error(
            "The SQL journal is missing. Recover the retained journal and envelopes before another import.",
          );
      }
    }
    journal = openJournal(journalPath, manifest.source, importer);
    validateJournal(journal, manifest.source, importer);
    const archive = join(output, "source-archive");
    await mkdir(archive, { recursive: true });
    for (const name of await readdir(archive)) {
      if (!name.endsWith(".reference.json")) continue;
      const prior = parseProtocolJson<Row>(await readFile(join(archive, name)));
      if (prior.path === sourcePath && prior.snapshot !== pinned.sha256)
        throw new Error(
          "The SQL source path already names a different archived snapshot. Use immutable source files at distinct paths.",
        );
    }
    const manifestHash = contentHash(manifestBytes);
    const originalManifest = join(
      archive,
      `${manifest.sha256.slice(7)}.${manifestHash.slice(7)}.manifest`,
    );
    try {
      await writeFile(originalManifest, manifestBytes, {
        flag: "wx",
        flush: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await readFile(originalManifest)).equals(manifestBytes))
        throw new Error(
          "The archived SQL manifest differs from the pinned bytes.",
        );
    }
    const archiveRecord = {
      format: "jbovlacku-external-source-reference-v1",
      source: manifest.source,
      snapshot: pinned.sha256,
      bytes: pinned.bytes,
      path: sourcePath,
      manifest: {
        path: manifestPath,
        sha256: manifestHash,
        archived: originalManifest,
      },
      availability:
        "The operator must retain the exact external source file. This reference does not contain the source bytes.",
    };
    const archivePath = join(
      archive,
      `${manifest.sha256.slice(7)}.reference.json`,
    );
    try {
      await writeFile(archivePath, canonical(archiveRecord), {
        flag: "wx",
        flush: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const previous = parseProtocolJson<Row>(await readFile(archivePath));
      if (
        previous.snapshot !== pinned.sha256 ||
        previous.bytes !== pinned.bytes ||
        previous.manifest.sha256 !== manifestHash
      )
        throw new Error(
          "The existing SQL archive reference differs from the verified source.",
        );
    }
    await syncDirectory(archive);
    await syncDirectory(output);
    await options.checkpoint?.("source-durable");
    // A committed batch can rebuild interrupted derived output without signing again.
    const committed = journal
      .prepare("SELECT * FROM batches WHERE snapshot=?")
      .get(manifest.sha256) as any;
    const currentSnapshot = (
      journal
        .prepare("SELECT value FROM state WHERE key='snapshot'")
        .get() as any
    )?.value;
    if (committed && currentSnapshot === manifest.sha256) {
      const view = journal
        .prepare("SELECT body FROM views WHERE event=?")
        .get(committed.view) as any;
      const roots = [...options.roots].sort((a, b) =>
        a.identity.localeCompare(b.identity),
      );
      if (committed.manifest !== canonical(manifest))
        throw new Error(
          "The committed SQL batch uses different manifest evidence. Reuse its original manifest.",
        );
      if (!same(JSON.parse(view.body).roots, roots)) {
        journal.exec("BEGIN IMMEDIATE");
        try {
          const selection = prepareSelection(utf8(committed.selection));
          const nextView = publishView(
            journal,
            options,
            manifest,
            importer,
            selection.hash,
          );
          journal
            .prepare("UPDATE batches SET view=? WHERE snapshot=?")
            .run(nextView, manifest.sha256);
          journal.exec("COMMIT");
        } catch (error) {
          journal.exec("ROLLBACK");
          throw error;
        }
        await syncDirectory(output);
        await options.checkpoint?.("journal-durable");
      }
      return await exportProposal(
        journal,
        output,
        manifest.sha256,
        importer,
        options.checkpoint,
      );
    }
    const result = report();
    result.declared_rows = manifest.expected_rows;
    stage = new DatabaseSync(stagePath);
    await stageSource(sourcePath, stage, result);
    const stageBytes = (await stat(stagePath)).size;
    const definitionRows = Number(
      (
        stage
          .prepare(
            "SELECT COUNT(*) AS count FROM rows WHERE table_name='definitions'",
          )
          .get() as any
      ).count,
    );
    // This includes the proposal, journal, service copy, and temporary staging.
    const estimatedTotal = stageBytes * 4 + definitionRows * 8192;
    options.estimate?.({
      stage_bytes: stageBytes,
      estimated_total_bytes: estimatedTotal,
      definition_rows: definitionRows,
    });
    if (estimatedTotal > 4_000_000_000)
      throw new Error(
        "The estimated local artifacts exceed the 4 GB limit. No publications were signed.",
      );
    for (const [table, expected] of Object.entries(manifest.expected_rows)) {
      if (result.table_rows[table] !== expected) {
        result.incomplete = true;
        result.notices.push(
          `Manifest row count differs for ${table}: declared ${expected}, physical COPY rows ${result.table_rows[table] ?? 0}. No source repair was inferred.`,
        );
      }
    }
    result.source_rows = result.table_rows.definitions ?? 0;
    const currentStat = await stat(sourcePath);
    if (
      sourceStat.dev !== currentStat.dev ||
      sourceStat.ino !== currentStat.ino ||
      sourceStat.size !== currentStat.size ||
      sourceStat.mtimeMs !== currentStat.mtimeMs ||
      sourceStat.ctimeMs !== currentStat.ctimeMs
    )
      throw new Error("The SQL source changed during extraction.");
    journal.exec("BEGIN IMMEDIATE");
    try {
      const definitions = stage.prepare(
        "SELECT source_id,COUNT(*) AS count FROM rows WHERE table_name='definitions' GROUP BY source_id ORDER BY source_id",
      );
      const seen = new Set<number>();
      for (const group of definitions.iterate()) {
        const id = group.source_id as number;
        seen.add(id);
        journal.exec("SAVEPOINT source_row");
        try {
          const rows = getRows(stage, "definitions", "source_id", id);
          if (rows.length > 1) {
            if (!rows.every((row) => same(row, rows[0]))) {
              result.conflicts.push(id);
              throw new Error(
                "Conflicting duplicate source rows share this definition ID.",
              );
            }
            result.duplicates += rows.length - 1;
          }
          const { body, lexical } = extract(stage, rows[0], manifest, result);
          // Size and word rules fail before the journal changes.
          wordId(body.word);
          if (Buffer.byteLength(canonical(body)) > 256 * 1024)
            throw new Error(
              "The retained definition and source history exceed the 256 KiB body limit.",
            );
          const lexicalDigest = digest(lexical);
          const entry = journal
            .prepare("SELECT * FROM entries WHERE record=?")
            .get(id) as any;
          let selected: string;
          let disposition: string;
          const current = entry
            ? (journal
                .prepare("SELECT * FROM versions WHERE event=?")
                .get(entry.selected) as any)
            : undefined;
          const baseline: Lexical | undefined = entry
            ? JSON.parse(entry.baseline)
            : undefined;
          if (
            current &&
            !same(
              body.legacy.attribution,
              JSON.parse(current.carrier).body.legacy.attribution,
            )
          )
            result.notices.push(
              `Definition ${id}: attribution or source dates changed. This provenance observation does not create a lexical edit.`,
            );
          const conflict = (a: Lexical, b: Lexical) =>
            FIELDS.some(
              (field) =>
                "known" in a[field] &&
                "known" in b[field] &&
                !same(a[field], b[field]),
            );
          if (entry && !conflict(baseline!, lexical)) {
            selected = entry.selected;
            disposition = "reused";
            result.reused++;
          } else {
            const old = journal
              .prepare("SELECT * FROM versions WHERE record=? AND digest=?")
              .all(id, lexicalDigest) as any[];
            if (old.length > 1)
              throw new Error(
                "The SQL journal contains ambiguous publication reuse associations.",
              );
            if (old.length === 1) {
              selected = old[0].event;
              disposition = "reverted";
              result.reverted++;
            } else {
              const priorBody = current
                ? JSON.parse(current.carrier).body
                : undefined;
              if (priorBody)
                body.sources.push({
                  label: "Prior imported source version",
                  url: null,
                  event: entry.selected,
                  locator: `definitions/definitionid=${id}`,
                });
              const sameContext =
                priorBody &&
                same(body.word, priorBody.word) &&
                body.language === priorBody.language;
              const carrier = sign(
                journal,
                options.seed,
                {
                  kind: "definition.publish",
                  word: wordId(body.word),
                  language: body.language,
                  parents: sameContext ? [entry.selected] : [],
                  origin: "import",
                },
                body,
              );
              selected = carrier.envelope.id;
              journal
                .prepare("INSERT INTO versions VALUES(?,?,?,?,?)")
                .run(
                  id,
                  lexicalDigest,
                  canonical(lexical),
                  canonical(carrier),
                  selected,
                );
              disposition = entry ? "revised" : "added";
              if (entry) result.revised++;
              else result.added++;
            }
          }
          journal
            .prepare("INSERT OR REPLACE INTO entries VALUES(?,?,?)")
            .run(id, selected, canonical(lexical));
          journal
            .prepare("INSERT OR IGNORE INTO observations VALUES(?,?,?,?,?)")
            .run(id, manifest.sha256, lexicalDigest, selected, disposition);
          result.languages[body.language] =
            (result.languages[body.language] ?? 0) + 1;
          journal.exec("RELEASE source_row");
        } catch (error) {
          journal.exec("ROLLBACK TO source_row; RELEASE source_row");
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            String(error.code).startsWith("ERR_SQLITE")
          )
            throw error;
          unresolved(
            result,
            id,
            `definitions/definitionid=${id}`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      for (const old of journal
        .prepare("SELECT record FROM entries ORDER BY record")
        .iterate())
        if (!seen.has(old.record as number))
          result.omitted.push(old.record as number);
      if (result.omitted.length)
        result.notices.push(
          "Absent source rows remain selected. Absence does not prove source deletion.",
        );
      const ids = journal
        .prepare("SELECT selected FROM entries ORDER BY selected")
        .all()
        .map((row) => row.selected as string);
      const selection = prepareSelection(utf8(canonical(ids)));
      const view = publishView(
        journal,
        options,
        manifest,
        importer,
        selection.hash,
      );
      const addUnresolved = journal.prepare(
        "INSERT INTO unresolved VALUES(?,?,?,?)",
      );
      for (const issue of result.unresolved)
        addUnresolved.run(
          manifest.sha256,
          issue.record,
          issue.locator,
          issue.reason,
        );
      journal
        .prepare("INSERT OR REPLACE INTO batches VALUES(?,?,?,?,?)")
        .run(
          manifest.sha256,
          canonical(manifest),
          canonical(result),
          view,
          selection.canonical,
        );
      journal
        .prepare("INSERT OR REPLACE INTO state VALUES('snapshot',?)")
        .run(manifest.sha256);
      journal.exec("COMMIT");
    } catch (error) {
      journal.exec("ROLLBACK");
      throw error;
    }
    await syncDirectory(output);
    await options.checkpoint?.("journal-durable");
    return await exportProposal(
      journal,
      output,
      manifest.sha256,
      importer,
      options.checkpoint,
    );
  } finally {
    stage?.close();
    journal?.close();
    await rm(stagePath, { force: true });
    await rm(`${stagePath}-journal`, { force: true });
    await rm(join(output, ".import-lock"), { recursive: true });
  }
}
