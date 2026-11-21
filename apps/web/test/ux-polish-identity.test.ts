import { test, expect, type Page } from "@playwright/test";
import { createIdentity, PASSPHRASE } from "./helpers.ts";

/** Creates the successor key on the handover page and passes its backup test. */
async function createSuccessor(page: Page) {
  await page.getByLabel("New passphrase for the new key").fill(PASSPHRASE);
  await page.getByLabel("Repeat passphrase").fill(PASSPHRASE);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Create the new key" }).click();
  await page
    .getByRole("button", { name: "Download the new key's backup" })
    .click();
  const download = await downloadPromise;
  const path = await download.path();
  await page.getByLabel("Backup file").setInputFiles(path!);
  await page.getByLabel("Its passphrase").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Test the backup" }).click();
  await expect(page.locator("main").getByRole("status").last()).toContainText(
    "recovers the new key",
  );
}

test("key creation refuses a short passphrase with a persistent inline error", async ({
  page,
}) => {
  await page.goto("/identity");
  await page.getByLabel("New passphrase", { exact: true }).fill("a");
  await page.getByLabel("Repeat passphrase").fill("a");
  await page.getByRole("button", { name: "Create a key" }).click();
  const alert = page
    .getByRole("form", { name: "Create a key" })
    .getByRole("alert");
  await expect(alert).toHaveText("Use at least 12 characters.");
  await expect(alert).toBeVisible();
  await expect(
    page.getByLabel("New passphrase", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("New passphrase", { exact: true })
    .fill("long enough passphrase");
  await page.getByLabel("Repeat passphrase").fill("different passphrase");
  await page.getByRole("button", { name: "Create a key" }).click();
  await expect(alert).toHaveText("The passphrases do not match.");
});

test("backup test and import errors stay inline by the field", async ({
  page,
  browser,
}) => {
  const backup = await createIdentity(page);
  await page.getByRole("button", { name: "Test the backup" }).click();
  const form = page.getByRole("form", { name: "Test the backup" });
  await form.getByLabel("Backup file").setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await form.getByLabel("Backup passphrase").fill("wrong passphrase");
  await page.getByRole("button", { name: "Run the test" }).click();
  await expect(form.getByRole("alert")).toHaveText(
    "This file did not unlock with that passphrase.",
  );
  await expect(form.getByRole("alert")).toBeVisible();

  const context = await browser.newContext();
  const restored = await context.newPage();
  await restored.goto("/identity");
  const importForm = restored.getByRole("form", {
    name: "Import an encrypted backup",
  });
  await importForm.getByLabel("Backup file").setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await importForm.getByLabel("Backup passphrase").fill("wrong");
  await restored
    .getByRole("button", { name: "Open backup locally" })
    .click();
  await expect(importForm.getByRole("alert")).toHaveText(
    "This file did not unlock with that passphrase.",
  );
  await expect(importForm.getByRole("alert")).toBeVisible();
  await context.close();
});

test("a failed import of the existing key keeps its form, alert and focus", async ({
  page,
}) => {
  const backup = await createIdentity(page);
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const form = page.getByRole("form", {
    name: "Import an encrypted backup",
  });
  await form.getByLabel("Backup file").setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await form.getByLabel("Backup passphrase").fill("wrong passphrase");
  await form
    .getByRole("button", { name: "Open backup locally" })
    .click();
  await expect(form.getByRole("alert")).toHaveText(
    "This file did not unlock with that passphrase.",
  );
  await expect(form.getByRole("alert")).toBeVisible();
  await expect(form).toBeVisible();
  await expect(form.getByLabel("Backup passphrase")).toBeFocused();
});

test("unlock uses its own message and focus lands on the Lock control", async ({
  page,
}) => {
  const backup = await createIdentity(page);
  void backup;
  await page.getByRole("button", { name: "Test the backup" }).click();
  const form = page.getByRole("form", { name: "Test the backup" });
  await form.getByLabel("Backup file").setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await form.getByLabel("Backup passphrase").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Run the test" }).click();
  await expect(
    page.getByText("Your backup test passed in this browser."),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.activeElement?.tagName),
  ).not.toBe("BODY");

  await page.getByRole("button", { name: "Lock", exact: true }).click();
  await expect(page.getByText("Locked", { exact: true })).toBeVisible();
  await page.getByLabel("Passphrase", { exact: true }).fill("wrong");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "That passphrase did not unlock the key.",
  );
  await page.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
  await page
    .getByLabel("Passphrase", { exact: true })
    .press("Enter");
  await expect(page.getByText("Unlocked", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => document.activeElement?.textContent?.trim()),
  ).toBe("Lock");
});

