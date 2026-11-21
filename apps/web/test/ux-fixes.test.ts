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
  await expect(page.locator("main")).toContainText("This link names no word.");
  await expect(page.locator("main")).not.toContainText('{"code"');
});

test("a blank rafsi link does not show a raw core error", async ({ page }) => {
  await page.goto("/rafsi/%20");
  await expect(page.locator("main")).toContainText("No retained claim assigns");
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

test("a failed refresh keeps focus on the Refresh button", async ({ page }) => {
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

/** The header search field, where the user moves focus during a run. */
const searchField = (page: Page) =>
  page.getByLabel("Search words and meanings");

/** Moves focus to the header search field and types the first letters. */
async function typeInSearchDuringRun(page: Page): Promise<void> {
  await searchField(page).click();
  await page.keyboard.type("kla");
  await expect(searchField(page)).toBeFocused();
}

/** Checks that the search field kept focus and gets the next letters. */
async function expectSearchKeptFocus(page: Page): Promise<void> {
  await expect(searchField(page)).toBeFocused();
  await page.keyboard.type("ma");
  await expect(searchField(page)).toHaveValue("klama");
}

/** Stores English, holds package requests and starts a refresh of English. */
async function startHeldRefresh(page: Page, fail: boolean) {
  await page.goto("/preferences");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(statusText(page)).toContainText(
    "The English search package is saved in this browser.",
  );
  const held = holdPackageRequests(page, fail);
  const refresh = page.getByRole("button", { name: "Refresh English" });
  await refresh.click();
  await expect.poll(() => held.started()).toBeGreaterThan(0);
  // Marks the pressed button, so the test can see when a render replaced it.
  await refresh.evaluate((node) => node.setAttribute("data-pressed", ""));
  return held;
}

/** Waits until a render replaced the pressed button and the list shows its new buttons. */
async function waitForRenderAfterRun(page: Page, label: string) {
  await expect(page.locator("button[data-pressed]")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: label, exact: true }),
  ).toBeEnabled();
}

test("a successful refresh leaves focus in a field the user moved to", async ({
  page,
}) => {
  const held = await startHeldRefresh(page, false);
  await typeInSearchDuringRun(page);
  held.release();
  await expect(statusText(page)).toContainText(
    "The English package is refreshed.",
  );
  await waitForRenderAfterRun(page, "Refresh English");
  await expectSearchKeptFocus(page);
});

test("a failed refresh leaves focus in a field the user moved to", async ({
  page,
}) => {
  const held = await startHeldRefresh(page, true);
  await typeInSearchDuringRun(page);
  held.release();
  await expect(statusText(page)).toContainText("No connection to the server.");
  // The failure enables the pressed button in place; focus moves, if at
  // all, in the same step.
  await expect(
    page.getByRole("button", { name: "Refresh English" }),
  ).toBeEnabled();
  await expectSearchKeptFocus(page);
});

/** Holds package requests and starts a download of English, with French still offered. */
async function startHeldDownload(page: Page, fail: boolean) {
  await offerFrench(page);
  await page.goto("/preferences");
  const held = holdPackageRequests(page, fail);
  const download = page.getByRole("button", { name: "Download", exact: true });
  await download.click();
  await expect.poll(() => held.started()).toBeGreaterThan(0);
  await download.evaluate((node) => node.setAttribute("data-pressed", ""));
  return held;
}

test("a successful download leaves focus in a field the user moved to", async ({
  page,
}) => {
  const held = await startHeldDownload(page, false);
  await typeInSearchDuringRun(page);
  held.release();
  await expect(statusText(page)).toContainText(
    "The English search package is saved in this browser.",
  );
  await waitForRenderAfterRun(page, "Download");
  await expectSearchKeptFocus(page);
});

test("a failed download leaves focus in a field the user moved to", async ({
  page,
}) => {
  const held = await startHeldDownload(page, true);
  await typeInSearchDuringRun(page);
  held.release();
  await expect(statusText(page)).toContainText("No connection to the server.");
  await expect(
    page.getByRole("button", { name: "Download", exact: true }),
  ).toBeEnabled();
  await expectSearchKeptFocus(page);
});

/** Scrolls the page so that the Refresh English button is above the viewport, and returns the scroll position. */
async function scrollPastRefresh(page: Page): Promise<number> {
  return page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find(
      (node) => node.textContent === "Refresh English",
    )!;
    window.scrollTo(
      0,
      window.scrollY + button.getBoundingClientRect().bottom + 150,
    );
    return window.scrollY;
  });
}

