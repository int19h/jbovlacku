import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
const corePath = `/@fs${resolve("packages/core/src/browser.ts")}`;
const pkg = (spellings: string[], rafsi: string[][] = []) => ({
  version: 2,
  snapshot: "sha256:" + "a".repeat(64),
  entries: spellings.map((spelling, index) => ({
    event: "jve1:" + (index + 1).toString(16).padStart(64, "0"),
    word: { language: "jbo", spelling },
    language: "en",
    glosses: [
      { language: "en", text: "c*-algebra", sense: null },
      { language: "en", text: "name@example.org", sense: null },
    ],
    plain_text: "how do you say hello?",
    classification: { kind: "other", selmaho: [] },
    body: null,
    issuer: "ed25519:" + "1".repeat(64),
    notes: false,
    attribution: null,
    rafsi: [...(rafsi[index] ?? [])].sort(),
    rafsi_complete: true,
  })),
});
const emptyWord = {
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
};

test("R2 plain and queued pattern aborts preserve the shared worker and prepared package", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const Original = Worker;
    (window as any).searchWorkers = 0;
    window.Worker = class extends Original {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (String(url).includes("package-search-worker"))
          (window as any).searchWorkers++;
        const property = Object.getOwnPropertyDescriptor(
          Original.prototype,
          "onmessage",
        )!;
        Object.defineProperty(this, "onmessage", {
          get: () => property.get?.call(this),
          set: (handler) =>
            property.set?.call(this, (event: MessageEvent) => {
              // Abort the active plain consumer before its completed reply settles it.
              if (event.data.result && (window as any).abortPlainOnReply) {
                const abort = (window as any).abortPlainOnReply;
                delete (window as any).abortPlainOnReply;
                abort();
              }
              handler?.call(this, event);
            }),
        });
      }
    };
  });
  await page.goto("/");
  const result = await page.evaluate(
    async (pkg) => {
      const { searchPackage } = await import(
        String("/src/data/package-search.ts")
      );
      const cold = new AbortController();
      let duringAbort: Promise<any> | undefined;
      (window as any).abortPlainOnReply = () => {
        cold.abort();
        // Reuse before the client receives the preparation acknowledgment.
        duringAbort = searchPackage(pkg, "en", ["bangu"]);
      };
      const coldError = await searchPackage(pkg, "en", ["bangu"], {
        signal: cold.signal,
      }).catch((error: any) => error.name);
      const backgroundWarm = !(await duringAbort!).prepared;
      const plain = new AbortController();
      (window as any).abortPlainOnReply = () => plain.abort();
      const aborted = searchPackage(pkg, "en", ["bangu"], {
        signal: plain.signal,
      }).catch((e: any) => e.name);
      const plainError = await aborted;
      const running = searchPackage(pkg, "en", ["bangu"]);
      const queued = new AbortController();
      const canceled = searchPackage(pkg, "en", ["ba*"], {
        signal: queued.signal,
      }).catch((e: any) => e.name);
      queued.abort();
      const active = await running;
      const later = await searchPackage(pkg, "en", ["ba*"]);
      const second = structuredClone(pkg);
      second.snapshot = "sha256:" + "b".repeat(64);
      await searchPackage(second, "en", ["bangu"]);
      const third = structuredClone(pkg);
      third.snapshot = "sha256:" + "c".repeat(64);
      const cancelThird = new AbortController();
      const thirdRequest = searchPackage(third, "en", ["ba*"], {
        signal: cancelThird.signal,
      }).catch((error: any) => error.name);
      cancelThird.abort();
      const originalWarm = await searchPackage(pkg, "en", ["bangu"]);
      const secondWarm = await searchPackage(second, "en", ["bangu"]);
      return {
        coldError,
        backgroundWarm,
        aborted: plainError,
        canceled: await canceled,
        active: active.hits[0].length,
        prepared: later.prepared,
        workers: (window as any).searchWorkers,
        third: await thirdRequest,
        originalWarm: !originalWarm.prepared,
        secondWarm: !secondWarm.prepared,
      };
    },
    pkg(["bangu"]),
  );
  expect(result).toEqual({
    coldError: "AbortError",
    backgroundWarm: true,
    aborted: "AbortError",
    canceled: "AbortError",
    active: 1,
    prepared: false,
    workers: 1,
    third: "AbortError",
    originalWarm: true,
    secondWarm: true,
  });
});
test("R2 nearby meanings use literal search", async ({ page }) => {
  await page.goto("/");
  const results = await page.evaluate(
    async (pkg) => {
      const { searchPackage } = await import(
        String("/src/data/package-search.ts")
      );
      const rows = [];
      for (const q of ["c*-algebra", "name@example.org"]) {
        const result = await searchPackage(pkg, "en", [q], {
          nearby: true,
          patterns: false,
        });
        rows.push(result.totals[0]);
      }
      return rows;
    },
    pkg(["r2word"]),
  );
  expect(results).toEqual([1, 1]);
});
test("R2 patterns use normalized dictionary order and remove combining acute literals", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(
    async (pkg) => {
      const { searchPackage } = await import(
        String("/src/data/package-search.ts")
      );
      const all = await searchPackage(pkg, "en", ["*"]);
      const acute = await searchPackage(pkg, "en", ["/^dj\u0301an$/"]);
      const unicode = await searchPackage(pkg, "en", [String.raw`/^\w{3,8}$/`]);
      return {
        all: all.hits[0].map((hit: any) => hit.word.spelling),
        acute: acute.hits[0].map((hit: any) => hit.word.spelling),
        unicode: unicode.totals[0],
      };
    },
    pkg(["zabna", "bangu", "djan", "ci zei tuple"]),
  );
  expect(result.all).toEqual(["bangu", "ci zei tuple", "djan", "zabna"]);
  expect(result.acute).toEqual(["djan"]);
  expect(result.unicode).toBe(3);
});
test("R2 question punctuation shows an ordinary-search note", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(
    async (pkg) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      await new LocalStore().put("packages", "en", pkg);
    },
    pkg(["r2word"]),
  );
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const cached: any = await store.get("packages", "en");
    cached.entries[0].plain_text += " what is a C*-algebra?";
    await store.put("packages", "en", cached);
  });
  for (const q of ["how do you say hello?", "what is a C*-algebra?"]) {
    await page.goto("/search?" + new URLSearchParams({ q, lang: "en" }));
    await expect(
      page.getByText(
        "The final question mark is punctuation. This search uses ordinary text.",
      ),
    ).toBeVisible();
    await expect(page.locator("article.hit")).toHaveCount(1);
  }
});
test("R2 rafsi conflict groups normalize aliases while assignments retain raw spellings", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(
    async (pkg) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      await new LocalStore().put("packages", "en", pkg);
    },
    pkg(["r2rafsa", "r2rafsb", "r2rafsc"], [["ba'i"], ["BAHI"], ["bahi"]]),
  );
  await page.route("**/api/v1/manifest", (route) => route.abort());
  await page.route("**/api/v1/words/**", (route) =>
    route.fulfill({ json: emptyWord }),
  );
  await page.goto("/rafsi/bahi");
  await expect(
    page.getByText("3 words claim ba'i.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Stored spellings: BAHI, ba'i, bahi.", { exact: false }),
  ).toBeVisible();
  const pairs = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { wordsWithRafsi } = await import(String("/src/pages/rafsi.ts"));
    const rows: { rafsi: string; spelling: string }[] = await wordsWithRafsi(
      {
        session: {
          preferences: { definitionLanguage: "en" },
          storageAvailable: true,
        },
        store: new LocalStore(),
      } as any,
      "bahi",
      new AbortController().signal,
    );
    return rows.map((row) => ({
      raw: row.rafsi,
      pair: core.rafsiPairId(
        core.wordId({ language: "jbo", spelling: row.spelling }),
        row.rafsi,
      ),
    }));
  }, corePath);
  expect(pairs.map((row) => row.raw).sort()).toEqual(["BAHI", "ba'i", "bahi"]);
  expect(new Set(pairs.map((row) => row.pair)).size).toBe(3);
  await expect(page.locator("section.definition[aria-label]")).toHaveCount(3);
  expect(
    await page
      .locator("section.definition[aria-label]")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("aria-label")),
      ),
  ).toEqual(["ba'i for r2rafsa", "BAHI for r2rafsb", "bahi for r2rafsc"]);
});
test("R2 truncated rafsi conflict counts disclose their lower bound", async ({
  page,
}) => {
  await page.goto("/");
  const spellings = Array.from(
    { length: 17 },
    (_, i) => "r2cap" + String.fromCharCode(97 + i),
  );
  const rafsi = spellings.map((_, i) =>
    Array.from({ length: 64 }, (_, part) =>
      part === 0
        ? "ra"
        : "r" +
          String.fromCharCode(98 + i) +
          String.fromCharCode(97 + Math.floor(part / 26)) +
          String.fromCharCode(97 + (part % 26)),
    ),
  );
  await page.evaluate(
    async (pkg) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      await new LocalStore().put("packages", "en", pkg);
    },
    pkg(spellings, rafsi),
  );
  await page.route("**/api/v1/manifest", (route) => route.abort());
  await page.route("**/api/v1/words/**", (route) =>
    route.fulfill({ json: emptyWord }),
  );
  await page.goto("/rafsi/r*");
  await expect(page.getByText(/At least 16 words claim ra\./)).toBeVisible();
  await expect(
    page.getByText(/This page shows at most 1,000 matching pairs/),
  ).toBeVisible();
});
test("R2 literal proposed slash and wildcard rafsi reach the claim preview", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(
    async (pkg) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      await new LocalStore().put("packages", "en", pkg);
    },
    pkg(["r2claim"], [["a"]]),
  );
  await page.route("**/api/v1/manifest", (route) => route.abort());
  await page.goto("/claim/cukta");
  for (const value of ["/", "ba* word", "@"]) {
    await page.getByLabel("Rafsi spelling").fill(value);
    await page
      .getByRole("button", { name: "Check claims and preview" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Preview", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(/The glob contains|Write a regular expression/),
    ).toHaveCount(0);
    await expect(
      page.getByText(`No retained claim of ${value} for another word`, {
        exact: false,
      }),
    ).toBeVisible();
  }
});

