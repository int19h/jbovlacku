import { expect, test } from "@playwright/test";
import { corePath } from "./helpers.ts";
import type { LocalStore as BrowserStore } from "../src/data/store.ts";

test("an interrupted sync resumes from committed record pages", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { syncRecords } = await import(String("/src/data/records.ts"));
    const seed = new Uint8Array(32).fill(91);
    const items = Array.from({ length: 201 }, (_, index) =>
      core.createEvent(
        seed,
        [],
        String(index + 1).padStart(32, "0"),
        { kind: "identity.merge" },
        null,
      ),
    )
      .map((event: any) => ({ id: event.envelope.id, ...event }))
      .sort((a: any, b: any) => (a.id < b.id ? -1 : 1));
    const canon = (value: unknown) =>
      core.canonicalize(core.utf8(JSON.stringify(value)));
    const hash = (value: unknown) => core.contentHash(core.utf8(canon(value)));
    const events = items.map((item: any) => item.id);
    const bodies: string[] = [];
    const selections: string[] = [];
    const declared = {
      events: {
        count: events.length,
        hash: core.contentHash(
          core.utf8(
            items.map((item: any) => canon(item.envelope) + "\n").join(""),
          ),
        ),
      },
      bodies: { count: 0, hash: hash(bodies) },
      import_selections: { count: 0, hash: hash(selections) },
    };
    const snapshot = hash(declared);
    const logical_inventory = hash({
      events,
      bodies,
      import_selections: selections,
    });
    const view = "jve1:" + "f".repeat(64);
    const recordRequests: (string | null)[] = [];
    const saved = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(
        String(input instanceof Request ? input.url : input),
        location.origin,
      );
      let value: unknown;
      if (url.pathname.endsWith("/manifest")) {
        value = {
          snapshot,
          logical_inventory,
          manifest: declared,
          view,
          accepted_cursor: "x.1",
          materialized_cursor: "x.1",
          packages: [],
        };
      } else if (url.pathname.endsWith("/inventory")) {
        const kind = url.searchParams.get("kind")!;
        const ids =
          kind === "events" ? events : kind === "bodies" ? bodies : selections;
        const after = url.searchParams.get("after");
        const start = after === null ? 0 : ids.indexOf(after) + 1;
        const limit = Number(url.searchParams.get("limit"));
        const pageIds = ids.slice(start, start + limit);
        value = {
          snapshot,
          kind,
          ids: pageIds,
          next: start + limit < ids.length ? pageIds.at(-1) : null,
        };
      } else if (url.pathname.endsWith("/records")) {
        const after = url.searchParams.get("after");
        recordRequests.push(after);
        const start = after === null ? 0 : events.indexOf(after) + 1;
        const limit = Number(url.searchParams.get("limit"));
        const pageItems = items.slice(start, start + limit);
        value = {
          snapshot,
          items: pageItems,
          next: start + limit < items.length ? pageItems.at(-1).id : null,
        };
      } else {
        value = { view };
      }
      return new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const store = new LocalStore(
      `resume-sync-${crypto.randomUUID()}`,
    ) as BrowserStore;
    let maxRead = 0;
    let maxWrite = 0;
    const read = store.readRecords.bind(store);
    store.readRecords = async (ids: string[]) => {
      maxRead = Math.max(maxRead, ids.length);
      return read(ids);
    };
    const write = store.putProjectedRecords.bind(store);
    store.putProjectedRecords = async (records: any[], latest: any) => {
      maxWrite = Math.max(maxWrite, records.length);
      return write(records, latest);
    };
    try {
      const controller = new AbortController();
      let firstError = "";
      try {
        await syncRecords(store, {
          signal: controller.signal,
          onProgress: (progress: { phase: string; loaded: number }) => {
            if (progress.phase === "records" && progress.loaded === 200)
              controller.abort(
                new Error("Interrupt after one committed page."),
              );
          },
        });
      } catch (error) {
        firstError = String(error);
      }
      const firstStored = await store.keys("records");
      const firstLatest = await store.get("inventory", "latest");
      const inventory = await syncRecords(store);
      return {
        firstError,
        firstStored: firstStored.length,
        firstLatest,
        secondEvents: inventory.events.length,
        recordRequests,
        maxRead,
        maxWrite,
      };
    } finally {
      globalThis.fetch = saved;
      (await store.database).close();
    }
  }, corePath);
  expect(result.firstError).toContain("Interrupt after one committed page");
  expect(result.firstStored).toBe(200);
  expect(result.firstLatest).toBeUndefined();
  expect(result.secondEvents).toBe(201);
  expect(result.recordRequests).toHaveLength(2);
  expect(result.recordRequests[0]).toBeNull();
  expect(typeof result.recordRequests[1]).toBe("string");
  expect(result.maxRead).toBeLessThanOrEqual(256);
  expect(result.maxWrite).toBeLessThanOrEqual(200);
});

