import { test, expect } from "@playwright/test";
import {
  corePath,
  createIdentity,
  acceptFirstSignature,
  openWord,
} from "./helpers.ts";

test("downloaded search queries work without an API request and offline signing uses saved history", async ({
  page,
}) => {
  await page.goto("/preferences");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(
    "The English search package is saved in this browser.",
  );
  await expect(page.getByText(/\d+ definitions · snapshot/)).toBeVisible();
  let requests = 0;
  await page.route("**/api/v1/**", (route) => {
    requests++;
    return route.abort();
  });
  await page.goto("/search?q=book&lang=en");
  const results = page.getByRole("region", { name: "Search results" });
  await expect(
    results.getByRole("link", { name: "cukta", exact: true }),
  ).toBeVisible();
  await expect(
    results.getByRole("link", { name: "cukta", exact: true }).locator(".."),
  ).toContainText("cku");
  await expect(
    results.getByRole("link", { name: "notes" }).first(),
  ).toBeVisible();
  await expect(page.getByText(/^\d+ words?$/)).toBeVisible();
  expect(requests).toBe(0);
  await page.unroute("**/api/v1/**");
  // Offline signing uses the remembered local history only.
  await createIdentity(page);
  await page.getByText("Offline signing").click();
  await page.getByLabel("Sign from history saved in this browser only").check();
  await openWord(page, "cukta");
  await page.route("**/api/v1/manifest", (route) => route.abort());
  await page.route("**/api/v1/identity-heads/**", (route) => route.abort());
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toHaveText(
    "Your endorsement is published.",
  );
});

test("hash-correct packages reject malformed descriptors and every entry field before activation", async ({
  page,
}) => {
  await page.goto("/");
  const results = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { downloadPackage } = await import(String("/src/data/search.ts"));
    const snapshot = "sha256:" + "a".repeat(64);
    const entry = {
      event: "jve1:" + "b".repeat(64),
      word: { language: "jbo", spelling: "broda" },
      language: "en",
      glosses: [{ language: "en", text: "test", sense: null }],
      plain_text: "Literal <script> text",
      classification: { kind: "other", selmaho: [] },
      body: null,
    };
    const bytes = (value: unknown) =>
      core.utf8(core.canonicalize(core.utf8(JSON.stringify(value))));
    const oldFetch = window.fetch;
    const results: { name: string; accepted: boolean; partRequests: number }[] =
      [];
    try {
      const scenarios: any[] = [
        { name: "valid", data: [entry] },
        { name: "fractional bytes", descriptor: { bytes: 2.5 } },
        { name: "negative count", descriptor: { count: -1 } },
        { name: "fractional count", descriptor: { count: 1.5 } },
        { name: "missing hash", descriptor: { hash: null } },
        { name: "too many parts", parts: 129 },
        { name: "too many bytes", parts: 33, huge: true },
        { name: "too many entries", parts: 101, many: true },
        ...[
          "event",
          "word",
          "language",
          "glosses",
          "plain_text",
          "classification",
          "body",
        ].map((field) => ({
          name: `invalid ${field}`,
          data: [{ ...entry, [field]: 7 }],
        })),
        {
          name: "invalid gloss",
          data: [
            { ...entry, glosses: [{ language: "en", text: 7, sense: null }] },
          ],
        },
        {
          name: "invalid classification",
          data: [
            { ...entry, classification: { kind: "invalid", selmaho: [] } },
          ],
        },
        { name: "duplicate entries", data: [entry, entry] },
      ];
      for (const scenario of scenarios) {
        const partBytes = bytes(scenario.data ?? [entry]);
        const parts = Array.from(
          { length: scenario.parts ?? 1 },
          (_, index) => ({
            hash:
              index === 0
                ? core.contentHash(partBytes)
                : "sha256:" + index.toString(16).padStart(64, "0"),
            bytes: scenario.huge ? 4194304 : partBytes.length,
            count: scenario.many ? 2000 : (scenario.data ?? [entry]).length,
            ...scenario.descriptor,
          }),
        );
        const pkgBytes = core.utf8(
          JSON.stringify({ version: 1, language: "en", snapshot, parts }),
        );
        const manifest = {
          snapshot,
          packages: [
            {
              language: "en",
              hash: core.contentHash(pkgBytes),
              bytes: pkgBytes.length,
            },
          ],
        };
        let partRequests = 0;
        window.fetch = async (url) => {
          if (String(url).endsWith("/manifest"))
            return new Response(JSON.stringify(manifest));
          if (String(url).includes("/package-parts/")) {
            partRequests++;
            return new Response(partBytes);
          }
          return new Response(pkgBytes);
        };
        try {
          const result = await downloadPackage("en");
          results.push({
            name: scenario.name,
            accepted: result.entries[0].plain_text === entry.plain_text,
            partRequests,
          });
        } catch {
          results.push({ name: scenario.name, accepted: false, partRequests });
        }
      }
      return results;
    } finally {
      window.fetch = oldFetch;
    }
  }, corePath);
  expect(results[0]).toEqual({
    name: "valid",
    accepted: true,
    partRequests: 1,
  });
  for (const result of results.slice(1))
    expect(result.accepted, result.name).toBe(false);
  for (const result of results.filter(
    (result) =>
      !result.name.startsWith("invalid") &&
      result.name !== "duplicate entries" &&
      result.name !== "valid",
  ))
    expect(result.partRequests, result.name).toBe(0);
});

