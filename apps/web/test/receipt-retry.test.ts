import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { OutboxItem } from "../src/data/store.ts";
import type { Transport } from "../src/model/types.ts";
import {
  acceptFirstSignature,
  corePath,
  createIdentity,
  openWord,
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

const signatureVariants = () =>
  JSON.parse(
    readFileSync(
      new URL(
        "../../../packages/service/test/fixtures/signature-variants.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Transport[];

type SaveFailure = "outcome" | "unknown" | "verification";

/**
 * Queues one record in its own database and starts a delivery engine that
 * stays open in the page. IndexedDB aborts up to `failures` outbox writes of
 * the record that match `fail`. The send mark of a first send stays queued,
 * so "outcome" fails every write except that mark.
 */
async function startEngine(
  page: Page,
  options: {
    database: string;
    fail: SaveFailure;
    failures: number;
    transport?: Transport;
    peer?: Record<string, unknown>;
  },
) {
  return page.evaluate(
    async ({ corePath, options }) => {
      const core = await import(corePath);
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { DeliveryEngine } = await import(String("/src/data/delivery.ts"));
      const { outboxItem } = await import(String("/src/data/lifecycle.ts"));
      await core.initializeCore();
      const store = new LocalStore(options.database);
      const item: OutboxItem = outboxItem(
        options.transport ??
          core.createEvent(
            crypto.getRandomValues(new Uint8Array(32)),
            [],
            "1".repeat(32),
            { kind: "identity.profile" },
            { name: "Unsaved outcome", bio: [], links: [] },
          ),
        "unsaved",
        0,
        {
          self: {
            origin: location.origin,
            base: "/api/v1",
            label: "This server",
          },
        },
      );
      Object.assign(item.peers.self, options.peer ?? {});
      await store.queueGroup([item]);
      let failed = 0;
      const matches = (peer: { state: string; verifyReceipt?: boolean }) =>
        options.fail === "outcome"
          ? peer.state !== "queued"
          : options.fail === "unknown"
            ? peer.state === "unknown"
            : peer.verifyReceipt === true;
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) {
        const request = put.call(this, value, key);
        if (
          this.name === "outbox" &&
          key === item.id &&
          value.peers?.self &&
          matches(value.peers.self) &&
          failed < options.failures
        ) {
          failed++;
          this.transaction.abort();
        }
        return request;
      };
      const engine = new DeliveryEngine(store);
      Object.assign(window, { unsavedEngine: engine });
      const result = await engine.tryNow(item.id).then(
        () => "saved",
        (error: Error) => error.name,
      );
      return { item, result, failed };
    },
    { corePath, options },
  );
}

async function storedPeer(page: Page, database: string) {
  return (await readOutbox(page, database))[0].peers.self;
}

test("an unsaved outcome keeps its Retry-After", async ({ page }) => {
  await page.goto("/about");
  await expect(page.locator("main h1")).toBeAttached();
  await freeze(page);
  const { posts, lookups } = deliveryRequests(page);
  await page.route("**/api/v1/events", (route) =>
    route.fulfill({
      status: 503,
      headers: { "retry-after": "600" },
      json: { code: "busy", message: "Busy.", event: null, field: null },
    }),
  );
  const { item, result } = await startEngine(page, {
    database: "unsaved-retry-after",
    fail: "outcome",
    failures: 1000,
  });
  expect(result).not.toBe("saved");
  expect(posts).toEqual([item.transport]);
  const wait = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const [row] = await new LocalStore("unsaved-retry-after").list("outbox");
    const engine = (
      window as unknown as {
        unsavedEngine: { nextTryAt(item: unknown, peer: string): number };
      }
    ).unsavedEngine;
    return engine.nextTryAt(row, "self") - Date.now();
  });
  expect(wait).toBe(600_000);
  for (let step = 0; step < 39; step++) await page.clock.fastForward(15_000);
  // Give a wrongly due attempt real time to start its requests.
  await page.waitForTimeout(1000);
  expect(posts).toEqual([item.transport]);
  expect(lookups).toEqual([]);
  await page.clock.fastForward(15_000);
  await expect.poll(() => posts.length).toBe(2);
  expect(posts).toEqual([item.transport, item.transport]);
  expect(lookups).toEqual([item.id]);
  expect((await readOutbox(page, "unsaved-retry-after"))[0].transport).toBe(
    item.transport,
  );
});

test("a refused record keeps a timer when its lookup and its outcome save fail", async ({
  page,
}) => {
  await page.goto("/about");
  await expect(page.locator("main h1")).toBeAttached();
  await freeze(page);
  const { posts, lookups } = deliveryRequests(page);
  await page.route("**/api/v1/receipts/*", (route) => route.abort("failed"));
  const { item, result, failed } = await startEngine(page, {
    database: "unsaved-refusal",
    fail: "unknown",
    failures: 1,
    peer: {
      state: "refused",
      nextAttempt: null,
      failure: "refused",
      attempt: "older-refusal",
    },
  });
  expect(result).not.toBe("saved");
  expect(failed).toBe(1);
  expect(lookups).toEqual([item.id]);
  expect((await storedPeer(page, "unsaved-refusal")).state).toBe("refused");
  await page.clock.fastForward(15_000);
  await expect.poll(() => lookups.length).toBe(2);
  await expect
    .poll(async () => (await storedPeer(page, "unsaved-refusal")).state)
    .toBe("unknown");
  expect(posts).toEqual([]);
});

test("a pending verification that finds a missing body sends the identical record again", async ({
  page,
}) => {
  const variants = signatureVariants();
  await page.goto("/about");
  await expect(page.locator("main h1")).toBeAttached();
  await freeze(page);
  const { posts, lookups } = deliveryRequests(page);
  const bytes = await page.evaluate(
    async ({ corePath, envelope }) => {
      const core = await import(corePath);
      await core.initializeCore();
      const bytes = core.canonicalize(core.utf8(JSON.stringify(envelope)));
      return { bytes, hash: core.contentHash(core.utf8(bytes)) };
    },
    { corePath, envelope: variants[0].envelope },
  );
  const receipt = {
    id: variants[1].envelope.id,
    envelope_hash: bytes.hash,
    body_status: "missing",
    body_hash: null,
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
    if (++envelopeReads === 1) return route.abort("failed");
    await route.fulfill({ body: bytes.bytes, contentType: "application/json" });
  });
  const { item, result, failed } = await startEngine(page, {
    database: "unsaved-missing-body",
    fail: "verification",
    failures: 1,
    transport: variants[1],
  });
  expect(result).not.toBe("saved");
  expect(failed).toBe(1);
  expect(posts).toEqual([item.transport]);
  await page.clock.fastForward(15_000);
  await expect
    .poll(async () => (await storedPeer(page, "unsaved-missing-body")).state)
    .toBe("missing-body");
  expect(posts).toEqual([item.transport, item.transport]);
  expect(lookups).toEqual([item.id]);
  expect((await storedPeer(page, "unsaved-missing-body")).verifyReceipt).toBe(
    undefined,
  );
});

