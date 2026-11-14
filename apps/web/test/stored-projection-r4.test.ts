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

test("commitInventory aborts when another tab pruned a record in the inventory and prunes all older snapshot data", async ({
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
        s3Snapshot: s3.next.snapshot,
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
  expect(result.inventoryKeysAfterS3).toEqual(["latest"]);
  expect(result.metaKeysAfterS3).toEqual(
    [
      "projection:latest",
      "projection:producer",
      `projection:${result.s3Snapshot}`,
    ].sort(),
  );
  expect(result.selectionKeysAfterS3).toEqual([result.sel3]);
  expect(result.removedBeforeCommit).toBe(true);
  expect(result.commitError).toMatch(/no longer cached/);
  expect(result.latestSnapshotAfterAbort).toBe(result.s3Snapshot);
});

test("concurrent tab commits abort on pruned selections across all three orders", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { syncRecords } = await import(String("/src/data/records.ts"));
    await core.initializeCore();

    const makeEvent = (seedByte: number, nonceChar: string) => {
      const event = core.createEvent(
        new Uint8Array(32).fill(seedByte),
        [],
        nonceChar.repeat(32),
        { kind: "identity.merge" },
        null,
      );
      const projected = core.projectRecord(
        core.utf8(JSON.stringify(event.envelope)),
      );
      return {
        id: event.envelope.id,
        stored: {
          id: event.envelope.id,
          envelope: projected.envelope,
          body: null,
          bodyHash: null,
          bodyStatus: "none" as const,
        },
        row: projected.row,
      };
    };

    const eventsDigestFor = async (store: BrowserStore, ids: string[]) => {
      const envelopes = await Promise.all(
        ids.map(async (id) => {
          const rec = await store.get<{ envelope: string }>("records", id);
          return rec!.envelope + "\n";
        }),
      );
      return core.contentHash(core.utf8(envelopes.join("")));
    };

    // Order 1: S0 -> S1 committed, Tab A stages S2 selection,
    // Tab B commits older S0 (pruning S2's staged selection), Tab A commits S2 -> must abort.
    let order1Error = "";
    let order1LatestAfterAbort = "";
    {
      const name = `order1-selection-prune-${crypto.randomUUID()}`;
      const tabA = new LocalStore(name) as BrowserStore;
      const tabB = new LocalStore(name) as BrowserStore;
      try {
        const base = await syncRecords(tabA);
        const sel0 = "sha256:" + "0".repeat(64);
        const sel1 = "sha256:" + "1".repeat(64);
        const sel2 = "sha256:" + "2".repeat(64);
        await tabA.put("selections", sel0, "[]");
        const s0: SnapshotInventory = {
          ...base,
          snapshot: "sha256:" + "a".repeat(64),
          logical_inventory: "sha256:" + "a".repeat(64),
          selections: [sel0],
        };
        await tabA.commitInventory(s0);

        await tabA.put("selections", sel1, "[]");
        const s1: SnapshotInventory = {
          ...base,
          snapshot: "sha256:" + "b".repeat(64),
          logical_inventory: "sha256:" + "b".repeat(64),
          selections: [sel1],
        };
        await tabA.commitInventory(s1);

        // Tab A stages sel2 for S2, and re-stages sel0 so Tab B can commit S0
        await tabA.put("selections", sel0, "[]");
        await tabA.put("selections", sel2, "[]");
        const s2: SnapshotInventory = {
          ...base,
          snapshot: "sha256:" + "c".repeat(64),
          logical_inventory: "sha256:" + "c".repeat(64),
          selections: [sel2],
        };

        // Tab B commits S0 -> retains only sel0, prunes sel1 and sel2
        await tabB.commitInventory(s0);

        try {
          await tabA.commitInventory(s2);
        } catch (error) {
          order1Error = error instanceof Error ? error.message : String(error);
        }
        const latest = await tabA.get<SnapshotInventory>("inventory", "latest");
        order1LatestAfterAbort = latest?.snapshot ?? "";
      } finally {
        (await tabA.database).close();
        (await tabB.database).close();
      }
    }

    // Order 2: S0 -> S1 -> S2 with concurrent tab pruning S1's selection.
    let order2SelectionError = "";
    {
      const name = `order2-concurrent-commit-${crypto.randomUUID()}`;
      const tabA = new LocalStore(name) as BrowserStore;
      const tabB = new LocalStore(name) as BrowserStore;
      try {
        const base = await syncRecords(tabA);
        const sel0 = "sha256:" + "0".repeat(64);
        const sel1 = "sha256:" + "1".repeat(64);
        const sel2 = "sha256:" + "2".repeat(64);

        await tabA.put("selections", sel0, "[]");
        const s0: SnapshotInventory = {
          ...base,
          snapshot: "sha256:" + "0".repeat(64),
          logical_inventory: "sha256:" + "0".repeat(64),
          selections: [sel0],
        };
        await tabA.commitInventory(s0);

        // Tab A stages sel1 for S1
        await tabA.put("selections", sel1, "[]");
        const s1WithSel1: SnapshotInventory = {
          ...base,
          snapshot: "sha256:" + "1".repeat(64),
          logical_inventory: "sha256:" + "1".repeat(64),
          selections: [sel1],
        };

        // Tab B stages extra record and sel2 for S2, and commits S2 first
        const extra = makeEvent(91, "9");
        await tabB.putProjectedRecord(extra.stored, extra.row);
        await tabB.put("selections", sel2, "[]");
        const s2Events = [...base.events, extra.id].sort();
        const s2: SnapshotInventory = {
          ...base,
          snapshot: "sha256:" + "2".repeat(64),
          logical_inventory: "sha256:" + "2".repeat(64),
          events: s2Events,
          events_digest: await eventsDigestFor(tabB, s2Events),
          selections: [sel2],
        };
        await tabB.commitInventory(s2);

        // Tab A's commit of s1WithSel1 must abort because sel1 was pruned when S2 committed
        try {
          await tabA.commitInventory(s1WithSel1);
        } catch (error) {
          order2SelectionError =
            error instanceof Error ? error.message : String(error);
        }
      } finally {
        (await tabA.database).close();
        (await tabB.database).close();
      }
    }

    // Order 3: cachedSelections check in records.ts goes stale
    // while another tab advances through S1 and S2, pruning sel0 before Tab A commits S3.
    let order3Error = "";
    let order3SameSnapshotError = "";
    {
      const name = `order3-stale-cached-selections-${crypto.randomUUID()}`;
      const tabA = new LocalStore(name) as BrowserStore;
      const tabB = new LocalStore(name) as BrowserStore;
      try {
        const base = await syncRecords(tabA);
        const sel0 = "sha256:" + "0".repeat(64);
        const sel1 = "sha256:" + "1".repeat(64);
        const sel2 = "sha256:" + "2".repeat(64);

        await tabA.put("selections", sel0, "[]");
        const s0: SnapshotInventory = {
          ...base,
          snapshot: "sha256:" + "0".repeat(64),
          logical_inventory: "sha256:" + "0".repeat(64),
          selections: [sel0],
        };
        await tabA.commitInventory(s0);

        // Tab A checks store.keys("selections") while S0 is latest and sees sel0 cached
        const cachedSelectionsInTabA = new Set(await tabA.keys("selections"));
        if (!cachedSelectionsInTabA.has(sel0))
          throw new Error("Expected sel0 to be cached initially");

        // Tab B commits S1 (sel1) and then S2 (sel2), pruning sel0
        await tabB.put("selections", sel1, "[]");
        const s1: SnapshotInventory = {
          ...base,
          snapshot: "sha256:" + "1".repeat(64),
          logical_inventory: "sha256:" + "1".repeat(64),
          selections: [sel1],
        };
        await tabB.commitInventory(s1);

        await tabB.put("selections", sel2, "[]");
        const s2: SnapshotInventory = {
          ...base,
          snapshot: "sha256:" + "2".repeat(64),
          logical_inventory: "sha256:" + "2".repeat(64),
          selections: [sel2],
        };
        await tabB.commitInventory(s2);

        // Tab A now commits S3 referencing sel0 (which it skipped downloading because cachedSelectionsInTabA had sel0)
        const s3: SnapshotInventory = {
          ...base,
          snapshot: "sha256:" + "3".repeat(64),
          logical_inventory: "sha256:" + "3".repeat(64),
          selections: [sel0],
        };
        try {
          await tabA.commitInventory(s3);
        } catch (error) {
          order3Error = error instanceof Error ? error.message : String(error);
        }

        // Also check same-snapshot re-commit (previous.snapshot === inventory.snapshot) when selection is missing
        await tabB.delete("selections", sel2);
        try {
          await tabB.commitInventory(s2);
        } catch (error) {
          order3SameSnapshotError =
            error instanceof Error ? error.message : String(error);
        }
      } finally {
        (await tabA.database).close();
        (await tabB.database).close();
      }
    }

    return {
      order1Error,
      order1LatestAfterAbort,
      order2SelectionError,
      order3Error,
      order3SameSnapshotError,
    };
  }, corePath);

  expect(result.order1Error).toMatch(
    /import selection in the inventory is no longer cached/,
  );
  expect(result.order1LatestAfterAbort).toBe("sha256:" + "a".repeat(64));
  expect(result.order2SelectionError).toMatch(
    /import selection in the inventory is no longer cached/,
  );
  expect(result.order3Error).toMatch(
    /import selection in the inventory is no longer cached/,
  );
  expect(result.order3SameSnapshotError).toMatch(
    /import selection in the inventory is no longer cached/,
  );
});

