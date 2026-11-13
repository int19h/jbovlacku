import { expect, test } from "@playwright/test";
import { corePath } from "./helpers.ts";
import type { LocalStore as BrowserStore } from "../src/data/store.ts";

test("the browser worker loads stored rows and rebuilds stale or damaged projections", async ({
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

    const store = new LocalStore(
      `streamed-${crypto.randomUUID()}`,
    ) as BrowserStore;
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
    let worker = new Worker(
      new URL("/src/workers/evaluate.ts", location.href),
      { type: "module" },
    );
    let sequence = 0;
    const send = (options: unknown) =>
      new Promise<{
        type: string;
        message?: string;
        projection_rebuilt?: boolean;
      }>((resolve, reject) => {
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
          id: ++sequence,
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
    const metaKey = `projection:${snapshot}`;
    const rebuilds: (boolean | undefined)[] = [];
    const recovered: Record<string, unknown>[] = [];
    try {
      const original = await send(options);
      const warm = await send(options);
      const claimed = await send({ ...options, host_records: [] });
      const firstRow = await store.get<Uint8Array>(
        "projections",
        record.envelope.id,
      );
      const damaged = new Uint8Array(firstRow!);
      damaged[67] ^= 1;
      const decoder = core.createEvaluationSession(options);
      decoder.addProjectionRow(damaged, record.envelope.id);
      decoder.free();
      await store.put("projections", record.envelope.id, damaged);
      worker.terminate();
      worker = new Worker(new URL("/src/workers/evaluate.ts", location.href), {
        type: "module",
      });
      recovered.push(await send(options));
      const validMeta = await store.get<Record<string, unknown>>(
        "meta",
        metaKey,
      );
      for (const change of [
        { version: 999 },
        { build: "different" },
        { rows_hash: "sha256:" + "0".repeat(64) },
      ]) {
        await store.put("meta", metaKey, { ...validMeta, ...change });
        recovered.push(await send(options));
      }
      rebuilds.push(
        ...recovered.map(
          (result) =>
            (result as { projection_rebuilt?: boolean }).projection_rebuilt,
        ),
      );
      const low = BigInt("0x" + inventory.events[0].slice(5));
      const high = BigInt("0x" + inventory.events[1].slice(5));
      const between = low + (high - low) / 2n;
      const betweenId = "jve1:" + between.toString(16).padStart(64, "0");
      const afterId = "jve1:" + "f".repeat(64);
      await store.put("projections", betweenId, firstRow);
      const strayRow = await send(options);
      await store.delete("projections", betweenId);
      await store.put("records", betweenId, null);
      await store.put("records", afterId, { id: afterId });
      const extra = await send(options);
      await store.delete("records", betweenId);
      await store.delete("records", afterId);
      await store.delete("records", record.envelope.id);
      const missing = await send(options);
      await store.put("records", record.envelope.id, stored);
      await send(options);
      await store.put("records", record.envelope.id, {
        ...stored,
        id: other.envelope.id,
      });
      const trusted = await send(options);
      await store.delete("projections", record.envelope.id);
      const mismatchedId = await send(options);
      await store.put("records", record.envelope.id, stored);
      await send(options);
      await store.put("records", record.envelope.id, {
        ...stored,
        envelope: JSON.stringify(other.envelope),
      });
      await store.delete("projections", record.envelope.id);
      const mismatchedEnvelope = await send(options);
      await store.put("records", record.envelope.id, stored);
      await send(options);
      const forged = { ...record.envelope, signature: "invalid" };
      await store.put("records", record.envelope.id, {
        ...stored,
        envelope: JSON.stringify(forged),
      });
      await store.delete("projections", record.envelope.id);
      const ordinary = await send(options);
      return {
        original,
        warm,
        claimed,
        missing,
        extra,
        strayRow,
        trusted,
        mismatchedId,
        mismatchedEnvelope,
        ordinary,
        rebuilds,
        recovered,
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
  expect(results.original.projection_rebuilt).toBe(true);
  expect(results.warm.type).toBe("loaded");
  expect(results.warm.projection_rebuilt).toBe(false);
  expect(results.rebuilds).toEqual([true, true, true, true]);
  const summary = (value: Record<string, unknown>) => ({
    available: value.available,
    reasons: value.reasons,
    selected_view: value.selected_view,
    events: value.events,
    actors: value.actors,
  });
  for (const recovered of results.recovered)
    expect(summary(recovered)).toEqual(summary(results.original));
  expect(results.claimed.type).toBe("error");
  expect(results.claimed.message).toContain("unknown field `host_records`");
  expect(results.missing.type).toBe("error");
  expect(results.missing.message).toContain("is not cached");
  expect(results.extra.type).toBe("loaded");
  expect(results.strayRow.type).toBe("loaded");
  expect(results.strayRow.projection_rebuilt).toBe(false);
  expect(results.trusted.type).toBe("loaded");
  expect(results.mismatchedId.type).toBe("error");
  expect(results.mismatchedId.message).toBe(results.missing.message);
  expect(results.mismatchedEnvelope.type).toBe("error");
  expect(results.mismatchedEnvelope.message).toBe(results.missing.message);
  expect(results.ordinary.type).toBe("error");
});

test("an inventory commit prunes stale record and projection IDs and publishes metadata", async ({
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
      await store.put("projections", inventory.events[0], new Uint8Array([1]));
      await store.put(
        "projections",
        "jve1:" + "f".repeat(64),
        new Uint8Array([2]),
      );
      await store.commitInventory(inventory);
      return {
        keys: await store.keys("records"),
        projectionKeys: await store.keys("projections"),
        latest: await store.get("inventory", "latest"),
        pinned: await store.get("inventory", snapshot),
        meta: await store.get("meta", `projection:${snapshot}`),
        cursorCounts,
      };
    } finally {
      IDBObjectStore.prototype.openKeyCursor = openKeyCursor;
      IDBObjectStore.prototype.openCursor = openCursor;
      (await store.database).close();
    }
  });
  expect(result.keys).toEqual(["jve1:" + "a".repeat(64)]);
  expect(result.projectionKeys).toEqual(["jve1:" + "a".repeat(64)]);
  expect(result.latest).toEqual(result.pinned);
  expect(result.meta.events_digest).toBe("digest");
  expect(result.meta.count).toBe(1);
  expect(typeof result.meta.rows_hash).toBe("string");
  expect(result.cursorCounts).toEqual({ key: 0, value: 0 });
});

test("an unordered inventory commit fails without pruning or publishing", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore(`inventory-${crypto.randomUUID()}`);
    const a = "jve1:" + "a".repeat(64);
    const f = "jve1:" + "f".repeat(64);
    const snapshot = "sha256:" + "b".repeat(64);
    const inventory = {
      snapshot,
      logical_inventory: snapshot,
      events_digest: "digest",
      view: "jve1:" + "0".repeat(64),
      events: [a],
      bodies: [],
      selections: [],
    };
    try {
      await store.put("records", a, { id: a });
      await store.put("records", f, { id: f });
      await store.put("inventory", "latest", { snapshot: "old" });
      const errors: string[] = [];
      for (const events of [
        [f, a],
        [a, a],
      ]) {
        const error = await store
          .commitInventory({ ...inventory, events })
          .then(
            () => null,
            (error: unknown) =>
              error instanceof Error ? error.message : String(error),
          );
        errors.push(error ?? "committed");
      }
      return {
        errors,
        keys: await store.keys("records"),
        latest: await store.get("inventory", "latest"),
      };
    } finally {
      (await store.database).close();
    }
  });
  expect(result.errors).toEqual([
    "The inventory is not in order.",
    "The inventory is not in order.",
  ]);
  expect(result.keys).toEqual([
    "jve1:" + "a".repeat(64),
    "jve1:" + "f".repeat(64),
  ]);
  expect(result.latest).toEqual({ snapshot: "old" });
});

