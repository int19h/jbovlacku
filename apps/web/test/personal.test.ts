import { test, expect, type Page } from "@playwright/test";
import {
  acceptFirstSignature,
  corePath,
  createIdentity,
  fingerprintText,
  fixture,
  openWord,
  PASSPHRASE,
} from "./helpers.ts";

const firstScore = (page: Page) =>
  page.locator("article.definition").first().getByRole("img");
const scores = (page: Page) =>
  page
    .locator("article.definition .score")
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label")));
async function choosePersonal(page: Page) {
  await page.getByRole("link", { name: /^Trust:/ }).click();
  await page
    .getByRole("radio", { name: "Mine: site view + my choices" })
    .check();
  await expect(
    page.getByRole("link", { name: "Trust: personal view" }),
  ).toBeVisible();
}
async function ignorePrivately(page: Page, identity: string) {
  await page.goto(`/identity/${encodeURIComponent(identity)}`);
  await page.getByRole("button", { name: "Ignore their judgments" }).click();
  await page.getByRole("radio", { name: /Just for me/ }).check();
  await page
    .getByRole("region", { name: /Ignore/ })
    .getByRole("button", { name: "Ignore", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Saved as a private block",
  );
}

test("the personal view calculates scores locally from verified records and a private Ignore changes them", async ({
  page,
}) => {
  const f = fixture();
  const original = page.locator("article.definition").filter({
    has: page.locator(
      `a[href="/definition/${encodeURIComponent(f.definitions.cukta1)}"]`,
    ),
  });
  const originalScore = original.locator(".score");
  await page.goto("/word/cukta");
  await expect(originalScore).toHaveAttribute("aria-label", /^Score 6/);
  const site = await scores(page);
  expect(site[0]).toMatch(/^Score 6/);
  await choosePersonal(page);
  await openWord(page, "cukta");
  const panel = page.getByRole("region", { name: "Personal view" });
  await expect(panel).toContainText(
    /Personal view calculated in this browser from \d+ verified records/,
  );
  await expect(originalScore).toHaveAttribute(
    "aria-label",
    /^Score 6.*in your personal view$/,
  );
  // Without private choices the personal scores equal the site scores.
  expect(
    (await scores(page)).map((s) => s?.replace(/, in your personal view$/, "")),
  ).toEqual(site);
  const reviewers = (await originalScore.getAttribute("aria-label"))!.match(
    /(\d+) reviewers?/,
  )![1];
  await ignorePrivately(page, f.identities.curator);
  await openWord(page, "cukta");
  await expect(originalScore).toHaveAttribute(
    "aria-label",
    new RegExp(
      `^Score 0: 0 for, 0 against, ${reviewers} reviewers?, in your personal view$`,
    ),
  );
  // The same publication lists its reviewer with the private block from the local calculation.
  const details = original.locator("details.judgment-details");
  await details.locator("summary").click();
  await expect(details).toContainText("blocked by your private choice");
  await expect(details).toContainText("calculated in this browser");
  // The search row uses the same local calculation.
  await page.getByLabel("Search words and meanings").fill("book");
  await page.getByLabel("Search words and meanings").press("Enter");
  const row = page
    .getByRole("region", { name: "Search results" })
    .locator("article")
    .first();
  await expect(
    row.getByRole("img", { name: /^Score 0.*in your personal view$/ }),
  ).toBeVisible();
  // The site view is unchanged and the private block survives the switch.
  await page.getByRole("link", { name: "Trust: personal view" }).click();
  await page.getByRole("radio", { name: "Site view only" }).check();
  await expect(
    page.getByText(/also blocks trust that passes through them/),
  ).toBeVisible();
  await openWord(page, "cukta");
  await expect(originalScore).toHaveAttribute("aria-label", /^Score 6/);
  await expect(originalScore).not.toHaveAttribute("aria-label", /personal/);
});

test("cancelling the download keeps personal scores unavailable and offers the site view", async ({
  page,
}) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v1/records?*", async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  await page.goto("/trust");
  await page
    .getByRole("radio", { name: "Mine: site view + my choices" })
    .check();
  await openWord(page, "cukta");
  const panel = page.getByRole("region", { name: "Personal view" });
  await expect(panel).toContainText(/Downloading/);
  await panel.getByRole("button", { name: "Cancel" }).click();
  await expect(panel).toContainText("The local calculation was cancelled.");
  await expect(firstScore(page)).toHaveAttribute(
    "aria-label",
    "Score unavailable in the personal view",
  );
  await expect(
    page.getByText(
      /Personal scores are unavailable: The local calculation was cancelled/,
    ),
  ).toBeVisible();
  await expect(page.getByRole("img", { name: /^Score 6/ })).toHaveCount(0);
  release();
  await page.unroute("**/api/v1/records?*");
  await panel.getByRole("button", { name: "Recompute from records" }).click();
  await expect(panel).toContainText(/Personal view calculated in this browser/);
  await expect(firstScore(page)).toHaveAttribute(
    "aria-label",
    /^Score 6.*personal view$/,
  );
  await panel.getByRole("button", { name: "Use the site view" }).click();
  await expect(
    page.getByRole("link", { name: "Trust: site view" }),
  ).toBeVisible();
  await expect(firstScore(page)).toHaveAttribute("aria-label", /^Score 6/);
});

test("a records page that omits an inventory record or alters a body never produces a personal score", async ({
  page,
}) => {
  await page.route("**/api/v1/records?*", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.items = json.items.slice(1);
    await route.fulfill({ response, json });
  });
  await page.goto("/trust");
  await page
    .getByRole("radio", { name: "Mine: site view + my choices" })
    .check();
  await openWord(page, "cukta");
  const panel = page.getByRole("region", { name: "Personal view" });
  await expect(panel).toContainText(
    /inventory records are missing from the records transport/,
  );
  await expect(firstScore(page)).toHaveAttribute(
    "aria-label",
    "Score unavailable in the personal view",
  );
  await page.unroute("**/api/v1/records?*");
  await page.route("**/api/v1/records?*", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    const item = json.items[0];
    item.body = { ...(item.body ?? {}), tampered: true };
    await route.fulfill({ response, json });
  });
  await panel.getByRole("button", { name: "Recompute from records" }).click();
  await expect(panel).toContainText(/does not match its signed hash/);
  await expect(
    page.getByRole("img", { name: /^Score \d.*personal view$/ }),
  ).toHaveCount(0);
});

test("recompute from records compares a local site view calculation with the server scores", async ({
  page,
}) => {
  await page.goto("/word/cukta");
  await page.getByText("Check the scores locally").click();
  await page.getByRole("button", { name: "Recompute from records" }).click();
  await expect(page.locator("main").getByRole("status").last()).toContainText(
    /The local calculation from \d+ verified records matches the server's \d+ scores and layers for this word\./,
  );
  await expect(
    page.getByRole("region", { name: "Local calculation" }),
  ).toContainText(/Site view calculated in this browser/);
});

