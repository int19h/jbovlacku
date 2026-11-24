import { test, expect } from "@playwright/test";
import { acceptFirstSignature, createIdentity, fixture, openWord } from "./helpers.ts";

const DEF_ID = "jve1:94b463e3b71d56fe4a7ae6839f9165a019a13a47095dd4fbe043cbda36ead07b";
const END_ID = "jve1:44e54ef8b71d56fe4a7ae6839f9165a019a13a47095dd4fbe043cbda36ead07c";

/** Seeds a definition and its dependent endorsement, as stored before the fix. */
async function seed(page: import("@playwright/test").Page, dependent: "waiting" | "stopped" | "refused" = "waiting") {
  await page.goto("/outbox");
  await expect(page.locator("main h1")).toHaveText("Not delivered");
  await page.evaluate(async ([defId, endId, mode]) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { freshPeer } = await import(String("/src/data/delivery.ts"));
    const store = new LocalStore();
    const peer = () => ({ ...freshPeer(), state: "unknown", failure: "offline", attempts: 1, lastAttempt: Date.now(), nextAttempt: Date.now() + 90000, error: "No connection to the server." });
    const definition = {
      id: defId, identity: "test", group: "g1", order: 0, stopped: false, signedAt: Date.now(),
      transport: JSON.stringify({ envelope: { id: defId, header: { issuer: "test", previous: [], action: { kind: "definition.publish" } } }, body: { word: { spelling: "cuntrix" } } }),
      label: { subject: "cuntrix", action: "new definition", href: "/" },
      peers: { self: peer() },
    };
    const endorsementPeer = mode === "refused"
      ? { ...freshPeer(), state: "refused", failure: "refused", attempts: 1, lastAttempt: Date.now(), nextAttempt: null, error: "The server refused this record." }
      : peer();
    const endorsement = {
      id: endId, identity: "test", group: "g1", order: 1, stopped: mode === "stopped", signedAt: Date.now(),
      transport: JSON.stringify({ envelope: { id: endId, header: { issuer: "test", previous: [defId], action: { kind: "judgment.set", target: defId, value: "bless" } } }, body: null }),
      label: { subject: defId, action: "endorsement", href: "/" },
      peers: { self: endorsementPeer },
    };
    await store.queueGroup([definition as never, endorsement as never]);
  }, [DEF_ID, END_ID, dependent]);
  await page.reload();
}

async function stoppedFlags(page: import("@playwright/test").Page) {
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const items = await new LocalStore().list("outbox");
    return Object.fromEntries(items.map((item: any) => [item.order, item.stopped]));
  });
}

test("U13/U29/U63/U64: outbox shows the word, the missing connection, exact seconds, and stop stays per-record", async ({ page }) => {
  await page.clock.setFixedTime(new Date());
  await seed(page);
  const endorsementRow = page.locator(`[data-outbox-record="${END_ID}"]`);
  await expect(endorsementRow).toContainText("cuntrix");
  await expect(endorsementRow).not.toContainText("jve1:94b463e3");
  await expect(endorsementRow).toContainText("No connection to the server.");
  await expect(page.locator("main")).toContainText("No connection to the server was reported for some records.");
  await expect(endorsementRow).toContainText("Next try in 90 seconds.");
  const definitionRow = page.locator(`[data-outbox-record="${DEF_ID}"]`);
  await definitionRow.getByRole("button", { name: "Stop retrying" }).click();
  await expect(page.getByRole("status")).toContainText("Stop affects only this record.");
  await expect(page.getByRole("status")).toContainText("Records that depend on it keep their own state; use the controls on their rows.");
  await expect(definitionRow.getByText("Stopped", { exact: true })).toBeVisible();
  await expect(endorsementRow.getByText("Stopped", { exact: true })).toHaveCount(0);
  await expect(endorsementRow.getByRole("button", { name: "Stop retrying" })).toBeVisible();
  expect(await stoppedFlags(page)).toEqual({ 0: true, 1: false });
  await definitionRow.getByRole("button", { name: "Resume" }).click();
  await expect.poll(async () => (await stoppedFlags(page))[0]).toBe(false);
  expect((await stoppedFlags(page))[1]).toBe(false);
});

