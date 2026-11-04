import { richText, expectRichText, typeRichText } from "./rich-helpers.ts";
import { test, expect, type Page } from "@playwright/test";
import { fixture } from "./helpers.ts";

async function draftRows(page: Page): Promise<any[]> {
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const keys = (await store.keys("drafts")).filter(
      (key: string) => key === "current" || key.startsWith("saved:"),
    );
    return Promise.all(
      keys.map(async (key: string) => ({
        key,
        draft: await store.get("drafts", key),
      })),
    );
  });
}

/** Keep a real revision current and the author's original draft in its saved row. */
async function revisionWithSavedDraft(page: Page) {
  await page.goto("/search");
  await expect(page.locator("main h1")).toBeVisible();
  const original = await page.evaluate(async (parent) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { newDraft, draftFromBody } = await import(
      String("/src/model/draft.ts")
    );
    const { loadDefinition } = await import(String("/src/data/api.ts"));
    const store = new LocalStore();
    const original = newDraft({
      meaning: "The author's original meaning.",
      text: "The author's original prose.",
      spelling: "brodu",
      kind: "gismu",
    });
    await store.saveDraft("current", original, "absent");
    const record = await loadDefinition(parent);
    await store.switchDraft(
      original.revision,
      draftFromBody(record.body, parent, "native", record.rawBody),
    );
    return original;
  }, fixture().definitions.cukta1);
  await page.goto("/new/type");
  await page.getByRole("link", { name: "Skip to the full editor" }).click();
  const editor = page.getByRole("textbox", {
    name: "Definition text",
    exact: true,
  });
  await expect(editor).toBeVisible();
  const rows = await draftRows(page);
  return {
    original,
    current: rows.find((row) => row.key === "current").draft,
    savedKey: rows.find((row) => row.key.startsWith("saved:")).key as string,
    editorText: await richText(editor),
  };
}

/** Hold either the method call or its database await before the transaction exists. */
async function holdRestore(page: Page, atDatabase: boolean) {
  await page.evaluate(async (atDatabase) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const original = LocalStore.prototype.switchDraft;
    LocalStore.prototype.switchDraft = async function (...args: any[]) {
      LocalStore.prototype.switchDraft = original;
      const held = new Promise<void>((resolve) => {
        (window as any).__releaseRestore = resolve;
      });
      try {
        if (atDatabase) {
          const database = this.database;
          this.database = held.then(() => database);
          // The method captures the held database promise before it returns.
          const switched = original.apply(this, args);
          this.database = database;
          return await switched;
        }
        await held;
        return await original.apply(this, args);
      } finally {
        (window as any).__restoreSettled = true;
      }
    };
  }, atDatabase);
}

for (const action of ["Back", "Add a word"] as const) {
  for (const boundary of [
    "before the call",
    "at the database await",
  ] as const) {
    test(`${action} during draft restore ${boundary} keeps both drafts and the visible editor`, async ({
      page,
    }) => {
      const before = await revisionWithSavedDraft(page);
      await holdRestore(page, boundary === "at the database await");
      await page
        .getByRole("link", { name: "Return to the saved draft" })
        .click();
      await page.waitForFunction(
        () => typeof (window as any).__releaseRestore === "function",
      );
      try {
        if (action === "Back") await page.evaluate(() => history.back());
        else
          await page
            .getByRole("link", { name: "Add a word", exact: true })
            .click();
        await expect(page).toHaveURL(
          action === "Back" ? /\/new\/editor$/ : /\/new\/meaning$/,
        );
        if (action === "Back")
          await expectRichText(
            page.getByRole("textbox", { name: "Definition text", exact: true }),
            before.editorText,
          );
        else
          await expect(
            page.getByRole("textbox", { name: "Meaning", exact: true }),
          ).toHaveValue(before.current.meaning);
        await page.evaluate(() => {
          const replace = history.replaceState.bind(history);
          (window as any).__staleUrlWrites = [];
          history.replaceState = (...args) => {
            (window as any).__staleUrlWrites.push(String(args[2]));
            replace(...args);
          };
        });
      } finally {
        await page.evaluate(() => (window as any).__releaseRestore());
      }
      await page.waitForFunction(() => (window as any).__restoreSettled);
      const rows = await draftRows(page);
      expect(rows.find((row) => row.key === "current").draft.text).toEqual(
        before.current.text,
      );
      expect(rows.find((row) => row.key === before.savedKey).draft).toEqual(
        before.original,
      );
      expect(rows).toHaveLength(2);
      expect(
        await page.evaluate(() => (window as any).__staleUrlWrites),
      ).toEqual([]);
      const editor = page.getByRole("textbox", {
        name: action === "Back" ? "Definition text" : "Meaning",
        exact: true,
      });
      if (action === "Back")
        await typeRichText(editor, "An edit after leaving the restore.");
      else await editor.fill("An edit after leaving the restore.");
      await expect(page.locator("main").getByRole("status").last()).toHaveText(
        "Saved in this browser",
      );
      await expect(
        page.getByRole("button", { name: "keep this copy", exact: true }),
      ).toHaveCount(0);
      const edited = await draftRows(page);
      expect(edited.find((row) => row.key === before.savedKey).draft).toEqual(
        before.original,
      );
      expect(
        edited.find((row) => row.key === "current").draft[
          action === "Back" ? "text" : "meaning"
        ],
      ).toEqual(
        action === "Back"
          ? [["An edit after leaving the restore."]]
          : "An edit after leaving the restore.",
      );
      await page.reload();
      if (action === "Back")
        await expectRichText(editor, "An edit after leaving the restore.");
      else
        await expect(editor).toHaveValue("An edit after leaving the restore.");
      expect(
        (await draftRows(page)).find((row) => row.key === before.savedKey)
          .draft,
      ).toEqual(before.original);
    });
  }
}

