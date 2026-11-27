import { test, expect } from "@playwright/test";
import { fixture } from "./helpers.ts";

test("a selected-view lookup for another snapshot stops the record sync", async ({
  page,
}) => {
  const other = "sha256:" + "6".repeat(64);
  await page.goto("/about");
  // An older server omits the manifest view, so the sync asks the zero word.
  await page.route("**/api/v1/manifest", async (route) => {
    const response = await route.fetch();
    const manifest = await response.json();
    delete manifest.view;
    delete manifest.packages_available;
    await route.fulfill({ response, json: manifest });
  });
  const lookups: string[] = [];
  const zeroWord = "0".repeat(64);
  await page.route("**/api/v1/words/**", async (route) => {
    if (!route.request().url().includes(zeroWord)) return route.continue();
    lookups.push(route.request().url());
    const response = await route.fetch();
    const word = await response.json();
    await route.fulfill({ response, json: { ...word, snapshot: other } });
  });
  const result = await page.evaluate(async () => {
    const { syncRecords, RecordsError } = (await import(
      String("/src/data/records.ts")
    )) as typeof import("../src/data/records.ts");
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore("selected-view-snapshot-pin");
    try {
      await syncRecords(store);
      return { failure: null, saved: await store.keys("inventory") };
    } catch (error) {
      return {
        failure: {
          recordsError: error instanceof RecordsError,
          message: (error as Error).message,
        },
        saved: await store.keys("inventory"),
      };
    }
  });
  expect(lookups).toHaveLength(1);
  expect(result.failure).toEqual({
    recordsError: true,
    message: "The server reported its selected view for another snapshot.",
  });
  expect(result.saved).toEqual([]);
});

test("the definition page rejects a receipt for another record", async ({
  page,
}) => {
  const id = fixture().definitions.cukta1;
  const other = "jve1:" + "0".repeat(64);
  await page.route("**/api/v1/receipts/**", async (route) => {
    const response = await route.fetch();
    const receipt = await response.json();
    await route.fulfill({ response, json: { ...receipt, id: other } });
  });
  await page.goto(`/definition/${encodeURIComponent(id)}`);
  await expect(page.locator("main")).toContainText(
    "The server returned a receipt for another record.",
  );
  await expect(page.locator("main")).not.toContainText(
    "This server: admission",
  );
});