test("U64: stopping a record with an already stopped dependent leaves both stopped", async ({ page }) => {
  await seed(page, "stopped");
  const endorsementRow = page.locator(`[data-outbox-record="${END_ID}"]`);
  await expect(endorsementRow.getByText("Stopped", { exact: true })).toBeVisible();
  const definitionRow = page.locator(`[data-outbox-record="${DEF_ID}"]`);
  await definitionRow.getByRole("button", { name: "Stop retrying" }).click();
  await expect(page.getByRole("status")).toContainText("Stop affects only this record.");
  await expect(page.getByRole("status")).toContainText("Records that depend on it keep their own state; use the controls on their rows.");
  expect(await stoppedFlags(page)).toEqual({ 0: true, 1: true });
});

test("U64: stopping a record with a refused dependent leaves it refused and unstopped", async ({ page }) => {
  await seed(page, "refused");
  const definitionRow = page.locator(`[data-outbox-record="${DEF_ID}"]`);
  await definitionRow.getByRole("button", { name: "Stop retrying" }).click();
  await expect(page.getByRole("status")).toContainText("Stop affects only this record.");
  await expect(page.getByRole("status")).toContainText("Records that depend on it keep their own state; use the controls on their rows.");
  expect(await stoppedFlags(page)).toEqual({ 0: true, 1: false });
  const endorsement = await page.evaluate(async (endId) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const item = await new LocalStore().get("outbox", endId);
    return item.peers.self.state;
  }, END_ID);
  expect(endorsement).toBe("refused");
});

test("U13: the publish panel shows the target word for an endorsement", async ({ page }) => {
  await seed(page);
  await page.evaluate(async ([defId, endId]) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().put("drafts", "published:last", {
      revision: "r1", draftKey: "current", group: "g1", ids: [defId, endId], identity: "test", signedAt: Date.now(),
    });
  }, [DEF_ID, END_ID]);
  await page.goto("/new/publish");
  const saved = page.getByRole("region", { name: "Saved publication" });
  await expect(saved).toContainText("endorsement cuntrix");
  await expect(saved).not.toContainText("jve1:94b463e3");
});

test("U13: Recent activity shows the target word for an endorsement", async ({ page }) => {
  const f = fixture();
  await page.goto(`/identity/${encodeURIComponent(f.identities.curator)}`);
  const recent = page.getByRole("list", { name: "Recent activity" });
  const target = recent.locator("li", { hasText: "Endorsed" }).locator(`a[href="/definition/${encodeURIComponent(f.definitions.cukta1)}"]`);
  await expect(target).toHaveText("cukta");
});

test("U65: Test it stays inside its sentence when the backup warning wraps", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await createIdentity(page);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { newDraft } = await import(String("/src/model/draft.ts"));
    await new LocalStore().put("drafts", "current", newDraft({
      spelling: "brodu", kind: "gismu", meaning: "A disposable test meaning.", text: "A disposable test meaning.", structured: false, frameMode: "none", step: 5,
    }));
  });
  await page.goto("/new/publish");
  const warning = page.locator("p.notice", { hasText: "your key backup is untested" });
  await expect(warning).toHaveText(/^Test it — your key backup is untested\. Publish now and test later if you need to\./);
  const link = warning.getByRole("link", { name: "Test it" });
  await expect(link).toBeVisible();
  const pBox = (await warning.boundingBox())!;
  const lBox = (await link.boundingBox())!;
  expect(pBox.height).toBeGreaterThan(lBox.height * 1.5);
  expect(lBox.y).toBeGreaterThanOrEqual(pBox.y - 1);
  expect(lBox.y).toBeLessThan(pBox.y + lBox.height);
  const sameLine = await warning.evaluate((node) => {
    const anchor = node.querySelector("a")!;
    const linkRect = anchor.getClientRects()[0];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let found = walker.nextNode();
    while (found && !found.textContent!.includes("your")) found = walker.nextNode();
    if (!found) return false;
    const start = found.textContent!.indexOf("your");
    const range = document.createRange();
    range.setStart(found, start);
    range.setEnd(found, start + 4);
    const wordRect = range.getClientRects()[0];
    return linkRect.top < wordRect.bottom && wordRect.top < linkRect.bottom;
  });
  expect(sameLine).toBe(true);
});