for (const boundary of ["before the current read", "before the transaction"]) {
  test(`a duplicate draft resume ${boundary} shows the current draft instead of hiding it`, async ({
    page,
  }) => {
    const before = await revisionWithSavedDraft(page);
    if (boundary === "before the current read") {
      await page.evaluate(async () => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        const original = LocalStore.prototype.get;
        LocalStore.prototype.get = async function (...args: any[]) {
          if (args[0] === "drafts" && args[1] === "current") {
            LocalStore.prototype.get = original;
            await new Promise<void>((resolve) => {
              (window as any).__releaseRestore = resolve;
            });
          }
          return original.apply(this, args);
        };
      });
    } else await holdRestore(page, false);
    await page.getByRole("link", { name: "Return to the saved draft" }).click();
    await page.waitForFunction(
      () => typeof (window as any).__releaseRestore === "function",
    );
    try {
      await page.evaluate(async (key) => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        const store = new LocalStore();
        const current = await store.get("drafts", "current");
        await store.switchDraft(current.revision, { resume: key });
      }, before.savedKey);
    } finally {
      await page.evaluate(() => (window as any).__releaseRestore());
    }
    await expect(page).toHaveURL(/\/new\/meaning$/);
    await expect(
      page.getByRole("textbox", { name: "Meaning", exact: true }),
    ).toHaveValue(before.original.meaning);
    await expect(
      page.getByRole("heading", { name: "Saved drafts", exact: true }),
    ).toHaveCount(0);
    const rows = await draftRows(page);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.key === "current").draft.text).toEqual(
      before.original.text,
    );
    expect(rows.find((row) => row.key.startsWith("saved:")).draft.text).toEqual(
      before.current.text,
    );
  });
}

test("Back during a pending save supersedes a draft resume under CPU throttling", async ({
  page,
}) => {
  const cpu = await page.context().newCDPSession(page);
  await cpu.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const before = await revisionWithSavedDraft(page);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const original = LocalStore.prototype.saveDraft;
    LocalStore.prototype.saveDraft = async function (...args: any[]) {
      LocalStore.prototype.saveDraft = original;
      await new Promise<void>((resolve) => {
        (window as any).__releaseSave = resolve;
      });
      return original.apply(this, args);
    };
  });
  await typeRichText(
    page.getByRole("textbox", { name: "Definition text", exact: true }),
    "An edit during the pending save.",
  );
  await page.waitForFunction(
    () => typeof (window as any).__releaseSave === "function",
  );
  try {
    await page.getByRole("link", { name: "Return to the saved draft" }).click();
    await expect(page).toHaveURL(/\/new\/editor$/);
    await page.evaluate(() => history.back());
    await expect(page).toHaveURL(/\/new\/type$/);
  } finally {
    await page.evaluate(() => (window as any).__releaseSave());
  }
  await expect(
    page.getByRole("heading", { name: "What kind of word?", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/new\/type$/);
  const rows = await draftRows(page);
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.key === "current").draft.text).toEqual([
    ["An edit during the pending save."],
  ]);
  expect(rows.find((row) => row.key === before.savedKey).draft).toEqual(
    before.original,
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "What kind of word?", exact: true }),
  ).toBeVisible();
  expect(
    (await draftRows(page)).find((row) => row.key === "current").draft.text,
  ).toEqual([["An edit during the pending save."]]);
});

