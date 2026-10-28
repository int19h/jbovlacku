import { test, expect, type Page } from "@playwright/test";

const event = (index: number) => "jve1:" + index.toString(16).padStart(64, "0");
const entry = (
  spelling: string,
  text: string,
  index: number,
  language = "en",
) => ({
  event: event(index),
  word: { language: "jbo", spelling },
  language,
  glosses: [] as { language: string; text: string; sense: null }[],
  plain_text: text,
  classification: { kind: "other", selmaho: [] },
  body: null,
});
async function seed(page: Page) {
  await page.goto("/");
  await page.evaluate(
    async (entries) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const store = new LocalStore();
      for (const language of ["en", "fr"])
        await store.put("packages", language, {
          snapshot: "sha256:" + "a".repeat(64),
          entries: entries.filter((row) => row.language === language),
        });
    },
    [
      entry("klama", "travel", 1),
      entry("cukta", "book", 2),
      entry("vecnu", "travel", 3, "fr"),
    ],
  );
}
async function open(page: Page, path: string) {
  await page.evaluate(async (path) => {
    (await import(String("/src/app/router.ts"))).navigate(path);
  }, path);
}
async function holdWorkerReplies(page: Page) {
  await page.addInitScript(() => {
    const Original = Worker;
    const bypass = new WeakSet<Event>();
    const state = window as any;
    state.heldReplies = [];
    state.holdSearch = false;
    state.releaseReply = (index: number, error: boolean) => {
      const { worker, data } = state.heldReplies[index];
      const reply = new MessageEvent("message", {
        data: error
          ? { ...data, error: "Synthetic stale lookup failure." }
          : data,
      });
      bypass.add(reply);
      worker.dispatchEvent(reply);
    };
    window.Worker = class extends Original {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (String(url).includes("package-search-worker"))
          this.addEventListener("message", (message) => {
            if (!state.holdSearch || bypass.has(message)) return;
            message.stopImmediatePropagation();
            state.heldReplies.push({ worker: this, data: message.data });
          });
      }
    };
  });
}
for (const target of ["empty", "meaning", "language"] as const)
  for (const error of [false, true])
    test(`R3 nearby ignores a late ${error ? "error" : "result"} after ${target} changes`, async ({
      page,
    }) => {
      await holdWorkerReplies(page);
      await seed(page);
      await open(page, "/new/meaning?meaning=initial&lang=en");
      const panel = page.getByRole("region", {
        name: "Close in meaning",
        exact: true,
      });
      await expect(panel).toContainText("No close definitions found");
      await page.evaluate(() => {
        (window as any).holdSearch = true;
      });
      await page
        .getByRole("textbox", { name: "Meaning", exact: true })
        .fill("travel");
      await expect
        .poll(() => page.evaluate(() => (window as any).heldReplies.length))
        .toBe(1);
      if (target === "language")
        await page
          .getByRole("textbox", { name: "Other language tag", exact: true })
          .fill("fr");
      else
        await page
          .getByRole("textbox", { name: "Meaning", exact: true })
          .fill(target === "empty" ? "" : "book");
      if (target === "empty") await page.waitForTimeout(500);
      else {
        await expect
          .poll(() => page.evaluate(() => (window as any).heldReplies.length))
          .toBe(2);
        await page.evaluate(() => (window as any).releaseReply(1, false));
        await expect(panel.locator(".hw")).toHaveText(
          target === "language" ? "vecnu" : "cukta",
        );
      }
      await page.evaluate(
        (error) => (window as any).releaseReply(0, error),
        error,
      );
      await expect(panel.locator(".hw")).toHaveText(
        target === "empty" ? [] : [target === "language" ? "vecnu" : "cukta"],
      );
      await expect(panel).not.toContainText("Synthetic stale lookup failure");
      if (target === "language")
        await expect(panel.locator(".hw")).toHaveAttribute("href", /lang=fr/);
    });

test("R3 nearby invalidates pending work during the input debounce", async ({
  page,
}) => {
  await holdWorkerReplies(page);
  await seed(page);
  await open(page, "/new/meaning?meaning=initial&lang=en");
  await expect(
    page.getByRole("region", { name: "Close in meaning", exact: true }),
  ).toContainText("No close definitions found");
  await page.evaluate(() => {
    (window as any).holdSearch = true;
  });
  await page
    .getByRole("textbox", { name: "Meaning", exact: true })
    .fill("travel");
  await expect
    .poll(() => page.evaluate(() => (window as any).heldReplies.length))
    .toBe(1);
  const shown = await page.evaluate(async () => {
    const input =
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Meaning"]',
      ) ?? [...document.querySelectorAll("textarea")][0];
    input.value = "book";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    (window as any).releaseReply(0, false);
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    return [...document.querySelectorAll(".similar-item .hw")].map(
      (row) => row.textContent,
    );
  });
  expect(shown).toEqual([]);
});

