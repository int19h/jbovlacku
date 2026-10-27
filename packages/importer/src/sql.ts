import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import {
  access,
  lstat,
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
  omitDefinitionDefaults,
  prepareAdmission,
  prepareSelection,
  utf8,
  wordId,
} from "../../core/src/index.ts";
import { canonical, type Carrier, type ImportOptions } from "./index.ts";
import { parseProtocolJson, syncDirectory } from "./storage.ts";
import { encodeOriginal, parseSourceJson } from "./source-json.ts";
import { hashFile, readCopyRows, type CopyRow } from "./sql-copy.ts";
import {
  openLedger as openJournal,
  validateLedger as validateJournal,
} from "./ledger.ts";
import {
  compareImportSize,
  estimateImportArtifacts,
  type ImportSizeEstimate,
} from "./import-estimate.ts";

export const SQL_EXTRACTION = "lensisku-sql-literal-v2";
export const SQL_SOURCE = "https://lensisku.lojban.org";
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
  logical_table_rows: Record<string, number>;
  declared_rows: Record<string, number>;
  languages: Record<string, number>;
}
export interface SqlImportOptions {
  sourcePath: string;
  manifestPath: string;
  output: string;
  seed: Uint8Array;
  roots: ImportOptions["roots"];
  /** Reparse an existing ledger without signing any publication or view. */
  checkExisting?: boolean;
  /** This test hook runs after durable state changes. */
  checkpoint?: (
    stage: "source-durable" | "journal-durable" | "carriers-written",
  ) => Promise<void>;
  estimate?: (value: ImportSizeEstimate) => void;
  measurement?: (value: ReturnType<typeof compareImportSize>) => void;
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
class SourceRowError extends Error {}
const omittedColumn = (key: string) =>
  key === "embedding" ||
  key === "metadata" ||
  key === "canonical_word" ||
  key.startsWith("cached_");
function retainedRow(row: Row): Row {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => !omittedColumn(key)),
  );
}
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
    throw new SourceRowError(
      "A source text field must contain a string or null.",
    );
  return value;
};
const integer = (value: any, positive = true): number => {
  const token = value?.$source_number;
  if (typeof token !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(token))
    throw new SourceRowError(
      "A source integer field lacks an exact integer token.",
    );
  const result = Number(token);
  if (!Number.isSafeInteger(result) || (positive && result <= 0))
    throw new SourceRowError(
      "A source integer is outside the supported range.",
    );
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

function validateManifest(value: unknown): SqlManifest {
  const keys = [
    "source",
    "url",
    "account_origin",
    "retrieved_at",
    "sha256",
    "bytes",
    "extraction",
    "recipe",
    "expected_rows",
    "notes",
  ];
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("The SQL manifest must be an object.");
  const manifest = value as Row;
  if (
    keys.some((key) => !Object.hasOwn(manifest, key)) ||
    Object.keys(manifest).some((key) => !keys.includes(key))
  )
    throw new Error("The SQL manifest has missing or unknown fields.");
  if (
    [
      "source",
      "url",
      "account_origin",
      "retrieved_at",
      "sha256",
      "extraction",
      "recipe",
    ].some((key) => typeof manifest[key] !== "string")
  )
    throw new Error("The SQL manifest text fields must contain strings.");
  try {
    const url = new URL(manifest.url);
    if (!["https:", "file:"].includes(url.protocol)) throw new Error();
  } catch {
    throw new Error(
      "The SQL manifest URL must identify an HTTPS or local file source.",
    );
  }
  if (
    !Array.isArray(manifest.notes) ||
    manifest.notes.some((note: unknown) => typeof note !== "string")
  )
    throw new Error("The SQL manifest notes must be an array of strings.");
  if (
    manifest.expected_rows === null ||
    typeof manifest.expected_rows !== "object" ||
    Array.isArray(manifest.expected_rows) ||
    Object.entries(manifest.expected_rows).some(
      ([key, count]) =>
        !/^[a-z_]+$/.test(key) ||
        !Number.isSafeInteger(count) ||
        (count as number) < 0,
    )
  )
    throw new Error(
      "The SQL manifest expected_rows must contain table names and nonnegative safe integers.",
    );
  if (
    !/^sha256:[0-9a-f]{64}$/.test(manifest.sha256) ||
    !Number.isSafeInteger(manifest.bytes) ||
    manifest.bytes <= 0 ||
    !Number.isFinite(Date.parse(manifest.retrieved_at))
  )
    throw new Error(
      "The SQL manifest digest, size, or retrieval date is invalid.",
    );
  if (
    manifest.source !== SQL_SOURCE ||
    manifest.account_origin !== SQL_ACCOUNT_ORIGIN ||
    manifest.extraction !== SQL_EXTRACTION ||
    manifest.recipe !== "lensisku-sql-copy-v1"
  )
    throw new Error(
      "The SQL manifest extraction recipe or source identity is unsupported.",
    );
  return manifest as SqlManifest;
}

/** Read the pinned archive manifest without treating TOML as executable input. */
export function parseSqlManifest(
  bytes: Uint8Array,
  sourcePath: string,
): SqlManifest {
  const input = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (input.trimStart().startsWith("{"))
    return validateManifest(parseProtocolJson<unknown>(bytes));
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
  return validateManifest({
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
  });
}

function originalRow(row: CopyRow): Row {
  const result: Row = Object.create(null);
  for (let i = 0; i < row.columns.length; i++) {
    const key = row.columns[i];
    const value = row.values[i];
    if (omittedColumn(key)) continue;
    if (value === null) result[key] = null;
    else if (numeric.has(key)) {
      if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(value))
        throw new SourceRowError(
          `The numeric SQL column ${key} contains an invalid number token.`,
        );
      result[key] = { $source_number: value };
    } else if (bools.has(key)) {
      if (value !== "t" && value !== "f")
        throw new SourceRowError(`The SQL boolean ${key} is invalid.`);
      result[key] = value === "t";
    } else if (jsonFields.has(key)) {
      try {
        result[key] = encodeOriginal(parseSourceJson(value));
      } catch (error) {
        throw new SourceRowError(
          `Invalid SQL JSON column ${key}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else result[key] = value;
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
    logical_table_rows: {},
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
    "PRAGMA journal_mode=DELETE; PRAGMA synchronous=OFF; PRAGMA cache_size=-16384; PRAGMA temp_store=FILE; CREATE TABLE rows (table_name TEXT, source_id INTEGER, owner INTEGER, language INTEGER, position INTEGER, data TEXT); CREATE INDEX by_id ON rows(table_name,source_id); CREATE INDEX by_owner ON rows(table_name,owner,language); CREATE TABLE issues(table_name TEXT,source_key INTEGER,locator TEXT,reason TEXT); CREATE INDEX issue_keys ON issues(table_name,source_key); CREATE TABLE incomplete_tables(table_name TEXT PRIMARY KEY,reason TEXT); CREATE TABLE seen_definitions(record INTEGER PRIMARY KEY);",
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
      definitions: "valsiid",
      definition_versions: "definition_id",
      keywordmapping: "definitionid",
      natlangwordbestplaces: "definitionid",
      etymology: "valsiid",
      example: "definitionid",
    } as Record<string, string>
  )[table];
  return key ? integer(row[key], false) : 0;
}
function recoveredId(copy: CopyRow, key: string): number | null {
  const index = copy.columns.indexOf(key);
  // A numeric value in a continuation fragment does not establish row identity.
  for (let position = 0; position < index; position++) {
    if (!numeric.has(copy.columns[position])) continue;
    const prefix = copy.values[position];
    if (
      typeof prefix !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(prefix) ||
      !Number.isSafeInteger(Number(prefix))
    )
      return null;
  }
  const value = index < 0 ? undefined : copy.values[index];
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}
const issueKey = (table: string) =>
  (
    ({
      languages: "langid",
      valsitypes: "typeid",
      valsi: "valsiid",
      definitions: "definitionid",
      definition_versions: "definition_id",
      natlangwords: "wordid",
      keywordmapping: "definitionid",
      natlangwordbestplaces: "definitionid",
      etymology: "valsiid",
      example: "definitionid",
    }) as Record<string, string>
  )[table];
function assertComplete(stage: DatabaseSync, table: string, key: number) {
  const coverage = stage
    .prepare("SELECT reason FROM incomplete_tables WHERE table_name=?")
    .get(table);
  if (coverage) throw new SourceRowError(coverage.reason as string);
  const lookup = [
    "definitions",
    "languages",
    "valsitypes",
    "valsi",
    "natlangwords",
  ].includes(table);
  const issue = stage
    .prepare(
      `SELECT locator FROM issues WHERE table_name=? AND (source_key=?${lookup ? "" : " OR source_key IS NULL"}) LIMIT 1`,
    )
    .get(table, key);
  if (issue)
    throw new SourceRowError(
      `The ${table} source evidence is incomplete because a related row is malformed at ${issue.locator}.`,
    );
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
      if (TABLES.has(table)) output.logical_table_rows[table] ??= 0;
    })) {
      // A grouped malformed record is one source row, even across line breaks.
      output.logical_table_rows[copy.table] =
        (output.logical_table_rows[copy.table] ?? 0) + 1;
      const locator = (copy.fragments ?? [copy])
        .map(({ row, line }) => `${copy.table}/COPY-row=${row}/line=${line}`)
        .join(" + ");
      const recovered = recoveredId(copy, issueKey(copy.table));
      const definitionId =
        copy.table === "definitions" ? recoveredId(copy, "definitionid") : null;
      if (definitionId !== null && definitionId > 0)
        db.prepare("INSERT OR IGNORE INTO seen_definitions VALUES(?)").run(
          definitionId,
        );
      try {
        if (copy.error) throw new SourceRowError(copy.error);
        const row = originalRow(copy);
        const id = stageId(copy.table, row);
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
        if (!(error instanceof SourceRowError)) throw error;
        db.prepare("INSERT INTO issues VALUES(?,?,?,?)").run(
          copy.table,
          recovered,
          locator,
          error.message,
        );
        const direct = [
          "definitions",
          "definition_versions",
          "keywordmapping",
          "natlangwordbestplaces",
          "example",
        ].includes(copy.table);
        unresolved(
          output,
          direct && recovered !== null && recovered > 0 ? recovered : null,
          locator,
          error.message,
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
    throw new SourceRowError(
      `The ${table} reference ${id} has ${rows.length} source rows.`,
    );
  return rows[0];
}
function language(row: Row): string {
  const tag = text(row.tag);
  if (tag === null || tag === "")
    throw new SourceRowError("The source language lacks a language tag.");
  return tag.toLowerCase();
}

function extract(
  stage: DatabaseSync,
  row: Row,
  manifest: SqlManifest,
  output: SqlReport,
): { body: Row; lexical: Lexical } {
  const id = integer(row.definitionid);
  assertComplete(stage, "definitions", id);
  for (const table of [
    "definition_versions",
    "keywordmapping",
    "example",
    "natlangwordbestplaces",
  ])
    assertComplete(stage, table, id);
  assertComplete(stage, "etymology", integer(row.valsiid));
  assertComplete(stage, "valsi", integer(row.valsiid));
  assertComplete(stage, "languages", integer(row.langid, false));
  const word = one(stage, "valsi", integer(row.valsiid));
  assertComplete(stage, "valsitypes", integer(word.typeid, false));
  assertComplete(stage, "languages", integer(word.source_langid, false));
  assertComplete(stage, "natlangwords", -1);
  const type = one(stage, "valsitypes", integer(word.typeid, false));
  const kind = text(type.descriptor);
  if (kind === null || kind === "")
    throw new SourceRowError("The source grammatical class is unavailable.");
  if (["wiki", "phrase", "nalvla"].includes(kind))
    throw new SourceRowError(
      `The source type ${kind} is outside the lexical import.`,
    );
  const lang = one(stage, "languages", integer(row.langid, false));
  const sourceLang = one(
    stage,
    "languages",
    integer(word.source_langid, false),
  );
  if (language(sourceLang) !== "jbo")
    throw new SourceRowError("The source word language is not Lojban.");
  const spelling = text(word.word);
  if (spelling === null)
    throw new SourceRowError("The source spelling is unavailable.");
  const definitionLanguage = language(lang);
  const mappings = getRows(stage, "keywordmapping", "owner", id).map(
    (mapping) => {
      assertComplete(
        stage,
        "natlangwords",
        integer(mapping.natlangwordid, false),
      );
      const keyword = one(
        stage,
        "natlangwords",
        integer(mapping.natlangwordid, false),
      );
      assertComplete(stage, "languages", integer(keyword.langid, false));
      const keywordLanguage = one(
        stage,
        "languages",
        integer(keyword.langid, false),
      );
      const place = integer(mapping.place, false);
      if (place < 0)
        throw new SourceRowError("A SQL place keyword has a negative index.");
      const value = text(keyword.word);
      if (value === null)
        throw new SourceRowError("A SQL keyword lacks a word.");
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
    language: known({ source_id: row.langid, tag: definitionLanguage }),
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
  const username = null;
  const account = row.userid === null ? null : integer(row.userid, false);
  const rawKind = kind.replace(/^(experimental|obsolete) /, "");
  const mapped =
    (
      {
        "cmavo-compound": "compound",
        "bu-letteral": "letteral",
        "fu'ivla": "fuhivla",
        "zei-lujvo": "lujvo",
        "non-canonical lujvo": "lujvo",
      } as Record<string, string>
    )[rawKind] ?? rawKind;
  const supported = new Set([
    "gismu",
    "cmavo",
    "lujvo",
    "fuhivla",
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
    "Derived source columns are excluded from published rows: embedding, metadata (including processed_text), cached_*, canonical_word, and cached_decomposition. Their exact values remain in the source archive. Cached usernames do not establish source author names.",
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
        definitions: retainedRow(row),
        valsi: retainedRow(word),
        valsitypes: type,
        languages: lang,
        source_language: sourceLang,
        keywordmapping: mappings.map(({ mapping, keyword }) => ({
          ...mapping,
          natlangword: keyword,
        })),
        definition_versions: history.map(retainedRow),
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

function normalizeLanguage(lexical: Lexical, carrier: Carrier): Lexical {
  const result = structuredClone(lexical);
  if ("known" in result.language) {
    const current = result.language.known as any;
    if (!current || typeof current !== "object" || !("source_id" in current))
      result.language = known({
        source_id: current,
        tag: carrier.body.language,
      });
  }
  return result;
}
function migrateLanguageEvidence(db: DatabaseSync) {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const version of db
      .prepare("SELECT event,lexical,carrier FROM versions")
      .iterate()) {
      const old = JSON.parse(version.lexical as string);
      const lexical = normalizeLanguage(
        old,
        JSON.parse(version.carrier as string),
      );
      if (!same(old, lexical))
        db.prepare("UPDATE versions SET lexical=?,digest=? WHERE event=?").run(
          canonical(lexical),
          digest(lexical),
          version.event,
        );
    }
    for (const entry of db
      .prepare(
        "SELECT entries.record,entries.baseline,versions.carrier FROM entries JOIN versions ON entries.selected=versions.event",
      )
      .iterate()) {
      const old = JSON.parse(entry.baseline as string);
      const lexical = normalizeLanguage(
        old,
        JSON.parse(entry.carrier as string),
      );
      if (!same(old, lexical))
        db.prepare("UPDATE entries SET baseline=? WHERE record=?").run(
          canonical(lexical),
          entry.record,
        );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function sourceWordId(word: { language: "jbo"; spelling: string }): string {
  try {
    return wordId(word);
  } catch (error) {
    if (typeof error === "string")
      throw new SourceRowError(`Invalid source spelling: ${error}`);
    throw error;
  }
}
function glossEvidenceMatches(
  a: Lexical,
  prior: Row,
  b: Lexical,
  current: Row,
): boolean {
  if (!("known" in a.glosses) || !("known" in b.glosses)) return true;
  if (
    !Array.isArray(prior.legacy?.original?.keywordmapping) ||
    !Array.isArray(current.legacy?.original?.keywordmapping)
  )
    return true;
  const glosses = (body: Row) =>
    sorted(
      (body.glosses ?? []).map((gloss: Row) => ({
        word: gloss.text,
        meaning: gloss.sense ?? null,
        language: gloss.language,
      })),
    );
  return same(glosses(prior), glosses(current));
}
function precedingContext(
  db: DatabaseSync,
  record: number,
  current: Carrier | undefined,
  body: Row,
): string[] {
  const sameContext = (candidate: Carrier) =>
    same(candidate.body.word, body.word) &&
    candidate.body.language === body.language;
  if (current && sameContext(current)) return [current.envelope.id];
  for (const version of db
    .prepare(
      "SELECT versions.carrier FROM observations JOIN versions ON observations.event=versions.event WHERE observations.record=? ORDER BY observations.run DESC",
    )
    .iterate(record)) {
    const candidate = JSON.parse(version.carrier as string) as Carrier;
    if (sameContext(candidate)) return [candidate.envelope.id];
  }
  for (const version of db
    .prepare("SELECT carrier FROM versions WHERE record=? ORDER BY rowid DESC")
    .iterate(record)) {
    const candidate = JSON.parse(version.carrier as string) as Carrier;
    if (sameContext(candidate)) return [candidate.envelope.id];
  }
  return [];
}

/** Use the same source checks and reuse rules before the budget and signing. */
function planDefinition(
  stage: DatabaseSync,
  journal: DatabaseSync,
  id: number,
  manifest: SqlManifest,
  result: SqlReport,
) {
  const rows = getRows(stage, "definitions", "source_id", id);
  if (rows.length > 1) {
    if (!rows.every((row) => same(row, rows[0]))) {
      result.conflicts.push(id);
      throw new SourceRowError(
        "Conflicting duplicate source rows share this definition ID.",
      );
    }
    result.duplicates += rows.length - 1;
  }
  const { body, lexical } = extract(stage, rows[0], manifest, result);
  sourceWordId(body.word);
  const lexicalDigest = digest(lexical);
  const entry = journal
    .prepare("SELECT * FROM entries WHERE record=?")
    .get(id) as any;
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
        "known" in a[field] && "known" in b[field] && !same(a[field], b[field]),
    );
  let reuse: { event: string; disposition: "reused" | "reverted" } | undefined;
  if (
    entry &&
    !conflict(baseline!, lexical) &&
    glossEvidenceMatches(
      JSON.parse(current.lexical),
      JSON.parse(current.carrier).body,
      lexical,
      body,
    )
  ) {
    reuse = { event: entry.selected, disposition: "reused" };
  } else {
    const old = journal
      .prepare("SELECT * FROM versions WHERE record=? AND digest=?")
      .all(id, lexicalDigest)
      .filter((version) =>
        glossEvidenceMatches(
          JSON.parse(version.lexical as string),
          JSON.parse(version.carrier as string).body,
          lexical,
          body,
        ),
      );
    if (old.length > 1)
      throw new Error(
        "The SQL journal contains ambiguous publication reuse associations.",
      );
    if (old.length === 1)
      reuse = { event: old[0].event as string, disposition: "reverted" };
  }
  if (!reuse) {
    if (current)
      body.sources.push({
        label: "Prior imported source version",
        url: null,
        event: entry.selected,
        locator: `definitions/definitionid=${id}`,
      });
    if (Buffer.byteLength(canonical(omitDefinitionDefaults(body))) > 256 * 1024)
      throw new SourceRowError(
        "The retained definition and source history exceed the 256 KiB body limit.",
      );
  }
  return { body, lexical, lexicalDigest, entry, current, baseline, reuse };
}

async function requireCheckScratch(output: string) {
  for (const name of ["carriers.jsonl", "source-archive"]) {
    const existing = await lstat(join(output, name)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (existing)
      throw new Error(
        "The proposal check requires a scratch output directory without carriers.jsonl or source-archive. Copy only the retained journal into a new scratch directory.",
      );
  }
}

function sign(
  db: DatabaseSync,
  seed: Uint8Array,
  action: Row,
  body: Row,
  checkExisting = false,
): Carrier {
  if (checkExisting)
    throw new Error(
      "The proposal check cannot sign a new publication or view. Compare the changed source or extraction before another import.",
    );
  const head = (
    db.prepare("SELECT value FROM state WHERE key='head'").get() as any
  )?.value;
  let carrier: Carrier;
  try {
    carrier = createEvent(
      seed,
      head ? [head] : [],
      randomBytes(16).toString("hex"),
      action,
      body,
    ) as Carrier;
  } catch (error) {
    if (typeof error === "string")
      throw new SourceRowError(
        `The extracted publication failed core validation: ${error}`,
      );
    throw error;
  }
  const prepared = prepareAdmission(utf8(canonical(carrier)));
  if (!prepared.action_valid || prepared.body_status !== "present")
    throw new SourceRowError(
      "The extracted publication failed the core schema.",
    );
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
    options.checkExisting,
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
  run: number,
  importer: string,
  checkpoint?: SqlImportOptions["checkpoint"],
) {
  const batch = db.prepare("SELECT * FROM batches WHERE run=?").get(run) as any;
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

async function allocatedProposalBytes(
  directory: string,
  excluded: Set<string>,
): Promise<number> {
  let bytes = 0;
  const visit = async (path: string) => {
    if (excluded.has(path)) return;
    const current = await lstat(path);
    bytes += current.blocks * 512;
    if (current.isDirectory())
      for (const name of await readdir(path)) await visit(join(path, name));
  };
  await visit(directory);
  return bytes;
}

/** Stage joins on disk, retain signed envelopes, then write one carrier at a time. */
export async function importSqlSnapshot(options: SqlImportOptions) {
  const output = resolve(options.output);
  const sourcePath = resolve(options.sourcePath);
  const manifestPath = resolve(options.manifestPath);
  const journalPath = join(output, "journal.sqlite");
  if (options.checkExisting) {
    await requireCheckScratch(output);
    const existing = await stat(journalPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!existing?.isFile() || existing.size === 0)
      throw new Error(
        "The proposal check requires an existing SQL journal. Copy the retained journal before the check.",
      );
  }
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
  try {
    await mkdir(join(output, ".import-lock"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "The output directory is locked. Settle the prior import before another run.",
      );
    throw error;
  }
  let journal: DatabaseSync | undefined;
  let stage: DatabaseSync | undefined;
  const stagePath = join(output, `.sql-stage-${randomUUID()}.sqlite`);
  try {
    if (options.checkExisting) await requireCheckScratch(output);
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
        "journal.json.migrated",
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
    migrateLanguageEvidence(journal);
    let sizeEstimate: ImportSizeEstimate;
    const estimateSize = async (
      stageBytes: number,
      definitionRows: number,
      newPublications: number,
      reuseCommitted = false,
    ) => {
      const retained = journal!
        .prepare(
          "SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(carrier AS BLOB))+1),0) AS bytes FROM (SELECT carrier FROM versions UNION ALL SELECT carrier FROM views)",
        )
        .get()!;
      const oldCarriers = await stat(join(output, "carriers.jsonl")).catch(
        (error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return undefined;
          throw error;
        },
      );
      sizeEstimate = estimateImportArtifacts({
        stage_bytes: stageBytes,
        definition_rows: definitionRows,
        new_publication_count: newPublications,
        existing_journal_bytes: (await stat(journalPath)).size,
        retained_carrier_bytes: Number(retained.bytes),
        retained_carrier_count: Number(retained.count),
        existing_output_carrier_bytes: oldCarriers?.size ?? 0,
        check_existing: options.checkExisting,
        reuse_committed_snapshot: reuseCommitted,
      });
      options.estimate?.(sizeEstimate);
      if (!sizeEstimate.within_budget)
        throw new Error(
          `The estimated ${sizeEstimate.scope} artifacts exceed the ${sizeEstimate.budget_bytes} byte limit. No publications were signed.`,
        );
    };
    const finish = async (run: number) => {
      const result = await exportProposal(
        journal!,
        output,
        run,
        importer,
        options.checkpoint,
      );
      const measurement = compareImportSize(sizeEstimate, {
        proposal_bytes: await allocatedProposalBytes(
          output,
          new Set([
            stagePath,
            `${stagePath}-journal`,
            join(output, ".import-lock"),
          ]),
        ),
        stage_bytes: sizeEstimate.stage_bytes,
      });
      options.measurement?.(measurement);
      return {
        ...result,
        size_estimate: sizeEstimate,
        size_measurement: measurement,
      };
    };
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
    // A verified repeated capture records a new observation without new definitions.
    const currentRun = journal
      .prepare("SELECT value FROM state WHERE key='run'")
      .get()?.value;
    const committed = currentRun
      ? (journal
          .prepare("SELECT * FROM batches WHERE run=?")
          .get(currentRun) as any)
      : undefined;
    if (
      committed &&
      committed.snapshot === manifest.sha256 &&
      committed.manifest !== canonical(manifest)
    )
      throw new Error(
        "The committed SQL batch uses different manifest evidence. Reuse its original manifest.",
      );
    if (
      committed &&
      committed.snapshot === manifest.sha256 &&
      !options.checkExisting
    ) {
      await estimateSize(0, JSON.parse(committed.report).source_rows, 0, true);
      journal.exec("BEGIN IMMEDIATE");
      let run: number;
      try {
        const selection = prepareSelection(utf8(committed.selection));
        const view = publishView(
          journal,
          options,
          manifest,
          importer,
          selection.hash,
        );
        const repeated: SqlReport = JSON.parse(committed.report);
        repeated.added = 0;
        repeated.revised = 0;
        repeated.reverted = 0;
        repeated.enriched = 0;
        repeated.reused = Number(
          journal
            .prepare("SELECT COUNT(*) AS count FROM observations WHERE run=?")
            .get(committed.run)?.count ?? 0,
        );
        run = Number(
          journal
            .prepare(
              "INSERT INTO batches(snapshot,manifest,report,view,selection) VALUES(?,?,?,?,?)",
            )
            .run(
              manifest.sha256,
              canonical(manifest),
              canonical(repeated),
              view,
              committed.selection,
            ).lastInsertRowid,
        );
        journal
          .prepare(
            "INSERT INTO observations SELECT ?,record,snapshot,digest,event,'reused' FROM observations WHERE run=?",
          )
          .run(run, committed.run);
        for (const old of journal
          .prepare("SELECT record,details FROM observation_details WHERE run=?")
          .all(committed.run)) {
          const details = JSON.parse(old.details as string);
          details.disposition = "reused";
          journal
            .prepare("INSERT INTO observation_details VALUES(?,?,?)")
            .run(run, old.record, canonical(details));
        }
        journal
          .prepare("INSERT OR REPLACE INTO state VALUES('run',?)")
          .run(String(run));
        journal.exec("COMMIT");
      } catch (error) {
        journal.exec("ROLLBACK");
        throw error;
      }
      await syncDirectory(output);
      await options.checkpoint?.("journal-durable");
      return await finish(run!);
    }
    const result = report();
    result.declared_rows = manifest.expected_rows;
    stage = new DatabaseSync(stagePath);
    await stageSource(sourcePath, stage, result);
    // Missing rows have no reliable owner. Keep dependent selections unchanged.
    // Extra logical rows still use the existing checks for malformed rows.
    for (const table of new Set([
      ...TABLES,
      ...Object.keys(manifest.expected_rows),
    ])) {
      const expected = manifest.expected_rows[table];
      const actual = TABLES.has(table)
        ? result.logical_table_rows[table]
        : result.table_rows[table];
      const units = TABLES.has(table) ? "logical" : "physical";
      if (
        expected === undefined ||
        actual === undefined ||
        actual !== expected
      ) {
        result.incomplete = true;
        if (
          expected === undefined ||
          actual === undefined ||
          actual < expected
        ) {
          const reason = `The ${table} source evidence is incomplete. ${expected === undefined ? "The manifest row count is unknown." : `The manifest declares ${expected} rows.`} The COPY table ${actual === undefined ? "is absent" : `contains ${actual} ${units} rows`}.`;
          stage
            .prepare("INSERT INTO incomplete_tables VALUES(?,?)")
            .run(table, reason);
        }
        result.notices.push(
          `Manifest row count ${expected === undefined ? "is unknown" : "differs"} for ${table}: declared ${expected ?? "unknown"}, ${units} COPY rows ${actual ?? "absent"}${TABLES.has(table) ? `, physical COPY rows ${result.table_rows[table] ?? "absent"}` : ""}. No source repair was inferred.`,
        );
      }
    }
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
    let newPublications = 0;
    for (const group of stage
      .prepare(
        "SELECT DISTINCT source_id FROM rows WHERE table_name='definitions' ORDER BY source_id",
      )
      .iterate()) {
      try {
        if (
          !planDefinition(
            stage,
            journal,
            group.source_id as number,
            manifest,
            report(),
          ).reuse
        )
          newPublications++;
      } catch (error) {
        if (!(error instanceof SourceRowError)) throw error;
      }
    }
    await estimateSize(stageBytes, definitionRows, newPublications);
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
    let run: number;
    try {
      run = Number(
        journal
          .prepare(
            "INSERT INTO batches(snapshot,manifest,report,view,selection) VALUES(?,?,?,NULL,NULL)",
          )
          .run(manifest.sha256, canonical(manifest), canonical(result))
          .lastInsertRowid,
      );
      const definitions = stage.prepare(
        "SELECT source_id,COUNT(*) AS count FROM rows WHERE table_name='definitions' GROUP BY source_id ORDER BY source_id",
      );
      const seen = new Set<number>(
        stage
          .prepare("SELECT record FROM seen_definitions")
          .all()
          .map((item) => item.record as number),
      );
      for (const group of definitions.iterate()) {
        const id = group.source_id as number;
        seen.add(id);
        journal.exec("SAVEPOINT source_row");
        try {
          const {
            body,
            lexical,
            lexicalDigest,
            entry,
            current,
            baseline,
            reuse,
          } = planDefinition(stage, journal, id, manifest, result);
          let selected: string;
          let disposition: string;
          if (reuse) {
            selected = reuse.event;
            disposition = reuse.disposition;
            result[reuse.disposition]++;
          } else {
            const carrier = sign(
              journal,
              options.seed,
              {
                kind: "definition.publish",
                word: sourceWordId(body.word),
                language: body.language,
                parents: precedingContext(
                  journal,
                  id,
                  current ? JSON.parse(current.carrier) : undefined,
                  body,
                ),
                origin: "import",
              },
              body,
              options.checkExisting,
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
          journal
            .prepare("INSERT OR REPLACE INTO entries VALUES(?,?,?)")
            .run(
              id,
              selected,
              canonical(
                entry && disposition === "reused"
                  ? Object.fromEntries(
                      FIELDS.map((field) => [
                        field,
                        "known" in lexical[field]
                          ? lexical[field]
                          : baseline![field],
                      ]),
                    )
                  : lexical,
              ),
            );
          journal
            .prepare("INSERT INTO observations VALUES(?,?,?,?,?,?)")
            .run(
              run,
              id,
              manifest.sha256,
              lexicalDigest,
              selected,
              disposition,
            );
          journal.prepare("INSERT INTO observation_details VALUES(?,?,?)").run(
            run,
            id,
            canonical({
              snapshot: manifest.sha256,
              lexical_digest: lexicalDigest,
              coverage: FIELDS.filter((field) => "known" in lexical[field]),
              publication: selected,
              disposition,
              extraction: manifest.extraction,
              original: {
                archive: manifest.sha256,
                locator: `definitions/definitionid=${id}`,
              },
            }),
          );
          result.languages[body.language] =
            (result.languages[body.language] ?? 0) + 1;
          journal.exec("RELEASE source_row");
        } catch (error) {
          journal.exec("ROLLBACK TO source_row; RELEASE source_row");
          if (!(error instanceof SourceRowError)) throw error;
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
        .prepare("UPDATE batches SET report=?,view=?,selection=? WHERE run=?")
        .run(canonical(result), view, selection.canonical, run);
      journal
        .prepare("INSERT OR REPLACE INTO state VALUES('snapshot',?)")
        .run(manifest.sha256);
      journal
        .prepare("INSERT OR REPLACE INTO state VALUES('run',?)")
        .run(String(run));
      journal.exec("COMMIT");
    } catch (error) {
      journal.exec("ROLLBACK");
      throw error;
    }
    await syncDirectory(output);
    await options.checkpoint?.("journal-durable");
    return await finish(run!);
  } finally {
    stage?.close();
    journal?.close();
    await rm(stagePath, { force: true });
    await rm(`${stagePath}-journal`, { force: true });
    await rm(join(output, ".import-lock"), { recursive: true });
  }
}
