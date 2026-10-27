import { test, expect, type Page } from "@playwright/test";
import { corePath } from "./helpers.ts";

/** A real delivery subscription with controlled storage and retry completion. */
async function savedView(page: Page, failure = "none") {
  await page.route("**/saved-view-harness", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><main></main>",
    }),
  );
  await page.goto("/saved-view-harness");
  await page.evaluate(
    async ({ corePath, failure }) => {
      const core = await import(corePath);
      await core.initializeCore();
      const { publishPage } = await import(
        String("/src/pages/wizard/publish.ts")
      );
      const { DeliveryEngine, freshPeer } = await import(
        String("/src/data/delivery.ts")
      );
      const main = document.querySelector("main")!;
      const controller = new AbortController();
      let failed = failure;
      let holdReads = false;
      const readReleases: (() => void)[] = [];
      let items = [0, 1].map((order) => ({
        id: `jve1:${String(order).repeat(64)}`,
        identity: "test",
        group: "group",
        order,
        signedAt: order,
        stopped: false,
        transport: "{}",
        label: { action: "signed record", subject: String(order), href: "/" },
        peers: {
          self: {
            ...freshPeer(),
            state: "unknown",
            attempts: 1,
            nextAttempt: null,
            failure: "server",
            error: "Test failure.",
          },
        },
      }));
      const record = {
        ids: items.map((item) => item.id),
        group: "group",
        revision: "saved",
      };
      const store = {
        async savedDrafts() {
          return [];
        },
        async get(name: string, key: string) {
          if (name === "outbox" && holdReads)
            await new Promise<void>((resolve) => readReleases.push(resolve));
          if (
            (name === "outbox" && failed === "outbox") ||
            (name === "drafts" &&
              key === "published:last" &&
              failed === "metadata") ||
            (name === "drafts" && key === "current" && failed === "draft")
          )
            throw new Error("Injected read failure");
          return name === "outbox"
            ? items.find((item) => item.id === key)
            : key === "published:last"
              ? record
              : undefined;
        },
        async list() {
          if (failed === "outbox") throw new Error("Injected read failure");
          return structuredClone(items);
        },
      };
      const delivery = new DeliveryEngine(store as any);
      const app = {
        store,
        delivery,
        session: { storageAvailable: true },
        announce() {},
      };
      const context = {
        main,
        signal: controller.signal,
        live: () => !controller.signal.aborted,
        title() {},
      };
      const calls: string[] = [];
      const releases: (() => void)[] = [];
      delivery.tryNow = async (id: string) => {
        calls.push(id);
        const item = items.find((item) => item.id === id)!;
        item.peers.self.error = `Retry failure ${calls.length}.`;
        await delivery.invalidate();
        await new Promise<void>((resolve) => releases.push(resolve));
        return item;
      };
      (window as any).savedHarness = {
        calls,
        releases,
        readReleases,
        holdReads() {
          holdReads = true;
        },
        releaseReads() {
          holdReads = false;
          readReleases.splice(0).forEach((release) => release());
        },
        setFailure(value: string) {
          failed = value;
        },
        async update(visible: boolean) {
          for (const item of items) {
            item.peers.self.attempts++;
            (item.peers.self as any).lastAttempt = Date.now();
            (item.peers.self as any).receipt = {
              synthetic: "ignored metadata",
            };
            if (visible) item.peers.self.error += " Again.";
          }
          await delivery.invalidate();
        },
        async notify() {
          await delivery.invalidate();
        },
        async missing() {
          items = [];
          await delivery.invalidate();
        },
        abort() {
          controller.abort();
        },
      };
      await publishPage({} as any, context as any, app as any);
    },
    { corePath, failure },
  );
}

test("saved publication updates preserve controls and announce only a short changed status", async ({
  page,
}) => {
  await savedView(page);
  const saved = page.getByRole("region", { name: "Saved publication" });
  const retry = saved.getByRole("button", { name: "Try now", exact: true });
  const open = saved.getByRole("link", {
    name: "Open the record",
    exact: true,
  });
  await expect(retry).toBeVisible();
  await expect(saved.locator("[aria-live]")).toHaveCount(1);
  await expect(saved.locator("[aria-live]")).toHaveText(
    "Saved. Not delivered yet.",
  );
  await expect(saved.locator("ul[aria-live], [aria-live] ul")).toHaveCount(0);
  await page.evaluate(() => {
    const live = document.querySelector(
      '[aria-label="Saved publication"] [aria-live]',
    )!;
    (window as any).liveChanges = 0;
    new MutationObserver(() => (window as any).liveChanges++).observe(live, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
  for (const action of [retry, open]) {
    await action.focus();
    await action.evaluate((node) => node.setAttribute("data-retained", "yes"));
    await page.evaluate(() => (window as any).savedHarness.update(false));
    await expect(action).toBeFocused();
    await expect(action).toHaveAttribute("data-retained", "yes");
    await page.evaluate(() => (window as any).savedHarness.update(true));
    await expect(action).toBeFocused();
  }
  expect(await page.evaluate(() => (window as any).liveChanges)).toBe(0);
});

test("a saved group keeps one disabled retry loop through every redraw", async ({
  page,
}) => {
  await savedView(page);
  const saved = page.getByRole("region", { name: "Saved publication" });
  const retry = saved.getByRole("button", { name: "Try now", exact: true });
  const open = saved.getByRole("link", {
    name: "Open the record",
    exact: true,
  });
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(retry).toBeDisabled();
  await expect(open).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).savedHarness.releases.length),
    )
    .toBe(1);
  // A dispatched event bypasses the native disabled-button protection and tests the shared guard.
  await retry.dispatchEvent("click");
  expect(
    await page.evaluate(() => (window as any).savedHarness.calls.length),
  ).toBe(1);
  await page.evaluate(() => (window as any).savedHarness.releases[0]());
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).savedHarness.releases.length),
    )
    .toBe(2);
  await expect(retry).toBeDisabled();
  await retry.dispatchEvent("click");
  expect(
    await page.evaluate(() => (window as any).savedHarness.calls.length),
  ).toBe(2);
  await page.evaluate(() => {
    (window as any).savedHarness.holdReads();
    (window as any).savedHarness.releases[1]();
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).savedHarness.readReleases.length),
    )
    .toBe(2);
  await expect(retry).toBeDisabled();
  await retry.dispatchEvent("click");
  expect(
    await page.evaluate(() => (window as any).savedHarness.calls.length),
  ).toBe(2);
  await page.evaluate(() => (window as any).savedHarness.releaseReads());
  await expect(retry).toBeEnabled();
  await expect(open).toBeFocused();
});

