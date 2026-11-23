import { test, expect } from "@playwright/test";
import { createIdentity, fixture } from "./helpers.ts";

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
    const peer = () => ({ ...freshPeer(), state: "unknown", failure: "offline", attempts: 1, lastAttempt: Date.now(), nextAttempt: Date.now() + 60000, error: "No connection to the server." });
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
  await seed(page);
  const endorsementRow = page.locator(`[data-outbox-record="${END_ID}"]`);
  await expect(endorsementRow).toContainText("cuntrix");
  await expect(endorsementRow).not.toContainText("jve1:94b463e3");
  await expect(page.locator("main")).toContainText("No connection to the server was reported for some records.");
  await expect(endorsementRow).toContainText(/Next try in (59|60) seconds\./);
  const definitionRow = page.locator(`[data-outbox-record="${DEF_ID}"]`);
  await definitionRow.getByRole("button", { name: "Stop retrying" }).click();
  await expect(page.getByRole("status")).toContainText("Stop leaves the records that depend on this record unchanged");
  await expect(page.getByRole("status")).toContainText("use the controls on each of those rows");
  await expect(definitionRow.getByText("Stopped", { exact: true })).toBeVisible();
  await expect(endorsementRow.getByText("Stopped", { exact: true })).toHaveCount(0);
  await expect(endorsementRow.getByRole("button", { name: "Stop retrying" })).toBeVisible();
  expect(await stoppedFlags(page)).toEqual({ 0: true, 1: false });
  await definitionRow.getByRole("button", { name: "Resume" }).click();
  await expect.poll(async () => (await stoppedFlags(page))[0]).toBe(false);
  expect((await stoppedFlags(page))[1]).toBe(false);
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
});

test("U64: stopping a record with an already stopped dependent says the dependent is unchanged", async ({ page }) => {
  await seed(page, "stopped");
  const endorsementRow = page.locator(`[data-outbox-record="${END_ID}"]`);
  await expect(endorsementRow.getByText("Stopped", { exact: true })).toBeVisible();
  const definitionRow = page.locator(`[data-outbox-record="${DEF_ID}"]`);
  await definitionRow.getByRole("button", { name: "Stop retrying" }).click();
  await expect(page.getByRole("status")).toContainText("Stop leaves the records that depend on this record unchanged");
  await expect(page.getByRole("status")).not.toContainText("keep retrying");
  expect(await stoppedFlags(page)).toEqual({ 0: true, 1: true });
});

test("U64: stopping a record with a refused dependent says the dependent is unchanged", async ({ page }) => {
  await seed(page, "refused");
  const definitionRow = page.locator(`[data-outbox-record="${DEF_ID}"]`);
  await definitionRow.getByRole("button", { name: "Stop retrying" }).click();
  await expect(page.getByRole("status")).toContainText("Stop leaves the records that depend on this record unchanged");
  await expect(page.getByRole("status")).not.toContainText("keep retrying");
  expect(await stoppedFlags(page)).toEqual({ 0: true, 1: false });
  const endorsement = await page.evaluate(async (endId) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const item = await new LocalStore().get("outbox", endId);
    return item.peers.self.state;
  }, END_ID);
  expect(endorsement).toBe("refused");
});
