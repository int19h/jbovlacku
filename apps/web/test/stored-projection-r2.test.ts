import { expect, test } from "@playwright/test";
import { corePath, fixture } from "./helpers.ts";
import type { LocalStore as BrowserStore } from "../src/data/store.ts";

const nextSnapshot = (letter: string) => "sha256:" + letter.repeat(64);

test("row loads follow body retention when it drops and returns", async ({
  page,
}) => {
  await page.goto("/");
  const word = fixture().words.cukta;
  const results = await page.evaluate(
    async ({ corePath, word }) => {
      const core = await import(corePath);
      const nextSnapshot = (letter: string) => "sha256:" + letter.repeat(64);
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { syncRecords, loadSelections } = await import(
        String("/src/data/records.ts")
      );
      await core.initializeCore();
      const store = new LocalStore(
        `retention-${crypto.randomUUID()}`,
      ) as BrowserStore;
      const inventory = await syncRecords(store);
      const options = {
        selected_view: inventory.view,
        import_selections: await loadSelections(store, inventory),
      };
      const worker = new Worker(
        new URL("/src/workers/evaluate.ts", location.href),
        { type: "module" },
      );
      let sequence = 0;
      const send = (message: Record<string, unknown>) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const id = ++sequence;
          worker.onmessage = (event) => resolve(event.data);
          worker.onerror = (event) => reject(new Error(event.message));
          worker.postMessage({ ...message, id });
        });
      const original = async (current: typeof inventory) => {
        const events: string[] = [];
        const bodies: Record<string, string> = {};
        for (const id of current.events) {
          const record = await store.get<{
            envelope: string;
            body: string | null;
            bodyStatus: string;
            bodyHash: string | null;
          }>("records", id);
          events.push(record!.envelope);
          if (
            record!.body &&
            record!.bodyHash &&
            current.bodies.includes(record!.bodyHash)
          )
            bodies[id] = record!.body!;
        }
        const session = core.evaluateSession({
          events,
          bodies,
          selected_view: current.view,
          import_selections: await loadSelections(store, current),
        });
        const result = {
          summary: session.summary(),
          actors: session.actors(),
          rank: session.rankWord(word, 64),
        };
        session.free();
        return result;
      };
      const rows = async (current: typeof inventory) => {
        const loaded = await send({
          type: "load",
          session: current.snapshot,
          source: {
            database: store.name,
            snapshot: current.snapshot,
            events_digest: current.events_digest,
            count: current.events.length,
          },
          options,
        });
        if (loaded.type === "error") throw new Error(String(loaded.message));
        const ranked = await send({
          type: "rank",
          session: current.snapshot,
          word,
          reviewers: 64,
        });
        return {
          summary: {
            available: loaded.available,
            reasons: loaded.reasons,
            selected_view: loaded.selected_view,
            events: loaded.events,
          },
          actors: loaded.actors,
          rank: ranked.result,
          rebuilt: loaded.projection_rebuilt,
        };
      };
      try {
        const firstMeta = await store.get<Record<string, unknown>>(
          "meta",
          `projection:${inventory.snapshot}`,
        );
        const before = {
          expected: await original(inventory),
          actual: await rows(inventory),
        };
        const loadedMeta = await store.get<Record<string, unknown>>(
          "meta",
          `projection:${inventory.snapshot}`,
        );
        const droppedHashes = new Set<string>();
        for (const id of inventory.events) {
          const record = await store.get<{
            envelope: string;
            body: string | null;
            bodyStatus: string;
            bodyHash: string | null;
          }>("records", id);
          const action = JSON.parse(record!.envelope).header.action;
          if (
            action.kind === "definition.publish" &&
            action.word === word &&
            record!.bodyStatus === "present" &&
            record!.body &&
            record!.bodyHash
          )
            droppedHashes.add(record!.bodyHash);
        }
        if (!droppedHashes.size)
          throw new Error("No retained definition body for the ranked word.");
        const dropped = {
          ...inventory,
          snapshot: nextSnapshot("b"),
          logical_inventory: nextSnapshot("b"),
          bodies: inventory.bodies.filter(
            (hash: string) => !droppedHashes.has(hash),
          ),
          unretained_bodies: [
            ...new Set([
              ...(inventory.unretained_bodies ?? []),
              ...droppedHashes,
            ]),
          ].sort(),
        };
        await store.commitInventory(dropped);
        const droppedMeta = await store.get<Record<string, unknown>>(
          "meta",
          `projection:${dropped.snapshot}`,
        );
        await store.put("meta", `projection:${dropped.snapshot}`, {
          ...droppedMeta,
          build: "different",
        });
        const afterDrop = {
          expected: await original(dropped),
          actual: await rows(dropped),
        };
        const restored = {
          ...inventory,
          snapshot: nextSnapshot("c"),
          logical_inventory: nextSnapshot("c"),
        };
        await store.commitInventory(restored);
        const afterRestore = {
          expected: await original(restored),
          actual: await rows(restored),
        };
        return { firstMeta, loadedMeta, before, afterDrop, afterRestore };
      } finally {
        worker.terminate();
        (await store.database).close();
      }
    },
    { corePath, word },
  );
  expect(typeof results.firstMeta?.rows_hash).toBe("string");
  expect(typeof results.loadedMeta?.rows_hash).toBe("string");
  expect(results.afterDrop.expected.rank).not.toEqual(
    results.before.expected.rank,
  );
  expect(results.afterDrop.actual.rebuilt).toBe(true);
  for (const result of [
    results.before,
    results.afterDrop,
    results.afterRestore,
  ]) {
    expect(result.actual.summary).toEqual(result.expected.summary);
    expect(result.actual.actors).toEqual(result.expected.actors);
    expect(result.actual.rank).toEqual(result.expected.rank);
  }
});

