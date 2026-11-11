import { expect, test } from "@playwright/test";
import { corePath } from "./helpers.ts";

test("the browser worker authenticates streamed records and checks the complete inventory", async ({
  page,
}) => {
  await page.goto("/");
  const results = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await core.initializeCore();
    const record = core.createEvent(
      new Uint8Array(32).fill(92),
      [],
      "1".repeat(32),
      { kind: "identity.merge" },
      null,
    );
    const other = core.createEvent(
      new Uint8Array(32).fill(93),
      [],
      "2".repeat(32),
      { kind: "identity.merge" },
      null,
    );
    const hostPorts = [
      "addHostVerifiedRecord",
      "extractHostVerifiedRecord",
      "checkHostVerifiedRecord",
      "inspectHostStoredBody",
      "restoreHostEvaluationSession",
    ];
    const exportedHostPorts = hostPorts.filter(
      (name) => typeof core[name] !== "undefined",
    );
    const session = core.evaluateSession({
      events: [JSON.stringify(record.envelope)],
      bodies: {},
      selected_view: "jve1:" + "0".repeat(64),
      import_selections: {},
    });
    const unsafeSessionPorts = [
      "state",
      "checkpoint",
      "addHostVerifiedRecord",
    ].filter((name) => typeof session[name] !== "undefined");
    const builder = session.fork({
      selected_view: "jve1:" + "0".repeat(64),
      import_selections: {},
    });
    const unsafeBuilderPorts = ["addHostVerifiedRecord", "removeRecord"].filter(
      (name) => typeof builder[name] !== "undefined",
    );
    builder.free();
    session.free();

    const store = new LocalStore(`streamed-${crypto.randomUUID()}`);
    const snapshot = "sha256:" + "a".repeat(64);
    const stored = {
      id: record.envelope.id,
      envelope: JSON.stringify(record.envelope),
      body: null,
      bodyStatus: "none",
      bodyHash: null,
    };
    const otherStored = {
      id: other.envelope.id,
      envelope: JSON.stringify(other.envelope),
      body: null,
      bodyStatus: "none",
      bodyHash: null,
    };
    await store.put("records", record.envelope.id, stored);
    await store.put("records", other.envelope.id, otherStored);
    const inventory = {
      snapshot,
      logical_inventory: snapshot,
      events_digest: "digest",
      view: "jve1:" + "0".repeat(64),
      events: [record.envelope.id, other.envelope.id].sort(),
      bodies: [],
      selections: [],
    };
    await store.put("inventory", snapshot, inventory);
    const worker = new Worker(
      new URL("/src/workers/evaluate.ts", location.href),
      { type: "module" },
    );
    const send = (options: unknown) =>
      new Promise<{ type: string; message?: string }>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(new Error("The browser evaluation worker did not answer.")),
          10000,
        );
        worker.onmessage = (event) => {
          clearTimeout(timer);
          resolve(event.data);
        };
        worker.onerror = (event) => {
          clearTimeout(timer);
          reject(new Error(event.message));
        };
        worker.postMessage({
          type: "load",
          id: 1,
          session: "host-boundary",
          source: {
            database: store.name,
            snapshot,
            events_digest: "digest",
            count: 2,
          },
          options,
        });
      });
    const options = {
      selected_view: "jve1:" + "0".repeat(64),
      import_selections: {},
    };
    try {
      const original = await send(options);
      const claimed = await send({ ...options, host_records: [] });
      await store.delete("records", record.envelope.id);
      const missing = await send(options);
      await store.put("records", record.envelope.id, stored);
      const low = BigInt("0x" + inventory.events[0].slice(5));
      const high = BigInt("0x" + inventory.events[1].slice(5));
      const between = low + (high - low) / 2n;
      const betweenId = "jve1:" + between.toString(16).padStart(64, "0");
      const afterId = "jve1:" + "f".repeat(64);
      await store.put("records", betweenId, { ...stored, id: betweenId });
      await store.put("records", afterId, { ...stored, id: afterId });
      const extra = await send(options);
      await store.delete("records", betweenId);
      await store.delete("records", afterId);
      const forged = { ...record.envelope, signature: "invalid" };
      await store.put("records", record.envelope.id, {
        ...stored,
        envelope: JSON.stringify(forged),
      });
      const ordinary = await send(options);
      return {
        original,
        claimed,
        missing,
        extra,
        ordinary,
        exportedHostPorts,
        unsafeSessionPorts: [...unsafeSessionPorts, ...unsafeBuilderPorts],
      };
    } finally {
      worker.terminate();
      (await store.database).close();
    }
  }, corePath);
  expect(results.exportedHostPorts).toEqual([]);
  expect(results.unsafeSessionPorts).toEqual([]);
  expect(results.original.type).toBe("loaded");
  expect(results.claimed.type).toBe("error");
  expect(results.claimed.message).toContain("unknown field `host_records`");
  expect(results.missing.type).toBe("error");
  expect(results.missing.message).toContain("is not cached");
  expect(results.extra).toEqual(results.original);
  expect(results.ordinary.type).toBe("error");
});

test("an inventory commit prunes stale record IDs and publishes the new pointer", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore(`inventory-${crypto.randomUUID()}`);
    const snapshot = "sha256:" + "b".repeat(64);
    const inventory = {
      snapshot,
      logical_inventory: snapshot,
      events_digest: "digest",
      view: "jve1:" + "0".repeat(64),
      events: ["jve1:" + "a".repeat(64)],
      bodies: [],
      selections: [],
    };
    const cursorCounts = { key: 0, value: 0 };
    const openKeyCursor = IDBObjectStore.prototype.openKeyCursor;
    const openCursor = IDBObjectStore.prototype.openCursor;
    IDBObjectStore.prototype.openKeyCursor = function (
      this: IDBObjectStore,
      ...args
    ) {
      cursorCounts.key++;
      return openKeyCursor.apply(this, args);
    } as typeof openKeyCursor;
    IDBObjectStore.prototype.openCursor = function (
      this: IDBObjectStore,
      ...args
    ) {
      cursorCounts.value++;
      return openCursor.apply(this, args);
    } as typeof openCursor;
    try {
      await store.put("records", inventory.events[0], {
        id: inventory.events[0],
      });
      await store.put("records", "jve1:" + "f".repeat(64), {
        id: "jve1:" + "f".repeat(64),
      });
      await store.commitInventory(inventory);
      return {
        keys: await store.keys("records"),
        latest: await store.get("inventory", "latest"),
        pinned: await store.get("inventory", snapshot),
        cursorCounts,
      };
    } finally {
      IDBObjectStore.prototype.openKeyCursor = openKeyCursor;
      IDBObjectStore.prototype.openCursor = openCursor;
      (await store.database).close();
    }
  });
  expect(result.keys).toEqual(["jve1:" + "a".repeat(64)]);
  expect(result.latest).toEqual(result.pinned);
  expect(result.cursorCounts).toEqual({ key: 1, value: 0 });
});
