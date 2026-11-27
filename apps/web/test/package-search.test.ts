import { test, expect } from "@playwright/test";

test("package search survives fresh storage reads and invalidates same-snapshot writes from another connection", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { searchPackage } = await import(
      String("/src/data/package-search.ts")
    );
    const store = new LocalStore("search-cache-r2");
    const writer = new LocalStore("search-cache-r2");
    const pkg = (text: string) => ({
      snapshot: "sha256:" + "a".repeat(64),
      entries: [
        {
          event: "jve1:" + "b".repeat(64),
          word: { language: "jbo", spelling: "klama" },
          language: "en",
          glosses: [],
          plain_text: text,
          classification: { kind: "gismu", selmaho: [] },
          body: null,
        },
      ],
    });
    await writer.put("packages", "en", pkg("old meaning"));
    const first = await store.get("packages", "en");
    const cold = await searchPackage(first, "en", ["old"]);
    const sameSnapshot = await searchPackage(first, "en", ["old"]);
    const second = await store.get("packages", "en");
    const warm = await searchPackage(second, "en", ["old"]);
    const otherRead = await writer.get("packages", "en");
    const shared = await searchPackage(otherRead, "en", ["old"]);
    await writer.put("packages", "en", pkg("new meaning"));
    const replacement = await store.get("packages", "en");
    const updated = await searchPackage(replacement, "en", ["new", "old"]);
    try {
      await writer.put("packages", "en", () => {});
    } catch {}
    const afterFailure = await store.get("packages", "en");
    const afterFailureSearch = await searchPackage(afterFailure, "en", ["new"]);
    const random = crypto.getRandomValues;
    crypto.getRandomValues = () => {
      throw new Error("Synthetic revision failure.");
    };
    try {
      try {
        await writer.put("packages", "en", pkg("wrong meaning"));
      } catch {}
      try {
        await writer.delete("packages", "en");
      } catch {}
    } finally {
      crypto.getRandomValues = random;
    }
    const afterNonceFailure = await store.get("packages", "en");
    const afterNonceFailureSearch = await searchPackage(
      afterNonceFailure,
      "en",
      ["new"],
    );
    await writer.delete("packages", "en");
    const deleted = await store.get("packages", "en");
    return {
      retained: first === second,
      freshAcrossConnections: otherRead !== first,
      replaced: first !== replacement,
      sameSnapshot: first.snapshot === replacement.snapshot,
      cold: cold.hits[0].length,
      sameSnapshotWarm: !sameSnapshot.prepared,
      sameSnapshotParses: sameSnapshot.metrics.headwordsParsed,
      warm: warm.hits[0].length,
      warmPrepared: warm.prepared,
      warmParses: warm.metrics.headwordsParsed,
      reusedAcrossConnections: !shared.prepared,
      keptAfterNonceFailure:
        afterNonceFailure === replacement &&
        !afterNonceFailureSearch.prepared &&
        afterNonceFailureSearch.hits[0][0]?.preview?.plain_text ===
          "new meaning",
      updated: updated.hits.map((rows: any[]) =>
        rows.map((hit: any) => hit.preview?.plain_text),
      ),
      keptAfterFailure:
        afterFailure === replacement &&
        !afterFailureSearch.prepared &&
        afterFailureSearch.hits[0][0]?.preview?.plain_text === "new meaning",
      deleted: deleted === undefined,
    };
  });
  expect(result).toEqual({
    retained: true,
    freshAcrossConnections: true,
    replaced: true,
    sameSnapshot: true,
    cold: 1,
    sameSnapshotWarm: true,
    sameSnapshotParses: 0,
    warm: 1,
    warmPrepared: false,
    warmParses: 0,
    reusedAcrossConnections: true,
    keptAfterNonceFailure: true,
    updated: [["new meaning"], []],
    keptAfterFailure: true,
    deleted: true,
  });
});

