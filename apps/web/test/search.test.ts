import { test, expect } from "@playwright/test";
import {
  corePath,
  createIdentity,
  acceptFirstSignature,
  openWord,
  fixture,
} from "./helpers.ts";

/** Only this exact background capability read can accompany private local queries. */
async function guardLocalQuery(
  page: import("@playwright/test").Page,
  query: string,
) {
  const forbidden: string[] = [];
  const leaks: string[] = [];
  const handler = (route: import("@playwright/test").Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postData() ?? "";
    const allowed =
      request.method() === "GET" &&
      url.pathname === "/api/v1/capabilities" &&
      !url.search &&
      !body;
    if (allowed) return route.continue();
    forbidden.push(`${request.method()} ${url.pathname}${url.search}`);
    if (
      [
        decodeURIComponent(url.pathname),
        ...url.searchParams.values(),
        body,
      ].some((value) => value.includes(query))
    )
      leaks.push(request.url());
    return route.abort();
  };
  await page.route("**/api/v1/**", handler);
  return {
    forbidden,
    leaks,
    assertPrivate() {
      expect(forbidden).toEqual([]);
      expect(leaks).toEqual([]);
    },
    dispose: () => page.unroute("**/api/v1/**", handler),
  };
}

test("downloaded local search sends nothing and offline signing uses saved history", async ({
  page,
}) => {
  await page.goto("/preferences");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.locator("#app > [role=status]")).toHaveText(
    "The English search package is saved in this browser.",
  );
  await expect(page.getByText(/\d+ definitions · snapshot/)).toBeVisible();
  const privacy = await guardLocalQuery(page, "book");
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
  privacy.assertPrivate();
  await privacy.dispose();
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
    const peer = {
      id: "isolated",
      base: "/request-count-test",
      label: "test peer",
    };
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
          if (!path.includes("/request-count-test/"))
            return oldFetch(url, options);
          if (stage.includes("package") || stage.includes("part")) {
            if (path.endsWith("/manifest"))
              return new Response(JSON.stringify(manifest));
            if (stage === "part body" && path.includes("/packages/"))
              return new Response(pkg);
          }
          // The page makes its own background requests, such as the manifest.
          // Only the request under test gets a counted stream.
          const target = stage.startsWith("envelope")
            ? path.includes("/events/")
            : path.includes("/package-parts/");
          if (stage.includes("body") && target)
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
            await api("/unused", {
              signal: new AbortController().signal,
              peer,
            });
          else if (stage.startsWith("envelope"))
            await getEnvelope("jve1:" + "1".repeat(64), undefined, { peer });
          else await downloadPackage("en", { peer });
          outcomes.push("accepted");
        } catch (error) {
          outcomes.push((error as Error).name + ":" + (error as any).kind);
        }
      }
      for (const withLength of [true, false]) {
        window.fetch = async (url, options) => {
          if (!String(url).includes("/request-count-test/"))
            return oldFetch(url, options);
          return new Response(
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
        };
        try {
          await getEnvelope("jve1:" + "1".repeat(64), undefined, { peer });
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
      return ["broda", "brode", "brodi"];
    }, corePath);
    const privacy = await guardLocalQuery(page, "I");
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
    privacy.assertPrivate();
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

test("local search pages through many results in stable order, keeps equal-class previews, renders HTML-like text literally, and sends nothing", async ({
  page,
}) => {
  await page.goto("/");
  const expected = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const entries = Array.from({ length: 121 }, (_, index) => ({
      event: "jve1:" + (index + 1).toString(16).padStart(64, "0"),
      word: { language: "jbo", spelling: `broda${index}` },
      language: "en",
      glosses: [],
      plain_text: `needle token ${index}`,
      classification: { kind: "other", selmaho: [] },
      body: null,
    }));
    // Two more definitions of the first word. Both match by gloss, the strongest class. The earlier event wins the tie.
    for (const [offset, text] of [
      "Chosen <img src=x onerror=window.bad=true> literal preview",
      "Later equal-class preview",
    ].entries())
      entries.push({
        ...entries[0],
        event: "jve1:" + (122 + offset).toString(16).padStart(64, "0"),
        glosses: [{ language: "en", text: "needle", sense: null }] as any,
        plain_text: text,
        classification: { kind: "lujvo", selmaho: [] },
      });
    await new LocalStore().put("packages", "en", {
      snapshot: "sha256:" + "d".repeat(64),
      entries,
    });
    return [
      "broda0",
      ...entries
        .slice(1, 121)
        .sort((a, b) =>
          core.wordId(a.word).localeCompare(core.wordId(b.word), "en"),
        )
        .map((entry) => entry.word.spelling),
    ];
  }, corePath);
  const privacy = await guardLocalQuery(page, "needle");
  await page.goto("/search?q=needle&lang=en");
  const results = page.getByRole("region", { name: "Search results" });
  await expect(results.locator("article")).toHaveCount(20);
  await expect(
    results.getByText(
      "Chosen <img src=x onerror=window.bad=true> literal preview",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    results.getByText("Later equal-class preview", { exact: true }),
  ).toHaveCount(0);
  await expect(results.getByText("lujvo", { exact: true })).toBeVisible();
  await expect(
    results.getByRole("link", { name: "also: 2 other matching definitions" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "show all" }).click();
  await expect(results.locator("article")).toHaveCount(40);
  // Browser back restores the loaded pages.
  await page.getByRole("link", { name: "Add a word" }).click();
  await page.goBack();
  await expect(results.locator("article")).toHaveCount(40);
  while ((await results.locator("article").count()) < 121)
    await page.getByRole("button", { name: "show all" }).click();
  await expect(results.locator("article")).toHaveCount(121);
  expect(await results.locator("article .hw").allTextContents()).toEqual(
    expected,
  );
  await expect(page.getByRole("button", { name: "show all" })).toHaveCount(0);
  await expect(
    page.getByText("Local results include every retained publication."),
  ).toBeVisible();
  privacy.assertPrivate();
  expect(await results.locator("img").count()).toBe(0);
  expect(await page.evaluate(() => Boolean((window as any).bad))).toBe(false);
});

test("a failed package download through Settings keeps the cache and leaves server search usable", async ({
  page,
}) => {
  await page.goto("/");
  const fixture = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const snapshot = "sha256:" + "a".repeat(64);
    await new LocalStore().put("packages", "en", {
      snapshot,
      entries: [{ word: null }],
    });
    // A hash-correct package whose part is malformed.
    const part = core.utf8(core.canonicalize(core.utf8(JSON.stringify([{}]))));
    const pkg = core.utf8(
      core.canonicalize(
        core.utf8(
          JSON.stringify({
            version: 1,
            language: "en",
            snapshot,
            parts: [
              { hash: core.contentHash(part), bytes: part.length, count: 1 },
            ],
          }),
        ),
      ),
    );
    return {
      snapshot,
      part: new TextDecoder().decode(part),
      pkg: new TextDecoder().decode(pkg),
      hash: core.contentHash(pkg),
      bytes: pkg.length,
    };
  }, corePath);
  await page.route("**/api/v1/manifest", async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({
      json: {
        ...real,
        packages: [
          { language: "en", hash: fixture.hash, bytes: fixture.bytes },
        ],
        package_versions: [],
      },
    });
  });
  await page.route("**/api/v1/packages/**", (route) =>
    route.fulfill({ body: fixture.pkg }),
  );
  await page.route("**/api/v1/package-parts/**", (route) =>
    route.fulfill({ body: fixture.part }),
  );
  await page.goto("/search?q=book&lang=en");
  await expect(page.getByRole("status")).toContainText(
    "The search package is invalid",
  );
  await expect(
    page.getByRole("link", { name: "cukta", exact: true }),
  ).toBeVisible();
  await page.goto("/preferences");
  await page
    .getByRole("button", { name: "Refresh" })
    .first()
    .click()
    .catch(() => {});
  await expect(page.locator("#app > [role=status]")).toContainText(
    /invalid|malformed|rejected/,
  );
  const cached = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return (await new LocalStore().get("packages", "en")).entries;
  });
  expect(cached).toEqual([{ word: null }]);
  await page.goto("/search?q=book&lang=en");
  await expect(
    page.getByRole("link", { name: "cukta", exact: true }),
  ).toBeVisible();
});

