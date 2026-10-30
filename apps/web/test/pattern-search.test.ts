import { test, expect, type Page } from "@playwright/test";
import { corePath } from "./helpers.ts";

const language = "en-x-pattern";
const queries = ["/^ba/", "/nu$/", "ba*", "@@$", "?a?a", "*'i", "*hi"];
async function fixture(page: Page) {
  await page.goto("/");
  const baseline = await page.evaluate(
    async ({ corePath, language }) => {
      const core = await import(corePath);
      await core.initializeCore();
      const seed = crypto.getRandomValues(new Uint8Array(32));
      let serial = 0;
      const signed = (action: any, body: any) =>
        core.createEvent(
          seed,
          [],
          (++serial).toString(16).padStart(32, "0"),
          action,
          body,
        );
      const word = (spelling: string) => ({ language: "jbo", spelling });
      const id = core.wordId(word("cukta"));
      const before = await (
        await fetch(`/api/v1/words/${encodeURIComponent(id)}`)
      ).json();
      const definitions = [
        "bapattern",
        "barpattern",
        "baxpattern",
        "bapti'i",
        "patnnu",
        "xaptnu",
        "uab",
        "yeb",
        "zaxa",
        "xaxa",
        "pátterndjan",
        "patternz",
      ].map((spelling) =>
        signed(
          {
            kind: "definition.publish",
            word: core.wordId(word(spelling)),
            language,
            parents: [],
            origin: "native",
          },
          {
            word: word(spelling),
            language,
            text: [["Synthetic pattern fixture."]],
            classification: {
              kind: spelling === "pátterndjan" ? "cmevla" : "other",
            },
            license: { expression: "CC0-1.0" },
          },
        ),
      );
      const claims = ["baptni", "ptnrafnu", "yub", "zaxa", "baptni'i"].map(
        (rafsi) =>
          signed(
            {
              kind: "rafsi.publish",
              word: core.wordId(word("patternz")),
              assignment: core.rafsiPairId(
                core.wordId(word("patternz")),
                rafsi,
              ),
              origin: "native",
            },
            {
              word: word("patternz"),
              rafsi,
              rationale: [],
              sources: [],
              legacy: null,
            },
          ),
      );
      for (const record of [...definitions, ...claims]) {
        const response = await fetch("/api/v1/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(record),
        });
        if (!response.ok) throw new Error(await response.text());
      }
      return { id, definitions: before.definitions, rafsi: before.rafsi };
    },
    { corePath, language },
  );
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/api/v1/search?${new URLSearchParams({ q: "/^ba/", language })}`,
      );
      return response.ok() && (await response.json()).hits.length;
    })
    .toBe(5);
  const unchanged = await (
    await page.request.get(`/api/v1/words/${encodeURIComponent(baseline.id)}`)
  ).json();
  expect(unchanged.definitions).toEqual(baseline.definitions);
  expect(unchanged.rafsi).toEqual(baseline.rafsi);
}
const pkgScript = () => ({
  snapshot: "sha256:" + "a".repeat(64),
  entries: [
    {
      event: "jve1:" + "b".repeat(64),
      word: { language: "jbo", spelling: "bangu" },
      language: "en",
      glosses: [],
      plain_text: "Synthetic fixture.",
      classification: { kind: "other", selmaho: [] },
      body: null,
    },
  ],
});
async function busyWorker(page: Page) {
  await page.addInitScript(() => {
    const Original = Worker;
    (window as any).blockPatternWorker = true;
    window.Worker = class extends Original {
      constructor(url: string | URL, options?: WorkerOptions) {
        if (
          String(url).includes("package-search-worker") &&
          (window as any).blockPatternWorker
        ) {
          (window as any).blockPatternWorker = false;
          const source =
            "self.onmessage=({data})=>{self.postMessage({request:data.request,started:true});while(true){}}";
          super(
            URL.createObjectURL(
              new Blob([source], { type: "text/javascript" }),
            ),
            options,
          );
        } else super(url, options);
      }
    };
  });
}

test("browser and server agree on every headword and rafsi pattern and preserve display spelling", async ({
  page,
}) => {
  await fixture(page);
  const compared = await page.evaluate(
    async ({ language, queries }) => {
      const { downloadPackage } = await import(String("/src/data/search.ts"));
      const { searchPackage } = await import(
        String("/src/data/package-search.ts")
      );
      const pkg = await downloadPackage(language);
      const rows = [];
      const attempts: {
        query: string;
        attempt: number;
        status: number;
        body?: unknown;
      }[] = [];
      const readRemote = async (q: string) => {
        // Resource refusal is possible on the shared VM. Keep three attempts,
        // with no retry for syntax errors, server failures, or malformed data.
        for (let attempt = 1; attempt <= 3; attempt++) {
          const response = await fetch(
            `/api/v1/search?${new URLSearchParams({ q, language })}`,
          );
          const text = await response.text();
          let body: any;
          try {
            body = JSON.parse(text);
          } catch {
            throw new Error(
              JSON.stringify({ q, status: response.status, text, attempts }),
            );
          }
          attempts.push({
            query: q,
            attempt,
            status: response.status,
            ...(response.status === 200 ? {} : { body }),
          });
          if (response.status === 200) {
            if (!body || !Array.isArray(body.hits) || body.code !== undefined)
              throw new Error(
                JSON.stringify({ q, status: response.status, body, attempts }),
              );
            return body;
          }
          if (
            response.status !== 422 ||
            !body ||
            body.code !== "pattern_timeout" ||
            typeof body.message !== "string" ||
            Object.hasOwn(body, "hits")
          )
            throw new Error(
              JSON.stringify({ q, status: response.status, body, attempts }),
            );
          if (attempt < 3)
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error(
          JSON.stringify({
            q,
            message:
              "Pattern parity exhausted three resource-limited attempts.",
            attempts,
          }),
        );
      };
      for (const q of [...queries, "/^PÁTTERNDJAN$/", "/hi$/", "/\\D+/"]) {
        const remote = await readRemote(q);
        const local = await searchPackage(pkg, language, [q]);
        const key = (hit: any) => [
          hit.word_id,
          hit.match,
          hit.definitions,
          hit.word.spelling,
        ];
        rows.push({
          q,
          remote: remote.hits.map(key),
          local: local.hits[0].map(key),
        });
        const rafsi = await searchPackage(pkg, language, [q], {
          rafsiOnly: true,
        });
        if (
          queries.includes(q) &&
          rafsi.hits[0][0]?.word.spelling !== "patternz"
        )
          throw new Error("Rafsi pattern missed its word.");
      }
      const { LocalStore } = await import(String("/src/data/store.ts"));
      await new LocalStore().put("packages", language, pkg);
      return { rows, attempts };
    },
    { language, queries },
  );
  await test.info().attach("server-pattern-attempts.json", {
    body: JSON.stringify(compared.attempts, null, 2),
    contentType: "application/json",
  });
  console.log("Server pattern attempts:", JSON.stringify(compared.attempts));
  for (const result of compared.rows)
    expect(result.local, result.q).toEqual(result.remote);
  await page.goto(
    `/search?${new URLSearchParams({ q: "/^PÁTTERNDJAN$/", lang: language })}`,
  );
  await expect(page.locator("article.hit .hw")).toHaveText(["pátterndjan"]);
  let leaked = false;
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/search")) leaked = true;
  });
  await page.goto(
    `/search?${new URLSearchParams({ q: "/[/", lang: language })}`,
  );
  await expect(
    page.getByText(
      "The regular expression is invalid or exceeds its compilation limit. Use a simpler pattern.",
    ),
  ).toBeVisible();
  expect(leaked).toBe(false);
  await page.goto(
    `/search?${new URLSearchParams({ q: "ba*", lang: language })}`,
  );
  await expect(page.locator("article.hit")).toHaveCount(5);
  expect(leaked).toBe(false);
  await page.goto(`/rafsi/${encodeURIComponent("b*")}`);
  await expect(
    page.getByText("baptni ← ", { exact: false }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("baptni'i ← ", { exact: false }).first(),
  ).toBeVisible();
  await expect(page.getByText(/words claim b\*/)).toHaveCount(0);
});

test("pattern show all keeps stable order and version 1 discloses missing rafsi data", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().put("packages", "en", {
      snapshot: "sha256:" + "a".repeat(64),
      entries: Array.from({ length: 27 }, (_, index) => ({
        event: "jve1:" + index.toString(16).padStart(64, "0"),
        word: { language: "jbo", spelling: "ba" + "a".repeat(index) + "b" },
        language: "en",
        glosses: [],
        plain_text: "Synthetic fixture.",
        classification: { kind: "other", selmaho: [] },
        body: null,
      })),
    });
  });
  await page.goto("/search?q=ba*&lang=en");
  await expect(page.locator("article.hit")).toHaveCount(20);
  await expect(
    page.locator("main > .notice").filter({ hasText: /known.word ordering/i }),
  ).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText(
    /Definitions (?:appear|comes?) first/i,
  );
  await expect(
    page.getByText(
      "This package has no rafsi data. Pattern results cover headwords only.",
    ),
  ).toBeVisible();
  const first = await page.locator("article.hit .hw").allTextContents();
  await page.getByRole("button", { name: "show all", exact: true }).click();
  await expect(page.locator("article.hit")).toHaveCount(27);
  const all = await page.locator("article.hit .hw").allTextContents();
  expect(all.slice(0, 20)).toEqual(first);
  expect(new Set(all).size).toBe(27);
});

test("rafsi lookup reports version 1 metadata as unavailable", async ({
  page,
}) => {
  await page.route("**/api/v1/manifest", async (route) => {
    const response = await route.fetch();
    const manifest = await response.json();
    manifest.package_versions = [];
    await route.fulfill({ response, json: manifest });
  });
  await page.goto("/rafsi/b*");
  await expect(
    page.getByText(
      "Rafsi lookup needs a version 2 search package. This server and the saved packages supply no rafsi data.",
    ),
  ).toBeVisible();
  await expect(page.getByText(/No retained claim assigns/)).toHaveCount(0);
});

test("a real blocked worker reaches its deadline without blocking the page and recovers", async ({
  page,
}) => {
  await busyWorker(page);
  await page.goto("/");
  const result = await page.evaluate(async (pkg) => {
    const { searchPackage } = await import(
      String("/src/data/package-search.ts")
    );
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    let code = "";
    try {
      await searchPackage(pkg, "en", ["/(a+)+$/"]);
    } catch (error: any) {
      code = error.code;
    }
    clearInterval(timer);
    const recovered = await searchPackage(pkg, "en", ["ba*"]);
    return {
      code,
      ticks,
      recovered: recovered.hits[0].map((hit: any) => hit.word.spelling),
    };
  }, pkgScript());
  expect(result.code).toBe("pattern_timeout");
  expect(result.ticks).toBeGreaterThan(3);
  expect(result.recovered).toEqual(["bangu"]);
});

test("canceling a shared worker settles active and queued requests and a later search recovers", async ({
  page,
}) => {
  await busyWorker(page);
  await page.goto("/");
  const result = await page.evaluate(async (pkg) => {
    const { searchPackage } = await import(
      String("/src/data/package-search.ts")
    );
    const controller = new AbortController();
    const active = searchPackage(pkg, "en", ["/(a+)+$/"], {
      signal: controller.signal,
    });
    const queued = searchPackage(pkg, "en", ["ba*"]);
    setTimeout(() => controller.abort(), 100);
    const stopped = await Promise.allSettled([active, queued]);
    const recovered = await searchPackage(pkg, "en", ["ba*"]);
    return {
      errors: stopped.map((result) =>
        result.status === "rejected" ? result.reason.name : result.status,
      ),
      recovered: recovered.hits[0].length,
    };
  }, pkgScript());
  expect(result.errors).toEqual(["AbortError", "AbortError"]);
  expect(result.recovered).toBe(1);
});

test("a missing-package retry starts a fresh worker after another request cancels the old one", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const Original = Worker;
    let first = true;
    window.Worker = class extends Original {
      constructor(url: string | URL, options?: WorkerOptions) {
        if (first && String(url).includes("package-search-worker")) {
          first = false;
          const source =
            "let first=true;self.onmessage=({data})=>{if(first){first=false;setTimeout(()=>self.postMessage({request:data.request,key:data.key,code:'package-missing',error:'Synthetic eviction.'}),100)}else if(data.cancel===undefined){self.postMessage({request:data.request,started:true})}}";
          super(
            URL.createObjectURL(
              new Blob([source], { type: "text/javascript" }),
            ),
            options,
          );
        } else super(url, options);
        const property = Object.getOwnPropertyDescriptor(
          Original.prototype,
          "onmessage",
        )!;
        Object.defineProperty(this, "onmessage", {
          get: () => property.get?.call(this),
          set: (handler) =>
            property.set?.call(this, (event: MessageEvent) => {
              handler?.call(this, event);
              // Force cancellation before the rejected promise can retry.
              if (event.data.code === "package-missing")
                (window as any).cancelQueued?.();
            }),
        });
      }
    };
  });
  await page.goto("/");
  const result = await page.evaluate(async (pkg) => {
    const { searchPackage } = await import(
      String("/src/data/package-search.ts")
    );
    const controller = new AbortController();
    (window as any).cancelQueued = () => controller.abort();
    const retried = searchPackage(pkg, "en", ["ba*"]);
    const canceled = searchPackage(pkg, "en", ["ba*"], {
      signal: controller.signal,
    }).catch((error: any) => error.name);
    return {
      retried: (await retried).hits[0].length,
      canceled: await canceled,
    };
  }, pkgScript());
  expect(result).toEqual({ retried: 1, canceled: "AbortError" });
});

test("legal long headwords exhaust the corpus budget without partial hits and the worker stays usable", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { searchPackage } = await import(
      String("/src/data/package-search.ts")
    );
    const long = "a".repeat(254) + "b";
    const entries = Array.from({ length: 25_000 }, (_, index) => ({
      event: "jve1:" + index.toString(16).padStart(64, "0"),
      word: { language: "jbo", spelling: index === 0 ? "a" : long },
      language: "en",
      glosses: [],
      plain_text: "",
      classification: { kind: "other", selmaho: [] },
      body: null,
    }));
    const pkg = { snapshot: "sha256:" + "a".repeat(64), entries };
    let code = "",
      message = "";
    try {
      await searchPackage(pkg, "en", ["/(a+)+$/"]);
    } catch (error: any) {
      code = error.code;
      message = error.message;
    }
    const recovered = await searchPackage(pkg, "en", ["a"]);
    return {
      code,
      message,
      recovered: recovered.hits[0].length,
      prepared: recovered.prepared,
    };
  });
  expect(result.code).toBe("pattern_timeout");
  expect(result.message).toContain("time or work limit");
  expect(result.recovered).toBe(2);
  expect(result.prepared).toBe(false);
});

async function cachedRafsiRows(page: Page, count: number, rafsiCount: number) {
  await page.goto("/");
  await page.evaluate(
    async ({ corePath, count, rafsiCount }) => {
      const core = await import(corePath);
      await core.initializeCore();
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const entries = Array.from({ length: count }, (_, index) => ({
        event: "jve1:" + (index + 1).toString(16).padStart(64, "0"),
        word: { language: "jbo", spelling: "ba" + "a".repeat(index) + "b" },
        language: "en",
        glosses: [],
        plain_text: "Synthetic rafsi fixture.",
        classification: { kind: "other", selmaho: [] },
        body: null,
        issuer: "ed25519:" + "1".repeat(64),
        notes: false,
        attribution: null,
        rafsi_complete: true,
        rafsi: Array.from({ length: rafsiCount }, (_, part) =>
          part === 0
            ? "ra"
            : "r" +
              String.fromCharCode(98 + index) +
              String.fromCharCode(97 + Math.floor(part / 26)) +
              String.fromCharCode(97 + (part % 26)),
        ),
      }));
      await new LocalStore().put("packages", "en", {
        snapshot: "sha256:" + "a".repeat(64),
        version: 2,
        entries,
      });
    },
    { corePath, count, rafsiCount },
  );
  await page.route("**/api/v1/manifest", (route) => route.abort());
}
const emptyRafsiWord = () => ({
  snapshot: "sha256:" + "a".repeat(64),
  view: "jve1:" + "b".repeat(64),
  word: null,
  definitions: [],
  rafsi: [],
  assignments: [],
  scores: [],
  statuses: [],
  layers: [],
  unavailable_scores: [],
  calculation: null,
});

test("R2 Opus F3: rafsi package rows group accent displays by word ID in the real worker", async ({
  page,
}) => {
  await page.goto("/");
  await page.route("**/api/v1/manifest", (route) => route.abort());
  const result = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { wordsWithRafsi } = await import(String("/src/pages/rafsi.ts"));
    const cached = {
      snapshot: "sha256:" + "a".repeat(64),
      version: 2,
      entries: ["dján", "djan"].map((spelling, index) => ({
        event: "jve1:" + (index + 1).toString(16).padStart(64, "0"),
        word: { language: "jbo", spelling },
        language: "en",
        glosses: [],
        plain_text: "Synthetic name.",
        classification: { kind: "cmevla", selmaho: [] },
        body: null,
        issuer: "ed25519:" + "a".repeat(64),
        notes: false,
        attribution: null,
        rafsi: ["dja"],
        rafsi_complete: true,
      })),
    };
    const app = {
      session: {
        preferences: { definitionLanguage: "en" },
        storageAvailable: true,
      },
      store: { keys: async () => ["en"], get: async () => cached },
    };
    const found = await wordsWithRafsi(
      app as any,
      "dja",
      new AbortController().signal,
    );
    return {
      count: found.length,
      identity: core.wordId({ language: "jbo", spelling: found[0].spelling }),
      expected: core.wordId({ language: "jbo", spelling: "djan" }),
    };
  }, corePath);
  expect(result.count).toBe(1);
  expect(result.identity).toBe(result.expected);
});

test("rafsi patterns show 20 cards first and show all keeps each assignment and conflict", async ({
  page,
}) => {
  await cachedRafsiRows(page, 3, 10);
  const wordRequests: string[] = [];
  await page.route("**/api/v1/words/**", async (route) => {
    wordRequests.push(route.request().url());
    await route.fulfill({ json: emptyRafsiWord() });
  });
  await page.goto("/rafsi/r*");
  const cards = page.locator("section.definition[aria-label]");
  await expect(cards).toHaveCount(20);
  expect(wordRequests.length).toBeLessThanOrEqual(20);
  await expect(
    page.getByText(
      "3 words claim ra. The assignment is unresolved until the selected view prefers one.",
    ),
  ).toBeVisible();
  const first = await cards.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("aria-label")),
  );
  await page.getByRole("button", { name: "show all", exact: true }).click();
  await expect(cards).toHaveCount(30);
  const all = await cards.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("aria-label")),
  );
  expect(all.slice(0, 20)).toEqual(first);
  expect(new Set(all).size).toBe(30);
  expect(all.filter((value) => value?.startsWith("ra for ")).length).toBe(3);
});

test("rafsi patterns cut the page at 1,000 pairs and state the coverage limit", async ({
  page,
}) => {
  await cachedRafsiRows(page, 17, 64);
  let requested = 0;
  await page.route("**/api/v1/words/**", async (route) => {
    requested++;
    await route.fulfill({ json: emptyRafsiWord() });
  });
  await page.goto("/rafsi/r*");
  await expect(
    page.getByText(
      "Rafsi coverage is limited. Packages list at most 64 rafsi per word. This page shows at most 1,000 matching pairs. Refine the pattern for more specific results.",
    ),
  ).toBeVisible();
  await expect(page.locator(".surface-word > p.muted a")).toHaveCount(1000);
  await expect(page.locator("section.definition[aria-label]")).toHaveCount(20);
  expect(requested).toBeLessThanOrEqual(20);
});

test("navigation cancels a rafsi expansion before it requests the remaining cards", async ({
  page,
}) => {
  await cachedRafsiRows(page, 40, 1);
  let hold = false,
    release: (() => void) | undefined,
    requested = 0;
  await page.route("**/api/v1/words/**", async (route) => {
    requested++;
    if (hold)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    await route.fulfill({ json: emptyRafsiWord() }).catch(() => {});
  });
  await page.goto("/rafsi/r*");
  await expect(page.locator("section.definition[aria-label]")).toHaveCount(20);
  expect(requested).toBe(20);
  hold = true;
  await page.getByRole("button", { name: "show all", exact: true }).click();
  await expect.poll(() => release !== undefined).toBe(true);
  await page.evaluate(async () => {
    (await import(String("/src/app/router.ts"))).navigate(
      "/search?q=bangu&lang=en",
    );
  });
  await expect(
    page.getByRole("region", { name: "Search results" }),
  ).toBeVisible();
  release!();
  await page.waitForTimeout(100);
  expect(requested).toBe(21);
  await expect(page.locator("section.definition[aria-label]")).toHaveCount(0);
  await expect(page.getByText("Search was canceled.")).toHaveCount(0);
});

test("navigation cancels actual rafsi claim bodies and prevents later claim requests", async ({
  page,
}) => {
  await cachedRafsiRows(page, 40, 1);
  let claimMode = false,
    release: (() => void) | undefined,
    aborted = false;
  const envelopes = new Map<string, any>(),
    bodies = new Map<string, string>();
  const eventRequests: string[] = [],
    bodyRequests: string[] = [];
  await page.route("**/api/v1/words/**", async (route) => {
    if (!claimMode) {
      await route.fulfill({ json: emptyRafsiWord() });
      return;
    }
    const id = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/").at(-1)!,
    );
    const fixture = await page.evaluate(
      async ({ corePath, id }) => {
        const core = await import(corePath);
        await core.initializeCore();
        const word = Array.from({ length: 40 }, (_, index) => ({
          language: "jbo",
          spelling: "ba" + "a".repeat(index) + "b",
        })).find((word) => core.wordId(word) === id)!;
        const pair = core.rafsiPairId(id, "ra");
        const records = [1, 2].map((index) =>
          core.createEvent(
            new Uint8Array(32).fill(98),
            [],
            index.toString(16).padStart(32, "0"),
            {
              kind: "rafsi.publish",
              word: id,
              assignment: pair,
              origin: "native",
            },
            {
              word,
              rafsi: "ra",
              rationale: [["Synthetic claim " + index]],
              sources: [],
              legacy: null,
            },
          ),
        );
        return {
          pair,
          records: records.map((record) => ({
            envelope: record.envelope,
            canonical: core.canonicalize(
              core.utf8(JSON.stringify(record.body)),
            ),
          })),
        };
      },
      { corePath, id },
    );
    for (const record of fixture.records) {
      envelopes.set(record.envelope.id, record.envelope);
      bodies.set(record.envelope.header.content.hash, record.canonical);
    }
    await route.fulfill({
      json: {
        ...emptyRafsiWord(),
        assignments: [
          {
            id: fixture.pair,
            claims: fixture.records.map((record) => record.envelope.id),
            status: "eligible",
          },
        ],
      },
    });
  });
  await page.route("**/api/v1/events/**", async (route) => {
    const id = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/").at(-1)!,
    );
    if (!envelopes.has(id)) {
      await route.continue();
      return;
    }
    eventRequests.push(id);
    await route.fulfill({ json: envelopes.get(id) });
  });
  await page.route("**/api/v1/bodies/**", async (route) => {
    const id = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/").at(-1)!,
    );
    if (!bodies.has(id)) {
      await route.continue();
      return;
    }
    bodyRequests.push(id);
    if (bodyRequests.length === 1)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    await route
      .fulfill({ contentType: "application/json", body: bodies.get(id)! })
      .catch(() => {});
  });
  page.on("requestfailed", (request) => {
    const id = decodeURIComponent(
      new URL(request.url()).pathname.split("/").at(-1)!,
    );
    if (bodies.has(id) && /ABORT/iu.test(request.failure()?.errorText ?? ""))
      aborted = true;
  });
  await page.goto("/rafsi/r*");
  await expect(page.locator("section.definition[aria-label]")).toHaveCount(20);
  claimMode = true;
  await page.getByRole("button", { name: "show all", exact: true }).click();
  await expect.poll(() => release !== undefined).toBe(true);
  try {
    await page.evaluate(async () => {
      (await import(String("/src/app/router.ts"))).navigate(
        "/search?q=bangu&lang=en",
      );
    });
    await expect(
      page.getByRole("region", { name: "Search results" }),
    ).toBeVisible();
    await expect.poll(() => aborted, { timeout: 2000 }).toBe(true);
  } finally {
    release?.();
  }
  await page.waitForTimeout(100);
  expect(eventRequests).toHaveLength(1);
  expect(bodyRequests).toHaveLength(1);
  await expect(page.locator("section.definition[aria-label]")).toHaveCount(0);
});

for (const compact of [false, true])
  test(`r3: a pattern with a mismatched ${compact ? "compact" : "legacy"} package view shows no ordering advice`, async ({
    page,
  }) => {
    await page.goto("/");
    await page.evaluate(async (compact) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const store = new LocalStore();
      const view = "jve1:" + "a".repeat(64);
      await store.put("packages", "en", {
        snapshot: "sha256:" + "b".repeat(64),
        version: 2,
        ...(compact ? { search_view: view } : {}),
        entries: [
          {
            event: "jve1:" + "1".repeat(64),
            word: { language: "jbo", spelling: "klama" },
            language: "en",
            glosses: [],
            plain_text: "Synthetic pattern definition.",
            classification: { kind: "gismu", selmaho: [] },
            body: null,
            issuer: "ed25519:" + "c".repeat(64),
            notes: false,
            rafsi: [],
            rafsi_complete: true,
            attribution: null,
            search_status: compact ? "active" : { view, status: "active" },
          },
        ],
      });
      await store.setPreferences({
        view: "jve1:" + "f".repeat(64),
        useAiAssistance: false,
      });
    }, compact);
    await page.goto("/search?q=kla*&lang=en");
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(["Lojban words"]);
    await expect(page.locator("article.hit .hw")).toHaveText(["klama"]);
    await expect(
      page
        .locator("main > .notice")
        .filter({ hasText: /known.word ordering/i }),
    ).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText(
      /Definitions (?:appear|comes?) first/i,
    );
  });
