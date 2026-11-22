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

test("handover banner keeps the delivery link out of the sentence and follows delivery updates", async ({
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
  ).toHaveCount(0);
  const sentence = banner.getByText(
    "Retries reuse the stored events and look the receipt up by event ID first. No replacement acceptance is ever signed automatically. Retry or resume delivery from Not delivered.",
    { exact: true },
  );
  await expect(sentence).toBeVisible();
  await expect(sentence.getByRole("link")).toHaveCount(0);
  // Delivery from a second page of the same browser updates this banner
  // through the delivery notification, without any manual re-check.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const other = await page.context().newPage();
  await other.goto("/outbox");
  await other.getByRole("button", { name: "Try now" }).click();
  await expect(other.locator("#app > [role=status]")).toHaveText("Delivered.");
  await other.close();
  const notDelivered = banner.getByRole("link", { name: "Not delivered" });
  await notDelivered.focus();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
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
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  const search = page.getByLabel("Search words and meanings");
  await search.focus();
  await expect(search).toBeFocused();
  await page.waitForTimeout(700);
  await expect(search).toBeFocused();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("banner notifications restore focus to the same control", async ({
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
});

async function refusedBanner(page: Page) {
  await createIdentity(page);
  await page.route("**/api/v1/events", (route) =>
    route.fulfill({
      status: 403,
      json: { code: "refused", message: "Refused.", event: null, field: null },
    }),
  );
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
  await expect(banner).toContainText(/Acceptance:.*refused/);
  return banner;
}

async function deliverFromOtherPage(page: Page, context: any) {
  const other = await context.newPage();
  await other.goto("/outbox");
  const row = other
    .locator("[data-outbox-record]")
    .filter({ hasText: /accept/i })
    .filter({ has: other.getByRole("button", { name: "Try now" }) });
  await row.getByRole("button", { name: "Try now" }).click();
  await expect(other.locator("#app > [role=status]")).toHaveText("Delivered.");
  const stored = await other.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return (await new LocalStore().list("outbox")).map(
      (item: any) => item.peers.self.state,
    );
  });
  expect(stored).toEqual(["accepted", "accepted"]);
  await other.close();
}

test("a failed newer banner read does not cancel an older successful one", async ({
  page,
  context,
}) => {
  const banner = await refusedBanner(page);
  await deliverFromOtherPage(page, context);
  await expect(banner).toContainText(/Acceptance:.*refused/);
  const wake = () =>
    page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const original = LocalStore.prototype.list;
    const trace: string[] = [];
    (window as any).traceReads = trace;
    LocalStore.prototype.list = async function (store: string) {
      if (
        store !== "outbox" ||
        !new Error().stack?.includes("handoverState")
      )
        return original.call(this, store);
      if (trace.length === 0) {
        trace.push("first started");
        const rows = await original.call(this, store);
        trace.push("first read");
        await new Promise<void>(
          (resolve) => ((window as any).releaseGood = resolve),
        );
        trace.push("first returned");
        return rows;
      }
      if (trace.length === 2) {
        trace.push("second read error");
        throw new DOMException("One outbox read failed.", "AbortError");
      }
      return original.call(this, store);
    };
  });
  const trace = () => page.evaluate(() => (window as any).traceReads as string[]);
  await wake();
  await expect.poll(trace).toHaveLength(2);
  await wake();
  await expect.poll(trace).toHaveLength(3);
  await page.evaluate(() => (window as any).releaseGood());
  await expect.poll(trace).toHaveLength(4);
  await expect(banner).toContainText("Handover complete");
});