test("the retired-results filter asks the server for retired publications and shows their status", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const seed = new Uint8Array(32).fill(219);
    const word = { language: "jbo", spelling: "blanu" };
    const body = {
      word,
      language: "en",
      text: [["retirementprobe"]],
      frame: null,
      operands: [],
      glosses: [],
      notes: [],
      etymology: { text: [], formation: null, compound: null },
      examples: [],
      classification: { kind: "gismu", selmaho: [] },
      labels: [],
      sources: [],
      license: {
        expression: "CC0-1.0",
        url: "https://creativecommons.org/publicdomain/zero/1.0/",
        attribution: "",
      },
      legacy: null,
    };
    const definition = core.createEvent(
      seed,
      [],
      "21".repeat(16),
      {
        kind: "definition.publish",
        word: core.wordId(word),
        language: "en",
        parents: [],
        origin: "native",
      },
      body,
    );
    const retired = core.createEvent(
      seed,
      [definition.envelope.id],
      "22".repeat(16),
      {
        kind: "status.set",
        target: definition.envelope.id,
        value: "deprecated",
      },
      null,
    );
    for (const event of [definition, retired]) {
      const response = await fetch("/api/v1/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      });
      if (!response.ok) throw new Error(await response.text());
    }
  }, corePath);
  const requests: string[] = [];
  await page.route("**/api/v1/search?**", async (route) => {
    requests.push(new URL(route.request().url()).search);
    await route.continue();
  });
  await page.goto("/search?q=retirementprobe&lang=en");
  await expect(
    page.getByText("No matching definitions on this server.", { exact: true }),
  ).toBeVisible();
  expect(requests.at(-1)).not.toContain("retired=");
  await expect(
    page.locator("article.hit").getByText("status: deprecated"),
  ).toHaveCount(0);
  await page.getByLabel("Include retired results").check();
  await expect(page).toHaveURL(/retired=1/);
  await expect(
    page.locator("article.hit").getByText("status: deprecated").first(),
  ).toBeVisible();
  expect(requests.at(-1)).toContain("retired=1");
  await expect(
    page
      .locator("article.hit")
      .getByRole("link", { name: "blanu", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Include retired results").uncheck();
  await expect(page).not.toHaveURL(/retired=1/);
  await expect(
    page.getByText("No matching definitions on this server.", { exact: true }),
  ).toBeVisible();
  expect(requests.at(-1)).not.toContain("retired=");
});

/** Builds canonical package bytes in the page, where the core is loaded. */
const packageFixture = `
  const build = (version, snapshot, entries) => {
    const part = core.utf8(core.canonicalize(core.utf8(JSON.stringify(entries))));
    const pkg = core.utf8(core.canonicalize(core.utf8(JSON.stringify({
      version, language: "en", snapshot,
      parts: [{ hash: core.contentHash(part), bytes: part.length, count: entries.length }],
    }))));
    const decode = (bytes) => new TextDecoder().decode(bytes);
    return { pkg: decode(pkg), hash: core.contentHash(pkg), bytes: pkg.length, part: decode(part), partHash: core.contentHash(part) };
  };
  const v1 = (spelling, event) => ({
    event: "jve1:" + event.repeat(64),
    word: { language: "jbo", spelling },
    language: "en",
    glosses: [{ language: "en", text: "book", sense: null }],
    plain_text: "x1 is a book",
    classification: { kind: "gismu", selmaho: [] },
    body: null,
  });
  const v2 = (spelling, event, rafsi, complete) => ({
    ...v1(spelling, event),
    issuer: "ed25519:" + "2".repeat(64),
    notes: false,
    rafsi,
    rafsi_complete: complete,
    attribution: null,
  });
`;
type Built = {
  pkg: string;
  hash: string;
  bytes: number;
  part: string;
  partHash: string;
};
/** Serves the manifest and package routes from built fixtures, by version query and part hash. */
async function servePackages(
  page: import("@playwright/test").Page,
  snapshot: string,
  state: {
    v1: Built | null;
    v2: Built | null;
    mode?: "abort" | "server" | "hang";
  },
) {
  await page.route("**/api/v1/manifest", async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({
      json: {
        ...real,
        snapshot,
        packages: state.v1
          ? [{ language: "en", hash: state.v1.hash, bytes: state.v1.bytes }]
          : [],
        package_versions: state.v2
          ? [
              {
                language: "en",
                version: 2,
                hash: state.v2.hash,
                bytes: state.v2.bytes,
              },
            ]
          : [],
      },
    });
  });
  await page.route("**/api/v1/packages/**", async (route) => {
    if (state.mode === "abort") return route.abort("connectionreset");
    if (state.mode === "server")
      return route.fulfill({
        status: 500,
        json: {
          code: "storage_unavailable",
          message: "Injected server error.",
          event: null,
          field: null,
        },
      });
    if (state.mode === "hang") {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      return route.abort("connectionreset");
    }
    const wantsV2 =
      new URL(route.request().url()).searchParams.get("version") === "2";
    const built = wantsV2 ? state.v2 : state.v1;
    if (!built)
      return route.fulfill({
        status: 404,
        json: {
          code: "missing",
          message: "No package.",
          event: null,
          field: null,
        },
      });
    await route.fulfill({ body: built.pkg });
  });
  await page.route("**/api/v1/package-parts/**", async (route) => {
    const hash = decodeURIComponent(
      route.request().url().split("/package-parts/")[1],
    );
    const built = [state.v1, state.v2].find((b) => b && b.partHash === hash);
    if (!built)
      return route.fulfill({
        status: 404,
        json: {
          code: "missing",
          message: "No part.",
          event: null,
          field: null,
        },
      });
    await route.fulfill({ body: built.part });
  });
}
const packageRequests = (page: import("@playwright/test").Page) => {
  const urls: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/packages/")) urls.push(request.url());
  });
  return urls;
};
const cachedPackage = (page: import("@playwright/test").Page) =>
  page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().get("packages", "en");
  });
