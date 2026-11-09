/**
 * Evaluation worker. It loads the shared core, builds one evaluation session
 * from authenticated records and the local overlay, and ranks words on request.
 * Every reply names the session it answers for, so a reply from an older
 * session is never read as the current one.
 * Cancellation terminates the worker, because WebAssembly work is synchronous.
 */
import {
  evaluateSession,
  evaluate,
  initializeCore,
  type EvaluationRequest,
} from "../../../../packages/core/src/browser.ts";

export type WorkerRequest =
  | { type: "actors"; id: number; input: EvaluationRequest }
  | { type: "load"; id: number; session: string; input: EvaluationRequest }
  | {
      type: "advance";
      id: number;
      base: string;
      session: string;
      input: EvaluationRequest;
    }
  | {
      type: "rank";
      id: number;
      session: string;
      word: string;
      /** At most this many reviewer details per score. Omitted means none. */
      reviewers?: number;
    };
export type WorkerResponse =
  | { type: "actors"; id: number; actors: Record<string, string> }
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

type LoadedResponse = Extract<WorkerResponse, { type: "loaded" }>;
type RankedResponse = Extract<WorkerResponse, { type: "ranked" }>;

export class EvaluationWorker {
  private session: ReturnType<typeof evaluateSession> | null = null;
  private sessionKey: string | null = null;
  private events = 0;

  /** Test and measurement access to the current browser-safe session. */
  get currentSession() {
    return this.session;
  }

  private release() {
    this.session?.free();
    this.session = null;
    this.sessionKey = null;
    this.events = 0;
  }

  private loaded(id: number, key: string): LoadedResponse {
    if (!this.session) throw new Error("The evaluation session is not loaded.");
    return {
      type: "loaded",
      id,
      session: key,
      available: this.session.state.available,
      reasons: this.session.state.reasons,
      events: this.events,
    };
  }

  load(message: Extract<WorkerRequest, { type: "load" }>): LoadedResponse {
    this.release();
    this.session = evaluateSession(message.input);
    this.sessionKey = message.session;
    this.events = message.input.events.length;
    return this.loaded(message.id, message.session);
  }

  advance(
    message: Extract<WorkerRequest, { type: "advance" }>,
  ): LoadedResponse {
    if (!this.session || this.sessionKey !== message.base)
      throw new Error("The base evaluation session is not loaded.");
    const { events, bodies, ...options } = message.input;
    const builder = this.session.fork(options);
    const previousEvents = this.events;
    this.release();
    try {
      for (const envelope of events) {
        const { id } = JSON.parse(envelope) as { id: string };
        builder.addRecord(
          new TextEncoder().encode(envelope),
          bodies[id] === undefined
            ? undefined
            : new TextEncoder().encode(bodies[id]),
        );
      }
      this.session = builder.finish();
      this.sessionKey = message.session;
      this.events = previousEvents + events.length;
      return this.loaded(message.id, message.session);
    } finally {
      builder.free();
    }
  }

  rank(message: Extract<WorkerRequest, { type: "rank" }>): RankedResponse {
    if (!this.session || this.sessionKey !== message.session)
      throw new Error("The requested evaluation session is not loaded.");
    return {
      type: "ranked",
      id: message.id,
      session: message.session,
      result: this.session.rankWord(message.word, message.reviewers),
    };
  }
}

const evaluation = new EvaluationWorker();
const ready = initializeCore();
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  const reply = (response: WorkerResponse) => self.postMessage(response);
  try {
    await ready;
    if (message.type === "actors") {
      const state = evaluate(message.input);
      const lifecycle = state.lifecycle as {
        key_actor: Record<string, string>;
      };
      reply({ type: "actors", id: message.id, actors: lifecycle.key_actor });
    } else if (message.type === "load") {
      reply(evaluation.load(message));
    } else if (message.type === "advance") {
      reply(evaluation.advance(message));
    } else if (message.type === "rank") {
      reply(evaluation.rank(message));
    }
  } catch (error) {
    reply({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
