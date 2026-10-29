import { test, expect, type Page } from "@playwright/test";
import {
  acceptFirstSignature,
  createIdentity,
  fixture,
  openWord,
} from "./helpers.ts";

async function outboxItems(page: Page) {
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().list("outbox");
  });
}
const firstEndorse = (page: Page) =>
  page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" });

test("a receipt with a missing or wrong hash leaves delivery unknown on POST and on lookup", async ({
  page,
}) => {
  await createIdentity(page);
  // POST answers with a receipt that omits the envelope hash.
  await page.route("**/api/v1/events", async (route) => {
    const response = await route.fetch();
    const receipt = await response.json();
    delete receipt.envelope_hash;
    await route.fulfill({ status: 201, json: receipt });
  });
  await openWord(page, "cukta");
  await firstEndorse(page).click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toContainText(
    "Delivery is not finished.",
  );
  let items = await outboxItems(page);
  expect(items[0].peers.self.state).toBe("unknown");
  expect(items[0].peers.self.error).toContain(
    "does not name the stored envelope",
  );
  // Receipt lookup answers with a wrong envelope hash. The variant check fetches the
  // real envelope, whose hash differs from the claim, so delivery stays unknown.
  await page.unroute("**/api/v1/events");
  await page.route("**/api/v1/receipts/**", async (route) => {
    const response = await route.fetch();
    const receipt = await response.json();
    await route.fulfill({
      status: 200,
      json: { ...receipt, envelope_hash: "sha256:" + "0".repeat(64) },
    });
  });
  await page.route("**/api/v1/events", (route) =>
    route.fulfill({
      status: 500,
      json: {
        code: "test",
        message: "No resend during this step.",
        event: null,
        field: null,
      },
    }),
  );
  await page.getByRole("link", { name: "1 not delivered" }).click();
  await page.getByRole("button", { name: "Try now" }).click();
  await expect
    .poll(async () => (await outboxItems(page))[0].peers.self.attempts)
    .toBe(2);
  items = await outboxItems(page);
  expect(items[0].peers.self.state).toBe("unknown");
  expect(items[0].peers.self.error).toContain("No resend during this step");
  // A lookup receipt with the right envelope hash but a wrong body status for a
  // bodiless judgment is also not accepted.
  await page.unroute("**/api/v1/receipts/**");
  await page.route("**/api/v1/receipts/**", async (route) => {
    const response = await route.fetch();
    const receipt = await response.json();
    await route.fulfill({
      status: 200,
      json: { ...receipt, body_status: "present", body_hash: null },
    });
  });
  await page.getByRole("button", { name: "Try now" }).click();
  await expect
    .poll(async () => (await outboxItems(page))[0].peers.self.attempts)
    .toBe(3);
  items = await outboxItems(page);
  expect(items[0].peers.self.state).toBe("unknown");
  expect(items[0].peers.self.error).toContain("No resend during this step");
  // The real receipt completes delivery without a second POST.
  await page.unroute("**/api/v1/receipts/**");
  let posted = 0;
  await page.unroute("**/api/v1/events");
  await page.route("**/api/v1/events", (route) => {
    posted++;
    return route.continue();
  });
  await page.getByRole("button", { name: "Try now" }).click();
  await expect(page.getByRole("status")).toHaveText("Delivered.");
  items = await outboxItems(page);
  expect(items[0].peers.self.state).toBe("accepted");
  expect(posted).toBe(0);
});

