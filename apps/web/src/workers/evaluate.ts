/**
 * Evaluation worker. It loads the shared core, builds one evaluation session
 * from authenticated records and the local overlay, and ranks words on request.
 * Every reply names the session it answers for, so a reply from an older
 * session is never read as the current one.
 * Cancellation terminates the worker, because WebAssembly work is synchronous.
 */
import {
  evaluateSession,
  initializeCore,
  type EvaluationRequest,
} from "../../../../packages/core/src/index.ts";

export type WorkerRequest =
  | { type: "load"; id: number; session: string; input: EvaluationRequest }
  | {
      type: "rank";
      id: number;
      session: string;
      word: string;
      /** At most this many reviewer details per score. Omitted means none. */
      reviewers?: number;
    };
export type WorkerResponse =
  | {
      type: "loaded";
      id: number;
      session: string;
      available: boolean;
      reasons: string[];
      events: number;
    }
  | { type: "ranked"; id: number; session: string; result: unknown }
  | { type: "error"; id: number; message: string };

let session: ReturnType<typeof evaluateSession> | null = null;
let sessionKey: string | null = null;
const ready = initializeCore();
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  const reply = (response: WorkerResponse) => self.postMessage(response);
  try {
    await ready;
    if (message.type === "load") {
      session?.free();
      session = null;
      sessionKey = null;
      session = evaluateSession(message.input);
      sessionKey = message.session;
      reply({
        type: "loaded",
        id: message.id,
        session: message.session,
        available: session.state.available,
        reasons: session.state.reasons,
        events: message.input.events.length,
      });
    } else if (message.type === "rank") {
      if (!session || sessionKey !== message.session)
        throw new Error("The requested evaluation session is not loaded.");
      reply({
        type: "ranked",
        id: message.id,
        session: message.session,
        result: session.rankWord(message.word, message.reviewers),
      });
    }
  } catch (error) {
    reply({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
