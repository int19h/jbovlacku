import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import {
  acceptFirstSignature,
  createIdentity,
  openWord,
  PASSPHRASE,
} from "./helpers.ts";

async function outboxItems(page: Page) {
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().list("outbox");
  });
}

async function statesOf(page: Page, ids: string[]) {
  const items = await outboxItems(page);
  return ids.map(
    (id) => items.find((item: any) => item.id === id)?.peers.self.state,
  );
}

const endorsedArticle = (page: Page) =>
  page.locator('article.definition:has(button[aria-pressed="true"])');

/** Signs and clears one online endorsement, so this browser holds own history. */
async function establishHistory(page: Page) {
  await openWord(page, "cukta");
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toContainText(
    "Your endorsement is published.",
  );
  await expect(endorsedArticle(page)).toHaveCount(1, {
    timeout: 30000,
  });
  await endorsedArticle(page).getByRole("button", { name: "Endorse" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Your judgment is cleared.",
  );
  await expect
    .poll(
      async () =>
        (await outboxItems(page))
          .map(
            (item: any) =>
              `${JSON.parse(item.transport).envelope.header.action.value}:${item.peers.self.state}`,
          )
          .sort(),
      { timeout: 30000 },
    )
    .toEqual(["bless:accepted", "clear:accepted"]);
  const clear = (await outboxItems(page)).find(
    (item: any) =>
      JSON.parse(item.transport).envelope.header.action.value === "clear",
  );
  return clear.id as string;
}

/** Clears every current endorsement after a full reload, through the unlock dialog. */
async function clearAfterReload(page: Page, clears: number) {
  const acceptedClears = async () =>
    (await outboxItems(page)).filter(
      (item: any) =>
        JSON.parse(item.transport).envelope.header.action.value === "clear" &&
        item.peers.self.state === "accepted",
    ).length;
  await page.goto("/word/cukta");
  await expect
    .poll(async () => endorsedArticle(page).count(), { timeout: 30000 })
    .toBeGreaterThan(0);
  // A test can leave more than one definition of the word endorsed. Clear
  // each pressed article until the expected clear records are accepted.
  while ((await acceptedClears()) < clears) {
    const before = await acceptedClears();
    await endorsedArticle(page)
      .first()
      .getByRole("button", { name: "Endorse" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Unlock your key" });
    if (await dialog.isVisible().catch(() => false)) {
      await dialog.getByLabel("Passphrase").fill(PASSPHRASE);
      await dialog.getByRole("button", { name: "Unlock" }).click();
    }
    await expect
      .poll(acceptedClears, { timeout: 30000 })
      .toBeGreaterThan(before);
  }
}

/** Drives the wizard to a reviewed publish page for a new gismu. */
async function toPublish(page: Page, spelling: string) {
  const meaning = `A disposable offline test meaning. ${randomUUID()}`;
  await page.getByRole("link", { name: "Add a word" }).click();
  await expect(page).toHaveTitle("Add a word: Meaning · jbovlacku");
  await page.getByRole("textbox", { name: "Meaning" }).fill(meaning);
  await page.getByRole("button", { name: "New word" }).click();
  await page.getByRole("radio", { name: /^gismu/ }).check();
  await page.getByRole("button", { name: "Make a gismu" }).click();
  await page.getByRole("link", { name: "Enter without generation" }).click();
  await page.getByLabel("Spelling").fill(spelling);
  await page.getByRole("button", { name: `Use ${spelling}` }).click();
  await expect(page.getByRole("heading", { name: spelling })).toBeVisible();
  await page.getByLabel("Read circled numbers as place references").uncheck();
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.getByRole("heading", { name: "Publish as" })).toBeVisible();
  return meaning;
}

async function publishOffline(page: Page) {
  const before = new Set((await outboxItems(page)).map((item: any) => item.id));
  await page.context().setOffline(true);
  await page.locator("aside").getByRole("button", { name: "Publish" }).click();
  const saved = page.getByRole("region", { name: "Saved publication" });
  await expect(saved).toContainText("Saved. Not delivered yet.");
  await expect(saved).toContainText(
    "This is a local preview of your signed record.",
  );
  await expect(
    page.getByRole("link", { name: "2 not delivered" }),
  ).toBeVisible();
  const items = (await outboxItems(page)).filter(
    (item: any) => !before.has(item.id),
  );
  expect(items).toHaveLength(2);
  expect(items.map((item: any) => item.peers.self.state).sort()).toEqual([
    "queued",
    "queued",
  ]);
  expect(items.map((item: any) => item.peers.self.attempts)).toEqual([0, 0]);
  return items;
}

test("offline publish saves the signed group and shows Not delivered", async ({
  page,
}) => {
  await createIdentity(page);
  const clearId = await establishHistory(page);
  await toPublish(page, "brodu");
  const group = await publishOffline(page);
  const byOrder = [...group].sort((a: any, b: any) => a.order - b.order);
  expect(JSON.parse(byOrder[0].transport).envelope.header.previous).toEqual([
    clearId,
  ]);
  expect(JSON.parse(byOrder[1].transport).envelope.header.previous).toEqual([
    byOrder[0].id,
  ]);
  await page.getByRole("link", { name: "2 not delivered" }).click();
  await expect(page).toHaveTitle("Not delivered · jbovlacku");
  await expect(page.getByText("No unfinished records.")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "2 not delivered" }),
  ).toBeVisible();
  await page.context().setOffline(false);
});

