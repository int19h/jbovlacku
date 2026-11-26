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
    if (before.other)
      expect(
        (await read()).find((row) => row.id === before.other?.id)?.peers.self
          .state,
      ).toBe("accepted");
    // A validated answer whose write failed commits locally, with no
    // request. An uncertain answer looks up the receipt after the backoff.
    if (mode === "oversized") await page.clock.fastForward(15_000);
    // Storage answers in real time, so the fake clock moves one second per
    // check until the local write commits.
    await expect
      .poll(async () => {
        if (mode !== "oversized") await page.clock.runFor(1_000);
        return (await read()).find((row) => row.id === before.saved.id)?.peers
          .self.state;
      })
      .toBe("accepted");
    expect(posts).toEqual(expectedPosts);
    expect(lookups).toEqual(
      mode === "oversized" ? [before.saved.id] : expectedLookups,
    );
    const after = await read();
    expect(after).toHaveLength(before.other ? 2 : 1);
    expect(after.find((row) => row.id === before.saved.id)).toMatchObject({
      transport: before.saved.transport,
      peers: { self: { nextAttempt: null, receipt: { id: before.saved.id } } },
    });
  });
}

test("a verified variant acceptance whose save fails commits locally without another request", async ({
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
  await page.clock.fastForward(2_000);
  await expect
    .poll(
      async () =>
        (await readOutbox(page, "receipt-retry"))[0]?.peers.self.state,
    )
    .toBe("accepted");
  expect(posts).toEqual([seed.item.transport]);
  expect(lookups).toEqual([]);
  expect(envelopeReads).toBe(1);
  expect((await readOutbox(page, "receipt-retry"))[0].transport).toBe(
    seed.item.transport,
  );
});

test("a failed publication receipt save reports a result that still needs saving", async ({
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
  await expect(saved).toContainText(
    "Saved. A delivery result still needs saving.",
  );
  await expect(saved).toContainText("could not save that answer yet");
  await expect(saved).toContainText(
    "The server accepted this record. This browser still needs to save the receipt.",
  );
  await expect(saved).not.toContainText("Saved. Sending.");
  await expect(saved.getByRole("button", { name: "Try now" })).toBeVisible();
  const [first] = (await readOutbox(page)).sort((a, b) => a.order - b.order);
  expect(first.peers.self.sendAttempt).toEqual(expect.any(String));
  // The tab knows that the server accepted the first record, so the later
  // records of the group can go ahead. The first record is sent once.
  expect(posts.filter((post) => post === first.transport)).toHaveLength(1);
  expect(lookups).toEqual([]);
  await page.clock.fastForward(2_000);
  await expect
    .poll(
      async () =>
        (await readOutbox(page)).find((row) => row.id === first.id)?.peers.self
          .state,
    )
    .toBe("accepted");
  // The local write needed no request. Every record of the group went
  // once, also the later ones that went ahead meanwhile.
  await expect
    .poll(async () =>
      (await readOutbox(page)).every(
        (row) => row.peers.self.state === "accepted",
      ),
    )
    .toBe(true);
  expect(lookups).toEqual([]);
  expect(posts).toHaveLength(4);
  expect(new Set(posts).size).toBe(posts.length);
  await expect(saved).toContainText("Published.");
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

type SaveFailure = "outcome" | "unknown" | "refused" | "verification";

/**
 * Queues one record in its own database and starts a delivery engine that
 * stays open in the page. IndexedDB aborts up to `failures` outbox writes of
 * the record that match `fail`. "outcome" fails every outcome write and
 * leaves send mark writes, which carry their attempt ID.
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
      const matches = (peer: {
        state: string;
        verifyReceipt?: boolean;
        sendAttempt?: string;
      }) =>
        options.fail === "outcome"
          ? peer.state !== "queued" && peer.sendAttempt === undefined
          : options.fail === "unknown" || options.fail === "refused"
            ? peer.state === options.fail
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

test("a failed write of a Retry-After outcome commits locally and keeps the deadline", async ({
  page,
}) => {
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
  // The outcome write fails, then its two local retries fail.
  const { item, result } = await startEngine(page, {
    database: "unsaved-retry-after",
    fail: "outcome",
    failures: 3,
  });
  expect(result).not.toBe("saved");
  expect(posts).toEqual([item.transport]);
  await expect
    .poll(async () => {
      await page.clock.runFor(1_000);
      return (await readOutbox(page, "unsaved-retry-after"))[0].peers.self
        .state;
    })
    .toBe("unknown");
  const wait = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const [row] = await new LocalStore("unsaved-retry-after").list("outbox");
    const engine = (
      window as unknown as {
        unsavedEngine: { nextTryAt(item: unknown, peer: string): number };
      }
    ).unsavedEngine;
    return engine.nextTryAt(row, "self") - row.peers.self.lastAttempt;
  });
  // The local retries left the server's deadline as it was.
  expect(wait).toBe(600_000);
  expect(lookups).toEqual([]);
  // Move to 10 s before the deadline in 15 s steps.
  const elapsed = await page.evaluate(
    async () =>
      Date.now() -
      (
        await (
          await import(String("/src/data/store.ts"))
        ).LocalStore.prototype.list.call(
          new (await import(String("/src/data/store.ts"))).LocalStore(
            "unsaved-retry-after",
          ),
          "outbox",
        )
      )[0].peers.self.lastAttempt,
  );
  for (let left = 590_000 - elapsed; left > 0; left -= 15_000)
    await page.clock.fastForward(Math.min(15_000, left));
  // Give a wrongly due attempt real time to start its requests.
  await page.waitForTimeout(1000);
  expect(posts).toEqual([item.transport]);
  expect(lookups).toEqual([]);
  await page.clock.fastForward(20_000);
  await expect.poll(() => posts.length).toBe(2);
  expect(posts).toEqual([item.transport, item.transport]);
  expect(lookups).toEqual([item.id]);
  expect((await readOutbox(page, "unsaved-retry-after"))[0].transport).toBe(
    item.transport,
  );
});

test("a refused record whose lookup and outcome save fail saves the result locally and keeps its timer", async ({
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
  // The unknown result commits locally, without a request.
  await page.clock.fastForward(2_000);
  await expect
    .poll(async () => (await storedPeer(page, "unsaved-refusal")).state)
    .toBe("unknown");
  expect(lookups).toEqual([item.id]);
  // Its saved retry time then runs the next lookup.
  await page.clock.fastForward(15_000);
  await expect.poll(() => lookups.length).toBe(2);
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
  // The open verification commits locally first.
  await page.clock.fastForward(2_000);
  await expect
    .poll(
      async () =>
        (await storedPeer(page, "unsaved-missing-body")).verifyReceipt,
    )
    .toBe(true);
  expect(lookups).toEqual([]);
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
    page.getByText("Delivery is unconfirmed. Receipt verification is pending."),
  ).toBeVisible();
  await expect(page.getByText(/Next receipt check/)).toBeVisible();
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
  const [saved] = await readOutbox(page);
  expect(saved.peers.self).toMatchObject({ state: "unknown" });
  expect(saved.peers.self.verifyReceipt).toBe(undefined);
  // The proved mismatch permits the identical retry.
  expect(posts).toEqual([item.transport, item.transport]);
  expect(saved.transport).toBe(item.transport);
});

/**
 * Aborts the next `count` outbox writes in this page whose peer state is
 * `state` and that carry no send mark. `releaseOutboxAborts` ends it early.
 */
async function abortOutboxWrites(page: Page, state: string, count = 1) {
  await page.evaluate(
    ({ state, count }) => {
      let left = count;
      Object.assign(window, {
        releaseOutboxAborts: () => {
          left = 0;
        },
      });
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) {
        const request = put.call(this, value, key);
        if (
          this.name === "outbox" &&
          left > 0 &&
          Object.values(
            (value?.peers ?? {}) as Record<string, { state: string }>,
          ).some(
            (peer) =>
              peer.state === state &&
              (peer as { sendAttempt?: string }).sendAttempt === undefined,
          )
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
const releaseOutboxAborts = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { releaseOutboxAborts(): void }
    ).releaseOutboxAborts(),
  );

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
  await abortOutboxWrites(page, "refused", 1000);
  const item = await queueProfile(page);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => posts.length).toBe(1);
  await expect(
    page.getByText(/This browser still needs to save that answer\./),
  ).toBeVisible();
  await expect(page.getByText(/Next save attempt/)).toBeVisible();
  expect((await readOutbox(page))[0].peers.self.state).toBe("queued");
  refuse = false;
  await page.getByRole("button", { name: "Stop retrying" }).click();
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
  // Resume cannot take effect while the refusal is not saved.
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
  expect((await readOutbox(page))[0].stopped).toBe(true);
  expect(posts).toEqual([item.transport]);
  await releaseOutboxAborts(page);
  await page.getByRole("button", { name: "Resume" }).click();
  await expect
    .poll(async () => (await readOutbox(page))[0].peers.self.state)
    .toBe("accepted");
  expect(posts).toEqual([item.transport, item.transport]);
});

test("the outbox summary, rows and saved publication lines show a result that still needs saving", async ({
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
  await abortOutboxWrites(page, "accepted", 1000);
  await page.getByRole("button", { name: "Try now" }).click();
  await expect(
    page.getByText(
      "The server accepted this record. This browser still needs to save the receipt.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText(/could not save some delivery results yet/),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "This browser could not save a delivery result yet",
  );
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
    "The server accepted this record. This browser still needs to save the receipt.",
  );
  expect(lines.lines.join(" ")).not.toContain("will be sent again");

  // A stopped record keeps the pending answer and promises no lookup.
  await page.getByRole("button", { name: "Stop retrying" }).click();
  await expect(
    page.getByText(
      "The server accepted this record. This browser still needs to save the receipt. Automatic delivery is stopped.",
    ),
  ).toBeVisible();
  await expect(page.getByText(/will be sent again/)).toHaveCount(0);
  // Once storage works, the local write ends delivery without a request.
  await releaseOutboxAborts(page);
  await expect
    .poll(async () => (await readOutbox(page))[0].peers.self.state)
    .toBe("accepted");
  expect(posts).toEqual([]);
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

test("Try now after an unsaved refusal of a never sent record looks up the receipt first", async ({
  page,
}) => {
  await page.goto("/about");
  await expect(page.locator("main h1")).toBeAttached();
  const { posts, lookups } = deliveryRequests(page);
  await page.route("**/api/v1/receipts/*", async (route) => {
    const id = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/").at(-1)!,
    );
    await route.fulfill({
      json: {
        id,
        admission: "refused",
        interpretation: "effective",
        body_status: "present",
        body_hash: null,
        envelope_hash: null,
        cursor: "x.1",
        snapshot: null,
        view: "jve1:" + "a".repeat(64),
        reasons: ["test"],
      },
    });
  });
  // The browser reports offline, but the server answers.
  await page.evaluate(() => {
    let online = false;
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => online,
    });
    Object.assign(window, {
      setReportedOnline: (value: boolean) => {
        online = value;
      },
    });
  });
  const { item, result, failed } = await startEngine(page, {
    database: "unsaved-refusal-offline",
    fail: "refused",
    failures: 1,
  });
  expect(result).not.toBe("saved");
  expect(failed).toBe(1);
  expect(lookups).toEqual([item.id]);
  expect((await storedPeer(page, "unsaved-refusal-offline")).state).toBe(
    "queued",
  );
  await page.evaluate(async (id) => {
    const target = window as unknown as {
      setReportedOnline(value: boolean): void;
      unsavedEngine: { tryNow(id: string): Promise<unknown> };
    };
    target.setReportedOnline(true);
    await target.unsavedEngine.tryNow(id);
  }, item.id);
  expect(lookups).toEqual([item.id, item.id]);
  expect(posts).toEqual([]);
  expect((await storedPeer(page, "unsaved-refusal-offline")).state).toBe(
    "refused",
  );
});

test("Try now that decides nothing keeps an unsaved refusal", async ({
  page,
}) => {
  await page.goto("/about");
  await expect(page.locator("main h1")).toBeAttached();
  await freeze(page);
  const { posts, lookups } = deliveryRequests(page);
  await page.route("**/api/v1/events", (route) =>
    route.fulfill({
      status: 409,
      json: { code: "refused", message: "Refused.", event: null, field: null },
    }),
  );
  let offline = false;
  await page.route("**/api/v1/receipts/*", (route) =>
    offline
      ? route.abort("internetdisconnected")
      : route.fulfill({ status: 404, json: { message: "Not found" } }),
  );
  await page.evaluate(() => {
    let online = true;
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => online,
    });
    Object.assign(window, {
      setReportedOnline: (value: boolean) => {
        online = value;
        if (value) window.dispatchEvent(new Event("online"));
      },
    });
  });
  const { item, result, failed } = await startEngine(page, {
    database: "unsaved-refusal-try-offline",
    fail: "refused",
    failures: 1,
  });
  expect(result).not.toBe("saved");
  expect(failed).toBe(1);
  expect(posts).toEqual([item.transport]);
  // Try now while the browser reports offline. The lookup fails at the
  // network level, so the attempt decides nothing.
  offline = true;
  await page.evaluate(async (id) => {
    const target = window as unknown as {
      setReportedOnline(value: boolean): void;
      unsavedEngine: { tryNow(id: string): Promise<unknown> };
    };
    target.setReportedOnline(false);
    await target.unsavedEngine.tryNow(id);
  }, item.id);
  offline = false;
  await page.evaluate(() =>
    (
      window as unknown as { setReportedOnline(value: boolean): void }
    ).setReportedOnline(true),
  );
  await page.clock.fastForward(15_000);
  await expect
    .poll(
      async () => (await storedPeer(page, "unsaved-refusal-try-offline")).state,
    )
    .toBe("refused");
  expect(posts).toEqual([item.transport]);
  // Try now first saved the refusal locally. Its offline lookup learned
  // nothing, and a saved refusal has no automatic lookup.
  expect(lookups).toEqual([item.id]);
});

/**
 * Queues one record for the given recipients in its own database, POSTs it
 * through a page engine and aborts the acceptance writes of the recipients
 * in `failing` until `releaseOutboxAborts`.
 */
async function acceptedWithFailedWrites(
  page: Page,
  database: string,
  peers: string[],
  failing: string[],
) {
  return page.evaluate(
    async ({ corePath, database, peers, failing }) => {
      const core = await import(corePath);
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { DeliveryEngine } = await import(String("/src/data/delivery.ts"));
      const { outboxItem } = await import(String("/src/data/lifecycle.ts"));
      await core.initializeCore();
      const store = new LocalStore(database);
      const item: OutboxItem = outboxItem(
        core.createEvent(
          crypto.getRandomValues(new Uint8Array(32)),
          [],
          "1".repeat(32),
          { kind: "identity.profile" },
          { name: "Discard guard", bio: [], links: [] },
        ),
        "discard",
        0,
        Object.fromEntries(
          peers.map((peer) => [
            peer,
            { origin: location.origin, base: "/api/v1", label: peer },
          ]),
        ),
      );
      await store.queueGroup([item]);
      let released = false;
      Object.assign(window, {
        releaseOutboxAborts: () => {
          released = true;
        },
      });
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) {
        const request = put.call(this, value, key);
        if (
          !released &&
          this.name === "outbox" &&
          key === item.id &&
          failing.some(
            (peer) =>
              value.peers?.[peer]?.state === "accepted" &&
              value.peers?.[peer]?.sendAttempt === undefined,
          )
        )
          this.transaction.abort();
        return request;
      };
      const engine = new DeliveryEngine(store);
      Object.assign(window, { discardEngine: engine });
      await engine.tryNow(item.id).catch(() => {});
      await engine.stop(item.id);
      return item;
    },
    { corePath, database, peers, failing },
  );
}
const discardResult = (page: Page, id: string) =>
  page.evaluate(async (id) => {
    const engine = (
      window as unknown as {
        discardEngine: {
          discard(id: string): Promise<void>;
          view(item: unknown): { saving: boolean; accepted: boolean };
        };
      }
    ).discardEngine;
    try {
      await engine.discard(id);
      return "discarded";
    } catch (error) {
      return (error as Error).message;
    }
  }, id);

