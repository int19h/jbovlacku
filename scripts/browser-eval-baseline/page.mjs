import {
  initializeCore,
  identityFromSeed,
  createEvent,
  utf8,
} from "../../packages/core/src/browser.ts";
import {
  PersonalCalculator,
  effectiveOverlay,
} from "../../apps/web/src/data/personal.ts";
import { LocalStore, emptyOverlay } from "../../apps/web/src/data/store.ts";
import { setPreferredView } from "../../apps/web/src/data/api.ts";

const seed = new Uint8Array(32).fill(173);
let input = null,
  worker = null,
  sequence = 0,
  sentEvents = 0,
  savedOverlay = null,
  mainWasm = null;
const pending = new Map();
let lastResult = null;
const request = (message) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    const payload = { ...message, id };
    pending.set(id, {
      resolve,
      reject,
      requestBytes: utf8(JSON.stringify(payload)).length,
    });
    worker.postMessage(payload);
  });
window.bench = {
  async gate(view) {
    const start = performance.now();
    mainWasm = await initializeCore();
    setPreferredView(view);
    const store = new LocalStore(`measurement-${crypto.randomUUID()}`);
    const calculator = new PersonalCalculator(store, async () => ({
      identity: identityFromSeed(seed),
    }));
    const statuses = [];
    calculator.subscribe((s) => statuses.push(s));
    const result = await calculator.ensure({ mode: "personal", refresh: true });
    const ms = performance.now() - start;
    calculator.cancel();
    (await store.database).close();
    return { ms, result, statuses };
  },
  mainMemory() {
    return { wasm_bytes: mainWasm?.memory.buffer.byteLength ?? 0 };
  },
  start() {
    sentEvents = 0;
    worker = new Worker("/worker.js", { type: "module" });
    worker.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if (data.type === "error") p.reject(new Error(data.message));
      else p.resolve({ ...data, request_bytes: p.requestBytes });
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message));
      pending.clear();
    };
  },
  async fetchInput() {
    const start = performance.now();
    input = await (await fetch("/input.json", { cache: "no-store" })).json();
    if (savedOverlay) input.overlay = savedOverlay;
    return { ms: performance.now() - start, events: input.events.length };
  },
  async actors(limits) {
    const start = performance.now();
    const response = await request({
      type: "actors",
      input: { ...input, limits },
    });
    const body = JSON.parse(input.bodies[input.selected_view]);
    savedOverlay = effectiveOverlay(
      emptyOverlay(),
      input.selected_view,
      { identity: identityFromSeed(seed), actors: response.actors },
      body.roots.map((r) => r.identity),
    );
    input.overlay = savedOverlay;
    return {
      ms: performance.now() - start,
      measurement: response.measurement,
      actors: Object.keys(response.actors).length,
    };
  },
  async load(limits, label) {
    const start = performance.now();
    const response = await request({
      type: "load",
      session: label,
      input: { ...input, limits },
    });
    sentEvents = input.events.length;
    return { ms: performance.now() - start, ...response };
  },
  async advance(limits, label) {
    const start = performance.now();
    const events = input.events.slice(sentEvents);
    const bodies = {};
    for (const envelope of events) {
      const id = JSON.parse(envelope).id;
      if (input.bodies[id] !== undefined) bodies[id] = input.bodies[id];
    }
    const response = await request({
      type: "advance",
      base: "base",
      session: label,
      input: { ...input, events, bodies, limits },
    });
    sentEvents = input.events.length;
    return { ms: performance.now() - start, ...response };
  },
  releaseInput() {
    input = null;
  },
  async rank(word, label) {
    const start = performance.now();
    const response = await request({
      type: "rank",
      session: label,
      word,
      reviewers: 64,
    });
    lastResult = response.result;
    return {
      ms: performance.now() - start,
      measurement: response.measurement,
      result: response.result,
      score_count: response.result.scores?.length,
      max_direct_reviewers: Math.max(
        0,
        ...(response.result.scores ?? []).map((s) => s.direct_reviewers ?? 0),
      ),
      layers: response.result.layers?.length,
      calculation: response.result.calculation,
      unavailable: response.result.unavailable_scores,
    };
  },
  async stress(words) {
    const start = performance.now();
    let added = 0;
    for (let reviewer = 0; reviewer < 16; reviewer++) {
      const key = new Uint8Array(32).fill(174 + reviewer);
      for (let i = 0; i < words.length; i++) {
        const row = createEvent(
          key,
          [],
          (i + 1).toString(16).padStart(32, "0"),
          { kind: "judgment.set", target: words[i].targets[0], value: "bless" },
          null,
        );
        input.events.push(JSON.stringify(row.envelope));
        added++;
      }
      const trust = createEvent(
        seed,
        [],
        (1000 + reviewer).toString(16).padStart(32, "0"),
        {
          kind: "trust.set",
          subject: identityFromSeed(key),
          scope: { kind: "definition", word: "*", language: "*" },
          value: "heed",
        },
        null,
      );
      input.events.push(JSON.stringify(trust.envelope));
      added++;
    }
    return {
      ms: performance.now() - start,
      added,
      reviewers: 16,
      words: words.length,
    };
  },
  async submission(target) {
    const start = performance.now();
    await initializeCore();
    const event = createEvent(
      seed,
      [],
      "b37b0000000000000000000000000001",
      { kind: "judgment.set", target, value: "bless" },
      null,
    );
    input.events.push(JSON.stringify(event.envelope));
    return {
      signing_ms: performance.now() - start,
      id: event.envelope.id,
      identity: identityFromSeed(seed),
      target,
      bytes: utf8(JSON.stringify(event.envelope)).length,
    };
  },
};