test("session reads reuse one snapshot, pick up app and cross-tab writes, and catch raw IndexedDB edits on reload", async ({
  page,
}) => {
  await page.goto("/");
  const firstPhase = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { searchPackage, PackageValidationError } = await import(
      String("/src/data/package-search.ts")
    );
    const dbName = "raw-idb-verdict-135";
    const store = new LocalStore(dbName);
    const other = new LocalStore(dbName);
    const row = (id: string, spelling: string, text: string, lang = "en") => ({
      event: "jve1:" + id.repeat(64),
      word: { language: "jbo", spelling },
      language: lang,
      glosses: [{ language: lang, text, sense: null }],
      plain_text: text,
      classification: { kind: "gismu", selmaho: [] },
      body: null,
    });
    const makePkg = (entries: unknown[]) => ({
      snapshot: "sha256:" + "a".repeat(64),
      version: 1,
      entries,
    });
    const rawPut = async (value: unknown) => {
      const db = await store.database;
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("packages", "readwrite");
        tx.objectStore("packages").put(value, "en");
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    };
    const initial = makePkg([
      row("1", "klama", "come"),
      row("2", "cukta", "book"),
    ]);
    await store.put("packages", "en", initial);
    const revBefore = await store.packageRevisionOf("en");
    const snap1 = await store.get("packages", "en");
    const cold = await searchPackage(snap1, "en", ["come"]);
    // Repeat get within one session reuses the exact same snapshot object.
    const snap2 = await store.get("packages", "en");
    const sameTwice = await searchPackage(snap2, "en", ["book"]);

    // App's own write is picked up immediately in the open session.
    await store.put(
      "packages",
      "en",
      makePkg([
        row("1", "cukta", "own write volume"),
        row("2", "klama", "come"),
      ]),
    );
    const afterOwnWrite = await store.get("packages", "en");
    const ownWriteSearch = await searchPackage(afterOwnWrite, "en", ["own"]);

    // Another connection's write (new revision) is picked up immediately.
    await other.put(
      "packages",
      "en",
      makePkg([
        row("1", "cukta", "other tab volume"),
        row("2", "klama", "travel"),
      ]),
    );
    const afterOtherWrite = await store.get("packages", "en");
    const otherWriteSearch = await searchPackage(afterOtherWrite, "en", [
      "other",
    ]);

    // A second connection reading the same revision gets a fresh clone that
    // reuses worker preparation after structural equality, and then reuses its alias.
    const freshOther = await other.get("packages", "en");
    const freshOtherSearch = await searchPackage(freshOther, "en", ["travel"]);
    const freshOtherAlias = await searchPackage(freshOther, "en", ["other"]);

    // Raw IndexedDB edit keeping the same revision: invalid late row.
    const revBeforeRaw = await store.packageRevisionOf("en");
    await rawPut(
      makePkg([row("1", "klama", "come"), row("2", "cukta", "livre", "fr")]),
    );
    const revAfterRaw = await store.packageRevisionOf("en");
    // A fresh connection reading storage catches the invalid raw edit directly.
    const third = new LocalStore(dbName);
    let freshConnRejected = false;
    try {
      await searchPackage(await third.get("packages", "en"), "en", ["come"]);
    } catch (error) {
      freshConnRejected =
        error instanceof PackageValidationError ||
        (error as Error).constructor.name === "PackageValidationError";
    }

    return {
      revChangedOnWrites: revBefore !== revBeforeRaw,
      sameRevisionOnRaw: revBeforeRaw === revAfterRaw,
      sameSnapshotReused: snap1 === snap2,
      coldWord: cold.hits[0][0]?.word.spelling,
      sameTwicePrepared: sameTwice.prepared,
      sameTwiceParses: sameTwice.metrics.headwordsParsed,
      sameTwiceWord: sameTwice.hits[0][0]?.word.spelling,
      ownWritePrepared: ownWriteSearch.prepared,
      ownWriteText: ownWriteSearch.hits[0][0]?.preview?.plain_text,
      otherWritePrepared: otherWriteSearch.prepared,
      otherWriteText: otherWriteSearch.hits[0][0]?.preview?.plain_text,
      freshOtherReused: !freshOtherSearch.prepared,
      freshOtherAliasReused: !freshOtherAlias.prepared,
      freshConnRejected,
    };
  });
  expect(firstPhase).toEqual({
    revChangedOnWrites: true,
    sameRevisionOnRaw: true,
    sameSnapshotReused: true,
    coldWord: "klama",
    sameTwicePrepared: false,
    sameTwiceParses: 0,
    sameTwiceWord: "cukta",
    ownWritePrepared: true,
    ownWriteText: "own write volume",
    otherWritePrepared: true,
    otherWriteText: "other tab volume",
    freshOtherReused: true,
    freshOtherAliasReused: true,
    freshConnRejected: true,
  });

  // Reload catches the raw IndexedDB invalid edit that preserved the revision.
  await page.reload();
  const afterInvalidReload = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { searchPackage, PackageValidationError } = await import(
      String("/src/data/package-search.ts")
    );
    const dbName = "raw-idb-verdict-135";
    const store = new LocalStore(dbName);
    let rejected = false;
    try {
      await searchPackage(await store.get("packages", "en"), "en", ["come"]);
    } catch (error) {
      rejected =
        error instanceof PackageValidationError ||
        (error as Error).constructor.name === "PackageValidationError";
    }
    // Now overwrite raw IndexedDB with a valid row-order/meaning change keeping the revision.
    const db = await store.database;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("packages", "readwrite");
      tx.objectStore("packages").put(
        {
          snapshot: "sha256:" + "a".repeat(64),
          version: 1,
          entries: [
            {
              event: "jve1:" + "1".repeat(64),
              word: { language: "jbo", spelling: "cukta" },
              language: "en",
              glosses: [{ language: "en", text: "revised volume", sense: null }],
              plain_text: "revised volume",
              classification: { kind: "gismu", selmaho: [] },
              body: null,
            },
            {
              event: "jve1:" + "2".repeat(64),
              word: { language: "jbo", spelling: "klama" },
              language: "en",
              glosses: [{ language: "en", text: "travel", sense: null }],
              plain_text: "travel",
              classification: { kind: "gismu", selmaho: [] },
              body: null,
            },
          ],
        },
        "en",
      );
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    return { rejected };
  });
  expect(afterInvalidReload).toEqual({ rejected: true });

  // Next reload reads and prepares the raw-edited valid package fresh, then delete removes it.
  await page.reload();
  const afterReload = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { searchPackage } = await import(
      String("/src/data/package-search.ts")
    );
    const store = new LocalStore("raw-idb-verdict-135");
    const pkg = await store.get("packages", "en");
    const res = await searchPackage(pkg, "en", ["revised"]);
    await store.delete("packages", "en");
    const gone = await store.get("packages", "en");
    return {
      prepared: res.prepared,
      word: res.hits[0][0]?.word.spelling,
      text: res.hits[0][0]?.preview?.plain_text,
      deleted: gone === undefined,
    };
  });
  expect(afterReload).toEqual({
    prepared: true,
    word: "cukta",
    text: "revised volume",
    deleted: true,
  });
});

