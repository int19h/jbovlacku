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

async function states(page: Page) {
  return (await outboxItems(page)).map(
    (item: any) => item.peers.self.state as string,
  );
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
  await expect(
    page.getByRole("heading", { name: spelling }),
  ).toBeVisible();
  await page.getByLabel("Read circled numbers as place references").uncheck();
  await page.getByRole("button", { name: "Review" }).click();
  await expect(
    page.getByRole("heading", { name: "Publish as" }),
  ).toBeVisible();
  return meaning;
}

async function publishOffline(page: Page) {
  await page.context().setOffline(true);
  await page
    .locator("aside")
    .getByRole("button", { name: "Publish" })
    .click();
  await acceptFirstSignature(page);
  const saved = page.getByRole("region", { name: "Saved publication" });
  await expect(saved).toContainText("Saved. Not delivered yet.");
  await expect(saved).toContainText(
    "This is a local preview of your signed record.",
  );
  await expect(
    page.getByRole("link", { name: "2 not delivered" }),
  ).toBeVisible();
  const items = await outboxItems(page);
  expect(items).toHaveLength(2);
  expect(items.map((item: any) => item.peers.self.state)).toEqual([
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
  await toPublish(page, "brodu");
  await publishOffline(page);
  await page.getByRole("link", { name: "2 not delivered" }).click();
  await expect(page).toHaveTitle("Not delivered · jbovlacku");
  await expect(page.getByText("No unfinished records.")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "2 not delivered" }),
  ).toBeVisible();
  await page.context().setOffline(false);
});

test("offline publish delivers when the network returns", async ({
  page,
}) => {
  await createIdentity(page);
  await toPublish(page, "brode");
  const items = await publishOffline(page);
  await page.context().setOffline(false);
  await expect
    .poll(() => states(page), { timeout: 30000 })
    .toEqual(["accepted", "accepted"]);
  const after = await outboxItems(page);
  expect(after.map((item: any) => item.id).sort()).toEqual(
    items.map((item: any) => item.id).sort(),
  );
  expect(after.map((item: any) => item.transport).sort()).toEqual(
    items.map((item: any) => item.transport).sort(),
  );
  await expect(
    page.getByRole("link", { name: /not delivered/ }),
  ).toBeHidden();
});

test("offline publish survives a reload before the network returns", async ({
  page,
}) => {
  await createIdentity(page);
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
  const kept = await outboxItems(page);
  expect(kept.map((item: any) => item.id).sort()).toEqual(
    items.map((item: any) => item.id).sort(),
  );
  expect(kept.map((item: any) => item.transport).sort()).toEqual(
    items.map((item: any) => item.transport).sort(),
  );
  await page.unroute("**/api/v1/**");
  await page.getByRole("button", { name: "Try now" }).first().click();
  await expect
    .poll(() => states(page), { timeout: 30000 })
    .toEqual(["accepted", "accepted"]);
});

test("offline endorsement saves the signed record and delivers on return", async ({
  page,
}) => {
  await createIdentity(page);
  await openWord(page, "cukta");
  const endorse = page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" });
  await page.context().setOffline(true);
  await endorse.click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toContainText(
    "Your judgment is signed and saved here. Delivery is not finished.",
  );
  await expect(
    page.getByRole("link", { name: "1 not delivered" }),
  ).toBeVisible();
  const items = await outboxItems(page);
  expect(items).toHaveLength(1);
  expect(items[0].peers.self.state).toBe("queued");
  await page.context().setOffline(false);
  await expect
    .poll(() => states(page), { timeout: 30000 })
    .toEqual(["accepted"]);
  await expect(
    page.getByRole("link", { name: /not delivered/ }),
  ).toBeHidden();
  // Clear the endorsement so this test leaves the shared word unchanged.
  // A reload locks the key, so the clear goes through the unlock dialog.
  await page.reload();
  const endorsedArticle = page.locator(
    'article.definition:has(button[aria-pressed="true"])',
  );
  await expect(endorsedArticle).toHaveCount(1);
  await endorsedArticle
    .getByRole("button", { name: "Endorse" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Unlock your key" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Passphrase").fill(PASSPHRASE);
  await dialog.getByRole("button", { name: "Unlock" }).click();
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
});
