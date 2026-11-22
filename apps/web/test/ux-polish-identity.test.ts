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

test("Check again honors a later stop, attempts each record once, and reports local failures", async ({
  page,
  context,
}) => {
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
  const ids = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return (await new LocalStore().list("outbox"))
      .sort((a: any, b: any) => a.order - b.order)
      .map((i: any) => i.id);
  });
  // A local storage failure is shown in the banner, with the evidence kept.
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    (window as any).origMerge = LocalStore.prototype.mergeOutbox;
    LocalStore.prototype.mergeOutbox = async function () {
      throw new DOMException(
        "Local storage quota exhausted.",
        "QuotaExceededError",
      );
    };
  });
  await banner.getByRole("button", { name: "Check again" }).click();
  await expect(banner.getByRole("alert")).toContainText(
    "The retry could not start in this browser",
  );
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    LocalStore.prototype.mergeOutbox = (window as any).origMerge;
  });
  await expect(banner).toContainText(/Acceptance:.*refused/);
  expect(pageErrors.join(" ")).not.toContain("quota");
  // One activation: one receipt lookup and one POST per record, transfer first.
  const trace: string[] = [];
  const observe = (request: any) => {
    if (request.url().includes("/receipts/"))
      trace.push(
        `GET ${decodeURIComponent(request.url()).includes(ids[1]) ? "accept" : "transfer"}`,
      );
    if (request.method() === "POST" && request.url().endsWith("/events"))
      trace.push(
        `POST ${request.postData()?.includes(ids[1]) ? "accept" : "transfer"}`,
      );
  };
  page.on("request", observe);
  await banner.getByRole("button", { name: "Check again" }).click();
  await expect
    .poll(() => trace.filter((entry) => entry === "POST accept").length)
    .toBe(1);
  await page.waitForTimeout(300);
  page.off("request", observe);
  expect(trace).toEqual([
    "GET transfer",
    "POST transfer",
    "GET accept",
    "POST accept",
  ]);
  // A stop in another tab during the transfer retry keeps the acceptance waiting.
  const other = await context.newPage();
  await other.goto("/outbox");
  const row = other.locator(`[data-outbox-record="${ids[1]}"]`).first();
  await expect(
    row.getByRole("button", { name: "Stop retrying" }),
  ).toBeVisible();
  await page.unroute("**/api/v1/events");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held!: () => void;
  const waiting = new Promise<void>((resolve) => (held = resolve));
  trace.length = 0;
  page.on("request", observe);
  await page.route("**/receipts/**", async (route) => {
    if (decodeURIComponent(route.request().url()).includes(ids[0])) {
      held();
      await gate;
    }
    await route.continue();
  });
  await banner.getByRole("button", { name: "Check again" }).click();
  await waiting;
  await row.getByRole("button", { name: "Stop retrying" }).click();
  await expect(row.getByRole("button", { name: "Resume" })).toBeVisible();
  release();
  await expect(banner).toContainText("Old key retired, acceptance waiting.");
  await page.waitForTimeout(300);
  page.off("request", observe);
  expect(trace.filter((entry) => entry === "POST accept")).toHaveLength(0);
  expect(trace.filter((entry) => entry === "GET accept")).toHaveLength(0);
  const accept = await page.evaluate(async (id) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const item = await new LocalStore().get("outbox", id);
    return {
      stopped: item.stopped,
      states: Object.values(item.peers).map((peer: any) => peer.state),
    };
  }, ids[1]);
  expect(accept.stopped).toBe(true);
  expect(accept.states).not.toContain("accepted");
  await other.close();
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

async function refusedHandover(page: Page) {
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
  const ids = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return (await new LocalStore().list("outbox"))
      .sort((a: any, b: any) => a.order - b.order)
      .map((i: any) => i.id);
  });
  return { banner, ids };
}

test("a receipt save failure says the outcome could not be saved", async ({
  page,
}) => {
  const { banner, ids } = await refusedHandover(page);
  await page.unroute("**/api/v1/events");
  await page.evaluate(async (target) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const original = LocalStore.prototype.mergeOutbox;
    let count = 0;
    LocalStore.prototype.mergeOutbox = async function (
      id: string,
      fn: never,
    ) {
      if (id === target && ++count === 2) {
        LocalStore.prototype.mergeOutbox = original;
        throw new DOMException("Cannot save receipt.", "QuotaExceededError");
      }
      return original.call(this, id, fn);
    };
  }, ids[0]);
  await banner.getByRole("button", { name: "Check again" }).click();
  await expect(banner.getByRole("alert")).toContainText(
    "The browser could not save the outcome",
  );
  await expect(banner.getByRole("alert")).not.toContainText(
    "could not start",
  );
  await banner.getByRole("button", { name: "Check again" }).click();
  await expect(banner).toContainText("Handover complete");
});