test("sync over rows from another build rebuilds instead of relabeling them", async ({
  page,
}) => {
  await page.goto("/");
  const word = fixture().words.cukta;
  const results = await page.evaluate(
    async ({ corePath, word }) => {
      const core = await import(corePath);
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { syncRecords, loadSelections } = await import(
        String("/src/data/records.ts")
      );
      await core.initializeCore();
      const store = new LocalStore(
        `producer-${crypto.randomUUID()}`,
      ) as BrowserStore;
      const inventory = await syncRecords(store);
      await store.put("meta", "projection:producer", "older-build");
      await syncRecords(store);
      const staleMeta = await store.get<Record<string, unknown>>(
        "meta",
        `projection:${inventory.snapshot}`,
      );
      const worker = new Worker(
        new URL("/src/workers/evaluate.ts", location.href),
        { type: "module" },
      );
      try {
        const loaded = await new Promise<Record<string, unknown>>(
          async (resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onerror = (event) => reject(new Error(event.message));
            worker.postMessage({
              type: "load",
              id: 1,
              session: inventory.snapshot,
              source: {
                database: store.name,
                snapshot: inventory.snapshot,
                events_digest: inventory.events_digest,
                count: inventory.events.length,
              },
              options: {
                selected_view: inventory.view,
                import_selections: await loadSelections(store, inventory),
              },
            });
          },
        );
        const ranked = await new Promise<Record<string, unknown>>(
          (resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onerror = (event) => reject(new Error(event.message));
            worker.postMessage({
              type: "rank",
              id: 2,
              session: inventory.snapshot,
              word,
              reviewers: 64,
            });
          },
        );
        await store.put("meta", "projection:producer", "mixed");
        const liveLoaded = await new Promise<Record<string, unknown>>(
          async (resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onerror = (event) => reject(new Error(event.message));
            worker.postMessage({
              type: "load",
              id: 3,
              session: inventory.snapshot,
              source: {
                database: store.name,
                snapshot: inventory.snapshot,
                events_digest: inventory.events_digest,
                count: inventory.events.length,
              },
              options: {
                selected_view: inventory.view,
                import_selections: await loadSelections(store, inventory),
              },
            });
          },
        );
        const events: string[] = [];
        const bodies: Record<string, string> = {};
        for (const id of inventory.events) {
          const record = await store.get<{
            envelope: string;
            body: string | null;
            bodyStatus: string;
            bodyHash: string | null;
          }>("records", id);
          events.push(record!.envelope);
          if (
            record!.body &&
            record!.bodyHash &&
            inventory.bodies.includes(record!.bodyHash)
          )
            bodies[id] = record!.body!;
        }
        const expected = core.evaluateSession({
          events,
          bodies,
          selected_view: inventory.view,
          import_selections: await loadSelections(store, inventory),
        });
        const expectedResult = {
          summary: expected.summary(),
          actors: expected.actors(),
          rank: expected.rankWord(word, 64),
        };
        expected.free();
        return {
          staleBuild: staleMeta?.build,
          loaded,
          liveLoaded,
          ranked,
          expectedResult,
          producer: await store.get("meta", "projection:producer"),
        };
      } finally {
        worker.terminate();
        (await store.database).close();
      }
    },
    { corePath, word },
  );
  expect(results.staleBuild).toBe("older-build");
  expect(results.loaded.projection_rebuilt).toBe(true);
  expect(results.liveLoaded.projection_rebuilt).toBe(true);
  expect(results.loaded.available).toBe(
    results.expectedResult.summary.available,
  );
  expect(results.loaded.reasons).toEqual(
    results.expectedResult.summary.reasons,
  );
  expect(results.loaded.events).toBe(results.expectedResult.summary.events);
  expect(results.loaded.actors).toEqual(results.expectedResult.actors);
  expect(results.ranked.result).toEqual(results.expectedResult.rank);
  expect(results.producer).not.toBe("older-build");
});

