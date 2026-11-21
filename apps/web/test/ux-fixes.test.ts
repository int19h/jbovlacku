import { test, expect, type Page } from "@playwright/test";
import { acceptFirstSignature, createIdentity } from "./helpers.ts";
import { typeRichText } from "./rich-helpers.ts";

/** The languages of the packages in the browser store. */
async function storedPackageKeys(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().keys("packages");
  });
}

/** The Settings status line of a page. */
const statusText = (page: Page) => page.locator("div.status[role=status]");

/** Holds every package request on this page until `release` is called. With `fail`, the release aborts the request instead of letting it through. */
function holdPackageRequests(page: Page, fail = false) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  void page.route("**/api/v1/packages/**", async (route) => {
    started++;
    await gate;
    if (fail) await route.abort();
    else await route.continue();
  });
  return { release: () => release(), started: () => started };
}

/** Offers French beside English in the manifest, as the server offers only English. */
async function offerFrench(page: Page): Promise<void> {
  await page.route("**/api/v1/manifest*", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    const en =
      json.packages.find(
        (pkg: { language: string }) => pkg.language === "en",
      ) ?? json.packages[0];
    json.packages = [...json.packages, { ...en, language: "fr" }];
    await route.fulfill({ response, json });
  });
}

/** Stores a small French package directly, as another download could. */
async function storeFrench(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().put("packages", "fr", {
      snapshot: "sha256:" + "a".repeat(64),
      version: 2,
      entries: [],
    });
  });
}

for (const path of ["/word/", "/word/%20"]) {
  test(`a blank word link at ${path} shows the friendly unavailable page`, async ({
    page,
  }) => {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { name: "Page unavailable" }),
    ).toBeVisible();
    await expect(page).toHaveTitle("Page unavailable · jbovlacku");
    await expect(page.locator("main")).toContainText(
      "This link does not name a word.",
    );
    await expect(page.locator("main")).not.toContainText('{"code"');
  });
}

test("biography paragraphs stay separate in the preview and on the public profile", async ({
  page,
}) => {
  const identity = (await createIdentity(page)).identity as string;
  await page.getByRole("link", { name: "Edit public profile" }).click();
  const editor = page.getByRole("region", { name: "Edit public profile" });
  await editor.getByLabel("Name", { exact: true }).fill("Paragraph Tester");
  await typeRichText(
    editor.getByLabel("Biography", { exact: true }),
    "mi cuntu la lojban\n\nsecond para",
  );
  await editor
    .getByRole("button", { name: "Preview the signed claim" })
    .click();
  const preview = page.getByRole("region", { name: "Profile preview" });
  await expect(preview).toBeVisible();
  const previewText = await preview.innerText();
  expect(previewText).not.toContain("lojbansecond");
  expect(previewText).toContain("mi cuntu la lojban\nsecond para");
  await preview
    .getByRole("button", { name: "Sign and publish the profile" })
    .click();
  await acceptFirstSignature(page);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "The profile is signed and published." }),
  ).toHaveText("The profile is signed and published.");
  await expect
    .poll(() => page.url())
    .toContain(`/identity/${encodeURIComponent(identity)}`);
  await expect
    .poll(async () => page.locator("main").innerText(), { timeout: 20000 })
    .toContain("mi cuntu la lojban\nsecond para");
  const profileText = await page.locator("main").innerText();
  expect(profileText).not.toContain("lojbansecond");
  // The signed record itself keeps the two paragraphs separate.
  const bio = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const [item] = await new LocalStore().list("outbox");
    return JSON.parse(item.transport).body.bio;
  });
  expect(bio).toEqual([["mi cuntu la lojban"], ["second para"]]);
});

test("removing a package during its refresh keeps it removed", async ({
  page,
}) => {
  await page.goto("/preferences");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.locator("div.status[role=status]")).toContainText(
    "The English search package is saved in this browser.",
  );
  await expect(
    page.getByRole("button", { name: "Refresh English" }),
  ).toBeVisible();
  // Hold the refresh download open so Remove lands while it runs.
  const held = holdPackageRequests(page);
  const responseDone = page.waitForResponse(
    (response) => response.url().includes("/api/v1/packages/") && response.ok(),
  );
  await page.getByRole("button", { name: "Refresh English" }).click();
  await expect.poll(() => held.started()).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(
    page.getByRole("button", { name: "Refresh English" }),
  ).toHaveCount(0);
  expect(await storedPackageKeys(page)).toEqual([]);
  // Wait for the held refresh itself to end: its response completes and
  // its status reports the outcome of the save attempt.
  held.release();
  await responseDone;
  await expect(statusText(page)).toContainText(
    /package is refreshed|package was not saved/,
  );
  expect(await storedPackageKeys(page)).toEqual([]);
  await page.reload();
  await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(0);
  expect(await storedPackageKeys(page)).toEqual([]);
});