test("another tab invalidates the retained package and its worker index", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { searchPackage } = await import(
      String("/src/data/package-search.ts")
    );
    const store = new LocalStore("search-tab-r2");
    (window as any).packageReader = store;
    await store.put("packages", "en", {
      snapshot: "sha256:" + "a".repeat(64),
      entries: [],
    });
    await searchPackage((await store.get("packages", "en"))!, "en", ["klama"]);
  });
  const other = await context.newPage();
  await other.goto("/");
  await other.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore("search-tab-r2").delete("packages", "en");
  });
  expect(
    await page.evaluate(
      async () =>
        (await (window as any).packageReader.get("packages", "en")) ===
        undefined,
    ),
  ).toBe(true);
  await other.close();
});

test("a failed worker preparation can retry the same package object", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { searchPackage } = await import(
      String("/src/data/package-search.ts")
    );
    const pkg = { snapshot: "invalid", entries: [] };
    let rejected = false;
    try {
      await searchPackage(pkg, "en", ["klama"]);
    } catch {
      rejected = true;
    }
    pkg.snapshot = "sha256:" + "a".repeat(64);
    return {
      rejected,
      retried: (await searchPackage(pkg, "en", ["klama"])).hits[0].length,
    };
  });
  expect(result).toEqual({ rejected: true, retried: 0 });
});

