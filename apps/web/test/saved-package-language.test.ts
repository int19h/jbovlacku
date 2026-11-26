import { expect, test, type Page } from "@playwright/test";
import { corePath, fixture } from "./helpers.ts";

const englishRow = {
  event: "jve1:" + "1".repeat(64),
  word: { language: "jbo", spelling: "cukta" },
  language: "en",
  glosses: [{ language: "en", text: "book", sense: null }],
  plain_text: "book",
  classification: { kind: "gismu", selmaho: [] },
  body: null,
  issuer: "ed25519:" + "a".repeat(64),
  notes: false,
  rafsi: ["cuk"],
  rafsi_complete: true,
  attribution: null,
};

const frenchRow = {
  ...englishRow,
  language: "fr",
  glosses: [{ language: "fr", text: "livre", sense: null }],
  plain_text: "Un livre ② {place 3}.",
};

async function savePackages(
  page: Page,
  entriesByLanguage: Record<string, unknown[]>,
  draft?: Record<string, unknown>,
) {
  await page.goto("/");
  await page.evaluate(
    async ({ packages, draft }) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const store = new LocalStore();
      await store.setPreferences({
        definitionLanguage: "en",
        searchMode: "local",
      });
      for (const [language, entries] of Object.entries(packages))
        await store.put("packages", language, {
          version: 2,
          snapshot: "sha256:" + "a".repeat(64),
          entries,
        });
      if (draft) {
        const { newDraft } = await import(String("/src/model/draft.ts"));
        await store.put("drafts", "current", newDraft(draft as never));
      }
    },
    { packages: entriesByLanguage, draft },
  );
}

function cuktaPair(page: Page) {
  return page.evaluate(async (path) => {
    const core = await import(path);
    await core.initializeCore();
    return core.rafsiPairId(
      core.wordId({ language: "jbo", spelling: "cukta" }),
      "cuk",
    );
  }, corePath);
}

test("a rafsi pair skips a matching package with a bad later row", async ({
  page,
}) => {
  await savePackages(page, { en: [englishRow, null], fr: [frenchRow] });
  const pair = await cuktaPair(page);
  await page.route("**/api/v1/manifest", (route) => route.abort());
  await page.goto(`/rafsi-pair/${pair}`);
  const word = page.locator('main a[href^="/word/cukta?"]').first();
  await expect(word).toHaveAttribute("href", "/word/cukta?lang=fr");
});

test("Meaning rejects a French row saved in the English package", async ({
  page,
}) => {
  await savePackages(page, { en: [frenchRow], fr: [frenchRow] });
  await page.goto("/new/meaning?lang=en");
  await page.getByLabel("Lojban word").fill("cukta");
  const typed = page.getByRole("region", { name: "Typed word" });
  await expect(typed).toContainText("The search package is invalid.");
  await expect(typed).not.toContainText("Already exists");
  await expect(typed).not.toContainText(frenchRow.plain_text);
  await expect(
    typed.getByRole("button", { name: "Check this word on the server" }),
  ).toBeVisible();
  await page.getByLabel("Language", { exact: true }).selectOption("fr");
  await expect(typed).toContainText("Local package for fr");
  await expect(
    typed.getByRole("link", { name: frenchRow.plain_text, exact: true }),
  ).toBeVisible();
});

async function countWordIds(page: Page) {
  await page.route("**/jvc_runtime.js*", async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = "function runtime_word_identifier(bytes) {";
    expect(source).toContain(marker);
    await route.fulfill({
      response,
      body: source.replace(
        marker,
        marker + "globalThis.wordIdCalls = (globalThis.wordIdCalls ?? 0) + 1;",
      ),
    });
  });
  await page.route("**/api/v1/words/**", (route) => route.abort());
}

test("a saved pair uses word IDs only when it needs an identity", async ({
  page,
}) => {
  const spellings = ["bajra", "ba'a", "Ba’a", "máik", "水", ".djan.", "ba a"];
  const rows = Array.from({ length: 12 }, (_, i) => ({
    ...englishRow,
    event: "jve1:" + (i + 2).toString(16).padStart(64, "0"),
    word: { language: "jbo", spelling: spellings[i % spellings.length] },
    rafsi: [],
  }));
  await savePackages(page, { en: [englishRow, ...rows] });
  const pair = await cuktaPair(page);
  await countWordIds(page);
  await page.route("**/api/v1/manifest", (route) => route.abort());
  await page.goto(`/rafsi-pair/${pair}`);
  await expect(
    page.locator('main a[href="/word/cukta?lang=en"]').first(),
  ).toBeVisible();
  expect(await page.evaluate(() => (globalThis as any).wordIdCalls)).toBe(2);
});

