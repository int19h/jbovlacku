import { convertPlaces } from "./places.ts";
import {
  displayUsername,
  originalField,
  officialRafsiClaims,
  rafsiClaimKey,
  emptyFidelity,
  countFidelity,
} from "./fidelity.ts";
import { randomBytes } from "node:crypto";
import {
  canonicalize,
  contentHash,
  createEvent,
  identityFromSeed,
  prepareAdmission,
  prepareSelection,
  utf8,
  wordId,
} from "../../core/src/index.ts";
import {
  encodeOriginal,
  parseSourceJson,
  sourceInteger,
  sourceObject,
  type SourceValue,
} from "./source-json.ts";

export const EXTRACTION = "lensisku-list-fidelity-v3";
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
export type Lexical = Record<
  (typeof FIELDS)[number],
  { known: unknown } | { unknown: true }
>;
export interface CaptureManifest {
  source: string;
  url: string;
  retrieved_at: string;
  sha256: string;
  extraction: string;
  recipe: "lensisku-definitions-list-v1";
  /** These fields contain placeholders in this endpoint and supply no field coverage. */
  unavailable_fields: string[];
  expected_rows?: number;
}
export interface Carrier {
  envelope: {
    id: string;
    header: {
      issuer: string;
      previous: string[];
      content: { hash: string; bytes: number } | null;
      action: Record<string, unknown>;
    };
    signature: string;
  };
  body: Record<string, any>;
}
interface Version {
  lexical: Lexical;
  digest: string;
  carrier: Carrier;
}
interface Entry {
  selected: string;
  baseline: Lexical;
  versions: Version[];
  observations: {
    snapshot: string;
    lexical_digest: string;
    coverage: string[];
    publication: string;
    disposition: string;
    extraction?: string;
    original: unknown;
  }[];
}
export interface Journal {
  format: "jbovlacku-import-journal-v1";
  source: string;
  importer: string;
  head: string | null;
  entries: Record<string, Entry>;
  views: Carrier[];
  rafsi_claims?: Carrier[];
  /** Last durable run read by this proposal. It prevents stale writes. */
  ledger_run?: number;
}
export interface ImportOptions {
  sourceBytes: Uint8Array;
  manifest: CaptureManifest;
  seed: Uint8Array;
  roots: { identity: string; q: { numerator: number; denominator: number } }[];
  journal?: Journal;
}
export interface ImportResult {
  journal: Journal;
  carriers: Carrier[];
  selection: { hash: string; canonical: string; ids: string[] };
  view: Carrier;
  report: {
    fidelity: ReturnType<typeof emptyFidelity>;
    source_rows: number;
    added: number;
    revised: number;
    reused: number;
    reverted: number;
    enriched: number;
    duplicates: number;
    conflicts: number[];
    incomplete: boolean;
    unresolved: { record: number | null; locator: string; reason: string }[];
    omitted: number[];
    notices: string[];
  };
}
export const canonical = (value: unknown): string =>
  canonicalize(utf8(JSON.stringify(value)));
const digest = (value: unknown): string => contentHash(utf8(canonical(value)));
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const known = (value: unknown) => ({ known: value });
const unknown = () => ({ unknown: true as const });
const stringOrNull = (value: SourceValue | undefined): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string")
    throw new Error("A source text field must contain a string or null.");
  return value;
};
const literal = (value: string | null): string[][] =>
  value === null || value === "" ? [] : [[value]];

function sourceKind(
  row: Record<string, SourceValue>,
  manifest: CaptureManifest,
): string {
  if (
    manifest.unavailable_fields.includes("type_name") ||
    typeof row.type_name !== "string" ||
    row.type_name === ""
  )
    throw new Error(
      "The source type_name is unavailable. No grammatical classification was published.",
    );
  if (
    !Object.hasOwn(row, "selmaho") ||
    manifest.unavailable_fields.includes("selmaho")
  )
    throw new Error(
      "The source classification evidence is incomplete because selmaho is unavailable. No grammatical classification was published.",
    );
  stringOrNull(row.selmaho);
  return row.type_name;
}