const writeClaimDraft = (
  page: import("@playwright/test").Page,
  rafsi: string,
) =>
  page.evaluate(async (rafsi) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { newDraft } = await import(String("/src/model/draft.ts"));
    await new LocalStore().put(
      "drafts",
      "current",
      newDraft({
        spelling: "brodu",
        kind: "gismu",
        meaning: "A disposable test meaning.",
        text: "A disposable test meaning.",
        structured: false,
        frameMode: "none",
        step: 5,
        rafsiClaims: [{ rafsi, rationale: "Disposable claim." }],
      }),
    );
  }, rafsi);

test("the client asks for an advertised version 2 package, binds it to the manifest snapshot, and rejects wrong-version or wrong-snapshot bytes without touching the cache", async ({
  page,
}) => {
  await page.goto("/");
  const snapshot = "sha256:" + "a".repeat(64);
  const fixture = await page.evaluate(
    async ({ corePath, snapshot, helpers }) => {
      const core = await import(corePath);
      await core.initializeCore();
      const build = new Function("core", helpers + "return { build, v1, v2 };")(
        core,
      );
      const entries = [build.v2("cukta", "1", ["cku"], true)];
      const v1 = build.build(1, snapshot, [build.v1("cukta", "1")]);
      return {
        entries,
        v1,
        // The same version 1 bytes under a descriptor hash that does not match them.
        brokenV1: { ...v1, hash: "sha256:" + "d".repeat(64) },
        good: build.build(2, snapshot, entries),
        // Hash-correct bytes that say version 1 while the descriptor says 2.
        // Their entries are valid version 2 entries, so only the version
        // rule can reject them.
        wrongVersion: build.build(1, snapshot, entries),
        // Hash-correct bytes bound to another snapshot.
        wrongSnapshot: build.build(2, "sha256:" + "b".repeat(64), entries),
      };
    },
    { corePath, snapshot, helpers: packageFixture },
  );
  const state = { v1: fixture.v1 as Built | null, v2: fixture.good as Built };
  await servePackages(page, snapshot, state);
  const urls = packageRequests(page);
  await page.goto("/preferences");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.locator("#app > [role=status]")).toHaveText(
    "The English search package is saved in this browser.",
  );
  expect(urls).toHaveLength(1);
  const query = new URL(urls[0]).searchParams;
  expect(query.get("version")).toBe("2");
  expect(query.get("snapshot")).toBe(snapshot);
  const cached = await cachedPackage(page);
  expect(cached.version).toBe(2);
  expect(cached.snapshot).toBe(snapshot);
  expect(cached.downgrade).toBeNull();
  expect(cached.entries).toEqual(fixture.entries);
  // The same download as a direct call, so the test awaits its real end
  // and reads its rejection. The version 1 package is unusable in these
  // legs, so nothing can replace the cache.
  const attempt = () =>
    page.evaluate(async () => {
      const { downloadPackage } = await import(String("/src/data/search.ts"));
      try {
        await downloadPackage("en");
        return "resolved";
      } catch (error) {
        return (error as Error).message;
      }
    });
  // Wrong version inside hash-correct bytes with valid version 2 entries.
  state.v2 = fixture.wrongVersion;
  state.v1 = fixture.brokenV1;
  expect(await attempt()).toContain("hash did not match");
  expect(urls).toHaveLength(3);
  // The Settings control runs the same download. A fresh page has an empty
  // status, so the announced failure marks this attempt's end.
  await page.goto("/preferences");
  await page.getByRole("button", { name: "Refresh English" }).click();
  await expect(page.locator("#app > [role=status]")).toContainText(
    "hash did not match",
  );
  expect(await cachedPackage(page)).toEqual(cached);
  // Another snapshot inside hash-correct bytes.
  state.v2 = fixture.wrongSnapshot;
  expect(await attempt()).toContain("hash did not match");
  expect(urls).toHaveLength(7);
  await page.goto("/preferences");
  await page.getByRole("button", { name: "Refresh English" }).click();
  await expect(page.locator("#app > [role=status]")).toContainText(
    "hash did not match",
  );
  expect(await cachedPackage(page)).toEqual(cached);
  // Each attempt asked for version 2 first and never activated its bytes.
  const versions = urls.map((url) => new URL(url).searchParams.get("version"));
  expect(versions).toEqual(["2", "2", null, "2", null, "2", null, "2", null]);
  const final = await cachedPackage(page);
  expect(final.version).toBe(2);
  expect(final.snapshot).toBe(snapshot);
});