test("package writes and deletion work on a plain HTTP origin", async ({
  page,
  baseURL,
}) => {
  await page.route("http://readonly.invalid/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Read only HTTP</title>",
      });
    return route.fulfill({
      response: await route.fetch({ url: baseURL + url.pathname + url.search }),
    });
  });
  await page.goto("http://readonly.invalid/");
  const result = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore("http-package-r2");
    await store.put("packages", "en", { snapshot: "example", entries: [] });
    const saved = await store.get("packages", "en");
    await store.delete("packages", "en");
    return {
      secure: isSecureContext,
      randomUUID: typeof crypto.randomUUID,
      saved: saved !== undefined,
      deleted: (await store.get("packages", "en")) === undefined,
    };
  });
  expect(result).toEqual({
    secure: false,
    randomUUID: "undefined",
    saved: true,
    deleted: true,
  });
});

test("a valid local package never uploads its query after a worker startup failure", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().put("packages", "en", {
      snapshot: "sha256:" + "a".repeat(64),
      entries: [],
    });
  });
  const uploads: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/search")) uploads.push(request.url());
  });
  await page.route("**/package-search-worker.ts*", (route) => route.abort());
  await page.goto("/search?q=private-worker-failure&lang=en");
  await expect(page.locator("main .notice")).toContainText(
    "Local search could not start.",
  );
  expect(uploads).toEqual([]);
});

test("built assets start a static local-search worker under the server CSP", async ({
  page,
}) => {
  const origin = `http://127.0.0.1:${process.env.JVC_TEST_API_PORT ?? "8797"}`;
  const workers: string[] = [];
  page.on("worker", (worker) => workers.push(worker.url()));
  await page.goto(origin + "/preferences");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.locator("div.status[role=status]")).toContainText(
    "search package is saved",
  );
  const uploads: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/search")) uploads.push(request.url());
  });
  await page.goto(origin + "/search?q=cukta&lang=en");
  await expect(
    page
      .getByRole("region", { name: "Search results" })
      .getByRole("link", { name: "cukta", exact: true }),
  ).toBeVisible();
  expect(
    workers.some(
      (url) => url.startsWith(origin + "/assets/") && url.endsWith(".js"),
    ),
  ).toBe(true);
  expect(uploads).toEqual([]);
});

test("stored-package search keeps a prefix-shaped compound after ordinary prefixes", async ({
  page,
}) => {
  await page.goto("/");
  const hits = await page.evaluate(async () => {
    const { searchPackage } = await import(
      String("/src/data/package-search.ts")
    );
    const pkg = {
      snapshot: "sha256:" + "a".repeat(64),
      entries: ["sefa'e", "selbri", "se'a", "se"].map((spelling, index) => ({
        event: "jve1:" + (index + 1).toString(16).padStart(64, "0"),
        word: { language: "jbo", spelling },
        language: "en",
        glosses: [],
        plain_text: "Synthetic definition.",
        classification: { kind: index === 1 ? "lujvo" : "cmavo", selmaho: [] },
        body: null,
      })),
    };
    return (await searchPackage(pkg, "en", ["se", "sef"])).hits.map(
      (rows: any[]) => rows.map((hit: any) => [hit.word.spelling, hit.match]),
    );
  });
  expect(hits[0][0]).toEqual(["se", "headword"]);
  expect(
    hits[0]
      .slice(1, 3)
      .map(([word]: string[]) => word)
      .sort(),
  ).toEqual(["se'a", "selbri"]);
  expect(hits[0][3]).toEqual(["sefa'e", "sequence-subsequence"]);
  expect(hits[1]).toEqual([["sefa'e", "headword-prefix"]]);
});