function extract(
  row: Record<string, SourceValue>,
  manifest: CaptureManifest,
): Lexical {
  const unavailable = new Set(manifest.unavailable_fields);
  const field = (key: string) =>
    Object.hasOwn(row, key) && !unavailable.has(key)
      ? known(encodeOriginal(row[key]))
      : unknown();
  const keyword = (key: string) => {
    if (!Object.hasOwn(row, key) || unavailable.has(key)) return unknown();
    if (row[key] === null) return known(null);
    if (!Array.isArray(row[key]))
      throw new Error(`The ${key} source field must contain an array or null.`);
    const values = row[key].map((item) => {
      const record = sourceObject(item);
      if (typeof record.word !== "string")
        throw new Error("A source keyword requires its word.");
      return { word: record.word, meaning: stringOrNull(record.meaning) };
    });
    values.sort((a, b) =>
      Buffer.compare(Buffer.from(canonical(a)), Buffer.from(canonical(b))),
    );
    return known(values);
  };
  const rafsi = (key: string) => {
    if (!Object.hasOwn(row, key) || unavailable.has(key)) return unknown();
    const value = stringOrNull(row[key]);
    return known(
      value === null
        ? []
        : [...new Set(value.split(/[\t\n\r\f\v ]+/).filter(Boolean))].sort(
            (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)),
          ),
    );
  };
  return {
    word: field("valsiword"),
    language:
      Object.hasOwn(row, "langid") && !unavailable.has("langid")
        ? known({ source_id: encodeOriginal(row.langid), tag: "en" })
        : unknown(),
    text: field("definition"),
    notes: field("notes"),
    etymology: field("etymology"),
    classification:
      Object.hasOwn(row, "type_name") &&
      row.type_name !== null &&
      !unavailable.has("type_name") &&
      Object.hasOwn(row, "selmaho") &&
      !unavailable.has("selmaho")
        ? known({
            kind: encodeOriginal(row.type_name),
            selmaho: encodeOriginal(row.selmaho),
          })
        : unknown(),
    labels: field("jargon"),
    glosses: keyword("gloss_keywords"),
    place_keywords: keyword("place_keywords"),
    place_keyword_indices: unknown(),
    official_rafsi: rafsi("official_rafsi"),
    experimental_rafsi: rafsi("experimental_rafsi"),
  };
}
const coverage = (lexical: Lexical) =>
  FIELDS.filter((field) => "known" in lexical[field]);
const conflicts = (a: Lexical, b: Lexical) =>
  FIELDS.some(
    (field) =>
      "known" in a[field] && "known" in b[field] && !same(a[field], b[field]),
  );
const mergeCoverage = (a: Lexical, b: Lexical): Lexical =>
  Object.fromEntries(
    FIELDS.map((field) => [field, "known" in b[field] ? b[field] : a[field]]),
  ) as Lexical;

function sourceReference(
  manifest: CaptureManifest,
  locator: string,
  event: string | null = null,
) {
  return {
    label: "Pinned Lensisku source capture",
    url: manifest.url,
    event,
    locator,
  };
}

const OMITTED_FIELDS = new Set([
  "embedding",
  "similarity",
  "can_edit",
  "user_vote",
  "comment_count",
  "has_image",
  "sound_url",
  "langrealname",
  "metadata",
  "canonical_word",
  "processed_text",
]);
function retainedOriginal(row: Record<string, SourceValue>): unknown {
  const original = encodeOriginal(row) as Record<string, unknown>;
  const escaped =
    Object.hasOwn(row, "$source_number") ||
    Object.hasOwn(row, "$source_object");
  const pairs = escaped
    ? (original.$source_object as [string, unknown][])
    : Object.entries(original);
  const retained = pairs.filter(
    ([key]) => !OMITTED_FIELDS.has(key) && !key.startsWith("cached_"),
  );
  return escaped ? { $source_object: retained } : Object.fromEntries(retained);
}

