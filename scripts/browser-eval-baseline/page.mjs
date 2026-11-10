import {
  initializeCore,
  identityFromSeed,
  createEvent,
  utf8,
} from "../../packages/core/src/browser.ts";
import {
  PersonalCalculator,
  effectiveOverlay,
  selectAddedEventIds,
} from "../../apps/web/src/data/personal.ts";
import { LocalStore, emptyOverlay } from "../../apps/web/src/data/store.ts";
import { setPreferredView } from "../../apps/web/src/data/api.ts";
import { seedProduct } from "./seed.mjs";

const seed = new Uint8Array(32).fill(173);
let input = null,
  worker = null,
  sequence = 0,
  sentEventIds = [],
  savedOverlay = null,
  mainWasm = null,
  productCalculator = null,
  productStore = null,
  productDatabase = null,
  productInput = null,
  productWorkerBytes = 0,
  productSnapshot = null,
  NativeWorker = null,
  diagnosticStore = null,
  diagnosticInventory = null;
const pending = new Map();
let lastResult = null;
const signedJudgment = (target) =>
  createEvent(
    seed,
    [],
    "b37b0000000000000000000000000002",
    { kind: "judgment.set", target, value: "bless" },
    null,
  );
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
  async seedProductProfile(view) {
    setPreferredView(view);
    productDatabase = `measurement-${crypto.randomUUID()}`;
    const inventory = await new Promise((resolve, reject) => {
      const seedWorker = new Worker("/seed-worker.js", { type: "module" });
      seedWorker.onmessage = ({ data }) => {
        if (data.error) reject(new Error(data.error));
        else resolve(data.inventory);
        seedWorker.terminate();
      };
      seedWorker.onerror = (event) => {
        reject(new Error(event.message));
        seedWorker.terminate();
      };
      seedWorker.postMessage({
        database: productDatabase,
        fixture: "/fixture.json",
        records: "/records.jsonl",
      });
    });
    return { database: productDatabase, events: inventory.events.length };
  },
  async prepareProduct(view, database = productDatabase) {
    if (!database) throw new Error("The product profile has not been seeded.");
    productDatabase = database;
    setPreferredView(view);
    mainWasm = await initializeCore();
    NativeWorker = globalThis.Worker;
    productWorkerBytes = 0;
    globalThis.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", (event) => {
          productWorkerBytes += utf8(JSON.stringify(event.data)).length;
        });
      }
      postMessage(message) {
        productWorkerBytes += utf8(JSON.stringify(message)).length;
        super.postMessage(message);
      }
    };
    productStore = new LocalStore(database);
    productCalculator = new PersonalCalculator(productStore, async () => ({
      identity: identityFromSeed(seed),
    }));
  },
  async gate(view, keep = false) {
    const start = performance.now();
    if (!keep) mainWasm = await initializeCore();
    setPreferredView(view);
    if (keep && !productCalculator) await window.bench.prepareProduct(view);
    const store = keep
      ? productStore
      : new LocalStore(`measurement-${crypto.randomUUID()}`);
    const calculator = keep
      ? productCalculator
      : new PersonalCalculator(store, async () => ({
          identity: identityFromSeed(seed),
        }));
    const statuses = [];
    calculator.subscribe((s) => statuses.push(s));
    const result = await calculator.ensure({
      mode: "personal",
      ...(!keep ? { refresh: true } : {}),
    });
    const ms = performance.now() - start;
    if (!keep) {
      calculator.cancel();
      (await store.database).close();
    }
    return { ms, result, statuses, worker_bytes: productWorkerBytes };
  },
  async productSubmission(target) {
    const start = performance.now();
    mainWasm = await initializeCore();
    const event = signedJudgment(target);
    const serialized = JSON.stringify(event.envelope);
    await productStore.put("records", event.envelope.id, {
      id: event.envelope.id,
      envelope: serialized,
      body: null,
      bodyStatus: "none",
      bodyHash: null,
    });
    return {
      ms: performance.now() - start,
      id: event.envelope.id,
      identity: identityFromSeed(seed),
      target,
      envelope: serialized,
      bytes: utf8(serialized).length,
    };
  },
  async productReload(inventory) {
    const start = performance.now();
    if (typeof productStore.commitInventory === "function")
      await productStore.commitInventory(inventory);
    else {
      await productStore.put("inventory", inventory.snapshot, inventory);
      await productStore.put("inventory", "latest", inventory);
    }
    productSnapshot = inventory.snapshot;
    const before = productWorkerBytes;
    const result = await productCalculator.ensure({ mode: "personal" });
    if (result.state !== "ready" || result.snapshot !== productSnapshot)
      throw new Error(
        `The product reload did not reach the submitted snapshot: ${JSON.stringify(result)}`,
      );
    return {
      ms: performance.now() - start,
      result,
      worker_bytes: productWorkerBytes - before,
    };
  },
  async productRank(word) {
    return { result: await productCalculator.rankWord(word) };
  },
  async productFinish() {
    productCalculator?.cancel();
    if (productStore) (await productStore.database).close();
    productCalculator = null;
    productStore = null;
    productDatabase = null;
    productInput = null;
    productSnapshot = null;
    if (NativeWorker) globalThis.Worker = NativeWorker;
    NativeWorker = null;
  },
  mainMemory() {
    return { wasm_bytes: mainWasm?.memory.buffer.byteLength ?? 0 };
  },
  start() {
    sentEventIds = [];
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
    diagnosticStore ??= new LocalStore(`diagnostic-${crypto.randomUUID()}`);
    diagnosticInventory = await seedProduct(diagnosticStore, input);
    return { ms: performance.now() - start, events: input.events.length };
  },
  async actors(limits) {
    const start = performance.now();
    const { events, bodies, overlay, ...options } = input;
    const response = await request({
      type: "load",
      session: "actors",
      source: {
        database: diagnosticStore.name,
        snapshot: diagnosticInventory.snapshot,
        events_digest: diagnosticInventory.events_digest,
        count: diagnosticInventory.events.length,
      },
      options: { ...options, limits },
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
      request_bytes: response.request_bytes,
      actors: Object.keys(response.actors).length,
    };
  },
  async load(limits, label) {
    const start = performance.now();
    const { events, bodies, ...options } = input;
    const response = await request({
      type: "load",
      session: label,
      source: {
        database: diagnosticStore.name,
        snapshot: diagnosticInventory.snapshot,
        events_digest: diagnosticInventory.events_digest,
        count: diagnosticInventory.events.length,
      },
      options: { ...options, limits },
    });
    sentEventIds = input.events.map((envelope) => JSON.parse(envelope).id);
    return { ms: performance.now() - start, ...response };
  },
  async advance(limits, label) {
    const start = performance.now();
    const inventoryIds = input.events.map(
      (envelope) => JSON.parse(envelope).id,
    );
    const addedIds = selectAddedEventIds(inventoryIds, sentEventIds);
    if (!addedIds)
      throw new Error("The diagnostic base is not an ordered subset.");
    const addedSet = new Set(addedIds);
    const events = input.events.filter((_, index) =>
      addedSet.has(inventoryIds[index]),
    );
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
    sentEventIds = input.events.map((envelope) => JSON.parse(envelope).id);
    return { ms: performance.now() - start, ...response };
  },
  releaseInput() {
    input = null;
    diagnosticStore?.database.then((database) => database.close());
    diagnosticStore = null;
    diagnosticInventory = null;
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
    const event = signedJudgment(target);
    const serialized = JSON.stringify(event.envelope);
    const found = input.events.findIndex(
      (envelope) => JSON.parse(envelope).id > event.envelope.id,
    );
    const index = found < 0 ? input.events.length : found;
    input.events.splice(index, 0, serialized);
    return {
      signing_ms: performance.now() - start,
      id: event.envelope.id,
      identity: identityFromSeed(seed),
      target,
      inventory_index: index,
      bytes: utf8(serialized).length,
    };
  },
};
