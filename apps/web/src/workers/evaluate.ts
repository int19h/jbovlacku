/**
 * Evaluation worker. It loads the shared core, builds one evaluation session
 * from authenticated records and the local overlay, and ranks words on request.
 * Cancellation terminates the worker, because WebAssembly work is synchronous.
 */
import {
  evaluateSession,
  initializeCore,
  type EvaluationRequest,
} from "../../../../packages/core/src/index.ts";

export type WorkerRequest =
  | { type: "load"; id: number; input: EvaluationRequest }
  | { type: "rank"; id: number; word: string };
export type WorkerResponse =
  | {
      type: "loaded";
      id: number;
      available: boolean;
      reasons: string[];
      events: number;
    }
  | { type: "ranked"; id: number; result: unknown }
  | { type: "error"; id: number; message: string };

let session: ReturnType<typeof evaluateSession> | null = null;
const ready = initializeCore();
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  const reply = (response: WorkerResponse) => self.postMessage(response);
  try {
    await ready;
    if (message.type === "load") {
      session?.free();
      session = null;
      session = evaluateSession(message.input);
      reply({
        type: "loaded",
        id: message.id,
        available: session.state.available,
        reasons: session.state.reasons,
        events: message.input.events.length,
      });
    } else if (message.type === "rank") {
      if (!session) throw new Error("No evaluation session is loaded.");
      reply({
        type: "ranked",
        id: message.id,
        result: session.rankWord(message.word),
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