test("R2 late canceled package replies preserve newer warm cache keys", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const Original = Worker;
    const bypass = new WeakSet<Event>();
    let first = true;
    window.Worker = class extends Original {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (String(url).includes("package-search-worker"))
          this.addEventListener("message", (event) => {
            if (!first || bypass.has(event) || !event.data.result) return;
            first = false;
            event.stopImmediatePropagation();
            const data = event.data;
            (window as any).releaseOldPackageReply = () => {
              const reply = new MessageEvent("message", { data });
              bypass.add(reply);
              this.dispatchEvent(reply);
            };
          });
      }
    };
  });
  await page.goto("/");
  const observed = await page.evaluate(
    async (pkg) => {
      const { searchPackage } = await import(
        String("/src/data/package-search.ts")
      );
      const controller = new AbortController();
      const older = searchPackage(pkg, "en", ["bangu"], {
        signal: controller.signal,
      }).catch((error: any) => error.name);
      const second = structuredClone(pkg);
      second.snapshot = "sha256:" + "e".repeat(64);
      await searchPackage(second, "en", ["bangu"]);
      controller.abort();
      (window as any).releaseOldPackageReply();
      return {
        older: await older,
        originalWarm: !(await searchPackage(pkg, "en", ["bangu"])).prepared,
        secondWarm: !(await searchPackage(second, "en", ["bangu"])).prepared,
      };
    },
    pkg(["bangu"]),
  );
  expect(observed).toEqual({
    older: "AbortError",
    originalWarm: true,
    secondWarm: true,
  });
});