test("download, saved cache, and search worker retain the package view once", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { downloadPackage, validateCachedPackage } = await import(
      String("/src/data/search.ts")
    );
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { searchPackage } = await import(
      String("/src/data/package-search.ts")
    );
    const store = new LocalStore("package-binding-r3");
    const pkg = await downloadPackage("en");
    validateCachedPackage(pkg, "en");
    await store.put("packages", "en", pkg);
    const cached = await store.get("packages", "en");
    const hits = await searchPackage(cached, "en", ["cukta"], {
      grouped: true,
      view: pkg.search_view,
    });
    return {
      view: pkg.search_view,
      cachedView: cached.search_view,
      statuses: pkg.entries.map(
        (entry: { search_status?: unknown }) => entry.search_status,
      ),
      known: hits.allLojban,
      downgrade: pkg.downgrade,
    };
  });
  expect(result.view).toMatch(/^jve1:[a-f0-9]{64}$/);
  expect(result.cachedView).toBe(result.view);
  expect(result.statuses.length).toBeGreaterThan(0);
  expect(
    result.statuses.every(
      (status: unknown) =>
        typeof status === "string" &&
        ["active", "retired", "ineligible"].includes(status),
    ),
  ).toBe(true);
  expect(result.known).toBe(true);
  expect(result.downgrade).toBeNull();
});

test("a zero-unit transfer checks list shapes first and walks no attribution dates", async ({ page }) => {
  // 100 valid version-2 entries with 128 attribution dates each. The unbudgeted
  // list-shape pass checks all 100 rows before the first budget check, and then
  // workLimit 0 refuses before inspecting any attribution date map, while the
  // default budget inspects the date maps and returns one hit with 100 entries.
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { searchPackage } = await import(
      String("/src/data/package-search.ts")
    );
    let dateOwnKeys = 0;
    let dateReads = 0;
    const proxiedDates = () =>
      new Proxy(
        Object.fromEntries(
          Array.from({ length: 128 }, (_, index) => [
            `d${index}`,
            "2020-01-01",
          ]),
        ),
        {
          ownKeys(target) {
            dateOwnKeys++;
            return Reflect.ownKeys(target);
          },
          get(target, prop, receiver) {
            if (typeof prop === "string" && prop.startsWith("d")) dateReads++;
            return Reflect.get(target, prop, receiver);
          },
        },
      );
    const rawEntries = Array.from({ length: 100 }, (_, index) => ({
      event: "jve1:" + (index + 1).toString(16).padStart(64, "0"),
      word: { language: "jbo", spelling: "broda" },
      language: "en",
      glosses: [],
      plain_text: "book",
      classification: { kind: "gismu", selmaho: [] },
      body: null,
      issuer: "ed25519:" + "a".repeat(64),
      notes: false,
      rafsi: [],
      attribution: {
        source: "test",
        author: null,
        account: null,
        dates: proxiedDates(),
      },
    }));
    let rowReads = 0;
    const entries = new Proxy(rawEntries, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && /^\d+$/.test(prop)) rowReads++;
        return Reflect.get(target, prop, receiver);
      },
    });
    const pkg = { snapshot: "sha256:" + "a".repeat(64), version: 2, entries };
    try {
      await searchPackage(pkg as never, "en", ["book"], { workLimit: 0 });
      return { refused: false, rowReads, dateOwnKeys, dateReads };
    } catch (error) {
      return {
        refused: true,
        constructor: (error as Error).constructor.name,
        phase: (error as { phase?: string }).phase ?? null,
        rowReads,
        dateOwnKeys,
        dateReads,
      };
    }
  });
  expect(result).toEqual({
    refused: true,
    constructor: "SearchBudgetError",
    phase: "prepare",
    rowReads: 100,
    dateOwnKeys: 0,
    dateReads: 0,
  });
  const spyControl = await page.evaluate(async () => {
    const { searchPackage } = await import(
      String("/src/data/package-search.ts")
    );
    let dateOwnKeys = 0;
    let dateReads = 0;
    const proxiedDates = () =>
      new Proxy(
        Object.fromEntries(
          Array.from({ length: 128 }, (_, index) => [
            `d${index}`,
            "2020-01-01",
          ]),
        ),
        {
          ownKeys(target) {
            dateOwnKeys++;
            return Reflect.ownKeys(target);
          },
          get(target, prop, receiver) {
            if (typeof prop === "string" && prop.startsWith("d")) dateReads++;
            return Reflect.get(target, prop, receiver);
          },
        },
      );
    const entries = Array.from({ length: 100 }, (_, index) => ({
      event: "jve1:" + (index + 1).toString(16).padStart(64, "0"),
      word: { language: "jbo", spelling: "broda" },
      language: "en",
      glosses: [],
      plain_text: "book",
      classification: { kind: "gismu", selmaho: [] },
      body: null,
      issuer: "ed25519:" + "a".repeat(64),
      notes: false,
      rafsi: [],
      attribution: {
        source: "test",
        author: null,
        account: null,
        dates: proxiedDates(),
      },
    }));
    try {
      await searchPackage(
        { snapshot: "sha256:" + "a".repeat(64), version: 2, entries } as never,
        "en",
        ["book"],
        { workLimit: 50 },
      );
      return { refused: false, dateChecked: dateOwnKeys > 0 && dateReads > 0 };
    } catch (error) {
      return {
        refused: true,
        constructor: (error as Error).constructor.name,
        dateChecked: dateOwnKeys > 0 && dateReads > 0,
      };
    }
  });
  expect(spyControl).toEqual({
    refused: true,
    constructor: "SearchBudgetError",
    dateChecked: true,
  });
  const control = await page.evaluate(async () => {
    const { searchPackage } = await import(
      String("/src/data/package-search.ts")
    );
    const plainDates = () =>
      Object.fromEntries(
        Array.from({ length: 128 }, (_, index) => [`d${index}`, "2020-01-01"]),
      );
    const entries = Array.from({ length: 100 }, (_, index) => ({
      event: "jve1:" + (index + 1).toString(16).padStart(64, "0"),
      word: { language: "jbo", spelling: "broda" },
      language: "en",
      glosses: [],
      plain_text: "book",
      classification: { kind: "gismu", selmaho: [] },
      body: null,
      issuer: "ed25519:" + "a".repeat(64),
      notes: false,
      rafsi: [],
      attribution: {
        source: "test",
        author: null,
        account: null,
        dates: plainDates(),
      },
    }));
    const hits = await searchPackage(
      { snapshot: "sha256:" + "a".repeat(64), version: 2, entries } as never,
      "en",
      ["book"],
    );
    return {
      hits: hits.hits[0].length,
      entries: hits.hits[0][0]?.entries.length,
    };
  });
  expect(control).toEqual({ hits: 1, entries: 100 });
});