test("a 30,000-row saved pair makes zero extra word-ID calls and enforces legal and illegal fallback batches", async ({
  page,
}) => {
  await page.goto("/");
  const pair = await cuktaPair(page);
  // Seed 29,999 empty-rafsi rows using safe Unicode spellings plus legal fallback spellings.
  await page.evaluate(async (sample) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    await store.setPreferences({
      definitionLanguage: "en",
      searchMode: "local",
    });
    const rows = Array.from({ length: 30_000 }, (_, i) => ({
      ...sample,
      event: "jve1:" + (i + 1).toString(16).padStart(64, "0"),
      word: {
        language: "jbo",
        spelling:
          i === 0
            ? "cukta"
            : i % 5000 === 0
              ? `𠮷${i}`
              : i % 3 === 0
                ? `ba'a${i}’á`
                : `水`.repeat(10) + String(i),
      },
      rafsi: i === 0 ? ["cuk"] : [],
    }));
    await store.put("packages", "en", {
      version: 2,
      snapshot: "sha256:" + "a".repeat(64),
      entries: rows,
    });
  }, englishRow);
  await countWordIds(page);
  await page.route("**/api/v1/manifest", (route) => route.abort());
  await page.goto(`/rafsi-pair/${pair}`);
  await expect(
    page.locator('main a[href="/word/cukta?lang=en"]').first(),
  ).toBeVisible();
  // One ID for matching row 0 and one for pairCard; zero for the 29,999 tail rows.
  expect(await page.evaluate(() => (globalThis as any).wordIdCalls)).toBe(2);

  // Now place an illegal fallback spelling in the final partial batch after 130 legal fallbacks.
  await page.evaluate(
    async ({ sample, fr }) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const store = new LocalStore();
      const rows = [
        sample,
        ...Array.from({ length: 130 }, (_, i) => ({
          ...sample,
          event: "jve1:" + (i + 2).toString(16).padStart(64, "0"),
          word: { language: "jbo", spelling: `𠮷${i}` },
          rafsi: [],
        })),
        {
          ...sample,
          event: "jve1:" + "f".repeat(64),
          word: { language: "jbo", spelling: "\u1100\u1161" },
          rafsi: [],
        },
      ];
      await store.put("packages", "en", {
        version: 2,
        snapshot: "sha256:" + "a".repeat(64),
        entries: rows,
      });
      await store.put("packages", "fr", {
        version: 2,
        snapshot: "sha256:" + "b".repeat(64),
        entries: [fr],
      });
    },
    { sample: englishRow, fr: frenchRow },
  );
  await page.goto(`/rafsi-pair/${pair}`);
  await expect(
    page.locator('main a[href^="/word/cukta?"]').first(),
  ).toHaveAttribute("href", "/word/cukta?lang=fr");
});

test("a saved pair still rejects an invalid spelling after a match", async ({
  page,
}) => {
  await page.route("**/api/v1/manifest", (route) => route.abort());
  let pair: string | undefined;
  for (const spelling of [
    " cukta",
    "c\u0000ukta",
    "c\u0301ukta",
    "q́",
    "\ud800",
  ]) {
    await savePackages(page, {
      en: [englishRow, { ...englishRow, word: { language: "jbo", spelling } }],
      fr: [frenchRow],
    });
    pair ??= await cuktaPair(page);
    await page.goto(`/rafsi-pair/${pair}`);
    await expect(
      page.locator('main a[href^="/word/cukta?"]').first(),
    ).toHaveAttribute("href", "/word/cukta?lang=fr");
  }
});

test("a downloaded pair uses the word IDs from download validation", async ({
  page,
}) => {
  await countWordIds(page);
  await page.goto(`/rafsi-pair/${fixture().pair}`);
  await expect(
    page.locator('main a[href="/word/cukta?lang=en"]').first(),
  ).toBeVisible();
  const calls = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const pkg = (await new LocalStore().get("packages", "en")) as {
      entries: unknown[];
    };
    return {
      actual: (globalThis as any).wordIdCalls,
      expected: pkg.entries.length + 1,
    };
  });
  expect(calls.actual).toBe(calls.expected);
});