test("an older banner read does not overwrite a newer shown result", async ({
  page,
  context,
}) => {
  const banner = await refusedBanner(page);
  await deliverFromOtherPage(page, context);
  await expect(banner).toContainText(/Acceptance:.*refused/);
  const wake = () =>
    page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const original = LocalStore.prototype.list;
    let calls = 0;
    (window as any).bannerReadCalls = () => calls;
    LocalStore.prototype.list = async function (store: string) {
      if (
        store !== "outbox" ||
        !new Error().stack?.includes("handoverState")
      )
        return original.call(this, store);
      calls++;
      if (calls === 1) {
        const rows = await original.call(this, store);
        const stale = rows.map((row: any) => ({
          ...row,
          peers: Object.fromEntries(
            Object.entries(row.peers).map(([id, peer]: [string, any]) => [
              id,
              { ...peer, state: "refused" },
            ]),
          ),
        }));
        await new Promise<void>(
          (resolve) => ((window as any).releaseStale = resolve),
        );
        return stale;
      }
      return original.call(this, store);
    };
  });
  await wake();
  await expect
    .poll(() => page.evaluate(() => (window as any).bannerReadCalls()))
    .toBe(1);
  await wake();
  await expect(banner).toContainText("Handover complete");
  await page.evaluate(() => (window as any).releaseStale());
  await page.waitForTimeout(300);
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

test("unlock keeps the reading position when the reader clicks prose during the wait", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 550 });
  await createIdentity(page);
  await page.getByRole("button", { name: "Lock", exact: true }).click();
  await page.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
  await page.evaluate(async () => {
    const { Session } = await import(String("/src/app/session.ts"));
    const original = Session.prototype.unlock;
    Session.prototype.unlock = async function (...args: any[]) {
      await new Promise<void>(
        (resolve) => ((window as any).releaseUnlock = resolve),
      );
      return original.apply(this, args as any);
    };
  });
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page
    .getByText(/This site supplies the code that uses your key/)
    .click();
  const during = await page.evaluate(() => ({
    y: window.scrollY,
    tag: document.activeElement?.tagName,
  }));
  expect(during.tag).toBe("BODY");
  await page.evaluate(() => (window as any).releaseUnlock());
  await expect(page.getByText("Unlocked", { exact: true })).toBeAttached();
  await page.waitForTimeout(300);
  const settled = await page.evaluate(() => ({
    y: window.scrollY,
    tag: document.activeElement?.tagName,
  }));
  expect(settled.tag).toBe("BODY");
  expect(Math.abs(settled.y - during.y)).toBeLessThanOrEqual(40);
});

