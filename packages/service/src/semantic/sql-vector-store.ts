import {
  canonicalBytes,
  inputHash,
  parseProfile,
  profileId,
} from "./profile.ts";
import { SemanticError, type EmbeddingProfile } from "./types.ts";
import { vectorBytes, vectorFromBytes } from "./vector.ts";
import type { DocumentPage, IndexContext } from "./source.ts";
import type { EmbeddingUsage } from "../embedding.ts";
import { MAX_PROFILE_COOLDOWN_MS } from "./vector-store.ts";
import type {
  IndexBatch,
  IndexGeneration,
  VectorStore,
  VectorAssociation,
} from "./vector-store.ts";

/** Hosts supply binary SQL bindings and atomic transactions. No provider work runs in a transaction. */
export interface VectorSqlConnection {
  exec(
    sql: string,
    ...bindings: (string | number | Uint8Array | null)[]
  ): Record<string, unknown>[];
  transaction<T>(operation: () => T): T;
}
export interface VectorLimits {
  associations: number;
  vectors: number;
  bytes: number;
}
export const DEFAULT_VECTOR_LIMITS: VectorLimits = {
  associations: 300000,
  vectors: 100000,
  bytes: 2 * 1024 ** 3,
};
const fail = (code: string, message: string): never => {
  throw new SemanticError(409, code, message);
};
const hash = (value: string, prefix = "sha256:") =>
  new RegExp(`^${prefix}[a-f0-9]{64}$`).test(value);
const boundedPage = (limit: number, maximum = 128) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum)
    throw new SemanticError(
      400,
      "semantic_page",
      `A page permits one through ${maximum} rows.`,
    );
};