test("offline publish delivers when the network returns", async ({ page }) => {
  await createIdentity(page);
  await establishHistory(page);
  await toPublish(page, "brode");
  const items = await publishOffline(page);
  const ids = items.map((item: any) => item.id);
  await page.context().setOffline(false);
  await expect
    .poll(() => statesOf(page, ids), { timeout: 30000 })
    .toEqual(["accepted", "accepted"]);
  const after = (await outboxItems(page)).filter((item: any) =>
    ids.includes(item.id),
  );
  expect(after.map((item: any) => item.id).sort()).toEqual(
    items.map((item: any) => item.id).sort(),
  );
  expect(after.map((item: any) => item.transport).sort()).toEqual(
    items.map((item: any) => item.transport).sort(),
  );
  await expect(page.getByRole("link", { name: /not delivered/ })).toBeHidden();
});

test("offline publish survives a reload before the network returns", async ({
  page,
}) => {
  await createIdentity(page);
  await establishHistory(page);
  await toPublish(page, "brodi");
  const items = await publishOffline(page);
  // The app reloads while the API is still unreachable.
  await page.context().setOffline(false);
  await page.route("**/api/v1/**", (route) => route.abort("failed"));
  await page.reload();
  await page.goto("/outbox");
  await expect(page).toHaveTitle("Not delivered · jbovlacku");
  await expect(page.getByText("No unfinished records.")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "2 not delivered" }),
  ).toBeVisible();
  const ids = items.map((item: any) => item.id);
  const kept = (await outboxItems(page)).filter((item: any) =>
    ids.includes(item.id),
  );
  expect(kept.map((item: any) => item.id).sort()).toEqual([...ids].sort());
  expect(kept.map((item: any) => item.transport).sort()).toEqual(
    items.map((item: any) => item.transport).sort(),
  );
  await page.unroute("**/api/v1/**");
  await page.getByRole("button", { name: "Try now" }).first().click();
  await expect
    .poll(() => statesOf(page, ids), { timeout: 30000 })
    .toEqual(["accepted", "accepted"]);
});

test("offline endorsement saves the signed record and delivers on return", async ({
  page,
}) => {
  await createIdentity(page);
  await establishHistory(page);
  const endorse = page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" });
  const before = new Set((await outboxItems(page)).map((item: any) => item.id));
  await page.context().setOffline(true);
  await endorse.click();
  await expect(page.getByRole("status")).toContainText(
    "Your judgment is signed and saved here. Delivery is not finished.",
  );
  await expect(
    page.getByRole("link", { name: "1 not delivered" }),
  ).toBeVisible();
  const items = (await outboxItems(page)).filter(
    (item: any) => !before.has(item.id),
  );
  expect(items).toHaveLength(1);
  expect(items[0].peers.self.state).toBe("queued");
  await page.context().setOffline(false);
  await expect
    .poll(() => statesOf(page, [items[0].id]), { timeout: 30000 })
    .toEqual(["accepted"]);
  await expect(page.getByRole("link", { name: /not delivered/ })).toBeHidden();
  // Clear the endorsement so this test leaves the shared word unchanged.
  await clearAfterReload(page, 2);
});

test("Try now while offline keeps a refused record refused", async ({
  page,
}) => {
  await createIdentity(page);
  await openWord(page, "cukta");
  await page.route("**/api/v1/events", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({ message: "Probe refusal.", code: "probe" }),
        })
      : route.continue(),
  );
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await acceptFirstSignature(page);
  const peerOf = async () => (await outboxItems(page))[0]?.peers.self;
  await expect.poll(async () => (await peerOf())?.state).toBe("refused");
  const refused = await peerOf();
  expect(refused.failure).toBe("refused");
  expect(refused.nextAttempt).toBeNull();
  await page.unroute("**/api/v1/events");
  await page.getByRole("link", { name: "1 not delivered" }).click();
  await expect(page).toHaveTitle("Not delivered · jbovlacku");
  await page.context().setOffline(true);
  await page.getByRole("button", { name: "Try now" }).first().click();
  await page.waitForTimeout(1000);
  const afterOffline = await peerOf();
  expect(afterOffline.state).toBe("refused");
  expect(afterOffline.failure).toBe("refused");
  expect(afterOffline.attempts).toBe(refused.attempts);
  expect(afterOffline.nextAttempt).toBeNull();
  await expect(page.locator("main")).toContainText(
    "Retries are paused until you try again.",
  );
  await page.context().setOffline(false);
  await page.waitForTimeout(3000);
  expect((await peerOf()).state).toBe("refused");
  await page.getByRole("button", { name: "Try now" }).first().click();
  await expect
    .poll(async () => (await peerOf())?.state, { timeout: 30000 })
    .toBe("accepted");
  await clearAfterReload(page, 1);
});