for (const fail of [false, true])
  test(`a ${fail ? "failed" : "successful"} refresh keeps the scroll position the user chose`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 500 });
    const held = await startHeldRefresh(page, fail);
    const scrolled = await scrollPastRefresh(page);
    // The button must be out of view, so a focus with scrolling would move the page.
    expect(scrolled).toBeGreaterThan(0);
    await expect(
      page.getByRole("button", { name: "Refresh English" }),
    ).not.toBeInViewport();
    held.release();
    if (fail) {
      await expect(statusText(page)).toContainText(
        "No connection to the server.",
      );
      await expect(
        page.getByRole("button", { name: "Refresh English" }),
      ).toBeEnabled();
    } else {
      await expect(statusText(page)).toContainText(
        "The English package is refreshed.",
      );
      await waitForRenderAfterRun(page, "Refresh English");
    }
    // Focus is free, so it returns to the button, but the page does not move.
    await expect(
      page.getByRole("button", { name: "Refresh English" }),
    ).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);
  });

/** Offers exactly these languages in the manifest, in this order, all with the English package's metadata. */
async function offerLanguages(page: Page, languages: string[]): Promise<void> {
  await page.route("**/api/v1/manifest*", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    const en =
      json.packages.find(
        (pkg: { language: string }) => pkg.language === "en",
      ) ?? json.packages[0];
    json.packages = languages.map((language) => ({ ...en, language }));
    await route.fulfill({ response, json });
  });
}

/** Holds the package requests of one language until `release`, which aborts them. */
function holdLanguage(page: Page, language: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  void page.route(`**/api/v1/packages/${language}**`, async (route) => {
    started++;
    await gate;
    await route.abort();
  });
  return { release: () => release(), started: () => started };
}

/** Downloads English through the page and waits for the saved status. */
async function downloadEnglish(page: Page): Promise<void> {
  await page.getByLabel("Download a package").selectOption("en");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(statusText(page)).toContainText(
    "The English search package is saved in this browser.",
  );
}

for (const order of [
  ["en", "fr"],
  ["fr", "en"],
])
  test(`a failed download keeps the picked language after a render, with ${order.join(" then ")} offered`, async ({
    page,
  }) => {
    await offerLanguages(page, order);
    await page.goto("/preferences");
    await downloadEnglish(page);
    // French is now the only offered language, so no change event names it.
    const pick = page.getByLabel("Download a package");
    await expect(pick).toHaveValue("fr");
    const held = holdLanguage(page, "fr");
    await page.getByRole("button", { name: "Download", exact: true }).click();
    await expect.poll(() => held.started()).toBeGreaterThan(0);
    // Removing English renders the list, which offers English again.
    await page
      .locator(".row", { hasText: "English" })
      .getByRole("button", { name: "Remove" })
      .click();
    await expect(
      page.getByRole("button", { name: "Refresh English" }),
    ).toHaveCount(0);
    held.release();
    await expect(statusText(page)).toContainText(
      "No connection to the server.",
    );
    await expect(pick).toHaveValue("fr");
    await expect(
      page.getByRole("button", { name: "Download", exact: true }),
    ).toBeEnabled();
  });

for (const fail of [false, true])
  test(`a ${fail ? "failed" : "successful"} refresh leaves focus on the picker after a render`, async ({
    page,
  }) => {
    // Exactly English and French, so French is the only language that the
    // picker can offer after its row is removed.
    await offerLanguages(page, ["en", "fr"]);
    await page.goto("/preferences");
    await downloadEnglish(page);
    await storeFrench(page);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Refresh French" }),
    ).toBeVisible();
    const held = holdPackageRequests(page, fail);
    await page.getByRole("button", { name: "Refresh English" }).click();
    await expect.poll(() => held.started()).toBeGreaterThan(0);
    // Remove French: the list renders and offers French for download.
    await page
      .locator(".row", { hasText: "French" })
      .getByRole("button", { name: "Remove" })
      .click();
    const pick = page.getByLabel("Download a package");
    await expect(pick).toHaveValue("fr");
    await pick.focus();
    await expect(pick).toBeFocused();
    held.release();
    if (fail) {
      await expect(statusText(page)).toContainText(
        "No connection to the server.",
      );
      await expect(
        page.getByRole("button", { name: "Refresh English" }),
      ).toBeEnabled();
    } else {
      await expect(statusText(page)).toContainText(
        "The English package is refreshed.",
      );
      await waitForRenderAfterRun(page, "Refresh English");
    }
    await expect(page.getByLabel("Download a package")).toBeFocused();
    await expect(page.getByLabel("Download a package")).toHaveValue("fr");
  });

