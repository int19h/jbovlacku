import { test, expect, type Page } from "@playwright/test";

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
  await expect(note).toHaveText("No connection to the server.");
  await expect(note).toHaveClass("notice");
  await expect(toast(page)).toHaveText("", { timeout: 15000 });
  await expect(note).toHaveText("No connection to the server.");
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
    `Local uses downloaded packages for word and definition searches. Without a downloaded package for a language, local mode asks the server. Remote sends each query to ${host}.`,
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

test("offline Settings with browser storage says that saved data still works", async ({
  page,
}) => {
  await page.route("**/api/v1/manifest*", (route) => route.abort());
  await page.goto("/preferences");
  await page.getByLabel("Theme", { exact: true }).waitFor();
  await expect(page.locator("main")).toContainText(
    "The server's languages and search packages did not load: No connection to the server. Settings and packages saved in this browser still work. Open Settings again to retry.",
  );
});