test("a one-time local write failure names the record and keeps its evidence", async ({
  page,
}) => {
  const { banner, ids } = await refusedHandover(page);
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/receipts/"))
      requests.push(
        `GET ${decodeURIComponent(request.url()).includes(ids[1]) ? "accept" : "transfer"}`,
      );
    if (request.method() === "POST" && request.url().endsWith("/events"))
      requests.push(
        `POST ${request.postData()?.includes(ids[1]) ? "accept" : "transfer"}`,
      );
  });
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const original = LocalStore.prototype.mergeOutbox;
    LocalStore.prototype.mergeOutbox = async function () {
      LocalStore.prototype.mergeOutbox = original;
      throw new DOMException(
        "Local storage quota exhausted.",
        "QuotaExceededError",
      );
    };
  });
  await banner.getByRole("button", { name: "Check again" }).click();
  await expect(banner.getByRole("alert")).toContainText(
    "The browser could not send the transfer: Local storage quota exhausted.",
  );
  await expect(banner).toContainText(/Transfer:.*refused/);
  await page.waitForTimeout(300);
  expect(
    requests.filter((entry) => entry.endsWith("transfer")),
  ).toEqual(["GET transfer"]);
});

test("an outbox read failure keeps the last evidence and shows the error", async ({
  page,
}) => {
  const { banner } = await refusedHandover(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const original = LocalStore.prototype.list;
    LocalStore.prototype.list = async function (store: string) {
      if (store === "outbox")
        throw new Error("Cannot read the local outbox.");
      return original.call(this, store);
    };
  });
  await banner.getByRole("button", { name: "Check again" }).click();
  await page.waitForTimeout(300);
  await expect(banner.getByRole("alert")).toContainText(
    "The browser could not read the saved delivery state",
  );
  await expect(banner).toContainText(/Transfer:.*refused/);
  expect(pageErrors.join(" ")).not.toContain("Cannot read the local outbox");
});

test("the saved publication page shows stopped records and offers no retry for them", async ({
  page,
  context,
}) => {
  await page.route("**/api/v1/events", (route) =>
    route.fulfill({
      status: 403,
      json: { code: "refused", message: "Refused.", event: null, field: null },
    }),
  );
  await createIdentity(page);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { newDraft } = await import(String("/src/model/draft.ts"));
    await new LocalStore().put(
      "drafts",
      "current",
      newDraft({
        spelling: "brode",
        kind: "gismu",
        meaning: "A disposable test meaning.",
        text: "A disposable test meaning.",
        structured: false,
        frameMode: "none",
        step: 5,
        rafsiClaims: [{ rafsi: "rod", rationale: "Disposable claim." }],
      }),
    );
  });
  await page.goto("/new/publish");
  await page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true })
    .click();
  const unlock = page.getByRole("dialog", { name: "Unlock your key" });
  await unlock.getByLabel("Passphrase").fill(PASSPHRASE);
  await unlock.getByRole("button", { name: "Unlock" }).click();
  const first = page.getByRole("dialog", {
    name: "Before your first public signature",
  });
  await expect(first).toBeVisible();
  await first.getByRole("button", { name: "Continue" }).click();
  const saved = page.getByRole("region", { name: "Saved publication" });
  await expect(saved).toContainText("Saved. Not delivered yet.");
  const other = await context.newPage();
  await other.goto("/outbox");
  await expect(
    other.getByRole("button", { name: "Stop retrying" }).first(),
  ).toBeVisible();
  await other.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    for (const item of await store.list("outbox"))
      await store.mergeOutbox(item.id, (stored: any) => ({
        ...stored,
        stopped: true,
      }));
  });
  await other.close();
  await page.reload();
  await expect(saved).toContainText("Saved. Not delivered yet.");
  await expect(saved).toContainText("Stopped.");
  await expect(saved).toContainText(/Resume in Not delivered/);
  await expect(saved).not.toContainText("sent again automatically");
  await expect(saved.getByRole("button", { name: "Try now" })).toHaveCount(0);
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