test("nearby defers its package label until the current language passes", async ({
  page,
}) => {
  await savePackages(page, { en: [frenchRow], fr: [frenchRow] });
  await page.goto("/new/meaning?lang=en");
  await page.getByLabel("Lojban word").fill("cukta");
  await expect(page.getByRole("region", { name: "Typed word" })).toContainText(
    "The search package is invalid.",
  );
  const nearby = page.getByRole("region", { name: "Close in meaning" });
  await expect(nearby).not.toContainText("from the downloaded package");
  await expect(
    nearby.getByRole("button", { name: "allow server search" }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Meaning", exact: true })
    .fill("livre");
  await expect(nearby).toContainText("saved package is invalid");
  await page.getByLabel("Language", { exact: true }).selectOption("fr");
  await expect(nearby).toContainText("from the downloaded package");
});

test("nearby consent does not announce a server search during local validation", async ({
  page,
}) => {
  await savePackages(page, { en: [englishRow] });
  await page.addInitScript(() => {
    const held: (() => void)[] = [];
    Object.assign(globalThis, { heldNearby: held });
    const NativeWorker = globalThis.Worker;
    globalThis.Worker = class extends NativeWorker {
      postMessage(message: any, ...options: unknown[]) {
        const send = () =>
          Reflect.apply(super.postMessage, this, [message, ...options]);
        if (message.options?.nearby) held.push(send);
        else send();
      }
    };
  });
  let requests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/v1/search"))
      requests++;
  });
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/new/meaning?lang=en");
  const nearby = page.getByRole("region", { name: "Close in meaning" });
  await page
    .getByRole("textbox", { name: "Meaning", exact: true })
    .fill("book");
  await page.waitForFunction(() => (globalThis as any).heldNearby.length > 0);
  await nearby
    .getByRole("button", { name: /^(allow server search|search this server)$/ })
    .click();
  await page.waitForFunction(() => (globalThis as any).heldNearby.length >= 2);
  await expect(nearby).not.toContainText("searching this server");
  await page.evaluate(() => {
    const held = (globalThis as any).heldNearby as (() => void)[];
    held.splice(0).forEach((release) => release());
  });
  await expect(nearby).toContainText("from the downloaded package");
  await expect(nearby.getByRole("link", { name: "cukta" })).toBeVisible();
  expect(requests).toBe(0);
});

test("nearby announces server search only while its request is pending", async ({
  page,
}) => {
  await savePackages(page, {});
  let release!: () => void;
  const untilReleased = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/search", async (route) => {
    await untilReleased;
    await route.fulfill({
      json: {
        snapshot: "sha256:" + "a".repeat(64),
        view: "jve1:" + "b".repeat(64),
        hits: [],
        next: null,
      },
    });
  });
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/new/meaning?lang=en");
  const nearby = page.getByRole("region", { name: "Close in meaning" });
  await page
    .getByRole("textbox", { name: "Meaning", exact: true })
    .fill("book");
  const request = page.waitForRequest(
    (req) => req.method() === "POST" && req.url().endsWith("/api/v1/search"),
  );
  await nearby.getByRole("button", { name: "allow server search" }).click();
  try {
    await request;
    await expect(nearby).toContainText("searching this server");
  } finally {
    release();
  }
  await expect(nearby).toContainText("No close definitions found on");
  await expect(nearby).not.toContainText("searching this server");
});

test("a rejected package leaves Lujvo part availability unknown", async ({
  page,
}) => {
  await savePackages(
    page,
    { en: [frenchRow] },
    {
      kind: "lujvo",
      meaning: "A disposable meaning.",
      step: 3,
    },
  );
  await page.goto("/new/lujvo");
  await page.getByLabel("Add a part").fill("cukta");
  const add = page.getByRole("button", { name: "Add cukta as entered" });
  await expect(add).toBeVisible();
  const row = add.locator("..");
  await expect(row).toContainText("local dictionary lookup is unavailable");
  await expect(row).not.toContainText("not in the local package");
});

test("unavailable rafsi packages leave server coverage unknown", async ({
  page,
}) => {
  await savePackages(page, {});
  await page.route("**/api/v1/manifest", (route) => route.abort());
  await page.goto("/rafsi/cuk");
  const main = page.locator("main");
  await expect(main).toContainText("Rafsi coverage is unknown.");
  await expect(main).not.toContainText(
    "This server and the saved packages supply no rafsi data.",
  );
  await page.goto(`/rafsi-pair/${fixture().pair}`);
  await expect(main).toContainText("Lookup did not resolve this pair");
  await expect(main).not.toContainText("No retained claim in this server");
});

test("Settings withholds the count for a package with an invalid spelling", async ({
  page,
}) => {
  await savePackages(page, {
    en: [{ ...englishRow, word: { language: "jbo", spelling: " cukta" } }],
  });
  await page.goto("/preferences");
  const row = page
    .locator('[data-package-control="remove"][data-package-language="en"]')
    .locator("..");
  await expect(row).toContainText("The search package is invalid.");
  await expect(row).not.toContainText("1 definition");
});

