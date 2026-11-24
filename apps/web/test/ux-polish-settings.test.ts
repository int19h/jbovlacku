import { test, expect, type Page } from "@playwright/test";
import { createIdentity, openWord } from "./helpers.ts";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

async function settings(page: Page) {
  await page.goto("/preferences");
  await page.getByLabel("Theme", { exact: true }).waitFor();
}

/** Holds every package part request until the returned function runs. */
async function holdParts(page: Page) {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v1/package-parts/*", async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  return release;
}

const toast = (page: Page) => page.locator("#app > [role=status]");

test("a package download and refresh show progress and keep the outcome by the list", async ({
  page,
}) => {
  await settings(page);
  let release = await holdParts(page);
  await page
    .getByLabel("Download a package", { exact: true })
    .selectOption("en");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  const note = page.locator("[data-package-note=en]");
  await expect(note).toHaveText(
    /^Downloading the English package: 0\.0 MiB of \d+\.\d MiB, part 0 of [1-9]\d*\.$/,
  );
  release();
  await expect(note).toHaveText(
    "The English search package is saved in this browser.",
  );
  await expect(note).toHaveClass("small");
  // The shell status clears after 8 seconds. The note stays in place.
  await expect(toast(page)).toHaveText("", { timeout: 15000 });
  await expect(note).toHaveText(
    "The English search package is saved in this browser.",
  );
  await page.unroute("**/api/v1/package-parts/*");
  release = await holdParts(page);
  const refresh = page.getByRole("button", {
    name: "Refresh English",
    exact: true,
  });
  await refresh.click();
  await expect(note).toHaveText(
    /^Refreshing the English package: 0\.0 MiB of \d+\.\d MiB, part 0 of [1-9]\d*\.$/,
  );
  await expect(refresh).toBeDisabled();
  release();
  await expect(note).toHaveText("The English package is refreshed.");
  await expect(refresh).toBeEnabled();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(note).toHaveText(
    "The English package is removed from this browser.",
  );
});

test("a failed package download keeps its error next to the list", async ({
  page,
}) => {
  await settings(page);
  await page.route("**/api/v1/package-parts/*", (route) => route.abort());
  await page
    .getByLabel("Download a package", { exact: true })
    .selectOption("en");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  const note = page.locator("[data-package-note=en]");
  const failed =
    "The English package was not downloaded: No connection to the server.";
  await expect(note).toHaveText(failed);
  await expect(note).toHaveClass("notice");
  await expect(toast(page)).toHaveText("", { timeout: 15000 });
  await expect(note).toHaveText(failed);
});

/** Offers these languages in the manifest, all with the English package's metadata. */
async function offerLanguages(page: Page, languages: string[]) {
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

test("failed download lines name their package after the connection returns", async ({
  page,
}) => {
  await offerLanguages(page, ["en", "fr", "de"]);
  await page.route("**/api/v1/packages/fr**", (route) => route.abort());
  await page.route("**/api/v1/packages/de**", (route) => route.abort());
  await settings(page);
  const picker = page.getByLabel("Download a package", { exact: true });
  const go = page.getByRole("button", { name: "Download", exact: true });
  await picker.selectOption("fr");
  await go.click();
  await expect(page.locator("[data-package-note=fr]")).toHaveClass("notice");
  await picker.selectOption("de");
  await go.click();
  await expect(page.locator("[data-package-note=de]")).toHaveClass("notice");
  // The connection returns, and another download succeeds.
  await page.unroute("**/api/v1/packages/fr**");
  await page.unroute("**/api/v1/packages/de**");
  await picker.selectOption("en");
  await go.click();
  await expect(page.locator("[data-package-note=en]")).toHaveText(
    "The English search package is saved in this browser.",
  );
  await expect(toast(page)).toHaveText("", { timeout: 15000 });
  await expect(page.locator("[data-package-notes] > p")).toHaveText([
    "The French package was not downloaded: No connection to the server.",
    "The German package was not downloaded: No connection to the server.",
    "The English search package is saved in this browser.",
  ]);
});

test("a failed refresh says that it changed nothing", async ({ page }) => {
  await settings(page);
  await page
    .getByLabel("Download a package", { exact: true })
    .selectOption("en");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  const note = page.locator("[data-package-note=en]");
  await expect(note).toHaveText(
    "The English search package is saved in this browser.",
  );
  // The server now gives a damaged index for both versions.
  await page.route("**/api/v1/packages/en?**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "{}",
    }),
  );
  await page
    .getByRole("button", { name: "Refresh English", exact: true })
    .click();
  await expect(note).toHaveClass("notice");
  await expect(note).toHaveText(
    "The English package was not refreshed. This refresh changed nothing in this browser: The search package hash did not match.",
  );
  await expect(note).not.toContainText("download another package");
  const stored = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { savedPackage } = await import(String("/src/data/saved-package.ts"));
    const store = new LocalStore();
    const pkg = savedPackage(await store.get("packages", "en"));
    return { keys: await store.keys("packages"), usable: pkg !== null };
  });
  expect(stored).toEqual({ keys: ["en"], usable: true });
});

