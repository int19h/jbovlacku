import { test, expect, type Page } from "@playwright/test";
import {
  acceptFirstSignature,
  createIdentity,
  fixture,
  openWord,
} from "./helpers.ts";

async function outboxItems(page: Page) {
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().list("outbox");
  });
}
const firstEndorse = (page: Page) =>
  page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" });

test("an endorsement from the word page signs, delivers, and shows known pressed state", async ({
  page,
}) => {
  await createIdentity(page);
  await openWord(page, "cukta");
  const endorse = firstEndorse(page);
  await expect(endorse).toHaveAttribute("aria-pressed", "false");
  await endorse.click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toHaveText(
    "Your endorsement is published.",
  );
  await expect(endorse).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("link", { name: /not delivered/ })).toBeHidden();
  const items = await outboxItems(page);
  expect(items).toHaveLength(1);
  expect(items[0].peers.self.state).toBe("accepted");
  expect(JSON.parse(items[0].transport).envelope.header.action.value).toBe(
    "bless",
  );
  // Reload: known state comes from authenticated own history, including the server's heads.
  await page.reload();
  await expect(firstEndorse(page)).toHaveAttribute("aria-pressed", "true");
  // Repeating the pressed arrow clears the judgment without a second disclosure. The reload locked the key.
  await firstEndorse(page).click();
  const dialog = page.getByRole("dialog", { name: "Unlock your key" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Passphrase").fill("test passphrase with spaces");
  await dialog.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Your judgment is cleared.",
  );
  await expect(firstEndorse(page)).toHaveAttribute("aria-pressed", "false");
  const after = await outboxItems(page);
  expect(
    after
      .sort((a: any, b: any) => a.signedAt - b.signedAt)
      .map(
        (item: any) => JSON.parse(item.transport).envelope.header.action.value,
      ),
  ).toEqual(["bless", "clear"]);
});

test("a judgment without a key resumes the exact target after key creation", async ({
  page,
}) => {
  await page.goto("/word/cukta");
  await firstEndorse(page).click();
  await expect(page).toHaveURL(/\/identity$/);
  await expect(
    page.getByText(
      "Endorsing cukta will continue after you create or import a key.",
    ),
  ).toBeVisible();
  await page
    .getByLabel("New passphrase", { exact: true })
    .fill("resume passphrase");
  await page.getByLabel("Repeat passphrase").fill("resume passphrase");
  await page.getByRole("button", { name: "Create a key" }).click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toContainText(
    "Your endorsement is published.",
  );
  const items = await outboxItems(page);
  expect(items).toHaveLength(1);
  expect(JSON.parse(items[0].transport).envelope.header.action.target).toBe(
    fixture().definitions.cukta1,
  );
});

test("an unknown delivery outcome asks for the receipt before any retry and never creates a second event", async ({
  page,
}) => {
  await createIdentity(page);
  let posted = 0;
  await page.route("**/api/v1/events", async (route) => {
    posted++;
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    await route.abort("failed");
  });
  await openWord(page, "cukta");
  await firstEndorse(page).click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toContainText(
    "Delivery is not finished.",
  );
  await expect(
    page.getByRole("link", { name: "1 not delivered" }),
  ).toBeVisible();
  await expect(firstEndorse(page)).toHaveClass(/pending/);
  await expect(
    page.getByText("Your endorsement is not delivered yet"),
  ).toBeVisible();
  const original = (await outboxItems(page))[0];
  expect(original.peers.self.state).toBe("unknown");
  await page.unroute("**/api/v1/events");
  await page.reload();
  await page.getByRole("link", { name: "1 not delivered" }).click();
  await expect(page).toHaveTitle("Not delivered · jbovlacku");
  await expect(
    page.getByText(/The client asks whether the record arrived/),
  ).toBeVisible();
  await expect(page.getByText(/Next try in/)).toBeVisible();
  await page.getByRole("button", { name: "Try now" }).click();
  await expect(page.getByRole("status")).toHaveText("Delivered.");
  await expect(page.getByText("No unfinished records.")).toBeVisible();
  await expect(page.getByRole("link", { name: /not delivered/ })).toBeHidden();
  expect(posted).toBe(1);
  const after = await outboxItems(page);
  expect(after).toHaveLength(1);
  expect(after[0].transport).toBe(original.transport);
  expect(after[0].id).toBe(original.id);
  expect(after[0].peers.self.state).toBe("accepted");
  expect(after[0].peers.self.receipt.admission).toBe("accepted");
});