test("handover banner keeps the delivery link out of the sentence and offers Check again", async ({
  page,
}) => {
  await createIdentity(page);
  let posts = 0;
  await page.route("**/api/v1/events", async (route) => {
    posts++;
    if (posts >= 2) {
      await route.fulfill({
        status: 503,
        json: { code: "busy", message: "Later.", event: null, field: null },
      });
      return;
    }
    await route.continue();
  });
  await page.getByRole("link", { name: "Start" }).click();
  await expect(
    page.getByRole("heading", { name: "Move to a new key" }),
  ).toBeVisible();
  await createSuccessor(page);
  const sign = page.getByRole("button", { name: "Sign the handover" });
  for (const box of await page.getByRole("checkbox").all()) await box.check();
  await expect(sign).toBeEnabled();
  await sign.click();
  const banner = page.getByRole("region", { name: "Handover status" });
  await expect(banner).toContainText("Old key retired, acceptance waiting.");
  await expect(
    banner.getByRole("button", { name: "Check again" }),
  ).toBeVisible();
  const sentence = banner.getByText(
    "Retries reuse the stored events and look the receipt up by event ID first. No replacement acceptance is ever signed automatically.",
    { exact: true },
  );
  await expect(sentence).toBeVisible();
  await expect(sentence.getByRole("link")).toHaveCount(0);
  await banner.getByRole("button", { name: "Check again" }).click();
  await expect(banner).toContainText("Old key retired, acceptance waiting.");
  // Activating Check again keeps focus on the replacement control.
  await banner.getByRole("button", { name: "Check again" }).focus();
  await page.keyboard.press("Enter");
  await expect(banner).toContainText("Old key retired, acceptance waiting.");
  await expect(
    banner.getByRole("button", { name: "Check again" }),
  ).toBeFocused();
  // With the server healthy again, a focused Check again retries delivery
  // in this tab, completes the handover, and focus moves to the status text.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await banner.getByRole("button", { name: "Check again" }).focus();
  await page.keyboard.press("Enter");
  await expect(banner).toContainText("Handover complete");
  await expect
    .poll(() =>
      page.evaluate(() => document.activeElement?.textContent?.trim() ?? ""),
    )
    .toContain("Handover complete");
});

test("a delayed banner refresh does not steal focus moved elsewhere", async ({
  page,
}) => {
  await createIdentity(page);
  let posts = 0;
  await page.route("**/api/v1/events", async (route) => {
    posts++;
    if (posts === 2) {
      await route.fulfill({
        status: 503,
        json: { code: "busy", message: "Later.", event: null, field: null },
      });
      return;
    }
    await route.continue();
  });
  await page.getByRole("link", { name: "Start" }).click();
  await expect(
    page.getByRole("heading", { name: "Move to a new key" }),
  ).toBeVisible();
  await createSuccessor(page);
  const sign = page.getByRole("button", { name: "Sign the handover" });
  for (const box of await page.getByRole("checkbox").all()) await box.check();
  await expect(sign).toBeEnabled();
  await sign.click();
  const banner = page.getByRole("region", { name: "Handover status" });
  await expect(banner).toContainText("Old key retired, acceptance waiting.");
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const original = LocalStore.prototype.list;
    LocalStore.prototype.list = async function (store: string) {
      if (store === "outbox") {
        LocalStore.prototype.list = original;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return original.call(this, store);
    };
  });
  await banner.getByRole("button", { name: "Check again" }).click();
  const search = page.getByLabel("Search words and meanings");
  await search.focus();
  await expect(search).toBeFocused();
  await page.waitForTimeout(700);
  await expect(search).toBeFocused();
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("banner notifications restore focus to the same control, and Check again retries delivery", async ({
  page,
}) => {
  await createIdentity(page);
  let posts = 0;
  await page.route("**/api/v1/events", async (route) => {
    posts++;
    if (posts === 2) {
      await route.fulfill({
        status: 503,
        json: { code: "busy", message: "Later.", event: null, field: null },
      });
      return;
    }
    await route.continue();
  });
  await page.getByRole("link", { name: "Start" }).click();
  await expect(
    page.getByRole("heading", { name: "Move to a new key" }),
  ).toBeVisible();
  await createSuccessor(page);
  const sign = page.getByRole("button", { name: "Sign the handover" });
  for (const box of await page.getByRole("checkbox").all()) await box.check();
  await expect(sign).toBeEnabled();
  await sign.click();
  const banner = page.getByRole("region", { name: "Handover status" });
  await expect(banner).toContainText("Old key retired, acceptance waiting.");
  const notDelivered = banner.getByRole("link", { name: "Not delivered" });
  await notDelivered.focus();
  await expect(notDelivered).toBeFocused();
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await page.waitForTimeout(300);
  await expect(notDelivered).toBeFocused();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await banner.getByRole("button", { name: "Check again" }).click();
  await expect(banner).toContainText("Handover complete");
});

test("stored-key unlock keeps concurrency and container errors truthful", async ({
  page,
}) => {
  const backup = await createIdentity(page);
  const messages = await page.evaluate(async () => {
    const { createKey, unlockKey } = await import(
      String("/src/data/keys.ts")
    );
    const created = await createKey("test passphrase with spaces");
    const first = unlockKey(
      created.backup,
      "test passphrase with spaces",
      true,
    );
    let concurrent = "";
    try {
      await unlockKey(created.backup, "test passphrase with spaces", true);
    } catch (error) {
      concurrent = String(error);
    }
    await first;
    let wrong = "";
    try {
      await unlockKey(created.backup, "wrong passphrase", true);
    } catch (error) {
      wrong = String(error);
    }
    let unsupported = "";
    try {
      await unlockKey({ ...created.backup, version: 2 }, "x", true);
    } catch (error) {
      unsupported = String(error);
    }
    return { concurrent, wrong, unsupported };
  });
  expect(messages.concurrent).toContain("Another backup is still opening.");
  expect(messages.wrong).toContain("That passphrase did not unlock the key.");
  expect(messages.unsupported).toContain(
    "This backup format is not supported.",
  );
  await page.evaluate(async (value) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().put("keys", "selected", { ...value, version: 2 });
  }, backup);
  await page.goto("/identity");
  await page.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "This backup format is not supported.",
  );
});

