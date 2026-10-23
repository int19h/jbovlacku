import { test, expect } from "@playwright/test";
import type { OutboxItem, PeerDelivery } from "../src/data/store.ts";

/** Saves synthetic own records without sending them to a peer. */
async function seed(page: import("@playwright/test").Page) {
  await page.goto("/outbox");
  await expect(page.locator("main h1")).toHaveText("Not delivered");
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { freshPeer } = await import(String("/src/data/delivery.ts"));
    const store = new LocalStore();
    const make = (id: string, previous: string[], stopped = true) => ({
      id,
      identity: "test",
      group: id,
      order: 0,
      stopped,
      signedAt: 1,
      transport: JSON.stringify({
        envelope: { id, header: { issuer: "test", previous } },
        body: { text: id },
      }),
      label: { subject: id, action: "test record", href: "/" },
      peers: {
        self: {
          ...freshPeer(),
          state: "refused",
          failure: "refused",
          nextAttempt: null,
        },
        mirror: { ...freshPeer(), state: "accepted", nextAttempt: null },
      },
    });
    await store.queueGroup([
      make("base", [], false),
      make("middle", ["base"]),
      make("leaf", ["middle"]),
    ]);
    (window as any).makeOutbox = make;
  });
  await page.reload();
}

test("stopped rows stay counted and only a leaf offers confirmed discard", async ({
  page,
}) => {
  await seed(page);
  await expect(
    page.getByRole("link", { name: "3 not delivered" }),
  ).toBeVisible();
  const middle = page.locator('[data-outbox-record="middle"]');
  const leaf = page.locator('[data-outbox-record="leaf"]');
  await expect(middle.getByText("Stopped", { exact: true })).toBeVisible();
  await expect(middle).toContainText("Later records depend on this record.");
  await expect(middle.getByRole("button", { name: "Discard" })).toHaveCount(0);
  await expect(
    middle.getByRole("button", { name: "Resume", exact: true }),
  ).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await middle
    .getByRole("button", { name: "Save as file", exact: true })
    .click();
  const download = await downloadPromise;
  const bytes = await (await download.createReadStream())
    .toArray()
    .then((chunks) => Buffer.concat(chunks as Buffer[]).toString());
  expect(JSON.parse(bytes).envelope.id).toBe("middle");
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain(
      "This does not retract a copy that a server already holds.",
    );
    void dialog.dismiss();
  });
  await leaf.getByRole("button", { name: "Discard" }).click();
  await expect(leaf).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await leaf.getByRole("button", { name: "Discard" }).click();
  await expect(leaf).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "2 not delivered" }),
  ).toBeVisible();
  const result = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    await store.mergeOutbox("leaf", () => {
      throw new Error("A late receipt recreated a discarded row.");
    });
    return {
      heads: await store.get("heads", "test"),
      leaf: await store.get("outbox", "leaf"),
    };
  });
  expect(result).toEqual({ heads: ["middle"], leaf: undefined });
  await expect(middle.getByRole("button", { name: "Discard" })).toBeVisible();
});

test("discard rechecks a stale row after another tab saves a dependent record", async ({
  page,
}) => {
  await seed(page);
  const leaf = page.locator('[data-outbox-record="leaf"]');
  await expect(leaf.getByRole("button", { name: "Discard" })).toBeVisible();
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const leaf = await store.get("outbox", "leaf");
    const later = {
      ...leaf,
      id: "later",
      group: "later",
      transport: JSON.stringify({
        envelope: {
          id: "later",
          header: { issuer: "test", previous: ["leaf"] },
        },
        body: null,
      }),
    };
    await store.queueGroup([later]);
  });
  page.once("dialog", (dialog) => void dialog.accept());
  await leaf.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Later records depend on this record.",
  );
  await expect(leaf).toBeVisible();
  await expect(leaf.getByRole("button", { name: "Discard" })).toHaveCount(0);
});