test("after any commit, only the committed snapshot remains across seeded legacy layouts, damaged candidates, and mixed commit sequences", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { projectionRowBytes } = await import(
      String("/src/data/projection-meta.ts")
    );
    const { EvaluationWorker } = await import(
      String("/src/workers/evaluate.ts")
    );
    await core.initializeCore();

    const makeEvent = (seedByte: number, nonceChar: string) => {
      const event = core.createEvent(
        new Uint8Array(32).fill(seedByte),
        [],
        nonceChar.repeat(32),
        { kind: "identity.merge" },
        null,
      );
      const projected = core.projectRecord(
        core.utf8(JSON.stringify(event.envelope)),
      );
      return {
        id: event.envelope.id,
        stored: {
          id: event.envelope.id,
          envelope: projected.envelope,
          body: null,
          bodyHash: null,
          bodyStatus: "none" as const,
        },
        row: projected.row,
      };
    };

    const eventsDigestFor = async (store: BrowserStore, ids: string[]) => {
      const envelopes = await Promise.all(
        ids.map(async (id) => {
          const rec = await store.get<{ envelope: string }>("records", id);
          return rec!.envelope + "\n";
        }),
      );
      return core.contentHash(core.utf8(envelopes.join("")));
    };

    const actualRowsDigestAndCount = async (
      store: BrowserStore,
      ids: string[],
    ) => {
      const digest = core.createProjectionDigest();
      let count = 0;
      try {
        for (const id of ids) {
          const row = await store.get<Uint8Array>("projections", id);
          if (row !== undefined) {
            count++;
            digest.update(id, projectionRowBytes(row));
          }
        }
        return { count, rowsHash: digest.finish() };
      } catch (error) {
        digest.free();
        throw error;
      }
    };

    const pool = [
      makeEvent(11, "1"),
      makeEvent(22, "2"),
      makeEvent(33, "3"),
      makeEvent(44, "4"),
      makeEvent(55, "5"),
      makeEvent(66, "6"),
    ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const [ev1, ev2, ev3, ev4, ev5] = pool;

    // 1. Seeded version 6 layout from main (several old inventories by snapshot hash, metas, records, rows, selections).
    const v6Name = `seeded-v6-${crypto.randomUUID()}`;
    const v6Store = new LocalStore(v6Name) as BrowserStore;
    const v6Worker = new EvaluationWorker();
    let v6Check = {
      inventoryKeys: [] as string[],
      metaKeys: [] as string[],
      recordKeys: [] as string[],
      projectionKeys: [] as string[],
      selectionKeys: [] as string[],
      loadedEvents: -1,
      rebuilt: true,
    };
    try {
      await v6Store.put(
        "meta",
        "projection:producer",
        core.projectionBuildIdentity(),
      );
      for (const ev of [ev1, ev2, ev3, ev4]) {
        await v6Store.putProjectedRecord(ev.stored, ev.row);
      }
      const sel0 = "sha256:" + "0".repeat(64);
      const sel1 = "sha256:" + "1".repeat(64);
      const sel2 = "sha256:" + "2".repeat(64);
      const sel3 = "sha256:" + "3".repeat(64);
      for (const sel of [sel0, sel1, sel2, sel3]) {
        await v6Store.put("selections", sel, "[]");
      }
      const s0Events = [ev1.id, ev2.id];
      const s1Events = [ev1.id, ev3.id];
      const s2Events = [ev1.id, ev4.id];
      const s3Events = [ev1.id, ev2.id, ev3.id];
      const s0: SnapshotInventory = {
        snapshot: "sha256:" + "0".repeat(64),
        logical_inventory: "sha256:" + "0".repeat(64),
        events_digest: await eventsDigestFor(v6Store, s0Events),
        view: ev1.id,
        events: s0Events,
        bodies: [],
        selections: [sel0],
      };
      const s1: SnapshotInventory = {
        snapshot: "sha256:" + "a".repeat(64),
        logical_inventory: "sha256:" + "a".repeat(64),
        events_digest: await eventsDigestFor(v6Store, s1Events),
        view: ev1.id,
        events: s1Events,
        bodies: [],
        selections: [sel1],
      };
      const s2: SnapshotInventory = {
        snapshot: "sha256:" + "b".repeat(64),
        logical_inventory: "sha256:" + "b".repeat(64),
        events_digest: await eventsDigestFor(v6Store, s2Events),
        view: ev1.id,
        events: s2Events,
        bodies: [],
        selections: [sel2],
      };
      const s3: SnapshotInventory = {
        snapshot: "sha256:" + "c".repeat(64),
        logical_inventory: "sha256:" + "c".repeat(64),
        events_digest: await eventsDigestFor(v6Store, s3Events),
        view: ev1.id,
        events: s3Events,
        bodies: [],
        unretained_bodies: [],
        selections: [sel3],
      };
      for (const inv of [s0, s1, s2]) {
        const actual = await actualRowsDigestAndCount(v6Store, inv.events);
        await v6Store.put("inventory", inv.snapshot, inv);
        await v6Store.put("meta", `projection:${inv.snapshot}`, {
          version: core.PROJECTION_ROW_VERSION,
          build: core.projectionBuildIdentity(),
          events_digest: inv.events_digest,
          rows_hash: actual.rowsHash,
          count: actual.count,
        });
      }
      await v6Store.put("inventory", "latest", s2);
      await v6Store.put("meta", "projection:latest", s2.snapshot);

      await v6Store.commitInventory(s3);
      const loaded = await v6Worker.load({
        id: 1,
        type: "load",
        session: "v6-s3",
        source: {
          database: v6Name,
          snapshot: s3.snapshot,
          events_digest: s3.events_digest,
          count: s3.events.length,
        },
        options: { selected_view: ev1.id },
      });
      v6Check = {
        inventoryKeys: (await v6Store.keys("inventory")).map(String).sort(),
        metaKeys: (await v6Store.keys("meta")).map(String).sort(),
        recordKeys: (await v6Store.keys("records")).map(String).sort(),
        projectionKeys: (await v6Store.keys("projections")).map(String).sort(),
        selectionKeys: (await v6Store.keys("selections")).map(String).sort(),
        loadedEvents: loaded.events,
        rebuilt: Boolean(loaded.projection_rebuilt),
      };
    } finally {
      v6Worker.currentSession?.free();
      (await v6Store.database).close();
    }

    // 2. Seeded layout from earlier branch heads (b1d2979) with previous-snapshot entries,
    // malformed keys sorting before valid ones, and damaged previous snapshots missing records/rows/meta/selections.
    const branchName = `seeded-branch-${crypto.randomUUID()}`;
    const branchStore = new LocalStore(branchName) as BrowserStore;
    const branchWorker = new EvaluationWorker();
    let branchCheck = {
      inventoryKeys: [] as string[],
      metaKeys: [] as string[],
      recordKeys: [] as string[],
      projectionKeys: [] as string[],
      selectionKeys: [] as string[],
      loadedEvents: -1,
      rebuilt: true,
    };
    try {
      await branchStore.put(
        "meta",
        "projection:producer",
        core.projectionBuildIdentity(),
      );
      await branchStore.putProjectedRecord(ev1.stored, ev1.row);
      await branchStore.putProjectedRecord(ev2.stored, ev2.row);
      await branchStore.putProjectedRecord(ev3.stored, ev3.row);
      const sel1 = "sha256:" + "1".repeat(64);
      const sel2 = "sha256:" + "2".repeat(64);
      await branchStore.put("selections", sel2, "[]");

      // Delete ev2's projection row so S1's stored state is damaged
      await branchStore.put("records", ev2.id, ev2.stored);
      const db = await branchStore.database;
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("projections", "readwrite");
        tx.objectStore("projections").delete(ev2.id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      const s1Damaged: SnapshotInventory = {
        snapshot: "sha256:" + "a".repeat(64),
        logical_inventory: "sha256:" + "a".repeat(64),
        events_digest: await eventsDigestFor(branchStore, [ev1.id, ev2.id]),
        view: ev1.id,
        events: [ev1.id, ev2.id],
        bodies: [],
        selections: [sel1], // sel1 is not even cached
      };
      const s2Current: SnapshotInventory = {
        snapshot: "sha256:" + "b".repeat(64),
        logical_inventory: "sha256:" + "b".repeat(64),
        events_digest: await eventsDigestFor(branchStore, [ev1.id, ev3.id]),
        view: ev1.id,
        events: [ev1.id, ev3.id],
        bodies: [],
        unretained_bodies: [],
        selections: [sel2],
      };
      const actualS2 = await actualRowsDigestAndCount(
        branchStore,
        s2Current.events,
      );
      await branchStore.put("inventory", "0", { malformed: true });
      await branchStore.put(
        "inventory",
        "sha256:" + "0".repeat(64),
        {
          ...s1Damaged,
          snapshot: "sha256:" + "0".repeat(64),
          selections: [123 as unknown as string],
        },
      );
      await branchStore.put("inventory", s1Damaged.snapshot, s1Damaged);
      await branchStore.put("inventory", s2Current.snapshot, s2Current);
      await branchStore.put("inventory", "latest", s2Current);
      await branchStore.put("meta", `projection:${s1Damaged.snapshot}`, {
        version: core.PROJECTION_ROW_VERSION,
        build: core.projectionBuildIdentity(),
        events_digest: s1Damaged.events_digest,
        rows_hash: "sha256:" + "f".repeat(64),
        count: 2,
      });
      await branchStore.put("meta", `projection:${s2Current.snapshot}`, {
        version: core.PROJECTION_ROW_VERSION,
        build: core.projectionBuildIdentity(),
        events_digest: s2Current.events_digest,
        rows_hash: actualS2.rowsHash,
        count: actualS2.count,
      });
      await branchStore.put("meta", "projection:latest", s2Current.snapshot);

      // Re-committing s2Current (same snapshot ID as latest) must prune all older/damaged/malformed keys
      await branchStore.commitInventory(s2Current);
      const loaded = await branchWorker.load({
        id: 1,
        type: "load",
        session: "branch-s2",
        source: {
          database: branchName,
          snapshot: s2Current.snapshot,
          events_digest: s2Current.events_digest,
          count: s2Current.events.length,
        },
        options: { selected_view: ev1.id },
      });
      branchCheck = {
        inventoryKeys: (await branchStore.keys("inventory")).map(String).sort(),
        metaKeys: (await branchStore.keys("meta")).map(String).sort(),
        recordKeys: (await branchStore.keys("records")).map(String).sort(),
        projectionKeys: (await branchStore.keys("projections"))
          .map(String)
          .sort(),
        selectionKeys: (await branchStore.keys("selections"))
          .map(String)
          .sort(),
        loadedEvents: loaded.events,
        rebuilt: Boolean(loaded.projection_rebuilt),
      };
    } finally {
      branchWorker.currentSession?.free();
      (await branchStore.database).close();
    }

    // 3. Bounded-storage check over a mixed sequence of 8 commits (mixing new and repeated snapshot IDs).
    const dbName2 = `bounded-mixed-commits-${crypto.randomUUID()}`;
    const store2 = new LocalStore(dbName2) as BrowserStore;
    const worker2 = new EvaluationWorker();
    const stepChecks: {
      step: number;
      recordsMatch: boolean;
      projectionsMatch: boolean;
      selectionsMatch: boolean;
      inventoriesMatch: boolean;
      metaMatch: boolean;
      currentLoadableWithoutRebuild: boolean;
    }[] = [];
    try {
      await store2.put(
        "meta",
        "projection:producer",
        core.projectionBuildIdentity(),
      );
      const specs = [
        { tag: "a", events: [ev1, ev2], sel: "sha256:" + "a".repeat(64) },
        { tag: "a", events: [ev1, ev2], sel: "sha256:" + "a".repeat(64) },
        { tag: "b", events: [ev1, ev3], sel: "sha256:" + "b".repeat(64) },
        { tag: "b", events: [ev1, ev3], sel: "sha256:" + "b".repeat(64) },
        { tag: "c", events: [ev1, ev4], sel: "sha256:" + "c".repeat(64) },
        { tag: "b", events: [ev1, ev3], sel: "sha256:" + "b".repeat(64) },
        { tag: "b", events: [ev1, ev3], sel: "sha256:" + "b".repeat(64) },
        { tag: "d", events: [ev1, ev5], sel: "sha256:" + "d".repeat(64) },
      ];

      for (let i = 0; i < specs.length; i++) {
        const spec = specs[i];
        for (const ev of spec.events) {
          await store2.putProjectedRecord(ev.stored, ev.row);
        }
        await store2.put("selections", spec.sel, "[]");
        const eventIds = spec.events.map((e) => e.id).sort();
        const inv: SnapshotInventory = {
          snapshot: "sha256:" + spec.tag.repeat(64),
          logical_inventory: "sha256:" + spec.tag.repeat(64),
          events_digest: await eventsDigestFor(store2, eventIds),
          view: ev1.id,
          events: eventIds,
          bodies: [],
          unretained_bodies: [],
          selections: [spec.sel],
        };
        await store2.commitInventory(inv);

        const currentSnap = inv.snapshot;
        const expectedEvents = eventIds;
        const expectedSelections = [spec.sel];
        const expectedInventories = ["latest"];
        const expectedMeta = [
          "projection:latest",
          "projection:producer",
          `projection:${currentSnap}`,
        ].sort();

        const recordKeys = (await store2.keys("records")).map(String).sort();
        const projectionKeys = (await store2.keys("projections"))
          .map(String)
          .sort();
        const selectionKeys = (await store2.keys("selections"))
          .map(String)
          .sort();
        const inventoryKeys = (await store2.keys("inventory"))
          .map(String)
          .sort();
        const metaKeys = (await store2.keys("meta"))
          .map(String)
          .filter((k) => k.startsWith("projection:"))
          .sort();

        const latestInv = await store2.get<SnapshotInventory>(
          "inventory",
          "latest",
        );
        const snapMeta = await store2.get<{
          count: number;
          rows_hash: string | null;
        }>("meta", `projection:${currentSnap}`);
        const actual = await actualRowsDigestAndCount(store2, inv.events);
        let loadableOk =
          Boolean(latestInv) &&
          latestInv?.snapshot === currentSnap &&
          Boolean(snapMeta) &&
          snapMeta?.count === actual.count &&
          snapMeta?.rows_hash === actual.rowsHash;
        if (loadableOk) {
          const loaded = await worker2.load({
            id: i + 1,
            type: "load",
            session: `step-${i}-${currentSnap}`,
            source: {
              database: dbName2,
              snapshot: inv.snapshot,
              events_digest: inv.events_digest,
              count: inv.events.length,
            },
            options: { selected_view: ev1.id },
          });
          if (
            loaded.events !== inv.events.length ||
            Boolean(loaded.projection_rebuilt)
          ) {
            loadableOk = false;
          }
        }

        stepChecks.push({
          step: i + 1,
          recordsMatch:
            JSON.stringify(recordKeys) === JSON.stringify(expectedEvents),
          projectionsMatch:
            JSON.stringify(projectionKeys) === JSON.stringify(expectedEvents),
          selectionsMatch:
            JSON.stringify(selectionKeys) ===
            JSON.stringify(expectedSelections),
          inventoriesMatch:
            JSON.stringify(inventoryKeys) ===
            JSON.stringify(expectedInventories),
          metaMatch: JSON.stringify(metaKeys) === JSON.stringify(expectedMeta),
          currentLoadableWithoutRebuild: loadableOk,
        });
      }
    } finally {
      worker2.currentSession?.free();
      (await store2.database).close();
    }

    return {
      v6ExpectedEvents: [ev1.id, ev2.id, ev3.id],
      v6Check,
      branchExpectedEvents: [ev1.id, ev3.id],
      branchCheck,
      stepChecks,
    };
  }, corePath);

  expect(result.v6Check).toEqual({
    inventoryKeys: ["latest"],
    metaKeys: [
      "projection:latest",
      "projection:producer",
      `projection:${"sha256:" + "c".repeat(64)}`,
    ].sort(),
    recordKeys: result.v6ExpectedEvents,
    projectionKeys: result.v6ExpectedEvents,
    selectionKeys: ["sha256:" + "3".repeat(64)],
    loadedEvents: 3,
    rebuilt: false,
  });
  expect(result.branchCheck).toEqual({
    inventoryKeys: ["latest"],
    metaKeys: [
      "projection:latest",
      "projection:producer",
      `projection:${"sha256:" + "b".repeat(64)}`,
    ].sort(),
    recordKeys: result.branchExpectedEvents,
    projectionKeys: result.branchExpectedEvents,
    selectionKeys: ["sha256:" + "2".repeat(64)],
    loadedEvents: 2,
    rebuilt: false,
  });
  expect(result.stepChecks).toEqual(
    Array.from({ length: 8 }, (_, idx) => ({
      step: idx + 1,
      recordsMatch: true,
      projectionsMatch: true,
      selectionsMatch: true,
      inventoriesMatch: true,
      metaMatch: true,
      currentLoadableWithoutRebuild: true,
    })),
  );
});

