import { expect, test } from "@playwright/test";
import { corePath } from "./helpers.ts";
import type { LocalStore as BrowserStore } from "../src/data/store.ts";
import type { SnapshotInventory } from "../src/data/records.ts";

test("the version 6 upgrade clears legacy record projections for a fresh sync", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const name = `legacy-upgrade-${crypto.randomUUID()}`;
    await new Promise<void>((resolve, reject) => {
      const opening = indexedDB.open(name, 5);
      opening.onupgradeneeded = () => {
        for (const store of [
          "records",
          "projections",
          "inventory",
          "meta",
          "drafts",
        ])
          opening.result.createObjectStore(store);
      };
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const database = opening.result;
        const transaction = database.transaction(
          ["records", "projections", "inventory", "meta", "drafts"],
          "readwrite",
        );
        transaction
          .objectStore("records")
          .put(
            { id: "legacy", envelope: "legacy", body: null, bodyHash: null },
            "legacy",
          );
        transaction
          .objectStore("projections")
          .put(new Uint8Array([1]), "legacy");
        transaction
          .objectStore("inventory")
          .put({ snapshot: "legacy" }, "latest");
        transaction.objectStore("meta").put("legacy", "projection:latest");
        transaction.objectStore("drafts").put({ revision: "keep" }, "current");
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore(name) as BrowserStore;
    try {
      return {
        version: (await store.database).version,
        record: await store.get("records", "legacy"),
        row: await store.get("projections", "legacy"),
        latest: await store.get("inventory", "latest"),
        producer: await store.get("meta", "projection:latest"),
        draft: await store.get("drafts", "current"),
      };
    } finally {
      (await store.database).close();
    }
  });
  expect(result.version).toBe(6);
  expect(result.record).toBeUndefined();
  expect(result.row).toBeUndefined();
  expect(result.latest).toBeUndefined();
  expect(result.producer).toBeUndefined();
  expect(result.draft).toEqual({ revision: "keep" });
});

test("an interrupted sync preserves a concurrently downloaded body", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { syncRecords } = await import(String("/src/data/records.ts"));
    await core.initializeCore();
    const store = new LocalStore(
      `interrupted-sync-${crypto.randomUUID()}`,
    ) as BrowserStore;
    try {
      const inventory = await syncRecords(store);
      let full: any;
      for (const id of inventory.events) {
        const record = await store.get<any>("records", id);
        if (
          record.body &&
          JSON.parse(record.envelope).header.action.kind ===
            "definition.publish"
        ) {
          full = record;
          break;
        }
      }
      const fullRow = await store.get<Uint8Array>("projections", full.id);
      const legacy = { ...full, body: null, bodyStatus: "missing" };
      await store.put("records", full.id, legacy);
      await store.commitInventory({
        ...inventory,
        snapshot: "sha256:" + "a".repeat(64),
        logical_inventory: "sha256:" + "a".repeat(64),
        bodies: inventory.bodies.filter(
          (hash: string) => hash !== full.bodyHash,
        ),
        unretained_bodies: [
          ...new Set([...(inventory.unretained_bodies ?? []), full.bodyHash]),
        ].sort(),
      });
      const get = store.get.bind(store) as <T>(
        name: string,
        id: string,
      ) => Promise<T | undefined>;
      let intervened = false;
      store.get = async <T>(
        name: string,
        id: string,
      ): Promise<T | undefined> => {
        const cached = await get<T>(name, id);
        if (!intervened && name === "records" && id === full.id) {
          intervened = true;
          const second = new LocalStore(store.name) as BrowserStore;
          try {
            await syncRecords(second);
          } finally {
            (await second.database).close();
          }
        }
        return cached;
      };
      const controller = new AbortController();
      let syncError = "";
      try {
        await syncRecords(store, {
          signal: controller.signal,
          onProgress: (progress: { phase: string }) => {
            if (progress.phase === "records")
              controller.abort(new Error("Stop after the competing sync."));
          },
        });
      } catch (error) {
        syncError = String(error);
      }
      const after = await get<any>("records", full.id);
      const rowAfter = await get<Uint8Array>("projections", full.id);
      return {
        intervened,
        syncError,
        bodyPreserved: after.body === full.body,
        bodyStatus: after.bodyStatus,
        rowPreserved:
          Array.from(rowAfter!).join() === Array.from(fullRow!).join(),
      };
    } finally {
      (await store.database).close();
    }
  }, corePath);
  expect(result.intervened).toBe(true);
  expect(result.bodyPreserved).toBe(true);
  expect(result.bodyStatus).toBe("present");
  expect(result.rowPreserved).toBe(true);
});

