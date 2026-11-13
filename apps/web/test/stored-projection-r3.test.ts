import { expect, test } from "@playwright/test";
import { corePath } from "./helpers.ts";
import type { LocalStore as BrowserStore } from "../src/data/store.ts";
import type { SnapshotInventory } from "../src/data/records.ts";

test("a damaged added row recovers before the calculation changes", async ({
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
      `advance-damage-${crypto.randomUUID()}`,
    ) as BrowserStore;
    try {
      const inventory = await syncRecords(store);
      const calculator = new PersonalCalculator(store, async () => ({
        identity: null,
      }));
      const first = await calculator.ensure();
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
        envelope: projected.envelope,
        body: null,
        bodyHash: null,
        bodyStatus: "none",
      };
      await store.putProjectedRecord(stored, projected.row);
      const events = [...inventory.events, added.envelope.id].sort();
      const envelopes = await Promise.all(
        events.map(async (id) => {
          const record = await store.get<{ envelope: string }>("records", id);
          return record!.envelope + "\n";
        }),
      );
      const advanced = {
        ...inventory,
        snapshot: "sha256:" + "d".repeat(64),
        logical_inventory: "sha256:" + "d".repeat(64),
        events,
        events_digest: core.contentHash(core.utf8(envelopes.join(""))),
      };
      await store.commitInventory(advanced);
      const damaged = new Uint8Array(projected.row);
      damaged[33] ^= 1;
      await store.put("projections", added.envelope.id, damaged);
      const second = await calculator.ensure();
      const actors = calculator.loadedContinuity?.actors;
      const fresh = new PersonalCalculator(store, async () => ({
        identity: null,
      }));
      const full = await fresh.ensure();
      const fullActors = fresh.loadedContinuity?.actors;
      const repaired = await store.get<Uint8Array>(
        "projections",
        added.envelope.id,
      );
      calculator.cancel();
      fresh.cancel();
      return {
        first,
        second,
        full,
        actors,
        fullActors,
        repaired:
          Array.from(repaired!).join() === Array.from(projected.row).join(),
      };
    } finally {
      (await store.database).close();
    }
  }, corePath);
  expect(result.first.state).toBe("ready");
  expect(result.second.state).toBe("ready");
  expect(result.full.state).toBe("ready");
  expect(result.repaired).toBe(true);
  expect(result.actors).toEqual(result.fullActors);
});

test("delayed bodyless writes preserve cached bodies and retained rows stay complete", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { updateProjectionHash } = await import(
      String("/src/data/projection-meta.ts")
    );
    const { syncRecords, loadRecords } = await import(
      String("/src/data/records.ts")
    );
    const { PersonalCalculator } = await import(
      String("/src/data/personal.ts")
    );
    await core.initializeCore();
    const store = new LocalStore(
      `retained-missing-${crypto.randomUUID()}`,
    ) as BrowserStore;
    let target: {
      id: string;
      envelope: string;
      body: string | null;
      bodyHash: string | null;
      bodyStatus: string;
    } | null = null;
    const commit = store.commitInventory.bind(store);
    store.commitInventory = async (inventory: SnapshotInventory) => {
      for (const id of inventory.events) {
        const record = await store.get<typeof target>("records", id);
        if (
          record?.body &&
          record.bodyStatus === "present" &&
          JSON.parse(record.envelope).header.action.kind ===
            "definition.publish"
        ) {
          target = record;
          break;
        }
      }
      const projected = core.projectRecord(core.utf8(target!.envelope));
      const delayed = { ...target!, body: null, bodyStatus: "missing" };
      await store.putProjectedRecord(delayed, projected.row, null);
      await commit(inventory);
    };
    try {
      const inventory = await syncRecords(store);
      const validRow = await store.get<Uint8Array>("projections", target!.id);
      const calculator = new PersonalCalculator(store, async () => ({
        identity: null,
      }));
      const preserved = await calculator.ensure();
      calculator.cancel();
      const missing = core.projectRecord(core.utf8(target!.envelope));
      await store.put("records", target!.id, {
        ...target!,
        body: null,
        bodyStatus: "missing",
      });
      await store.put("projections", target!.id, missing.row);
      const key = `projection:${inventory.snapshot}`;
      const meta = await store.get<Record<string, unknown>>("meta", key);
      await store.put("meta", key, {
        ...meta,
        rows_hash: updateProjectionHash(
          String(meta!.rows_hash),
          target!.id,
          validRow!,
          missing.row,
        ),
      });
      let originalError: string | null = null;
      try {
        await loadRecords(store, inventory);
      } catch (error) {
        originalError = String(error);
      }
      const fresh = new PersonalCalculator(store, async () => ({
        identity: null,
      }));
      const rejected = await fresh.ensure();
      fresh.cancel();
      return { preserved, originalError, rejected };
    } finally {
      (await store.database).close();
    }
  }, corePath);
  expect(result.preserved.state).toBe("ready");
  expect(result.originalError).toContain("retained by the snapshot");
  expect(result.originalError).toContain("not cached");
  expect(result.rejected.state).toBe("failed");
  if (result.rejected.state === "failed") {
    expect(result.rejected.message).toContain("retained by the snapshot");
    expect(result.rejected.message).toContain("not cached");
  }
});

test("a write with a stale inventory refreshes its snapshot binding", async ({
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
      `latest-snapshot-${crypto.randomUUID()}`,
    ) as BrowserStore;
    const worker = new Worker(
      new URL("/src/workers/evaluate.ts", location.href),
      { type: "module" },
    );
    try {
      const inventory = await syncRecords(store);
      const added = core.createEvent(
        new Uint8Array(32).fill(112),
        [],
        "8".repeat(32),
        { kind: "identity.profile" },
        { name: "Late body", bio: [], links: [] },
      );
      const missing = core.projectRecord(
        core.utf8(JSON.stringify(added.envelope)),
      );
      const bodyHash = added.envelope.header.content!.hash;
      const missingRecord = {
        id: added.envelope.id,
        envelope: JSON.stringify(added.envelope),
        body: null,
        bodyStatus: "missing",
        bodyHash,
      };
      await store.putProjectedRecord(missingRecord, missing.row);
      const advanced = {
        ...inventory,
        snapshot: "sha256:" + "e".repeat(64),
        logical_inventory: "sha256:" + "e".repeat(64),
        events: [...inventory.events, added.envelope.id].sort(),
        bodies: [...inventory.bodies, bodyHash].sort(),
        unretained_bodies: (inventory.unretained_bodies ?? []).filter(
          (hash: string) => hash !== bodyHash,
        ),
      };
      await store.commitInventory(advanced);
      const body = core.canonicalize(core.utf8(JSON.stringify(added.body)));
      const valid = core.projectRecord(
        core.utf8(JSON.stringify(added.envelope)),
        core.utf8(body),
      );
      const validRecord = {
        id: added.envelope.id,
        envelope: JSON.stringify(added.envelope),
        body,
        bodyStatus: "present",
        bodyHash,
      };
      await store.putProjectedRecord(validRecord, valid.row, inventory);
      const selections = await loadSelections(store, advanced);
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
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
      });
    } finally {
      worker.terminate();
      (await store.database).close();
    }
  }, corePath);
  expect(result.type).toBe("loaded");
  expect(result.projection_rebuilt).toBe(false);
});
