import { test, expect } from "@playwright/test";
import { acceptFirstSignature, createIdentity, openWord } from "./helpers.ts";

test("a first online send stays out of Not delivered until its outcome fails", async ({
  page,
}) => {
  await createIdentity(page);
  await openWord(page, "cukta");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/v1/events", async (route) => {
    started();
    await held;
    await route.abort("failed");
  });
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await acceptFirstSignature(page);
  await requested;
  await expect(page.getByRole("link", { name: /not delivered/ })).toBeHidden();
  // Navigate within the app while the request waits. The stored queued row is also hidden.
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.evaluate(async () => {
    const { navigate } = await import(String("/src/app/router.ts"));
    navigate("/outbox");
  });
  await expect(page.getByText("No unfinished records.")).toBeVisible();
  release();
  await expect(
    page.getByRole("link", { name: "1 not delivered" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Try now" })).toBeVisible();
});

test("outbox updates keep keyboard focus and the retained disclosure open", async ({
  page,
}) => {
  await page.goto("/outbox");
  await expect(page.locator("main h1")).toBeAttached();
  await expect(page.locator("main h1")).toHaveText("Not delivered");
  await page.evaluate(async () => {
    const { outboxPage } = await import(String("/src/pages/outbox.ts"));
    const { freshPeer } = await import(String("/src/data/delivery.ts"));
    const main = document.querySelector("main")!;
    main.replaceChildren();
    let listener: (items: any[]) => void;
    const make = (id: string, stopped: boolean) => ({
      id,
      group: id,
      order: 0,
      identity: "test",
      transport: JSON.stringify({
        envelope: { id, header: { issuer: "test", previous: [] } },
      }),
      signedAt: Date.now(),
      stopped,
      label: { subject: id, action: "judgment", href: "/" },
      peers: {
        self: {
          ...freshPeer(),
          state: "refused",
          failure: "refused",
          nextAttempt: null,
        },
      },
    });
    const accepted = make("accepted", false);
    accepted.peers.self.state = "accepted";
    const items = [make("active", false), make("stopped", true), accepted];
    const update = () => listener(items);
    const app = {
      session: { storageAvailable: true },
      store: { list: async () => [] },
      announce() {},
      delivery: {
        subscribe(fn: typeof listener) {
          listener = fn;
          update();
          return () => {};
        },
        async tryNow() {
          update();
          return items[0];
        },
        async resume(id: string) {
          items.find((item) => item.id === id)!.stopped = false;
          update();
        },
      },
    };
    await outboxPage(
      {} as any,
      {
        main,
        title() {},
        live: () => true,
        signal: new AbortController().signal,
      } as any,
      app as any,
    );
    (window as any).updateOutbox = update;
  });
  const details = page.locator("main details");
  await details.locator("summary").click();
  const retry = page.getByRole("button", { name: "Try now" });
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(retry).toBeFocused();
  await expect(details).toHaveAttribute("open", "");
  const resume = page.getByRole("button", { name: "Resume" });
  await resume.focus();
  await page.evaluate(() => (window as any).updateOutbox());
  await expect(resume).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(details).toHaveAttribute("open", "");
  await expect(
    page.getByRole("button", { name: "Try now" }).nth(1),
  ).toBeFocused();
});

test("offline delivery waits without polling and resumes on connectivity return", async ({
  page,
}) => {
  await page.goto("/outbox");
  await expect(page.locator("main h1")).toBeAttached();
  const result = await page.evaluate(async () => {
    const { DeliveryEngine, freshPeer, isNotDelivered } = await import(
      String("/src/data/delivery.ts")
    );
    const item = {
      id: "test",
      group: "test",
      order: 0,
      stopped: false,
      peers: { mirror: freshPeer() },
    };
    let reads = 0;
    let sends = 0;
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    const engine = new DeliveryEngine({
      list: async () => {
        reads++;
        return [item];
      },
    } as any);
    (engine as any).deliver = async () => {
      sends++;
      item.peers.mirror.state = "accepted" as any;
    };
    engine.start();
    // Every old polling interval must stay absent while offline.
    await new Promise((resolve) => setTimeout(resolve, 850));
    const offlineReads = reads;
    const visibleOffline = isNotDelivered(item);
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });
    window.dispatchEvent(new Event("online"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      offlineReads,
      visibleOffline,
      sends,
      visibleOnline: isNotDelivered(item),
    };
  });
  expect(result).toEqual({
    offlineReads: 0,
    visibleOffline: true,
    sends: 1,
    visibleOnline: false,
  });
});