test("a wrong body hash on a record with a body stays unknown until the real receipt matches", async ({
  page,
}) => {
  await createIdentity(page);
  const f = fixture();
  await page.route("**/api/v1/events", async (route) => {
    const response = await route.fetch();
    const receipt = await response.json();
    await route.fulfill({
      status: 201,
      json: { ...receipt, body_hash: "sha256:" + "1".repeat(64) },
    });
  });
  await page.getByLabel("Search words and meanings").fill("book");
  await page.getByLabel("Search words and meanings").press("Enter");
  await page
    .getByRole("region", { name: "Search results" })
    .getByRole("link", {
      name:
        f.identities.curator.slice(8, 12) +
        "…" +
        f.identities.curator.slice(-4),
    })
    .first()
    .click();
  await page.getByRole("button", { name: "Report abuse" }).click();
  const dialog = page.getByRole("dialog", { name: "Report identity abuse" });
  await expect(
    dialog.getByLabel("Explanation", { exact: true }),
  ).toHaveAttribute("contenteditable", "true");
  await dialog
    .getByLabel("Explanation", { exact: true })
    .fill("Synthetic body for the hash test.");
  await dialog
    .getByRole("button", { name: "Preview the public report" })
    .click();
  await page
    .getByRole("button", { name: "Sign and publish the report" })
    .click();
  await acceptFirstSignature(page);
  await expect(
    page.getByRole("link", { name: "1 not delivered" }),
  ).toBeVisible();
  // The marker counts queued records too. Wait for the attempt to settle.
  await expect
    .poll(async () => (await outboxItems(page))[0].peers.self.state)
    .toBe("unknown");
  let items = await outboxItems(page);
  expect(items[0].peers.self.error).toContain("submitted body hash");
  await page.unroute("**/api/v1/events");
  await page.getByRole("link", { name: "1 not delivered" }).click();
  await page.getByRole("button", { name: "Try now" }).click();
  await expect(page.getByRole("status")).toHaveText("Delivered.");
  items = await outboxItems(page);
  expect(items[0].peers.self.state).toBe("accepted");
  expect(items[0].peers.self.receipt.body_hash).toBe(
    JSON.parse(items[0].transport).envelope.header.content.hash,
  );
});

test("stopping during an in-flight request keeps the stop and still records the receipt", async ({
  page,
}) => {
  await createIdentity(page);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let posts = 0;
  await page.route("**/api/v1/events", async (route) => {
    posts++;
    await held;
    await route.continue();
  });
  await openWord(page, "cukta");
  await firstEndorse(page).click();
  await acceptFirstSignature(page);
  // The record is persisted before the send. Stop it while the request waits.
  await expect.poll(async () => (await outboxItems(page)).length).toBe(1);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const [item] = await store.list("outbox");
    await store.mergeOutbox(item.id, (current: any) => ({
      ...current,
      stopped: true,
    }));
  });
  release();
  await expect(page.getByRole("status")).toContainText("published");
  const items = await outboxItems(page);
  expect(items[0].stopped).toBe(true);
  expect(items[0].peers.self.state).toBe("accepted");
  expect(posts).toBe(1);
});