test("a key with no history in this browser does not sign while unreachable", async ({
  page,
}) => {
  await createIdentity(page);
  await openWord(page, "cukta");
  await page.context().setOffline(true);
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toContainText(
    "Publishing needs a connection the first time this key publishes in this browser.",
  );
  expect(await outboxItems(page)).toHaveLength(0);
  await expect(page.getByRole("link", { name: /not delivered/ })).toBeHidden();
  await page.context().setOffline(false);
});

test("Resume while offline resumes a stopped record and it delivers when the network returns", async ({
  page,
}) => {
  await createIdentity(page);
  await openWord(page, "cukta");
  await page.route("**/api/v1/events", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "Probe unavailable." }),
        })
      : route.continue(),
  );
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await acceptFirstSignature(page);
  const itemOf = async () => (await outboxItems(page))[0];
  await expect
    .poll(async () => (await itemOf())?.peers.self.state, {
      timeout: 30000,
    })
    .toBe("unknown");
  await page.unroute("**/api/v1/events");
  await page.getByRole("link", { name: "1 not delivered" }).click();
  await expect(page).toHaveTitle("Not delivered · jbovlacku");
  await page.getByRole("button", { name: "Stop retrying" }).click();
  await expect
    .poll(async () => (await itemOf())?.stopped, { timeout: 30000 })
    .toBe(true);
  await page.context().setOffline(true);
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "Delivery resumed with the same signed bytes and recipients.",
  );
  // The resume took effect while offline: the stop is cleared and an
  // attempt is scheduled, even though nothing was sent yet.
  await expect
    .poll(async () => (await itemOf())?.stopped, { timeout: 30000 })
    .toBe(false);
  await page.context().setOffline(false);
  await expect
    .poll(async () => (await itemOf())?.peers.self.state, {
      timeout: 30000,
    })
    .toBe("accepted");
  await clearAfterReload(page, 1);
});

test("an empty offline parent list refuses to sign even with local records", async ({
  page,
}) => {
  const identity = (await createIdentity(page)).identity as string;
  await establishHistory(page);
  // Remove only the remembered heads. The signed records stay in the
  // outbox, so a source check passes, but no parent list can be computed.
  await page.evaluate(async (id) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().delete("heads", id);
  }, identity);
  const before = (await outboxItems(page)).length;
  await page.context().setOffline(true);
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Publishing needs a connection the first time this key publishes in this browser.",
  );
  expect((await outboxItems(page)).length).toBe(before);
  await page.context().setOffline(false);
});

