import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { OutboxItem } from "../src/data/store.ts";
import type { Transport } from "../src/model/types.ts";
import {
  acceptFirstSignature,
  corePath,
  createIdentity,
  PASSPHRASE,
} from "./helpers.ts";

async function freeze(page: Page) {
  const now = Date.now();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now + 1000);
}

function deliveryRequests(page: Page) {
  const posts: string[] = [];
  const lookups: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      path === "/api/v1/events" &&
      !request.headers()["x-fixture-seed"]
    )
      posts.push(request.postData()!);
    if (request.method() === "GET" && path.startsWith("/api/v1/receipts/"))
      lookups.push(decodeURIComponent(path.slice("/api/v1/receipts/".length)));
  });
  return { posts, lookups };
}

function readOutbox(page: Page, database?: string): Promise<OutboxItem[]> {
  return page.evaluate(async (name) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore(name).list("outbox");
  }, database);
}

for (const mode of [
  "automatic delivery",
  "Try now",
  "refused",
  "independent",
  "oversized",
] as const) {
  test(`receipt recovery after ${mode}`, async ({ page }) => {
    await page.goto("/about");
    await expect(page.locator("main h1")).toBeAttached();
    await freeze(page);
    const { posts, lookups } = deliveryRequests(page);
    if (mode === "oversized")
      await page.route("**/api/v1/events", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        // The peer takes the record. The browser receives an uncertain result.
        expect((await route.fetch()).status()).toBe(201);
        await route.fulfill({
          status: 503,
          headers: { "retry-after": "9".repeat(309) },
          json: { message: "Retry later." },
        });
      });
    const before = await page.evaluate(
      async ({ corePath, mode }) => {
        const core = await import(corePath);
        const { LocalStore } = await import(String("/src/data/store.ts"));
        const { DeliveryEngine } = await import(
          String("/src/data/delivery.ts")
        );
        const { outboxItem } = await import(String("/src/data/lifecycle.ts"));
        await core.initializeCore();
        const store = new LocalStore("receipt-retry");
        const make = (group: string): OutboxItem =>
          outboxItem(
            core.createEvent(
              crypto.getRandomValues(new Uint8Array(32)),
              [],
              "1".repeat(32),
              { kind: "identity.profile" },
              { name: "Receipt retry", bio: [], links: [] },
            ),
            group,
            0,
            {
              self: {
                origin: location.origin,
                base: "/api/v1",
                label: "This server",
              },
            },
          );
        const item = make("test");
        const other = mode === "independent" ? make("unrelated") : null;
        if (mode === "refused") {
          const seeded = await fetch("/api/v1/events", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-fixture-seed": "yes",
            },
            body: item.transport,
          });
          if (!seeded.ok) throw new Error(await seeded.text());
          Object.assign(item.peers.self, {
            state: "refused",
            nextAttempt: null,
            failure: "refused",
            attempt: "older-refusal",
          });
        }
        await store.queueGroup([item]);
        if (other) await store.queueGroup([other]);

        let failedWrites = 0;
        const failureLimit =
          mode === "oversized" ? 0 : mode === "independent" ? 2 : 1;
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (value, key) {
          const request = put.call(this, value, key);
          if (
            this.name === "outbox" &&
            key === item.id &&
            value.peers?.self?.state === "accepted" &&
            failedWrites < failureLimit
          ) {
            failedWrites++;
            if (failedWrites === failureLimit)
              IDBObjectStore.prototype.put = put;
            this.transaction.abort();
          }
          return request;
        };
        const engine = new DeliveryEngine(store);
        await (
          mode === "Try now" || mode === "refused"
            ? engine.tryNow(item.id)
            : engine.tick()
        ).catch(() => {});
        return {
          saved: (await store.get("outbox", item.id)) as OutboxItem,
          other,
          failedWrites,
        };
      },
      { corePath, mode },
    );
    expect(before.failedWrites).toBe(mode === "oversized" ? 0 : 1);
    expect(before.saved.peers.self).toMatchObject({
      state:
        mode === "refused"
          ? "refused"
          : mode === "oversized"
            ? "unknown"
            : "queued",
      receipt: null,
    });
    if (mode === "oversized")
      expect(Number.isFinite(before.saved.peers.self.nextAttempt)).toBe(true);
    if (before.saved.peers.self.state === "queued") {
      expect(before.saved.peers.self.sendStarted).toEqual(expect.any(Number));
      expect(before.saved.peers.self.sendAttempt).toEqual(expect.any(String));
    }
    const expectedPosts =
      mode === "refused"
        ? []
        : [
            before.saved.transport,
            ...(before.other ? [before.other.transport] : []),
          ];
    expect(posts).toEqual(expectedPosts);
    const expectedLookups = mode === "refused" ? [before.saved.id] : [];
    expect(lookups).toEqual(expectedLookups);
    const read = () => readOutbox(page, "receipt-retry");
    if (before.other) {
      expect(
        (await read()).find((row) => row.id === before.other?.id)?.peers.self
          .state,
      ).toBe("accepted");
      await page.clock.fastForward(15_000);
      await expect.poll(() => lookups.slice()).toEqual([before.saved.id]);
      expect(
        (await read()).find((row) => row.id === before.saved.id)?.peers.self
          .state,
      ).toBe("queued");
      expectedLookups.push(before.saved.id);
    }
    await page.clock.fastForward(15_000);
    await expect
      .poll(
        async () =>
          (await read()).find((row) => row.id === before.saved.id)?.peers.self
            .state,
      )
      .toBe("accepted");
    expect(posts).toEqual(expectedPosts);
    expect(lookups).toEqual([...expectedLookups, before.saved.id]);
    const after = await read();
    expect(after).toHaveLength(before.other ? 2 : 1);
    expect(after.find((row) => row.id === before.saved.id)).toMatchObject({
      transport: before.saved.transport,
      peers: { self: { nextAttempt: null, receipt: { id: before.saved.id } } },
    });
  });
}

