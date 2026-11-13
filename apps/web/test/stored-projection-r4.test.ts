import { expect, test } from "@playwright/test";
import { corePath } from "./helpers.ts";
import type { LocalStore as BrowserStore } from "../src/data/store.ts";
import type { SnapshotInventory } from "../src/data/records.ts";

test("the version 6 upgrade reports a blocked open when an older connection stays open and clears legacy record projections once unblocked", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const name = `legacy-upgrade-${crypto.randomUUID()}`;
    let olderVersionChanged = false;
    const legacyDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open(name, 5);
      opening.onupgradeneeded = () => {
        for (const store of [
          "records",
          "projections",
          "inventory",
          "meta",
          "drafts",
          "keys",
          "prefs",
          "outbox",
        ])
          opening.result.createObjectStore(store);
      };
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const database = opening.result;
        const transaction = database.transaction(
          [
            "records",
            "projections",
            "inventory",
            "meta",
            "drafts",
            "keys",
            "prefs",
            "outbox",
          ],
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
        transaction.objectStore("keys").put({ identity: "keep" }, "selected");
        transaction.objectStore("prefs").put({ theme: "dark" }, "preferences");
        transaction.objectStore("outbox").put({ id: "keep" }, "pending");
        transaction.oncomplete = () => resolve(database);
        transaction.onerror = () => reject(transaction.error);
      };
    });
    const { LocalStore } = await import(String("/src/data/store.ts"));
    // Case 1: older connection stays open without closing on versionchange.
    let stayedOpenVersionChanged = false;
    legacyDb.onversionchange = () => {
      stayedOpenVersionChanged = true;
    };
    let blockedError = "";
    const blockedStore = new LocalStore(name) as BrowserStore;
    try {
      await blockedStore.database;
    } catch (error) {
      blockedError = error instanceof Error ? error.message : String(error);
    }
    legacyDb.close();

    // Case 2: older v5 connection closes on versionchange, allowing version 6 upgrade.
    const upgradeName = `legacy-upgrade-unblocked-${crypto.randomUUID()}`;
    const legacyDb2 = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open(upgradeName, 5);
      opening.onupgradeneeded = () => {
        for (const store of [
          "records",
          "projections",
          "inventory",
          "meta",
          "drafts",
          "keys",
          "prefs",
          "outbox",
        ])
          opening.result.createObjectStore(store);
      };
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const database = opening.result;
        const transaction = database.transaction(
          [
            "records",
            "projections",
            "inventory",
            "meta",
            "drafts",
            "keys",
            "prefs",
            "outbox",
          ],
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
        transaction.objectStore("keys").put({ identity: "keep" }, "selected");
        transaction.objectStore("prefs").put({ theme: "dark" }, "preferences");
        transaction.objectStore("outbox").put({ id: "keep" }, "pending");
        transaction.oncomplete = () => resolve(database);
        transaction.onerror = () => reject(transaction.error);
      };
    });
    legacyDb2.onversionchange = () => {
      olderVersionChanged = true;
      legacyDb2.close();
    };
    const store = new LocalStore(upgradeName) as BrowserStore;
    try {
      const snapshot = {
        stayedOpenVersionChanged,
        blockedError,
        version: (await store.database).version,
        record: await store.get("records", "legacy"),
        row: await store.get("projections", "legacy"),
        latest: await store.get("inventory", "latest"),
        producer: await store.get("meta", "projection:latest"),
        draft: await store.get("drafts", "current"),
        key: await store.get("keys", "selected"),
        preferences: await store.get("prefs", "preferences"),
        outbox: await store.get("outbox", "pending"),
        olderVersionChanged,
        productClosedOnUpgrade: false,
      };
      // Verify the product's own onversionchange handler closes its connection when a higher version opens.
      const nextVersion = await new Promise<number>((resolve, reject) => {
        const opening = indexedDB.open(upgradeName, 7);
        opening.onerror = () => reject(opening.error);
        opening.onblocked = () =>
          reject(new Error("Product connection blocked upgrade."));
        opening.onsuccess = () => {
          const v = opening.result.version;
          opening.result.close();
          resolve(v);
        };
      });
      snapshot.productClosedOnUpgrade = nextVersion === 7;
      return snapshot;
    } finally {
      (await store.database).close();
    }
  });
  expect(result.stayedOpenVersionChanged).toBe(true);
  expect(result.blockedError).toBe(
    "Local storage is blocked by another open tab.",
  );
  expect(result.version).toBe(6);
  expect(result.record).toBeUndefined();
  expect(result.row).toBeUndefined();
  expect(result.latest).toBeUndefined();
  expect(result.producer).toBeUndefined();
  expect(result.draft).toEqual({ revision: "keep" });
  expect(result.key).toEqual({ identity: "keep" });
  expect(result.preferences).toEqual({ theme: "dark" });
  expect(result.outbox).toEqual({ id: "keep" });
  expect(result.olderVersionChanged).toBe(true);
  expect(result.productClosedOnUpgrade).toBe(true);
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
          record.bodyStatus === "present" &&
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
      const readRecords = store.readRecords.bind(store);
      let intervened = false;
      store.readRecords = async (ids: string[]) => {
        const cached = await readRecords(ids);
        if (!intervened && ids.includes(full.id)) {
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
        originalBodyStatus: full.bodyStatus,
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
  expect(result.originalBodyStatus).toBe("present");
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

test("commitInventory aborts when another tab pruned a record in the inventory and prunes older snapshots beyond the previous one", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { syncRecords } = await import(String("/src/data/records.ts"));
    await core.initializeCore();
    const name = `two-tab-commit-${crypto.randomUUID()}`;
    const tabA = new LocalStore(name) as BrowserStore;
    const tabB = new LocalStore(name) as BrowserStore;
    const makeSnapshot = async (
      base: SnapshotInventory,
      letter: string,
      selectionHash: string,
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
      const stored = {
        id: event.envelope.id,
        envelope: projected.envelope,
        body: null,
        bodyHash: null,
        bodyStatus: "none",
      };
      await tabA.putProjectedRecord(stored, projected.row);
      await tabA.put("selections", selectionHash, "[]");
      const events = [...base.events, event.envelope.id].sort();
      const envelopes = await Promise.all(
        events.map(async (id) => {
          const record = await tabA.get<{ envelope: string }>("records", id);
          return record!.envelope + "\n";
        }),
      );
      const next: SnapshotInventory = {
        ...base,
        snapshot: "sha256:" + letter.repeat(64),
        logical_inventory: "sha256:" + letter.repeat(64),
        events,
        events_digest: core.contentHash(core.utf8(envelopes.join(""))),
        selections: [selectionHash],
      };
      return { next, addedId: event.envelope.id };
    };
    try {
      const s0 = await syncRecords(tabA);
      const sel1 = "sha256:" + "1".repeat(64);
      const sel2 = "sha256:" + "2".repeat(64);
      const sel3 = "sha256:" + "3".repeat(64);
      const s1 = await makeSnapshot(s0, "a", sel1);
      await tabA.commitInventory(s1.next);
      const s2 = await makeSnapshot(s1.next, "b", sel2);
      await tabA.commitInventory(s2.next);
      const s3 = await makeSnapshot(s2.next, "c", sel3);
      await tabA.commitInventory(s3.next);

      const inventoryKeysAfterS3 = (await tabA.keys("inventory")).sort();
      const metaKeysAfterS3 = (await tabA.keys("meta")).sort();
      const selectionKeysAfterS3 = (await tabA.keys("selections")).sort();

      // Now stage S4 in tabA, but before tabA commits S4, tabB commits S3 which prunes S4's added record.
      const sel4 = "sha256:" + "4".repeat(64);
      const s4 = await makeSnapshot(s3.next, "d", sel4);
      await tabB.commitInventory(s3.next);
      const removedBeforeCommit = await tabA.get("records", s4.addedId);
      let commitError = "";
      try {
        await tabA.commitInventory(s4.next);
      } catch (error) {
        commitError = error instanceof Error ? error.message : String(error);
      }
      const latestAfterAbort = await tabA.get<SnapshotInventory>(
        "inventory",
        "latest",
      );
      return {
        inventoryKeysAfterS3,
        metaKeysAfterS3,
        selectionKeysAfterS3,
        s2Snapshot: s2.next.snapshot,
        s3Snapshot: s3.next.snapshot,
        sel2,
        sel3,
        removedBeforeCommit: removedBeforeCommit === undefined,
        commitError,
        latestSnapshotAfterAbort: latestAfterAbort?.snapshot ?? null,
      };
    } finally {
      (await tabA.database).close();
      (await tabB.database).close();
    }
  }, corePath);
  expect(result.inventoryKeysAfterS3).toEqual(
    ["latest", result.s2Snapshot, result.s3Snapshot].sort(),
  );
  expect(result.metaKeysAfterS3).toEqual(
    [
      "projection:latest",
      "projection:producer",
      `projection:${result.s2Snapshot}`,
      `projection:${result.s3Snapshot}`,
    ].sort(),
  );
  expect(result.selectionKeysAfterS3).toEqual([result.sel2, result.sel3].sort());
  expect(result.removedBeforeCommit).toBe(true);
  expect(result.commitError).toMatch(/no longer cached/);
  expect(result.latestSnapshotAfterAbort).toBe(result.s3Snapshot);
});
