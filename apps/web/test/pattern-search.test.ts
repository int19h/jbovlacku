import { test, expect, type Page } from "@playwright/test";
import { corePath } from "./helpers.ts";

const language = "en-x-pattern";
const queries = ["/^ba/", "/nu$/", "ba*", "@@$", "?a?a", "*'i", "*hi"];
async function fixture(page: Page) {
  await page.goto("/");
  await page.evaluate(
    async ({ corePath, language }) => {
      const core = await import(corePath);
      await core.initializeCore();
      const seed = new Uint8Array(32).fill(96);
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
      const definitions = [
        "bangu",
        "barda",
        "vecnu",
        "nu",
        "uen",
        "yen",
        "papa",
        "baba",
        "ba'i",
        "dján",
        "cukta",
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
            classification: { kind: spelling === "dján" ? "cmevla" : "other" },
            license: { expression: "CC0-1.0" },
          },
        ),
      );
      const claims = ["ban", "nu", "uen", "papa", "ba'i"].map((rafsi) =>
        signed(
          {
            kind: "rafsi.publish",
            word: core.wordId(word("cukta")),
            assignment: core.rafsiPairId(core.wordId(word("cukta")), rafsi),
            origin: "native",
          },
          {
            word: word("cukta"),
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
      for (const q of [...queries, "/^DJÁN$/", "/hi$/", "/\\D+/"]) {
        const remote = await (
          await fetch(`/api/v1/search?${new URLSearchParams({ q, language })}`)
        ).json();
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
        if (queries.includes(q) && rafsi.hits[0][0]?.word.spelling !== "cukta")
          throw new Error("Rafsi pattern missed its word.");
      }
      const { LocalStore } = await import(String("/src/data/store.ts"));
      await new LocalStore().put("packages", language, pkg);
      return rows;
    },
    { language, queries },
  );
  for (const result of compared)
    expect(result.local, result.q).toEqual(result.remote);
  await page.goto(
    `/search?${new URLSearchParams({ q: "/^DJÁN$/", lang: language })}`,
  );
  await expect(page.locator("article.hit .hw")).toHaveText(["dján"]);
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
    page.getByText("ban ← ", { exact: false }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("ba'i ← ", { exact: false }).first(),
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
            "let first=true;self.onmessage=({data})=>{if(first){first=false;setTimeout(()=>self.postMessage({request:data.request,key:data.key,code:'package-missing',error:'Synthetic eviction.'}),100)}}";
          super(
            URL.createObjectURL(
              new Blob([source], { type: "text/javascript" }),
            ),
            options,
          );
          (window as any).evictedWorker = this;
        } else super(url, options);
      }
    };
  });
  await page.goto("/");
  const result = await page.evaluate(async (pkg) => {
    const { searchPackage } = await import(
      String("/src/data/package-search.ts")
    );
    const controller = new AbortController();
    const retried = searchPackage(pkg, "en", ["ba*"]);
    const canceled = searchPackage(pkg, "en", ["ba*"], {
      signal: controller.signal,
    }).catch((error: any) => error.name);
    (window as any).evictedWorker.addEventListener(
      "message",
      (event: MessageEvent) => {
        if (event.data.code === "package-missing") controller.abort();
      },
    );
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
    const entries = Array.from({ length: 20_000 }, (_, index) => ({
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
    return { code, message, recovered: recovered.hits[0].length };
  });
  expect(result.code).toBe("pattern_timeout");
  expect(result.message).toContain("time or work limit");
  expect(result.recovered).toBe(2);
});
