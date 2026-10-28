import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import {
  scanPages,
  type ScanRequest,
} from "../../../packages/service/src/semantic/scan.ts";
import { SemanticError } from "../../../packages/service/src/semantic/types.ts";

const database = new DatabaseSync(workerData.path, { readOnly: true });
database.exec("PRAGMA query_only=ON; PRAGMA cache_size=-8192;");
const page =
  database.prepare(`SELECT a.*,v.bytes AS vector FROM semantic_associations a
  JOIN semantic_vectors v ON v.profile=? AND v.input=a.input
  WHERE a.generation=? AND a.language=? AND a.event>? ORDER BY a.event LIMIT 129`);
const generation = database.prepare(
  "SELECT snapshot,view,profile,state FROM semantic_generations WHERE id=?",
);
const suspended = database.prepare(
  "SELECT reason FROM semantic_profile_suspensions WHERE profile=?",
);
parentPort!.on(
  "message",
  async (message: {
    id: number;
    request: ScanRequest;
    cancel: SharedArrayBuffer;
  }) => {
    const request = message.request;
    const cancellation = new Int32Array(message.cancel);
    const valid = () => {
      const g = generation.get(request.generation);
      if (
        !g ||
        g.state === "retired" ||
        g.view !== request.view ||
        g.profile !== request.profile
      )
        throw new SemanticError(
          503,
          "semantic_generation",
          "The selected vector generation is unavailable.",
        );
      if (suspended.get(request.profile))
        throw new SemanticError(
          503,
          "semantic_profile_suspended",
          "The selected embedding profile is suspended.",
        );
    };
    try {
      valid();
      const hits = await scanPages(
        request,
        async (after) => {
          const rows = page.all(
            request.profile,
            request.generation,
            request.language,
            after ?? "",
          );
          return {
            rows: rows.slice(0, 128).map((row) => ({
              event: String(row.event),
              envelope: String(row.envelope),
              body: String(row.body),
              extraction_version: Number(row.extraction_version),
              word: String(row.word),
              language: String(row.language),
              input_hash: String(row.input),
              error: row.error === null ? null : String(row.error),
              vector: row.vector as Uint8Array,
            })),
            next: rows.length > 128 ? String(rows[127].event) : null,
          };
        },
        () => Atomics.load(cancellation, 0) !== 0,
      );
      valid();
      parentPort!.postMessage({ id: message.id, hits });
    } catch (failure) {
      const error =
        failure instanceof SemanticError
          ? {
              status: failure.status,
              code: failure.code,
              message: failure.message,
            }
          : {
              status: 503,
              code: "semantic_scan",
              message: "The vector scan failed.",
            };
      parentPort!.postMessage({ id: message.id, error });
    }
  },
);
