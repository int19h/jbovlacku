import { expect, test } from "@playwright/test";
import type { OutboxItem } from "../src/data/store.ts";
import { corePath } from "./helpers.ts";

for (const explicit of [false, true]) {
  test(`a failed receipt write retries after ${explicit ? "Try now" : "automatic delivery"}`, async ({
    page,
  }) => {
    await page.goto("/about");
    await expect(page.locator("main h1")).toBeAttached();
    const now = Date.now();
    await page.clock.install({ time: now });
    await page.clock.pauseAt(now + 1000);
    const posts: string[] = [];
    const lookups: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST" && path === "/api/v1/events")
        posts.push(request.postData()!);
      if (request.method() === "GET" && path.startsWith("/api/v1/receipts/"))
        lookups.push(
          decodeURIComponent(path.slice("/api/v1/receipts/".length)),
        );
    });
    const before = await page.evaluate(
      async ({ corePath, explicit }) => {
        const core = await import(corePath);
        const { LocalStore } = await import(String("/src/data/store.ts"));
        const { DeliveryEngine } = await import(
          String("/src/data/delivery.ts")
        );
        const { outboxItem } = await import(String("/src/data/lifecycle.ts"));
        await core.initializeCore();
        const store = new LocalStore("receipt-retry");
        const transport = core.createEvent(
          crypto.getRandomValues(new Uint8Array(32)),
          [],
          "1".repeat(32),
          { kind: "identity.profile" },
          { name: "Receipt retry", bio: [], links: [] },
        );
        const item: OutboxItem = outboxItem(transport, "test", 0, {
          self: {
            origin: location.origin,
            base: "/api/v1",
            label: "This server",
          },
        });
        await store.queueGroup([item]);
        let failedWrites = 0;
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (value, key) {
          const request = put.call(this, value, key);
          if (
            this.name === "outbox" &&
            key === item.id &&
            value.peers?.self?.state === "accepted" &&
            failedWrites === 0
          ) {
            failedWrites++;
            this.transaction.abort();
          }
          return request;
        };
        try {
          const engine = new DeliveryEngine(store);
          await (explicit ? engine.tryNow(item.id) : engine.tick()).catch(
            () => {},
          );
          return {
            saved: (await store.get("outbox", item.id)) as OutboxItem,
            failedWrites,
          };
        } finally {
          IDBObjectStore.prototype.put = put;
        }
      },
      { corePath, explicit },
    );
    expect(before.failedWrites).toBe(1);
    expect(before.saved.peers.self).toMatchObject({
      state: "queued",
      receipt: null,
    });
    expect(before.saved.peers.self.sendStarted).toEqual(expect.any(Number));
    expect(before.saved.peers.self.sendAttempt).toEqual(expect.any(String));
    expect(posts).toEqual([before.saved.transport]);
    expect(lookups).toEqual([]);

    await page.clock.fastForward(15_000);
    const read = () =>
      page.evaluate(async (): Promise<OutboxItem[]> => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        return new LocalStore("receipt-retry").list("outbox");
      });
    await expect
      .poll(async () => (await read())[0]?.peers.self.state)
      .toBe("accepted");
    expect(posts).toEqual([before.saved.transport]);
    expect(lookups).toEqual([before.saved.id]);
    const after = await read();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      id: before.saved.id,
      transport: before.saved.transport,
      peers: { self: { nextAttempt: null, receipt: { id: before.saved.id } } },
    });
  });
}