for (const [path, draft, copy] of [
  [
    "/new/lujvo",
    {
      kind: "lujvo",
      meaning: "A disposable meaning.",
      step: 3,
      lujvo: {
        profile: "cll",
        components: [
          {
            id: "sance",
            spelling: "sance",
            kind: "gismu",
            claims: [],
            locked: null,
            definition: null,
            gloss: "",
          },
          {
            id: "cmalu",
            spelling: "cmalu",
            kind: "gismu",
            claims: [],
            locked: null,
            definition: null,
            gloss: "",
          },
        ],
      },
    },
    "Availability is unknown because there is no usable local package.",
  ],
  [
    "/new/gismu",
    {
      kind: "gismu",
      spelling: "cukte",
      meaning: "A disposable meaning.",
      step: 3,
      gismu: {
        preset: null,
        rows: [
          {
            id: "r1",
            language: "en",
            name: "English",
            weight: { numerator: "1", denominator: "1" },
            word: "book",
            input: "cukte",
            sense: "",
            note: "",
          },
        ],
        candidates: "source-letters",
        window: 12,
        manual: "cukte",
        selected: "cukte",
        acknowledged: [],
        reason: "",
      },
    },
    "Conflict coverage is unknown.",
  ],
  [
    "/new/publish",
    {
      kind: "gismu",
      spelling: "zelpu",
      meaning: "A disposable meaning.",
      text: "A disposable meaning.",
      step: 5,
      rafsiClaims: [{ rafsi: "zel" }],
    },
    "No usable local package is available. Conflict coverage is unknown.",
  ],
  [
    "/search?lang=en",
    undefined,
    "The saved search package for English is invalid. Searches use this server.",
  ],
] as const)
  test(`a rejected package keeps its fallback message on ${path}`, async ({
    page,
  }) => {
    await savePackages(page, { en: [frenchRow] }, draft);
    await page.goto(path);
    const main = page.locator("main");
    await expect(main).toContainText(copy);
    await expect(main).not.toContainText(
      /no (local package is downloaded|downloaded search package|package is downloaded)/i,
    );
  });

test("Meaning nearby reports a query-length error without marking a valid local package unavailable", async ({
  page,
}) => {
  await savePackages(page, { en: [englishRow] });
  await page.goto("/new/meaning?lang=en");
  const nearby = page.getByRole("region", { name: "Close in meaning" });
  await page
    .getByRole("textbox", { name: "Meaning", exact: true })
    .fill("a".repeat(5000));
  await expect(nearby).toContainText("The search query is too long.");
  await expect(nearby).toContainText("by words, from the downloaded package");
  await expect(nearby).not.toContainText("local package unavailable");
  await expect(nearby).not.toContainText(
    "Download a search package in Settings",
  );
});

test("Search does not claim browser storage is unavailable when one package read fails", async ({
  page,
}) => {
  await savePackages(page, { en: [englishRow] });
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (
      this: IDBObjectStore,
      key: IDBValidKey | IDBKeyRange,
    ) {
      if (this.name === "packages") {
        this.transaction.abort();
      }
      return original.call(this, key);
    };
  });
  await page.goto("/search?lang=en");
  const main = page.locator("main");
  await expect(main).toContainText(
    "The saved search package for English could not be read. Searches use this server.",
  );
  await expect(main).not.toContainText("Browser storage is unavailable");
});

test("rafsi routes reject a saved version 1 package with an invalid row", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    await store.setPreferences({
      definitionLanguage: "en",
      searchMode: "local",
    });
    await store.put("packages", "en", {
      version: 1,
      snapshot: "sha256:" + "a".repeat(64),
      entries: [null],
    });
  });
  const pair = await cuktaPair(page);
  await page.route("**/api/v1/manifest*", (route) => route.abort());
  await page.goto("/rafsi/cuk");
  await expect(page.locator("main")).toContainText(
    "The search package is invalid. Search this server or download another package.",
  );
  await page.goto(`/rafsi-pair/${encodeURIComponent(pair)}`);
  await expect(page.locator("main")).toContainText(
    "The search package is invalid. Search this server or download another package.",
  );
});