function definition(
  row: Record<string, SourceValue>,
  id: number,
  manifest: CaptureManifest,
  prior: Version | undefined,
): Record<string, any> {
  const spelling = stringOrNull(row.valsiword);
  if (spelling === null || !Object.hasOwn(row, "definition"))
    throw new Error(
      "A publication requires the source spelling and definition field.",
    );
  const languageId = sourceInteger(row.langid);
  if (languageId !== 2)
    throw new Error(`Unmapped source language ID: ${languageId}.`);
  const locator = `definitions/definitionid=${id}`;
  const url = new URL(manifest.url);
  const filteredAuthor =
    url.pathname === "/api/jbovlaste/definitions/list"
      ? url.searchParams.get("user_id")
      : null;
  const explicitAuthor =
    row.user_id === undefined ? null : sourceInteger(row.user_id);
  if (
    explicitAuthor !== null &&
    filteredAuthor !== null &&
    explicitAuthor !== Number(filteredAuthor)
  )
    throw new Error(
      "The explicit author differs from the numeric capture filter.",
    );
  const account =
    explicitAuthor ??
    (filteredAuthor !== null &&
    /^[1-9][0-9]*$/.test(filteredAuthor) &&
    Number.isSafeInteger(Number(filteredAuthor))
      ? Number(filteredAuthor)
      : null);
  const username = displayUsername(row.username);
  const original = retainedOriginal(row) as Record<string, any>;
  const converted = convertPlaces(
    stringOrNull(row.definition),
    originalField(original, "definition").pointer,
  );
  const kind = sourceKind(row, manifest);
  const classification =
    (
      {
        "cmavo-compound": "compound",
        "bu-letteral": "letteral",
        "fu'ivla": "fuhivla",
      } as Record<string, string>
    )[kind ?? ""] ?? kind;
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
  const limitations = [
    "Only the main definition receives place annotations. Notes, etymology, examples, and source history remain literal.",
    "This capture does not supply authenticated individual votes or historical edit coverage.",
    "Explicit x-place forms use a context frame. Unindexed place keywords remain source evidence.",
    "The source capture does not include a rights statement. Rights remain unknown.",
    `Unavailable endpoint fields: ${manifest.unavailable_fields.join(", ")}.`,
    "Known official rafsi can produce separate imported claims. Experimental rafsi remain source evidence.",
    "The extraction omits embedding, similarity, can_edit, user_vote, comment_count, has_image, sound_url, langrealname, metadata, cached_*, canonical_word, and processed_text. These derived, display, and viewer values remain in the exact source archive.",
    "Joined usernames supply display evidence only. An explicit numeric author or capture filter supplies account evidence.",
  ];
  const omittedFields = [
    "notes",
    "type_name",
    "etymology",
    "selmaho",
    "jargon",
    "gloss_keywords",
    "place_keywords",
    "official_rafsi",
    "experimental_rafsi",
  ].filter((field) => !Object.hasOwn(row, field));
  if (omittedFields.length)
    limitations.push(
      `Fields omitted from this source row remain unavailable: ${omittedFields.join(", ")}. Empty display values do not establish empty source values.`,
    );
  if (account === null)
    limitations.push(
      "This capture does not establish a numeric source author.",
    );
  const mappedKind = supported.has(classification ?? "")
    ? classification
    : "other";
  if (kind !== mappedKind)
    limitations.push(`Source classification ${kind} maps to ${mappedKind}.`);
  const dates = Object.fromEntries(
    ["created_at", "updated_at"]
      .filter((key) => typeof row[key] === "string")
      .map((key) => [key, row[key]]),
  );
  return {
    word: { language: "jbo", spelling: spelling.normalize("NFC") },
    language: "en",
    text: converted.text,
    frame: converted.frame,
    operands: [],
    glosses: [],
    notes: literal(stringOrNull(row.notes)),
    etymology: {
      text: literal(stringOrNull(row.etymology)),
      formation: null,
      compound: null,
    },
    examples: [],
    classification: {
      kind: mappedKind,
      selmaho:
        !manifest.unavailable_fields.includes("selmaho") &&
        typeof row.selmaho === "string" &&
        row.selmaho !== ""
          ? [row.selmaho]
          : [],
    },
    labels: [],
    sources: [
      sourceReference(manifest, locator, prior?.carrier.envelope.id ?? null),
      ...(username
        ? [
            {
              ...sourceReference(manifest, `${locator}/username`),
              label: "Joined Lensisku username for display only",
            },
          ]
        : []),
    ],
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
      original,
      attribution: {
        author: username,
        editor: null,
        author_account:
          account === null
            ? null
            : {
                origin: new URL(manifest.source).origin,
                account,
                username,
                evidence: {
                  kind: "source-id",
                  source: sourceReference(manifest, locator),
                },
              },
        dates,
      },
      conversion: converted.conversion,
      limitations,
    },
  };
}