test("a failed import keeps focus moved to the backup file field", async ({
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
  await form.getByLabel("Backup passphrase").fill("incorrect passphrase");
  await page.evaluate(() => {
    const original = File.prototype.text;
    File.prototype.text = async function () {
      File.prototype.text = original;
      await new Promise<void>(
        (resolve) => ((window as any).continueFile = resolve),
      );
      return original.call(this);
    };
  });
  await form.getByRole("button", { name: "Open backup locally" }).click();
  await form.getByLabel("Backup file").focus();
  await expect(form.getByLabel("Backup file")).toBeFocused();
  await page.evaluate(() => (window as any).continueFile());
  await expect(form.getByRole("alert")).toBeVisible();
  await expect(form.getByLabel("Backup file")).toBeFocused();
});

test("a passing backup test keeps focus moved to the download control", async ({
  page,
}) => {
  const backup = await createIdentity(page);
  const download = page.getByRole("button", {
    name: "Download the encrypted backup",
  });
  await page.getByRole("button", { name: "Test the backup" }).click();
  const testForm = page.getByRole("form", { name: "Test the backup" });
  await testForm.getByLabel("Backup file").setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await testForm.getByLabel("Backup passphrase").fill(PASSPHRASE);
  await page.evaluate(() => {
    const original = File.prototype.text;
    File.prototype.text = async function () {
      File.prototype.text = original;
      await new Promise<void>(
        (resolve) => ((window as any).continueFile = resolve),
      );
      return original.call(this);
    };
  });
  await testForm.getByRole("button", { name: "Run the test" }).click();
  await download.focus();
  await expect(download).toBeFocused();
  await page.evaluate(() => (window as any).continueFile());
  await expect(
    page.getByText("Your backup test passed in this browser."),
  ).toBeVisible();
  await expect(download).toBeFocused();
});

test("six emoji do not satisfy the 12-character minimum", async ({ page }) => {
  const emoji = "😀".repeat(6);
  expect([...emoji].length).toBe(6);
  await page.goto("/identity");
  await page.getByLabel("New passphrase", { exact: true }).fill(emoji);
  await page.getByLabel("Repeat passphrase").fill(emoji);
  await page.getByRole("button", { name: "Create a key" }).click();
  await expect(
    page.getByRole("form", { name: "Create a key" }).getByRole("alert"),
  ).toHaveText("Use at least 12 characters.");
  await createIdentity(page);
  await page.getByRole("link", { name: "Start" }).click();
  await page.getByLabel("New passphrase for the new key").fill(emoji);
  await page.getByLabel("Repeat passphrase").fill(emoji);
  await page.getByRole("button", { name: "Create the new key" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Use at least 12 characters.",
  );
});

test("a failed import keeps focus on the body after the reader clicks prose", async ({
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
  await form.getByLabel("Backup passphrase").fill("incorrect passphrase");
  await page.evaluate(() => {
    const original = File.prototype.text;
    File.prototype.text = async function () {
      File.prototype.text = original;
      await new Promise<void>(
        (resolve) => ((window as any).continueFile = resolve),
      );
      return original.call(this);
    };
  });
  // Submit with focus on the body, then click prose while the read is held.
  await page
    .getByText(/This site supplies the code that uses your key/)
    .click();
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(
    "BODY",
  );
  await page.evaluate(() => {
    document
      .querySelector<HTMLFormElement>(
        'form[aria-label="Import an encrypted backup"]',
      )!
      .requestSubmit();
  });
  await page
    .getByText(/This site supplies the code that uses your key/)
    .click();
  await page.evaluate(() => (window as any).continueFile());
  await expect(form.getByRole("alert")).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(
    "BODY",
  );
});

test("successful key work removes its window focus listeners", async ({
  page,
}) => {
  const backup = await (async () => {
    await page.goto("/identity");
    await page.evaluate(() => {
      const w = window as any;
      w.__added = 0;
      w.__removed = 0;
      const add = EventTarget.prototype.addEventListener;
      const remove = EventTarget.prototype.removeEventListener;
      EventTarget.prototype.addEventListener = function (
        type: string,
        ...rest: any[]
      ) {
        if (this === window && (type === "pointerdown" || type === "keydown"))
          w.__added++;
        return (add as any).apply(this, [type, ...rest]);
      };
      EventTarget.prototype.removeEventListener = function (
        type: string,
        ...rest: any[]
      ) {
        if (this === window && (type === "pointerdown" || type === "keydown"))
          w.__removed++;
        return (remove as any).apply(this, [type, ...rest]);
      };
    });
    await page.getByLabel("New passphrase", { exact: true }).fill(PASSPHRASE);
    await page.getByLabel("Repeat passphrase").fill(PASSPHRASE);
    await page.getByRole("button", { name: "Create a key" }).click();
    await expect(page.getByText("Unlocked", { exact: true })).toBeVisible();
    const afterCreate = await page.evaluate(() => {
      const w = window as any;
      return { added: w.__added, removed: w.__removed };
    });
    expect(afterCreate.removed).toBe(afterCreate.added);
    return page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      return new LocalStore().get("keys", "selected");
    });
  })();
  for (let round = 0; round < 2; round++) {
    await page.getByRole("button", { name: "Import", exact: true }).click();
    const form = page.getByRole("form", {
      name: "Import an encrypted backup",
    });
    await form.getByLabel("Backup file").setInputFiles({
      name: "backup.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(backup)),
    });
    await form.getByLabel("Backup passphrase").fill(PASSPHRASE);
    await form.getByRole("button", { name: "Open backup locally" }).click();
    await expect(
      page.locator("#app > [role=status]"),
    ).toHaveText("The backup opened locally. Keep the file in a safe place.");
    await expect(form).toBeHidden();
    const afterImport = await page.evaluate(() => {
      const w = window as any;
      return { added: w.__added, removed: w.__removed };
    });
    expect(afterImport.removed).toBe(afterImport.added);
  }
  const counts = await page.evaluate(() => {
    const w = window as any;
    return { added: w.__added, removed: w.__removed };
  });
  expect(counts.added).toBeGreaterThan(0);
  expect(counts.removed).toBe(counts.added);
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