test("LocalStore.get keeps a cross-tab refreshed language as most recently used", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const dbName = "store-lru-refresh-r7";
    const reader = new LocalStore(dbName);
    const writer = new LocalStore(dbName);
    const makePkg = (lang: string, text: string) => ({
      version: 2,
      snapshot: "sha256:" + "a".repeat(64),
      entries: [
        {
          event: "jve1:" + "1".repeat(64),
          word: { language: "jbo", spelling: "cukta" },
          language: lang,
          glosses: [{ language: lang, text, sense: null }],
          plain_text: text,
          classification: { kind: "gismu", selmaho: [] },
          body: null,
          issuer: "ed25519:" + "a".repeat(64),
          notes: false,
          rafsi: ["cuk"],
          rafsi_complete: true,
          attribution: null,
        },
      ],
    });
    await writer.put("packages", "en", makePkg("en", "book 1"));
    await writer.put("packages", "fr", makePkg("fr", "livre"));
    await writer.put("packages", "jbo", makePkg("jbo", "cukta"));

    await reader.get("packages", "en");
    await reader.get("packages", "fr");
    // Cross-tab update refreshes "en" to a new revision.
    await writer.put("packages", "en", makePkg("en", "book 2"));
    await reader.get("packages", "en");
    // Reading a third language must evict "fr" (LRU) and keep "en" (MRU).
    await reader.get("packages", "jbo");

    const reads: string[] = [];
    const original = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (
      this: IDBObjectStore,
      key: IDBValidKey | IDBKeyRange,
    ) {
      if (this.name === "packages") reads.push(String(key));
      return original.call(this, key);
    };
    try {
      reads.length = 0;
      await reader.get("packages", "en");
      const readsOnEn = [...reads];
      reads.length = 0;
      await reader.get("packages", "fr");
      const readsOnFr = [...reads];
      return { readsOnEn, readsOnFr };
    } finally {
      IDBObjectStore.prototype.get = original;
    }
  });
  expect(result).toEqual({
    readsOnEn: [],
    readsOnFr: ["fr"],
  });
});

test("Meaning typed-word check picks up a cross-tab package download on the same visit", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    await store.setPreferences({
      definitionLanguage: "en",
      searchMode: "local",
    });
    await store.delete("packages", "en");
  });
  await page.goto("/new/meaning?lang=en");
  const wordBox = page.getByRole("textbox", { name: "Lojban word", exact: true });
  const typedRegion = page.getByRole("region", { name: "Typed word" });
  await wordBox.fill("broda");
  await expect(typedRegion).toContainText(
    "No usable local package is available for this language.",
  );

  // Another tab downloads and saves an English package defining cukta.
  await page.evaluate(async (row) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().put("packages", "en", {
      version: 2,
      snapshot: "sha256:" + "a".repeat(64),
      entries: [row],
    });
  }, englishRow);

  await wordBox.fill("cukta");
  await expect(typedRegion).toContainText("Already exists:");
  await expect(typedRegion).toContainText("cukta");
  await expect(typedRegion).toContainText("Local package for en");
});

test("Meaning nearby uses the server after consent when local worker startup fails", async ({
  page,
}) => {
  await savePackages(page, { en: [englishRow] });
  let serverCalls = 0;
  await page.route("**/package-search-worker.ts*", (route) => route.abort());
  await page.route("**/api/v1/search*", async (route) => {
    serverCalls++;
    await route.fulfill({
      json: {
        snapshot: "sha256:" + "a".repeat(64),
        view: "jve1:" + "b".repeat(64),
        hits: [],
        next: null,
      },
    });
  });

  await page.goto("/new/meaning?lang=en");
  const nearby = page.getByRole("region", { name: "Close in meaning" });
  await page
    .getByRole("textbox", { name: "Meaning", exact: true })
    .fill("book");
  await expect(nearby).toContainText("Local search could not start");
  expect(serverCalls).toBe(0);

  page.once("dialog", (dialog) => dialog.accept());
  await nearby.getByRole("button", { name: "allow server search" }).click();
  await expect(nearby).toContainText("No close definitions found on");
  expect(serverCalls).toBe(1);
});

for (const form of ["per-row", "compact"] as const)
  test(`Search and Settings both reject an array row with ${form} search_status`, async ({
    page,
  }) => {
    await page.route("**/api/**", (route) =>
      route.fulfill({ status: 503, body: "unavailable" }),
    );
    await page.goto("/");
    await page.evaluate(
      async ({ baseRow, mode }) => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        const view = "jve1:" + "9".repeat(64);
        const row =
          mode === "compact"
            ? Object.assign([], baseRow, { search_status: "active" })
            : Object.assign([], baseRow, {
                search_status: { view, status: "active" },
              });
        const pkg =
          mode === "compact"
            ? {
                version: 2,
                snapshot: "sha256:" + "a".repeat(64),
                search_view: view,
                entries: [row],
              }
            : {
                version: 2,
                snapshot: "sha256:" + "a".repeat(64),
                entries: [row],
              };
        const store = new LocalStore();
        await store.setPreferences({
          definitionLanguage: "en",
          searchMode: "local",
        });
        await store.put("packages", "en", pkg);
      },
      { baseRow: englishRow, mode: form },
    );

    await page.goto("/search?lang=en");
    await expect(page.locator("main")).toContainText(
      "The saved search package for English is invalid. Searches use this server.",
    );

    await page.goto("/search?q=cukta&lang=en");
    await expect(page.locator("main")).toContainText("Search server:");
    await expect(page.locator("main")).not.toContainText(
      "the downloaded English package",
    );
    await expect(page.locator("main")).not.toContainText("book");

    await page.goto("/preferences");
    await expect(page.locator("main")).toContainText(
      "The search package is invalid. Search this server or download another package.",
    );
  });