export function importCapture(options: ImportOptions): ImportResult {
  const { manifest, seed, sourceBytes } = options;
  if (
    manifest.extraction !== EXTRACTION ||
    manifest.recipe !== "lensisku-definitions-list-v1"
  )
    throw new Error("The capture extraction recipe is unsupported.");
  if (
    new URL(manifest.source).protocol !== "https:" ||
    new URL(manifest.source).origin !== manifest.source ||
    new URL(manifest.url).origin !== manifest.source
  )
    throw new Error(
      "The capture URL must belong to its canonical HTTPS source origin.",
    );
  if (!Number.isFinite(Date.parse(manifest.retrieved_at)))
    throw new Error("The source retrieval date is invalid.");
  if (contentHash(sourceBytes) !== manifest.sha256)
    throw new Error("The source bytes do not match the pinned digest.");
  const importer = identityFromSeed(seed);
  const journal: Journal = options.journal
    ? structuredClone(options.journal)
    : {
        format: "jbovlacku-import-journal-v1",
        source: manifest.source,
        importer,
        head: null,
        entries: {},
        views: [],
      };
  if (
    journal.format !== "jbovlacku-import-journal-v1" ||
    journal.source !== manifest.source ||
    journal.importer !== importer
  )
    throw new Error("The journal belongs to another source or importer.");
  const retained = Object.values(journal.entries)
    .flatMap((entry) => entry.versions.map((version) => version.carrier))
    .concat(journal.views, journal.rafsi_claims ?? []);
  const retainedIds = new Set<string>();
  for (const carrier of retained) {
    const admitted = prepareAdmission(utf8(canonical(carrier)));
    if (
      !admitted.action_valid ||
      admitted.body_status !== "present" ||
      carrier.envelope.header.issuer !== importer
    )
      throw new Error("The journal contains an invalid publication.");
    retainedIds.add(carrier.envelope.id);
  }
  if (journal.head !== null && !retainedIds.has(journal.head))
    throw new Error(
      "The journal head lacks its original envelope. Rebuild the journal before import.",
    );
  for (const [id, entry] of Object.entries(journal.entries)) {
    if (
      !entry.versions.some(
        (version) => version.carrier.envelope.id === entry.selected,
      )
    )
      throw new Error("The journal selection lacks its original envelope.");
    for (const version of entry.versions) {
      if (
        digest(version.lexical) !== version.digest ||
        version.carrier.body.legacy?.source !== manifest.source ||
        String(version.carrier.body.legacy?.record?.id) !== id ||
        version.carrier.envelope.header.action.kind !== "definition.publish"
      )
        throw new Error(
          "The journal source record or lexical digest is inconsistent.",
        );
    }
  }
  for (const claim of journal.rafsi_claims ?? [])
    if (
      claim.envelope.header.action.kind !== "rafsi.publish" ||
      claim.envelope.header.action.origin !== "import" ||
      claim.body.legacy?.source !== manifest.source
    )
      throw new Error("The journal contains an invalid imported rafsi claim.");
  const retainedPrevious = retained.flatMap(
    (carrier) => carrier.envelope.header.previous,
  );
  if (retainedPrevious.some((id) => !retainedIds.has(id)))
    throw new Error("The journal lacks a retained predecessor envelope.");
  const predecessors = new Set(retainedPrevious);
  const maxima = [...retainedIds].filter((id) => !predecessors.has(id));
  if (
    maxima.length !== (retainedIds.size ? 1 : 0) ||
    (maxima.length && maxima[0] !== journal.head)
  )
    throw new Error(
      "The journal head does not name its complete signed frontier.",
    );
  // Old lexical bookkeeping can change. Original signed carriers stay unchanged.
  for (const entry of Object.values(journal.entries)) {
    for (const version of entry.versions) {
      const language = version.lexical.language;
      if (
        "known" in language &&
        !(
          language.known &&
          typeof language.known === "object" &&
          "source_id" in language.known
        )
      ) {
        version.lexical.language = known({
          source_id: language.known,
          tag: version.carrier.body.language,
        });
        version.digest = digest(version.lexical);
      }
    }
    const selected = entry.versions.find(
      (version) => version.carrier.envelope.id === entry.selected,
    )!;
    const language = entry.baseline.language;
    if (
      "known" in language &&
      !(
        language.known &&
        typeof language.known === "object" &&
        "source_id" in language.known
      )
    )
      entry.baseline.language = known({
        source_id: language.known,
        tag: selected.carrier.body.language,
      });
  }
  const parsed = sourceObject(
    parseSourceJson(
      new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes),
    ),
  );
  if (!Array.isArray(parsed.definitions))
    throw new Error("The source capture requires a definitions array.");
  if (
    manifest.expected_rows !== undefined &&
    parsed.definitions.length !== manifest.expected_rows
  )
    throw new Error("The source row count does not match the manifest.");
  const report: ImportResult["report"] = {
    fidelity: emptyFidelity(),
    source_rows: parsed.definitions.length,
    added: 0,
    revised: 0,
    reused: 0,
    reverted: 0,
    enriched: 0,
    duplicates: 0,
    conflicts: [],
    incomplete: false,
    unresolved: [],
    omitted: [],
    notices: [],
  };
  const rows = new Map<number, Record<string, SourceValue>>();
  const seenIds = new Set<number>();
  const conflictingIds = new Set<number>();
  const unresolved = (
    record: number | null,
    locator: string,
    reason: string,
  ) => {
    report.incomplete = true;
    report.unresolved.push({ record, locator, reason });
    report.notices.push(
      `Incomplete import at ${locator}: ${reason} The exact source row remains in the capture archive.`,
    );
  };
  for (const [position, sourceRow] of parsed.definitions.entries()) {
    let id: number | null = null;
    try {
      const row = sourceObject(sourceRow);
      id = sourceInteger(row.definitionid);
      seenIds.add(id);
      const previous = rows.get(id);
      if (previous) {
        if (same(encodeOriginal(previous), encodeOriginal(row)))
          report.duplicates++;
        else conflictingIds.add(id);
      } else rows.set(id, row);
    } catch (error) {
      if (id !== null && rows.has(id)) conflictingIds.add(id);
      unresolved(
        id,
        `definitions/${position}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  report.conflicts = [...conflictingIds].sort((a, b) => a - b);
  for (const id of report.conflicts) {
    rows.delete(id);
    unresolved(
      id,
      `definitions/definitionid=${id}`,
      "Conflicting duplicate source rows share this definition ID. No row version was selected.",
    );
  }
  const sign = (
    action: Record<string, unknown>,
    body: Record<string, any>,
  ): Carrier => {
    const carrier = createEvent(
      seed,
      journal.head === null ? [] : [journal.head],
      randomBytes(16).toString("hex"),
      action,
      body,
    ) as Carrier;
    const admission = prepareAdmission(utf8(canonical(carrier)));
    if (!admission.action_valid || admission.body_status !== "present")
      throw new Error("The extracted publication failed the core schema.");
    journal.head = carrier.envelope.id;
    return carrier;
  };
  for (const [id, row] of [...rows].sort(([a], [b]) => a - b)) {
    try {
      sourceKind(row, manifest);
      const lexical = extract(row, manifest),
        lexicalDigest = digest(lexical);
      for (const field of ["official_rafsi", "experimental_rafsi"] as const) {
        const value = lexical[field];
        if (
          "known" in value &&
          Array.isArray(value.known) &&
          value.known.some(
            (token) =>
              typeof token === "string" &&
              /[\p{White_Space}\ufeff]/u.test(token),
          )
        )
          report.notices.push(
            `Definition ${id}: ${field} contains non-ASCII whitespace inside a preserved rafsi token. Review the original source value.`,
          );
      }
      const entry = journal.entries[String(id)];
      let disposition = "added";
      if (entry) {
        const current = entry.versions.find(
          (version) => version.carrier.envelope.id === entry.selected,
        )!;
        const original = encodeOriginal(row) as Record<string, unknown>;
        if (
          ["user_id", "username", "created_at", "updated_at"].some(
            (field) =>
              Object.hasOwn(original, field) &&
              !same(
                original[field],
                current.carrier.body.legacy.original[field] ?? null,
              ),
          )
        )
          report.notices.push(
            `Definition ${id}: attribution or source dates changed. This observation does not create a lexical edit.`,
          );
        const priorVersions = entry.versions.filter(
          (version) => version.carrier.envelope.id !== entry.selected,
        );
        const exactMatches = priorVersions.filter(
          (version) => version.digest === lexicalDigest,
        );
        const matches = exactMatches.length
          ? exactMatches
          : priorVersions.filter(
              (version) => !conflicts(version.lexical, lexical),
            );
        const past = matches.length === 1 ? matches[0] : undefined;
        if (conflicts(entry.baseline, lexical) && matches.length > 1) {
          unresolved(
            id,
            `definitions/definitionid=${id}`,
            "The partial capture agrees with multiple prior revisions. Source reversion remains unresolved.",
          );
          disposition = "unresolved-reversion";
        } else if (past && conflicts(entry.baseline, lexical)) {
          entry.selected = past.carrier.envelope.id;
          entry.baseline = mergeCoverage(past.lexical, lexical);
          report.reverted++;
          disposition = "reverted";
        } else if (!conflicts(entry.baseline, lexical)) {
          const enrichment = coverage(lexical).some(
            (field) => !("known" in entry.baseline[field]),
          );
          entry.baseline = mergeCoverage(entry.baseline, lexical);
          report.reused++;
          disposition = enrichment ? "enriched-observation" : "reused";
          if (enrichment) report.enriched++;
          if (!same(current.lexical, lexical))
            report.notices.push(
              `Definition ${id}: field coverage or nonlexical provenance changed. The publication remains unchanged.`,
            );
        } else {
          const body = definition(row, id, manifest, current);
          const sameContext = (version: Version) =>
            same(body.word, version.carrier.body.word) &&
            body.language === version.carrier.body.language;
          const observedParent = [...entry.observations]
            .reverse()
            .map((observation) =>
              entry.versions.find(
                (version) =>
                  version.carrier.envelope.id === observation.publication,
              ),
            )
            .find((version) => version !== undefined && sameContext(version));
          const contextParent = sameContext(current)
            ? current
            : (observedParent ??
              [...entry.versions].reverse().find(sameContext));
          const carrier = sign(
            {
              kind: "definition.publish",
              word: wordId(body.word),
              language: body.language,
              parents: contextParent ? [contextParent.carrier.envelope.id] : [],
              origin: "import",
            },
            body,
          );
          entry.versions.push({ lexical, digest: lexicalDigest, carrier });
          entry.selected = carrier.envelope.id;
          entry.baseline = lexical;
          report.revised++;
          disposition = "revised";
        }
      } else {
        const body = definition(row, id, manifest, undefined);
        const carrier = sign(
          {
            kind: "definition.publish",
            word: wordId(body.word),
            language: body.language,
            parents: [],
            origin: "import",
          },
          body,
        );
        journal.entries[String(id)] = {
          selected: carrier.envelope.id,
          baseline: lexical,
          versions: [{ lexical, digest: lexicalDigest, carrier }],
          observations: [],
        };
        report.added++;
      }
      const final = journal.entries[String(id)];
      const lastObservation = final.observations.at(-1);
      if (
        journal.ledger_run !== undefined ||
        lastObservation?.snapshot !== manifest.sha256 ||
        lastObservation?.lexical_digest !== lexicalDigest ||
        lastObservation?.extraction !== manifest.extraction
      )
        final.observations.push({
          snapshot: manifest.sha256,
          lexical_digest: lexicalDigest,
          coverage: coverage(lexical),
          publication: final.selected,
          disposition,
          extraction: manifest.extraction,
          original: {
            archive: manifest.sha256,
            locator: `definitions/definitionid=${id}`,
          },
        });
    } catch (error) {
      unresolved(
        id,
        `definitions/definitionid=${id}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  report.omitted = Object.keys(journal.entries)
    .map(Number)
    .filter((id) => !seenIds.has(id))
    .sort((a, b) => a - b);
  if (report.omitted.length)
    report.notices.push(
      "Rows absent from this capture remain selected. Absence does not prove source deletion.",
    );
  const ids: string[] = [];
  const claims = new Set<string>();
  for (const entry of Object.values(journal.entries)) {
    const version = entry.versions.find(
      (item) => item.carrier.envelope.id === entry.selected,
    )!;
    ids.push(entry.selected);
    countFidelity(report.fidelity, version.carrier);
    for (const claim of officialRafsiClaims(version.carrier, version.lexical)) {
      journal.rafsi_claims ??= [];
      let carrier = journal.rafsi_claims.find(
        (item) => rafsiClaimKey(item.body) === claim.key,
      );
      if (!carrier) {
        carrier = sign(claim.action, claim.body);
        journal.rafsi_claims.push(carrier);
      }
      claims.add(carrier.envelope.id);
    }
  }
  report.fidelity.official_rafsi_claims = claims.size;
  ids.push(...claims);
  ids.sort();
  const prepared = prepareSelection(utf8(canonical(ids)));
  const selection = {
    hash: prepared.hash,
    canonical: prepared.canonical,
    ids: prepared.ids,
  };
  const roots = [...options.roots].sort((a, b) =>
    a.identity.localeCompare(b.identity),
  );
  const viewBody = {
    name: "Pinned Lensisku import",
    description: [["Literal extraction of a pinned local Lensisku capture."]],
    roots,
    rafsi_threshold: { numerator: 1, denominator: 1 },
    H: { numerator: 3, denominator: 1 },
    alpha: { numerator: 1, denominator: 2 },
    excluded: [],
    calculation: "simple-routes-bounds-v1",
    work: 1_000_000,
    import_sets: [
      { source: manifest.source, importer, selection: selection.hash },
    ],
    account_witnesses: [],
    account_authority: false,
    notes: [
      [
        "The operator chose these roots. Legacy ranking scores grant no influence.",
      ],
    ],
  };
  let view = journal.views.find((carrier) => same(carrier.body, viewBody));
  if (!view) {
    view = sign(
      {
        kind: "view.publish",
        parents: journal.views.length
          ? [journal.views[journal.views.length - 1].envelope.id]
          : [],
      },
      viewBody,
    );
    journal.views.push(view);
  }
  const carriers = Object.values(journal.entries)
    .flatMap((entry) => entry.versions.map((version) => version.carrier))
    .concat(journal.views, journal.rafsi_claims ?? [])
    .sort((a, b) => a.envelope.id.localeCompare(b.envelope.id));
  return { journal, carriers, selection, view, report };
}