test("an invalid cached package is reported and server search stays usable", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().put("packages", "en", {
      snapshot: "sha256:" + "a".repeat(64),
      entries: [{ word: null }],
    });
  });
  await page.goto("/search?q=book&lang=en");
  await expect(page.getByRole("status")).toContainText(
    "The search package is invalid",
  );
  await expect(
    page.getByRole("link", { name: "cukta", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      return (await new LocalStore().get("packages", "en")).entries;
    }),
  ).toEqual([{ word: null }]);
});

test("object and package waits expire and oversized streams are cancelled", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { api, getEnvelope } = await import(String("/src/data/api.ts"));
    const { downloadPackage } = await import(String("/src/data/search.ts"));
    const oldFetch = window.fetch;
    const oldTimeout = AbortSignal.timeout;
    const requestedTimeouts: number[] = [];
    AbortSignal.timeout = (ms) => {
      requestedTimeouts.push(ms);
      return oldTimeout.call(AbortSignal, 25);
    };
    const snapshot = "sha256:" + "a".repeat(64);
    const part = core.utf8("[]");
    const pkg = core.utf8(
      core.canonicalize(
        core.utf8(
          JSON.stringify({
            version: 1,
            language: "en",
            snapshot,
            parts: [
              { hash: core.contentHash(part), bytes: part.length, count: 0 },
            ],
          }),
        ),
      ),
    );
    const manifest = {
      snapshot,
      packages: [
        { language: "en", hash: core.contentHash(pkg), bytes: pkg.length },
      ],
    };
    const outcomes: string[] = [];
    let cancelled = 0;
    try {
      for (const stage of [
        "envelope headers",
        "envelope body",
        "package headers",
        "part body",
        "generic custom signal",
      ]) {
        window.fetch = async (url, options) => {
          const path = String(url);
          if (stage.includes("package") || stage.includes("part")) {
            if (path.endsWith("/manifest"))
              return new Response(JSON.stringify(manifest));
            if (stage === "part body" && path.includes("/packages/"))
              return new Response(pkg);
          }
          if (stage.includes("body"))
            return new Response(
              new ReadableStream({
                cancel() {
                  cancelled++;
                },
              }),
            );
          return new Promise((_, reject) =>
            options!.signal!.addEventListener(
              "abort",
              () => reject(options!.signal!.reason),
              { once: true },
            ),
          );
        };
        try {
          if (stage === "generic custom signal")
            await api("/unused", { signal: new AbortController().signal });
          else if (stage.startsWith("envelope"))
            await getEnvelope("jve1:" + "1".repeat(64));
          else await downloadPackage("en");
          outcomes.push("accepted");
        } catch (error) {
          outcomes.push((error as Error).name + ":" + (error as any).kind);
        }
      }
      for (const withLength of [true, false]) {
        window.fetch = async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                if (!withLength) controller.enqueue(new Uint8Array(20481));
              },
              cancel() {
                cancelled++;
              },
            }),
            { headers: withLength ? { "content-length": "20481" } : {} },
          );
        try {
          await getEnvelope("jve1:" + "1".repeat(64));
          outcomes.push("accepted");
        } catch (error) {
          outcomes.push((error as Error).message);
        }
      }
      return { outcomes, cancelled, requestedTimeouts };
    } finally {
      window.fetch = oldFetch;
      AbortSignal.timeout = oldTimeout;
    }
  }, corePath);
  // Timeouts surface as transport errors with kind "timeout", so delivery treats them as unknown outcomes.
  expect(result.outcomes.slice(0, 5)).toEqual(Array(5).fill("Error:timeout"));
  expect(result.outcomes.slice(5)).toEqual(
    Array(2).fill("The response exceeds the browser byte limit."),
  );
  expect(result.cancelled).toBe(4);
  expect(result.requestedTimeouts).toContain(20000);
  expect(result.requestedTimeouts).toContain(120000);
});

