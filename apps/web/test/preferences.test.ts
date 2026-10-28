import { test, expect, type Page } from "@playwright/test";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

async function settings(page: Page) {
  await page.route("**/api/v1/capabilities", async (route) => {
    const response = await route.fetch();
    const capabilities = await response.json();
    await route.fulfill({
      json: {
        ...capabilities,
        features: { ...capabilities.features, assistance: true },
        assistance_profiles: [
          {
            id: "default",
            label: "Test assistant",
            provider: "Mock provider",
            model: "mock-model",
            operations: ["type"],
            disclosure: "Send the draft fields.",
          },
        ],
      },
    });
  });
  await page.goto("/preferences");
  await page.getByLabel("Theme", { exact: true }).waitFor();
  return page.getByRole("checkbox", { name: "Use AI assistance" });
}

async function holdSave(page: Page, fail = false) {
  await page.evaluate(async (fail) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const original = LocalStore.prototype.setPreferences;
    const held = new Promise<void>((resolve) => {
      (window as any).releasePreferenceSave = resolve;
    });
    (window as any).preferenceWrites = 0;
    LocalStore.prototype.setPreferences = async function (patch: any) {
      (window as any).preferenceWrites++;
      await held;
      if (fail) throw new Error("Test preference write failed.");
      return original.call(this, patch);
    };
  }, fail);
}

async function pauseClock(page: Page) {
  await page.clock.install({ time: new Date("2026-10-27T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-10-27T12:00:01Z"));
}

async function unloadWarns(page: Page) {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

const saved = "Assistance setting saved in this browser.";
const failed = "Not saved: Test preference write failed.";

for (const fail of [false, true]) {
  test(`the assistance checkbox keeps keyboard focus after a ${fail ? "failed" : "successful"} save and ignores pending input`, async ({
    page,
  }) => {
    const choice = await settings(page);
    await holdSave(page, fail);
    await choice.focus();
    await choice.press("Space");
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(
      "INPUT",
    );
    await expect(choice).toBeFocused();
    await expect(choice).not.toBeChecked();
    await expect(choice).toHaveAttribute("aria-disabled", "true");
    await choice.press("Space");
    const box = (await choice.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(choice).not.toBeChecked();
    expect(await page.evaluate(() => (window as any).preferenceWrites)).toBe(1);
    await page.evaluate(() => (window as any).releasePreferenceSave());
    await expect(page.locator("main")).toContainText(fail ? failed : saved);
    await expect(page.locator("#app > [role=status]")).toHaveText(
      fail ? failed : saved,
    );
    await expect(choice).toBeFocused();
    await expect(choice).toHaveAttribute("aria-disabled", "false");
    if (fail) await expect(choice).toBeChecked();
    await choice.press("Space");
    await expect
      .poll(() => page.evaluate(() => (window as any).preferenceWrites))
      .toBe(2);
    await expect(choice).toBeFocused();
    expect(await unloadWarns(page)).toBe(false);
  });

  test(`a ${fail ? "failed" : "successful"} assistance save keeps focus on another control`, async ({
    page,
  }) => {
    const choice = await settings(page);
    await holdSave(page, fail);
    await choice.focus();
    await choice.press("Space");
    const search = page.getByRole("searchbox");
    await search.focus();
    await page.evaluate(() => (window as any).releasePreferenceSave());
    await expect(page.locator("main")).toContainText(fail ? failed : saved);
    await expect(search).toBeFocused();
  });

  test(`a stalled preference write permits navigation and reports late ${fail ? "failure" : "success"}`, async ({
    page,
  }) => {
    const choice = await settings(page);
    await pauseClock(page);
    await holdSave(page, fail);
    await choice.uncheck();
    await page.getByRole("link", { name: "Add a word", exact: true }).click();
    await page.getByRole("link", { name: "About", exact: true }).press("Enter");
    expect(new URL(page.url()).pathname).toBe("/preferences");
    await page.clock.runFor(1999);
    expect(new URL(page.url()).pathname).toBe("/preferences");
    await page.clock.runFor(1);
    await expect(page).toHaveURL(/\/about$/);
    await expect(page.locator("#app > [role=status]")).toContainText(
      "still saving",
    );
    expect(await unloadWarns(page)).toBe(true);
    const search = page.getByRole("searchbox");
    await search.focus();
    await page.evaluate(() => (window as any).releasePreferenceSave());
    await expect(page.locator("#app > [role=status]")).toHaveText(
      fail ? failed : saved,
    );
    expect(new URL(page.url()).pathname).toBe("/about");
    await expect(search).toBeFocused();
    expect(await unloadWarns(page)).toBe(false);
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    if (fail) await expect(choice).toBeChecked();
    else await expect(choice).not.toBeChecked();
  });
}

test("assistance save text describes the checkbox and uses the existing shell status", async ({
  page,
}) => {
  const choice = await settings(page);
  const status = page.locator("#app > [role=status]");
  await status.evaluate((node) => {
    (window as any).originalStatus = node;
  });
  await holdSave(page);
  await choice.uncheck();
  await expect(page.locator("[role=status]")).toHaveCount(1);
  const description = await choice.getAttribute("aria-describedby");
  expect(description).toBeTruthy();
  await expect(page.locator(`[id="${description}"]`)).toHaveText(
    "Saving assistance setting.",
  );
  await page.evaluate(() => (window as any).releasePreferenceSave());
  await expect(status).toHaveText(saved);
  expect(
    await status.evaluate((node) => node === (window as any).originalStatus),
  ).toBe(true);
});

for (const preference of [
  "language",
  "theme",
  "search",
  "orthography",
  "judgments",
] as const) {
  test(`a failed ${preference} preference save announces the error and permits the first navigation`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await settings(page);
    await pauseClock(page);
    const before = await page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      return new LocalStore().preferences();
    });
    await holdSave(page, true);
    switch (preference) {
      case "language":
        await page
          .getByLabel("Definition language", { exact: true })
          .selectOption("en");
        break;
      case "theme":
        await page.getByLabel("Theme", { exact: true }).selectOption("dark");
        break;
      case "search":
        await page
          .getByLabel("Search mode", { exact: true })
          .selectOption("remote");
        break;
      case "orthography":
        await page
          .getByLabel("Lojban orthography beside headwords", { exact: true })
          .selectOption("zbalermorna");
        break;
      case "judgments":
        await page
          .getByRole("checkbox", {
            name: "Show my judgments first on word pages",
          })
          .check();
        break;
    }
    await expect
      .poll(() => page.evaluate(() => (window as any).preferenceWrites))
      .toBe(1);
    await page.getByRole("link", { name: "About", exact: true }).press("Enter");
    expect(new URL(page.url()).pathname).toBe("/preferences");
    await page.evaluate(() => (window as any).releasePreferenceSave());
    await expect(page).toHaveURL(/\/about$/);
    await expect(page.locator("#app > [role=status]")).toHaveText(failed);
    expect(await unloadWarns(page)).toBe(false);
    expect(
      await page.evaluate(() => document.documentElement.dataset.theme),
    ).not.toBe("dark");
    expect(errors).toEqual([]);
    expect(
      await page.evaluate(async () => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        return new LocalStore().preferences();
      }),
    ).toEqual(before);
  });
}