test("a 503 history read signs from the history saved in this browser", async ({
  page,
}) => {
  // This test signs and delivers four records in sequence.
  test.setTimeout(300000);
  await createIdentity(page);
  const clearId = await establishHistory(page);
  const before = new Set((await outboxItems(page)).map((item: any) => item.id));
  const unavailable = () =>
    page.route("**/api/v1/**", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "Probe unavailable." }),
      }),
    );
  await unavailable();
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await expect
    .poll(async () => (await outboxItems(page)).length, { timeout: 30000 })
    .toBe(before.size + 1);
  const items = (await outboxItems(page)).filter(
    (item: any) => !before.has(item.id),
  );
  expect(items).toHaveLength(1);
  expect(JSON.parse(items[0].transport).envelope.header.action.value).toBe(
    "bless",
  );
  // The fallback record names the accepted clear as its only parent.
  expect(JSON.parse(items[0].transport).envelope.header.previous).toEqual([
    clearId,
  ]);
  await page.unroute("**/api/v1/**");
  await page.goto("/outbox");
  await page.getByRole("button", { name: "Try now" }).first().click();
  await expect
    .poll(() => statesOf(page, [items[0].id]), { timeout: 30000 })
    .toEqual(["accepted"]);
  // A second fallback record names the first fallback record as its parent.
  // Any judgment signed now has that parent, so the first article is enough.
  await openWord(page, "cukta");
  // The definitions must load before every API read answers 503.
  await expect(page.locator("article.definition").first()).toBeVisible({
    timeout: 30000,
  });
  await unavailable();
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  // The outbox visit reloaded the app and locked the key.
  const dialog = page.getByRole("dialog", { name: "Unlock your key" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Passphrase").fill(PASSPHRASE);
  await dialog.getByRole("button", { name: "Unlock" }).click();
  await expect
    .poll(
      async () =>
        (await outboxItems(page)).filter(
          (item: any) => !before.has(item.id) && item.id !== items[0].id,
        ).length,
      { timeout: 30000 },
    )
    .toBe(1);
  const second = (await outboxItems(page)).find(
    (item: any) => !before.has(item.id) && item.id !== items[0].id,
  );
  expect(JSON.parse(second.transport).envelope.header.action.kind).toBe(
    "judgment.set",
  );
  expect(JSON.parse(second.transport).envelope.header.previous).toEqual([
    items[0].id,
  ]);
  await page.unroute("**/api/v1/**");
  await page.goto("/outbox");
  await page.getByRole("button", { name: "Try now" }).first().click();
  await expect
    .poll(() => statesOf(page, [second.id]), { timeout: 30000 })
    .toEqual(["accepted"]);
  // Leave the shared word without a live endorsement from this test.
  if (JSON.parse(second.transport).envelope.header.action.value === "bless") {
    const sameTarget =
      JSON.parse(second.transport).envelope.header.action.target ===
      JSON.parse(items[0].transport).envelope.header.action.target;
    await clearAfterReload(page, sameTarget ? 2 : 3);
  }
});

test("a record is delivered while the browser reports offline but the server answers", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "onLine", {
      configurable: true,
      get: () => false,
    });
  });
  await createIdentity(page);
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  await openWord(page, "cukta");
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toContainText(
    "Your endorsement is published.",
  );
  const items = await outboxItems(page);
  expect(items).toHaveLength(1);
  expect(items[0].peers.self.state).toBe("accepted");
  expect(items[0].peers.self.attempts).toBe(1);
  await clearAfterReload(page, 1);
});

/** Records the order of event POSTs and receipt lookups that the page sends. */
function deliveryRequests(page: Page) {
  const log: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (request.method() === "POST" && /\/api\/v1\/events$/.test(url))
      log.push("POST");
    if (request.method() === "GET" && url.includes("/api/v1/receipts/"))
      log.push("receipt");
  });
  return log;
}

test("a POST that reached the server and timed out while the browser reports offline is unknown", async ({
  page,
}) => {
  // The client waits 20 seconds for an answer before it gives up.
  test.setTimeout(180000);
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "onLine", {
      configurable: true,
      get: () => false,
    });
  });
  const log = deliveryRequests(page);
  await createIdentity(page);
  await openWord(page, "cukta");
  let answered = 0;
  await page.route("**/api/v1/events", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    // The server stores the record and answers. The answer arrives only
    // after the client stopped waiting.
    const response = await route.fetch();
    answered = response.status();
    await new Promise((resolve) => setTimeout(resolve, 25000));
    await route.fulfill({ response }).catch(() => {});
  });
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await acceptFirstSignature(page);
  const peerOf = async () => (await outboxItems(page))[0]?.peers.self;
  // The outcome is unknown from the start of the POST. The timeout then
  // records its own failure.
  await expect
    .poll(async () => (await peerOf())?.failure, { timeout: 40000 })
    .toBe("timeout");
  expect(answered).toBe(201);
  const timedOut = await peerOf();
  expect(timedOut.state).toBe("unknown");
  expect(timedOut.failure).toBe("timeout");
  expect(timedOut.attempts).toBe(1);
  expect(timedOut.lastAttempt).not.toBeNull();
  expect(log.filter((entry) => entry === "POST")).toHaveLength(1);
  await page.unroute("**/api/v1/events");
  await page.getByRole("link", { name: "1 not delivered" }).click();
  await expect(page).toHaveTitle("Not delivered · jbovlacku");
  await expect(page.locator("main")).toContainText(
    "The server did not answer.",
  );
  await expect(page.locator("main")).not.toContainText(
    "Waiting for a connection.",
  );
  log.length = 0;
  await page.getByRole("button", { name: "Try now" }).first().click();
  await expect
    .poll(async () => (await peerOf())?.state, { timeout: 30000 })
    .toBe("accepted");
  // The receipt shows that the server holds the record, so no second POST.
  expect(log[0]).toBe("receipt");
  expect(log).not.toContain("POST");
  await clearAfterReload(page, 1);
});