test("header-only acceptance stays unfinished until the matching body is confirmed", async ({
  page,
}) => {
  await createIdentity(page);
  const f = fixture();
  // The first request answers with a header-only receipt. The outbox must keep a missing-body row.
  await page.route("**/api/v1/events", async (route) => {
    const response = await route.fetch();
    const receipt = await response.json();
    await route.fulfill({
      status: 201,
      json: { ...receipt, body_status: "missing" },
    });
  });
  await page.getByLabel("Search words and meanings").fill("book");
  await page.getByLabel("Search words and meanings").press("Enter");
  await page
    .getByRole("region", { name: "Search results" })
    .getByRole("link", {
      name:
        f.identities.curator.slice(8, 12) +
        "…" +
        f.identities.curator.slice(-4),
    })
    .first()
    .click();
  await page.getByRole("button", { name: "Report abuse" }).click();
  const dialog = page.getByRole("dialog", { name: "Report identity abuse" });
  await dialog
    .getByLabel("Explanation")
    .fill("Synthetic test report with a body.");
  await dialog
    .getByRole("button", { name: "Preview the public report" })
    .click();
  await page
    .getByRole("button", { name: "Sign and publish the report" })
    .click();
  await acceptFirstSignature(page);
  await expect(
    page.getByRole("link", { name: "1 not delivered" }),
  ).toBeVisible();
  await page.unroute("**/api/v1/events");
  await page.goto("/outbox");
  await expect(
    page.getByText(/stored the signed header without its body/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Try now" }).click();
  await expect(page.getByRole("status")).toHaveText("Delivered.");
  const items = await outboxItems(page);
  expect(items[0].peers.self.state).toBe("accepted");
  expect(items[0].peers.self.receipt.body_status).toBe("present");
});

test("a permanent refusal pauses retries, Retry-After schedules the next try, and stop and resume keep the bytes", async ({
  page,
}) => {
  await createIdentity(page);
  await page.route("**/api/v1/events", (route) =>
    route.fulfill({
      status: 422,
      json: {
        code: "test_refusal",
        message: "Refused by the test.",
        event: null,
        field: null,
      },
    }),
  );
  await openWord(page, "cukta");
  await firstEndorse(page).click();
  await acceptFirstSignature(page);
  await expect(
    page.getByRole("link", { name: "1 not delivered" }),
  ).toBeVisible();
  await page.goto("/outbox");
  await expect(
    page.getByText(
      /Refused by the test\. \(test_refusal\) Retries are paused until you try again\./,
    ),
  ).toBeVisible();
  await expect(page.getByText(/Next try in/)).toHaveCount(0);
  await page.unroute("**/api/v1/events");
  await page.route("**/api/v1/events", (route) =>
    route.fulfill({
      status: 429,
      headers: { "retry-after": "120" },
      json: { code: "quota", message: "Slow down.", event: null, field: null },
    }),
  );
  await page.getByRole("button", { name: "Try now" }).click();
  await expect(page.getByRole("status")).toContainText("Still not delivered.");
  await expect(page.getByText(/Next try in 2 minutes\./)).toBeVisible();
  const items = await outboxItems(page);
  expect(
    items[0].peers.self.nextAttempt - items[0].peers.self.lastAttempt,
  ).toBeGreaterThanOrEqual(120000);
  await page.getByRole("button", { name: "Stop retrying" }).click();
  await expect(page.getByRole("status")).toContainText("Stopped.");
  await expect(page.getByText("No unfinished records.")).toBeVisible();
  await expect(page.getByRole("link", { name: /not delivered/ })).toBeHidden();
  const stopped = await outboxItems(page);
  expect(stopped[0].stopped).toBe(true);
  expect(stopped[0].transport).toBe(items[0].transport);
  await page.unroute("**/api/v1/events");
  await page.reload();
  await expect(page.getByText("No unfinished records.")).toBeVisible();
  await page.getByText(/Retained records/).click();
  await page.getByRole("button", { name: "Resume delivery" }).click();
  await expect(page.getByRole("status")).toContainText("Delivery resumed");
  await expect
    .poll(async () => (await outboxItems(page))[0].peers.self.state)
    .toBe("accepted");
  const final = await outboxItems(page);
  expect(final[0].transport).toBe(items[0].transport);
  expect(final[0].stopped).toBe(false);
});

test("the delivery export contains the exact signed transport lines", async ({
  page,
}) => {
  await createIdentity(page);
  await page.route("**/api/v1/events", (route) => route.abort("failed"));
  await openWord(page, "cukta");
  await firstEndorse(page).click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toContainText(
    "Delivery is not finished.",
  );
  await page.getByRole("link", { name: "1 not delivered" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save them as a file" }).click();
  const download = await downloadPromise;
  const text = await (await download.createReadStream())
    .toArray()
    .then((chunks) => Buffer.concat(chunks as Buffer[]).toString());
  const items = await outboxItems(page);
  expect(text).toBe(items[0].transport + "\n");
});