test("sync stores a projection with every record and deletes both together", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { forgetInventory, syncRecords } = await import(
      String("/src/data/records.ts")
    );
    await core.initializeCore();
    const store = new LocalStore(
      `sync-projection-${crypto.randomUUID()}`,
    ) as BrowserStore;
    const get = IDBObjectStore.prototype.get;
    let latestReads = 0;
    IDBObjectStore.prototype.get = function (key) {
      if (this.name === "inventory" && key === "latest") latestReads++;
      return get.call(this, key);
    };
    try {
      const inventory = await syncRecords(store);
      const syncLatestReads = latestReads;
      const records = await store.keys("records");
      const projections = await store.keys("projections");
      const first = inventory.events[0];
      const row = await store.get<Uint8Array>("projections", first);
      await store.delete("records", first);
      await forgetInventory(store);
      return {
        inventory,
        records,
        projections,
        syncLatestReads,
        rowBytes: row?.byteLength ?? 0,
        deletedRecord: await store.get("records", first),
        deletedProjection: await store.get("projections", first),
        forgottenInventory: await store.get("inventory", "latest"),
        forgottenProjection: await store.get("meta", "projection:latest"),
      };
    } finally {
      IDBObjectStore.prototype.get = get;
      (await store.database).close();
    }
  }, corePath);
  expect(result.syncLatestReads).toBe(2);
  expect(result.records).toEqual(result.inventory.events);
  expect(result.projections).toEqual(result.inventory.events);
  expect(result.rowBytes).toBeGreaterThan(100);
  expect(result.deletedRecord).toBeUndefined();
  expect(result.deletedProjection).toBeUndefined();
  expect(result.forgottenInventory).toBeUndefined();
  expect(result.forgottenProjection).toBeUndefined();
});