test("a connection that drops after the server took the POST makes delivery unknown", async ({
  page,
}) => {
  test.setTimeout(120000);
  const log = deliveryRequests(page);
  await createIdentity(page);
  await openWord(page, "cukta");
  let answered = 0;
  await page.route("**/api/v1/events", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    // The server stores the record and answers. Then the connection drops
    // before the answer reaches the page.
    const response = await route.fetch();
    answered = response.status();
    await page.context().setOffline(true);
    await route.abort("internetdisconnected");
  });
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await acceptFirstSignature(page);
  const peerOf = async () => (await outboxItems(page))[0]?.peers.self;
  await expect
    .poll(async () => (await peerOf())?.failure, { timeout: 30000 })
    .toBe("offline");
  expect(answered).toBe(201);
  const dropped = await peerOf();
  expect(dropped.state).toBe("unknown");
  expect(dropped.failure).toBe("offline");
  expect(dropped.attempts).toBe(1);
  expect(dropped.lastAttempt).not.toBeNull();
  expect(log.filter((entry) => entry === "POST")).toHaveLength(1);
  await page.unroute("**/api/v1/events");
  await page.getByRole("link", { name: "1 not delivered" }).click();
  await expect(page).toHaveTitle("Not delivered · jbovlacku");
  await expect(page.locator("main")).toContainText(
    "Some delivery outcomes are unknown.",
  );
  await page.context().setOffline(false);
  log.length = 0;
  await page.getByRole("button", { name: "Try now" }).first().click();
  await expect
    .poll(async () => (await peerOf())?.state, { timeout: 30000 })
    .toBe("accepted");
  // The receipt shows that the server holds the record, so no second POST.
  expect(log[0]).toBe("receipt");
  expect(log).not.toContain("POST");
  await clearAfterReload(page, 1);
});

test("Resume while offline keeps a header-only outcome and retries a refused record", async ({
  page,
}) => {
  await page.goto("/outbox");
  await expect(page.locator("main h1")).toBeAttached();
  await page.context().setOffline(true);
  const result = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { DeliveryEngine, describePeer } = await import(
      String("/src/data/delivery.ts")
    );
    const store = new LocalStore();
    const record = (id: string, peer: object) => ({
      id,
      identity: "test",
      transport: "{}",
      recipients: {
        self: { origin: location.origin, base: "/api/v1", label: "this site" },
      },
      group: id,
      order: 0,
      stopped: true,
      signedAt: Date.now(),
      label: { subject: "test", action: "judgment", href: "/" },
      peers: {
        self: {
          attempts: 1,
          lastAttempt: Date.now() - 60000,
          nextAttempt: null,
          receipt: null,
          ...peer,
        },
      },
    });
    await store.put(
      "outbox",
      "header-only",
      record("header-only", {
        state: "missing-body",
        error: "The server has the header without its body.",
        failure: "server",
      }),
    );
    await store.put(
      "outbox",
      "refused",
      record("refused", {
        state: "refused",
        error: "Probe refusal. (probe)",
        failure: "refused",
      }),
    );
    const engine = new DeliveryEngine(store);
    const before = Date.now();
    await engine.resume("header-only");
    await engine.resume("refused");
    const peerOf = async (id: string) =>
      (await store.get("outbox", id)).peers.self;
    const headerOnly = await peerOf("header-only");
    const refused = await peerOf("refused");
    const stopped = [
      (await store.get("outbox", "header-only")).stopped,
      (await store.get("outbox", "refused")).stopped,
    ];
    await store.delete("outbox", "header-only");
    await store.delete("outbox", "refused");
    return {
      headerOnly: {
        state: headerOnly.state,
        attempts: headerOnly.attempts,
        scheduled: headerOnly.nextAttempt >= before,
        text: describePeer(headerOnly),
      },
      refused: {
        state: refused.state,
        failure: refused.failure,
        attempts: refused.attempts,
        scheduled: refused.nextAttempt >= before,
        text: describePeer(refused),
      },
      stopped,
    };
  });
  await page.context().setOffline(false);
  expect(result).toEqual({
    headerOnly: {
      state: "missing-body",
      attempts: 1,
      scheduled: true,
      text: "The server has the header without its body.",
    },
    refused: {
      state: "unknown",
      failure: null,
      attempts: 1,
      scheduled: true,
      text: "A server refused this record before. Resume retries it. The client asks whether the record arrived before it sends the same bytes again.",
    },
    stopped: [false, false],
  });
});

