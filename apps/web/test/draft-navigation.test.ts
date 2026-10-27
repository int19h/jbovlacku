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
    editorText: await editor.inputValue(),
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
        await expect(
          page.getByRole("textbox", {
            name: action === "Back" ? "Definition text" : "Meaning",
            exact: true,
          }),
        ).toHaveValue(
          action === "Back" ? before.editorText : before.current.meaning,
        );
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
      await editor.fill("An edit after leaving the restore.");
      await expect(page.getByRole("status").last()).toHaveText(
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
  await page
    .getByRole("textbox", { name: "Definition text", exact: true })
    .fill("An edit during the pending save.");
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
  const status = page.getByRole("status").last();
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