test("inventory traversal continues beyond one thousand pages", async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.goto("/");
  const result = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { syncRecords } = await import(String("/src/data/records.ts"));
    const canon = (value: unknown) =>
      core.canonicalize(core.utf8(JSON.stringify(value)));
    const hash = (value: unknown) => core.contentHash(core.utf8(canon(value)));
    const events: string[] = [];
    const bodies = Array.from(
      { length: 1001 },
      (_, index) => `sha256:${index.toString(16).padStart(64, "0")}`,
    );
    const selections: string[] = [];
    const declared = {
      events: { count: 0, hash: core.contentHash(core.utf8("")) },
      bodies: { count: bodies.length, hash: hash(bodies) },
      import_selections: { count: 0, hash: hash(selections) },
    };
    const snapshot = hash(declared);
    const logical_inventory = hash({
      events,
      bodies,
      import_selections: selections,
    });
    const view = "jve1:" + "f".repeat(64);
    let bodyPages = 0;
    const saved = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(
        String(input instanceof Request ? input.url : input),
        location.origin,
      );
      let value: unknown;
      if (url.pathname.endsWith("/manifest")) {
        value = {
          snapshot,
          logical_inventory,
          manifest: declared,
          view,
          accepted_cursor: "x.1",
          materialized_cursor: "x.1",
          packages: [],
        };
      } else if (url.pathname.endsWith("/inventory")) {
        const kind = url.searchParams.get("kind")!;
        const ids =
          kind === "events" ? events : kind === "bodies" ? bodies : selections;
        if (kind === "bodies") bodyPages++;
        const after = url.searchParams.get("after");
        const start = after === null ? 0 : ids.indexOf(after) + 1;
        const pageIds = ids.slice(start, start + 1);
        value = {
          snapshot,
          kind,
          ids: pageIds,
          next: start + 1 < ids.length ? pageIds[0] : null,
        };
      } else {
        value = { view };
      }
      return new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const store = new LocalStore(
      `paged-inventory-${crypto.randomUUID()}`,
    ) as BrowserStore;
    try {
      const inventory = await syncRecords(store);
      return { bodyPages, bodies: inventory.bodies.length };
    } finally {
      globalThis.fetch = saved;
      (await store.database).close();
    }
  }, corePath);
  expect(result.bodyPages).toBe(1001);
  expect(result.bodies).toBe(1001);
});

test("sync rejects an empty inventory page with a non-advancing cursor", async ({
  page,
}) => {
  const id = "jve1:" + "a".repeat(64);
  let eventPages = 0;
  await page.route("**/api/v1/inventory?*", async (route) => {
    const url = new URL(route.request().url());
    const kind = url.searchParams.get("kind");
    let value: unknown;
    if (kind === "events") {
      eventPages++;
      value = {
        snapshot: url.searchParams.get("snapshot"),
        kind,
        ids: eventPages === 1 ? [id] : [],
        next: id,
      };
    } else {
      value = {
        snapshot: url.searchParams.get("snapshot"),
        kind,
        ids: [],
        next: null,
      };
    }
    await route.fulfill({ json: value });
  });
  await page.goto("/");
  const result = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { syncRecords } = await import(String("/src/data/records.ts"));
    const store = new LocalStore(`static-cursor-${crypto.randomUUID()}`);
    try {
      await syncRecords(store);
      return null;
    } catch (error) {
      const failure = error as { kind?: string; message?: string };
      return { kind: failure.kind, message: failure.message };
    } finally {
      (await store.database).close();
    }
  }, corePath);
  expect(eventPages).toBe(2);
  expect(result?.kind).toBe("invalid");
  expect(result?.message).toContain("cursor did not advance");
});

test("sync rejects a records page above the per-message bound", async ({
  page,
}) => {
  await page.route("**/api/v1/records?*", async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    value.items = Array.from(
      { length: 201 },
      (_, index) => value.items[index % value.items.length],
    );
    await route.fulfill({ response, json: value });
  });
  await page.goto("/");
  const result = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { syncRecords, RecordsError } = await import(
      String("/src/data/records.ts")
    );
    const store = new LocalStore(
      `bounded-response-${crypto.randomUUID()}`,
    ) as BrowserStore;
    try {
      await syncRecords(store);
      return null;
    } catch (error) {
      const failure = error as { kind?: string; message?: string };
      return { kind: failure.kind, message: failure.message };
    } finally {
      (await store.database).close();
    }
  }, corePath);
  expect(result?.kind).toBe("invalid");
  expect(result?.message).toContain("per-page bound");
});