for (const fail of [false, true]) {
  test(`a stalled theme save reports late ${fail ? "failure" : "success"} after navigation`, async ({
    page,
  }) => {
    await settings(page);
    await pauseClock(page);
    await holdSave(page, fail);
    await page.getByLabel("Theme", { exact: true }).selectOption("dark");
    await page.getByRole("link", { name: "About", exact: true }).press("Enter");
    await page.clock.runFor(2000);
    await expect(page).toHaveURL(/\/about$/);
    await expect(page.locator("#app > [role=status]")).toContainText(
      "still saving",
    );
    expect(await unloadWarns(page)).toBe(true);
    await page.evaluate(() => (window as any).releasePreferenceSave());
    await expect(page.locator("#app > [role=status]")).toHaveText(
      fail ? failed : "Settings change saved in this browser.",
    );
    expect(await unloadWarns(page)).toBe(false);
    if (fail)
      expect(await page.locator("html").getAttribute("data-theme")).toBeNull();
    else
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });
}

test("a preference wait still runs the draft guard after its deadline", async ({
  page,
}) => {
  const choice = await settings(page);
  await pauseClock(page);
  await holdSave(page);
  await choice.uncheck();
  await page.getByRole("link", { name: "Add a word", exact: true }).click();
  await page.clock.runFor(2000);
  await expect(page).toHaveURL(/\/new\/meaning$/);
  const meaning = page.getByLabel("Meaning", { exact: true });
  await expect(meaning).toBeVisible();
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const original = LocalStore.prototype.saveDraft;
    (window as any).restoreDraftSave = () => {
      LocalStore.prototype.saveDraft = original;
    };
    LocalStore.prototype.saveDraft = async function () {
      throw new Error("Test draft write failed.");
    };
  });
  await meaning.fill("Keep this unsaved meaning.");
  await page.getByRole("link", { name: "About", exact: true }).press("Enter");
  await expect(page.locator("main")).toContainText(
    "Not saved: Test draft write failed.",
  );
  expect(new URL(page.url()).pathname).toBe("/new/meaning");
  await expect(meaning).toHaveValue("Keep this unsaved meaning.");
  expect(await unloadWarns(page)).toBe(true);
  await page.evaluate(() => {
    (window as any).restoreDraftSave();
    (window as any).releasePreferenceSave();
  });
  await expect(page.locator("#app > [role=status]")).toHaveText(saved);
  await page.getByRole("link", { name: "About", exact: true }).press("Enter");
  await expect(page).toHaveURL(/\/about$/);
  expect(await unloadWarns(page)).toBe(false);
});

test("saving remote search keeps its privacy disclosure visible", async ({
  page,
}) => {
  await settings(page);
  await page.getByLabel("Search mode", { exact: true }).selectOption("remote");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        return (await new LocalStore().preferences()).searchMode;
      }),
    )
    .toBe("remote");
  await expect(page.locator("#app > [role=status]")).toContainText(
    "Earlier local queries are not uploaded.",
  );
});

test("an ignored preference promise announces failure without an unhandled rejection", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await settings(page);
  await page.evaluate(async () => {
    const { Session } = await import(String("/src/app/session.ts"));
    const original = Session.prototype.setPreferences;
    Session.prototype.setPreferences = function (patch: any) {
      (window as any).preferenceSession = this;
      return original.call(this, patch);
    };
  });
  await page.getByLabel("Theme", { exact: true }).selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await holdSave(page, true);
  await page.evaluate(() => {
    void (window as any).preferenceSession.setPreferences({
      orthography: "zbalermorna",
    });
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).preferenceWrites))
    .toBe(1);
  await page.evaluate(() => (window as any).releasePreferenceSave());
  await expect(page.locator("#app > [role=status]")).toHaveText(failed);
  await page.getByRole("link", { name: "About", exact: true }).press("Enter");
  await expect(page).toHaveURL(/\/about$/);
  expect(errors).toEqual([]);
});