test("an invalid version 2 package falls back to version 1 with a recorded reason, and the publish page then reports unknown coverage", async ({
  page,
}) => {
  await createIdentity(page);
  const snapshot = "sha256:" + "a".repeat(64);
  const fixture = await page.evaluate(
    async ({ corePath, snapshot, helpers }) => {
      const core = await import(corePath);
      await core.initializeCore();
      const build = new Function("core", helpers + "return { build, v1, v2 };")(
        core,
      );
      return {
        v1: build.build(1, snapshot, [build.v1("cukta", "1")]),
        wrongVersion: build.build(1, snapshot, [build.v1("cukta", "1")]),
      };
    },
    { corePath, snapshot, helpers: packageFixture },
  );
  await servePackages(page, snapshot, {
    v1: fixture.v1,
    v2: fixture.wrongVersion,
  });
  const urls = packageRequests(page);
  await page.goto("/preferences");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  const status = page.locator("#app > [role=status]");
  await expect(status).toContainText(
    "The English search package is saved in this browser as version 1.",
  );
  await expect(status).toContainText("invalid");
  await expect(page.locator("main")).toContainText(
    "Version 1 was saved instead of version 2: The search package is invalid",
  );
  const cached = await cachedPackage(page);
  expect(cached.version).toBe(1);
  expect(typeof cached.downgrade).toBe("string");
  expect(cached.downgrade).toContain("invalid");
  expect(urls.map((url) => new URL(url).searchParams.get("version"))).toEqual([
    "2",
    null,
  ]);
  // A version 1 package carries no claims, so the publish page says the coverage is unknown.
  await writeClaimDraft(page, "rod");
  await page.goto("/new/publish");
  const conflicts = page.getByRole("region", { name: "Known conflicts" });
  await expect(conflicts).toContainText("Rafsi claims: rod.");
  await expect(conflicts).toContainText(
    "The local package carries no rafsi claims, so rafsi conflict coverage is unknown.",
  );
});