test("a download that finishes after a remove in another tab does not save", async ({
  context,
}) => {
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  await tabA.goto("/preferences");
  await expect(
    tabA.getByRole("button", { name: "Download", exact: true }),
  ).toBeVisible();
  // Tab A's download is held open while tab B downloads and removes.
  const held = holdPackageRequests(tabA);
  await tabA.getByRole("button", { name: "Download", exact: true }).click();
  await expect.poll(() => held.started()).toBeGreaterThan(0);
  await tabB.goto("/preferences");
  await tabB.getByRole("button", { name: "Download", exact: true }).click();
  await expect(tabB.locator("div.status[role=status]")).toContainText(
    "The English search package is saved in this browser.",
  );
  await tabB.getByRole("button", { name: "Remove" }).click();
  await expect.poll(async () => storedPackageKeys(tabB)).toEqual([]);
  // Let tab A's download finish and wait for its status, which reports
  // the outcome of its save attempt.
  held.release();
  await expect(statusText(tabA)).toContainText(
    /is saved in this browser|package was not saved/,
  );
  expect(await storedPackageKeys(tabA)).toEqual([]);
  await tabB.reload();
  await expect(tabB.getByRole("button", { name: "Remove" })).toHaveCount(0);
  expect(await storedPackageKeys(tabB)).toEqual([]);
});

test("a blank claim link shows the claim page's unavailable message", async ({
  page,
}) => {
  await page.goto("/claim/%20");
  await expect(
    page.getByRole("heading", { name: "Assign a rafsi" }),
  ).toBeVisible();
  await expect(page.locator("main")).toContainText(
    "This link names no word.",
  );
  await expect(page.locator("main")).not.toContainText('{"code"');
});

test("a blank rafsi link does not show a raw core error", async ({
  page,
}) => {
  await page.goto("/rafsi/%20");
  await expect(page.locator("main")).toContainText(
    "No retained claim assigns",
  );
  await expect(page.locator("main")).not.toContainText('{"code"');
});

test("a failed download keeps the picked language", async ({ page }) => {
  // Offer French and German beside English, then cut every package request.
  await page.route("**/api/v1/manifest*", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    const en =
      json.packages.find(
        (pkg: { language: string }) => pkg.language === "en",
      ) ?? json.packages[0];
    json.packages = [
      ...json.packages,
      { ...en, language: "fr" },
      { ...en, language: "de" },
    ];
    await route.fulfill({ response, json });
  });
  await page.route("**/api/v1/packages/**", (route) => route.abort());
  await page.goto("/preferences");
  const pick = page.getByLabel("Download a package");
  await pick.selectOption("de");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(statusText(page)).toContainText("No connection to the server.");
  await expect(pick).toHaveValue("de");
  await expect(
    page.getByRole("button", { name: "Download", exact: true }),
  ).toBeEnabled();
});

test("a failed refresh keeps focus on the Refresh button", async ({
  page,
}) => {
  await page.goto("/preferences");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(statusText(page)).toContainText(
    "The English search package is saved in this browser.",
  );
  await page.route("**/api/v1/packages/**", (route) => route.abort());
  const refresh = page.getByRole("button", { name: "Refresh English" });
  await refresh.click();
  await expect(statusText(page)).toContainText("No connection to the server.");
  await expect(refresh).toBeEnabled();
  await expect(refresh).toBeFocused();
});

test("refresh in a stale tab does not bring back a removed package", async ({
  context,
}) => {
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  await tabA.goto("/preferences");
  await tabA.getByRole("button", { name: "Download", exact: true }).click();
  await expect(statusText(tabA)).toContainText(
    "The English search package is saved in this browser.",
  );
  await tabB.goto("/preferences");
  await tabB.getByRole("button", { name: "Remove" }).click();
  await expect.poll(async () => storedPackageKeys(tabB)).toEqual([]);
  // Tab A still shows its stale English row. Refresh must not download.
  await tabA.getByRole("button", { name: "Refresh English" }).click();
  await expect(statusText(tabA)).toContainText(
    "The English package is no longer saved in this browser.",
  );
  expect(await storedPackageKeys(tabA)).toEqual([]);
  await expect(
    tabA.getByRole("button", { name: "Refresh English" }),
  ).toHaveCount(0);
  await tabB.reload();
  await expect(tabB.getByRole("button", { name: "Remove" })).toHaveCount(0);
});

