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
    await writer.delete("packages", "en");
    const deleted = await store.get("packages", "en");
    return {
      retained: first === second,
      replaced: first !== replacement,
      sameSnapshot: first.snapshot === replacement.snapshot,
      cold: cold.hits[0].length,
      warm: warm.hits[0].length,
      warmParses: warm.metrics.headwordsParsed,
      reusedAcrossConnections: !shared.prepared,
      keptAfterNonceFailure: afterNonceFailure === replacement,
      updated: updated.hits.map((rows: any[]) =>
        rows.map((hit: any) => hit.preview?.plain_text),
      ),
      keptAfterFailure: afterFailure === replacement,
      deleted: deleted === undefined,
    };
  });
  expect(result).toEqual({
    retained: true,
    replaced: true,
    sameSnapshot: true,
    cold: 1,
    warm: 1,
    warmParses: 0,
    reusedAcrossConnections: true,
    keptAfterNonceFailure: true,
    updated: [["new meaning"], []],
    keptAfterFailure: true,
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