test("a version 2 transport failure, server error, or cancel makes no version 1 request and keeps the cache", async ({
  page,
}) => {
  await page.goto("/");
  const snapshot = "sha256:" + "a".repeat(64);
  const fixture = await page.evaluate(
    async ({ corePath, snapshot, helpers }) => {
      const core = await import(corePath);
      await core.initializeCore();
      const build = new Function("core", helpers + "return { build, v1, v2 };")(
        core,
      );
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const entries = [build.v2("cukta", "1", ["cku"], true)];
      await new LocalStore().put("packages", "en", {
        snapshot: "sha256:" + "c".repeat(64),
        version: 2,
        entries,
        downgrade: null,
      });
      return {
        v1: build.build(1, snapshot, [build.v1("cukta", "1")]),
        v2: build.build(2, snapshot, entries),
      };
    },
    { corePath, snapshot, helpers: packageFixture },
  );
  const before = await cachedPackage(page);
  const state = {
    v1: fixture.v1 as Built,
    v2: fixture.v2 as Built,
    mode: "abort" as "abort" | "server" | "hang" | undefined,
  };
  await servePackages(page, snapshot, state);
  const urls = packageRequests(page);
  await page.goto("/preferences");
  const status = page.locator("#app > [role=status]");
  await page.getByRole("button", { name: "Refresh English" }).click();
  await expect(status).not.toContainText("refreshed");
  await expect(status).not.toHaveText("");
  expect(urls).toHaveLength(1);
  expect(new URL(urls[0]).searchParams.get("version")).toBe("2");
  expect(await cachedPackage(page)).toEqual(before);
  state.mode = "server";
  await page.getByRole("button", { name: "Refresh English" }).click();
  await expect(status).toContainText("Injected server error");
  expect(urls).toHaveLength(2);
  expect(new URL(urls[1]).searchParams.get("version")).toBe("2");
  expect(await cachedPackage(page)).toEqual(before);
  // A cancel while the version 2 bytes are in flight.
  state.mode = "hang";
  const outcome = await page.evaluate(async () => {
    const { downloadPackage } = await import(String("/src/data/search.ts"));
    const controller = new AbortController();
    const pending = downloadPackage("en", { signal: controller.signal });
    setTimeout(() => controller.abort(), 500);
    try {
      await pending;
      return "resolved";
    } catch (error) {
      return (error as Error).name;
    }
  });
  expect(outcome).toBe("AbortError");
  await page.waitForTimeout(600);
  expect(urls).toHaveLength(3);
  expect(new URL(urls[2]).searchParams.get("version")).toBe("2");
  expect(await cachedPackage(page)).toEqual(before);
  // After the failures the full package still downloads.
  state.mode = undefined;
  await page.getByRole("button", { name: "Refresh English" }).click();
  await expect(status).toContainText("The English package is refreshed.");
  expect((await cachedPackage(page)).snapshot).toBe(snapshot);
});