test("U13: a standalone endorsement from the word page shows the word in Not delivered", async ({ page }) => {
  await createIdentity(page);
  await page.route("**/api/v1/events", (route) => route.request().method() === "POST" ? route.abort("connectionreset") : route.continue());
  await openWord(page, "cukta");
  await page.locator("article.definition").first().getByRole("button", { name: "Endorse" }).click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toContainText("signed and saved here");
  await page.goto("/outbox");
  const row = page.locator("[data-outbox-record]").first();
  await expect(row).toContainText("cukta");
  await expect(row).not.toContainText("jve1:dc52573a");
  const label = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const [item] = await new LocalStore().list("outbox");
    return item.label.subject;
  });
  expect(label).toBe("cukta");
});

test("U13: label lookup comparisons grow linearly with the outbox size", async ({ page, browser }) => {
  test.setTimeout(120000);
  await page.goto("/outbox");
  const origin = new URL(page.url()).origin;
  const comparisons = async (rows: number) => {
    const context = await browser.newContext({ baseURL: origin });
    const counted = await context.newPage();
    await counted.addInitScript(() => {
      const original = Array.prototype.find;
      (window as any).__labelComparisons = 0;
      Array.prototype.find = function (callback: any, thisArg: any) {
        const list = this as unknown[];
        const isOutbox = Array.isArray(list) && list.length > 1 && list.every((entry) => entry !== null && typeof entry === "object" && "label" in entry && "transport" in entry);
        if (!isOutbox) return original.call(this, callback, thisArg);
        const counting = function (this: unknown, ...args: unknown[]) {
          (window as any).__labelComparisons += 1;
          return callback.apply(this, args);
        };
        return original.call(this, counting, thisArg);
      };
    });
    await counted.goto("/outbox");
    await counted.evaluate(async (count) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { freshPeer } = await import(String("/src/data/delivery.ts"));
      const store = new LocalStore();
      const records = [];
      for (let i = 0; i < count; i++) {
        const id = `jve1:${i.toString(16).padStart(64, "0")}`;
        const definition = i % 2 === 0;
        const target = `jve1:${(i - 1).toString(16).padStart(64, "0")}`;
        records.push({
          id, identity: "test", group: "g1", order: i, stopped: false, signedAt: Date.now(),
          transport: JSON.stringify({ envelope: { id, header: { issuer: "test", previous: definition ? [] : [target], action: definition ? { kind: "definition.publish" } : { kind: "judgment.set", target, value: "bless" } } }, body: null }),
          label: { subject: definition ? `word${i}` : target, action: definition ? "new definition" : "endorsement", href: "/" },
          peers: { self: { ...freshPeer(), state: "refused", failure: "refused", attempts: 1, lastAttempt: Date.now(), nextAttempt: null, error: "The server refused this record." } },
        });
      }
      await store.queueGroup(records as never[]);
    }, rows);
    await counted.reload();
    await expect(counted.locator("[data-outbox-record]")).toHaveCount(rows);
    const total = await counted.evaluate(() => (window as any).__labelComparisons as number);
    await context.close();
    return total;
  };
  const at64 = await comparisons(64);
  const at256 = await comparisons(256);
  console.log(`label comparisons: 64 rows=${at64}, 256 rows=${at256}`);
  expect(at256).toBeLessThan(at64 * 6 + 500);
});