test("a malformed saved package reports an invalid package", async ({
  page,
}) => {
  // A stored package whose entries field is missing, null, or not an
  // array must report PackageValidationError (so the page clears it and
  // falls back to server search), not a raw TypeError. A null row still
  // reports invalid, and an empty package still returns zero hits.
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { searchPackage, PackageValidationError } = await import(
      String("/src/data/package-search.ts")
    );
    const snapshot = "sha256:" + "a".repeat(64);
    const attempt = async (entries: unknown) => {
      try {
        const outcome = await searchPackage(
          { snapshot, version: 1, entries } as never,
          "en",
          ["book"],
        );
        return { resolved: true, hits: outcome.hits[0].length };
      } catch (error) {
        return {
          resolved: false,
          constructor: (error as Error).constructor.name,
          invalid:
            error instanceof PackageValidationError ||
            (error as Error).constructor.name ===
              "PackageValidationError",
          message: (error as Error).message,
        };
      }
    };
    return {
      missing: await attempt(undefined),
      null: await attempt(null),
      object: await attempt({}),
      nullRow: await attempt([null]),
      empty: await attempt([]),
    };
  });
  for (const label of ["missing", "null", "object"] as const) {
    expect(result[label].resolved).toBe(false);
    expect(result[label].invalid).toBe(true);
    expect(result[label].constructor).toBe("PackageValidationError");
  }
  expect(result.nullRow.resolved).toBe(false);
  expect(result.nullRow.invalid).toBe(true);
  expect(result.empty).toEqual({ resolved: true, hits: 0 });
});

