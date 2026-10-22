import { test, expect } from "@playwright/test";
import {
  acceptFirstSignature,
  createIdentity,
  fixture,
  openWord,
} from "./helpers.ts";

test("word language tabs keep failed definitions visible", async ({ page }) => {
  const id = fixture().definitions.cukta2;
  await page.route(`**/api/v1/events/${encodeURIComponent(id)}?**`, (route) =>
    route.abort("failed"),
  );
  await page.goto("/word/cukta?lang=en");
  await expect(
    page.getByText(
      new RegExp(`Definition ${id.slice(0, 20)}.* is unavailable`),
    ),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Definition language" })
      .getByRole("link", { name: /English/ }),
  ).toHaveAttribute("aria-current", "true");
  await page.getByRole("link", { name: /^All/ }).click();
  await expect(
    page.getByText(
      new RegExp(`Definition ${id.slice(0, 20)}.* is unavailable`),
    ),
  ).toBeVisible();
});

test("imported author links use HTTPS evidence and Source fallback opens its disclosure", async ({
  page,
}) => {
  const id = fixture().definitions.imported;
  await page.goto(`/definition/${encodeURIComponent(id)}`);
  await expect(
    page.getByRole("link", { name: "arj", exact: true }),
  ).toHaveAttribute("href", "https://lensisku.invalid/api/definitions/42");
  await page.goto("/search?q=library");
  await expect(
    page.getByRole("link", { name: "ckusro", exact: true }),
  ).toBeVisible();
  await page.evaluate(async (id) => {
    const { attribution } = await import(
      String("/src/components/attribution.ts")
    );
    const envelope = { id, header: { issuer: "ed25519:" + "1".repeat(64) } };
    const body = {
      legacy: {
        attribution: {
          author: "fallback author",
          author_account: {
            origin: "https://source.invalid",
            account: 8,
            evidence: {
              kind: "username-lookup",
              source: { url: "http://unsafe.invalid/evidence" },
            },
          },
        },
      },
    };
    document
      .querySelector("main")!
      .append(attribution(envelope as any, body as any).node);
  }, id);
  const author = page.getByRole("link", {
    name: "fallback author",
    exact: true,
  });
  await expect(author).toHaveAttribute(
    "title",
    /does not establish source authorship/,
  );
  await author.click();
  const source = page
    .locator("main details.disclosure")
    .filter({ has: page.locator("summary", { hasText: /^Source$/ }) });
  await expect(source).toHaveAttribute("open", "");
  await expect(
    source.getByText("Source author: arj.", { exact: true }),
  ).toBeVisible();
  // A second same-page fallback link opens the disclosure after the reader closes it.
  await source.locator(":scope > summary").click();
  await page.evaluate(async (id) => {
    const { attribution } = await import(
      String("/src/components/attribution.ts")
    );
    document
      .querySelector("main")!
      .append(
        attribution(
          { id, header: { issuer: "test" } } as any,
          { legacy: { attribution: { author: "same page author" } } } as any,
        ).node,
      );
  }, id);
  await page.getByRole("link", { name: "same page author" }).click();
  await expect(source).toHaveAttribute("open", "");
});

test("local search separates exact NFC spellings from case and apostrophe aliases", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("main h1")).toBeAttached();
  const result = await page.evaluate(async () => {
    const { localSearch, matchKind } = await import(
      String("/src/data/search.ts")
    );
    const make = (n: number, spelling: string, glosses: string[]) => ({
      event: "jve1:" + n.toString(16).padStart(64, "0"),
      word: { language: "jbo", spelling },
      glosses: glosses.map((text) => ({ language: "en", text, sense: null })),
      plain_text: "",
      classification: { kind: "other", selmaho: [] },
      language: "en",
      body: null,
    });
    const entries = [
      make(1, ".alis", []),
      make(2, "broda", [".Alis"]),
      make(3, ".Alis", []),
      make(4, ".Alisa", []),
    ];
    return {
      hits: localSearch(entries as any, ".Alis").map((hit: any) => [
        hit.word.spelling,
        hit.match,
      ]),
      apostrophe: matchKind(make(5, "brode", ["can't"]) as any, "can’t"),
      nfc: matchKind(make(6, "brodi", ["é"]) as any, "e\u0301"),
    };
  });
  expect(result.hits).toEqual([
    [".Alis", "headword"],
    ["broda", "gloss"],
    [".alis", "alias"],
    [".Alisa", "headword-prefix"],
  ]);
  expect(result.apostrophe).toBe("alias");
  expect(result.nfc).toBe("gloss");
});

