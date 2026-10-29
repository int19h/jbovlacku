import { test, expect } from "@playwright/test";
import { fixture } from "./helpers.ts";

test("an unconfigured view declaration is never loaded or saved as a signed policy", async ({
  page,
}) => {
  const f = fixture();
  const sentinel = "jve1:" + "0".repeat(64);
  let declaration: "none" | "real" | "legacy" = "none";
  const sentinelFetches: string[] = [];
  const probes: string[] = [];
  await page.goto("/about");
  await page.route("**/api/v1/manifest", async (route) => {
    const response = await route.fetch();
    const manifest = await response.json();
    if (declaration === "legacy") {
      delete manifest.view;
      delete manifest.packages_available;
    } else {
      manifest.view = declaration === "none" ? sentinel : f.view;
      manifest.packages_available = false;
      manifest.packages = [];
      manifest.package_versions = [];
    }
    await route.fulfill({ response, json: manifest });
  });
  await page.route(
    `**/api/v1/events/${encodeURIComponent(sentinel)}*`,
    (route) => {
      sentinelFetches.push(route.request().url());
      return route.fulfill({
        status: 404,
        json: { message: "No selected policy." },
      });
    },
  );
  await page.route("**/api/v1/words/**", (route) => {
    probes.push(route.request().url());
    if (declaration === "legacy") return route.continue();
    return route.fulfill({ status: 503, json: { message: "No evaluation." } });
  });
  const unconfigured = await page.evaluate(async () => {
    const { loadSiteView } = await import(String("/src/data/view.ts"));
    const { syncRecords, RecordsError } = (await import(
      String("/src/data/records.ts")
    )) as typeof import("../src/data/records.ts");
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore("unconfigured-view-regression");
    const policy = await loadSiteView();
    let failure = null;
    try {
      await syncRecords(store);
    } catch (error) {
      failure = {
        recordsError: error instanceof RecordsError,
        kind: error instanceof RecordsError ? error.kind : null,
        message: (error as Error).message,
      };
    }
    return { policy, failure, saved: await store.keys("inventory") };
  });
  expect(unconfigured.policy).toEqual({
    id: "",
    body: null,
    error: "The server did not report its selected view.",
  });
  expect(unconfigured.failure).toEqual({
    recordsError: true,
    kind: "invalid",
    message: "The server did not report its selected view.",
  });
  expect(unconfigured.saved).toEqual([]);
  expect(sentinelFetches).toEqual([]);
  expect(probes).toEqual([]);
  await page.goto("/trust");
  await expect(page.locator("main")).toContainText(
    "The server did not report its selected view.",
  );
  await expect(page.locator("main")).not.toContainText(sentinel);

  const readSelection = async (selected: string | null) =>
    page.evaluate(async (selected) => {
      const { setPreferredView } = await import(String("/src/data/api.ts"));
      const { loadSiteView } = await import(String("/src/data/view.ts"));
      const { syncRecords } = await import(String("/src/data/records.ts"));
      const { LocalStore } = (await import(
        String("/src/data/store.ts")
      )) as typeof import("../src/data/store.ts");
      const store = new LocalStore("unconfigured-view-regression");
      setPreferredView(selected);
      const policy = await loadSiteView();
      const inventory = await syncRecords(store);
      const saved = await store.get<{ view: string }>("inventory", "latest");
      setPreferredView(null);
      return { policy, view: inventory.view, savedView: saved?.view };
    }, selected);
  // A real reader selection overrides the absent server selection without evaluation.
  const preferred = await readSelection(f.views.shun);
  expect(preferred.policy.id).toBe(f.views.shun);
  expect(preferred.policy.error).toBeNull();
  expect(preferred.policy.body).not.toBeNull();
  expect(preferred.view).toBe(f.views.shun);
  expect(preferred.savedView).toBe(f.views.shun);
  declaration = "real";
  const configured = await readSelection(null);
  expect(configured.policy.id).toBe(f.view);
  expect(configured.policy.error).toBeNull();
  expect(configured.view).toBe(f.view);
  expect(configured.savedView).toBe(f.view);
  expect(sentinelFetches).toEqual([]);
  expect(probes).toEqual([]);
  declaration = "legacy";
  const legacy = await readSelection(null);
  expect(legacy.policy.id).toBe(f.view);
  expect(legacy.policy.error).toBeNull();
  expect(legacy.view).toBe(f.view);
  expect(legacy.savedView).toBe(f.view);
  expect(probes.length).toBeGreaterThan(0);
  expect(sentinelFetches).toEqual([]);
});