test("a refresh that fails after a remove claims no saved package", async ({
  page,
}) => {
  await settings(page);
  await page
    .getByLabel("Download a package", { exact: true })
    .selectOption("en");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  const note = page.locator("[data-package-note=en]");
  await expect(note).toHaveText(
    "The English search package is saved in this browser.",
  );
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v1/package-parts/*", async (route) => {
    await held;
    await route.abort().catch(() => {});
  });
  await page
    .getByRole("button", { name: "Refresh English", exact: true })
    .click();
  await expect(note).toHaveText(/part 0 of/);
  await page
    .locator("[data-package-control=remove][data-package-language=en]")
    .click();
  await expect(note).toHaveText(
    "The English package is removed from this browser.",
  );
  release();
  await expect(note).toHaveClass("notice");
  await expect(note).toHaveText(
    "The English package was not refreshed. This refresh changed nothing in this browser: No connection to the server.",
  );
  await expect(
    page.locator("[data-package-control=remove][data-package-language=en]"),
  ).toHaveCount(0);
  const keys = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().keys("packages");
  });
  expect(keys).toEqual([]);
});

/** Makes the read of the saved package list fail from the given call on. */
const failKeysFrom = (page: Page, from: number) =>
  page.evaluate(async (from) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const original = LocalStore.prototype.keys;
    let calls = 0;
    LocalStore.prototype.keys = async function (store: string) {
      if (store === "packages" && ++calls >= from)
        throw new Error("Test read failure.");
      return original.call(this, store);
    };
  }, from);

test("an error after a saved download keeps the saved line", async ({
  page,
}) => {
  await settings(page);
  await failKeysFrom(page, 1);
  await page
    .getByLabel("Download a package", { exact: true })
    .selectOption("en");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(toast(page)).toContainText("Test read failure.");
  const note = page.locator("[data-package-note=en]");
  await expect(note).toHaveText(
    "The English search package is saved in this browser.",
  );
  await expect(note).toHaveClass("small");
});

test("an error after a saved refresh keeps the refreshed line", async ({
  page,
}) => {
  await settings(page);
  await page
    .getByLabel("Download a package", { exact: true })
    .selectOption("en");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  const note = page.locator("[data-package-note=en]");
  await expect(note).toHaveText(
    "The English search package is saved in this browser.",
  );
  // The first read is the check for a stale row. The second is the list.
  await failKeysFrom(page, 2);
  await page
    .getByRole("button", { name: "Refresh English", exact: true })
    .click();
  await expect(toast(page)).toContainText("Test read failure.");
  await expect(note).toHaveText("The English package is refreshed.");
  await expect(note).toHaveClass("small");
});

test("a failed settings save stays in place under its control", async ({
  page,
}) => {
  await settings(page);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    LocalStore.prototype.setPreferences = async function () {
      throw new Error("Test preference write failed.");
    };
  });
  const theme = page.getByLabel("Theme", { exact: true });
  await theme.selectOption("dark");
  const note = page
    .locator(".field-group", { has: theme })
    .locator("xpath=following-sibling::p[1]");
  await expect(note).toHaveText("Not saved: Test preference write failed.");
  await expect(note).toBeVisible();
  await expect(theme).toHaveValue("system");
});