test("a refused Back after a restored draft save fails keeps the tracked URL and edit", async ({
  page,
}) => {
  const before = await revisionWithSavedDraft(page);
  await page.getByRole("link", { name: "Return to the saved draft" }).click();
  await expect(page).toHaveURL(/\/new\/meaning$/);
  const meaning = page.getByRole("textbox", { name: "Meaning", exact: true });
  await expect(meaning).toHaveValue(before.original.meaning);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const original = LocalStore.prototype.saveDraft;
    (window as any).__restoreSave = () => {
      LocalStore.prototype.saveDraft = original;
    };
    LocalStore.prototype.saveDraft = async () => {
      throw new Error("Injected save failure");
    };
  });
  await meaning.fill("An unsaved edit after restoring.");
  const status = page.locator("main").getByRole("status").last();
  await expect(status).toContainText("Not saved: Injected save failure.");
  await page.evaluate(() => history.back());
  await expect(status).toContainText("Your unsaved edits stay on this page.");
  await expect(page).toHaveURL(/\/new\/meaning$/);
  await expect(meaning).toHaveValue("An unsaved edit after restoring.");
  const rows = await draftRows(page);
  expect(rows.find((row) => row.key === "current").draft.text).toEqual(
    before.original.text,
  );
  expect(rows.find((row) => row.key.startsWith("saved:")).draft.text).toEqual(
    before.current.text,
  );
  await page.evaluate(() => (window as any).__restoreSave());
  await page.getByRole("button", { name: "retry", exact: true }).click();
  await expect(status).toHaveText("Saved in this browser");
  await page.reload();
  await expect(meaning).toHaveValue("An unsaved edit after restoring.");
});

/** Hold the first save, then either commit it or keep writes failing until retry. */
async function holdSave(page: Page, fail: boolean) {
  await page.evaluate(async (fail) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { DraftSaver } = await import(String("/src/pages/wizard/common.ts"));
    const save = LocalStore.prototype.saveDraft;
    const flush = DraftSaver.prototype.flush;
    (window as any).__settledFlushes = 0;
    DraftSaver.prototype.flush = async function () {
      try {
        return await flush.call(this);
      } finally {
        (window as any).__settledFlushes++;
      }
    };
    (window as any).__restoreSave = () => {
      LocalStore.prototype.saveDraft = save;
    };
    let first = true;
    LocalStore.prototype.saveDraft = async function (...args: any[]) {
      if (first) {
        first = false;
        await new Promise<void>((resolve) => {
          (window as any).__releaseSave = resolve;
        });
      }
      if (fail) throw new Error("Injected save failure");
      return save.apply(this, args);
    };
  }, fail);
}

for (const action of ["Add a word", "Search"] as const) {
  test(`a refused Back followed by refused ${action} keeps the editor URL and saves before reload`, async ({
    page,
  }) => {
    const before = await revisionWithSavedDraft(page);
    await holdSave(page, true);
    const editor = page.getByRole("textbox", {
      name: "Definition text",
      exact: true,
    });
    await typeRichText(editor, "The edit kept after two refused navigations.");
    await page.waitForFunction(
      () => typeof (window as any).__releaseSave === "function",
    );
    await page.evaluate(() => history.back());
    await expect(page).toHaveURL(/\/new\/type$/);
    if (action === "Add a word")
      await page.getByRole("link", { name: action, exact: true }).click();
    else {
      const search = page.getByRole("searchbox", {
        name: "Search words and meanings",
      });
      await search.fill("cukta");
      await search.press("Enter");
    }
    await page.evaluate(() => (window as any).__releaseSave());
    await page.waitForFunction(() => (window as any).__settledFlushes >= 3);
    await expect(page).toHaveURL(/\/new\/editor$/);
    await expectRichText(
      editor,
      "The edit kept after two refused navigations.",
    );
    await expect(page.locator("main").getByRole("status").last()).toContainText(
      "Your unsaved edits stay on this page.",
    );
    expect(
      (await draftRows(page)).find((row) => row.key === before.savedKey).draft,
    ).toEqual(before.original);
    // A second refused Back also checks that restoring the URL updated router tracking.
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => (window as any).__settledFlushes >= 4);
    await expect(page).toHaveURL(/\/new\/editor$/);
    await page.evaluate(() => (window as any).__restoreSave());
    await page.getByRole("button", { name: "retry", exact: true }).click();
    await expect(page.locator("main").getByRole("status").last()).toHaveText(
      "Saved in this browser",
    );
    await page.reload();
    await expect(page).toHaveURL(/\/new\/editor$/);
    await expectRichText(
      editor,
      "The edit kept after two refused navigations.",
    );
    expect(
      (await draftRows(page)).find((row) => row.key === before.savedKey).draft,
    ).toEqual(before.original);
  });
}