test("the personal view adds the signing identity as a root so its own endorsement counts after a refresh", async ({
  page,
}) => {
  const identity = (await createIdentity(page)).identity;
  await choosePersonal(page);
  await openWord(page, "cukta");
  const third = page.locator("article.definition", {
    hasText: "Third meaning",
  });
  await expect(third.getByRole("img")).toHaveAttribute(
    "aria-label",
    /^Score minus 3: 0 for, 3 against, \d+ reviewers, in your personal view$/,
  );
  const reviewersBefore = Number(
    (await third.getByRole("img").getAttribute("aria-label"))!.match(
      /(\d+) reviewers/,
    )![1],
  );
  // Later repeats keep earlier endorsements, but each new key adds exactly one reviewer.
  expect(reviewersBefore).toBeGreaterThanOrEqual(2);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const original = LocalStore.prototype.list;
    const state = { hold: false, waiting: false, release: () => {} };
    const held = new Promise<void>((resolve) => {
      state.release = resolve;
    });
    (window as any).ownRefreshGate = state;
    LocalStore.prototype.list = async function (name: string) {
      if (name === "ownhistory" && state.hold) {
        state.waiting = true;
        await held;
      }
      return original.call(this, name);
    };
  });
  let releaseReceipts!: () => void;
  const receiptsReady = new Promise<void>((resolve) => {
    releaseReceipts = resolve;
  });
  await page.route("**/api/v1/events", async (route) => {
    const response = await route.fetch();
    const receipt = await response.json();
    await page.evaluate(() => {
      (window as any).ownRefreshGate.hold = true;
    });
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
  let receiptReads = 0;
  await page.route("**/api/v1/receipts/*", async (route) => {
    receiptReads++;
    await receiptsReady;
    await route.continue();
  });
  let manifests = 0;
  try {
    await third.getByRole("button", { name: "Endorse" }).click();
    await acceptFirstSignature(page);
    await expect(page.getByRole("status")).toHaveText(
      "Your endorsement is published.",
    );
    // Publishing also reloads own history, which reads a manifest independently.
    await expect
      .poll(() => page.evaluate(() => (window as any).ownRefreshGate.waiting))
      .toBe(true);
    await page.evaluate(() => (window as any).ownRefreshGate.release());
    await expect(
      third.getByRole("button", { name: "Endorse" }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.route("**/api/v1/manifest", async (route) => {
      manifests++;
      await route.continue();
    });
    const panel = page.getByRole("region", { name: "Personal view" });
    const receiptsBeforeRecompute = receiptReads;
    await panel.getByRole("button", { name: "Recompute from records" }).click();
    await expect(
      panel.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => receiptReads)
      .toBeGreaterThan(receiptsBeforeRecompute);
    expect(manifests).toBe(0);
  } finally {
    releaseReceipts();
    await page.evaluate(() => (window as any).ownRefreshGate.release());
  }
  await expect.poll(() => manifests).toBeGreaterThan(0);
  await expect(
    page
      .locator("article.definition", { hasText: "Third meaning" })
      .getByRole("img"),
  ).toHaveAttribute(
    "aria-label",
    new RegExp(`, ${reviewersBefore + 1} reviewers, in your personal view$`),
  );
  const details = page
    .locator("article.definition", { hasText: "Third meaning" })
    .locator("details.judgment-details");
  await details.locator("summary").click();
  const ownReviewer = details.getByRole("row").filter({
    has: page.locator(`a[href="/identity/${encodeURIComponent(identity)}"]`),
  });
  await expect(ownReviewer).toContainText("root of the view (q=1)");
});

test("a body that became available is fetched for a cached record, and malformed transports are refused", async ({
  page,
}) => {
  await page.goto("/trust");
  await page
    .getByRole("radio", { name: "Mine: site view + my choices" })
    .check();
  await openWord(page, "cukta");
  const panel = page.getByRole("region", { name: "Personal view" });
  await expect(panel).toContainText(/Personal view calculated in this browser/);
  // Forget the body of one cached definition. The inventory still lists it as retained.
  const target = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const inventory = await store.get("inventory", "latest");
    for (const id of inventory.events) {
      const record = await store.get("records", id);
      if (
        record.body &&
        JSON.parse(record.envelope).header.action.kind === "definition.publish"
      ) {
        await store.put("records", id, {
          ...record,
          body: null,
          bodyStatus: "missing",
        });
        return { id, hash: record.bodyHash };
      }
    }
    return null;
  });
  expect(target).not.toBeNull();
  let bodyFetches = 0;
  page.on("request", (request) => {
    if (
      decodeURIComponent(request.url()).includes(
        `/api/v1/bodies/${target!.hash}`,
      )
    )
      bodyFetches++;
  });
  // The cached inventory alone cannot serve a calculation: the retained body is not cached.
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    void new LocalStore();
  });
  await page.reload();
  await page.goto("/word/cukta");
  await expect(panel).toContainText(/retained by the snapshot but not cached/);
  // Recompute fetches exactly that body and the calculation completes.
  await panel.getByRole("button", { name: "Recompute from records" }).click();
  await expect(panel).toContainText(/Personal view calculated in this browser/);
  expect(bodyFetches).toBeGreaterThanOrEqual(1);
  const restored = await page.evaluate(async (id) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return (await new LocalStore().get("records", id)).bodyStatus;
  }, target!.id);
  expect(restored).toBe("present");
  // A records page that does not advance is refused.
  await page.route("**/api/v1/records?*", async (route) => {
    const url = new URL(route.request().url());
    url.searchParams.delete("after");
    const response = await route.fetch({ url: url.href });
    const json = await response.json();
    json.next = json.items.at(-1).id;
    await route.fulfill({ response, json });
  });
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const inventory = await store.get("inventory", "latest");
    await store.delete("records", inventory.events.at(-1));
  });
  await panel.getByRole("button", { name: "Recompute from records" }).click();
  await expect(panel).toContainText(
    /did not advance|traversal did not advance|needed more pages/,
  );
  await page.unroute("**/api/v1/records?*");
  // A manifest whose digests do not match its inventory is refused before any record counts.
  await page.route("**/api/v1/manifest", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.manifest.events.hash = "sha256:" + "0".repeat(64);
    await route.fulfill({ response, json });
  });
  await panel.getByRole("button", { name: "Recompute from records" }).click();
  await expect(panel).toContainText(/does not match the manifest digests/);
  await page.unroute("**/api/v1/manifest");
  await panel.getByRole("button", { name: "Recompute from records" }).click();
  await expect(panel).toContainText(/Personal view calculated in this browser/);
});