test("the persistent storage outcome stays under its button", async ({
  page,
}) => {
  await settings(page);
  // A real request can open a browser prompt. The test answers it.
  await page.evaluate(() => {
    Object.defineProperty(navigator.storage, "persist", {
      configurable: true,
      value: async () => false,
    });
  });
  await page
    .getByRole("button", { name: "Request persistent storage", exact: true })
    .click();
  const note = page
    .locator(".actions", {
      has: page.getByRole("button", { name: "Request persistent storage" }),
    })
    .locator("xpath=following-sibling::p[1]");
  await expect(note).toHaveText(
    "The browser did not grant persistent storage.",
  );
  await expect(toast(page)).toHaveText("", { timeout: 15000 });
  await expect(note).toBeVisible();
});

test("a failed persistent storage request names the request", async ({
  page,
}) => {
  await settings(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator.storage, "persist", {
      configurable: true,
      value: async () => {
        throw new Error("Test persist failure.");
      },
    });
  });
  await page
    .getByRole("button", { name: "Request persistent storage", exact: true })
    .click();
  const note = page
    .locator(".actions", {
      has: page.getByRole("button", { name: "Request persistent storage" }),
    })
    .locator("xpath=following-sibling::p[1]");
  await expect(note).toHaveText(
    "The request for persistent storage failed: Test persist failure.",
  );
  await expect(note).toHaveClass("notice");
});

test("the remote search disclosure stays under the search mode control", async ({
  page,
}) => {
  await settings(page);
  const mode = page.getByLabel("Search mode", { exact: true });
  await mode.selectOption("remote");
  const host = new URL(page.url()).host;
  await expect(
    page
      .locator("main")
      .getByText(
        `Remote search sends each query to ${host}. Earlier local queries are not uploaded.`,
        { exact: true },
      ),
  ).toBeVisible();
});

test("Settings opened offline says that the server did not answer", async ({
  page,
}) => {
  await page.goto("/");
  // A package saved earlier keeps its language while offline.
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().put("packages", "eo", {
      snapshot: "sha256:" + "d".repeat(64),
      entries: [],
    });
  });
  await page.route("**/api/v1/**", (route) => route.abort());
  await page
    .getByRole("contentinfo")
    .getByRole("link", { name: "Settings", exact: true })
    .click();
  await page.getByLabel("Theme", { exact: true }).waitFor();
  const main = page.locator("main");
  await expect(main).toContainText(
    "The server's languages and search packages did not load: No connection to the server.",
  );
  await expect(main).not.toContainText(
    "This server offers no search package yet.",
  );
  await expect(main).not.toContainText("Not available on this server.");
  await expect(main).toContainText(
    "Assistance settings did not load: No connection to the server.",
  );
  await expect(main).toContainText(
    "The packages that the server offers are listed when it answers.",
  );
  await expect(
    page.getByLabel("Definition language", { exact: true }).locator("option"),
  ).toContainText(["English", "Esperanto"]);
  const host = new URL(page.url()).host;
  await expect(main).toContainText(
    `Publications go to one server at ${host}. Its server name did not load.`,
  );
  await expect(main).not.toContainText(`${host} at ${host}`);
});

test("a second tab follows settings saved in another tab", async ({
  page,
  context,
}) => {
  await settings(page);
  const other = await context.newPage();
  await settings(other);
  await other.getByLabel("Theme", { exact: true }).selectOption("dark");
  await other.getByLabel("Search mode", { exact: true }).selectOption("remote");
  await other
    .getByRole("checkbox", { name: "Show my judgments first on word pages" })
    .check();
  await expect(page.getByLabel("Theme", { exact: true })).toHaveValue("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByLabel("Search mode", { exact: true })).toHaveValue(
    "remote",
  );
  await expect(
    page.getByRole("checkbox", {
      name: "Show my judgments first on word pages",
    }),
  ).toBeChecked();
  await other.getByLabel("Theme", { exact: true }).selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await other.close();
});