export class SqlVectorStore implements VectorStore {
  constructor(
    private sql: VectorSqlConnection,
    private limits = DEFAULT_VECTOR_LIMITS,
  ) {
    if (Object.values(limits).some((n) => !Number.isSafeInteger(n) || n < 1))
      throw new Error("The vector store limits are invalid.");
    for (const statement of [
      "CREATE TABLE IF NOT EXISTS semantic_profiles(id TEXT PRIMARY KEY, value BLOB NOT NULL)",
      "CREATE TABLE IF NOT EXISTS semantic_profile_suspensions(profile TEXT PRIMARY KEY, reason TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS semantic_profile_backoff(profile TEXT PRIMARY KEY, retry_after INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS semantic_generations(id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, view TEXT NOT NULL, profile TEXT NOT NULL, eligible INTEGER NOT NULL, state TEXT NOT NULL, cursor TEXT, source_done INTEGER NOT NULL DEFAULT 0, error TEXT)",
      "CREATE TABLE IF NOT EXISTS semantic_associations(generation TEXT NOT NULL, event TEXT NOT NULL, envelope TEXT NOT NULL, body TEXT NOT NULL, extraction_version INTEGER NOT NULL, word TEXT NOT NULL, language TEXT NOT NULL, input TEXT, error TEXT, PRIMARY KEY(generation,event))",
      "CREATE INDEX IF NOT EXISTS semantic_association_inputs ON semantic_associations(generation,input)",
      "CREATE INDEX IF NOT EXISTS semantic_association_input_lookup ON semantic_associations(input,generation)",
      "CREATE INDEX IF NOT EXISTS semantic_association_language ON semantic_associations(generation,language,event)",
      "CREATE TABLE IF NOT EXISTS semantic_inputs(profile TEXT NOT NULL, input TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(profile,input))",
      "CREATE TABLE IF NOT EXISTS semantic_vectors(profile TEXT NOT NULL, input TEXT NOT NULL, bytes BLOB NOT NULL, operation TEXT NOT NULL, PRIMARY KEY(profile,input))",
      "CREATE TABLE IF NOT EXISTS semantic_batches(id TEXT PRIMARY KEY, generation TEXT NOT NULL, state TEXT NOT NULL, operation TEXT, previous TEXT, inputs TEXT NOT NULL, error TEXT, usage TEXT, retry INTEGER NOT NULL DEFAULT 0)",
      "CREATE INDEX IF NOT EXISTS semantic_batch_generation ON semantic_batches(generation,id)",
      "CREATE INDEX IF NOT EXISTS semantic_batch_retry ON semantic_batches(generation,retry,id)",
      "CREATE INDEX IF NOT EXISTS semantic_batch_active ON semantic_batches(generation,id) WHERE state IN ('prepared','sent')",
      "CREATE TABLE IF NOT EXISTS semantic_batch_inputs(generation TEXT NOT NULL, input TEXT NOT NULL, batch TEXT NOT NULL, PRIMARY KEY(generation,input))",
      "CREATE TABLE IF NOT EXISTS semantic_capacity_reservations(batch TEXT PRIMARY KEY, vectors INTEGER NOT NULL, bytes INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS semantic_current(profile TEXT NOT NULL, view TEXT NOT NULL, generation TEXT NOT NULL, rollback TEXT, PRIMARY KEY(profile,view))",
      "CREATE TABLE IF NOT EXISTS semantic_usage(id INTEGER PRIMARY KEY CHECK(id=1), associations INTEGER NOT NULL, vectors INTEGER NOT NULL, bytes INTEGER NOT NULL)",
      "INSERT OR IGNORE INTO semantic_usage VALUES(1,0,0,0)",
    ])
      sql.exec(statement);
    sql.transaction(() => {
      if (
        !sql
          .exec("PRAGMA table_info(semantic_generations)")
          .some((column) => column.name === "claim_cursor")
      ) {
        sql.exec(
          "ALTER TABLE semantic_generations ADD COLUMN claim_cursor TEXT NOT NULL DEFAULT ''",
        );
        // Earlier claims already own every fresh input through this position.
        sql.exec(
          "UPDATE semantic_generations SET claim_cursor=COALESCE((SELECT MAX(input) FROM semantic_batch_inputs WHERE generation=semantic_generations.id),'')",
        );
      }
      // Reconstruct reservations for interrupted jobs from earlier store versions.
      for (const row of sql.exec(
        `SELECT b.id,b.inputs,p.value FROM semantic_batches b
        JOIN semantic_generations g ON g.id=b.generation
        JOIN semantic_profiles p ON p.id=g.profile
        WHERE b.state IN ('prepared','sent')
        AND NOT EXISTS (SELECT 1 FROM semantic_capacity_reservations r WHERE r.batch=b.id)`,
      )) {
        const count = (JSON.parse(String(row.inputs)) as string[]).length;
        const dimension = parseProfile(row.value as Uint8Array).dimension;
        sql.exec(
          "INSERT INTO semantic_capacity_reservations VALUES(?,?,?)",
          String(row.id),
          count,
          count * dimension * 4,
        );
      }
    });
  }
  private generationRow(id: string): IndexGeneration {
    const row = this.sql.exec(
      "SELECT * FROM semantic_generations WHERE id=?",
      id,
    )[0];
    if (!row)
      return fail(
        "semantic_generation",
        "The index generation is unavailable.",
      );
    return {
      id,
      snapshot: String(row.snapshot),
      view: String(row.view),
      profile: String(row.profile),
      eligible: Number(row.eligible),
      state: row.state as IndexGeneration["state"],
      cursor: row.cursor === null ? null : String(row.cursor),
      source_done: Boolean(row.source_done),
      error: row.error === null ? null : String(row.error),
    };
  }
  async published(view: string): Promise<IndexGeneration[]> {
    return this.sql
      .exec(
        "SELECT generation FROM semantic_current WHERE view=? ORDER BY profile LIMIT 64",
        view,
      )
      .map((row) => this.generationRow(String(row.generation)));
  }
  async references(id: string) {
    const generation = this.active(id);
    this.compatible(generation.profile);
    return this.sql
      .exec(
        `SELECT i.bytes AS input,v.bytes AS vector FROM semantic_associations a
      JOIN semantic_inputs i ON i.profile=? AND i.input=a.input
      JOIN semantic_vectors v ON v.profile=i.profile AND v.input=i.input
      WHERE a.generation=? AND a.error IS NULL ORDER BY a.event LIMIT 2`,
        generation.profile,
        id,
      )
      .map((row) => ({
        input: row.input as Uint8Array,
        vector: row.vector as Uint8Array,
      }));
  }
  private active(id: string): IndexGeneration {
    const generation = this.generationRow(id);
    if (generation.state === "retired")
      fail("semantic_retired", "The index generation is retired.");
    return generation;
  }
  private capacity(associations: number, vectors: number, bytes: number) {
    const row = this.sql.exec("SELECT * FROM semantic_usage WHERE id=1")[0];
    const reserved = this.sql.exec(
      "SELECT COALESCE(SUM(vectors),0) AS vectors,COALESCE(SUM(bytes),0) AS bytes FROM semantic_capacity_reservations",
    )[0];
    return (
      Number(row.associations) + associations <= this.limits.associations &&
      Number(row.vectors) + Number(reserved.vectors) + vectors <=
        this.limits.vectors &&
      Number(row.bytes) + Number(reserved.bytes) + bytes <= this.limits.bytes
    );
  }
  private allocation(associations: number, vectors: number, bytes: number) {
    if (
      (associations > 0 || vectors > 0 || bytes > 0) &&
      !this.capacity(associations, vectors, bytes)
    )
      fail(
        "semantic_capacity",
        "The document vector store reached its capacity. Retire an unused generation before another attempt.",
      );
    this.sql.exec(
      "UPDATE semantic_usage SET associations=associations+?, vectors=vectors+?, bytes=bytes+? WHERE id=1",
      associations,
      vectors,
      bytes,
    );
  }
  async create(
    context: IndexContext,
    profile: EmbeddingProfile,
  ): Promise<IndexGeneration> {
    const identity = profileId(profile);
    if (
      identity !== context.profile ||
      !hash(context.snapshot) ||
      !hash(context.view, "jve1:") ||
      !Number.isInteger(context.eligible) ||
      context.eligible < 0 ||
      context.eligible > this.limits.associations
    )
      fail("semantic_context", "The indexing context is invalid.");
    const id = crypto.randomUUID();
    this.sql.transaction(() => {
      const count = Number(
        this.sql.exec(
          "SELECT COUNT(*) AS n FROM semantic_generations WHERE state!='retired'",
        )[0].n,
      );
      if (count >= 64)
        fail(
          "semantic_capacity",
          "Retire an unused generation before creating another.",
        );
      this.sql.exec(
        "INSERT OR IGNORE INTO semantic_profiles VALUES(?,?)",
        identity,
        canonicalBytes(profile),
      );
      this.sql.exec(
        "INSERT INTO semantic_generations(id,snapshot,view,profile,eligible,state) VALUES(?,?,?,?,?,'paused')",
        id,
        context.snapshot,
        context.view,
        identity,
        context.eligible,
      );
    });
    return this.generationRow(id);
  }
  async generation(id: string) {
    return this.generationRow(id);
  }
  async compatibility(profile: string): Promise<string | null> {
    return (
      (this.sql.exec(
        "SELECT reason FROM semantic_profile_suspensions WHERE profile=?",
        profile,
      )[0]?.reason as string) ?? null
    );
  }
  async suspend(profile: string, reason: string): Promise<void> {
    if (!hash(profile) || !reason)
      fail("semantic_profile", "The profile suspension is invalid.");
    this.sql.exec(
      "INSERT INTO semantic_profile_suspensions VALUES(?,?) ON CONFLICT(profile) DO NOTHING",
      profile,
      reason,
    );
  }
  async defer(profile: string, until: number, now = Date.now()): Promise<void> {
    if (
      !hash(profile) ||
      !Number.isSafeInteger(until) ||
      until < 0 ||
      !Number.isSafeInteger(now) ||
      now < 0
    )
      fail("semantic_backoff", "The embedding retry deadline is invalid.");
    const maximum = Math.min(
      Number.MAX_SAFE_INTEGER,
      now + MAX_PROFILE_COOLDOWN_MS,
    );
    this.sql.exec(
      "INSERT INTO semantic_profile_backoff VALUES(?,?) ON CONFLICT(profile) DO UPDATE SET retry_after=MIN(MAX(retry_after,excluded.retry_after),?)",
      profile,
      Math.min(until, maximum),
      maximum,
    );
  }
  async clearCooldown(profile: string): Promise<void> {
    if (!hash(profile))
      fail("semantic_profile", "The embedding profile is invalid.");
    this.sql.exec(
      "DELETE FROM semantic_profile_backoff WHERE profile=?",
      profile,
    );
  }
  async retryAfter(profile: string): Promise<number | null> {
    const row = this.sql.exec(
      "SELECT retry_after FROM semantic_profile_backoff WHERE profile=?",
      profile,
    )[0];
    return row ? Number(row.retry_after) : null;
  }
  private compatible(profile: string) {
    if (
      this.sql.exec(
        "SELECT 1 FROM semantic_profile_suspensions WHERE profile=?",
        profile,
      ).length
    )
      fail(
        "semantic_profile_suspended",
        "The embedding profile is suspended. Create a fresh profile and generation after repairing the provider.",
      );
  }
  async profile(id: string): Promise<EmbeddingProfile> {
    const profile = this.sql.exec(
      "SELECT value FROM semantic_profiles WHERE id=?",
      this.active(id).profile,
    )[0];
    if (!profile)
      return fail("semantic_profile", "The generation profile is unavailable.");
    return parseProfile(profile.value as Uint8Array);
  }
  async stage(
    id: string,
    after: string | null,
    page: DocumentPage,
  ): Promise<void> {
    boundedPage(Math.max(1, page.documents.length));
    this.sql.transaction(() => {
      const generation = this.active(id);
      if (
        generation.source_done ||
        generation.cursor !== after ||
        generation.state !== "paused"
      )
        fail(
          "semantic_progress",
          "The source cursor changed or preparation is complete.",
        );
      const profile = parseProfile(
        this.sql.exec(
          "SELECT value FROM semantic_profiles WHERE id=?",
          generation.profile,
        )[0].value as Uint8Array,
      );
      let cursor = after;
      for (const document of page.documents) {
        if (
          !hash(document.event, "jve1:") ||
          !hash(document.envelope) ||
          !hash(document.body) ||
          !hash(document.word, "jvw1:") ||
          !Number.isInteger(document.extraction_version) ||
          document.extraction_version < 1 ||
          !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(document.language) ||
          document.language.length > 63 ||
          (cursor !== null && document.event <= cursor)
        )
          fail(
            "semantic_binding",
            "The source page has an invalid or unordered association.",
          );
        cursor = document.event;
        if (document.input !== null) {
          if (
            document.error !== null ||
            document.input_hash !== inputHash(document.input) ||
            !document.input.byteLength ||
            document.input.byteLength >
              Number(profile.parameters.maximum_input_bytes)
          )
            fail("semantic_input", "The source input binding is invalid.");
          new TextDecoder("utf-8", { fatal: true }).decode(document.input);
          const old = this.sql.exec(
            "SELECT bytes FROM semantic_inputs WHERE profile=? AND input=?",
            generation.profile,
            document.input_hash,
          )[0];
          if (old) {
            const bytes = old.bytes as Uint8Array;
            if (
              bytes.length !== document.input.length ||
              bytes.some((n, i) => n !== document.input![i])
            )
              fail("semantic_input", "The input hash has conflicting bytes.");
          } else {
            this.allocation(0, 0, document.input.byteLength);
            this.sql.exec(
              "INSERT INTO semantic_inputs VALUES(?,?,?)",
              generation.profile,
              document.input_hash,
              document.input,
            );
          }
        } else if (document.input_hash !== null || !document.error)
          fail("semantic_input", "A failed source input needs a reason.");
        this.allocation(1, 0, 0);
        this.sql.exec(
          "INSERT INTO semantic_associations VALUES(?,?,?,?,?,?,?,?,?)",
          id,
          document.event,
          document.envelope,
          document.body,
          document.extraction_version,
          document.word,
          document.language,
          document.input_hash,
          document.error,
        );
      }
      if (
        page.next !== cursor ||
        (!page.done && (!page.documents.length || cursor === after))
      )
        fail(
          "semantic_progress",
          "The source page did not advance its cursor.",
        );
      const count = Number(
        this.sql.exec(
          "SELECT COUNT(*) AS n FROM semantic_associations WHERE generation=?",
          id,
        )[0].n,
      );
      if (
        count > generation.eligible ||
        (page.done && count !== generation.eligible)
      )
        fail(
          "semantic_progress",
          "The prepared source count differs from its eligible count.",
        );
      this.sql.exec(
        "UPDATE semantic_generations SET cursor=?,source_done=? WHERE id=?",
        cursor,
        Number(page.done),
        id,
      );
    });
  }
  async coverage(id: string, language?: string) {
    const generation = this.active(id);
    const row = this.sql.exec(
      `SELECT COUNT(*) AS eligible,
      COALESCE(SUM(v.input IS NOT NULL),0) AS indexed,
      COALESCE(SUM(a.error IS NOT NULL OR (v.input IS NULL AND b.state IN ('failed','ambiguous'))),0) AS failed
      FROM semantic_associations a LEFT JOIN semantic_vectors v ON v.profile=? AND v.input=a.input
      LEFT JOIN semantic_batch_inputs bi ON bi.generation=a.generation AND bi.input=a.input
      LEFT JOIN semantic_batches b ON b.id=bi.batch WHERE a.generation=? ${language === undefined ? "" : "AND a.language=?"}`,
      generation.profile,
      id,
      ...(language === undefined ? [] : [language]),
    )[0];
    const eligible =
      language === undefined ? generation.eligible : Number(row.eligible);
    return {
      eligible,
      indexed: Number(row.indexed),
      failed: Number(row.failed),
      pending: eligible - Number(row.indexed) - Number(row.failed),
    };
  }
  async summary(id: string) {
    this.generationRow(id);
    const row = this.sql.exec(
      `SELECT COUNT(*) AS batches,
      COALESCE(SUM(operation IS NOT NULL),0) AS dispatch_intents,
      COALESCE(SUM(state='completed'),0) AS completed_batches,
      COALESCE(SUM(CASE WHEN state='completed' THEN json_array_length(inputs) ELSE 0 END),0) AS completed_inputs,
      COALESCE(SUM(state='failed'),0) AS failed_batches,
      COALESCE(SUM(state='ambiguous'),0) AS ambiguous_batches,
      COALESCE(SUM(json_extract(usage,'$.inputTokens')),0) AS known_input_tokens,
      COALESCE(SUM(operation IS NOT NULL AND json_extract(usage,'$.inputTokens') IS NULL),0) AS unknown_token_batches,
      COALESCE(SUM(json_extract(usage,'$.costUsd')),0) AS reported_cost_usd,
      COALESCE(SUM(operation IS NOT NULL AND json_extract(usage,'$.costUsd') IS NULL),0) AS unknown_cost_batches
      FROM semantic_batches WHERE generation=?`,
      id,
    )[0];
    return {
      batches: Number(row.batches),
      dispatch_intents: Number(row.dispatch_intents),
      completed_batches: Number(row.completed_batches),
      completed_inputs: Number(row.completed_inputs),
      failed_batches: Number(row.failed_batches),
      ambiguous_batches: Number(row.ambiguous_batches),
      known_input_tokens: Number(row.known_input_tokens),
      unknown_token_batches: Number(row.unknown_token_batches),
      reported_cost_usd: Number(row.reported_cost_usd),
      unknown_cost_batches: Number(row.unknown_cost_batches),
    };
  }
  async page(
    id: string,
    after: string | null = null,
    limit = 128,
    language?: string,
  ) {
    boundedPage(limit);
    const generation = this.active(id);
    this.compatible(generation.profile);
    if (!generation.source_done)
      fail("semantic_preparing", "The generation source is incomplete.");
    // Read one extra row to establish the end without allocating the full vector set.
    const rows = this.sql.exec(
      `SELECT a.*,v.bytes AS vector FROM semantic_associations a
      LEFT JOIN semantic_vectors v ON v.profile=? AND v.input=a.input
      WHERE a.generation=? AND a.event>? ${language === undefined ? "" : "AND a.language=?"}
      ORDER BY a.event LIMIT ?`,
      generation.profile,
      id,
      after ?? "",
      ...(language === undefined ? [] : [language]),
      limit + 1,
    );
    const more = rows.length > limit;
    const result: VectorAssociation[] = rows.slice(0, limit).map((row) => ({
      event: String(row.event),
      envelope: String(row.envelope),
      body: String(row.body),
      extraction_version: Number(row.extraction_version),
      word: String(row.word),
      language: String(row.language),
      input_hash: row.input === null ? null : String(row.input),
      error: row.error === null ? null : String(row.error),
      vector: row.vector === null ? null : (row.vector as Uint8Array),
    }));
    return { rows: result, next: more ? result.at(-1)!.event : null };
  }
  async start(id: string) {
    this.sql.transaction(() => {
      const generation = this.active(id);
      this.compatible(generation.profile);
      if (!generation.source_done || generation.state !== "paused")
        fail(
          "semantic_progress",
          "Prepare or recover this generation before running it.",
        );
      this.sql.exec(
        "UPDATE semantic_generations SET state='running',error=NULL WHERE id=?",
        id,
      );
    });
  }
  async pause(id: string, error?: string) {
    this.active(id);
    this.sql.exec(
      "UPDATE semantic_generations SET state='paused',error=? WHERE id=? AND state!='completed'",
      error ?? null,
      id,
    );
  }
  /** The host calls this only after it excludes another live owner of this job. */
  async recover(id: string) {
    this.sql.transaction(() => {
      this.active(id);
      this.sql.exec(
        "DELETE FROM semantic_capacity_reservations WHERE batch IN (SELECT id FROM semantic_batches WHERE generation=? AND state IN ('prepared','sent'))",
        id,
      );
      this.sql.exec(
        "UPDATE semantic_batches SET state=CASE WHEN state='sent' THEN 'ambiguous' ELSE 'failed' END,error='index_interrupted' WHERE generation=? AND state IN ('prepared','sent')",
        id,
      );
      this.sql.exec(
        "UPDATE semantic_generations SET state='paused',error='index_interrupted' WHERE id=? AND state!='completed'",
        id,
      );
    });
  }
  private batch(id: string): IndexBatch {
    const row = this.sql.exec(
      "SELECT * FROM semantic_batches WHERE id=?",
      id,
    )[0];
    if (!row)
      return fail("semantic_batch", "The indexing batch is unavailable.");
    return {
      id,
      generation: String(row.generation),
      state: row.state as IndexBatch["state"],
      operation: row.operation === null ? null : String(row.operation),
      previous: row.previous === null ? null : String(row.previous),
      inputs: JSON.parse(String(row.inputs)),
      error: row.error === null ? null : String(row.error),
      usage: row.usage === null ? null : JSON.parse(String(row.usage)),
    };
  }
  async claim(id: string): Promise<IndexBatch | null> {
    return this.sql.transaction(() => {
      const generation = this.active(id);
      this.compatible(generation.profile);
      if (generation.state !== "running") return null;
      let inputs: string[] = [];
      let previous: string | null = null;
      for (;;) {
        const retry = this.sql.exec(
          "SELECT id FROM semantic_batches WHERE generation=? AND retry=1 ORDER BY id LIMIT 1",
          id,
        )[0];
        if (!retry) break;
        previous = String(retry.id);
        inputs = this.batch(previous).inputs.filter(
          (input) =>
            !this.sql.exec(
              "SELECT 1 FROM semantic_vectors WHERE profile=? AND input=?",
              generation.profile,
              input,
            ).length,
        );
        if (inputs.length) break;
        // Another generation can finish every input while this retry waits.
        this.sql.exec(
          "UPDATE semantic_batches SET retry=0 WHERE id=?",
          previous,
        );
        previous = null;
      }
      if (previous === null) {
        const cursor = String(
          this.sql.exec(
            "SELECT claim_cursor FROM semantic_generations WHERE id=?",
            id,
          )[0].claim_cursor,
        );
        inputs = this.sql
          .exec(
            `SELECT DISTINCT a.input FROM semantic_associations a
          LEFT JOIN semantic_vectors v ON v.profile=? AND v.input=a.input
          LEFT JOIN semantic_batch_inputs b ON b.generation=a.generation AND b.input=a.input
          WHERE a.generation=? AND a.input>? AND a.error IS NULL AND v.input IS NULL AND b.input IS NULL
          ORDER BY a.input LIMIT 8`,
            generation.profile,
            id,
            cursor,
          )
          .map((row) => String(row.input));
      }
      if (!inputs.length) return null;
      const profile = parseProfile(
        this.sql.exec(
          "SELECT value FROM semantic_profiles WHERE id=?",
          generation.profile,
        )[0].value as Uint8Array,
      );
      const bytes = inputs.length * profile.dimension * 4;
      if (!this.capacity(0, inputs.length, bytes)) {
        this.sql.exec(
          "UPDATE semantic_generations SET state='paused',error='semantic_capacity' WHERE id=?",
          id,
        );
        return null;
      }
      const batch = crypto.randomUUID();
      this.sql.exec(
        "INSERT INTO semantic_batches(id,generation,state,previous,inputs) VALUES(?,?,'prepared',?,?)",
        batch,
        id,
        previous,
        JSON.stringify(inputs),
      );
      this.sql.exec(
        "INSERT INTO semantic_capacity_reservations VALUES(?,?,?)",
        batch,
        inputs.length,
        bytes,
      );
      if (previous === null)
        this.sql.exec(
          "UPDATE semantic_generations SET claim_cursor=? WHERE id=?",
          inputs.at(-1)!,
          id,
        );
      else
        this.sql.exec(
          "UPDATE semantic_batches SET retry=0 WHERE id=?",
          previous,
        );
      for (const input of inputs)
        this.sql.exec(
          "INSERT INTO semantic_batch_inputs VALUES(?,?,?) ON CONFLICT(generation,input) DO UPDATE SET batch=excluded.batch",
          id,
          input,
          batch,
        );
      return this.batch(batch);
    });
  }
  async inputs(id: string): Promise<Uint8Array[]> {
    const batch = this.batch(id);
    const generation = this.active(batch.generation);
    return batch.inputs.map(
      (input) =>
        this.sql.exec(
          "SELECT bytes FROM semantic_inputs WHERE profile=? AND input=?",
          generation.profile,
          input,
        )[0].bytes as Uint8Array,
    );
  }
  async sent(id: string, operation: string) {
    this.sql.transaction(() => {
      const batch = this.batch(id);
      this.compatible(this.active(batch.generation).profile);
      if (
        batch.state !== "prepared" ||
        !operation.startsWith("embedding:index:")
      )
        fail("semantic_batch", "The batch cannot enter the sent state.");
      this.sql.exec(
        "UPDATE semantic_batches SET state='sent',operation=? WHERE id=?",
        operation,
        id,
      );
    });
  }
  async complete(
    id: string,
    operation: string,
    vectors: Float32Array[],
    usage: EmbeddingUsage,
  ) {
    const batch = this.batch(id);
    const generation = this.active(batch.generation);
    const profile = await this.profile(generation.id);
    if (
      batch.state !== "sent" ||
      batch.operation !== operation ||
      vectors.length !== batch.inputs.length
    )
      fail(
        "semantic_batch",
        "The vector result differs from the dispatched batch.",
      );
    const encoded = vectors.map((vector) =>
      vectorBytes(vector, profile.dimension),
    );
    this.sql.transaction(() => {
      this.sql.exec(
        "DELETE FROM semantic_capacity_reservations WHERE batch=?",
        id,
      );
      // Validate every result before the first write. A conflict rolls back the whole batch.
      for (let i = 0; i < encoded.length; i++) {
        vectorFromBytes(encoded[i], profile.dimension);
        const old = this.sql.exec(
          "SELECT bytes FROM semantic_vectors WHERE profile=? AND input=?",
          generation.profile,
          batch.inputs[i],
        )[0];
        if (old) {
          const bytes = old.bytes as Uint8Array;
          if (
            bytes.length !== encoded[i].length ||
            bytes.some((n, j) => n !== encoded[i][j])
          )
            fail(
              "semantic_vector_conflict",
              "The profile and input already have a different vector.",
            );
        } else {
          this.allocation(0, 1, encoded[i].length);
          this.sql.exec(
            "INSERT INTO semantic_vectors VALUES(?,?,?,?)",
            generation.profile,
            batch.inputs[i],
            encoded[i],
            operation,
          );
        }
      }
      this.sql.exec(
        "UPDATE semantic_batches SET state='completed',usage=?,error=NULL WHERE id=?",
        JSON.stringify(usage),
        id,
      );
    });
  }
  async fail(id: string, error: string, usage?: EmbeddingUsage) {
    this.sql.transaction(() => {
      const batch = this.batch(id);
      if (!["prepared", "sent"].includes(batch.state)) return;
      this.sql.exec(
        "DELETE FROM semantic_capacity_reservations WHERE batch=?",
        id,
      );
      this.sql.exec(
        "UPDATE semantic_batches SET state=?,error=?,usage=? WHERE id=?",
        batch.state === "sent" ? "ambiguous" : "failed",
        error,
        usage === undefined ? null : JSON.stringify(usage),
        id,
      );
    });
  }
  async batches(id: string, after: string | null = null, limit = 64) {
    this.generationRow(id);
    boundedPage(limit);
    return this.sql
      .exec(
        "SELECT id FROM semantic_batches WHERE generation=? AND id>? ORDER BY id LIMIT ?",
        id,
        after ?? "",
        limit,
      )
      .map((row) => this.batch(String(row.id)));
  }
  async retry(id: string) {
    this.sql.transaction(() => {
      const batch = this.batch(id);
      const generation = this.active(batch.generation);
      if (
        generation.state !== "paused" ||
        !["failed", "ambiguous"].includes(batch.state)
      )
        fail(
          "semantic_retry",
          "Pause the generation and select a failed or ambiguous batch for retry.",
        );
      // A later explicit attempt owns these inputs. Never replay an older attempt again.
      if (
        batch.inputs.some(
          (input) =>
            this.sql.exec(
              "SELECT batch FROM semantic_batch_inputs WHERE generation=? AND input=?",
              generation.id,
              input,
            )[0]?.batch !== id,
        )
      )
        fail("semantic_retry", "A later attempt already owns these inputs.");
      this.sql.exec("UPDATE semantic_batches SET retry=1 WHERE id=?", id);
    });
  }
  async finish(id: string) {
    this.sql.transaction(() => {
      const generation = this.active(id);
      const inFlight = Number(
        this.sql.exec(
          "SELECT COUNT(*) AS n FROM semantic_batches WHERE generation=? AND state IN ('prepared','sent')",
          id,
        )[0].n,
      );
      if (generation.state !== "running" || inFlight) return;
      const missing = Number(
        this.sql.exec(
          "SELECT COUNT(*) AS n FROM semantic_associations a LEFT JOIN semantic_vectors v ON v.profile=? AND v.input=a.input WHERE a.generation=? AND a.error IS NULL AND v.input IS NULL",
          generation.profile,
          id,
        )[0].n,
      );
      this.sql.exec(
        "UPDATE semantic_generations SET state=?,error=? WHERE id=?",
        missing ? "paused" : "completed",
        missing ? "index_incomplete" : null,
        id,
      );
    });
  }
  async current(profile: string, view: string) {
    return (
      (this.sql.exec(
        "SELECT generation FROM semantic_current WHERE profile=? AND view=?",
        profile,
        view,
      )[0]?.generation as string) ?? null
    );
  }
  async publish(id: string, expected: string | null) {
    return this.sql.transaction(() => {
      const generation = this.active(id);
      this.compatible(generation.profile);
      if (!generation.source_done)
        fail("semantic_preparing", "The generation source is incomplete.");
      const old = this.sql.exec(
        "SELECT generation,rollback FROM semantic_current WHERE profile=? AND view=?",
        generation.profile,
        generation.view,
      )[0];
      if ((old?.generation ?? null) !== expected) return false;
      if (old?.generation === id) return true;
      this.sql.exec(
        "INSERT INTO semantic_current VALUES(?,?,?,?) ON CONFLICT(profile,view) DO UPDATE SET generation=excluded.generation,rollback=excluded.rollback",
        generation.profile,
        generation.view,
        id,
        (old?.generation as string) ?? null,
      );
      return true;
    });
  }
  async rollback(profile: string, view: string, expected: string) {
    return this.sql.transaction(() => {
      const row = this.sql.exec(
        "SELECT * FROM semantic_current WHERE profile=? AND view=?",
        profile,
        view,
      )[0];
      if (row?.generation !== expected || !row.rollback)
        return fail(
          "semantic_publication",
          "The publication changed or no rollback generation remains.",
        );
      this.active(String(row.rollback));
      this.sql.exec(
        "UPDATE semantic_current SET generation=?,rollback=? WHERE profile=? AND view=?",
        String(row.rollback),
        expected,
        profile,
        view,
      );
      return String(row.rollback);
    });
  }
  /** Remove only this exact current pointer. A separate retirement removes derived bytes. */
  async unpublish(profile: string, view: string, expected: string) {
    return this.sql.transaction(() => {
      const row = this.sql.exec(
        "SELECT generation FROM semantic_current WHERE profile=? AND view=?",
        profile,
        view,
      )[0];
      if (row?.generation !== expected) return false;
      this.sql.exec(
        "DELETE FROM semantic_current WHERE profile=? AND view=? AND generation=?",
        profile,
        view,
        expected,
      );
      return true;
    });
  }
  async retire(id: string) {
    this.sql.transaction(() => {
      const generation = this.active(id);
      if (
        generation.state === "running" ||
        this.sql.exec(
          "SELECT 1 FROM semantic_current WHERE generation=? OR rollback=?",
          id,
          id,
        ).length ||
        this.sql.exec(
          "SELECT 1 FROM semantic_batches WHERE generation=? AND state IN ('prepared','sent')",
          id,
        ).length
      )
        fail(
          "semantic_retirement",
          "Pause the job and remove its current or rollback reference before retirement.",
        );
      const count = Number(
        this.sql.exec(
          "SELECT COUNT(*) AS n FROM semantic_associations WHERE generation=?",
          id,
        )[0].n,
      );
      this.sql.exec("DELETE FROM semantic_associations WHERE generation=?", id);
      this.sql.exec("DELETE FROM semantic_batch_inputs WHERE generation=?", id);
      const orphan = `NOT EXISTS (SELECT 1 FROM semantic_associations a JOIN semantic_generations g ON g.id=a.generation WHERE g.profile=semantic_inputs.profile AND a.input=semantic_inputs.input)`;
      const removed = Number(
        this.sql.exec(
          `SELECT COALESCE(SUM(length(bytes)),0) AS n FROM semantic_inputs WHERE ${orphan}`,
        )[0].n,
      );
      const vectorRows = this.sql.exec(
        `SELECT COUNT(*) AS n,COALESCE(SUM(length(bytes)),0) AS bytes FROM semantic_vectors v WHERE NOT EXISTS (SELECT 1 FROM semantic_associations a JOIN semantic_generations g ON g.id=a.generation WHERE g.profile=v.profile AND a.input=v.input)`,
      )[0];
      this.sql.exec(`DELETE FROM semantic_inputs WHERE ${orphan}`);
      this.sql.exec(
        "DELETE FROM semantic_vectors WHERE NOT EXISTS (SELECT 1 FROM semantic_associations a JOIN semantic_generations g ON g.id=a.generation WHERE g.profile=semantic_vectors.profile AND a.input=semantic_vectors.input)",
      );
      this.allocation(
        -count,
        -Number(vectorRows.n),
        -removed - Number(vectorRows.bytes),
      );
      this.sql.exec(
        "UPDATE semantic_generations SET state='retired' WHERE id=?",
        id,
      );
    });
  }
}