test("a cached body takes part only when the selected snapshot retains it", async ({
  page,
}) => {
  await page.goto("/trust");
  await page
    .getByRole("radio", { name: "Mine: site view + my choices" })
    .check();
  await openWord(page, "cukta");
  await expect(
    page.getByRole("region", { name: "Personal view" }),
  ).toContainText(/Personal view calculated in this browser/);
  const result = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { loadRecords } = await import(String("/src/data/records.ts"));
    const store = new LocalStore();
    const a = await store.get("inventory", "latest");
    // Snapshot B has the same events but retains no bodies.
    const b = { ...a, snapshot: "sha256:" + "b".repeat(64), bodies: [] };
    const withA = await loadRecords(store, a);
    const withB = await loadRecords(store, b);
    // An empty cache for B: the same envelopes without any body.
    const empty = new LocalStore(`empty-cache-${Date.now()}`);
    for (const id of a.events) {
      const record = await store.get("records", id);
      await empty.put("records", id, {
        ...record,
        body: null,
        bodyStatus: record.bodyHash ? "missing" : "none",
      });
    }
    for (const hash of a.selections)
      await empty.put("selections", hash, await store.get("selections", hash));
    const fromEmpty = await loadRecords(empty, b);
    return {
      bodiesA: Object.keys(withA.bodies).length,
      bodiesB: Object.keys(withB.bodies).length,
      sameAsEmpty: JSON.stringify(withB) === JSON.stringify(fromEmpty),
      cachedBodies: (await store.list("records")).filter((r: any) => r.body)
        .length,
    };
  });
  expect(result.bodiesA).toBeGreaterThan(0);
  expect(result.bodiesB).toBe(0);
  expect(result.sameAsEmpty).toBe(true);
  // The cache keeps the bodies for snapshot A.
  expect(result.cachedBodies).toBe(result.bodiesA);
});

test("an authenticated record that the schema cannot interpret stays inert and never disables the local calculation", async ({
  page,
}) => {
  const f = fixture();
  await page.goto("/word/cukta");
  const result = await page.evaluate(
    async ({ corePath, cuktaWord, cukta1 }) => {
      const core = await import(corePath);
      await core.initializeCore();
      const { syncRecords, loadRecords } = await import(
        String("/src/data/records.ts")
      );
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const canon = (value: unknown) =>
        core.canonicalize(core.utf8(JSON.stringify(value)));
      const hash = (value: unknown) =>
        core.contentHash(core.utf8(canon(value)));
      const sign = (
        seed: Uint8Array,
        previous: string[],
        nonce: string,
        action: Record<string, unknown>,
        body: unknown,
      ) => {
        const content =
          body === null
            ? null
            : { hash: hash(body), bytes: core.utf8(canon(body)).length };
        const envelope = core.signHeader(seed, {
          version: 1,
          issuer: core.identityFromSeed(seed),
          previous: [...previous].sort(),
          nonce,
          action,
          content,
        });
        return { envelope, body };
      };
      // The server's real records.
      const server = await (await fetch("/api/v1/manifest")).json();
      const page1 = await (
        await fetch(
          `/api/v1/records?snapshot=${encodeURIComponent(server.snapshot)}&limit=200`,
        )
      ).json();
      const base = page1.items as {
        id: string;
        envelope: any;
        body: unknown;
      }[];
      const selectionsIds = (
        await (
          await fetch(
            `/api/v1/inventory?kind=import_selections&snapshot=${encodeURIComponent(server.snapshot)}`,
          )
        ).json()
      ).ids as string[];
      const selectionBytes: Record<string, string> = {};
      for (const id of selectionsIds)
        selectionBytes[id] = await (
          await fetch(
            `/api/v1/import-selections/${encodeURIComponent(id)}?snapshot=${encodeURIComponent(server.snapshot)}`,
          )
        ).text();
      // One inert record: an unknown action with a matching body.
      const stranger = new Uint8Array(32).fill(201);
      const inert = sign(
        stranger,
        [],
        "a".repeat(32),
        { kind: "future.unknown" },
        { future: "data" },
      );
      // A root of its own view blesses, clears, then blesses again with an explanation body that the schema rejects.
      const judge = new Uint8Array(32).fill(202);
      const judgeId = core.identityFromSeed(judge);
      const view = sign(
        judge,
        [],
        "b".repeat(32),
        { kind: "view.publish", parents: [] },
        {
          name: "Judge view",
          description: [["One root."]],
          roots: [{ identity: judgeId, q: { numerator: 1, denominator: 1 } }],
          rafsi_threshold: { numerator: 1, denominator: 1 },
          H: { numerator: 3, denominator: 1 },
          alpha: { numerator: 1, denominator: 2 },
          excluded: [],
          calculation: "simple-routes-bounds-v1",
          work: 10000,
          import_sets: [],
          account_witnesses: [],
          account_authority: false,
          notes: [],
        },
      );
      const bless = sign(
        judge,
        [view.envelope.id],
        "c".repeat(32),
        { kind: "judgment.set", target: cukta1, value: "bless" },
        null,
      );
      const clear = sign(
        judge,
        [bless.envelope.id],
        "d".repeat(32),
        { kind: "judgment.set", target: cukta1, value: "clear" },
        null,
      );
      // The same clear with an explanation body that the schema rejects. The
      // header value stands: an invalid explanation cannot hide a signed clear.
      const malformed = sign(
        judge,
        [bless.envelope.id],
        "e".repeat(32),
        { kind: "judgment.set", target: cukta1, value: "clear" },
        { not: "an explanation" },
      );
      const admission = (record: { envelope: unknown; body: unknown }) =>
        core.prepareAdmission(core.utf8(JSON.stringify(record)));
      const buildSnapshot = (extra: { envelope: any; body: unknown }[]) => {
        const items = [
          ...base,
          ...extra.map((r) => ({
            id: r.envelope.id,
            envelope: r.envelope,
            body: r.body,
          })),
        ].sort((x, y) => (x.id < y.id ? -1 : 1));
        const events = items.map((i) => i.id);
        const bodies = [
          ...new Set(
            items
              .filter((i) => i.envelope.header.content)
              .map((i) => i.envelope.header.content.hash),
          ),
        ].sort();
        const manifest = {
          version: 1,
          events: {
            count: events.length,
            hash: core.contentHash(
              core.utf8(items.map((i) => canon(i.envelope) + "\n").join("")),
            ),
          },
          bodies: { count: bodies.length, hash: hash(bodies) },
          import_selections: {
            count: selectionsIds.length,
            hash: hash(selectionsIds),
          },
        };
        const snapshot = hash(manifest);
        return {
          items,
          events,
          bodies,
          manifest,
          snapshot,
          logical_inventory: hash({
            events,
            bodies,
            import_selections: selectionsIds,
          }),
        };
      };
      const saved = globalThis.fetch;
      const serve = (
        snap: ReturnType<typeof buildSnapshot>,
        viewId: string,
      ) => {
        globalThis.fetch = (async (input: string | URL | Request) => {
          const url = new URL(
            String(input instanceof Request ? input.url : input),
            location.origin,
          );
          let value: unknown;
          if (url.pathname.endsWith("/manifest"))
            value = {
              snapshot: snap.snapshot,
              logical_inventory: snap.logical_inventory,
              manifest: snap.manifest,
              accepted_cursor: "x.1",
              materialized_cursor: "x.1",
              packages: [],
            };
          else if (url.pathname.endsWith("/inventory")) {
            const kind = url.searchParams.get("kind")!;
            value = {
              snapshot: snap.snapshot,
              kind,
              ids: {
                events: snap.events,
                bodies: snap.bodies,
                import_selections: selectionsIds,
              }[kind],
              next: null,
            };
          } else if (url.pathname.endsWith("/records"))
            value = {
              snapshot: snap.snapshot,
              logical_inventory: snap.logical_inventory,
              items: snap.items,
              next: null,
            };
          else if (url.pathname.includes("/import-selections/"))
            return new Response(
              selectionBytes[
                decodeURIComponent(url.pathname.split("/").at(-1)!)
              ],
              { headers: { "content-type": "application/json" } },
            );
          else value = { view: viewId };
          return new Response(JSON.stringify(value), {
            headers: { "content-type": "application/json" },
          });
        }) as typeof fetch;
      };
      const evaluate = async (
        snap: ReturnType<typeof buildSnapshot>,
        viewId: string,
      ) => {
        serve(snap, viewId);
        try {
          const store = new LocalStore(
            `inert-${snap.snapshot.slice(7, 19)}-${Date.now()}`,
          );
          const inventory = await syncRecords(store);
          const records = await loadRecords(store, inventory);
          const session = core.evaluateSession({
            events: records.events,
            bodies: records.bodies,
            selected_view: viewId,
            import_selections: records.selections,
          });
          const ranking = session.rankWord(cuktaWord);
          session.free();
          const stored = await store.get("records", inert.envelope.id);
          return {
            scores: ranking.scores.map((s: any) => [
              s.target,
              s.net,
              s.direct_reviewers,
            ]),
            layers: ranking.layers,
            inertStatus: stored?.bodyStatus ?? null,
          };
        } finally {
          globalThis.fetch = saved;
        }
      };
      const serverWord = await (
        await fetch(
          `/api/v1/words/${encodeURIComponent(cuktaWord)}?snapshot=${encodeURIComponent(server.snapshot)}`,
        )
      ).json();
      const withInert = await evaluate(buildSnapshot([inert]), serverWord.view);
      const judgeCleared = await evaluate(
        buildSnapshot([view, bless, clear]),
        view.envelope.id,
      );
      const judgeMalformed = await evaluate(
        buildSnapshot([view, bless, malformed]),
        view.envelope.id,
      );
      const judgeBlessed = await evaluate(
        buildSnapshot([view, bless]),
        view.envelope.id,
      );
      return {
        inertAdmission: admission(inert).body_status,
        malformedAdmission: {
          action: admission(malformed).action_valid,
          body: admission(malformed).body_status,
        },
        inertStatus: withInert.inertStatus,
        localScores: withInert.scores,
        serverScores: serverWord.scores.map((s: any) => [
          s.target,
          s.net,
          s.direct_reviewers,
        ]),
        localLayers: withInert.layers,
        serverLayers: serverWord.layers,
        cleared: judgeCleared.scores.find((s: any) => s[0] === cukta1),
        malformed: judgeMalformed.scores.find((s: any) => s[0] === cukta1),
        blessed: judgeBlessed.scores.find((s: any) => s[0] === cukta1),
      };
    },
    { corePath, cuktaWord: f.words.cukta, cukta1: f.definitions.cukta1 },
  );
  expect(result.inertAdmission).toBe("invalid");
  expect(result.malformedAdmission).toEqual({ action: true, body: "invalid" });
  // The inert record is cached with its authenticated bytes and the calculation still runs and matches the server.
  expect(result.inertStatus).toBe("invalid");
  expect(result.localScores).toEqual(result.serverScores);
  expect(result.localLayers).toEqual(result.serverLayers);
  // The root's bless counts and the clear supersedes it. A clear whose
  // explanation body is invalid still clears: the malformed body cannot
  // restore the superseded bless, and it cannot disable the calculation.
  expect(result.blessed[2]).toBe(result.cleared[2] + 1);
  expect(result.blessed[1]).not.toEqual(result.cleared[1]);
  expect(result.malformed).toEqual(result.cleared);
});