test("a cancelled kind dialog supersedes pending Back without detaching the editor saver", async ({
  page,
}) => {
  const before = await revisionWithSavedDraft(page);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { manualFormation } = await import(String("/src/model/builders.ts"));
    const store = new LocalStore();
    const draft = await store.get("drafts", "current");
    draft.autoDetectedKind = "gismu";
    draft.formation = manualFormation(
      [],
      "Synthetic evidence for the kind dialog.",
    );
    await store.put("drafts", "current", draft);
  });
  // Search gives Back a target that does not confirm the automatic kind.
  await page.goto("/search");
  await expect(page.locator("main h1")).toBeVisible();
  // Meaning preserves the automatic kind until a forward step asks for confirmation.
  await page.getByRole("link", { name: "Add a word", exact: true }).click();
  const meaning = page.getByRole("textbox", { name: "Meaning", exact: true });
  await expect(meaning).toBeVisible();
  await holdSave(page, false);
  await meaning.fill("The edit before the cancelled dialog.");
  await page.waitForFunction(
    () => typeof (window as any).__releaseSave === "function",
  );
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(/\/search$/);
  const dialogSeen = page.waitForEvent("dialog");
  const navigation = page.evaluate(async () => {
    const { navigate } = await import(String("/src/app/router.ts"));
    navigate("/new/lujvo");
  });
  const dialog = await dialogSeen;
  expect(dialog.message()).toContain("Remove those fields?");
  await dialog.dismiss();
  await navigation;
  // A synchronous refusal must restore the URL before the older save settles.
  await expect.soft(page).toHaveURL(/\/new\/meaning$/);
  await page.evaluate(() => (window as any).__releaseSave());
  await page.waitForFunction(() => (window as any).__settledFlushes >= 2);
  await expect(meaning).toHaveValue("The edit before the cancelled dialog.");
  await meaning.fill("The edit after the cancelled dialog.");
  await expect
    .poll(
      async () =>
        (await draftRows(page)).find((row) => row.key === "current").draft
          .meaning,
    )
    .toBe("The edit after the cancelled dialog.");
  await expect(page.locator("main").getByRole("status").last()).toHaveText(
    "Saved in this browser",
  );
  await expect(page).toHaveURL(/\/new\/meaning$/);
  await page.reload();
  await expect(meaning).toHaveValue("The edit after the cancelled dialog.");
  expect(
    (await draftRows(page)).find((row) => row.key === before.savedKey).draft,
  ).toEqual(before.original);
});

test("a concurrent draft edit keeps an unconsumed resume available without retrying the switch", async ({
  page,
}) => {
  const before = await revisionWithSavedDraft(page);
  await holdRestore(page, false);
  await page.getByRole("link", { name: "Return to the saved draft" }).click();
  await page.waitForFunction(
    () => typeof (window as any).__releaseRestore === "function",
  );
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const current = await store.get("drafts", "current");
    await store.saveDraft(
      "current",
      {
        ...current,
        meaning: "The other tab's newer meaning.",
        revision: crypto.randomUUID(),
      },
      { revision: current.revision },
    );
  });
  await page.evaluate(() => (window as any).__releaseRestore());
  const meaning = page.getByRole("textbox", { name: "Meaning", exact: true });
  await expect(meaning).toHaveValue("The other tab's newer meaning.");
  expect(new URL(page.url()).searchParams.get("resume")).toBe(before.savedKey);
  let rows = await draftRows(page);
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.key === before.savedKey).draft).toEqual(
    before.original,
  );
  // An ordinary step link leaves the pending request without retrying it.
  await page
    .getByRole("list", { name: "Steps" })
    .getByRole("link", { name: /^Type\b/ })
    .click();
  await expect(page).toHaveURL(/\/new\/type$/);
  await expect(
    page.getByRole("heading", { name: "What kind of word?", exact: true }),
  ).toBeVisible();
  expect(
    (await draftRows(page)).find((row) => row.key === "current").draft.meaning,
  ).toBe("The other tab's newer meaning.");
  // The saved link remains an explicit retry. It archives the newer current draft.
  await page.getByRole("link", { name: "Return to the saved draft" }).click();
  await expect(page).toHaveURL(/\/new\/meaning$/);
  await expect(meaning).toHaveValue(before.original.meaning);
  rows = await draftRows(page);
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.key.startsWith("saved:")).draft.meaning).toBe(
    "The other tab's newer meaning.",
  );
  await page.reload();
  await expect(meaning).toHaveValue(before.original.meaning);
});