test("a denied receipt lookup while the browser reports offline does not refuse an unsent record", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "onLine", {
      configurable: true,
      get: () => false,
    });
  });
  const log = deliveryRequests(page);
  await createIdentity(page);
  await openWord(page, "cukta");
  await page.route("**/api/v1/receipts/*", (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ message: "Receipt lookup denied." }),
    }),
  );
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await acceptFirstSignature(page);
  // The lookup only checks the connection for a record that was never sent.
  // The server answered, so the POST goes ahead.
  await expect(page.getByRole("status")).toContainText(
    "Your endorsement is published.",
  );
  const items = await outboxItems(page);
  expect(items).toHaveLength(1);
  expect(items[0].peers.self.state).toBe("accepted");
  expect(log.indexOf("receipt")).toBeGreaterThanOrEqual(0);
  expect(log.indexOf("receipt")).toBeLessThan(log.indexOf("POST"));
  expect(log.filter((entry) => entry === "POST")).toHaveLength(1);
  await page.unroute("**/api/v1/receipts/*");
  await clearAfterReload(page, 1);
});

test("a denied receipt lookup for a refused record is retried and is not a refusal", async ({
  page,
}) => {
  await createIdentity(page);
  await openWord(page, "cukta");
  await page.route("**/api/v1/events", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({ message: "Probe refusal.", code: "probe" }),
        })
      : route.continue(),
  );
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await acceptFirstSignature(page);
  const peerOf = async () => (await outboxItems(page))[0]?.peers.self;
  await expect.poll(async () => (await peerOf())?.state).toBe("refused");
  await page.unroute("**/api/v1/events");
  const log = deliveryRequests(page);
  await page.route("**/api/v1/receipts/*", (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ message: "Receipt lookup denied." }),
    }),
  );
  await page.getByRole("link", { name: "1 not delivered" }).click();
  await expect(page).toHaveTitle("Not delivered · jbovlacku");
  await page.getByRole("button", { name: "Try now" }).first().click();
  await expect.poll(async () => (await peerOf())?.attempts).toBe(2);
  const retried = await peerOf();
  expect(retried.state).toBe("unknown");
  expect(retried.failure).toBe("server");
  expect(retried.nextAttempt).not.toBeNull();
  expect(log).toContain("receipt");
  expect(log).not.toContain("POST");
  await page.unroute("**/api/v1/receipts/*");
  await page.getByRole("button", { name: "Try now" }).first().click();
  await expect
    .poll(async () => (await peerOf())?.state, { timeout: 30000 })
    .toBe("accepted");
  await clearAfterReload(page, 1);
});

for (const initial of ["queued", "refused"] as const)
  test(`a tab that closes after the server took the POST of a ${initial} record leaves a receipt lookup`, async ({
    page,
    context,
  }) => {
    await createIdentity(page);
    await openWord(page, "cukta");
    const endorse = async () => {
      await page
        .locator("article.definition")
        .first()
        .getByRole("button", { name: "Endorse" })
        .click();
      await acceptFirstSignature(page);
    };
    if (initial === "refused") {
      await page.route("**/api/v1/events", (route) =>
        route.request().method() === "POST"
          ? route.fulfill({
              status: 422,
              contentType: "application/json",
              body: JSON.stringify({ message: "Probe refusal." }),
            })
          : route.continue(),
      );
      await endorse();
      await expect
        .poll(async () => (await outboxItems(page))[0]?.peers.self.state)
        .toBe("refused");
      await page.unroute("**/api/v1/events");
      await page.getByRole("link", { name: "1 not delivered" }).click();
      await expect(page).toHaveTitle("Not delivered · jbovlacku");
    }
    // The server stores the POST and answers. The answer never reaches the
    // page, because the tab closes first.
    let reached!: (status: number) => void;
    const stored = new Promise<number>((resolve) => (reached = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/v1/events", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      reached(response.status());
      await gate;
      await route.fulfill({ response }).catch(() => {});
    });
    if (initial === "refused")
      await page.getByRole("button", { name: "Try now" }).first().click();
    else await endorse();
    expect(await stored).toBe(201);
    await page.close();
    release();
    const next = await context.newPage();
    const log = deliveryRequests(next);
    await next.goto("/outbox");
    await expect
      .poll(async () => (await outboxItems(next))[0]?.peers.self.state, {
        timeout: 30000,
      })
      .toBe("accepted");
    // The reopened tab asked for the receipt and did not send the bytes again.
    expect(log).toContain("receipt");
    expect(log).not.toContain("POST");
    await clearAfterReload(next, 1);
  });

test("explicit local-only signing does not sign a first event for a key without history here", async ({
  page,
}) => {
  await createIdentity(page);
  await page.getByText("Offline signing", { exact: true }).click();
  await page.getByLabel("Sign from history saved in this browser only").check();
  await openWord(page, "cukta");
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toContainText(
    "Publishing needs a connection the first time this key publishes in this browser.",
  );
  expect(await outboxItems(page)).toHaveLength(0);
});