test("a failed download keeps Download disabled while the picked language still downloads", async ({
  page,
}) => {
  await offerLanguages(page, ["en", "fr"]);
  const heldEn = holdLanguage(page, "en");
  const heldFr = holdLanguage(page, "fr");
  await page.goto("/preferences");
  const pick = page.getByLabel("Download a package");
  const download = page.getByRole("button", { name: "Download", exact: true });
  await expect(pick).toHaveValue("en");
  await download.click();
  await expect.poll(() => heldEn.started()).toBe(1);
  await expect(download).toBeDisabled();
  await pick.selectOption("fr");
  await expect(download).toBeEnabled();
  await download.click();
  await expect.poll(() => heldFr.started()).toBe(1);
  await expect(download).toBeDisabled();
  // Only English fails. French still downloads.
  heldEn.release();
  await expect(statusText(page)).toContainText("No connection to the server.");
  await expect(pick).toHaveValue("fr");
  await expect(download).toBeDisabled();
  // Picking the idle language enables Download again.
  await pick.selectOption("en");
  await expect(download).toBeEnabled();
  heldFr.release();
});

/**
 * Offers these languages, stores small packages for `saved`, and loads
 * Settings. Then it installs gates on the page's store: `arm(name)` makes
 * the next `get` or `delete` of that package, named like "get-fr", wait
 * after it completes until `resume(name)`.
 */
async function setupGatedStore(
  page: Page,
  offered: string[],
  saved: string[],
): Promise<void> {
  await offerLanguages(page, offered);
  await page.goto("/preferences");
  await page.evaluate(async (languages) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    for (const language of languages)
      await store.put("packages", language, {
        snapshot: "sha256:" + "a".repeat(64),
        version: 2,
        entries: [],
      });
  }, saved);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Refresh English" }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    type Gate = { promise: Promise<void>; resume: () => void; hit: boolean };
    const gates = new Map<string, Gate>();
    const scope = window as unknown as Record<string, unknown>;
    scope.armGate = (name: string) => {
      let resume!: () => void;
      const promise = new Promise<void>((resolve) => {
        resume = resolve;
      });
      gates.set(name, { promise, resume, hit: false });
    };
    scope.gateHit = (name: string) => gates.get(name)?.hit ?? false;
    scope.resumeGate = (name: string) => gates.get(name)?.resume();
    for (const method of ["get", "delete"] as const) {
      const original = LocalStore.prototype[method];
      LocalStore.prototype[method] = async function (
        this: unknown,
        storeName: string,
        id: string,
        ...rest: unknown[]
      ) {
        const value = await (original as (...args: unknown[]) => unknown).call(
          this,
          storeName,
          id,
          ...rest,
        );
        const gate = storeName === "packages" && gates.get(`${method}-${id}`);
        if (gate && !gate.hit) {
          gate.hit = true;
          await gate.promise;
        }
        return value;
      } as never;
    }
  });
}
const armGate = (page: Page, name: string) =>
  page.evaluate(
    (key) =>
      (window as never as Record<string, (k: string) => void>).armGate(key),
    name,
  );
const resumeGate = (page: Page, name: string) =>
  page.evaluate(
    (key) =>
      (window as never as Record<string, (k: string) => void>).resumeGate(key),
    name,
  );
const gateHit = (page: Page, name: string) =>
  expect
    .poll(() =>
      page.evaluate(
        (key) =>
          (window as never as Record<string, (k: string) => boolean>).gateHit(
            key,
          ),
        name,
      ),
    )
    .toBe(true);

const languageNames: Record<string, string> = {
  en: "English",
  fr: "French",
  de: "German",
};
const removeButton = (page: Page, language: string) =>
  page
    .locator(".row", { hasText: languageNames[language] })
    .getByRole("button", { name: "Remove", exact: true });