test("R3 nearby returns to a saved language and recovers after deletion and replacement", async ({
  page,
}) => {
  await seed(page);
  await open(page, "/new/meaning?meaning=travel&lang=en");
  const panel = page.getByRole("region", {
    name: "Close in meaning",
    exact: true,
  });
  await expect(panel.locator(".hw")).toHaveText("klama");
  const language = page.getByRole("textbox", {
    name: "Other language tag",
    exact: true,
  });
  await language.fill("de");
  await expect(panel).toContainText("Download a search package");
  await expect(panel.locator(".hw")).toHaveCount(0);
  await language.fill("");
  await expect(panel.locator(".hw")).toHaveText("klama");
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const writer = new LocalStore();
    (window as any).savedPackage = await writer.get("packages", "en");
    await writer.delete("packages", "en");
  });
  await page
    .getByRole("textbox", { name: "Meaning", exact: true })
    .fill("travel again");
  await expect(panel).toContainText("Download a search package");
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().put("packages", "en", (window as any).savedPackage);
  });
  await page
    .getByRole("textbox", { name: "Meaning", exact: true })
    .fill("travel");
  await expect(panel.locator(".hw")).toHaveText("klama");
});

test("R3 an empty nearby meaning still reads the current package mode", async ({
  page,
}) => {
  await seed(page);
  await open(page, "/new/meaning?meaning=travel&lang=en");
  const panel = page.getByRole("region", {
    name: "Close in meaning",
    exact: true,
  });
  await expect(panel.locator(".hw")).toHaveText("klama");
  await page.getByRole("textbox", { name: "Meaning", exact: true }).fill("");
  await page
    .getByRole("textbox", { name: "Other language tag", exact: true })
    .fill("de");
  await expect(panel).toContainText("no local package");
  await expect(panel.locator(".hw")).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "Other language tag", exact: true })
    .fill("");
  await expect(panel).toContainText("from the downloaded package");
});

for (const corrupt of [
  { entries: [] },
  { snapshot: "sha256:" + "a".repeat(64), entries: [{}] },
])
  test(`R3 empty search validates a corrupt package ${"snapshot" in corrupt ? "entry" : "snapshot"}`, async ({
    page,
  }) => {
    await page.goto("/");
    await page.evaluate(async (pkg) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      await new LocalStore().put("packages", "en", pkg);
    }, corrupt);
    await open(page, "/search?lang=en");
    await expect(page.locator("div.status[role=status]")).toContainText(
      "search package is invalid",
    );
    await expect(page.locator("main")).toContainText(
      "No downloaded search package",
    );
    await expect(page.locator("main")).not.toContainText(
      "Local search package from snapshot",
    );
  });

test("R3 concurrent rejected package searches keep the validation error", async ({
  page,
}) => {
  await page.goto("/");
  const errors = await page.evaluate(async () => {
    const { searchPackage } = await import(
      String("/src/data/package-search.ts")
    );
    const pkg = { snapshot: "invalid", entries: [] };
    return Promise.all(
      [1, 2, 3].map(async () => {
        try {
          await searchPackage(pkg, "en", ["travel"]);
          return "accepted";
        } catch (error) {
          return String(error);
        }
      }),
    );
  });
  for (const error of errors)
    expect(error).toContain("search package is invalid");
});

test("R3 accepted package searches survive queued cache eviction", async ({
  page,
}) => {
  await page.goto("/");
  const counts = await page.evaluate(async () => {
    const { searchPackage } = await import(
      String("/src/data/package-search.ts")
    );
    const packages = ["a", "b", "c"].map((letter) => ({
      snapshot: "sha256:" + letter.repeat(64),
      entries: [],
    }));
    await searchPackage(packages[0], "en", ["travel"]);
    await searchPackage(packages[1], "en", ["travel"]);
    return Promise.all(
      [2, 0, 1, 2, 0].map(
        async (index) =>
          (await searchPackage(packages[index], "en", ["travel"])).hits[0]
            .length,
      ),
    );
  });
  expect(counts).toEqual([0, 0, 0, 0, 0]);
});

