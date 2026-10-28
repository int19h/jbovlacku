import { test, expect, type Page } from "@playwright/test";
import { fixture } from "./helpers.ts";

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
  const time = await page.evaluate(() => Date.now());
  await page.clock.install({ time });
  await page.clock.pauseAt(time + 1000);
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
    await expect(page.locator("#app > [role=status]")).toBeEmpty();
    if (fail)
      await expect(
        page.getByRole("status").filter({ hasText: failed }),
      ).toHaveCount(1);
    await expect(choice).toBeFocused();
    await expect(choice).toHaveAttribute("aria-disabled", "false");
    if (fail) await expect(choice).toBeChecked();
    await choice.press("Space");
    await expect
      .poll(() => page.evaluate(() => (window as any).preferenceWrites))
      .toBe(2);
    await expect(choice).toHaveAttribute("aria-disabled", "false");
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
    if (fail)
      await expect(
        page.getByRole("status").filter({ hasText: failed }),
      ).toHaveCount(1);
    expect(new URL(page.url()).pathname).toBe("/about");
    await expect(search).toBeFocused();
    expect(await unloadWarns(page)).toBe(false);
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    if (fail) await expect(choice).toBeChecked();
    else await expect(choice).not.toBeChecked();
  });
}

test("assistance save text describes the checkbox and keeps separate inline and shell status regions", async ({
  page,
}) => {
  const choice = await settings(page);
  const status = page.locator("#app > [role=status]");
  await status.evaluate((node) => {
    (window as any).originalStatus = node;
  });
  await holdSave(page);
  await choice.uncheck();
  await expect(page.locator("[role=status]")).toHaveCount(2);
  const description = await choice.getAttribute("aria-describedby");
  expect(description).toBeTruthy();
  await expect(page.locator(`[id="${description}"]`)).toHaveText(
    "Saving assistance setting.",
  );
  await page.evaluate(() => (window as any).releasePreferenceSave());
  await expect(page.locator("#assistance-save-status")).toHaveText(saved);
  await expect(status).toBeEmpty();
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

// Each held write has its own release, so older completions can arrive while
// the latest choice is still waiting for storage.
async function holdEachSave(page: Page) {
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const original = LocalStore.prototype.setPreferences;
    (window as any).heldPreferenceWrites = [];
    (window as any).finishedPreferenceWrites = [];
    LocalStore.prototype.setPreferences = async function (patch: any) {
      const index = (window as any).heldPreferenceWrites.length;
      const fail = await new Promise<boolean>((resolve) => {
        (window as any).heldPreferenceWrites.push({ patch, release: resolve });
      });
      try {
        if (fail) throw new Error("Test preference write failed.");
        return await original.call(this, patch);
      } finally {
        (window as any).finishedPreferenceWrites.push(index);
      }
    };
  });
}
async function releaseSave(page: Page, index: number, fail = false) {
  await page.evaluate(
    ({ index, fail }) =>
      (window as any).heldPreferenceWrites[index].release(fail),
    { index, fail },
  );
  await expect
    .poll(() =>
      page.evaluate(
        (index) => (window as any).finishedPreferenceWrites.includes(index),
        index,
      ),
    )
    .toBe(true);
}
async function storedPreferences(page: Page) {
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().preferences();
  });
}
async function leaveAfterDeadline(page: Page) {
  await page.getByRole("link", { name: "About", exact: true }).press("Enter");
  await page.clock.runFor(2000);
  await expect(page).toHaveURL(/\/about$/);
  await expect(
    page.getByRole("heading", { name: "About jbovlacku" }),
  ).toBeVisible();
  await page.getByRole("searchbox").focus();
  await page.evaluate(() => {
    (window as any).destinationHeading = document.querySelector("main h1");
    (window as any).destinationNavigations = 0;
    const original = history.replaceState.bind(history);
    history.replaceState = (...args) => {
      (window as any).destinationNavigations++;
      return original(...args);
    };
  });
}
async function expectDestination(page: Page) {
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.getByRole("searchbox")).toBeFocused();
  expect(
    await page.evaluate(() => ({
      sameHeading:
        document.querySelector("main h1") ===
        (window as any).destinationHeading,
      navigations: (window as any).destinationNavigations,
    })),
  ).toEqual({ sameHeading: true, navigations: 0 });
}