test("a 503 history read with a large error body still signs from the history saved here", async ({
  page,
}) => {
  test.setTimeout(180000);
  await createIdentity(page);
  const clearId = await establishHistory(page);
  const before = new Set((await outboxItems(page)).map((item: any) => item.id));
  await page.route("**/api/v1/identity-heads/**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "text/html",
      body: "x".repeat(65537),
    }),
  );
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await expect
    .poll(async () => (await outboxItems(page)).length, { timeout: 30000 })
    .toBe(before.size + 1);
  const signed = (await outboxItems(page)).find(
    (item: any) => !before.has(item.id),
  );
  expect(JSON.parse(signed.transport).envelope.header.previous).toEqual([
    clearId,
  ]);
  await page.unroute("**/api/v1/identity-heads/**");
  await expect
    .poll(async () => (await statesOf(page, [signed.id]))[0], {
      timeout: 30000,
    })
    .toBe("accepted");
  await clearAfterReload(page, 2);
});

const endorseFirst = async (page: Page) => {
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await acceptFirstSignature(page);
};
const selfPeer = async (page: Page) => (await outboxItems(page))[0]?.peers.self;
/** Counts the event POSTs that one page sends. */
function postCounter(page: Page) {
  const counter = { posts: 0 };
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/v1\/events$/.test(request.url()))
      counter.posts++;
  });
  return counter;
}
/** Holds a route until `release` runs. `arrived` resolves when it is called. */
function holdable() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let arrive!: () => void;
  const arrived = new Promise<void>((resolve) => (arrive = resolve));
  return { release, released, arrive, arrived };
}

test("a stopped record keeps true text after its tab closed during a send", async ({
  page,
  context,
}) => {
  await createIdentity(page);
  await openWord(page, "cukta");
  await page.route("**/api/v1/events", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({ message: "Probe refusal." }),
        })
      : route.continue(),
  );
  await endorseFirst(page);
  await expect.poll(async () => (await selfPeer(page))?.state).toBe("refused");
  await page.unroute("**/api/v1/events");
  await page.getByRole("link", { name: "1 not delivered" }).click();
  await expect(page).toHaveTitle("Not delivered · jbovlacku");
  // The POST never answers and never reaches the server.
  const held = holdable();
  await page.route("**/api/v1/events", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    held.arrive();
    await held.released;
    await route.abort("failed").catch(() => {});
  });
  await page.getByRole("button", { name: "Try now" }).first().click();
  await held.arrived;
  await page.getByRole("button", { name: "Stop retrying" }).click();
  await expect
    .poll(async () => (await outboxItems(page))[0]?.stopped)
    .toBe(true);
  await page.close();
  held.release();
  const next = await context.newPage();
  await next.goto("/outbox");
  await expect(next.locator("main")).toContainText(
    "A send started. Its outcome is unknown.",
  );
  await expect(next.locator("main")).not.toContainText(
    "The record is being sent.",
  );
});

test("an older tab's refusal does not erase the send mark of a newer tab's accepted POST", async ({
  page,
  context,
}) => {
  test.setTimeout(150000);
  await createIdentity(page);
  await openWord(page, "cukta");
  // Tab A's first POST waits, and then gets a refusal that never reached the server.
  const first = holdable();
  await page.route("**/api/v1/events", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    first.arrive();
    await first.released;
    await route
      .fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ message: "Older refusal." }),
      })
      .catch(() => {});
  });
  await endorseFirst(page);
  await first.arrived;
  // Tab B sees A's mark, finds no receipt, and sends. The server accepts,
  // and B's answer never arrives.
  const other = await context.newPage();
  const accepted = holdable();
  await other.route("**/api/v1/events", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    accepted.arrive();
    await accepted.released;
    await route.fulfill({ response }).catch(() => {});
  });
  await other.goto("/outbox");
  await accepted.arrived;
  first.release();
  // A stores nothing over B's mark.
  await page.waitForTimeout(2000);
  expect((await selfPeer(other))?.state).not.toBe("refused");
  await page.close();
  await other.close();
  accepted.release();
  const reopened = await context.newPage();
  await reopened.goto("/outbox");
  await expect
    .poll(async () => (await selfPeer(reopened))?.state, { timeout: 30000 })
    .toBe("accepted");
  await clearAfterReload(reopened, 1);
});