test("Meaning nearby keeps overlong queries local when no local package is usable", async ({
  page,
}) => {
  let serverCalls = 0;
  await page.route("**/api/v1/search*", async (route) => {
    serverCalls++;
    await route.fulfill({
      json: {
        snapshot: "sha256:" + "a".repeat(64),
        view: "jve1:" + "b".repeat(64),
        hits: [],
        next: null,
      },
    });
  });

  await page.goto("/new/meaning?lang=en");
  const meaningBox = page.getByRole("textbox", { name: "Meaning", exact: true });
  const nearby = page.getByRole("region", { name: "Close in meaning" });

  // Overlong query with no local package shows the local limit error, hides
  // server consent, and sends zero requests.
  await meaningBox.fill("a".repeat(4097));
  await expect(nearby).toContainText(
    "The search query is too long. Queries accept at most 4096 characters.",
  );
  await expect(
    nearby.getByRole("button", { name: "allow server search" }),
  ).toHaveCount(0);
  expect(serverCalls).toBe(0);

  // Even after granting consent for a valid first word ("book"), appending an
  // overlong second word still stays local and sends no new server request.
  await meaningBox.fill("book");
  page.once("dialog", (dialog) => dialog.accept());
  await nearby.getByRole("button", { name: "allow server search" }).click();
  await expect(nearby).toContainText("No close definitions found on");
  expect(serverCalls).toBe(1);

  await meaningBox.fill(`book ${"a".repeat(4097)}`);
  await expect(nearby).toContainText(
    "The search query is too long. Queries accept at most 4096 characters.",
  );
  await page.waitForTimeout(800);
  expect(serverCalls).toBe(1);
});

for (const kind of ["dates", "selmaho"] as const)
  test(`fresh-read structural reuse compares a shared ${kind} object once across 128 rows within a 10,000-unit budget`, async ({
    page,
  }) => {
    await page.goto("/");
    const result = await page.evaluate(async (kind) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { searchPackage } = await import(
        String("/src/data/package-search.ts")
      );
      const n = 128;
      const db = `shared-graph-${kind}-${Date.now()}`;
      const store = new LocalStore(db);
      const sharedDates = Object.fromEntries(
        Array.from({ length: n }, (_, i) => [
          "k" + i.toString(16).padStart(8, "0"),
          "1",
        ]),
      );
      const sharedSelmaho = Array.from({ length: n }, () => "UI");
      const pick = (entry: any) =>
        kind === "dates"
          ? entry.attribution.dates
          : entry.classification.selmaho;
      const pkg = {
        version: 2 as const,
        snapshot: "sha256:" + "a".repeat(64),
        entries: Array.from({ length: n }, (_, i) => ({
          event: "jve1:" + (i + 1).toString(16).padStart(64, "0"),
          word: { language: "jbo" as const, spelling: "cukta" },
          language: "en",
          glosses: [],
          plain_text: "book",
          classification: {
            kind: "gismu" as const,
            selmaho: kind === "selmaho" ? sharedSelmaho : [],
          },
          body: null,
          issuer: "ed25519:" + "a".repeat(64),
          notes: false,
          rafsi: [],
          attribution: {
            source: "fixture",
            author: null,
            account: null,
            dates: kind === "dates" ? sharedDates : {},
          },
        })),
      };
      try {
        await store.put("packages", "en", pkg);
        const first = await store.get("packages", "en");
        const coldPrepared = (await searchPackage(first, "en", [])).prepared;

        const fresh = await new LocalStore(db).get("packages", "en");
        const left = pick(first.entries[0]);
        const right = pick(fresh.entries[0]);
        let calls = 0;
        const nativeOwnKeys = Reflect.ownKeys;
        Reflect.ownKeys = function (target: object) {
          if (target === left || target === right) calls++;
          return nativeOwnKeys(target);
        };
        let freshPrepared: boolean;
        try {
          freshPrepared = (await searchPackage(fresh, "en", [])).prepared;
        } finally {
          Reflect.ownKeys = nativeOwnKeys;
        }

        const again = await new LocalStore(db).get("packages", "en");
        const boundedPrepared = (
          await searchPackage(again, "en", [], { workLimit: 10_000 })
        ).prepared;

        return {
          coldPrepared,
          freshPrepared,
          boundedPrepared,
          calls,
          aliasedFirst: pick(first.entries[n - 1]) === left,
          aliasedFresh: pick(fresh.entries[n - 1]) === right,
          distinct: left !== right,
        };
      } finally {
        indexedDB.deleteDatabase(db);
      }
    }, kind);

    expect(result).toEqual({
      coldPrepared: true,
      freshPrepared: false,
      boundedPrepared: false,
      calls: 2,
      aliasedFirst: true,
      aliasedFresh: true,
      distinct: true,
    });
  });