test("a terminal records page reports missing inventory before a no-write traversal error", async ({
  page,
}) => {
  await page.route("**/api/v1/records?*", async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    value.items = value.items.slice(1);
    value.next = null;
    await route.fulfill({ response, json: value });
  });
  await page.goto("/");
  const result = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { syncRecords } = await import(String("/src/data/records.ts"));
    const store = new LocalStore(`missing-records-${crypto.randomUUID()}`);
    const errors: { kind?: string; message?: string }[] = [];
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await syncRecords(store);
        } catch (error) {
          const failure = error as { kind?: string; message?: string };
          errors.push({ kind: failure.kind, message: failure.message });
        }
      }
      return errors;
    } finally {
      (await store.database).close();
    }
  }, corePath);
  expect(result).toHaveLength(2);
  for (const error of result) {
    expect(error.kind).toBe("missing");
    expect(error.message).toContain(
      "inventory records are missing from the records transport",
    );
  }
});

test("sync reports physical storage and memory failures", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { syncRecords } = await import(String("/src/data/records.ts"));
    const store = new LocalStore(
      `bounded-page-${crypto.randomUUID()}`,
    ) as BrowserStore;
    const write = store.putProjectedRecords.bind(store);
    store.putProjectedRecords = async () => {
      throw new DOMException("The quota is full.", "QuotaExceededError");
    };
    let storage: { kind: string; message: string } | null = null;
    try {
      await syncRecords(store);
    } catch (error) {
      const failure = error as { kind: string; message: string };
      storage = { kind: failure.kind, message: failure.message };
    }
    store.putProjectedRecords = write;
    const memoryStore = new LocalStore(
      `bounded-page-${crypto.randomUUID()}`,
    ) as BrowserStore;
    memoryStore.putProjectedRecords = async () => {
      throw new RangeError("Array buffer allocation failed");
    };
    let memory: { kind: string; message: string } | null = null;
    try {
      await syncRecords(memoryStore);
    } catch (error) {
      const failure = error as { kind: string; message: string };
      memory = { kind: failure.kind, message: failure.message };
    }
    (await memoryStore.database).close();
    return { storage, memory };
  }, corePath);
  expect(result.storage?.kind).toBe("storage");
  expect(result.storage?.message).toContain("storage quota is full");
  expect(result.memory?.kind).toBe("memory");
  expect(result.memory?.message).toContain("ran out of memory");
});

test("a first inventory commit reads projection rows in batches", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore(`first-commit-${crypto.randomUUID()}`);
    const snapshot = "sha256:" + "b".repeat(64);
    const events = Array.from(
      { length: 300 },
      (_, index) => `jve1:${index.toString(16).padStart(64, "0")}`,
    );
    for (let start = 0; start < events.length; start += 200) {
      await store.putProjectedRecords(
        events.slice(start, start + 200).map((id) => ({
          record: { id, body: null },
          row: new Uint8Array([1]),
        })),
        null,
      );
    }
    const get = IDBObjectStore.prototype.get;
    const getAll = IDBObjectStore.prototype.getAll;
    let projectionGets = 0;
    let projectionBatchReads = 0;
    IDBObjectStore.prototype.get = function (this: IDBObjectStore, key) {
      if (this.name === "projections") projectionGets++;
      return get.call(this, key);
    } as typeof get;
    IDBObjectStore.prototype.getAll = function (this: IDBObjectStore, ...args) {
      if (this.name === "projections") projectionBatchReads++;
      return getAll.apply(this, args);
    } as typeof getAll;
    try {
      await store.commitInventory({
        snapshot,
        logical_inventory: snapshot,
        events_digest: "digest",
        view: "jve1:" + "0".repeat(64),
        events,
        bodies: [],
        selections: [],
      });
      return {
        projectionGets,
        projectionBatchReads,
        count: ((await store.get("meta", `projection:${snapshot}`)) as any)
          .count,
      };
    } finally {
      IDBObjectStore.prototype.get = get;
      IDBObjectStore.prototype.getAll = getAll;
      (await store.database).close();
    }
  });
  expect(result.projectionGets).toBe(0);
  expect(result.projectionBatchReads).toBe(2);
  expect(result.count).toBe(300);
});