test("the personal view refuses a calculation from another snapshot and offers a recompute for this snapshot", async ({
  page,
}) => {
  await createIdentity(page);
  await choosePersonal(page);
  await openWord(page, "cukta");
  const panel = page.getByRole("region", { name: "Personal view" });
  await expect(panel).toContainText(/Personal view calculated in this browser/);
  await expect(firstScore(page)).toHaveAttribute(
    "aria-label",
    /in your personal view$/,
  );
  // A new signed judgment moves the server to a newer snapshot. The judged
  // word is outside the exact-count fixtures, so test order does not matter.
  await openWord(page, "vlacku");
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toHaveText(
    "Your endorsement is published.",
  );
  // The next word page shows the newer snapshot. The old calculation is not shown beside it.
  // The word is fetched fresh, past the short response cache, inside the app.
  await page.evaluate(() => {
    const anchor = document.createElement("a");
    anchor.href = "/word/cukta?fresh=1";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  });
  await expect(page).toHaveTitle("cukta · jbovlacku");
  await expect(
    page.getByText(
      /Personal scores are unavailable: The local calculation is for snapshot .* but this content is from snapshot/,
    ),
  ).toBeVisible();
  await expect(firstScore(page)).toHaveAttribute(
    "aria-label",
    "Score unavailable in the personal view",
  );
  await expect(
    page.getByText(
      "personal scores unavailable: the local calculation is for another snapshot",
    ),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Recompute for this snapshot" })
    .click();
  await expect(firstScore(page)).toHaveAttribute(
    "aria-label",
    /in your personal view$/,
  );
  // The own endorsement now counts on the judged word.
  await openWord(page, "vlacku");
  const judged = page.locator("article.definition").first();
  await expect(judged.getByRole("img")).toHaveAttribute(
    "aria-label",
    /: 1 for, .*in your personal view$/,
  );
  await expect(judged.getByRole("button", { name: "Endorse" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // Search rows follow the same rule. Another judgment makes the calculation stale again.
  await judged.getByRole("button", { name: "Endorse" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Your judgment is cleared.",
  );
  // Ordinary search can serve the previous completed snapshot during evaluation.
  // Wait for this clear before checking that the cached calculation is stale.
  await page.evaluate(async () => {
    const { getManifest } = await import(String("/src/data/api.ts"));
    await getManifest({ fresh: true });
  });
  await page.getByLabel("Search words and meanings").fill("book");
  await page.getByLabel("Search words and meanings").press("Enter");
  const results = page.getByRole("region", { name: "Search results" });
  const row = results.locator("article").first();
  const unavailable = row.getByRole("img", {
    name: "Score unavailable in the personal view",
  });
  await expect(unavailable).toBeVisible();
  await expect(unavailable).toHaveAttribute(
    "title",
    /The local calculation is for snapshot .* but this content is from snapshot/,
  );
  const searchPanel = page.getByRole("region", { name: "Personal view" });
  await searchPanel
    .getByRole("button", { name: "Recompute from records" })
    .click();
  await expect(
    results
      .locator("article")
      .first()
      .getByRole("img", { name: /in your personal view$/ }),
  ).toBeVisible();
});

test("cancel during record loading never lets the old run touch the new calculation, and a failed shared load does not answer another mode", async ({
  page,
}) => {
  await page.goto("/");
  // Deterministic through the module. Records reads of the first run wait on a gate.
  const outcome = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { PersonalCalculator } = await import(
      String("/src/data/personal.ts")
    );
    const store = new LocalStore();
    const original = store.get.bind(store);
    let holds = 1;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    store.get = async (name: string, id: string) => {
      if (name === "records" && holds > 0) {
        holds--;
        await gate;
      }
      return original(name, id);
    };
    const calc = new PersonalCalculator(store, async () => ({
      identity: null,
      shuns: [],
    }));
    const states: string[] = [];
    calc.subscribe((status: any) => states.push(status.state));
    const first = calc.ensure({ mode: "personal" });
    // Wait until the first run is inside record loading.
    while (holds > 0) await new Promise((r) => setTimeout(r, 20));
    calc.cancel();
    const afterCancel = calc.status.state;
    const automatic = await calc.ensure({ mode: "personal" });
    const second = await calc.ensure({ mode: "personal", refresh: true });
    const marker = states.length;
    release();
    const firstResult = await first;
    await new Promise((r) => setTimeout(r, 300));
    const ranking = await calc.rankWord("jvw1:" + "0".repeat(64), {
      mode: "personal",
    });
    return {
      afterCancel,
      automatic: automatic.state + ":" + (automatic as any).kind,
      second: second.state,
      firstResult: firstResult.state + ":" + (firstResult as any).kind,
      statesAfterRelease: states.slice(marker),
      finalState: calc.status.state,
      finalSnapshot: (calc.status as any).snapshot,
      rankingSnapshot: ranking.snapshot,
    };
  });
  expect(outcome.afterCancel).toBe("failed");
  expect(outcome.automatic).toBe("failed:cancelled");
  expect(outcome.second).toBe("ready");
  expect(outcome.firstResult).toBe("failed:cancelled");
  expect(outcome.statesAfterRelease).toEqual([]);
  expect(outcome.finalState).toBe("ready");
  expect(outcome.rankingSnapshot).toBe(outcome.finalSnapshot);
  // A shared load that fails answers only its own request. A waiting request for another mode runs its own load.
  let failures = 1;
  await page.route("**/api/v1/inventory?*", (route) => {
    if (failures > 0) {
      failures--;
      return route.fulfill({ status: 500, body: "broken" });
    }
    return route.continue();
  });
  const shared = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { PersonalCalculator } = await import(
      String("/src/data/personal.ts")
    );
    const store = new LocalStore();
    await store.delete("inventory", "latest");
    const calc = new PersonalCalculator(store, async () => ({
      identity: null,
      shuns: [],
    }));
    const personal = calc.ensure({ mode: "personal", refresh: true });
    const site = calc.ensure({ mode: "site" });
    const [a, b] = await Promise.all([personal, site]);
    return { a: a.state, b: b.state + ":" + (b as any).mode };
  });
  expect(shared.a).toBe("failed");
  expect(shared.b).toBe("ready:site");
});

test("a calculation binds its digest to the one overlay it sends, and a choice change during record loading recomputes with the new choices", async ({
  page,
}) => {
  await page.goto("/");
  const outcome = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { PersonalCalculator, overlayDigest } = await import(
      String("/src/data/personal.ts")
    );
    const store = new LocalStore();
    // Every worker load is recorded. The real worker still evaluates.
    const loads: any[] = [];
    const RealWorker = window.Worker;
    class RecordingWorker extends RealWorker {
      postMessage(message: any, ...rest: any[]) {
        if (message.type === "load") loads.push(structuredClone(message));
        return super.postMessage(message, ...(rest as []));
      }
    }
    window.Worker = RecordingWorker as any;
    try {
      const originalOverlay = store.overlay.bind(store);
      const base = await originalOverlay();
      let work = 1000;
      let reads = 0;
      store.overlay = async () => {
        reads++;
        return { ...base, work };
      };
      const calc = new PersonalCalculator(store, async () => ({
        identity: null,
        shuns: [],
      }));
      // Part one: the choices change between any two reads. One read per run binds the digest.
      const first = await calc.ensure({ mode: "personal" });
      const firstLoad = loads.at(-1);
      const bound = {
        state: first.state,
        reads,
        matches:
          first.state === "ready" &&
          first.overlay === overlayDigest(firstLoad.input.overlay),
      };
      // Part two: the choices change while records load. The run is inert and the call recomputes.
      const originalGet = store.get.bind(store);
      let entered: () => void = () => {};
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => (entered = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      let hold = true;
      store.get = async (name: string, id: string) => {
        if (name === "records" && hold) {
          hold = false;
          entered();
          await gate;
        }
        return originalGet(name, id);
      };
      const loadsBefore = loads.length;
      calc.invalidate();
      const pending = calc.ensure({ mode: "personal" });
      await held;
      // A private choice changes. The app invalidates, as main.ts does.
      work = 2000;
      calc.invalidate();
      release();
      const result = await pending;
      const used = loads.at(-1);
      return {
        bound,
        result: result.state,
        loadsDuring: loads.length - loadsBefore,
        usedWork: used.input.overlay.work,
        matchesUsed:
          result.state === "ready" &&
          result.overlay === overlayDigest(used.input.overlay),
        finalState: calc.status.state,
      };
    } finally {
      window.Worker = RealWorker;
    }
  });
  expect(outcome.bound.state).toBe("ready");
  expect(outcome.bound.matches).toBe(true);
  expect(outcome.result).toBe("ready");
  expect(outcome.loadsDuring).toBe(1);
  expect(outcome.usedWork).toBe(2000);
  expect(outcome.matchesUsed).toBe(true);
  expect(outcome.finalState).toBe("ready");
});