test("overlapping renders show one list, with one row per saved package", async ({
  page,
}) => {
  await setupGatedStore(page, ["en", "fr", "de"], ["en", "fr", "de"]);
  // The refresh's render waits after reading French.
  await armGate(page, "get-fr");
  await page.getByRole("button", { name: "Refresh English" }).click();
  await gateHit(page, "get-fr");
  // Remove German. Its render passes the used gate and finishes first.
  await removeButton(page, "de").click();
  await expect(removeButton(page, "de")).toHaveCount(0);
  await resumeGate(page, "get-fr");
  await expect(statusText(page)).toContainText(
    "The English package is refreshed.",
  );
  // Let any older render finish appending.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
  const main = page.locator("main");
  await expect(
    main.getByRole("button", { name: "Remove", exact: true }),
  ).toHaveCount(2);
  await expect(
    main.getByRole("button", { name: "Refresh English" }),
  ).toHaveCount(1);
  await expect(
    main.getByRole("button", { name: "Refresh French" }),
  ).toHaveCount(1);
  await expect(
    main.getByRole("button", { name: "Refresh German" }),
  ).toHaveCount(0);
  await expect(main.getByLabel("Download a package")).toHaveCount(1);
  await expect(
    main.getByRole("button", { name: "Download", exact: true }),
  ).toHaveCount(1);
});

test("an older refresh does not clear the running mark of a newer download", async ({
  page,
}) => {
  await setupGatedStore(page, ["en", "fr"], ["en", "fr"]);
  // The refresh's render waits after reading French.
  await armGate(page, "get-fr");
  await page.getByRole("button", { name: "Refresh English" }).click();
  await gateHit(page, "get-fr");
  // Remove English and download it again while the older render waits.
  await removeButton(page, "en").click();
  const pick = page.getByLabel("Download a package");
  await expect(pick).toHaveValue("en");
  const held = holdLanguage(page, "en");
  const download = page.getByRole("button", { name: "Download", exact: true });
  await download.click();
  await expect.poll(() => held.started()).toBe(1);
  await expect(download).toBeDisabled();
  // The older refresh now ends.
  await resumeGate(page, "get-fr");
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
  // A later clean render, then the picker moves away and back.
  await removeButton(page, "fr").first().click();
  await expect(
    page.getByRole("button", { name: "Remove", exact: true }),
  ).toHaveCount(0);
  await pick.selectOption("fr");
  await pick.selectOption("en");
  await expect(pick).toHaveValue("en");
  await expect(download).toHaveCount(1);
  await expect(download).toBeDisabled();
  expect(held.started()).toBe(1);
  held.release();
});

test("an older refresh does not take focus from a Remove button that the newest render keeps", async ({
  page,
}) => {
  await setupGatedStore(page, ["en", "fr", "de"], ["en", "fr", "de"]);
  // The refresh's render waits after reading French.
  await armGate(page, "get-fr");
  await page.getByRole("button", { name: "Refresh English" }).click();
  await gateHit(page, "get-fr");
  // Remove German, and focus English's Remove while the delete waits.
  await armGate(page, "delete-de");
  await removeButton(page, "de").click();
  await gateHit(page, "delete-de");
  await removeButton(page, "en").focus();
  await expect(removeButton(page, "en")).toBeFocused();
  // The newer render waits after reading English.
  await armGate(page, "get-en");
  await resumeGate(page, "delete-de");
  await gateHit(page, "get-en");
  // The older render ends first, then the newer one.
  await resumeGate(page, "get-fr");
  await expect(statusText(page)).toContainText(
    "The English package is refreshed.",
  );
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  await resumeGate(page, "get-en");
  await expect(removeButton(page, "de")).toHaveCount(0);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  await expect(removeButton(page, "en")).toHaveCount(1);
  await expect(removeButton(page, "en")).toBeFocused();
});

test("after overlapping renders, Download is disabled while the picked language downloads", async ({
  page,
}) => {
  await setupGatedStore(
    page,
    ["en", "fr", "de", "it", "es"],
    ["en", "fr", "de"],
  );
  await armGate(page, "get-fr");
  await page.getByRole("button", { name: "Refresh English" }).click();
  await gateHit(page, "get-fr");
  await removeButton(page, "de").click();
  await expect(removeButton(page, "de")).toHaveCount(0);
  await resumeGate(page, "get-fr");
  await expect(statusText(page)).toContainText(
    "The English package is refreshed.",
  );
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
  const pick = page.locator("main").getByLabel("Download a package");
  const download = page
    .locator("main")
    .getByRole("button", { name: "Download", exact: true });
  await expect(pick).toHaveCount(1);
  await pick.selectOption("es");
  const held = holdLanguage(page, "es");
  await download.click();
  await expect.poll(() => held.started()).toBe(1);
  await expect(download).toHaveCount(1);
  await expect(download).toBeDisabled();
  held.release();
});