for (const kind of ["dates", "selmaho"] as const)
  test(`conflicting ${kind} sharing across 8, 16, and 32 squares falls back to cold preparation in linear work and passes the 19,200-unit search`, async ({
    page,
  }) => {
    await page.goto("/");
    const results = await page.evaluate(async (kind) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { searchPackage } = await import(
        String("/src/data/package-search.ts")
      );
      const pick = (entry: any) =>
        kind === "dates"
          ? entry.attribution.dates
          : entry.classification.selmaho;
      const out = [];
      for (const k of [8, 16, 32]) {
        const db = `cross-sharing-${kind}-${k}-${Date.now()}`;
        const make = (byColumn: boolean) => {
          const shared = Array.from({ length: k }, () =>
            kind === "dates"
              ? Object.fromEntries(
                  Array.from({ length: 4 * k }, (_, j) => [
                    "k" + j.toString(16).padStart(8, "0"),
                    "1",
                  ]),
                )
              : Array.from({ length: 4 * k }, () => "UI"),
          );
          return {
            version: 2 as const,
            snapshot: "sha256:" + "a".repeat(64),
            entries: Array.from({ length: k * k }, (_, i) => {
              const value = shared[byColumn ? i % k : Math.floor(i / k)];
              return {
                event: "jve1:" + (i + 1).toString(16).padStart(64, "0"),
                word: { language: "jbo" as const, spelling: "cukta" },
                language: "en",
                glosses: [],
                plain_text: "book",
                classification: {
                  kind: "gismu" as const,
                  selmaho: kind === "selmaho" ? (value as string[]) : [],
                },
                body: null,
                issuer: "ed25519:" + "a".repeat(64),
                notes: false,
                rafsi: [],
                attribution: {
                  source: "fixture",
                  author: null,
                  account: null,
                  dates:
                    kind === "dates"
                      ? (value as Record<string, string>)
                      : {},
                },
              };
            }),
          };
        };
        try {
          const store = new LocalStore(db);
          await store.put("packages", "en", make(false));
          const first = await store.get("packages", "en");
          const coldPrepared = (await searchPackage(first, "en", [])).prepared;

          // Replace stored value in place while preserving the revision marker.
          const rawDb = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open(db);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          await new Promise<void>((resolve, reject) => {
            const tx = rawDb.transaction("packages", "readwrite");
            tx.objectStore("packages").put(make(true), "en");
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error);
          });
          rawDb.close();

          const fresh = await new LocalStore(db).get("packages", "en");
          const watched = new Set([
            ...first.entries.map(pick),
            ...fresh.entries.map(pick),
          ]);
          const nativeOwnKeys = Reflect.ownKeys;
          let calls = 0;
          let keys = 0;
          let freshPrepared: boolean;
          Reflect.ownKeys = function (target: object) {
            const list = nativeOwnKeys(target);
            if (watched.has(target)) {
              calls++;
              keys += list.length;
            }
            return list;
          };
          try {
            freshPrepared = (await searchPackage(fresh, "en", [])).prepared;
          } finally {
            Reflect.ownKeys = nativeOwnKeys;
          }

          const again = await new LocalStore(db).get("packages", "en");
          const boundedPrepared = (
            await searchPackage(again, "en", [], { workLimit: 75 * k * k })
          ).prepared;
          out.push({ k, coldPrepared, freshPrepared, calls, keys, boundedPrepared });
        } finally {
          indexedDB.deleteDatabase(db);
        }
      }
      return out;
    }, kind);

    for (const row of results) {
      expect(row.coldPrepared).toBe(true);
      expect(row.boundedPrepared).toBe(false);
      // Side 8 fits inside the 2x distinct-size cap and reuses as equal content;
      // sides 16 and 32 hit the 2x cap and fall back to cold preparation, then
      // the 75 * k * k (19,200 / 76,800) search succeeds cleanly.
      expect(row.freshPrepared).toBe(row.k > 8);
      // keys counts both copies, staying O(k^2) (well below uncapped 262,144 at k=32).
      expect(row.keys).toBeLessThan(2 * 75 * row.k * row.k);
      if (row.k === 32) expect(row.keys).toBeLessThan(150_000);
    }
  });