test("cancel during the cache-reuse check does not restart the calculation, and an invalidation there recomputes once", async ({
  page,
}) => {
  await page.goto("/");
  const outcome = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { PersonalCalculator } = await import(
      String("/src/data/personal.ts")
    );
    const store = new LocalStore();
    const calc = new PersonalCalculator(store, async () => ({
      identity: null,
      shuns: [],
    }));
    await calc.ensure({ mode: "personal" });
    const originalGet = store.get.bind(store);
    const holdOnce = () => {
      let entered: () => void = () => {};
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => (entered = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      let hold = true;
      store.get = async (name: string, id: string) => {
        if (name === "inventory" && id === "latest" && hold) {
          hold = false;
          entered();
          await gate;
        }
        return originalGet(name, id);
      };
      return { held, release: () => release() };
    };
    const states: string[] = [];
    calc.subscribe((status: any) =>
      states.push(status.state + ":" + (status.kind ?? "")),
    );
    // Cancel while the ready calculator reads the cached inventory.
    const one = holdOnce();
    const pending = calc.ensure({ mode: "personal" });
    await one.held;
    calc.cancel();
    const marker = states.length;
    one.release();
    const result = await pending;
    const afterCancel = {
      result: result.state + ":" + (result as any).kind,
      statesAfterCancel: states.slice(marker),
      finalState: calc.status.state,
    };
    // An explicit recompute is still available.
    const again = await calc.ensure({ mode: "personal", refresh: true });
    // Invalidate while the ready calculator reads the cached inventory. One recompute follows.
    const two = holdOnce();
    const marker2 = states.length;
    const pending2 = calc.ensure({ mode: "personal" });
    await two.held;
    calc.invalidate();
    two.release();
    const result2 = await pending2;
    return {
      afterCancel,
      again: again.state,
      afterInvalidate: {
        result: result2.state,
        states: states.slice(marker2),
      },
    };
  });
  expect(outcome.afterCancel.result).toBe("failed:cancelled");
  expect(outcome.afterCancel.statesAfterCancel).toEqual([]);
  expect(outcome.afterCancel.finalState).toBe("failed");
  expect(outcome.again).toBe("ready");
  expect(outcome.afterInvalidate.result).toBe("ready");
  expect(outcome.afterInvalidate.states).toEqual([
    "idle:",
    "evaluating:",
    "ready:",
  ]);
});