test("judgments first without a key explains the missing key instead of a failure", async ({
  page,
}) => {
  await settings(page);
  const choice = page.getByRole("checkbox", {
    name: "Show my judgments first on word pages",
  });
  await expect(choice).toHaveAccessibleDescription(
    "Uses the judgments that your key signed. Without a key, the order does not change.",
  );
  await choice.check();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        return (await new LocalStore().preferences()).myJudgmentsFirst;
      }),
    )
    .toBe(true);
  await page.goto("/word/cukta");
  await expect(page.locator("main")).toContainText(
    "You have no key in this browser, so no judgments of yours change this order.",
  );
  await expect(page.locator("main")).not.toContainText(
    "Your judgments could not be loaded.",
  );
});

test("unknown sub-paths of Settings and About give the unavailable page", async ({
  page,
}) => {
  for (const path of ["/preferences/extra", "/about/x"]) {
    await page.goto(path);
    await expect(page.locator("main h1")).toHaveText("Page unavailable");
    await expect(page).toHaveTitle("Page unavailable · jbovlacku");
  }
  await page.goto("/preferences");
  await expect(page.locator("main h1")).toHaveText("Settings");
  await page.goto("/about");
  await expect(page.locator("main h1")).not.toHaveText("Page unavailable");
});

test("the search mode options are short and the hint explains them", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await settings(page);
  const mode = page.getByLabel("Search mode", { exact: true });
  await expect(mode.locator("option")).toHaveText(["Local", "Remote"]);
  const host = new URL(page.url()).host;
  await expect(
    page.locator(".field-group", { has: mode }).locator(".hint"),
  ).toContainText(
    `Local uses downloaded packages for word and definition searches. If no usable package is available for a language, local mode asks the server. Remote sends each query to ${host}.`,
  );
  // The closed select shows its whole label.
  const fits = await mode.evaluate((select: HTMLSelectElement) => {
    const probe = document.createElement("span");
    const style = getComputedStyle(select);
    probe.style.font = style.font;
    probe.style.position = "absolute";
    probe.style.whiteSpace = "nowrap";
    let widest = 0;
    for (const option of select.options) {
      probe.textContent = option.text;
      document.body.append(probe);
      widest = Math.max(widest, probe.getBoundingClientRect().width);
      probe.remove();
    }
    return widest < select.clientWidth;
  });
  expect(fits).toBe(true);
});

test("zbalermorna beside the headword has the headword size", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().setPreferences({ orthography: "zbalermorna" });
  });
  await page.goto("/word/cukta");
  const glyphs = page.locator(".word-head .zbalermorna");
  await expect(glyphs).toBeVisible();
  const sizes = await page.evaluate(() => ({
    headword: getComputedStyle(document.querySelector(".word-head h1")!)
      .fontSize,
    glyphs: getComputedStyle(document.querySelector(".word-head .zbalermorna")!)
      .fontSize,
  }));
  expect(sizes.glyphs).toBe(sizes.headword);
});

test("a theme and view from another tab apply while an unrelated save of this tab runs", async ({
  page,
  context,
}) => {
  await settings(page);
  // Hold this tab's orthography write until the test releases it.
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const original = LocalStore.prototype.setPreferences;
    LocalStore.prototype.setPreferences = async function (patch: any) {
      if (patch.orthography) {
        await new Promise<void>((resolve) => {
          (window as any).releaseOrthographySave = resolve;
        });
        const result = await original.call(this, patch);
        (window as any).orthographyStoreFinished = true;
        return result;
      }
      return original.call(this, patch);
    };
  });
  const other = await context.newPage();
  await settings(other);
  await page
    .getByLabel("Lojban orthography beside headwords", { exact: true })
    .selectOption("zbalermorna");
  await page.waitForFunction(
    () => typeof (window as any).releaseOrthographySave === "function",
  );
  await other.getByLabel("Theme", { exact: true }).selectOption("dark");
  await expect(other.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByLabel("Theme", { exact: true })).toHaveValue("dark");
  // The other tab's theme applies at once: only a theme write of this tab
  // may hold it back.
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  // A view that the other tab saves applies too.
  const view = "jve1:" + "e".repeat(64);
  await other.evaluate(async (view) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().setPreferences({ view });
    new BroadcastChannel("jbovlacku-preferences").postMessage("changed");
  }, view);
  const preferredView = () =>
    page.evaluate(async () => {
      const { getPreferredView } = await import(String("/src/data/api.ts"));
      return getPreferredView();
    });
  await expect.poll(preferredView).toBe(view);
  await page.evaluate(() => (window as any).releaseOrthographySave());
  await page.waitForFunction(() => (window as any).orthographyStoreFinished);
  // The finished unrelated write keeps the saved values applied.
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(preferredView).toBe(view);
  expect(
    await page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const saved = await new LocalStore().preferences();
      return [saved.theme, saved.orthography];
    }),
  ).toEqual(["dark", "zbalermorna"]);
  await other.close();
});

