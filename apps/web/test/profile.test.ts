import { test, expect, type Page } from "@playwright/test";
import {
  acceptFirstSignature,
  corePath,
  createIdentity,
  fingerprintText,
  fixture,
} from "./helpers.ts";

test("the profile Name field keeps focus when held activity finishes the page render", async ({
  page,
}) => {
  const identity = (await createIdentity(page)).identity as string;
  const activityPath = `/api/v1/identities/${encodeURIComponent(identity)}/activity`;
  let releaseActivity = () => {};
  const held = new Promise<void>((resolve) => (releaseActivity = resolve));
  let activityStarted = () => {};
  const started = new Promise<void>((resolve) => (activityStarted = resolve));
  await page.route(
    (url) => url.pathname === activityPath,
    async (route) => {
      activityStarted();
      await held;
      await route.continue();
    },
  );
  try {
    await page.getByRole("link", { name: "Edit public profile" }).click();
    await started;
    const name = page
      .getByRole("region", { name: "Edit public profile" })
      .getByLabel("Name", { exact: true });
    await expect(name).toBeFocused();
    const emptyActivity = page.getByText(
      "No signed records from this key are retained on this server.",
      { exact: true },
    );
    await expect(emptyActivity).toHaveCount(0);
    releaseActivity();
    await expect(emptyActivity).toBeVisible();
    // The next frame runs after the renderer's promise and heading-focus guard.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await expect(name).toBeFocused();
    await expect(page.locator("main h1")).not.toBeFocused();
  } finally {
    releaseActivity();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("a reader's search focus before the profile editor appears takes priority over Name focus", async ({
  page,
}) => {
  const identity = (await createIdentity(page)).identity as string;
  await page.evaluate(async (identity) => {
    const { forgetProfile } = await import(
      String("/src/components/attribution.ts")
    );
    forgetProfile(identity);
  }, identity);
  const profilePath = `/api/v1/identities/${encodeURIComponent(identity)}`;
  let releaseProfile = () => {};
  const held = new Promise<void>((resolve) => (releaseProfile = resolve));
  let profileStarted = () => {};
  const started = new Promise<void>((resolve) => (profileStarted = resolve));
  await page.route(
    (url) => url.pathname === profilePath,
    async (route) => {
      profileStarted();
      await held;
      await route.continue();
    },
  );
  try {
    await page.getByRole("link", { name: "Edit public profile" }).click();
    await started;
    const editor = page.getByRole("region", { name: "Edit public profile" });
    await expect(editor).toHaveCount(0);
    const search = page.getByLabel("Search words and meanings");
    await search.focus();
    await expect(search).toBeFocused();
    releaseProfile();
    await expect(editor.getByLabel("Name", { exact: true })).toBeVisible();
    await expect(page.locator("main")).toContainText(
      "No signed records from this key are retained on this server.",
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await expect(search).toBeFocused();
    await expect(page.locator("main h1")).not.toBeFocused();
  } finally {
    releaseProfile();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("the public profile editor checks every limit, previews the signed claim, and publishes it", async ({
  page,
}) => {
  const identity = (await createIdentity(page)).identity as string;
  await page.getByRole("link", { name: "Edit public profile" }).click();
  await expect(page).toHaveURL(/#edit$/);
  const editor = page.getByRole("region", { name: "Edit public profile" });
  await expect(editor).toContainText("public signed claim");
  await expect(editor).toContainText("At most 80 characters.");
  await expect(editor).toContainText("at most 8.");
  await expect(editor.getByLabel("Name", { exact: true })).toBeFocused();
  // Every problem is named before a preview exists.
  await editor.getByLabel("Name", { exact: true }).fill("x".repeat(81));
  await editor
    .getByLabel("Links", { exact: true })
    .fill("https://example.org/a\nhttp://example.org/b");
  await editor
    .getByRole("button", { name: "Preview the signed claim" })
    .click();
  await expect(editor).toContainText(
    "The name has 81 characters. The limit is 80.",
  );
  await expect(editor).toContainText(
    '"http://example.org/b" is not an absolute HTTPS address.',
  );
  await expect(
    page.getByRole("region", { name: "Profile preview" }),
  ).toHaveCount(0);
  // The biography node limit and the link count limit are checked too.
  await editor.getByLabel("Name", { exact: true }).fill("Short");
  // 8193 paragraphs are 8193 text parts. The value is set directly, which is faster than typing.
  await editor
    .getByLabel("Biography", { exact: true })
    .evaluate((node: HTMLTextAreaElement) => {
      node.value = Array(8193).fill("p").join("\n\n");
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
  await editor
    .getByLabel("Links", { exact: true })
    .fill(
      Array.from({ length: 9 }, (_, i) => `https://example.org/${i}`).join(
        "\n",
      ),
    );
  await editor
    .getByRole("button", { name: "Preview the signed claim" })
    .click();
  await expect(editor).toContainText(
    "The biography has 8193 text parts. The limit is 8192.",
  );
  await expect(editor).toContainText("There are 9 links. The limit is 8.");
  await expect(
    page.getByRole("region", { name: "Profile preview" }),
  ).toHaveCount(0);
  await editor.getByLabel("Name", { exact: true }).fill("Disposable Tester");
  await editor
    .getByLabel("Biography", { exact: true })
    .fill("A disposable profile for a test.\n\nSecond paragraph.");
  await editor
    .getByLabel("Links", { exact: true })
    .fill("https://example.org/a");
  await editor
    .getByRole("button", { name: "Preview the signed claim" })
    .click();
  const preview = page.getByRole("region", { name: "Profile preview" });
  await expect(preview).toContainText("Disposable Tester");
  await expect(preview).toContainText(fingerprintText(identity));
  await expect(preview).toContainText("A disposable profile for a test.");
  await expect(
    preview.getByRole("link", { name: "https://example.org/a" }),
  ).toBeVisible();
  await expect(preview).toContainText(
    "This is a public signed claim with retained history.",
  );
  let releaseReceipts!: () => void;
  const receiptsReady = new Promise<void>((resolve) => {
    releaseReceipts = resolve;
  });
  await page.route("**/api/v1/events", async (route) => {
    const response = await route.fetch();
    const receipt = await response.json();
    await route.fulfill({
      response,
      json: {
        ...receipt,
        snapshot: null,
        interpretation: "unavailable",
        reasons: ["index_lag", "evaluation_pending"],
      },
    });
  });
  await page.route("**/api/v1/receipts/*", async (route) => {
    await receiptsReady;
    await route.continue();
  });
  try {
    await preview
      .getByRole("button", { name: "Sign and publish the profile" })
      .click();
    await acceptFirstSignature(page);
    await expect(page.getByRole("status").last()).toContainText(
      "The profile is signed and published.",
    );
    await expect(
      page.getByText("This server stored your profile. Its view is updating."),
    ).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(0);
  } finally {
    releaseReceipts();
  }

  // The page shows the server's effective profile, and the key page shows the name.
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Disposable Tester",
  );
  await expect(page.locator("main")).toContainText(
    "A disposable profile for a test.",
  );
  await expect(
    page
      .locator("main")
      .getByRole("link", { name: "https://example.org/a" })
      .first(),
  ).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Recent activity" }),
  ).toContainText("Updated the public profile");
  const record = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const [item] = await new LocalStore().list("outbox");
    return JSON.parse(item.transport);
  });
  expect(record.envelope.header.action).toEqual({ kind: "identity.profile" });
  expect(record.body).toEqual({
    name: "Disposable Tester",
    bio: [["A disposable profile for a test."], ["Second paragraph."]],
    links: ["https://example.org/a"],
  });
  await page.getByRole("link", { name: "Manage it" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Disposable Tester",
  );
  // The editor starts from the current claim.
  await page.getByRole("link", { name: "Edit public profile" }).click();
  await expect(editor.getByLabel("Name", { exact: true })).toHaveValue(
    "Disposable Tester",
  );
  await expect(editor.getByLabel("Links", { exact: true })).toHaveValue(
    "https://example.org/a",
  );
});

test("a rafsi pair link opens the pair's word, rafsi, and judgment, and an unknown pair stays unavailable", async ({
  page,
}) => {
  const f = fixture();
  await page.goto(`/identity/${encodeURIComponent(f.identities.curator)}`);
  const pairLink = page
    .getByRole("list", { name: "Recent activity" })
    .locator('a[href^="/rafsi-pair/"]')
    .first();
  await expect(pairLink).toBeVisible();
  const href = await pairLink.getAttribute("href");
  await pairLink.click();
  await expect(page).toHaveTitle("Rafsi cku for cukta · jbovlacku");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("cku");
  await expect(
    page.getByRole("link", { name: "cukta", exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "all words with cku" }),
  ).toBeVisible();
  const card = page.getByRole("region", { name: "cku for cukta" });
  await expect(card).toContainText("Eligible pair");
  await expect(card.getByRole("button", { name: "Endorse" })).toBeVisible();
  await expect(card).toContainText("Claimed by");
  await expect(page.locator("main")).toContainText(
    decodeURIComponent(href!.slice("/rafsi-pair/".length)),
  );
  // A pair that no retained claim in the packages names stays unavailable.
  await page.goto(`/rafsi-pair/jvr1:${"0".repeat(64)}`);
  await expect(
    page.getByRole("heading", { name: "Rafsi pair unavailable" }),
  ).toBeVisible();
  await expect(page.locator("main")).toContainText(
    "the word and the rafsi are unknown here",
  );
  await page.goto("/rafsi-pair/not-a-pair");
  await expect(page.locator("main")).toContainText(
    "does not name a rafsi pair ID",
  );
});

/** Signs a profile claim with links and code in the biography, as another client can. */
async function signRichProfile(page: Page) {
  return page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { createKey } = await import(String("/src/data/keys.ts"));
    const { signWith, outboxItem } = await import(
      String("/src/data/lifecycle.ts")
    );
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const created = await createKey("test passphrase with spaces");
    await store.put("keys", "selected", created.backup);
    const body = {
      name: "Rich Tester",
      bio: [
        [
          "See ",
          { url: "https://example.org/site", label: "the site" },
          " and the word ",
          { code: "zo'e" },
          ".",
        ],
        ["Second paragraph."],
      ],
      links: ["https://example.org/site"],
    };
    const prepared = core.prepareSigning(
      created.backup.identity,
      [],
      Array.from(crypto.getRandomValues(new Uint8Array(16)), (n: number) =>
        n.toString(16).padStart(2, "0"),
      ).join(""),
      { kind: "identity.profile" },
      body,
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign("Ed25519", created.key, prepared.signing_bytes),
    );
    const transport = core.finishSigning(prepared, signature);
    void signWith;
    const item = outboxItem(transport, crypto.randomUUID(), 0, {
      self: { origin: location.origin, base: "/api/v1", label: "this server" },
    });
    await store.queueGroup([item]);
    return created.backup.identity;
  }, corePath);
}

test("changing only the name keeps a rich biography exact, and replacing it needs an explicit choice", async ({
  page,
}) => {
  await page.goto("/");
  const identity = await signRichProfile(page);
  // Delivery runs by itself once a page is open.
  await page.goto("/outbox");
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        const [item] = await new LocalStore().list("outbox");
        return item?.peers.self.state;
      }),
    )
    .toBe("accepted");
  // Delivery can finish before the server serves this fixture profile.
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/api/v1/identities/${encodeURIComponent(identity)}`,
      );
      expect(response.ok()).toBe(true);
      return (await response.json()).profile.state;
    })
    .toBe("known");
  await page.goto("/identity");
  await page
    .getByLabel("Passphrase", { exact: true })
    .fill("test passphrase with spaces");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByText("Unlocked", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Rich Tester",
  );
  await page.getByRole("link", { name: "Edit public profile" }).click();
  const editor = page.getByRole("region", { name: "Edit public profile" });
  await expect(editor.getByLabel("Biography", { exact: true })).toHaveValue(
    "See the site and the word zo'e.\n\nSecond paragraph.",
  );
  await expect(editor).toContainText(
    "The current biography has links or code that this editor shows as plain text.",
  );
  // Only the name changes. The signed body carries the exact current biography.
  await editor.getByLabel("Name", { exact: true }).fill("Renamed Tester");
  await editor
    .getByRole("button", { name: "Preview the signed claim" })
    .click();
  const preview = page.getByRole("region", { name: "Profile preview" });
  await expect(
    preview.getByRole("link", { name: /the site/ }).first(),
  ).toHaveAttribute("href", "https://example.org/site");
  await preview
    .getByRole("button", { name: "Sign and publish the profile" })
    .click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status").last()).toContainText(
    "The profile is signed and published.",
  );
  const bodies = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const items = await new LocalStore().list("outbox");
    return items
      .sort((a: any, b: any) => a.signedAt - b.signedAt)
      .map((item: any) => JSON.parse(item.transport).body);
  });
  expect(bodies).toHaveLength(2);
  expect(bodies[1].name).toBe("Renamed Tester");
  // The exact nodes of the first claim, kept through the name change.
  expect(bodies[1].bio).toEqual([
    [
      "See ",
      { url: "https://example.org/site", label: "the site" },
      " and the word ",
      { code: "zo'e" },
      ".",
    ],
    ["Second paragraph."],
  ]);
  expect(bodies[1].bio).toEqual(bodies[0].bio);
  expect(bodies[1].links).toEqual(["https://example.org/site"]);
  // The page rendered again with the new claim. An edited biography names
  // what the plain text drops and waits for the choice.
  await expect(editor.getByLabel("Name", { exact: true })).toHaveValue(
    "Renamed Tester",
  );
  await editor
    .getByLabel("Biography", { exact: true })
    .fill("A plain biography now.");
  await editor
    .getByRole("button", { name: "Preview the signed claim" })
    .click();
  await expect(editor).toContainText(
    'Signing it drops from the current biography: the link "the site" to https://example.org/site; the code "zo\'e".',
  );
  await expect(preview).toHaveCount(0);
  await editor
    .getByLabel(
      "Replace the links and code of the current biography with this plain text",
    )
    .check();
  await editor
    .getByRole("button", { name: "Preview the signed claim" })
    .click();
  await expect(preview).toContainText("A plain biography now.");
  await expect(preview.getByRole("link", { name: /the site/ })).toHaveCount(0);
  await preview
    .getByRole("button", { name: "Sign and publish the profile" })
    .click();
  // The earlier announcement is still in the live region. Wait for the third record itself.
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        return (await new LocalStore().list("outbox")).length;
      }),
    )
    .toBe(3);
  const last = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const items = await new LocalStore().list("outbox");
    return JSON.parse(
      items.sort((a: any, b: any) => a.signedAt - b.signedAt).at(-1).transport,
    ).body;
  });
  expect(last.bio).toEqual([["A plain biography now."]]);
});

test("a judgment control built before its card joins the page keeps its subscription, and navigation releases it", async ({
  page,
}) => {
  const f = fixture();
  await createIdentity(page);
  const competingClaim = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const word = { language: "jbo" as const, spelling: "vlacku" };
    const id = core.wordId(word);
    const record = core.createEvent(
      new Uint8Array(32).fill(238),
      [],
      "e".repeat(32),
      {
        kind: "rafsi.publish",
        word: id,
        assignment: core.rafsiPairId(id, "cku"),
        origin: "native",
      },
      { word, rafsi: "cku", rationale: [], sources: [], legacy: null },
    );
    const response = await fetch("/api/v1/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });
    if (!response.ok) throw new Error(await response.text());
    return record.envelope.id;
  }, corePath);
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/api/v1/words/${f.words.vlacku}`,
      );
      return (
        response.ok() && (await response.json()).rafsi.includes(competingClaim)
      );
    })
    .toBe(true);
  await page.evaluate(async () => {
    const { OwnState } = await import(String("/src/app/context.ts"));
    const original = OwnState.prototype.subscribe;
    (window as any).__ownListeners = 0;
    OwnState.prototype.subscribe = function (listener: () => void) {
      (window as any).__ownListeners++;
      const unsubscribe = original.call(this, listener);
      return () => {
        (window as any).__ownListeners--;
        return unsubscribe();
      };
    };
  });
  const listeners = () => page.evaluate(() => (window as any).__ownListeners);
  await page.getByRole("link", { name: "About", exact: true }).click();
  const baseline = await listeners();
  // The claim record of the pair waits until the test releases it.
  let release: (() => void) | null = null;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    `**/api/v1/events/${encodeURIComponent(f.claim)}*`,
    async (route) => {
      await held;
      await route.continue();
    },
  );
  const openRafsi = () =>
    page.evaluate(() => {
      const anchor = document.createElement("a");
      anchor.href = "/rafsi/cku";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    });
  await openRafsi();
  await expect(page).toHaveURL(/\/rafsi\/cku/);
  // The waiting card's control exists and subscribed while the card is outside
  // the document. Other tests can add words with this rafsi, whose cards
  // attach before this one, so the count is at least one more than the baseline.
  await expect.poll(listeners).toBeGreaterThanOrEqual(baseline + 1);
  const during = await listeners();
  // A DOM change during the wait must not release the subscription.
  await page.evaluate(() => {
    const probe = document.createElement("div");
    document.body.append(probe);
    probe.remove();
  });
  await page.waitForTimeout(200);
  expect(await listeners()).toBe(during);
  release!();
  const card = page.getByRole("region", { name: "cku for cukta" });
  await expect(card).toBeVisible();
  // The final paragraph appears after every sequential card joins the page.
  await expect(
    page.getByText(
      "A rafsi is not reserved by the first server that receives a claim. Judgments on a pair apply across all its publishers.",
    ),
  ).toBeVisible();
  // Other tests can add words with this rafsi, so one subscription per card is the rule.
  const pairCards = await page.getByRole("region", { name: / for / }).count();
  expect(pairCards).toBeGreaterThanOrEqual(2);
  await expect.poll(listeners).toBe(baseline + pairCards);
  // The attached control responds to a later own-state change.
  await card.getByRole("button", { name: "Endorse" }).click();
  await acceptFirstSignature(page);
  await expect(card.getByRole("button", { name: "Endorse" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // Navigation away releases the subscription.
  await page.getByRole("link", { name: "About", exact: true }).click();
  await expect.poll(listeners).toBe(baseline);
  // A card cancelled before it joins the document releases its subscription too.
  let releaseAgain: (() => void) | null = null;
  const heldAgain = new Promise<void>((resolve) => {
    releaseAgain = resolve;
  });
  await page.unroute(`**/api/v1/events/${encodeURIComponent(f.claim)}*`);
  await page.route(
    `**/api/v1/events/${encodeURIComponent(f.claim)}*`,
    async (route) => {
      await heldAgain;
      await route.continue().catch(() => null);
    },
  );
  await openRafsi();
  await expect.poll(listeners).toBeGreaterThanOrEqual(baseline + 1);
  await page.getByRole("link", { name: "About", exact: true }).click();
  await expect.poll(listeners).toBe(baseline);
  releaseAgain!();
});

test("the identity page says when the claim list or a claim body was cut by the response bounds", async ({
  page,
}) => {
  const f = fixture();
  const identity = f.identities.curator;
  await page.route(
    (url) =>
      url.pathname === `/api/v1/identities/${encodeURIComponent(identity)}`,
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const claim = body.profile.claims[0] ?? {
        event: "jve1:" + "1".repeat(64),
        issuer: identity,
        body_hash: null,
        body: null,
      };
      body.profile = {
        state: "conflicted",
        claims: [
          { ...claim, body_status: "present" },
          {
            ...claim,
            event: "jve1:" + "2".repeat(64),
            body: null,
            body_status: "omitted",
          },
          {
            ...claim,
            event: "jve1:" + "3".repeat(64),
            body: null,
            body_status: "unavailable",
          },
        ],
        claims_count: 20,
        claims_complete: false,
      };
      await route.fulfill({ response, json: body });
    },
  );
  await page.goto(`/identity/${encodeURIComponent(identity)}`);
  const main = page.locator("main");
  await expect(main).toContainText(
    "This response holds 3 of 20 concurrent profile claims. The IDs of the other 17 are not in this response.",
  );
  await expect(main).toContainText(
    "This response omitted 1 claim body for size. Open those claim records to read them.",
  );
  await expect(main).toContainText(
    "This key has 20 concurrent profile claims. 3 of them are shown. None is selected as current.",
  );
  // Record links exist only for the claim IDs this response supplies.
  await expect(
    main.locator(".card a.fingerprint[href^='/definition/jve1']"),
  ).toHaveCount(3);
  await expect(main).toContainText(
    "body omitted by this response for size; open the record",
  );
  await expect(main).toContainText("body unavailable on this server");
  // The unavailable state names the omitted body as an omission, not as a server gap.
  await page.unroute(
    (url) =>
      url.pathname === `/api/v1/identities/${encodeURIComponent(identity)}`,
  );
  await page.route(
    (url) =>
      url.pathname === `/api/v1/identities/${encodeURIComponent(identity)}`,
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.profile = {
        state: "unavailable",
        claims: [
          {
            event: "jve1:" + "4".repeat(64),
            issuer: identity,
            body_hash: null,
            body: null,
            body_status: "omitted",
          },
        ],
        claims_count: 1,
        claims_complete: false,
      };
      await route.fulfill({ response, json: body });
    },
  );
  await page.goto(`/identity/${encodeURIComponent(identity)}`);
  await expect(main).toContainText(
    "The newest profile claim's body was omitted by this response for size",
  );
  await expect(main).not.toContainText("The IDs of the other");
});