for (const [outcome, sameClock] of [
  ["accepted", false],
  ["refused", false],
  ["refused", true],
] as const)
  test(`a tab does not send after another tab stored ${outcome}${sameClock ? " in the same millisecond" : ""}`, async ({
    page,
    context,
  }) => {
    test.setTimeout(150000);
    await createIdentity(page);
    await openWord(page, "cukta");
    // The first send fails at the network level, so the outcome is unknown.
    await page.route("**/api/v1/events", (route) =>
      route.request().method() === "POST"
        ? route.abort("failed")
        : route.continue(),
    );
    await endorseFirst(page);
    await expect
      .poll(async () => (await selfPeer(page))?.state)
      .toBe("unknown");
    await page.unroute("**/api/v1/events");
    await page.getByRole("link", { name: "1 not delivered" }).click();
    await expect(page).toHaveTitle("Not delivered · jbovlacku");
    const other = await context.newPage();
    await other.goto("/outbox");
    await expect(other.getByRole("button", { name: "Try now" })).toBeVisible();
    // Both tabs read one fixed time, later than every stored time.
    const fixed = Date.now() + 5000;
    if (sameClock)
      for (const tab of [page, other])
        await tab.evaluate((time) => {
          Date.now = () => time;
        }, fixed);
    // Tab A's lookup answers "not found" only after tab B finished.
    const lookup = holdable();
    await page.route("**/api/v1/receipts/*", async (route) => {
      lookup.arrive();
      await lookup.released;
      await route
        .fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ message: "Not found." }),
        })
        .catch(() => {});
    });
    const postsA = postCounter(page);
    await page.getByRole("button", { name: "Try now" }).first().click();
    await lookup.arrived;
    if (outcome === "refused")
      await other.route("**/api/v1/events", (route) =>
        route.request().method() === "POST"
          ? route.fulfill({
              status: 422,
              contentType: "application/json",
              body: JSON.stringify({ message: "Newer refusal." }),
            })
          : route.continue(),
      );
    await other.getByRole("button", { name: "Try now" }).first().click();
    await expect
      .poll(async () => (await selfPeer(other))?.state, { timeout: 30000 })
      .toBe(outcome);
    lookup.release();
    await page.waitForTimeout(3000);
    // A sends nothing, and B's outcome stays.
    expect(postsA.posts).toBe(0);
    expect((await selfPeer(page))?.state).toBe(outcome);
    await other.close();
    if (outcome === "accepted") {
      await page.unroute("**/api/v1/receipts/*");
      await clearAfterReload(page, 1);
    }
  });

test("an unreadable receipt answer while the browser reports offline lets a first send go ahead", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "onLine", {
      configurable: true,
      get: () => false,
    });
  });
  const posts = postCounter(page);
  await createIdentity(page);
  await openWord(page, "cukta");
  await page.route("**/api/v1/receipts/*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Portal</title>",
    }),
  );
  await endorseFirst(page);
  await expect(page.getByRole("status")).toContainText(
    "Your endorsement is published.",
  );
  expect(posts.posts).toBe(1);
  expect((await selfPeer(page))?.state).toBe("accepted");
  await page.unroute("**/api/v1/receipts/*");
  await clearAfterReload(page, 1);
});

test("a first send whose POST started says that it waits for confirmation", async ({
  page,
}) => {
  await page.goto("/outbox");
  const text = await page.evaluate(async () => {
    const { describePeer, freshPeer } = await import(
      String("/src/data/delivery.ts")
    );
    return describePeer({ ...freshPeer(), sendStarted: Date.now() });
  });
  expect(text).toBe("A send started. Its outcome is not confirmed yet.");
});

test("the local-only setting names its condition and how to publish without it", async ({
  page,
}) => {
  await createIdentity(page);
  await page.getByText("Offline signing", { exact: true }).click();
  await expect(page.locator("main")).toContainText(
    "after this key has published at least one record in this browser",
  );
  await page.getByLabel("Sign from history saved in this browser only").check();
  await openWord(page, "cukta");
  await endorseFirst(page);
  await expect(page.getByRole("status")).toContainText(
    "Clear “Sign from history saved in this browser only” and publish with a connection.",
  );
  expect(await outboxItems(page)).toHaveLength(0);
});

test("the open publication page shows a started first send while its POST is open", async ({
  page,
}) => {
  await createIdentity(page);
  await toPublish(page, "brodu");
  // The server takes the first POST, and its answer waits.
  const held = holdable();
  let first = true;
  await page.route("**/api/v1/events", async (route) => {
    if (route.request().method() !== "POST" || !first) return route.continue();
    first = false;
    const response = await route.fetch();
    held.arrive();
    await held.released;
    await route.fulfill({ response }).catch(() => {});
  });
  await page.locator("aside").getByRole("button", { name: "Publish" }).click();
  await acceptFirstSignature(page);
  await held.arrived;
  const saved = page.getByRole("region", { name: "Saved publication" });
  await expect(saved).toContainText(
    "A send started. Its outcome is not confirmed yet.",
  );
  await expect(page.getByRole("link", { name: /not delivered/ })).toBeHidden();
  held.release();
  await expect
    .poll(
      async () =>
        (await outboxItems(page)).every(
          (item: any) => item.peers.self.state === "accepted",
        ),
      { timeout: 30000 },
    )
    .toBe(true);
});