test("a theme from another tab waits for this tab's own theme write and then applies the saved theme", async ({
  page,
  context,
}) => {
  await settings(page);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const original = LocalStore.prototype.setPreferences;
    LocalStore.prototype.setPreferences = async function (patch: any) {
      if (patch.theme) {
        await new Promise<void>((resolve) => {
          (window as any).releaseThemeSave = resolve;
        });
      }
      return original.call(this, patch);
    };
  });
  const other = await context.newPage();
  await settings(other);
  await page.getByLabel("Theme", { exact: true }).selectOption("light");
  await page.waitForFunction(
    () => typeof (window as any).releaseThemeSave === "function",
  );
  await other.getByLabel("Theme", { exact: true }).selectOption("dark");
  await expect(other.locator("html")).toHaveAttribute("data-theme", "dark");
  // This tab's own theme write still runs, so the other tab's theme waits.
  await page.waitForTimeout(300);
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", "dark");
  await page.evaluate(() => (window as any).releaseThemeSave());
  // The later write of this tab is the saved theme, and it applies.
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await other.close();
});

test("offline Settings without browser storage does not claim that saved data works", async ({
  page,
}) => {
  await page.addInitScript(() => {
    indexedDB.open = () => {
      throw new DOMException("Storage is blocked.", "SecurityError");
    };
  });
  await page.route("**/api/v1/manifest*", (route) => route.abort());
  await page.goto("/preferences");
  await page.getByLabel("Theme", { exact: true }).waitFor();
  const main = page.locator("main");
  await expect(main).toContainText(
    "The server's languages and search packages did not load: No connection to the server. Open Settings again to retry.",
  );
  await expect(main).not.toContainText("still work");
  await expect(main).toContainText(
    "Browser storage is unavailable. Packages cannot be saved.",
  );
  await expect(page.getByRole("alert")).toContainText(
    "Browser storage is unavailable.",
  );
});

test("saving the theme keeps a cached word page for Back", async ({ page }) => {
  await page.goto("/word/cukta");
  await expect(page.locator(".word-head h1")).toContainText("cukta");
  await page
    .getByRole("contentinfo")
    .getByRole("link", { name: "Settings", exact: true })
    .click();
  await page.getByLabel("Theme", { exact: true }).selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  let wordRequests = 0;
  await page.route("**/api/v1/words/*", (route) => {
    wordRequests++;
    return route.abort();
  });
  await page.goBack();
  // The view did not change, so the cached word response still serves Back.
  await expect(page.locator(".word-head h1")).toContainText("cukta");
  expect(wordRequests).toBe(0);
});