test("a version 2 entry with a cut rafsi list makes the publish page name the incomplete coverage and the word", async ({
  page,
}) => {
  await createIdentity(page);
  const snapshot = "sha256:" + "a".repeat(64);
  const fixture = await page.evaluate(
    async ({ corePath, snapshot, helpers }) => {
      const core = await import(corePath);
      await core.initializeCore();
      const build = new Function("core", helpers + "return { build, v1, v2 };")(
        core,
      );
      return {
        v1: build.build(1, snapshot, [build.v1("cukta", "1")]),
        v2: build.build(2, snapshot, [
          build.v2("cukta", "1", ["cku"], false),
          build.v2("vlacku", "3", ["vla"], true),
        ]),
      };
    },
    { corePath, snapshot, helpers: packageFixture },
  );
  await servePackages(page, snapshot, { v1: fixture.v1, v2: fixture.v2 });
  await page.goto("/preferences");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.locator("#app > [role=status]")).toHaveText(
    "The English search package is saved in this browser.",
  );
  await writeClaimDraft(page, "rod");
  await page.goto("/new/publish");
  const conflicts = page.getByRole("region", { name: "Known conflicts" });
  await expect(conflicts).toContainText("Rafsi claims: rod.");
  await expect(conflicts).toContainText(
    "The package lists at most 64 claims per word, so coverage is incomplete for cukta.",
  );
  await expect(conflicts).not.toContainText("vlacku");
});