test("remote and local-fallback queries name the host before the first request", async ({
  page,
}) => {
  for (const mode of ["local", "remote"]) {
    await page.goto("/about");
    await expect(page.locator("main h1")).toBeAttached();
    await page.evaluate(async (searchMode) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const store = new LocalStore();
      await store.setPreferences({ searchMode, remoteSearchDisclosed: false });
    }, mode);
    let statement = "";
    await page.route("**/api/v1/search?**", async (route) => {
      statement = await page.locator("main").innerText();
      await route.continue();
    });
    await page.goto("/search?q=book&lang=en");
    await expect(
      page.getByRole("link", { name: "cukta", exact: true }),
    ).toBeVisible();
    expect(statement).toContain(
      `Search sends this query to ${new URL(page.url()).host}.`,
    );
    await expect(
      page.getByText(`Searched on ${new URL(page.url()).host}.`, {
        exact: true,
      }),
    ).toBeVisible();
    await page.unroute("**/api/v1/search?**");
  }
});

test("concurrent preference changes keep both choices and remove the old persistent unlock setting", async ({
  page,
}) => {
  await page.goto("/about");
  await expect(page.locator("main h1")).toBeAttached();
  const preferences = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const name = "jbovlacku-concurrent-preferences";
    const first = new LocalStore(name);
    const second = new LocalStore(name);
    await first.put("prefs", "preferences", {
      theme: "dark",
      keepUnlocked: true,
    });
    await Promise.all([
      first.setPreferences({ myJudgmentsFirst: true }),
      second.setPreferences({ orthography: "zbalermorna" }),
    ]);
    return {
      loaded: await second.preferences(),
      stored: await first.get("prefs", "preferences"),
    };
  });
  for (const value of [preferences.loaded, preferences.stored]) {
    expect(value).toMatchObject({
      theme: "dark",
      myJudgmentsFirst: true,
      orthography: "zbalermorna",
    });
    expect(value).not.toHaveProperty("keepUnlocked");
  }
});