test("delivery retries an envelope read after a failed receipt save", async ({
  page,
}) => {
  const variants = JSON.parse(
    readFileSync(
      new URL(
        "../../../packages/service/test/fixtures/signature-variants.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Transport[];
  await page.goto("/about");
  await expect(page.locator("main h1")).toBeAttached();
  await freeze(page);
  const { posts, lookups } = deliveryRequests(page);
  const seed = await page.evaluate(
    async ({ corePath, variants }) => {
      const core = await import(corePath);
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { outboxItem } = await import(String("/src/data/lifecycle.ts"));
      await core.initializeCore();
      const item: OutboxItem = outboxItem(variants[1], "variant", 0, {
        self: {
          origin: location.origin,
          base: "/api/v1",
          label: "This server",
        },
      });
      await new LocalStore("receipt-retry").queueGroup([item]);
      const bytes = core.canonicalize(
        core.utf8(JSON.stringify(variants[0].envelope)),
      );
      return { item, bytes, hash: core.contentHash(core.utf8(bytes)) };
    },
    { corePath, variants },
  );
  const receipt = {
    id: seed.item.id,
    envelope_hash: seed.hash,
    body_status: "present",
    body_hash: variants[1].envelope.header.content?.hash,
    admission: "accepted",
    interpretation: "effective",
    cursor: "x.1",
    snapshot: null,
    view: "jve1:" + "a".repeat(64),
    reasons: [],
  };
  await page.route("**/api/v1/events", (route) =>
    route.fulfill({ status: 201, json: receipt }),
  );
  await page.route("**/api/v1/receipts/*", (route) =>
    route.fulfill({ json: receipt }),
  );
  let envelopeReads = 0;
  await page.route("**/api/v1/events/*", async (route) => {
    if (++envelopeReads === 2) return route.abort("failed");
    await route.fulfill({ body: seed.bytes, contentType: "application/json" });
  });
  const failure = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { DeliveryEngine } = await import(String("/src/data/delivery.ts"));
    const store = new LocalStore("receipt-retry");
    const [item] = (await store.list("outbox")) as OutboxItem[];
    const put = IDBObjectStore.prototype.put;
    let aborted = false;
    IDBObjectStore.prototype.put = function (value, key) {
      const request = put.call(this, value, key);
      if (this.name === "outbox" && value.peers?.self?.state === "accepted") {
        IDBObjectStore.prototype.put = put;
        aborted = true;
        this.transaction.abort();
      }
      return request;
    };
    try {
      await new DeliveryEngine(store).tryNow(item.id);
    } catch {
      return aborted;
    }
    return false;
  });
  expect(failure).toBe(true);
  expect(posts).toEqual([seed.item.transport]);
  expect(envelopeReads).toBe(1);
  await page.clock.fastForward(15_000);
  await expect.poll(() => envelopeReads).toBe(2);
  expect(posts).toEqual([seed.item.transport]);
  await expect.poll(() => lookups.slice()).toEqual([seed.item.id]);
  await page.clock.fastForward(15_000);
  await expect
    .poll(
      async () =>
        (await readOutbox(page, "receipt-retry"))[0]?.peers.self.state,
    )
    .toBe("accepted");
  expect(posts).toEqual([seed.item.transport]);
  expect(lookups).toEqual([seed.item.id, seed.item.id]);
  expect(envelopeReads).toBe(3);
  expect((await readOutbox(page, "receipt-retry"))[0].transport).toBe(
    seed.item.transport,
  );
});

test("a failed publication receipt save reports an unconfirmed outcome", async ({
  page,
}) => {
  await createIdentity(page);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { newDraft } = await import(String("/src/model/draft.ts"));
    await new LocalStore().put(
      "drafts",
      "current",
      newDraft({
        spelling: "brodi",
        kind: "gismu",
        meaning: "A disposable test meaning.",
        text: "A disposable test meaning.",
        structured: false,
        frameMode: "none",
        step: 5,
        rafsiClaims: [{ rafsi: "bro", rationale: "Disposable claim." }],
      }),
    );
  });
  await page.goto("/new/publish");
  const { posts, lookups } = deliveryRequests(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      const request = put.call(this, value, key);
      if (this.name === "outbox" && value.peers?.self?.state === "accepted") {
        IDBObjectStore.prototype.put = put;
        this.transaction.abort();
      }
      return request;
    };
  });
  await page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true })
    .click();
  await page.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await freeze(page);
  await acceptFirstSignature(page);
  await expect(page.getByText(/A step after saving failed:/)).toBeVisible();
  const saved = page.getByRole("region", { name: "Saved publication" });
  await expect(saved).toContainText("Saved. Outcome unconfirmed.");
  await expect(saved).toContainText("will check the receipt again when online");
  await expect(saved).not.toContainText("Saved. Sending.");
  await expect(saved.getByRole("button", { name: "Try now" })).toBeVisible();
  const [first] = (await readOutbox(page)).sort((a, b) => a.order - b.order);
  expect(first.peers.self.sendAttempt).toEqual(expect.any(String));
  expect(posts).toEqual([first.transport]);
  expect(lookups).toEqual([]);
  await page.clock.fastForward(15_000);
  await expect
    .poll(
      async () =>
        (await readOutbox(page)).find((row) => row.id === first.id)?.peers.self
          .state,
    )
    .toBe("accepted");
  expect(posts.filter((post) => post === first.transport)).toHaveLength(1);
  expect(lookups.filter((id) => id === first.id)).toHaveLength(1);
  expect(
    (await readOutbox(page)).find((row) => row.id === first.id)?.transport,
  ).toBe(first.transport);
});

test("an outbox read failure keeps the empty state unknown", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const getAll = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function (...args) {
      if (this.name === "outbox")
        throw new DOMException("Test outbox read failure.", "UnknownError");
      return getAll.apply(this, args);
    };
    window.addEventListener(
      "restore-outbox-read",
      () => {
        IDBObjectStore.prototype.getAll = getAll;
      },
      { once: true },
    );
  });
  await page.goto("/outbox");
  await expect(
    page.getByText("This browser could not read the saved records."),
  ).toBeVisible();
  await expect(page.getByText("No unfinished records.")).toHaveCount(0);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("restore-outbox-read")),
  );
  await page.getByRole("button", { name: "Retry reading" }).click();
  await expect(page.getByText("No unfinished records.")).toBeVisible();
});
