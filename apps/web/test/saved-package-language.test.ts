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
    event: "jve1:2" + (i + 1).toString(16).padStart(63, "0"),
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