test("the outbox shows a proved receipt mismatch after pending verification", async ({
  page,
}) => {
  const variants = signatureVariants();
  await page.goto("/about");
  await expect(page.locator("main h1")).toBeAttached();
  const seed = await page.evaluate(
    async ({ corePath, variants }) => {
      const core = await import(corePath);
      await core.initializeCore();
      const canonical = (envelope: unknown) =>
        core.canonicalize(core.utf8(JSON.stringify(envelope)));
      const other = canonical(
        core.createEvent(
          crypto.getRandomValues(new Uint8Array(32)),
          [],
          "1".repeat(32),
          { kind: "identity.profile" },
          { name: "Other record", bio: [], links: [] },
        ).envelope,
      );
      return {
        other,
        hash: core.contentHash(core.utf8(canonical(variants[0].envelope))),
      };
    },
    { corePath, variants },
  );
  const receipt = {
    id: variants[1].envelope.id,
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
  const { posts } = deliveryRequests(page);
  await page.route("**/api/v1/events", (route) =>
    route.fulfill({ status: 201, json: receipt }),
  );
  await page.route("**/api/v1/receipts/*", (route) =>
    route.fulfill({ json: receipt }),
  );
  let envelopeReads = 0;
  await page.route("**/api/v1/events/*", async (route) => {
    if (++envelopeReads === 1) return route.abort("failed");
    await route.fulfill({ body: seed.other, contentType: "application/json" });
  });
  const item = await page.evaluate(async (transport) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { outboxItem } = await import(String("/src/data/lifecycle.ts"));
    const item: OutboxItem = outboxItem(transport, "mismatch", 0, {
      self: {
        origin: location.origin,
        base: "/api/v1",
        label: "This server",
      },
    });
    await new LocalStore().queueGroup([item]);
    return item;
  }, variants[1]);
  await page.goto("/outbox");
  await expect(
    page.getByText(
      "The result is unconfirmed. The browser will check the receipt again when online.",
    ),
  ).toBeVisible();
  expect((await readOutbox(page))[0].peers.self.verifyReceipt).toBe(true);
  await page.getByRole("button", { name: "Try now" }).click();
  await expect(
    page.getByText(
      /The receipt names an envelope that does not match the stored record\. Delivery remains unknown\. The client asks whether the record arrived before it sends the same bytes again\./,
    ),
  ).toBeVisible();
  await expect(page.getByText(/Receipt verification is pending/)).toHaveCount(
    0,
  );
  await expect(
    page.getByText(/will check the receipt again when online/),
  ).toHaveCount(0);
  const [saved] = await readOutbox(page);
  expect(saved.peers.self).toMatchObject({ state: "unknown" });
  expect(saved.peers.self.verifyReceipt).toBe(undefined);
  // The proved mismatch permits the identical retry.
  expect(posts).toEqual([item.transport, item.transport]);
  expect(saved.transport).toBe(item.transport);
});