test("a cold request does not copy other pending transfers", async ({
  page,
}) => {
  // Overlapping calls with distinct packages used to copy every pending
  // transfer key into an array and search it, so one cold request did work
  // proportional to unrelated transfers. The client now looks up the
  // package key directly: no pending-key array is ever built or searched,
  // even with 32 transfers in flight.
  await page.goto("/");
  const result = await page.evaluate(async (count) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { searchPackage } = await import(
      String("/src/data/package-search.ts")
    );
    const store = new LocalStore("pending-keys");
    const packages = [];
    for (let index = 0; index <= count; index++) {
      const language = `en-x-p${index}`;
      await store.put("packages", language, {
        version: 1,
        snapshot: "sha256:" + "a".repeat(64),
        entries: [],
      });
      packages.push({
        pkg: await store.get("packages", language),
        language,
      });
    }
    const calls = [];
    for (let index = 0; index < count; index++)
      calls.push(
        searchPackage(packages[index].pkg, packages[index].language, [], {
          workLimit: 0,
        }),
      );
    const lengths: number[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const native: any = Array.prototype.includes;
    const hooked = function (
      this: unknown[],
      needle: unknown,
      ...rest: unknown[]
    ): boolean {
      if (
        typeof needle === "string" &&
        needle.startsWith('["en-x-p') &&
        this.every(
          (item) => typeof item === "string" && item.startsWith('["en-x-p'),
        )
      )
        lengths.push(this.length);
      return native.call(this, needle, ...rest);
    };
    try {
      Array.prototype.includes = hooked;
      calls.push(
        searchPackage(packages[count].pkg, packages[count].language, [], {
          workLimit: 0,
        }),
      );
    } finally {
      Array.prototype.includes = native;
    }
    const settled = await Promise.all(calls);
    return {
      lengths,
      fulfilled: settled.length,
      groups: settled[settled.length - 1].hits.length,
    };
  }, 32);
  expect(result.fulfilled).toBe(33);
  expect(result.groups).toBe(0);
  expect(result.lengths).toEqual([]);
});

test("an over-cap query is refused before any detector or transfer", async ({
  page,
}) => {
  // A query past the product length cap must not reach the wildcard
  // detector or the worker: the client refuses with a typed error. The
  // worker may still validate the package, but no posted message carries
  // the query.
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { searchPackage } = await import(String("/src/data/package-search.ts"));
    const pkg = {
      snapshot: "sha256:" + "b".repeat(64),
      version: 1,
      entries: [
        {
          event: "jve1:" + "1".repeat(64),
          word: { language: "jbo", spelling: "broda" },
          language: "en",
          glosses: [{ language: "en", text: "book", sense: null }],
          plain_text: "book",
          classification: { kind: "gismu", selmaho: [] },
          body: null,
        },
      ],
    };
    const query = "z".repeat(5000);
    const originalTest = RegExp.prototype.test;
    let detectorCalls = 0;
    RegExp.prototype.test = function (this: RegExp, value: string): boolean {
      if (this.source === "[*?@$]" && value === query) detectorCalls++;
      return originalTest.call(this, value);
    };
    const originalPost = Worker.prototype.postMessage;
    let queryUnits = 0;
    (Worker.prototype as any).postMessage = function (
      this: unknown,
      ...args: [unknown]
    ) {
      const message = args[0] as { queries?: string[] };
      for (const text of message?.queries ?? []) queryUnits += text.length;
      return originalPost.apply(this, args);
    };
    try {
      await searchPackage(pkg as never, "en", [query]);
      return { refused: false, detectorCalls, queryUnits };
    } catch (error) {
      return {
        refused: true,
        constructor: (error as Error).constructor.name,
        message: (error as Error).message,
        detectorCalls,
        queryUnits,
      };
    } finally {
      RegExp.prototype.test = originalTest;
      Worker.prototype.postMessage = originalPost;
    }
  });
  expect(result.refused).toBe(true);
  expect(result.constructor).toBe("SearchQueryTooLongError");
  expect(result.detectorCalls).toBe(0);
  expect(result.queryUnits).toBe(0);
});

test("an over-cap query on an invalid package reports the invalid package", async ({
  page,
}) => {
  // The length refusal waits until the package is known to be usable, so a
  // malformed package keeps its validation error and the page fallback.
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { searchPackage } = await import(
      String("/src/data/package-search.ts")
    );
    const pkg = {
      snapshot: "sha256:" + "c".repeat(64),
      version: 2,
      entries: [null],
    };
    try {
      await searchPackage(pkg as never, "en", ["z".repeat(4097)], {
        grouped: true,
      });
      return "completed";
    } catch (error) {
      return (error as Error).constructor.name;
    }
  });
  expect(result).toBe("PackageValidationError");
});