test("R3 nearby ranks overlapping candidates before selecting its six rows", async ({
  page,
}) => {
  await page.goto("/");
  const entries = Array.from({ length: 60 }, (_, index) => ({
    ...entry(
      "broad" +
        String.fromCharCode(97 + Math.floor(index / 26), 97 + (index % 26)),
      "Synthetic",
      index + 1,
    ),
    glosses: [
      { language: "en", text: index < 30 ? "travel" : "motion", sense: null },
    ],
  }));
  entries.push(entry("klama", "travel motion", 61));
  await page.evaluate(async (entries) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().put("packages", "en", {
      snapshot: "sha256:" + "a".repeat(64),
      entries,
    });
  }, entries);
  await open(page, "/new/meaning?meaning=travel%20motion&lang=en");
  const rows = page
    .getByRole("region", { name: "Close in meaning", exact: true })
    .locator(".hw");
  await expect(rows).toHaveCount(6);
  await expect(rows.first()).toHaveText("klama");
});

test("R3 a broad local page keeps its total and show-all cap", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(
    async (entries) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      await new LocalStore().put("packages", "en", {
        snapshot: "sha256:" + "a".repeat(64),
        entries,
      });
    },
    Array.from({ length: 1005 }, (_, index) =>
      entry(
        "broad" +
          String.fromCharCode(
            97 + Math.floor(index / 676),
            97 + (Math.floor(index / 26) % 26),
            97 + (index % 26),
          ),
        "shared",
        index + 1,
      ),
    ),
  );
  await open(page, "/search?q=shared&lang=en");
  await expect(page.locator(".count")).toHaveText("1005 words");
  await expect(page.locator("article.hit")).toHaveCount(20);
  await page.getByRole("button", { name: "show all", exact: true }).click();
  await expect(page.locator("article.hit")).toHaveCount(1000);
  await expect(page.locator(".count")).toHaveText("1005 words");
  await expect(
    page.getByRole("button", { name: "show all", exact: true }),
  ).toBeDisabled();
});

test("R3 worker pages compact hits and retains alternate definitions and previews", async ({
  page,
}) => {
  await page.goto("/");
  const entries = Array.from({ length: 1050 }, (_, index) =>
    entry(
      "broad" +
        String.fromCharCode(
          97 + Math.floor(index / 676),
          97 + (Math.floor(index / 26) % 26),
          97 + (index % 26),
        ),
      "shared " + "synthetic ".repeat(600),
      index + 1,
    ),
  );
  entries.push({
    ...entry(entries[0].word.spelling, "Selected preview.", 1051),
    glosses: [{ language: "en", text: "shared", sense: null }],
  });
  const result = await page.evaluate(async (entries) => {
    const Original = Worker;
    const transfers: number[] = [];
    window.Worker = class extends Original {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener("message", (reply) =>
          transfers.push(JSON.stringify(reply.data).length),
        );
      }
    };
    const { searchPackage } = await import(
      String("/src/data/package-search.ts")
    );
    const pkg = { snapshot: "sha256:" + "b".repeat(64), entries };
    const first = await searchPackage(pkg, "en", ["shared"]);
    const rest = await searchPackage(pkg, "en", ["shared"], {
      offset: 20,
      limit: 980,
    });
    const chosen = first.hits[0].find(
      (hit: any) => hit.word.spelling === entries[0].word.spelling,
    );
    return {
      first: first.hits[0].length,
      rest: rest.hits[0].length,
      total: first.totals?.[0],
      transfer: Math.max(...transfers),
      sameEntry: chosen?.entries[0] === entries.at(-1),
      preview: chosen?.preview?.event,
      definitions: chosen?.definitions,
    };
  }, entries);
  expect(result.first).toBe(20);
  expect(result.rest).toBe(980);
  expect(result.total).toBe(1050);
  expect(result.transfer).toBeLessThan(180_000);
  expect(result.sameEntry).toBe(true);
  expect(result.preview).toBe(event(1051));
  expect(result.definitions).toEqual([event(1), event(1051)]);
});

test("R3 lujvo part lookup uses the package worker", async ({ page }) => {
  await seed(page);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { newDraft } = await import(String("/src/model/draft.ts"));
    const draft = newDraft({ meaning: "Synthetic", language: "en" });
    draft.kind = "lujvo";
    await new LocalStore().put("drafts", "current", draft);
  });
  const workers: string[] = [];
  page.on("worker", (worker) => workers.push(worker.url()));
  await open(page, "/new/lujvo");
  await page
    .getByRole("textbox", { name: "Add a part", exact: true })
    .fill("klama");
  await expect(
    page.getByRole("button", { name: "Add klama", exact: true }),
  ).toBeVisible();
  expect(workers.some((url) => url.includes("package-search-worker"))).toBe(
    true,
  );
});