/** Aborts the next `count` outbox writes in this page whose peer state is `state`. */
async function abortOutboxWrites(page: Page, state: string, count = 1) {
  await page.evaluate(
    ({ state, count }) => {
      let left = count;
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) {
        const request = put.call(this, value, key);
        if (
          this.name === "outbox" &&
          left > 0 &&
          Object.values(
            (value?.peers ?? {}) as Record<string, { state: string }>,
          ).some((peer) => peer.state === state)
        ) {
          left--;
          this.transaction.abort();
        }
        return request;
      };
    },
    { state, count },
  );
}

/** Queues one fresh signed profile in the app's own outbox. */
async function queueProfile(page: Page, peer: Record<string, unknown> = {}) {
  return page.evaluate(
    async ({ corePath, peer }) => {
      const core = await import(corePath);
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { outboxItem } = await import(String("/src/data/lifecycle.ts"));
      await core.initializeCore();
      const item: OutboxItem = outboxItem(
        core.createEvent(
          crypto.getRandomValues(new Uint8Array(32)),
          [],
          "1".repeat(32),
          { kind: "identity.profile" },
          { name: "Outbox view", bio: [], links: [] },
        ),
        "outbox-view",
        0,
        {
          self: {
            origin: location.origin,
            base: "/api/v1",
            label: "This server",
          },
        },
      );
      Object.assign(item.peers.self, peer);
      await new LocalStore().queueGroup([item]);
      return item;
    },
    { corePath, peer },
  );
}

test("Stop and Resume on the outbox send again after an unsaved refusal", async ({
  page,
}) => {
  await page.goto("/outbox");
  await expect(page.getByText("No unfinished records.")).toBeVisible();
  const { posts } = deliveryRequests(page);
  let refuse = true;
  await page.route("**/api/v1/events", (route) =>
    refuse
      ? route.fulfill({
          status: 422,
          json: {
            code: "refused",
            message: "Refused.",
            event: null,
            field: null,
          },
        })
      : route.continue(),
  );
  await abortOutboxWrites(page, "refused");
  const item = await queueProfile(page);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => posts.length).toBe(1);
  await expect(
    page.getByText(
      "The result is unconfirmed. The browser will check the receipt again when online.",
    ),
  ).toBeVisible();
  expect((await readOutbox(page))[0].peers.self.state).toBe("queued");
  refuse = false;
  await page.getByRole("button", { name: "Stop retrying" }).click();
  await page.getByRole("button", { name: "Resume" }).click();
  await expect
    .poll(async () => (await readOutbox(page))[0].peers.self.state)
    .toBe("accepted");
  expect(posts).toEqual([item.transport, item.transport]);
});