/** A disposable calculator over its own store, with every worker load recorded. */
const calculatorHarness = `async (corePath) => {
  const core = await import(corePath);
  await core.initializeCore();
  const { LocalStore } = await import("/src/data/store.ts");
  const { PersonalCalculator, overlayDigest } = await import("/src/data/personal.ts");
  const store = new LocalStore("calculator-test-" + crypto.randomUUID());
  const loads = [];
  const RealWorker = window.Worker;
  class RecordingWorker extends RealWorker {
    postMessage(message, ...rest) {
      if (message.type === "load") loads.push(structuredClone(message));
      return super.postMessage(message, ...rest);
    }
  }
  window.Worker = RecordingWorker;
  const context = { identity: null, shuns: [] };
  const calc = new PersonalCalculator(store, async () => ({ ...context }));
  // The app's own invalidation paths: an overlay write and a session change.
  store.onOverlayChange = () => calc.invalidate();
  const originalOverlay = store.overlay.bind(store);
  let reads = 0;
  store.overlay = async () => { reads++; return originalOverlay(); };
  const originalGet = store.get.bind(store);
  const gateRead = (name, id) => {
    let entered, release;
    const held = new Promise((r) => (entered = r));
    const gate = new Promise((r) => (release = r));
    let hold = true;
    store.get = async (n, i) => {
      if (n === name && (id === null || i === id) && hold) { hold = false; entered(); await gate; }
      return originalGet(n, i);
    };
    return { held, release: () => release() };
  };
  const net = async (word, target) => {
    const ranking = await calc.rankWord(word, { mode: "personal" });
    const score = ranking.scores.find((s) => s.target === target);
    return score ? score.net[0].numerator : null;
  };
  return { store, calc, loads, context, overlayDigest, gateRead, net, reads: () => reads, restore: () => { window.Worker = RealWorker; } };
}`;
const allScope = { kind: "*", word: "*", language: "*" };

test("a private Ignore or an identity change during record loading reaches the worker with its digest, and every waiter gets the new context", async ({
  page,
}) => {
  const f = fixture();
  await page.goto("/");
  const outcome = await page.evaluate(
    async ({ harness, corePath, cuktaWord, cukta1, curator, allScope }) => {
      const h = await new Function("return " + harness)()(corePath);
      try {
        // One run reads the private choices once.
        const first = await h.calc.ensure({ mode: "personal" });
        const readsForFirstRun = h.reads();
        const before = await h.net(cuktaWord, cukta1);
        // Part one: a private Ignore of the seeded curator lands while records load.
        const one = h.gateRead("records", null);
        h.calc.invalidate();
        const waiterA = h.calc.ensure({ mode: "personal" });
        await one.held;
        const waiterB = h.calc.ensure({ mode: "personal" });
        const loadsBefore = h.loads.length;
        const overlay = await h.store.overlay();
        await h.store.setOverlay({
          ...overlay,
          blocked: [{ identity: curator, scope: allScope }],
        });
        one.release();
        const [a, b] = await Promise.all([waiterA, waiterB]);
        const used = h.loads.at(-1);
        const afterIgnore = {
          a: a.state,
          b: b.state,
          sameDigest: a.overlay === b.overlay,
          loadsDuring: h.loads.length - loadsBefore,
          blockedInInput: used.input.overlay.blocked.some(
            (e: any) => e.identity === curator,
          ),
          digestMatches: a.overlay === h.overlayDigest(used.input.overlay),
          oldDigestGone: a.overlay !== first.overlay,
          statusMatches: h.calc.status.overlay === a.overlay,
          score: await h.net(cuktaWord, cukta1),
        };
        // Part two: the active identity changes while records load.
        const identity = "ed25519:" + "7".repeat(64);
        const two = h.gateRead("records", null);
        h.calc.invalidate();
        const waiterC = h.calc.ensure({ mode: "personal" });
        await two.held;
        const loadsBefore2 = h.loads.length;
        h.context.identity = identity;
        h.calc.invalidate();
        two.release();
        const c = await waiterC;
        const used2 = h.loads.at(-1);
        const afterIdentity = {
          c: c.state,
          loadsDuring: h.loads.length - loadsBefore2,
          rootInInput: used2.input.overlay.root_changes.some(
            (r: any) => r.identity === identity && r.q.numerator === 1,
          ),
          digestMatches: c.overlay === h.overlayDigest(used2.input.overlay),
          differsFromIgnoreRun: c.overlay !== a.overlay,
          statusMatches: h.calc.status.overlay === c.overlay,
        };
        return { readsForFirstRun, before, afterIgnore, afterIdentity };
      } finally {
        h.restore();
      }
    },
    {
      harness: calculatorHarness,
      corePath,
      cuktaWord: f.words.cukta,
      cukta1: f.definitions.cukta1,
      curator: f.identities.curator,
      allScope,
    },
  );
  expect(outcome.readsForFirstRun).toBe(1);
  expect(outcome.before).toBe("6");
  expect(outcome.afterIgnore).toEqual({
    a: "ready",
    b: "ready",
    sameDigest: true,
    loadsDuring: 1,
    blockedInInput: true,
    digestMatches: true,
    oldDigestGone: true,
    statusMatches: true,
    score: "0",
  });
  expect(outcome.afterIdentity).toEqual({
    c: "ready",
    loadsDuring: 1,
    rootInInput: true,
    digestMatches: true,
    differsFromIgnoreRun: true,
    statusMatches: true,
  });
});