test("round 3: a late Search language save preserves the chosen destination", async ({
  page,
}) => {
  await page.goto("/search?q=book&lang=fr");
  await expect(page.locator(".count-line .count")).not.toBeEmpty();
  await pauseClock(page);
  await holdEachSave(page);
  await page
    .getByLabel("Definition language", { exact: true })
    .selectOption("en");
  await leaveAfterDeadline(page);
  await releaseSave(page, 0);
  await expect(page.locator("#app > [role=status]")).toHaveText(
    "Settings change saved in this browser.",
  );
  expect((await storedPreferences(page)).definitionLanguage).toBe("en");
  await expectDestination(page);
});

test("round 3: the empty shell status stays exposed in Chromium accessibility before and after a notice", async ({
  page,
}) => {
  await settings(page);
  await pauseClock(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Accessibility.enable");
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: "#app > [role=status]",
  });
  const exposed = async () => {
    const { nodes } = await cdp.send("Accessibility.getPartialAXTree", {
      nodeId,
      fetchRelatives: false,
    });
    expect(nodes[0].ignored).toBe(false);
    expect(nodes[0].role?.value).toBe("status");
    expect(nodes[0].properties).toContainEqual(
      expect.objectContaining({
        name: "live",
        value: expect.objectContaining({ value: "polite" }),
      }),
    );
  };
  await exposed();
  await holdSave(page, true);
  await page.getByLabel("Theme", { exact: true }).selectOption("dark");
  await page.evaluate(() => (window as any).releasePreferenceSave());
  await expect(page.locator("#app > [role=status]")).toHaveText(failed);
  await exposed();
  await page.clock.runFor(8000);
  await expect(page.locator("#app > [role=status]")).toBeEmpty();
  await exposed();
  await cdp.detach();
});

test("a fast failed assistance save announces exactly one live failure status", async ({
  page,
}) => {
  const choice = await settings(page);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    LocalStore.prototype.setPreferences = async function () {
      throw new Error("Test preference write failed.");
    };
    const previous = new Map<Element, string>();
    const announcements: { id: string; message: string }[] = [];
    (window as any).failureAnnouncements = announcements;
    new MutationObserver(() => {
      for (const region of document.querySelectorAll('[role="status"]')) {
        const message = region.textContent ?? "";
        if (
          message !== previous.get(region) &&
          message.startsWith("Not saved:")
        )
          announcements.push({ id: region.id, message });
        previous.set(region, message);
      }
    }).observe(document.querySelector("#app")!, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  await choice.focus();
  await choice.press("Space");
  await expect(page.locator("#assistance-save-status")).toHaveText(failed);
  expect(
    await page.getByRole("status").filter({ hasText: failed }).count(),
  ).toBe(1);
  await expect(page.locator("#app > [role=status]")).toBeEmpty();
  expect(
    await page.evaluate(() => (window as any).failureAnnouncements),
  ).toEqual([{ id: "assistance-save-status", message: failed }]);
  await expect(choice).toBeFocused();
  await expect(choice).toBeChecked();
  await expect(choice).toHaveAttribute("aria-disabled", "false");
});

test("a fast assistance save announces inline feedback from an exposed empty status region", async ({
  page,
}) => {
  const choice = await settings(page);
  const status = page.locator("#assistance-save-status");
  await expect(status).toBeEmpty();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Accessibility.enable");
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: "#assistance-save-status",
  });
  const exposed = async () => {
    const { nodes } = await cdp.send("Accessibility.getPartialAXTree", {
      nodeId,
      fetchRelatives: false,
    });
    expect(nodes[0].ignored).toBe(false);
    expect(nodes[0].role?.value).toBe("status");
    expect(nodes[0].properties).toContainEqual(
      expect.objectContaining({
        name: "live",
        value: expect.objectContaining({ value: "polite" }),
      }),
    );
  };
  await exposed();
  await choice.uncheck();
  await expect(status).toHaveText(saved);
  await exposed();
  await expect(page.locator("#app > [role=status]")).toBeEmpty();
  await expect(choice).toBeFocused();
  await cdp.detach();
});