test("advance and pruning keep the incremental row digest current", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { syncRecords, loadSelections } = await import(
      String("/src/data/records.ts")
    );
    await core.initializeCore();
    const store = new LocalStore(
      `digest-${crypto.randomUUID()}`,
    ) as BrowserStore;
    const worker = new Worker(
      new URL("/src/workers/evaluate.ts", location.href),
      { type: "module" },
    );
    try {
      const inventory = await syncRecords(store);
      const firstHash = (
        await store.get<Record<string, unknown>>(
          "meta",
          `projection:${inventory.snapshot}`,
        )
      )?.rows_hash;
      const added = core.createEvent(
        new Uint8Array(32).fill(111),
        [],
        "7".repeat(32),
        { kind: "identity.merge" },
        null,
      );
      const projected = core.projectRecord(
        core.utf8(JSON.stringify(added.envelope)),
      );
      const stored = {
        id: added.envelope.id,
        envelope: JSON.stringify(added.envelope),
        body: null,
        bodyStatus: "none",
        bodyHash: null,
      };
      await store.putProjectedRecord(stored, projected.row);
      const advanced = {
        ...inventory,
        snapshot: "sha256:" + "d".repeat(64),
        logical_inventory: "sha256:" + "d".repeat(64),
        events: [...inventory.events, added.envelope.id].sort(),
      };
      await store.commitInventory(advanced);
      const advancedHash = (
        await store.get<Record<string, unknown>>(
          "meta",
          `projection:${advanced.snapshot}`,
        )
      )?.rows_hash;
      const selections = await loadSelections(store, advanced);
      const advancedLoad = await new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          worker.onmessage = (event) => resolve(event.data);
          worker.onerror = (event) => reject(new Error(event.message));
          worker.postMessage({
            type: "load",
            id: 1,
            session: advanced.snapshot,
            source: {
              database: store.name,
              snapshot: advanced.snapshot,
              events_digest: advanced.events_digest,
              count: advanced.events.length,
            },
            options: {
              selected_view: advanced.view,
              import_selections: selections,
            },
          });
        },
      );
      await store.commitInventory(inventory);
      const prunedHash = (
        await store.get<Record<string, unknown>>(
          "meta",
          `projection:${inventory.snapshot}`,
        )
      )?.rows_hash;
      return { firstHash, advancedHash, advancedLoad, prunedHash };
    } finally {
      worker.terminate();
      (await store.database).close();
    }
  }, corePath);
  expect(result.advancedHash).not.toBe(result.firstHash);
  expect(result.advancedLoad.type).toBe("loaded");
  expect(result.advancedLoad.projection_rebuilt).toBe(false);
  expect(result.prunedHash).toBe(result.firstHash);
});