test("a rejected advance uses the full-load digest on the next advance", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { syncRecords } = await import(String("/src/data/records.ts"));
    const { PersonalCalculator } = await import(
      String("/src/data/personal.ts")
    );
    await core.initializeCore();
    const store = new LocalStore(
      `fallback-digest-${crypto.randomUUID()}`,
    ) as BrowserStore;
    const NativeWorker = globalThis.Worker;
    const operations: string[] = [];
    let rejectNextAdvance = true;
    globalThis.Worker = class extends NativeWorker {
      postMessage(message: any, options?: any) {
        operations.push(message.type);
        if (message.type === "advance" && rejectNextAdvance) {
          rejectNextAdvance = false;
          void (async () => {
            await store.put("meta", "projection:producer", "other-build");
            super.postMessage(message, options);
          })();
        } else {
          super.postMessage(message, options);
        }
      }
    };
    const append = async (
      inventory: SnapshotInventory,
      letter: string,
      damaged: boolean,
    ) => {
      const event = core.createEvent(
        new Uint8Array(32).fill(letter.charCodeAt(0)),
        [],
        letter.repeat(32),
        { kind: "identity.merge" },
        null,
      );
      const projected = core.projectRecord(
        core.utf8(JSON.stringify(event.envelope)),
      );
      const row = new Uint8Array(projected.row);
      if (damaged) row[33] ^= 1;
      const stored = {
        id: event.envelope.id,
        envelope: projected.envelope,
        body: null,
        bodyHash: null,
        bodyStatus: "none",
      };
      await store.putProjectedRecord(stored, row);
      const events = [...inventory.events, event.envelope.id].sort();
      const envelopes = await Promise.all(
        events.map(async (id) => {
          const record = await store.get<{ envelope: string }>("records", id);
          return record!.envelope + "\n";
        }),
      );
      const next = {
        ...inventory,
        snapshot: "sha256:" + letter.repeat(64),
        logical_inventory: "sha256:" + letter.repeat(64),
        events,
        events_digest: core.contentHash(core.utf8(envelopes.join(""))),
      };
      await store.commitInventory(next);
      return { next, projected, id: event.envelope.id };
    };
    try {
      let inventory = await syncRecords(store);
      const calculator = new PersonalCalculator(store, async () => ({
        identity: null,
      }));
      const first = await calculator.ensure();
      const damaged = await append(inventory, "d", true);
      inventory = damaged.next;
      const second = await calculator.ensure();
      const repaired = await store.get<Uint8Array>("projections", damaged.id);
      const added = await append(inventory, "e", false);
      inventory = added.next;
      const third = await calculator.ensure();
      calculator.cancel();
      return {
        first,
        second,
        third,
        operations,
        repaired:
          Array.from(repaired!).join() ===
          Array.from(damaged.projected.row).join(),
      };
    } finally {
      globalThis.Worker = NativeWorker;
      (await store.database).close();
    }
  }, corePath);
  expect(result.first.state).toBe("ready");
  expect(result.second.state).toBe("ready");
  expect(result.third.state).toBe("ready");
  expect(result.repaired).toBe(true);
  expect(result.operations).toContain("advance");
  const thirdAdvance = result.operations.lastIndexOf("advance");
  const lastLoad = result.operations.lastIndexOf("load");
  expect(thirdAdvance).toBeGreaterThan(lastLoad);
});