for (const failure of ["draft", "metadata", "outbox"]) {
  test(`a saved publication recovers from an initial ${failure} read failure without reporting missing records`, async ({
    page,
  }) => {
    await savedView(page, failure);
    await expect(
      page.getByRole("button", { name: "Retry reading", exact: true }),
    ).toBeVisible();
    await expect(page.locator("main")).toContainText("could not read");
    await expect(page.locator("main")).not.toContainText("no longer available");
    await expect(page.locator("main")).not.toContainText("Start a new draft");
    await expect(
      page.getByRole("button", { name: "Publish", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Retry reading", exact: true })
      .click();
    await expect(page.locator("main")).toContainText("could not read");
    await page.evaluate(() => (window as any).savedHarness.setFailure("none"));
    await page
      .getByRole("button", { name: "Retry reading", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Saved publication" }),
    ).toContainText("Saved. Not delivered yet.");
    await expect(
      page.getByRole("button", { name: "Try now", exact: true }),
    ).toBeEnabled();
    if (failure !== "outbox")
      await expect(page.locator("main h1")).toBeFocused();
  });
}

test("failed saved-publication notifications keep known records and safe controls until reading succeeds", async ({
  page,
}) => {
  await savedView(page);
  const saved = page.getByRole("region", { name: "Saved publication" });
  const retry = saved.getByRole("button", { name: "Try now", exact: true });
  const open = saved.getByRole("link", {
    name: "Open the record",
    exact: true,
  });
  await expect(retry).toBeVisible();
  await open.focus();
  await page.evaluate(async () => {
    (window as any).savedHarness.setFailure("outbox");
    await (window as any).savedHarness.notify();
  });
  await expect(saved).toContainText("could not read");
  await expect(saved).not.toContainText("no longer available");
  await expect(saved.locator("li")).toHaveCount(2);
  await expect(open).toBeFocused();
  await expect(retry).toBeDisabled();
  await retry.dispatchEvent("click");
  expect(
    await page.evaluate(() => (window as any).savedHarness.calls.length),
  ).toBe(0);
  for (let attempt = 0; attempt < 2; attempt++) {
    await saved
      .getByRole("button", { name: "Retry reading", exact: true })
      .click();
    await expect(saved).toContainText("could not read");
    await expect(retry).toBeDisabled();
  }
  await page.evaluate(() => {
    (window as any).savedHarness.setFailure("none");
    (window as any).savedHarness.holdReads();
  });
  await saved
    .getByRole("button", { name: "Retry reading", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).savedHarness.readReleases.length),
    )
    .toBe(2);
  await open.focus();
  await page.evaluate(() => (window as any).savedHarness.releaseReads());
  await expect(retry).toBeEnabled();
  await expect(open).toBeFocused();
  await page.evaluate(async () => {
    (window as any).savedHarness.setFailure("outbox");
    await (window as any).savedHarness.notify();
    (window as any).savedHarness.setFailure("none");
  });
  await saved
    .getByRole("button", { name: "Retry reading", exact: true })
    .click();
  await expect(
    saved.getByText(
      "The browser could not read these saved records. They were not changed. Try reading them again.",
      { exact: true },
    ),
  ).toBeHidden();
  await expect(saved.locator("[aria-live]")).toHaveText(
    "Saved. Not delivered yet.",
  );
  await expect(retry).toBeEnabled();
  await expect(retry).toBeFocused();
  await page.evaluate(() => (window as any).savedHarness.missing());
  await expect(saved).toContainText(
    "These saved records are no longer available in this browser.",
  );
  await expect(
    saved.getByRole("button", { name: "Retry reading", exact: true }),
  ).toBeHidden();
  await expect(retry).toHaveCount(0);
  await expect(open).toHaveCount(0);
});