test("automatic delivery follows each peer's own schedule while an explicit retry attempts all", async ({
  page,
}) => {
  await createIdentity(page);
  // Configure a second recipient served through a routed path on this origin.
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().setPreferences({
      peers: [
        { id: "self", base: "/api/v1", label: "this server" },
        { id: "mirror", base: "/mirror/api/v1", label: "mirror" },
      ],
    });
  });
  await page.reload();
  await page
    .getByLabel("Passphrase", { exact: true })
    .fill("test passphrase with spaces");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByText("Unlocked", { exact: true })).toBeVisible();
  let mirrorPosts = 0;
  await page.route("**/mirror/api/v1/receipts/**", (route) =>
    route.fulfill({
      status: 404,
      json: { code: "missing", message: "missing", event: null, field: null },
    }),
  );
  await page.route("**/mirror/api/v1/events", (route) => {
    mirrorPosts++;
    return route.fulfill({
      status: 429,
      headers: { "retry-after": "600" },
      json: { code: "quota", message: "Later.", event: null, field: null },
    });
  });
  await openWord(page, "cukta");
  await firstEndorse(page).click();
  await acceptFirstSignature(page);
  await expect(
    page.getByRole("link", { name: "1 not delivered" }),
  ).toBeVisible();
  await expect
    .poll(async () => (await outboxItems(page))[0].peers.mirror.state)
    .toBe("unknown");
  let items = await outboxItems(page);
  expect(items[0].peers.self.state).toBe("accepted");
  expect(items[0].peers.mirror.nextAttempt - Date.now()).toBeGreaterThan(
    500000,
  );
  expect(mirrorPosts).toBe(1);
  // Automatic ticks respect the mirror's Retry-After even though the record is
  // active. The test observes the tick itself, not a fixed delay: the engine
  // runs a tick on the online event, and that tick must skip the mirror.
  await page.evaluate(async () => {
    const { DeliveryEngine } = await import(String("/src/data/delivery.ts"));
    const original = DeliveryEngine.prototype.tick;
    (window as any).__ticks = 0;
    DeliveryEngine.prototype.tick = async function (...args: unknown[]) {
      const result = await (original as any).apply(this, args);
      (window as any).__ticks += 1;
      return result;
    };
    window.dispatchEvent(new Event("online"));
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).__ticks as number))
    .toBeGreaterThan(0);
  items = await outboxItems(page);
  expect(items[0].peers.mirror.attempts).toBe(1);
  expect(items[0].peers.mirror.nextAttempt - Date.now()).toBeGreaterThan(
    500000,
  );
  expect(mirrorPosts).toBe(1);
  // An explicit retry attempts the mirror now.
  await page.getByRole("link", { name: "1 not delivered" }).click();
  await expect(page.getByText(/mirror:/)).toBeVisible();
  await page.getByRole("button", { name: "Try now" }).click();
  await expect(page.getByRole("status")).toContainText("Still not delivered.");
  expect(mirrorPosts).toBe(2);
  items = await outboxItems(page);
  expect(items[0].peers.self.attempts).toBe(1);
});

test("an unresolved recipient keeps its bytes and never falls back to this server", async ({
  page,
}) => {
  await createIdentity(page);
  let posts = 0;
  await page.route("**/api/v1/events", (route) => {
    posts++;
    return route.continue();
  });
  await openWord(page, "cukta");
  await firstEndorse(page).click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toHaveText(
    "Your endorsement is published.",
  );
  // Rewrite the stored recipient to an ID that no configuration names.
  const original = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const [item] = await store.list("outbox");
    await store.mergeOutbox(item.id, (current: any) => ({
      ...current,
      peers: {
        ghost: {
          state: "queued",
          attempts: 0,
          lastAttempt: null,
          nextAttempt: Date.now(),
          error: null,
          failure: null,
          receipt: null,
        },
      },
    }));
    return item.transport;
  });
  posts = 0;
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("link", { name: "1 not delivered" }).click();
  await expect(
    page.getByText(/Recipient "ghost" is not configured in this record/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Try now" }).click();
  await expect(page.getByRole("status")).toContainText("Still not delivered.");
  const items = await outboxItems(page);
  expect(items[0].transport).toBe(original);
  expect(items[0].peers.ghost.failure).toBe("unresolved");
  expect(items[0].peers.ghost.attempts).toBe(0);
  expect(posts).toBe(0);
});