for (const [label, peers, failing] of [
  ["a pending acceptance", ["self"], ["self"]],
  ["saved and pending acceptances", ["self", "copy"], ["copy"]],
] as const)
  test(`Discard keeps a record with ${label}`, async ({ page }) => {
    await page.goto("/about");
    await expect(page.locator("main h1")).toBeAttached();
    const database = `discard-${peers.length}`;
    const item = await acceptedWithFailedWrites(
      page,
      database,
      [...peers],
      [...failing],
    );
    const [row] = await readOutbox(page, database);
    expect(row.stopped).toBe(true);
    // The pending write cannot commit yet, so Discard does not run.
    expect(await discardResult(page, item.id)).toMatch(/Discard did not run/);
    expect(await readOutbox(page, database)).toHaveLength(1);
    // Once it commits, the storage guard sees every acceptance.
    await releaseOutboxAborts(page);
    expect(await discardResult(page, item.id)).toMatch(
      /delivered to every recipient/,
    );
    const [kept] = await readOutbox(page, database);
    expect(kept.transport).toBe(item.transport);
    expect(Object.values(kept.peers).map((peer) => peer.state)).toEqual(
      peers.map(() => "accepted"),
    );
    expect(kept.stopped).toBe(true);
    const marker = await page.evaluate(
      async ({ database, id }) => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        return new LocalStore(database).get("keys", `discarded:${id}`);
      },
      { database, id: item.id },
    );
    expect(marker).toBeUndefined();
  });