test("compromise unlock of a stored key uses the stored-key sentence", async ({
  page,
}) => {
  await createIdentity(page);
  await page.getByRole("button", { name: "Lock", exact: true }).click();
  await expect(page.getByText("Locked", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Report", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Report a stolen key" }),
  ).toBeVisible();
  await page.getByLabel(/cannot prove/).check();
  await page.getByLabel(/disabling all authority/).check();
  await page.getByRole("button", { name: "Sign the notice" }).click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('input[type="file"]')).toHaveCount(0);
  await dialog.locator('input[type="password"]').fill("wrong");
  await dialog.getByRole("button", { name: "Unlock" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "That passphrase did not unlock the key.",
  );
});

test("key work does not steal focus moved to the search field", async ({
  page,
}) => {
  await createIdentity(page);
  await page.getByRole("button", { name: "Lock", exact: true }).click();
  await expect(page.getByText("Locked", { exact: true })).toBeVisible();
  const search = page.getByLabel("Search words and meanings");
  await page.getByLabel("Passphrase", { exact: true }).fill("wrong passphrase");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await search.focus();
  await expect(page.getByRole("alert")).toHaveText(
    "That passphrase did not unlock the key.",
  );
  await expect(search).toBeFocused();
  await page.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await search.focus();
  await expect(page.getByText("Unlocked", { exact: true })).toBeVisible();
  await expect(search).toBeFocused();
});

test("identity intro paragraphs and empty editor links have visible separation", async ({
  page,
}) => {
  await page.goto("/identity");
  await expect(
    page.getByRole("form", { name: "Create a key" }),
  ).toBeVisible();
  const gap = await page.evaluate(() => {
    const paragraphs = [
      ...document.querySelectorAll("main > .stack > p"),
    ] as HTMLElement[];
    if (paragraphs.length < 2) return 0;
    return (
      paragraphs[1].getBoundingClientRect().top -
      paragraphs[0].getBoundingClientRect().bottom
    );
  });
  expect(gap).toBeGreaterThanOrEqual(8);
  const margin = await page.evaluate(() => {
    const span = document.createElement("span");
    span.className = "rich-word-link";
    document.querySelector("main")!.append(span);
    const value = parseFloat(getComputedStyle(span).marginLeft);
    span.remove();
    return value;
  });
  expect(margin).toBeGreaterThan(0);
});

test("same-row action buttons keep their gap at 600 px", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 844 });
  await page.goto("/identity");
  await expect(
    page.getByRole("form", { name: "Create a key" }),
  ).toBeVisible();
  const boxes = await page.evaluate(() => {
    const form = document.querySelector('form[aria-label="Create a key"]')!;
    const buttons = [...form.querySelectorAll("button")];
    const create = buttons.find(
      (b) => b.textContent?.trim() === "Create a key",
    )!;
    const reveal = buttons.find(
      (b) => b.textContent?.trim() === "Reveal passphrases",
    )!;
    const a = create.getBoundingClientRect();
    const b = reveal.getBoundingClientRect();
    return { sameRow: Math.abs(a.top - b.top) < 4, gap: b.left - a.right };
  });
  expect(boxes.sameRow).toBe(true);
  expect(boxes.gap).toBeGreaterThanOrEqual(0);
});

test("phone Reveal passphrase aligns with the import button edge", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/identity");
  await expect(
    page.getByRole("form", { name: "Import an encrypted backup" }),
  ).toBeVisible();
  const positions = await page.evaluate(() => {
    const form = document.querySelector(
      'form[aria-label="Import an encrypted backup"]',
    )!;
    const buttons = [...form.querySelectorAll("button")];
    const submit = buttons.find(
      (b) => b.textContent?.trim() === "Open backup locally",
    )!;
    const reveal = buttons.find(
      (b) => b.textContent?.trim() === "Reveal passphrase",
    )!;
    const textX = (node: HTMLElement) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getClientRects()[0]?.left ?? 0;
    };
    return {
      submitLeft: submit.getBoundingClientRect().left,
      revealTextLeft: textX(reveal),
    };
  });
  expect(
    Math.abs(positions.revealTextLeft - positions.submitLeft),
  ).toBeLessThanOrEqual(2);
});