test("an old ready-state reuse check released after a newer calculation leaves that calculation untouched", async ({
  page,
}) => {
  const f = fixture();
  await page.goto("/");
  const outcome = await page.evaluate(
    async ({ harness, corePath, cuktaWord, cukta1, curator, allScope }) => {
      const h = await new Function("return " + harness)()(corePath);
      try {
        const initial = await h.calc.ensure({ mode: "personal" });
        if (initial.state !== "ready")
          throw new Error(
            `The reuse test needs a ready calculation: ${JSON.stringify(initial)}`,
          );
        // The old call waits inside the reuse check.
        const hold = h.gateRead("inventory", "latest");
        const old = h.calc.ensure({ mode: "personal" });
        await hold.held;
        // A newer calculation for changed choices completes meanwhile.
        const overlay = await h.store.overlay();
        await h.store.setOverlay({
          ...overlay,
          blocked: [{ identity: curator, scope: allScope }],
        });
        const newer = await h.calc.ensure({ mode: "personal", refresh: true });
        const newerScore = await h.net(cuktaWord, cukta1);
        const generation = h.calc.generation;
        const loads = h.loads.length;
        hold.release();
        const oldResult = await old;
        return {
          newer: newer.state,
          oldResult: oldResult.state,
          sameDigest: oldResult.overlay === newer.overlay,
          generationUnchanged: h.calc.generation === generation,
          snapshotUnchanged: h.calc.status.snapshot === newer.snapshot,
          digestUnchanged: h.calc.status.overlay === newer.overlay,
          loadsAfter: h.loads.length - loads,
          scoreUnchanged: (await h.net(cuktaWord, cukta1)) === newerScore,
          newerScore,
        };
      } finally {
        h.restore();
      }
    },
    {
      harness: calculatorHarness,
      corePath,
      cuktaWord: f.words.cukta,
      cukta1: f.definitions.cukta1,
      curator: f.identities.curator,
      allScope,
    },
  );
  expect(outcome).toEqual({
    newer: "ready",
    oldResult: "ready",
    sameDigest: true,
    generationUnchanged: true,
    snapshotUnchanged: true,
    digestUnchanged: true,
    loadsAfter: 0,
    scoreUnchanged: true,
    newerScore: "0",
  });
});

test("the Personal view panel completes with available scores when the snapshot holds a record the schema cannot interpret", async ({
  page,
}) => {
  await page.goto("/trust");
  await page
    .getByRole("radio", { name: "Mine: site view + my choices" })
    .check();
  await expect(
    page.getByRole("link", { name: "Trust: personal view" }),
  ).toBeVisible();
  // A synthetic snapshot: the server's records plus one authenticated record with an unknown action.
  const synthetic = await page.evaluate(
    async ({ corePath }) => {
      const core = await import(corePath);
      await core.initializeCore();
      const canon = (value: unknown) =>
        core.canonicalize(core.utf8(JSON.stringify(value)));
      const hash = (value: unknown) =>
        core.contentHash(core.utf8(canon(value)));
      const saved = globalThis.fetch;
      const server = await (await saved("/api/v1/manifest")).json();
      const base = (
        await (
          await saved(
            `/api/v1/records?snapshot=${encodeURIComponent(server.snapshot)}&limit=200`,
          )
        ).json()
      ).items as { id: string; envelope: any; body: unknown }[];
      const selectionsIds = (
        await (
          await saved(
            `/api/v1/inventory?kind=import_selections&snapshot=${encodeURIComponent(server.snapshot)}`,
          )
        ).json()
      ).ids as string[];
      const stranger = new Uint8Array(32).fill(205);
      const body = { future: "data" };
      const envelope = core.signHeader(stranger, {
        version: 1,
        issuer: core.identityFromSeed(stranger),
        previous: [],
        nonce: "f".repeat(32),
        action: { kind: "future.unknown" },
        content: { hash: hash(body), bytes: core.utf8(canon(body)).length },
      });
      const items = [...base, { id: envelope.id, envelope, body }].sort(
        (x, y) => (x.id < y.id ? -1 : 1),
      );
      const events = items.map((i) => i.id);
      const bodies = [
        ...new Set(
          items
            .filter((i) => i.envelope.header.content)
            .map((i) => i.envelope.header.content.hash),
        ),
      ].sort();
      const manifest = {
        version: 1,
        events: {
          count: events.length,
          hash: core.contentHash(
            core.utf8(items.map((i) => canon(i.envelope) + "\n").join("")),
          ),
        },
        bodies: { count: bodies.length, hash: hash(bodies) },
        import_selections: {
          count: selectionsIds.length,
          hash: hash(selectionsIds),
        },
      };
      const snapshot = hash(manifest);
      const logical = hash({
        events,
        bodies,
        import_selections: selectionsIds,
      });
      const zeroWord = "/words/jvw1:" + "0".repeat(64);
      // The page's own requests see the synthetic snapshot. Word responses are bound to it.
      globalThis.fetch = (async (input: any, init?: any) => {
        const url = new URL(
          String(input instanceof Request ? input.url : input),
          location.origin,
        );
        const json = (value: unknown) =>
          new Response(JSON.stringify(value), {
            headers: { "content-type": "application/json" },
          });
        // Any other request that names the synthetic snapshot asks the server for its own snapshot.
        const toServer = () => {
          if (url.searchParams.get("snapshot") === snapshot)
            url.searchParams.set("snapshot", server.snapshot);
          return saved(url.href, init);
        };
        if (url.pathname.endsWith("/manifest"))
          return json({
            snapshot,
            logical_inventory: logical,
            manifest,
            accepted_cursor: "x.1",
            materialized_cursor: "x.1",
            packages: [],
          });
        if (url.pathname.endsWith("/inventory")) {
          const kind = url.searchParams.get("kind")!;
          return json({
            snapshot,
            kind,
            ids: { events, bodies, import_selections: selectionsIds }[kind],
            next: null,
          });
        }
        if (url.pathname.endsWith("/records"))
          return json({
            snapshot,
            logical_inventory: logical,
            items,
            next: null,
          });
        if (url.pathname.includes(zeroWord)) {
          const real = await (await toServer()).json();
          return json({ view: real.view });
        }
        if (url.pathname.includes("/words/")) {
          const real = await (
            await saved(
              `/api/v1${url.pathname.slice(url.pathname.indexOf("/words/"))}?snapshot=${encodeURIComponent(server.snapshot)}`,
            )
          ).json();
          return json({ ...real, snapshot, logical_inventory: logical });
        }
        return toServer();
      }) as typeof fetch;
      return { snapshot, inert: envelope.id, events: events.length };
    },
    { corePath },
  );
  await openWord(page, "cukta");
  const panel = page.getByRole("region", { name: "Personal view" });
  await expect(panel).toContainText(
    `Personal view calculated in this browser from ${synthetic.events} verified records of snapshot ${synthetic.snapshot.slice(7, 19)}`,
  );
  await expect(panel).not.toContainText("The evaluation reports");
  await expect(firstScore(page)).toHaveAttribute(
    "aria-label",
    /^Score 6: 6 for, 0 against, \d+ reviewers?, in your personal view$/,
  );
  await expect(page.getByText(/Personal scores are unavailable/)).toHaveCount(
    0,
  );
  const stored = await page.evaluate(async (id) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const record = await new LocalStore().get("records", id);
    return record?.bodyStatus ?? null;
  }, synthetic.inert);
  expect(stored).toBe("invalid");
});