test("discard guards cached own branches and rejects a pre-signed group after deletion", async ({
  page,
}) => {
  await seed(page);
  const result = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const leaf = await store.get("outbox", "leaf");
    const own = {
      id: "cached",
      header: { issuer: "test", previous: ["leaf"] },
    };
    await store.put("ownhistory", "cached", own);
    const blocked = await store.discardOutbox("middle").then(
      () => false,
      () => true,
    );
    const cachedBlocked = await store.discardOutbox("leaf").then(
      () => false,
      () => true,
    );
    await store.delete("ownhistory", "cached");
    await store.discardOutbox("leaf");
    const stale = {
      ...leaf,
      id: "later",
      transport: JSON.stringify({
        envelope: {
          id: "later",
          header: { issuer: "test", previous: ["leaf"] },
        },
        body: null,
      }),
    };
    const staleBlocked = await store.queueGroup([stale]).then(
      () => false,
      () => true,
    );
    return {
      blocked,
      cachedBlocked,
      staleBlocked,
      later: await store.get("outbox", "later"),
      heads: await store.get("heads", "test"),
    };
  });
  expect(result).toEqual({
    blocked: true,
    cachedBlocked: true,
    staleBlocked: true,
    later: undefined,
    heads: ["middle"],
  });
});

test("a stopped in-flight row clears when all recipients accept", async ({
  page,
}) => {
  await seed(page);
  const result = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { isNotDelivered } = await import(String("/src/data/delivery.ts"));
    const store = new LocalStore();
    const leaf = await store.mergeOutbox("leaf", (item: OutboxItem) => ({
      ...item,
      peers: Object.fromEntries(
        Object.entries(item.peers).map(([id, peer]) => [
          id,
          { ...peer, state: "accepted" },
        ]),
      ),
    }));
    return isNotDelivered(leaf!);
  });
  expect(result).toBe(false);
  await page.reload();
  await expect(
    page.locator(
      '[aria-label="Unfinished records"] [data-outbox-record="leaf"]',
    ),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "2 not delivered" }),
  ).toBeVisible();
});

test("lifecycle commits refuse a rediscovered discarded predecessor", async ({
  page,
}) => {
  await seed(page);
  const result = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { queueCompromise, queueHandover } = await import(
      String("/src/data/lifecycle.ts")
    );
    const store = new LocalStore();
    const leaf = await store.get("outbox", "leaf");
    await store.discardOutbox("leaf");
    // A server can still expose the discarded ID. Keep that evidence and refuse a new descendant.
    await store.put("heads", "test", ["leaf"]);
    const old = { identity: "test" };
    const successor = { identity: "next" };
    await store.put("keys", "selected", old);
    const item = (
      id: string,
      issuer: string,
      previous: string[],
      action: unknown,
    ) => ({
      ...leaf,
      id,
      identity: issuer,
      transport: JSON.stringify({
        envelope: { id, header: { issuer, previous, action } },
        body: null,
      }),
    });
    const compromise = item("compromise", "test", ["leaf"], {
      kind: "identity.compromise",
    });
    const transfer = item("transfer", "test", ["leaf"], {
      kind: "identity.transfer",
      successor: "next",
    });
    const accept = item("accept", "next", [], {
      kind: "identity.accept",
      transfer: "transfer",
    });
    const compromiseError = await queueCompromise(store, compromise, [
      "leaf",
    ]).then(
      () => "",
      (error: Error) => error.message,
    );
    const handoverError = await queueHandover(store, {
      transfer,
      accept,
      old,
      successor,
      successorTested: false,
      expectedHeads: ["leaf"],
    }).then(
      () => "",
      (error: Error) => error.message,
    );
    return {
      compromiseError,
      handoverError,
      compromise: await store.get("outbox", "compromise"),
      transfer: await store.get("outbox", "transfer"),
      selected: await store.get("keys", "selected"),
      heads: await store.get("heads", "test"),
    };
  });
  expect(result.compromiseError).toContain("discarded local record");
  expect(result.handoverError).toContain("discarded local record");
  expect(result.compromise).toBeUndefined();
  expect(result.transfer).toBeUndefined();
  expect(result.selected).toEqual({ identity: "test" });
  expect(result.heads).toEqual(["leaf"]);
});