test("local search ranks match classes, keeps the strongest match, and sends nothing", async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: "tr-TR" });
  const page = await context.newPage();
  try {
    await page.goto("/");
    const expected = await page.evaluate(async (corePath) => {
      const core = await import(corePath);
      await core.initializeCore();
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const entry = (
        event: number,
        spelling: string,
        glosses: string[],
        text: string,
      ) => ({
        event: "jve1:" + event.toString(16).padStart(64, "0"),
        word: { language: "jbo", spelling },
        language: "en",
        glosses: glosses.map((text) => ({ language: "en", text, sense: null })),
        plain_text: text,
        classification: {
          kind: "other",
          selmaho: event === 1 ? Array(8193).fill("BAI") : [],
        },
        body: null,
      });
      await new LocalStore().put("packages", "en", {
        snapshot: "sha256:" + "e".repeat(64),
        entries: [
          entry(1, "broda", [], "i travel"),
          entry(2, "brode", ["i"], "another retained publication"),
          entry(3, "broda", ["I"], "a stronger later match"),
          entry(4, "brodi", ["input"], "a prefix match"),
        ],
      });
      return ["broda", "brode"]
        .sort((a, b) =>
          core
            .wordId({ language: "jbo", spelling: a })
            .localeCompare(core.wordId({ language: "jbo", spelling: b }), "en"),
        )
        .concat("brodi");
    }, corePath);
    let requests = 0;
    await page.route("**/api/v1/**", (route) => {
      requests++;
      return route.abort();
    });
    await page.goto("/search?q=I&lang=en");
    const results = page.getByRole("region", { name: "Search results" });
    await expect(results.locator("article")).toHaveCount(3);
    expect(await results.locator("article .hw").allTextContents()).toEqual(
      expected,
    );
    const broda = results
      .locator("article")
      .filter({ has: page.getByRole("link", { name: "broda", exact: true }) });
    await expect(
      broda.getByText("a stronger later match", { exact: true }),
    ).toBeVisible();
    await expect(
      broda.getByRole("link", { name: "also: 1 other matching definition" }),
    ).toBeVisible();
    await expect(
      page.getByText("Local results include every retained publication."),
    ).toBeVisible();
    expect(requests).toBe(0);
  } finally {
    await context.close();
  }
});

test("remote search pages pin snapshot and view, survive browser back, and reject repeated cursors", async ({
  page,
}) => {
  const snapshot = "sha256:" + "a".repeat(64);
  const view = "jve1:" + "b".repeat(64);
  const hit = (index: number) => {
    const event = "jve1:" + index.toString(16).padStart(64, "0");
    return {
      word: { language: "jbo", spelling: `fixture-${index}` },
      word_id: "jvw1:" + index.toString(16).padStart(64, "0"),
      definitions: [event],
      match: "token",
      preview: {
        event,
        word_kind: "gismu",
        plain_text: `Literal <script>window.bad=true</script> preview ${index}`,
        status: "active",
      },
    };
  };
  const requests: string[] = [];
  await page.route("**/api/v1/search?**", (route) => {
    const url = new URL(route.request().url());
    requests.push(url.search);
    expect(url.searchParams.get("limit")).toBe("20");
    const after = url.searchParams.get("after");
    if (after) {
      expect(after).toBe("next-page");
      expect(url.searchParams.get("snapshot")).toBe(snapshot);
      expect(url.searchParams.get("view")).toBe(view);
    }
    return route.fulfill({
      json: {
        snapshot,
        view,
        hits: Array.from({ length: after ? 3 : 20 }, (_, index) =>
          hit(index + (after ? 21 : 1)),
        ),
        next: after ? null : "next-page",
      },
    });
  });
  await page.route("**/api/v1/words/**", (route) =>
    route.fulfill({
      status: 503,
      json: {
        code: "resource_unavailable",
        message: "unavailable",
        event: null,
        field: null,
      },
    }),
  );
  await page.route("**/api/v1/events/**", (route) =>
    route.fulfill({
      status: 404,
      json: { code: "missing", message: "missing", event: null, field: null },
    }),
  );
  await page.goto("/search?q=fixture&lang=en");
  const results = page.getByRole("region", { name: "Search results" });
  await expect(results.locator("article")).toHaveCount(20);
  await expect(
    results.getByText("Literal <script>window.bad=true</script> preview 1", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    results.getByRole("img", { name: "Score unavailable" }),
  ).toHaveCount(20);
  await page.getByRole("button", { name: "show all" }).click();
  await expect(results.locator("article")).toHaveCount(23);
  expect(await results.locator("article .hw").allTextContents()).toEqual(
    Array.from({ length: 23 }, (_, index) => `fixture-${index + 1}`),
  );
  await expect(page.getByRole("button", { name: "show all" })).toHaveCount(0);
  await page.getByRole("link", { name: "Settings" }).click();
  await page.goBack();
  await expect(page.getByLabel("Search words and meanings")).toHaveValue(
    "fixture",
  );
  await expect(results.locator("article")).toHaveCount(23);
  expect(requests).toHaveLength(2);
  expect(await page.evaluate(() => Boolean((window as any).bad))).toBe(false);
  await page.unroute("**/api/v1/search?**");
  await page.route("**/api/v1/search?**", (route) => {
    const url = new URL(route.request().url());
    const later = url.searchParams.has("after");
    return route.fulfill({
      json: {
        snapshot,
        view,
        hits: [hit(later && url.searchParams.get("q") === "loop" ? 2 : 1)],
        next:
          later && url.searchParams.get("q") === "duplicate" ? null : "repeat",
      },
    });
  });
  for (const query of ["loop", "duplicate"]) {
    await page.goto(`/search?q=${query}&lang=en`);
    await expect(results.locator("article")).toHaveCount(1);
    await page.getByRole("button", { name: "show all" }).click();
    await expect(results.locator(".notice")).toContainText(
      "Search pagination repeated a cursor or result.",
    );
    await expect(results.locator("article")).toHaveCount(1);
  }
});