test("two tabs: an older sync that finishes after a newer commit aborts with a retryable superseded error and PersonalCalculator uses the new latest", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { RecordsError, syncRecords } = await import(
      String("/src/data/records.ts")
    );
    const { PersonalCalculator } = await import(
      String("/src/data/personal.ts")
    );
    await core.initializeCore();

    const dbName = `cas-sync-${crypto.randomUUID()}`;
    const tabA = new LocalStore(dbName) as BrowserStore;
    const tabB = new LocalStore(dbName) as BrowserStore;
    try {
      const base = await syncRecords(tabA);
      const extra = core.createEvent(
        new Uint8Array(32).fill(77),
        [],
        "7".repeat(32),
        { kind: "identity.merge" },
        null,
      );
      const projected = core.projectRecord(
        core.utf8(JSON.stringify(extra.envelope)),
      );
      const extraStored = {
        id: extra.envelope.id,
        envelope: projected.envelope,
        body: null,
        bodyHash: null,
        bodyStatus: "none" as const,
      };
      const s2Events = [...base.events, extra.envelope.id].sort();
      await tabA.putProjectedRecord(extraStored, projected.row);
      const envelopes = await Promise.all(
        s2Events.map(async (id) => {
          const rec = await tabA.get<{ envelope: string }>("records", id);
          return rec!.envelope + "\n";
        }),
      );
      const s2: SnapshotInventory = {
        ...base,
        snapshot: "sha256:" + "e".repeat(64),
        logical_inventory: "sha256:" + "e".repeat(64),
        events: s2Events,
        events_digest: core.contentHash(core.utf8(envelopes.join(""))),
      };

      // Case 1: direct syncRecords(tabB) starts when latest is base,
      // and tabA commits newer s2 before tabB commits.
      const originalCommit = tabB.commitInventory.bind(tabB);
      let intervened = false;
      tabB.commitInventory = async (
        inv: SnapshotInventory,
        expectedLatest?: string | null,
      ) => {
        if (!intervened) {
          intervened = true;
          await tabA.putProjectedRecord(extraStored, projected.row);
          await tabA.commitInventory(s2, base.snapshot);
        }
        return originalCommit(inv, expectedLatest);
      };

      let directKind = "";
      let directRetryable = false;
      let directIsRecordsError = false;
      try {
        await syncRecords(tabB);
      } catch (error) {
        directIsRecordsError = error instanceof RecordsError;
        if (error instanceof RecordsError) {
          const recErr = error as { kind: string; retryable: boolean };
          directKind = recErr.kind;
          directRetryable = recErr.retryable;
        }
      }
      const latestAfterDirectAbort = await tabA.get<SnapshotInventory>(
        "inventory",
        "latest",
      );

      // Case 2: PersonalCalculator.ensure({ refresh: true }) in tabB starts when latest is base,
      // tabA commits s2 while tabB syncs, tabB's sync aborts with superseded, and PersonalCalculator
      // uses the new latest (s2) without resyncing the older snapshot.
      await tabA.commitInventory(base);
      let syncCalls = 0;
      intervened = false;
      tabB.commitInventory = async (
        inv: SnapshotInventory,
        expectedLatest?: string | null,
      ) => {
        syncCalls++;
        if (!intervened) {
          intervened = true;
          await tabA.putProjectedRecord(extraStored, projected.row);
          await tabA.commitInventory(s2, base.snapshot);
        }
        return originalCommit(inv, expectedLatest);
      };

      const calcB = new PersonalCalculator(tabB, async () => ({
        identity: null,
      }));
      const status = await calcB.ensure({ mode: "personal", refresh: true });
      const latestAfterCalc = await tabA.get<SnapshotInventory>(
        "inventory",
        "latest",
      );
      calcB.cancel();

      return {
        directIsRecordsError,
        directKind,
        directRetryable,
        latestAfterDirectAbort: latestAfterDirectAbort?.snapshot ?? null,
        s2Snapshot: s2.snapshot,
        s2Count: s2.events.length,
        syncCalls,
        calcStatus: status,
        latestAfterCalc: latestAfterCalc?.snapshot ?? null,
      };
    } finally {
      (await tabA.database).close();
      (await tabB.database).close();
    }
  }, corePath);

  expect(result.directIsRecordsError).toBe(true);
  expect(result.directKind).toBe("superseded");
  expect(result.directRetryable).toBe(true);
  expect(result.latestAfterDirectAbort).toBe(result.s2Snapshot);
  expect(result.syncCalls).toBe(1);
  expect(result.calcStatus.state).toBe("ready");
  if (result.calcStatus.state === "ready") {
    expect(result.calcStatus.snapshot).toBe(result.s2Snapshot);
    expect(result.calcStatus.events).toBe(result.s2Count);
  }
  expect(result.latestAfterCalc).toBe(result.s2Snapshot);
});