test("unavailable package discovery preserves record sync, own history, signed policy inspection, and cached packages", async ({
  page,
}) => {
  const f = fixture();
  await page.goto("/preferences");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.locator("#app > [role=status]")).toHaveText(
    "The English search package is saved in this browser.",
  );
  let legacy = false;
  let malformed: Record<string, unknown> | null = null;
  const blocked: string[] = [];
  const probes: string[] = [];
  // The service regression uses a real evaluation limit. This browser case simulates that network response.
  await page.route("**/api/v1/manifest", async (route) => {
    const response = await route.fetch();
    const manifest = await response.json();
    if (legacy) {
      delete manifest.view;
      delete manifest.packages_available;
    } else {
      manifest.view = f.view;
      manifest.packages_available = false;
      manifest.packages = [];
      manifest.package_versions = [];
    }
    await route.fulfill({ response, json: { ...manifest, ...malformed } });
  });
  await page.route("**/api/v1/words/**", (route) => {
    probes.push(route.request().url());
    if (legacy) return route.continue();
    blocked.push(route.request().url());
    return route.fulfill({
      status: 503,
      json: {
        code: "resource_unavailable",
        message: "Synthetic unavailable evaluation.",
        event: null,
        field: null,
      },
    });
  });
  await page.route("**/api/v1/packages/**", (route) => {
    if (legacy) return route.continue();
    blocked.push(route.request().url());
    return route.fulfill({
      status: 503,
      json: {
        code: "resource_unavailable",
        message: "Synthetic unavailable packages.",
        event: null,
        field: null,
      },
    });
  });
  const result = await page.evaluate(
    async ({ identity, selected }) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { syncRecords, loadRecords } = await import(
        String("/src/data/records.ts")
      );
      const { loadOwnHistory } = await import(String("/src/data/history.ts"));
      const { loadSiteView } = await import(String("/src/data/view.ts"));
      const { setPreferredView } = await import(String("/src/data/api.ts"));
      const { downloadPackage } = await import(String("/src/data/search.ts"));
      const store = new LocalStore();
      const cached = await store.get("packages", "en");
      const inventory = await syncRecords(store);
      const records = await loadRecords(store, inventory);
      const history = await loadOwnHistory(store, identity);
      const policy = await loadSiteView();
      let downloadError = "";
      try {
        await downloadPackage("en");
      } catch (error) {
        downloadError = (error as Error).message;
      }
      setPreferredView(selected);
      const preferred = await loadSiteView();
      const preferredInventory = await syncRecords(store);
      setPreferredView(null);
      return {
        inventory,
        count: records.events.length,
        history: { complete: history.complete, snapshot: history.snapshot },
        policy,
        preferred,
        preferredInventoryView: preferredInventory.view,
        downloadError,
        retained:
          JSON.stringify(cached) ===
          JSON.stringify(await store.get("packages", "en")),
      };
    },
    { identity: f.identities.author, selected: f.views.shun },
  );
  expect(result.count).toBeGreaterThan(0);
  expect(result.inventory.view).toBe(f.view);
  expect(result.history.complete).toBe(true);
  expect(result.history.snapshot).toBe(result.inventory.snapshot);
  expect(result.policy.id).toBe(f.view);
  expect(result.policy.body).not.toBeNull();
  expect(result.policy.error).toBeNull();
  expect(result.preferred.id).toBe(f.views.shun);
  expect(result.preferredInventoryView).toBe(f.views.shun);
  expect(result.downloadError).toContain(
    "Search packages are temporarily unavailable.",
  );
  expect(result.retained).toBe(true);
  expect(blocked).toEqual([]);
  await page.goto("/trust");
  await expect(page.locator("main")).toContainText(f.view);
  await page.goto("/preferences");
  await expect(
    page.getByText(
      "Search packages are temporarily unavailable. The service cannot evaluate publication receipts.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("This server offers no search package yet.", {
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(page.getByText(/definitions · snapshot/)).toBeVisible();
  expect(blocked).toEqual([]);
  for (const invalid of [
    { packages_available: "false" },
    { view: "invalid" },
  ]) {
    malformed = invalid;
    expect(
      await page.evaluate(async () => {
        const { getManifest } = await import(String("/src/data/api.ts"));
        try {
          await getManifest();
          return "accepted";
        } catch (error) {
          return (error as Error).message;
        }
      }),
    ).toBe("The server returned an invalid manifest.");
  }
  malformed = null;
  legacy = true;
  const old = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { syncRecords } = await import(String("/src/data/records.ts"));
    const { loadSiteView } = await import(String("/src/data/view.ts"));
    const { downloadPackage } = await import(String("/src/data/search.ts"));
    return {
      inventory: await syncRecords(new LocalStore()),
      policy: await loadSiteView(),
      package: await downloadPackage("en"),
    };
  });
  expect(old.inventory.view).toBe(f.view);
  expect(old.policy.id).toBe(f.view);
  expect(old.package.entries.length).toBeGreaterThan(0);
  expect(probes.length).toBeGreaterThan(0);
});