test("a stale failure from another engine never overwrites an acceptance recorded meanwhile", async ({
  page,
}) => {
  await createIdentity(page);
  let release: (status: number) => void = () => {};
  const held = new Promise<number>((resolve) => (release = resolve));
  let posts = 0;
  await page.route("**/api/v1/events", async (route) => {
    posts++;
    if (posts === 1) {
      // The app's engine waits here. A second engine in the same browser completes first.
      const status = await held;
      await route
        .fulfill({
          status,
          json: {
            code: "server",
            message: "Late failure.",
            event: null,
            field: null,
          },
        })
        .catch(() => {});
      return;
    }
    await route.continue();
  });
  await openWord(page, "cukta");
  await firstEndorse(page).click();
  await acceptFirstSignature(page);
  await expect.poll(() => posts).toBe(1);
  // The second engine delivers the same record and peer while the first request is pending.
  const accepted = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { DeliveryEngine } = await import(String("/src/data/delivery.ts"));
    const store = new LocalStore();
    const [item] = await store.list("outbox");
    const engine = new DeliveryEngine(store);
    const result = await engine.deliver(item.id, true);
    return result.peers.self;
  });
  expect(accepted.state).toBe("accepted");
  expect(posts).toBe(2);
  release(500);
  await expect(page.getByRole("status")).toHaveText(
    "Your endorsement is published.",
  );
  const items = await outboxItems(page);
  expect(items[0].peers.self.state).toBe("accepted");
  expect(items[0].peers.self.nextAttempt).toBeNull();
  expect(items[0].peers.self.attempts).toBe(1);
  expect(items[0].peers.self.receipt.admission).toMatch(/accepted|duplicate/);
  await expect(page.getByRole("link", { name: /not delivered/ })).toBeHidden();
});

test("retries use the address saved with the record after the peer preference changes", async ({
  page,
}) => {
  await createIdentity(page);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().setPreferences({
      peers: [
        { id: "self", base: "/api/v1", label: "this server" },
        { id: "mirror", base: "/mirror/api/v1", label: "mirror" },
      ],
    });
  });
  await page.reload();
  await page
    .getByLabel("Passphrase", { exact: true })
    .fill("test passphrase with spaces");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByText("Unlocked", { exact: true })).toBeVisible();
  const hits = { mirror: 0, replacement: 0 };
  await page.route("**/mirror/api/v1/**", (route) => {
    hits.mirror++;
    return route.fulfill({
      status: 503,
      json: { code: "busy", message: "Later.", event: null, field: null },
    });
  });
  await page.route("**/replacement/api/v1/**", (route) => {
    hits.replacement++;
    return route.fulfill({
      status: 200,
      json: {
        id: "x",
        admission: "accepted",
        body_status: "none",
        interpretation: "none",
      },
    });
  });
  await openWord(page, "cukta");
  await firstEndorse(page).click();
  await acceptFirstSignature(page);
  await expect(
    page.getByRole("link", { name: "1 not delivered" }),
  ).toBeVisible();
  // The marker counts queued records too. Wait for the mirror attempt to settle.
  await expect
    .poll(async () => (await outboxItems(page))[0].peers.mirror.state)
    .toBe("unknown");
  let items = await outboxItems(page);
  expect(items[0].recipients.mirror).toEqual({
    origin: new URL(page.url()).origin,
    base: "/mirror/api/v1",
    label: "mirror",
  });
  expect(hits.mirror).toBe(1);
  // The operator moves the "mirror" ID to another address. The pending record keeps its own.
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().setPreferences({
      peers: [
        { id: "self", base: "/api/v1", label: "this server" },
        { id: "mirror", base: "/replacement/api/v1", label: "replacement" },
      ],
    });
  });
  await page.getByRole("link", { name: "1 not delivered" }).click();
  await expect(page.getByText(/mirror:/)).toBeVisible();
  await page.getByRole("button", { name: "Try now" }).click();
  await expect(page.getByRole("status")).toContainText("Still not delivered.");
  expect(hits.replacement).toBe(0);
  expect(hits.mirror).toBeGreaterThanOrEqual(2);
  items = await outboxItems(page);
  expect(items[0].peers.mirror.state).toBe("unknown");
  expect(items[0].recipients.mirror.base).toBe("/mirror/api/v1");
  // A record without saved address evidence stays unresolved even though the ID is configured now.
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const [item] = await store.list("outbox");
    await store.mergeOutbox(item.id, (current: any) => {
      const { recipients, ...rest } = current;
      return rest;
    });
  });
  await page.getByRole("button", { name: "Try now" }).click();
  await expect(page.getByRole("status")).toContainText("Still not delivered.");
  await expect(
    page.getByText(/Recipient "mirror" is not configured in this record/),
  ).toBeVisible();
  expect(hits.replacement).toBe(0);
});