test("Discard is offered for a stopped leaf only after its pending refusal commits", async ({
  page,
}) => {
  await page.goto("/outbox");
  await expect(page.getByText("No unfinished records.")).toBeVisible();
  await page.route("**/api/v1/events", (route) =>
    route.request().method() === "POST"
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
  await abortOutboxWrites(page, "refused", 1000);
  await queueProfile(page);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(
    page.getByText(/This browser still needs to save that answer\./),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop retrying" }).click();
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
  const discard = page.getByRole("button", { name: "Discard" });
  const saving = page.getByText(
    "This browser is still saving a delivery result. Discard is available after it is saved.",
  );
  const unavailable = page.getByText(/Local history is unavailable/);
  await expect(saving.or(unavailable)).toBeVisible();
  await expect(discard).toHaveCount(0);
  await releaseOutboxAborts(page);
  await expect
    .poll(async () => (await readOutbox(page))[0].peers.self.state)
    .toBe("refused");
  await expect(saving).toHaveCount(0);
  expect((await readOutbox(page))[0].stopped).toBe(true);
  if (await unavailable.isVisible()) return;
  page.on("dialog", (dialog) => void dialog.accept());
  await discard.click();
  await expect(page.getByRole("status")).toContainText("Discarded");
  expect(await readOutbox(page)).toHaveLength(0);
});

test("the stopped publication, an empty group and the handover headline read one summary", async ({
  page,
}) => {
  await page.goto("/about");
  await expect(page.locator("main h1")).toBeAttached();
  const database = "summary-text";
  const item = await acceptedWithFailedWrites(
    page,
    database,
    ["self"],
    ["self"],
  );
  const texts = await page.evaluate(
    async ({ database, id }) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { savedGroupState } = await import(
        String("/src/pages/wizard/publish.ts")
      );
      const { handoverStatusLine } = await import(
        String("/src/pages/handover.ts")
      );
      const engine = (window as unknown as { discardEngine: never })
        .discardEngine;
      const rows = (await new LocalStore(database).list(
        "outbox",
      )) as OutboxItem[];
      const row = rows.find((candidate) => candidate.id === id)!;
      const stopped = savedGroupState([row], engine);
      const empty = savedGroupState([], engine);
      const handover = handoverStatusLine(engine, {
        transfer: row,
        accept: row,
        transferDone: false,
        acceptDone: false,
      });
      const savedAndPending = handoverStatusLine(engine, {
        transfer: {
          ...row,
          id: "jve1:" + "c".repeat(64),
          peers: { self: { ...row.peers.self, state: "accepted" } },
        },
        accept: row,
        transferDone: true,
        acceptDone: false,
      });
      const pendingAccept = handoverStatusLine(engine, {
        transfer: row,
        accept: {
          ...row,
          id: "jve1:" + "d".repeat(64),
          peers: {
            self: {
              ...row.peers.self,
              state: "queued",
              sendAttempt: undefined,
              sendStarted: undefined,
            },
          },
        },
        transferDone: false,
        acceptDone: false,
      });
      return { stopped, empty, handover, savedAndPending, pendingAccept };
    },
    { database, id: item.id },
  );
  expect(texts.stopped.headline).toBe(
    "Saved. A delivery result still needs saving.",
  );
  expect(texts.stopped.lines.join(" ")).toContain(
    "The server accepted this record. This browser still needs to save the receipt. Automatic delivery is stopped.",
  );
  expect(texts.empty.headline).toBe("Saved. Delivery state unavailable.");
  expect(texts.empty.headline).not.toBe("Published.");
  expect(texts.handover).toBe(
    "Both events were accepted. This browser still needs to save a receipt.",
  );
  expect(texts.savedAndPending).toBe(
    "Both events were accepted. This browser still needs to save a receipt.",
  );
  expect(texts.pendingAccept).toBe(
    "Old key retired locally. Transfer accepted, saving the receipt, acceptance waiting.",
  );
});