test("the outbox summary and saved publication lines show an unconfirmed outcome", async ({
  page,
}) => {
  await page.goto("/outbox");
  await expect(page.getByText("No unfinished records.")).toBeVisible();
  const { posts } = deliveryRequests(page);
  const stale = {
    state: "missing-body",
    attempts: 1,
    nextAttempt: Date.now() + 3_600_000,
    error:
      "The server stored the signed header without its body. The complete record will be sent again.",
    attempt: "older",
  };
  const item = await queueProfile(page, stale);
  const receipt = await page.evaluate(async (transport) => {
    const { storedEnvelopeHash } = await import(
      String("/src/data/delivery.ts")
    );
    const parsed = JSON.parse(transport) as Transport;
    return {
      id: parsed.envelope.id,
      admission: "accepted",
      interpretation: "effective",
      body_status: "present",
      body_hash: parsed.envelope.header.content?.hash,
      envelope_hash: storedEnvelopeHash(transport),
      cursor: "x.1",
      snapshot: null,
      view: "jve1:" + "a".repeat(64),
      reasons: [],
    };
  }, item.transport);
  await page.route("**/api/v1/receipts/*", (route) =>
    route.fulfill({ json: receipt }),
  );
  await page.reload();
  await expect(
    page.getByText(/A server stored a signed header without its required body/),
  ).toBeVisible();
  await abortOutboxWrites(page, "accepted");
  await page.getByRole("button", { name: "Try now" }).click();
  await expect(
    page.getByText(
      "The result is unconfirmed. The browser will check the receipt again when online.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText(/Some delivery outcomes are unconfirmed/),
  ).toBeVisible();
  await expect(
    page.getByText(/A server stored a signed header without its required body/),
  ).toHaveCount(0);
  expect((await readOutbox(page))[0].peers.self.state).toBe("missing-body");
  expect(posts).toEqual([]);

  // The saved publication lines use the same rule in another engine.
  const lines = await page.evaluate(async (stale) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { DeliveryEngine } = await import(String("/src/data/delivery.ts"));
    const { savedGroupState } = await import(
      String("/src/pages/wizard/publish.ts")
    );
    const main = new LocalStore();
    const [row] = (await main.list("outbox")) as OutboxItem[];
    const store = new LocalStore("saved-lines");
    await store.queueGroup([
      { ...row, peers: { self: { ...row.peers.self, ...stale } } },
    ]);
    const put = IDBObjectStore.prototype.put;
    let left = 1;
    IDBObjectStore.prototype.put = function (value, key) {
      const request = put.call(this, value, key);
      if (
        this.name === "outbox" &&
        left > 0 &&
        value?.peers?.self?.state === "accepted"
      ) {
        left--;
        this.transaction.abort();
      }
      return request;
    };
    const engine = new DeliveryEngine(store);
    await engine.tryNow(row.id).catch(() => {});
    const items = (await store.list("outbox")) as OutboxItem[];
    return {
      state: items[0].peers.self.state,
      lines: savedGroupState(items, engine).lines,
    };
  }, stale);
  expect(lines.state).toBe("missing-body");
  expect(lines.lines.join(" ")).toContain(
    "The result is unconfirmed. The browser will check the receipt again when online.",
  );
  expect(lines.lines.join(" ")).not.toContain("will be sent again");
});

test("a judgment whose outcome save fails still reports a saved record", async ({
  page,
}) => {
  await createIdentity(page);
  await openWord(page, "cukta");
  await abortOutboxWrites(page, "accepted");
  const { posts } = deliveryRequests(page);
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toContainText(
    "Your judgment is signed and saved here. Delivery is not finished.",
  );
  await expect.poll(() => posts.length).toBe(1);
  const rows = await readOutbox(page);
  expect(rows).toHaveLength(1);
  expect(rows[0].transport).toBe(posts[0]);
});