test("Settings shows a theme that another tab saved while the page loaded", async ({
  page,
  context,
}) => {
  const other = await context.newPage();
  await settings(other);
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let started = () => {};
  const seen = new Promise<void>((resolve) => (started = resolve));
  await page.route("**/api/v1/manifest*", async (route) => {
    started();
    await held;
    await route.continue().catch(() => {});
  });
  await page.goto("/preferences");
  await seen;
  await other.getByLabel("Theme", { exact: true }).selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  release();
  await page.getByLabel("Theme", { exact: true }).waitFor();
  await expect(page.getByText("Loading…", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Theme", { exact: true })).toHaveValue("dark");
  await other.close();
});

test("the word page does not deny a key that another tab saved", async ({
  page,
  context,
}) => {
  await settings(page);
  await page
    .getByRole("checkbox", { name: "Show my judgments first on word pages" })
    .check();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        return (await new LocalStore().preferences()).myJudgmentsFirst;
      }),
    )
    .toBe(true);
  const other = await context.newPage();
  await createIdentity(other);
  await openWord(page, "cukta");
  const main = page.locator("main");
  await expect(main).toContainText(
    "This tab has not loaded the key that is now saved in this browser. Reload the page to put your judgments first.",
  );
  await expect(main).not.toContainText("You have no key in this browser");
  await other.close();
});

test("offline Settings leaves the state of a saved package to its row", async ({
  page,
}) => {
  await page.goto("/about");
  await page.locator("main h1").waitFor();
  // A saved package with one malformed entry.
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().put("packages", "eo", {
      snapshot: "sha256:" + "a".repeat(64),
      entries: [{}],
    });
  });
  await page.route("**/api/v1/**", (route) => route.abort());
  await page
    .getByRole("contentinfo")
    .getByRole("link", { name: "Settings", exact: true })
    .click();
  await page.getByLabel("Theme", { exact: true }).waitFor();
  const main = page.locator("main");
  await expect(main).toContainText(
    "The server's languages and search packages did not load: No connection to the server. Open Settings again to retry.",
  );
  await expect(main).toContainText("The search package is invalid.");
  await expect(main).not.toContainText("still work");
});

test("a failed request for meaning search profiles does not say that assistance is unavailable", async ({
  page,
}) => {
  await page.route("**/api/v1/capabilities*", (route) =>
    route.fulfill({
      json: {
        server_id: "local-test",
        features: { semantic_search: true, assistance: false },
        assistance_profiles: [],
      },
    }),
  );
  await page.route("**/api/v1/embedding-profiles*", (route) => route.abort());
  await settings(page);
  const line = page
    .getByRole("heading", { name: "Assistance", exact: true })
    .locator("xpath=following-sibling::*[1]");
  await expect(line).toHaveText(
    "Assistance settings did not load: the meaning search profiles did not load. No connection to the server. Open Settings again to retry.",
  );
  await expect(page.locator("main")).not.toContainText(
    "Not available on this server.",
  );
});

test("a package note follows the list after another tab removed the package", async ({
  page,
  context,
}) => {
  await page.goto("/about");
  await page.locator("main h1").waitFor();
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().put("packages", "eo", {
      snapshot: "sha256:" + "a".repeat(64),
      entries: [],
    });
  });
  await settings(page);
  const picker = page.getByLabel("Download a package", { exact: true });
  await picker.selectOption("en");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  const note = page.locator("[data-package-note=en]");
  await expect(note).toHaveText(
    "The English search package is saved in this browser.",
  );
  const other = await context.newPage();
  await settings(other);
  await other
    .locator("[data-package-control=remove][data-package-language=en]")
    .click();
  await expect(
    other.locator("[data-package-control=remove][data-package-language=en]"),
  ).toHaveCount(0);
  // This removal rebuilds the list from storage, which no longer has English.
  await page
    .locator("[data-package-control=remove][data-package-language=eo]")
    .click();
  await expect(picker.locator("option[value=en]")).toHaveCount(1);
  await expect(note).toHaveText(
    "The English package is no longer saved in this browser.",
  );
  await other.close();
});