test("equal content with changed sharing reuses warm index, and four-depth named-property graph falls back cleanly at 82,688 units", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { searchPackage } = await import(
      String("/src/data/package-search.ts")
    );
    const fields = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, "x"]));
    const makeRow = (i: number) => ({
      event: "jve1:" + (i + 1).toString(16).padStart(64, "0"),
      word: { language: "jbo" as const, spelling: "cukta" },
      language: "en",
      glosses: [],
      plain_text: "book",
      classification: { kind: "gismu" as const, selmaho: [] as string[] },
      body: null,
      issuer: "ed25519:" + "a".repeat(64),
      notes: false,
      rafsi: [] as string[],
      attribution: {
        source: "fixture",
        author: null,
        account: null,
        dates: {} as Record<string, string>,
      },
    });
    const wrap = (entries: ReturnType<typeof makeRow>[]) => ({
      version: 2 as const,
      snapshot: "sha256:" + "a".repeat(64),
      entries,
    });
    const rawPut = async (dbName: string, value: unknown) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("packages", "readwrite");
          tx.objectStore("packages").put(value, "en");
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    };

    const sharingCases: Array<{
      label: string;
      prepared: boolean;
      hits: number;
    }> = [];
    for (const [field, n] of [
      ["word", 0],
      ["selmaho", 23],
      ["dates", 24],
      ["text", 127],
      ["cross", 23],
    ] as const) {
      for (const split of [true, false]) {
        const db = `r4-share-${field}-${n}-${split}-${Date.now()}`;
        const build = (shared: boolean) => {
          const a = makeRow(0);
          const b = makeRow(1);
          const make = () =>
            field === "word"
              ? { language: "jbo" as const, spelling: "cukta" }
              : field === "dates"
                ? fields(n)
                : field === "text"
                  ? { day: "x".repeat(64 * n) }
                  : Array.from({ length: n }, () => "cuk");
          const v = make();
          const w = shared ? v : make();
          if (field === "word") {
            a.word = v as any;
            b.word = w as any;
          } else if (field === "dates" || field === "text") {
            a.attribution.dates = v as any;
            b.attribution.dates = w as any;
          } else if (field === "cross") {
            a.classification.selmaho = v as any;
            a.rafsi = w as any;
          } else {
            a.classification.selmaho = v as any;
            b.classification.selmaho = w as any;
          }
          return wrap([a, b]);
        };
        try {
          const store = new LocalStore(db);
          await store.put("packages", "en", build(split));
          const old = await store.get("packages", "en");
          await searchPackage(old, "en", ["cukta"]);
          await rawPut(db, build(!split));
          const fresh = await new LocalStore(db).get("packages", "en");
          const res = await searchPackage(fresh, "en", ["cukta"]);
          sharingCases.push({
            label: `${field}:${n}:${split}`,
            prepared: res.prepared,
            hits: res.hits[0]?.length ?? 0,
          });
        } finally {
          indexedDB.deleteDatabase(db);
        }
      }
    }

    // Four-depth graph attached to a named property on selmaho must hit the
    // comparison work cap, decline reuse, take the cold path, and succeed at
    // workLimit: 82,688.
    const dname = `r4-nested-depth-${Date.now()}`;
    const leaf = fields(14);
    const small = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`s${i}`, leaf]),
    );
    const wide = Array.from({ length: 256 }, () => small);
    const folded: Record<string, unknown> = {};
    for (let d = 0; d < 4; d++) {
      let obj: unknown = wide;
      for (let j = 0; j < d; j++) obj = { v: obj };
      folded[`d${d}`] = obj;
    }
    const row = makeRow(0);
    (row.classification.selmaho as unknown as Record<string, unknown>).extra =
      folded;
    let nestedCold = false;
    let nestedFallbackPrepared = false;
    try {
      const store = new LocalStore(dname);
      await store.put("packages", "en", wrap([row]));
      const before = await store.get("packages", "en");
      nestedCold = (await searchPackage(before, "en", [])).prepared;
      const after = await new LocalStore(dname).get("packages", "en");
      nestedFallbackPrepared = (
        await searchPackage(after, "en", [], { workLimit: 82_688 })
      ).prepared;
    } finally {
      indexedDB.deleteDatabase(dname);
    }
    return { sharingCases, nestedCold, nestedFallbackPrepared };
  });

  for (const item of result.sharingCases) {
    expect(item, item.label).toEqual({
      label: item.label,
      prepared: false,
      hits: 1,
    });
  }
  expect(result.nestedCold).toBe(true);
  expect(result.nestedFallbackPrepared).toBe(true);
});