test("a running refresh stays disabled across a render of the list", async ({
  page,
}) => {
  // Offer French beside English so a second package can be stored.
  await page.route("**/api/v1/manifest*", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    const en =
      json.packages.find(
        (pkg: { language: string }) => pkg.language === "en",
      ) ?? json.packages[0];
    json.packages = [...json.packages, { ...en, language: "fr" }];
    await route.fulfill({ response, json });
  });
  await page.goto("/preferences");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(statusText(page)).toContainText(
    "The English search package is saved in this browser.",
  );
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().put("packages", "fr", {
      snapshot: "sha256:" + "a".repeat(64),
      version: 2,
      entries: [],
    });
  });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Refresh French" }),
  ).toBeVisible();
  // Hold the refresh, then remove French so the list renders again.
  const held = holdPackageRequests(page);
  await page.getByRole("button", { name: "Refresh English" }).click();
  await expect.poll(() => held.started()).toBeGreaterThan(0);
  await page
    .locator(".row", { hasText: "French" })
    .getByRole("button", { name: "Remove" })
    .click();
  await expect(
    page.getByRole("button", { name: "Refresh French" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Refresh English" }),
  ).toBeDisabled();
  held.release();
  await expect(statusText(page)).toContainText(
    /package is refreshed|package was not saved/,
  );
  await expect(
    page.getByRole("button", { name: "Refresh English" }),
  ).toBeEnabled();
});

test("a failed refresh after a render of the list keeps its button enabled", async ({
  page,
}) => {
  await offerFrench(page);
  await page.goto("/preferences");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(statusText(page)).toContainText(
    "The English search package is saved in this browser.",
  );
  await storeFrench(page);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Refresh French" }),
  ).toBeVisible();
  // Hold the refresh, remove French so the list renders again, then fail it.
  const held = holdPackageRequests(page, true);
  const refresh = page.getByRole("button", { name: "Refresh English" });
  await refresh.click();
  await expect.poll(() => held.started()).toBeGreaterThan(0);
  await page
    .locator(".row", { hasText: "French" })
    .getByRole("button", { name: "Remove" })
    .click();
  await expect(
    page.getByRole("button", { name: "Refresh French" }),
  ).toHaveCount(0);
  held.release();
  await expect(statusText(page)).toContainText("No connection to the server.");
  await expect(refresh).toBeEnabled();
  await expect(refresh).toBeFocused();
});

test("a failed download after a render of the list keeps its button enabled", async ({
  page,
}) => {
  await offerFrench(page);
  await storeFrenchAfterLoad(page);
  await expect(
    page.getByRole("button", { name: "Refresh French" }),
  ).toBeVisible();
  // Hold the English download, remove French so the list renders again,
  // then fail the download.
  const held = holdPackageRequests(page, true);
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect.poll(() => held.started()).toBeGreaterThan(0);
  await page
    .locator(".row", { hasText: "French" })
    .getByRole("button", { name: "Remove" })
    .click();
  await expect(
    page.getByRole("button", { name: "Refresh French" }),
  ).toHaveCount(0);
  held.release();
  await expect(statusText(page)).toContainText("No connection to the server.");
  await expect(
    page.getByRole("button", { name: "Download", exact: true }),
  ).toBeEnabled();
});

/** Loads Settings and stores the French package, so its row is listed. */
async function storeFrenchAfterLoad(page: Page): Promise<void> {
  await page.goto("/preferences");
  await storeFrench(page);
  await page.reload();
}

test("a successful refresh returns focus to the Refresh button", async ({
  page,
}) => {
  await offerFrench(page);
  await page.goto("/preferences");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(statusText(page)).toContainText(
    "The English search package is saved in this browser.",
  );
  // French stays offered, so a Download button stays on the page.
  await expect(
    page.getByRole("button", { name: "Download", exact: true }),
  ).toBeVisible();
  const refresh = page.getByRole("button", { name: "Refresh English" });
  await refresh.focus();
  await page.keyboard.press("Enter");
  await expect(statusText(page)).toContainText(
    "The English package is refreshed.",
  );
  await expect(refresh).toBeFocused();
});

test("opening a rafsi page does not save back a removed package", async ({
  page,
}) => {
  await page.goto("/preferences");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.locator("div.status[role=status]")).toContainText(
    "The English search package is saved in this browser.",
  );
  await page.getByRole("button", { name: "Remove" }).click();
  await expect.poll(async () => storedPackageKeys(page)).toEqual([]);
  await page.goto("/rafsi/klama");
  // The lookup has settled when the page reports its outcome.
  await expect
    .poll(async () => {
      const text = await page.locator("main").innerText();
      return /No retained claim assigns|Rafsi lookup needs|claim/i.test(text);
    })
    .toBe(true);
  expect(await storedPackageKeys(page)).toEqual([]);
  await page.goto("/preferences");
  await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(0);
  expect(await storedPackageKeys(page)).toEqual([]);
});