test("record deletion removes the old row from the digest", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { syncRecords } = await import(String("/src/data/records.ts"));
    await core.initializeCore();
    const store = new LocalStore(
      `delete-digest-${crypto.randomUUID()}`,
    ) as BrowserStore;
    try {
      const inventory = await syncRecords(store);
      const deleted = inventory.events[0];
      const key = `projection:${inventory.snapshot}`;
      const beforeHash = (await store.get<Record<string, unknown>>("meta", key))
        ?.rows_hash;
      await store.delete("records", deleted);
      const digest = core.createProjectionDigest();
      for (const id of inventory.events) {
        const row = await store.get<Uint8Array>("projections", id);
        if (row) digest.update(id, row);
      }
      return {
        beforeHash,
        expectedHash: digest.finish(),
        actualHash: (await store.get<Record<string, unknown>>("meta", key))
          ?.rows_hash,
        record: await store.get("records", deleted),
        row: await store.get("projections", deleted),
      };
    } finally {
      (await store.database).close();
    }
  }, corePath);
  expect(result.actualHash).toBe(result.expectedHash);
  expect(result.actualHash).not.toBe(result.beforeHash);
  expect(result.record).toBeUndefined();
  expect(result.row).toBeUndefined();
});

test("a decodable row change is caught on the first load of a new page", async ({
  page,
}) => {
  await page.goto("/");
  const stored = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { syncRecords, loadSelections } = await import(
      String("/src/data/records.ts")
    );
    await core.initializeCore();
    const store = new LocalStore(
      `first-load-${crypto.randomUUID()}`,
    ) as BrowserStore;
    try {
      const inventory = await syncRecords(store);
      const options = {
        selected_view: inventory.view,
        import_selections: await loadSelections(store, inventory),
      };
      for (const id of inventory.events) {
        const row = await store.get<Uint8Array>("projections", id);
        if (!row || row[65] !== 0 || row[66] === 255) continue;
        const changed = new Uint8Array(row);
        changed[67] ^= 1;
        const decoder = core.createEvaluationSession(options);
        decoder.addProjectionRow(changed, id);
        decoder.free();
        await store.put("projections", id, changed);
        return { database: store.name, inventory, options };
      }
      throw new Error("No suitable projection row.");
    } finally {
      (await store.database).close();
    }
  }, corePath);
  await page.reload();
  const results = await page.evaluate(
    async ({ corePath, stored }) => {
      const core = await import(corePath);
      const { LocalStore } = await import(String("/src/data/store.ts"));
      await core.initializeCore();
      const store = new LocalStore(stored.database) as BrowserStore;
      const worker = new Worker(
        new URL("/src/workers/evaluate.ts", location.href),
        { type: "module" },
      );
      let sequence = 0;
      const load = () =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          worker.onmessage = (event) => resolve(event.data);
          worker.onerror = (event) => reject(new Error(event.message));
          worker.postMessage({
            type: "load",
            id: ++sequence,
            session: stored.inventory.snapshot,
            source: {
              database: stored.database,
              snapshot: stored.inventory.snapshot,
              events_digest: stored.inventory.events_digest,
              count: stored.inventory.events.length,
            },
            options: stored.options,
          });
        });
      try {
        return [await load(), await load()];
      } finally {
        worker.terminate();
        (await store.database).close();
      }
    },
    { corePath, stored },
  );
  expect(results[0].type).toBe("loaded");
  expect(results[0].projection_rebuilt).toBe(true);
  expect(results[1].type).toBe("loaded");
  expect(results[1].projection_rebuilt).toBe(false);
});
