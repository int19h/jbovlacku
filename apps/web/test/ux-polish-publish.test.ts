import { test, expect } from "@playwright/test";

/** Seeds a definition and its dependent endorsement, as stored before the fix. */
async function seed(page: import("@playwright/test").Page) {
  await page.goto("/outbox");
  await expect(page.locator("main h1")).toHaveText("Not delivered");
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { freshPeer } = await import(String("/src/data/delivery.ts"));
    const store = new LocalStore();
    const defId = "jve1:94b463e3b71d56fe4a7ae6839f9165a019a13a47095dd4fbe043cbda36ead07b";
    const peer = () => ({ ...freshPeer(), state: "unknown", failure: "offline", attempts: 1, lastAttempt: Date.now(), nextAttempt: Date.now() + 60000, error: "No connection to the server." });
    const definition = {
      id: defId, identity: "test", group: "g1", order: 0, stopped: false, signedAt: Date.now(),
      transport: JSON.stringify({ envelope: { id: defId, header: { issuer: "test", previous: [], action: { kind: "definition.publish" } } }, body: { word: { spelling: "cuntrix" } } }),
      label: { subject: "cuntrix", action: "new definition", href: "/" },
      peers: { self: peer() },
    };
    const endorsement = {
      id: "jve1:44e54ef8b71d56fe4a7ae6839f9165a019a13a47095dd4fbe043cbda36ead07c", identity: "test", group: "g1", order: 1, stopped: false, signedAt: Date.now(),
      transport: JSON.stringify({ envelope: { id: "jve1:44e54ef8b71d56fe4a7ae6839f9165a019a13a47095dd4fbe043cbda36ead07c", header: { issuer: "test", previous: [defId], action: { kind: "judgment.set", target: defId, value: "bless" } } }, body: null }),
      label: { subject: defId, action: "endorsement", href: "/" },
      peers: { self: peer() },
    };
    await store.queueGroup([definition as never, endorsement as never]);
  });
  await page.reload();
}

test("U13/U29/U63/U64: outbox shows the word, the missing connection, exact seconds, and stops dependents", async ({ page }) => {
  await seed(page);
  const endorsementRow = page.locator('[data-outbox-record="jve1:44e54ef8b71d56fe4a7ae6839f9165a019a13a47095dd4fbe043cbda36ead07c"]');
  await expect(endorsementRow).toContainText("cuntrix");
  await expect(endorsementRow).not.toContainText("jve1:94b463e3");
  await expect(page.locator("main")).toContainText("No connection to the server was reported for some records.");
  await expect(endorsementRow).toContainText(/Next try in (59|60) seconds\./);
  const definitionRow = page.locator('[data-outbox-record="jve1:94b463e3b71d56fe4a7ae6839f9165a019a13a47095dd4fbe043cbda36ead07b"]');
  await definitionRow.getByRole("button", { name: "Stop retrying" }).click();
  await expect(endorsementRow.getByText("Stopped", { exact: true })).toBeVisible();
});