async function firstSignatureDialog(page: Page) {
  await page.getByRole("searchbox").focus();
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { Session } = await import(String("/src/app/session.ts"));
    const session = new Session(new LocalStore());
    await session.load();
    (window as any).disclosureResult = "pending";
    void session.firstSignatureDisclosure().then((result: boolean) => {
      (window as any).disclosureResult = result;
    });
  });
  return page.getByRole("dialog", {
    name: "Before your first public signature",
  });
}

test("round 3: a first-signature storage failure is visible inside the modal and allows retry", async ({
  page,
}) => {
  await settings(page);
  await holdEachSave(page);
  const dialog = await firstSignatureDialog(page);
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await releaseSave(page, 0, true);
  await expect(dialog).toContainText("Test preference write failed.");
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect((await storedPreferences(page)).firstSignatureAcknowledged).toBe(
    false,
  );
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await releaseSave(page, 1);
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => (window as any).disclosureResult))
    .toBe(true);
});

for (const fail of [false, true]) {
  test(`round 3: a canceled first-signature dialog ignores late ${fail ? "failure" : "success"}`, async ({
    page,
  }) => {
    await settings(page);
    await holdEachSave(page);
    const dialog = await firstSignatureDialog(page);
    await dialog.evaluate((node) => {
      (window as any).closedDisclosure = node;
      (window as any).lateDisclosureCloses = 0;
      const original = (node as HTMLDialogElement).close.bind(node);
      (node as HTMLDialogElement).close = (...args) => {
        (window as any).lateDisclosureCloses++;
        return original(...args);
      };
    });
    await dialog.getByRole("button", { name: "Continue", exact: true }).click();
    await dialog.getByRole("button", { name: "Not now", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => (window as any).disclosureResult))
      .toBe(false);
    const before = await page.evaluate(
      () => (window as any).closedDisclosure.innerHTML,
    );
    await page.getByRole("searchbox").focus();
    await releaseSave(page, 0, fail);
    expect(
      await page.evaluate(() => (window as any).lateDisclosureCloses),
    ).toBe(1);
    expect(
      await page.evaluate(() => (window as any).closedDisclosure.innerHTML),
    ).toBe(before);
    await expect(page.getByRole("searchbox")).toBeFocused();
    expect((await storedPreferences(page)).firstSignatureAcknowledged).toBe(
      !fail,
    );
  });
}

for (const preference of [
  "language",
  "theme",
  "search",
  "orthography",
  "judgments",
] as const) {
  for (const fail of [false, true]) {
    test(`round 3: the latest ${preference} choice survives an older ${fail ? "failed" : "successful"} save`, async ({
      page,
    }) => {
      await page.route("**/api/v1/manifest", async (route) => {
        const response = await route.fetch();
        const manifest = await response.json();
        await route.fulfill({
          json: {
            ...manifest,
            packages: ["en", "fr", "de"].map((language) => ({
              ...manifest.packages[0],
              language,
            })),
          },
        });
      });
      await settings(page);
      await holdEachSave(page);
      const label = {
        language: "Definition language",
        theme: "Theme",
        search: "Search mode",
        orthography: "Lojban orthography beside headwords",
        judgments: "Show my judgments first on word pages",
      }[preference];
      const input = page.getByLabel(label, { exact: true });
      const first = {
        language: "fr",
        theme: "light",
        search: "remote",
        orthography: "zbalermorna",
        judgments: "true",
      }[preference];
      const latest = {
        language: "de",
        theme: "dark",
        search: "local",
        orthography: "latin",
        judgments: "false",
      }[preference];
      if (preference === "judgments") {
        await input.check();
        await input.uncheck();
      } else {
        await input.selectOption(first);
        await input.selectOption(latest);
      }
      await expect
        .poll(() =>
          page.evaluate(() => (window as any).heldPreferenceWrites.length),
        )
        .toBe(2);
      await releaseSave(page, 0, fail);
      if (fail)
        await expect(page.locator("#app > [role=status]")).toHaveText(failed);
      if (preference === "judgments") await expect(input).not.toBeChecked();
      else await expect(input).toHaveValue(latest);
      if (preference === "theme")
        expect(
          await page.locator("html").getAttribute("data-theme"),
        ).toBeNull();
      await releaseSave(page, 1);
      const prefs = await storedPreferences(page);
      const key = {
        language: "definitionLanguage",
        theme: "theme",
        search: "searchMode",
        orthography: "orthography",
        judgments: "myJudgmentsFirst",
      }[preference];
      expect((prefs as any)[key]).toBe(
        preference === "judgments" ? false : latest,
      );
      if (preference === "theme")
        await expect(page.locator("html")).toHaveAttribute(
          "data-theme",
          "dark",
        );
    });
  }
}

