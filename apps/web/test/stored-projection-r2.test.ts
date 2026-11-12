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
        const bodyRecord = await (async () => {
          for (const id of inventory.events) {
            const record = await store.get<{
              body: string | null;
              bodyHash: string | null;
            }>("records", id);
            if (record?.body && record.bodyHash) return { id, ...record };
          }
          return null;
        })();
        if (!bodyRecord?.bodyHash) throw new Error("No body-bearing record.");
        const dropped = {
          ...inventory,
          snapshot: nextSnapshot("b"),
          logical_inventory: nextSnapshot("b"),
          bodies: inventory.bodies.filter(
            (hash: string) => hash !== bodyRecord.bodyHash,
          ),
          unretained_bodies: [
            ...new Set([
              ...(inventory.unretained_bodies ?? []),
              bodyRecord.bodyHash,
            ]),
          ].sort(),
        };
        await store.commitInventory(dropped);
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
  expect(results.firstMeta?.rows_hash).toBeNull();
  expect(typeof results.loadedMeta?.rows_hash).toBe("string");
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
        const events: string[] = [];
        const bodies: Record<string, string> = {};
        for (const id of inventory.events) {
          const record = await store.get<{
            envelope: string;
            body: string | null;
            bodyHash: string | null;
          }>("records", id);
          events.push(record!.envelope);
          if (record!.body && record!.bodyHash) bodies[id] = record!.body!;
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