test("a retry sends the strings that passed the length check", async ({
  page,
}) => {
  // A canceled cold transfer makes the next request retry with the package.
  // The caller's array changes after the call; the retry must still send
  // the four-unit query that was checked, not the 4,097-unit replacement.
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { searchPackage } = await import(
      String("/src/data/package-search.ts")
    );
    const replacement = "e\u0301".repeat(2048) + "z";
    const originalTest = RegExp.prototype.test;
    let detectorCalls = 0;
    RegExp.prototype.test = function (this: RegExp, value: string): boolean {
      if (this.source === "[*?@$]" && value === replacement) detectorCalls++;
      return originalTest.call(this, value);
    };
    const originalPost = Worker.prototype.postMessage;
    const sent: number[][] = [];
    (Worker.prototype as any).postMessage = function (
      this: unknown,
      ...args: [unknown]
    ) {
      const message = args[0] as { queries?: string[] };
      if (message?.queries) sent.push(message.queries.map((q) => q.length));
      return originalPost.apply(this, args);
    };
    const pkg = {
      version: 1,
      snapshot: "sha256:" + "d".repeat(64),
      entries: [
        {
          event: "jve1:" + "2".repeat(64),
          word: { language: "jbo", spelling: "cukta" },
          language: "en",
          glosses: [{ language: "en", text: "book", sense: null }],
          plain_text: "book",
          classification: { kind: "gismu", selmaho: [] },
          body: null,
        },
      ],
    };
    try {
      const controller = new AbortController();
      const starter = searchPackage(pkg as never, "en", [], {
        signal: controller.signal,
      });
      controller.abort();
      const terms = ["book"];
      const waiting = searchPackage(pkg as never, "en", terms, {
        group: "definitions",
      });
      terms[0] = replacement;
      const [, settled] = await Promise.allSettled([starter, waiting]);
      return {
        sent,
        detectorCalls,
        outcome:
          settled.status === "fulfilled"
            ? settled.value.hits
                .flat()
                .map((hit: { word: { spelling: string } }) => hit.word.spelling)
            : (settled.reason as Error).constructor.name,
      };
    } finally {
      RegExp.prototype.test = originalTest;
      Worker.prototype.postMessage = originalPost;
    }
  });
  // The second request ran twice: once without the package, then the retry.
  expect(result.sent.filter((lengths) => lengths.length === 1)).toEqual([
    [4],
    [4],
  ]);
  expect(result.detectorCalls).toBe(0);
  expect(result.outcome).toEqual(["cukta"]);
});

test("a grouped rafsi query completes after lowercasing expands it", async ({
  page,
}) => {
  // "z".repeat(4095) + "İ" fits the cap at 4,096 raw units, but lowercasing
  // expands İ, so the worker-side text is over the cap. The cap was decided
  // on the raw spelling at entry, so both groups complete as on main
  // instead of failing with a plain error.
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { searchPackage } = await import(
      String("/src/data/package-search.ts")
    );
    const pkg = {
      snapshot: "sha256:" + "b".repeat(64),
      version: 1,
      entries: [
        {
          event: "jve1:" + "1".repeat(64),
          word: { language: "jbo", spelling: "broda" },
          language: "en",
          glosses: [{ language: "en", text: "book", sense: null }],
          plain_text: "book",
          classification: { kind: "gismu", selmaho: [] },
          body: null,
        },
      ],
    };
    const query = "z".repeat(4095) + "İ";
    try {
      const found = await searchPackage(pkg as never, "en", [query], {
        grouped: true,
        rafsiOnly: true,
        patterns: false,
      });
      return {
        completed: true,
        groups: found.hits.length,
        constructor: "",
      };
    } catch (error) {
      return {
        completed: false,
        groups: 0,
        constructor: (error as Error).constructor.name,
      };
    }
  });
  expect(result.completed).toBe(true);
  expect(result.groups).toBe(2);
});