test("two tabs: a load or advance in tab B that races a commit in tab A recovers through one retry and matches a fresh load", async ({
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

    const dbName = `race-load-retry-${crypto.randomUUID()}`;
    const tabA = new LocalStore(dbName) as BrowserStore;
    const tabB = new LocalStore(dbName) as BrowserStore;
    const NativeWorker = globalThis.Worker;

    const makeSnapshotWithExtra = async (
      base: SnapshotInventory,
      seedByte: number,
      tag: string,
      selTag: string,
    ) => {
      const event = core.createEvent(
        new Uint8Array(32).fill(seedByte),
        [],
        tag.repeat(32),
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
        bodyStatus: "none" as const,
      };
      const selHash = "sha256:" + selTag.repeat(64);
      await tabA.putProjectedRecord(stored, projected.row);
      await tabA.put("selections", selHash, "[]");
      const events = [...base.events, event.envelope.id].sort();
      const envelopes = await Promise.all(
        events.map(async (id) => {
          const rec = await tabA.get<{ envelope: string }>("records", id);
          return rec!.envelope + "\n";
        }),
      );
      const inv: SnapshotInventory = {
        ...base,
        snapshot: "sha256:" + tag.repeat(64),
        logical_inventory: "sha256:" + tag.repeat(64),
        events,
        events_digest: core.contentHash(core.utf8(envelopes.join(""))),
        unretained_bodies: base.unretained_bodies ?? [],
        selections: [...base.selections, selHash].sort(),
      };
      return { inv, stored, row: projected.row, selHash };
    };

    try {
      const s0 = await syncRecords(tabA);
      const s1Spec = await makeSnapshotWithExtra(s0, 101, "a", "1");
      const s2Spec = await makeSnapshotWithExtra(s0, 102, "b", "2");
      const s3Spec = await makeSnapshotWithExtra(s0, 103, "c", "3");

      // Subcase 1: Full load in Tab B starts on S1, Tab A commits S2 (pruning S1's record & selection)
      // right before Tab B's worker load executes. Tab B retries once with S2 and matches a fresh load of S2.
      await tabA.putProjectedRecord(s1Spec.stored, s1Spec.row);
      await tabA.put("selections", s1Spec.selHash, "[]");
      await tabA.commitInventory(s1Spec.inv);

      const loadSnapshotsSeen: string[] = [];
      let interceptFullLoadRace = true;
      globalThis.Worker = class extends NativeWorker {
        postMessage(message: any, options?: any) {
          if (message.type === "load") {
            loadSnapshotsSeen.push(message.source.snapshot);
            if (interceptFullLoadRace) {
              interceptFullLoadRace = false;
              void (async () => {
                await tabA.putProjectedRecord(s2Spec.stored, s2Spec.row);
                await tabA.put("selections", s2Spec.selHash, "[]");
                await tabA.commitInventory(s2Spec.inv);
                super.postMessage(message, options);
              })();
              return;
            }
          }
          super.postMessage(message, options);
        }
      };

      const calcB = new PersonalCalculator(tabB, async () => ({
        identity: null,
      }));
      const recoveredLoadStatus = await calcB.ensure({ mode: "personal" });

      const freshCalc = new PersonalCalculator(tabB, async () => ({
        identity: null,
      }));
      const freshLoadStatus = await freshCalc.ensure({ mode: "personal" });
      const recoveredInternal = {
        loadedKey: (calcB as any).loadedKey,
        sent: (calcB as any).sent,
        projectionDigest: (calcB as any).projectionDigest,
        continuity: calcB.loadedContinuity,
      };
      const freshInternal = {
        loadedKey: (freshCalc as any).loadedKey,
        sent: (freshCalc as any).sent,
        projectionDigest: (freshCalc as any).projectionDigest,
        continuity: freshCalc.loadedContinuity,
      };
      calcB.cancel();
      freshCalc.cancel();

      // Subcase 2: Incremental advance in Tab B from S0 to S1 races Tab A committing S2.
      let interceptAdvanceRace = false;
      const advanceMessagesSeen: string[] = [];
      globalThis.Worker = class extends NativeWorker {
        postMessage(message: any, options?: any) {
          if (message.type === "load" || message.type === "advance") {
            advanceMessagesSeen.push(
              `${message.type}:${message.source?.snapshot ?? ""}`,
            );
          }
          if (message.type === "advance" && interceptAdvanceRace) {
            interceptAdvanceRace = false;
            void (async () => {
              await tabA.putProjectedRecord(s2Spec.stored, s2Spec.row);
              await tabA.put("selections", s2Spec.selHash, "[]");
              await tabA.commitInventory(s2Spec.inv);
              super.postMessage(message, options);
            })();
            return;
          }
          super.postMessage(message, options);
        }
      };

      await tabA.commitInventory(s0);
      const calcAdvance = new PersonalCalculator(tabB, async () => ({
        identity: null,
      }));
      await calcAdvance.ensure({ mode: "personal" });
      await tabA.putProjectedRecord(s1Spec.stored, s1Spec.row);
      const s1Append: SnapshotInventory = {
        ...s1Spec.inv,
        selections: s0.selections,
      };
      await tabA.commitInventory(s1Append);
      interceptAdvanceRace = true;

      const recoveredAdvanceStatus = await calcAdvance.ensure({
        mode: "personal",
      });
      calcAdvance.cancel();

      // Subcase 3: Both initial load (S1) and retry load (S2) lose the race to newer commits (S2, then S3).
      // Calculator stops after one retry, reports the missing-record failure, and leaves no stale state.
      await tabA.putProjectedRecord(s1Spec.stored, s1Spec.row);
      await tabA.put("selections", s1Spec.selHash, "[]");
      await tabA.commitInventory(s1Spec.inv);

      let doubleRaceCount = 0;
      globalThis.Worker = class extends NativeWorker {
        postMessage(message: any, options?: any) {
          if (message.type === "load" && doubleRaceCount < 2) {
            doubleRaceCount++;
            void (async () => {
              const target = doubleRaceCount === 1 ? s2Spec : s3Spec;
              await tabA.putProjectedRecord(target.stored, target.row);
              await tabA.put("selections", target.selHash, "[]");
              await tabA.commitInventory(target.inv);
              super.postMessage(message, options);
            })();
            return;
          }
          super.postMessage(message, options);
        }
      };

      const calcDoubleRace = new PersonalCalculator(tabB, async () => ({
        identity: null,
      }));
      const doubleRaceStatus = await calcDoubleRace.ensure({
        mode: "personal",
      });
      const doubleRaceInternal = {
        loadedKey: (calcDoubleRace as any).loadedKey,
        sent: (calcDoubleRace as any).sent,
        projectionDigest: (calcDoubleRace as any).projectionDigest,
      };
      calcDoubleRace.cancel();

      // Subcase 4: S1 has a missing projection row (so load(S1) falls back to rebuildStoredProjection(S1)),
      // and Tab A commits S2 right before Tab B's worker load executes. rebuildStoredProjection(S1) aborts
      // without clearing S2's rows, and PersonalCalculator retries once with S2 and succeeds.
      await tabA.putProjectedRecord(s1Spec.stored, s1Spec.row);
      await tabA.put("selections", s1Spec.selHash, "[]");
      await tabA.commitInventory(s1Spec.inv);
      await tabA.delete("projections", s1Spec.stored.id);

      let interceptRebuildRace = true;
      const rebuildSnapshotsSeen: string[] = [];
      globalThis.Worker = class extends NativeWorker {
        postMessage(message: any, options?: any) {
          if (message.type === "load") {
            rebuildSnapshotsSeen.push(message.source.snapshot);
            if (interceptRebuildRace) {
              interceptRebuildRace = false;
              void (async () => {
                await tabA.putProjectedRecord(s2Spec.stored, s2Spec.row);
                await tabA.put("selections", s2Spec.selHash, "[]");
                await tabA.commitInventory(s2Spec.inv);
                super.postMessage(message, options);
              })();
              return;
            }
          }
          super.postMessage(message, options);
        }
      };

      const calcRebuildRace = new PersonalCalculator(tabB, async () => ({
        identity: null,
      }));
      const rebuildRaceStatus = await calcRebuildRace.ensure({
        mode: "personal",
      });
      const s2RowStillPresent = Boolean(
        await tabA.get("projections", s2Spec.stored.id),
      );
      calcRebuildRace.cancel();

      return {
        s1Snapshot: s1Spec.inv.snapshot,
        s2Snapshot: s2Spec.inv.snapshot,
        loadSnapshotsSeen,
        recoveredLoadStatus,
        freshLoadStatus,
        recoveredInternal,
        freshInternal,
        advanceMessagesSeen,
        recoveredAdvanceStatus,
        doubleRaceCount,
        doubleRaceStatus,
        doubleRaceInternal,
        rebuildSnapshotsSeen,
        rebuildRaceStatus,
        s2RowStillPresent,
      };
    } finally {
      globalThis.Worker = NativeWorker;
      (await tabA.database).close();
      (await tabB.database).close();
    }
  }, corePath);

  expect(result.loadSnapshotsSeen.slice(0, 2)).toEqual([
    result.s1Snapshot,
    result.s2Snapshot,
  ]);
  expect(result.recoveredLoadStatus).toEqual(result.freshLoadStatus);
  expect(result.recoveredLoadStatus.state).toBe("ready");
  expect(result.recoveredInternal).toEqual(result.freshInternal);

  expect(result.advanceMessagesSeen).toContain(`advance:${result.s1Snapshot}`);
  expect(result.advanceMessagesSeen).toContain(`load:${result.s2Snapshot}`);
  expect(result.recoveredAdvanceStatus).toEqual(result.freshLoadStatus);

  expect(result.doubleRaceCount).toBe(2);
  expect(result.doubleRaceStatus.state).toBe("failed");
  if (result.doubleRaceStatus.state === "failed") {
    expect(result.doubleRaceStatus.kind).toBe("missing");
    expect(result.doubleRaceStatus.message).toMatch(
      /Download the records again\./,
    );
  }
  expect(result.doubleRaceInternal).toEqual({
    loadedKey: null,
    sent: null,
    projectionDigest: null,
  });

  expect(result.rebuildSnapshotsSeen.slice(0, 2)).toEqual([
    result.s1Snapshot,
    result.s2Snapshot,
  ]);
  expect(result.rebuildRaceStatus).toEqual(result.freshLoadStatus);
  expect(result.s2RowStillPresent).toBe(true);
});