test("a refresh leaves focus on the page when the focused Remove button is gone from the new list", async ({
  page,
  context,
}) => {
  await setupGatedStore(page, ["en", "fr"], ["en", "fr"]);
  // Another tab removes French. This tab still shows the French row.
  const other = await context.newPage();
  await other.goto("/preferences");
  await removeButton(other, "fr").click();
  await expect(removeButton(other, "fr")).toHaveCount(0);
  // The refresh's render waits after reading English.
  await armGate(page, "get-en");
  await page.getByRole("button", { name: "Refresh English" }).click();
  await gateHit(page, "get-en");
  await removeButton(page, "fr").focus();
  await expect(removeButton(page, "fr")).toBeFocused();
  await resumeGate(page, "get-en");
  await expect(removeButton(page, "fr")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Refresh English" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Refresh English" }),
  ).not.toBeFocused();
  expect(
    await page.evaluate(() => document.activeElement === document.body),
  ).toBe(true);
});

test("the shown buttons follow the running marks while a list is built", async ({
  page,
}) => {
  await setupGatedStore(page, ["en", "de", "fr"], ["en", "fr"]);
  // A refresh of English is held at the network. Remove English meanwhile.
  let through!: () => void;
  let requests = 0;
  const gate = new Promise<void>((resolve) => {
    through = resolve;
  });
  await page.route("**/api/v1/packages/en**", async (route) => {
    requests++;
    await gate;
    await route.continue();
  });
  await page.getByRole("button", { name: "Refresh English" }).click();
  await expect.poll(() => requests).toBe(1);
  await removeButton(page, "en").click();
  await expect(removeButton(page, "en")).toHaveCount(0);
  const pick = page.getByLabel("Download a package");
  const download = page.getByRole("button", { name: "Download", exact: true });
  await pick.selectOption("en");
  await expect(download).toBeDisabled();
  // The refused refresh ends, and its render waits after reading French.
  await armGate(page, "get-fr");
  through();
  await gateHit(page, "get-fr");
  await expect(statusText(page)).toContainText(
    "The English package was not saved.",
  );
  // The mark is clear, so the shown Download is enabled before the new list.
  await expect(pick).toHaveValue("en");
  await expect(download).toBeEnabled();
  await resumeGate(page, "get-fr");
  await expect(download).toBeEnabled();
});

test("a shown Refresh button is enabled when its run ends, before the new list", async ({
  page,
}) => {
  await setupGatedStore(page, ["en", "fr"], ["en", "fr"]);
  // The refresh's render waits after reading French.
  await armGate(page, "get-fr");
  const refresh = page.getByRole("button", { name: "Refresh English" });
  await refresh.click();
  await gateHit(page, "get-fr");
  await expect(statusText(page)).toContainText(
    "The English package is refreshed.",
  );
  await expect(refresh).toBeEnabled();
  await resumeGate(page, "get-fr");
  await expect(refresh).toBeEnabled();
});

test("the row check of a render runs after its list is shown", async ({
  page,
}) => {
  // English has a row that only the full row check rejects.
  await setupGatedStore(page, ["en", "fr", "de"], ["fr", "de"]);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().put("packages", "en", {
      snapshot: "sha256:" + "b".repeat(64),
      version: 2,
      entries: [{}],
    });
  });
  // Record each change of a shown row's detail to the invalid message.
  await page.evaluate(() => {
    const scope = window as unknown as { shownChecks: number };
    scope.shownChecks = 0;
    new MutationObserver((records) => {
      for (const record of records)
        if (
          record.target instanceof HTMLElement &&
          record.target.tagName === "SMALL" &&
          record.target.textContent?.startsWith("The search package is invalid")
        )
          scope.shownChecks++;
    }).observe(document.body, { childList: true, subtree: true });
  });
  // Removing German renders the list. The render waits after reading
  // French, after English's row is built.
  await armGate(page, "get-fr");
  await removeButton(page, "de").click();
  await gateHit(page, "get-fr");
  // Give an early row check time to run while the list is held.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  await resumeGate(page, "get-fr");
  await expect(removeButton(page, "de")).toHaveCount(0);
  await expect(page.locator(".row", { hasText: "English" })).toContainText(
    "The search package is invalid",
  );
  // The check changed the row after the row was shown.
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { shownChecks: number }).shownChecks,
      ),
    )
    .toBe(1);
});