test("reading preferences change orthography and preserve scores and singleton layers", async ({
  page,
}) => {
  await createIdentity(page);
  await openWord(page, "cukta");
  const articles = page.locator("article.definition");
  await expect(articles).toHaveCount(4);
  const originalScores = await articles
    .locator(".judgment .score")
    .allTextContents();
  await articles.last().getByRole("button", { name: "Oppose" }).click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toHaveText(
    "Your opposition is published.",
  );
  const originalOrder = await articles
    .locator(".byline a[href^='/definition/']")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href")));
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByLabel("Show my judgments first on word pages").check();
  await page
    .getByLabel("Lojban orthography beside headwords")
    .selectOption("zbalermorna");
  await openWord(page, "cukta");
  await expect(page.locator(".word-head .zbalermorna")).toBeVisible();
  await expect(articles).toHaveCount(4);
  // Each fixture layer holds one definition, so the preference preserves their order.
  expect(
    await articles
      .locator(".byline a[href^='/definition/']")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href"))),
  ).toEqual(originalOrder);
  await expect(
    articles.last().getByRole("button", { name: "Oppose", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    (await articles.locator(".judgment .score").allTextContents()).sort(),
  ).toEqual([...originalScores].sort());
  await page.getByLabel("Search words and meanings").fill("cukta");
  await page.getByLabel("Search words and meanings").press("Enter");
  await expect(page.locator("article.hit .zbalermorna")).toBeVisible();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page
    .getByLabel("Lojban orthography beside headwords")
    .selectOption("latin");
  await openWord(page, "cukta");
  await expect(page.locator(".word-head .zbalermorna")).toHaveCount(0);
});

test("search score details open by keyboard and list every supplied incoming identity", async ({
  page,
}) => {
  await page.goto("/search?q=book&lang=en");
  const row = page
    .locator("article.hit")
    .filter({ has: page.getByRole("link", { name: "cukta", exact: true }) });
  const summary = row.locator("details.judgment-details summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(row.getByText("Support", { exact: true })).toBeVisible();
  await page.goto("/about");
  await expect(page.locator("main h1")).toBeAttached();
  const ids = Array.from(
    { length: 5 },
    (_, i) => "ed25519:" + String(i + 1).repeat(64),
  );
  await page.evaluate(async (ids) => {
    const { scoreDetails } = await import(
      String("/src/components/judgment.ts")
    );
    const zero = { numerator: "0", denominator: "1" };
    const score = {
      target: "test",
      support: [zero, zero],
      opposition: [zero, zero],
      net: [zero, zero],
      direct_reviewers: 1,
      reviewers_complete: true,
      reviewers: [
        {
          identity: ids[0],
          verdict: "bless",
          root: null,
          incoming: ids,
          incoming_count: 8,
          incoming_complete: false,
          multiple_routes: true,
          weight: [zero, zero],
        },
      ],
    };
    document
      .querySelector("main")!
      .append(
        scoreDetails(
          { own: { registers: async () => null }, session: {} } as any,
          { id: "test", word: "test", describe: () => "test" },
          { score, unavailable: false } as any,
        ),
      );
  }, ids);
  await page.locator("details.judgment-details summary").click();
  const table = page.getByRole("region", { name: "Reviewers" });
  for (const id of ids)
    await expect(
      table.locator(`a[href='/identity/${encodeURIComponent(id)}']`).first(),
    ).toBeVisible();
  await expect(table).toContainText(
    "The server lists 5 of 8 incoming identities.",
  );
});

test("conflicted judgments expose both branches and Clear even when scores are unavailable", async ({
  page,
}) => {
  await page.goto("/about");
  await expect(page.locator("main h1")).toBeAttached();
  const ids = ["jve1:" + "a".repeat(64), "jve1:" + "b".repeat(64)];
  await page.evaluate(async (ids) => {
    const { judgmentControl, scoreDetails } = await import(
      String("/src/components/judgment.ts")
    );
    const state = { known: true, conflicted: true, value: null, events: ids };
    const own = {
      registers: async () => ({ judgments: new Map([["test", state]]) }),
      subscribe: () => () => {},
      invalidate() {},
    };
    const app = {
      own,
      offlineSigning: { value: false },
      session: {
        identity: "me",
        storageAvailable: true,
        requireUnlocked: async (_: string, action: () => Promise<void>) =>
          action(),
        firstSignatureDisclosure: async () => true,
      },
      store: {
        get: async (_: string, id: string) => ({
          transport: JSON.stringify({
            envelope: {
              header: { action: { value: id === ids[0] ? "bless" : "curse" } },
            },
          }),
        }),
      },
      delivery: { items: async () => [] },
      signer: {
        publish: async (records: any[]) => {
          (window as any).resolved = records[0].action;
          return [{ peers: { mirror: { state: "refused" } } }];
        },
      },
      announce: (message: string) => {
        document.querySelector("[role=status]")!.textContent = message;
      },
    };
    const target = { id: "test", word: null, describe: () => "test" };
    document
      .querySelector("main")!
      .append(
        judgmentControl(app as any, target, { score: null, unavailable: true }),
        scoreDetails(app as any, target, { score: null, unavailable: true }),
      );
  }, ids);
  await expect(
    page.locator(".own-judgment").getByRole("link", { name: "Endorsement" }),
  ).toHaveAttribute("href", `/definition/${encodeURIComponent(ids[0])}`);
  await expect(
    page.locator(".own-judgment").getByRole("link", { name: "Opposition" }),
  ).toBeVisible();
  await page.locator("details.judgment-details summary").click();
  await expect(
    page
      .locator("details")
      .getByRole("button", { name: "Endorse", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator("details")
      .getByRole("button", { name: "Oppose", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear my judgment" }).click();
  expect(await page.evaluate(() => (window as any).resolved.value)).toBe(
    "clear",
  );
  await expect(page.getByRole("status")).toContainText(
    "Delivery is not finished",
  );
});

test("place strip numbers have readable text and receipt positions name their server", async ({
  page,
}) => {
  await page.goto("/word/cukta");
  const item = page
    .locator("article.definition")
    .first()
    .locator(".place-strip > span")
    .first();
  await expect(item).toContainText("place 1: book");
  await expect(item).not.toHaveAttribute("aria-label", /.*/);
  await expect(item).toMatchAriaSnapshot(`- text: "place 1: book"`);
  await page.goto(
    `/identity/${encodeURIComponent(fixture().identities.curator)}`,
  );
  await expect(
    page.getByText(/^Receipt position \d+ on browser-test$/).first(),
  ).toBeVisible();
  await expect(page.getByText(/^Seen \d+$/)).toHaveCount(0);
});

test("failed disclosure persistence keeps remote reading and the session acknowledgment", async ({
  page,
}) => {
  await page.goto("/about");
  await expect(page.locator("main h1")).toBeAttached();
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const original = LocalStore.prototype.setPreferences;
    (window as any).disclosureWrites = 0;
    LocalStore.prototype.setPreferences = async function (patch: any) {
      if (patch.remoteSearchDisclosed) {
        (window as any).disclosureWrites++;
        throw new Error("Preference storage failed");
      }
      return original.call(this, patch);
    };
  });
  const statements: string[] = [];
  await page.route("**/api/v1/search?**", async (route) => {
    statements.push(await page.locator("main").innerText());
    await route.continue();
  });
  for (const query of ["book", "library"]) {
    await page.getByLabel("Search words and meanings").fill(query);
    await page.getByLabel("Search words and meanings").press("Enter");
    await expect(
      page.getByRole("link", {
        name: query === "book" ? "cukta" : "ckusro",
        exact: true,
      }),
    ).toBeVisible();
  }
  expect(statements).toHaveLength(2);
  expect(statements[0]).toContain(
    `Search sends this query to ${new URL(page.url()).host}.`,
  );
  expect(statements[1]).toContain(`Searched on ${new URL(page.url()).host}.`);
  expect(await page.evaluate(() => (window as any).disclosureWrites)).toBe(1);
  await expect(page.locator("main")).not.toContainText(
    "Preference storage failed",
  );
});

for (const tail of [false, true]) {
  test(`own judgments stay within ranking layers${tail ? " and before no ranked definition in the tail" : " with one note per layer"}`, async ({
    page,
  }) => {
    const f = fixture();
    const ids = [
      f.definitions.cukta1,
      f.definitions.cukta2,
      f.definitions.cukta3,
      f.definitions.cuktaRev,
    ];
    await page.route("**/api/v1/words/**", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.layers = tail
        ? [[ids[0], ids[1]], [ids[2]]]
        : [
            [ids[0], ids[1]],
            [ids[2], ids[3]],
          ];
      await route.fulfill({ response, json: body });
    });
    await page.goto("/preferences");
    await page.getByLabel("Show my judgments first on word pages").check();
    await page.evaluate(
      async (judged) => {
        const { OwnState } = await import(String("/src/app/context.ts"));
        OwnState.prototype.registers = async () =>
          ({
            complete: true,
            trust: new Map(),
            judgments: new Map(
              judged.map((id: string) => [
                id,
                { known: true, value: "bless", conflicted: false, events: [] },
              ]),
            ),
          }) as any;
      },
      [ids[1], ids[3]],
    );
    await openWord(page, "cukta");
    await page.getByRole("link", { name: /^All/ }).click();
    const articles = page.locator("article.definition");
    await expect(articles).toHaveCount(4);
    const links = await articles
      .locator(".byline a[href^='/definition/']")
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("href")));
    const expected = tail
      ? [ids[1], ids[0], ids[2], ids[3]]
      : [ids[1], ids[0], ids[3], ids[2]];
    expect(links).toEqual(
      expected.map((id) => `/definition/${encodeURIComponent(id)}`),
    );
    await expect(
      page.getByText(/^2 alternatives with unresolved order\./),
    ).toHaveCount(tail ? 1 : 2);
  });
}

test("missing own judgments disclose the failure and keep ranking order", async ({
  page,
}) => {
  await page.goto("/preferences");
  await page.getByLabel("Show my judgments first on word pages").check();
  await page.evaluate(async () => {
    const { OwnState } = await import(String("/src/app/context.ts"));
    OwnState.prototype.registers = async () => null;
  });
  await openWord(page, "cukta");
  await expect(
    page.getByText(
      "Your judgments could not be loaded. Definitions follow ranking layers, then event order.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Definitions with your judgments appear first.", {
      exact: false,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Your judgments appear first", { exact: false }),
  ).toHaveCount(0);
});