for (const action of ["select", "reset", "fallback"] as const) {
  test(`round 3: a late Trust ${action} save keeps the destination page and global view`, async ({
    page,
  }) => {
    await page.goto("/trust");
    await expect(page.getByLabel("Signed view event ID")).toBeVisible();
    if (action === "reset") {
      await page.getByLabel("Signed view event ID").fill(fixture().view);
      await page
        .getByRole("button", { name: "Use this view", exact: true })
        .click();
      await expect(
        page.getByRole("button", {
          name: "Back to the server's view",
          exact: true,
        }),
      ).toBeVisible();
    }
    await pauseClock(page);
    await holdEachSave(page);
    if (action === "select") {
      await page.getByLabel("Signed view event ID").fill(fixture().view);
      await page
        .getByRole("button", { name: "Use this view", exact: true })
        .click();
    } else
      await page
        .getByRole("button", {
          name:
            action === "reset"
              ? "Back to the server's view"
              : "Use the site view",
          exact: true,
        })
        .click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).heldPreferenceWrites.length),
      )
      .toBe(1);
    await leaveAfterDeadline(page);
    await releaseSave(page, 0);
    await expect(page.locator("#app > [role=status]")).toHaveText(
      "Settings change saved in this browser.",
    );
    await expectDestination(page);
    const prefs = await storedPreferences(page);
    if (action === "fallback") {
      expect(prefs.viewMode).toBe("site");
      await expect(
        page.getByRole("link", { name: "Trust: site view", exact: true }),
      ).toBeVisible();
    } else expect(prefs.view).toBe(action === "reset" ? null : fixture().view);
  });
}

for (const fail of [false, true]) {
  test(`round 3: a first-signature save cannot resume the abandoned page after ${fail ? "failure" : "success"}`, async ({
    page,
  }) => {
    await settings(page);
    await holdEachSave(page);
    const dialog = await firstSignatureDialog(page);
    await dialog.getByRole("button", { name: "Continue", exact: true }).click();
    await dialog.getByRole("link", { name: "key page", exact: true }).click();
    await expect(page).toHaveURL(/\/identity$/);
    await expect(
      page.getByLabel("New passphrase", { exact: true }),
    ).toBeVisible();
    await releaseSave(page, 0, fail);
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => (window as any).disclosureResult))
      .toBe(false);
    expect((await storedPreferences(page)).firstSignatureAcknowledged).toBe(
      !fail,
    );
    await expect(page).toHaveURL(/\/identity$/);
  });
}

test("round 3: the latest failed theme choice restores the preceding committed theme", async ({
  page,
}) => {
  await settings(page);
  await holdEachSave(page);
  const theme = page.getByLabel("Theme", { exact: true });
  await theme.selectOption("light");
  await theme.selectOption("dark");
  await releaseSave(page, 0);
  await expect(theme).toHaveValue("dark");
  await releaseSave(page, 1, true);
  await expect(theme).toHaveValue("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect((await storedPreferences(page)).theme).toBe("light");
});

for (const focusOther of [false, true]) {
  test(`round 3: a first-signature failure keeps focus on ${focusOther ? "another modal control" : "Continue"} and ignores repeated input`, async ({
    page,
  }) => {
    await settings(page);
    await holdEachSave(page);
    const dialog = await firstSignatureDialog(page);
    const proceed = dialog.getByRole("button", {
      name: "Continue",
      exact: true,
    });
    await proceed.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).heldPreferenceWrites.length),
      )
      .toBe(1);
    const focused = focusOther
      ? dialog.getByRole("button", { name: "Not now", exact: true })
      : proceed;
    if (focusOther) await focused.focus();
    await releaseSave(page, 0, true);
    await expect(dialog.getByRole("alert")).toContainText(
      "Test preference write failed.",
    );
    await expect(focused).toBeFocused();
    await expect(proceed).not.toBeDisabled();
  });
}