test("a restored search belongs to the view choice that produced it: a changed choice or a return to the server's view starts a new search, and the same choice restores without a request", async ({
  page,
}) => {
  const f = fixture();
  const requests: string[] = [];
  await page.route("**/api/v1/search?**", (route) => {
    requests.push(new URL(route.request().url()).search);
    return route.continue();
  });
  const results = page.getByRole("region", { name: "Search results" });
  const provenance = page.locator("details", {
    hasText: "Search source and snapshot",
  });
  await page.goto("/search?q=cukta&lang=en");
  await expect(results.locator("article").first()).toBeVisible();
  await provenance.locator("summary").click();
  await expect(provenance).toContainText(`View: ${f.view}`);
  expect(requests).toHaveLength(1);
  expect(requests[0]).not.toContain("view=");
  // The reader chooses another signed view inside the app, then goes back.
  await page.getByRole("link", { name: /^Trust:/ }).click();
  await page.getByLabel("Signed view event ID").fill(f.views.shun);
  await page.getByRole("button", { name: "Use this view" }).click();
  await expect(page.locator("main")).toContainText(
    `Signed view in use: ${f.views.shun}`,
  );
  await page.goBack();
  await expect(page.getByLabel("Search words and meanings")).toHaveValue(
    "cukta",
  );
  await expect(results.locator("article").first()).toBeVisible();
  await expect(provenance).toContainText(`View: ${f.views.shun}`);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toContain(`view=${encodeURIComponent(f.views.shun)}`);
  // The same choice restores the results without a request.
  await page.getByRole("link", { name: "Settings" }).click();
  await page.goBack();
  await expect(results.locator("article").first()).toBeVisible();
  await expect(provenance).toContainText(`View: ${f.views.shun}`);
  expect(requests).toHaveLength(2);
  // A return to the server's view is a change of choice too.
  await page.getByRole("link", { name: /^Trust:/ }).click();
  await page.getByRole("button", { name: "Back to the server's view" }).click();
  await expect(page.locator("main")).toContainText("Selected by this server");
  await page.goBack();
  await expect(results.locator("article").first()).toBeVisible();
  await expect(provenance).toContainText(`View: ${f.view}`);
  expect(requests).toHaveLength(3);
  expect(requests[2]).not.toContain("view=");
  // Older saved state without a choice marker is not restored.
  await page.evaluate(() => {
    const state = { ...(history.state ?? {}) };
    delete state.dictionarySearch.choice;
    history.replaceState(state, "");
  });
  await page.getByRole("link", { name: "Settings" }).click();
  await page.goBack();
  await expect(results.locator("article").first()).toBeVisible();
  expect(requests).toHaveLength(4);
});

test("the local-query guard blocks result fetches and query-bearing capability variants", async ({
  page,
}) => {
  await page.route("**/privacy-harness", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Privacy test</title>",
    }),
  );
  await page.goto("/privacy-harness");
  const guard = await guardLocalQuery(page, "book");
  await page.evaluate(async () => {
    await fetch("/api/v1/capabilities");
    for (const path of [
      "/words/result",
      "/search/extra?q=book",
      "/other?query=book",
      "/capabilities?q=book",
    ])
      await fetch(`/api/v1${path}`).catch(() => {});
    await fetch("/api/v1/capabilities", {
      method: "POST",
      body: JSON.stringify({ query: "book" }),
    }).catch(() => {});
  });
  expect(guard.forbidden).toHaveLength(5);
  expect(guard.leaks).toHaveLength(4);
});