test("a late body write followed by a load gives a consistent meta and rows with no rebuild that clears rows", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { projectionRowBytes } = await import(
      String("/src/data/projection-meta.ts")
    );
    const { syncRecords } = await import(String("/src/data/records.ts"));
    const { EvaluationWorker } = await import(
      String("/src/workers/evaluate.ts")
    );
    const { PersonalCalculator } = await import(
      String("/src/data/personal.ts")
    );
    await core.initializeCore();

    const dbName = `late-body-write-${crypto.randomUUID()}`;
    const store = new LocalStore(dbName) as BrowserStore;
    const worker = new EvaluationWorker();
    try {
      const base = (await syncRecords(store)) as SnapshotInventory;
      type TargetRec = {
        id: string;
        envelope: string;
        body: string | null;
        bodyHash: string | null;
        bodyStatus: string;
      };
      let target: TargetRec | null = null;
      for (const id of base.events) {
        const rec = await store.get<TargetRec>("records", id);
        if (
          rec?.body &&
          rec.bodyHash &&
          rec.bodyStatus === "present" &&
          JSON.parse(rec.envelope).header.action.kind === "definition.publish"
        ) {
          target = rec;
          break;
        }
      }
      if (!target || !target.body || !target.bodyHash)
        throw new Error("Expected a definition record with a retained body");

      const fullRow = await store.get<Uint8Array>("projections", target.id);
      const bodylessProjected = core.projectRecord(core.utf8(target.envelope));
      const bodylessRecord = {
        ...target,
        body: null,
        bodyStatus: "missing",
      };

      // First commit S1 where target's body is unretained and missing in storage
      await store.put("records", target.id, bodylessRecord);
      await store.put("projections", target.id, bodylessProjected.row);
      await store.delete("meta", `projection:${base.snapshot}`);
      const s1: SnapshotInventory = {
        ...base,
        snapshot: "sha256:" + "1".repeat(64),
        logical_inventory: "sha256:" + "1".repeat(64),
        bodies: base.bodies.filter((h: string) => h !== target!.bodyHash),
        unretained_bodies: [
          ...new Set([...(base.unretained_bodies ?? []), target.bodyHash]),
        ].sort(),
      };
      await store.commitInventory(s1);

      // Next commit S2 where target's body is retained, then perform the late body write via putProjectedRecord
      const s2: SnapshotInventory = {
        ...base,
        snapshot: "sha256:" + "2".repeat(64),
        logical_inventory: "sha256:" + "2".repeat(64),
      };
      await store.commitInventory(s2);
      await store.putProjectedRecord(target, fullRow!, s1);

      const metaS2 = await store.get<{
        count: number;
        rows_hash: string | null;
      }>("meta", `projection:${s2.snapshot}`);
      const digest = core.createProjectionDigest();
      let actualCount = 0;
      for (const id of s2.events) {
        const row = await store.get<Uint8Array>("projections", id);
        if (row) {
          actualCount++;
          digest.update(id, projectionRowBytes(row));
        }
      }
      const actualHash = digest.finish();

      const loaded = await worker.load({
        id: 1,
        type: "load",
        session: "s2-after-late-body",
        source: {
          database: dbName,
          snapshot: s2.snapshot,
          events_digest: s2.events_digest,
          count: s2.events.length,
        },
        options: { selected_view: s2.view },
      });

      const calc = new PersonalCalculator(store, async () => ({
        identity: null,
      }));
      const calcStatus = await calc.ensure({ mode: "personal" });
      calc.cancel();

      return {
        metaCount: metaS2?.count ?? -1,
        actualCount,
        metaRowsHash: metaS2?.rows_hash ?? null,
        actualHash,
        rebuilt: Boolean(loaded.projection_rebuilt),
        loadedEvents: loaded.events,
        expectedEvents: s2.events.length,
        calcState: calcStatus.state,
      };
    } finally {
      worker.currentSession?.free();
      (await store.database).close();
    }
  }, corePath);

  expect(result.metaCount).toBe(result.expectedEvents);
  expect(result.actualCount).toBe(result.expectedEvents);
  expect(result.metaRowsHash).toBe(result.actualHash);
  expect(result.rebuilt).toBe(false);
  expect(result.loadedEvents).toBe(result.expectedEvents);
  expect(result.calcState).toBe("ready");
});