test("a package note does not contradict the version that another tab refreshed", async ({
  page,
  context,
}) => {
  await page.goto("/about");
  await page.locator("main h1").waitFor();
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().put("packages", "eo", {
      snapshot: "sha256:" + "a".repeat(64),
      entries: [],
    });
  });
  // Only this tab gets a damaged version 2 index, so its download saves
  // version 1. The other tab refreshes to a valid version 2.
  await page.route("**/api/v1/packages/en?**", (route) =>
    new URL(route.request().url()).searchParams.get("version") === "2"
      ? route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "{}",
        })
      : route.continue(),
  );
  await settings(page);
  await page
    .getByLabel("Download a package", { exact: true })
    .selectOption("en");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  const row = (p: Page) =>
    p
      .locator(".row", {
        has: p.locator(
          "[data-package-control=remove][data-package-language=en]",
        ),
      })
      .locator("small");
  const note = page.locator("[data-package-note=en]");
  await expect(row(page)).toContainText("version 1");
  await expect(note).toContainText("version 1");
  const other = await context.newPage();
  await settings(other);
  await other
    .getByRole("button", { name: "Refresh English", exact: true })
    .click();
  await expect(row(other)).toContainText("version 2");
  // This removal rebuilds the list from storage, which now has version 2.
  await page
    .locator("[data-package-control=remove][data-package-language=eo]")
    .click();
  await expect(row(page)).toContainText("version 2");
  await expect(note).not.toContainText("in this browser as version");
  await expect(note).toHaveText(
    /^The English search package is saved in this browser\. This download saved version 1 because version 2 failed: /,
  );
  await other.close();
});

test("a note after a version 1 fallback gives the cause and no recovery instruction", async ({
  page,
}) => {
  // A damaged version 2 index fails its hash check. The version 1 package
  // then downloads, so the reader has a usable package.
  await page.route("**/api/v1/packages/en?**", (route) =>
    new URL(route.request().url()).searchParams.get("version") === "2"
      ? route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "{}",
        })
      : route.continue(),
  );
  await settings(page);
  await page
    .getByLabel("Download a package", { exact: true })
    .selectOption("en");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  const note = page.locator("[data-package-note=en]");
  await expect(note).toHaveText(
    "The English search package is saved in this browser. This download saved version 1 because version 2 failed: The search package hash did not match.",
  );
  const row = page
    .locator(".row", {
      has: page.locator(
        "[data-package-control=remove][data-package-language=en]",
      ),
    })
    .locator("small");
  await expect(row).toContainText(
    "Version 1 was saved instead of version 2: The search package hash did not match.",
  );
  await expect(row).not.toContainText("download another package");
});

test("a saved fallback reason that ends with the recovery instruction shows only the cause", async ({
  page,
}) => {
  // A damaged version 2 index makes the download save version 1 with a
  // reason.
  await page.route("**/api/v1/packages/en?**", (route) =>
    new URL(route.request().url()).searchParams.get("version") === "2"
      ? route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "{}",
        })
      : route.continue(),
  );
  await settings(page);
  await page
    .getByLabel("Download a package", { exact: true })
    .selectOption("en");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.locator("[data-package-note=en]")).toContainText(
    "saved version 1",
  );
  // Earlier code saved the whole error message as the reason.
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const cached = await store.get("packages", "en");
    cached.downgrade =
      "The search package hash did not match. Search this server or download another package.";
    await store.put("packages", "en", cached);
  });
  await settings(page);
  const row = page
    .locator(".row", {
      has: page.locator(
        "[data-package-control=remove][data-package-language=en]",
      ),
    })
    .locator("small");
  await expect(row).toContainText(
    "Version 1 was saved instead of version 2: The search package hash did not match.",
  );
  await expect(row).not.toContainText("download another package");
});

test("a new saved value from another tab clears an earlier failed save", async ({
  page,
  context,
}) => {
  await settings(page);
  const other = await context.newPage();
  await settings(other);
  // The next single write of this tab fails.
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const original = LocalStore.prototype.setPreferences;
    LocalStore.prototype.setPreferences = async function () {
      LocalStore.prototype.setPreferences = original;
      throw new DOMException("Preference transaction aborted.", "AbortError");
    };
  });
  const theme = page.getByLabel("Theme", { exact: true });
  await theme.selectOption("dark");
  const note = page
    .locator(".field-group", { has: theme })
    .locator("xpath=following-sibling::p[1]");
  await expect(note).toHaveText("Not saved: Preference transaction aborted.");
  await expect(theme).toHaveValue("system");
  await other.getByLabel("Theme", { exact: true }).selectOption("dark");
  await expect(theme).toHaveValue("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(note).toBeHidden();
  await other.close();
});