test("offline rows and missing-body introductions describe the actual wait", async ({
  page,
}) => {
  await page.goto("/outbox");
  await expect(page.locator("main h1")).toBeAttached();
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { freshPeer } = await import(String("/src/data/delivery.ts"));
    await new LocalStore().put("outbox", "test", {
      id: "test",
      group: "test",
      order: 0,
      stopped: false,
      signedAt: Date.now(),
      label: { subject: "test", action: "judgment", href: "/" },
      transport: "{}",
      peers: {
        mirror: {
          ...freshPeer(),
          state: "missing-body",
          nextAttempt: Date.now() + 60000,
        },
      },
    });
  });
  await page.reload();
  await expect(page.locator("main > p").first()).toContainText(
    "stored a signed header without its required body",
  );
  await expect(page.locator("main > p").first()).toContainText(
    "while the app is open",
  );
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    window.dispatchEvent(new Event("offline"));
  });
  await expect(
    page.getByText("Waiting for a connection.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("main")).not.toContainText("Next try");
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    await store.mergeOutbox("test", (item: any) => ({
      ...item,
      peers: {
        mirror: {
          ...item.peers.mirror,
          state: "queued",
          failure: "unresolved",
          nextAttempt: null,
          error: "The recipient has no saved address.",
        },
      },
    }));
    window.dispatchEvent(new Event("offline"));
  });
  await expect(page.locator("main > p").first()).toContainText(
    "no saved recipient address",
  );
  await expect(page.locator("main")).toContainText(
    "The recipient has no saved address.",
  );
  await expect(page.locator("main")).not.toContainText(
    "Waiting for a connection.",
  );
});

test("first-delivery status covers all records and all selected peers", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("main h1")).toBeAttached();
  const result = await page.evaluate(async () => {
    const { deliveryAccepted } = await import(String("/src/data/delivery.ts"));
    const { publicTrustOutcome, publicClearOutcome } = await import(
      String("/src/components/trustpanel.ts")
    );
    const accepted = { peers: { mirror: { state: "accepted" } } };
    const partial = {
      peers: { self: { state: "accepted" }, mirror: { state: "refused" } },
    };
    return {
      accepted: deliveryAccepted([accepted]),
      partial: deliveryAccepted([partial]),
      group: deliveryAccepted([accepted, partial]),
      empty: deliveryAccepted([]),
      noPeers: deliveryAccepted([{ peers: {} }]),
      trust: publicTrustOutcome([accepted]),
      clear: publicClearOutcome([partial]),
    };
  });
  expect(result.accepted).toBe(true);
  expect([result.partial, result.group, result.empty, result.noPeers]).toEqual([
    false,
    false,
    false,
    false,
  ]);
  expect(result.trust).toContain("Others can build on it");
  expect(result.clear).toContain("Delivery is not finished");
});

test("judgment announcements use every selected peer for arrows and Clear", async ({
  page,
}) => {
  await page.goto("/about");
  await expect(page.locator("main h1")).toBeAttached();
  await expect(page.locator("main")).toBeVisible();
  await page.evaluate(async () => {
    const { judgmentControl, scoreDetails } = await import(
      String("/src/components/judgment.ts")
    );
    const app = {
      session: {
        identity: "me",
        storageAvailable: true,
        requireUnlocked: async (_: string, action: () => Promise<void>) =>
          action(),
        firstSignatureDisclosure: async () => true,
      },
      own: {
        registers: async () => ({
          complete: true,
          judgments: new Map([
            [
              "test",
              { known: true, conflicted: false, value: "bless", events: [] },
            ],
          ]),
        }),
        subscribe: () => () => {},
        invalidate() {},
      },
      offlineSigning: { value: false },
      delivery: { items: async () => [] },
      signer: { publish: async () => (window as any).outcome },
      announce: (message: string) => {
        document.querySelector("[role=status]")!.textContent = message;
      },
    };
    const target = { id: "test", word: null, describe: () => "test" };
    document
      .querySelector("main")!
      .replaceChildren(
        judgmentControl(app as any, target, { score: null, unavailable: true }),
        scoreDetails(app as any, target, { score: null, unavailable: true }),
      );
    (window as any).outcome = [{ peers: { mirror: { state: "accepted" } } }];
  });
  // Oppose starts a new judgment. The configured recipient has no special ID.
  await page.getByRole("button", { name: "Oppose", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Your opposition is published.",
  );
  await page.evaluate(() => {
    (window as any).outcome = [
      { peers: { self: { state: "accepted" }, mirror: { state: "refused" } } },
    ];
  });
  await page.getByRole("button", { name: "Oppose", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "Delivery is not finished",
  );
  await page.locator("details summary").click();
  await page.getByRole("button", { name: "Clear my judgment" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Delivery is not finished",
  );
});

test("stopping during a held first send keeps the stop while a late acceptance clears the row", async ({
  page,
}) => {
  await createIdentity(page);
  await openWord(page, "cukta");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let admitted!: () => void;
  const accepted = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  await page.route("**/api/v1/events", async (route) => {
    const response = await route.fetch();
    admitted();
    await held;
    await route.fulfill({ response });
  });
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse", exact: true })
    .click();
  await acceptFirstSignature(page);
  await accepted;
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const items = await store.list("outbox");
    await store.mergeOutbox(items[0].id, (item: any) => ({
      ...item,
      stopped: true,
    }));
    window.dispatchEvent(new Event("online"));
    const { navigate } = await import(String("/src/app/router.ts"));
    navigate("/outbox");
  });
  try {
    await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "1 not delivered" }),
    ).toBeVisible();
  } finally {
    release();
  }
  await expect(page.getByText("No unfinished records.")).toBeVisible();
  await expect(page.getByRole("link", { name: /not delivered/ })).toBeHidden();
  const stored = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const items = await new LocalStore().list("outbox");
    return { stopped: items[0].stopped, state: items[0].peers.self.state };
  });
  expect(stored).toEqual({ stopped: true, state: "accepted" });
});