test("the breakdown follows both root routes to one reviewer, and a privately blocked reviewer is labeled blocked", async ({
  page,
}) => {
  const f = fixture();
  const short = (identity: string) =>
    identity.slice(8, 12) + "…" + identity.slice(-4);
  await page.goto("/word/cukta");
  const first = page.locator("article.definition").first();
  await first.getByText(/^\d+ reviewers?$/).click();
  const curatorRow = first.locator("tbody tr", {
    has: page.getByRole("link", { name: short(f.identities.curator) }),
  });
  // Both roots heed the curator. The route cell names both and says that several routes contribute.
  await expect(curatorRow).toContainText("trusted by 2 identities, including");
  await expect(
    curatorRow.getByRole("link", { name: short(f.identities.rootA) }),
  ).toBeVisible();
  await expect(
    curatorRow.getByRole("link", { name: short(f.identities.rootB) }),
  ).toBeVisible();
  await expect(curatorRow).toContainText("several routes contribute");
  await expect(curatorRow).toContainText("endorses");
  // Each root link leads to that root's identity page.
  const rootLink = (identity: string) =>
    curatorRow.getByRole("link", { name: short(identity) });
  await expect(rootLink(f.identities.rootA)).toHaveAttribute(
    "href",
    `/identity/${encodeURIComponent(f.identities.rootA)}`,
  );
  await expect(rootLink(f.identities.rootB)).toHaveAttribute(
    "href",
    `/identity/${encodeURIComponent(f.identities.rootB)}`,
  );
  await rootLink(f.identities.rootB).click();
  await expect(page).toHaveURL(
    new RegExp(`/identity/${f.identities.rootB.replace(":", "%3A")}$`),
  );
  await expect(
    page.getByText(fingerprintText(f.identities.rootB), { exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveTitle("cukta · jbovlacku");
  // A private Ignore in the personal view labels the same reviewer as blocked by that choice.
  await choosePersonal(page);
  await ignorePrivately(page, f.identities.curator);
  // The private block names the curator for every scope.
  expect(
    await page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      return (await new LocalStore().overlay()).blocked;
    }),
  ).toEqual([
    {
      identity: f.identities.curator,
      scope: { kind: "*", word: "*", language: "*" },
    },
  ]);
  await openWord(page, "cukta");
  // The order changes with the choice. The curator's definition is found by its link.
  const curated = page.locator("article.definition", {
    has: page.locator(
      `a[href="/definition/${encodeURIComponent(f.definitions.cukta1)}"]`,
    ),
  });
  await expect(curated.getByRole("img")).toHaveAttribute(
    "aria-label",
    /^Score 0.*in your personal view$/,
  );
  const details = curated.locator("details.judgment-details");
  await details.locator("summary").click();
  const blockedRow = details.locator("tbody tr", {
    has: page.getByRole("link", { name: short(f.identities.curator) }),
  });
  await expect(blockedRow).toContainText("blocked by your private choice");
  await expect(blockedRow).toContainText("+0");
  await expect(blockedRow).not.toContainText("trusted by");
  await expect(details).not.toContainText("No judgments yet.");
  // The delegate's route ran through the blocked curator. It is gone in this view.
  const delegated = page.locator("article.definition", {
    has: page.locator(
      `a[href="/definition/${encodeURIComponent(f.definitions.cukta2)}"]`,
    ),
  });
  const delegatedDetails = delegated.locator("details.judgment-details");
  await delegatedDetails.locator("summary").click();
  await expect(
    delegatedDetails.locator("tbody tr", {
      has: page.getByRole("link", { name: short(f.identities.delegate) }),
    }),
  ).toContainText("no route in this view");
});

test("a restored key with no local history in offline signing shows unknown evidence instead of a known absence", async ({
  page,
  browser,
}) => {
  const backup = await createIdentity(page);
  // One judgment from the original browser, so the server holds history for this key.
  await openWord(page, "vlacku");
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toHaveText(
    "Your endorsement is published.",
  );
  const context = await browser.newContext();
  const restored = await context.newPage();
  await restored.goto("/identity");
  await restored.getByLabel("Backup file").setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await restored.getByLabel("Backup passphrase").fill(PASSPHRASE);
  await restored.getByRole("button", { name: "Open backup locally" }).click();
  await expect(restored.getByText("Unlocked", { exact: true })).toBeVisible();
  await restored.getByText("Offline signing", { exact: true }).click();
  await restored
    .getByLabel("Sign from history saved in this browser only")
    .check();
  await openWord(restored, "vlacku");
  const control = restored.locator("article.definition").first();
  // The local history is empty. Offline, that proves nothing about the server's history.
  await expect(control.getByRole("button", { name: "Endorse" })).toBeVisible();
  await expect(
    control.getByRole("button", { name: "Endorse" }),
  ).not.toHaveAttribute("aria-pressed", /.*/);
  await expect(
    control.getByRole("button", { name: "Oppose" }),
  ).not.toHaveAttribute("aria-pressed", /.*/);
  await expect(
    control.getByText("Your judgment is unknown here"),
  ).toBeVisible();
  // With a connection the authenticated history shows the endorsement.
  await restored.goto("/identity");
  await restored.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
  await restored.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(restored.getByText("Unlocked", { exact: true })).toBeVisible();
  await openWord(restored, "vlacku");
  await expect(
    restored
      .locator("article.definition")
      .first()
      .getByRole("button", { name: "Endorse" }),
  ).toHaveAttribute("aria-pressed", "true");
  await context.close();
});
