import { test, expect, type Page } from "@playwright/test";
import {
  acceptFirstSignature,
  corePath,
  createIdentity,
  fixture,
  PASSPHRASE,
} from "./helpers.ts";

/** Chooses a signed view by its event ID on the Trust page. */
async function useView(page: Page, id: string | null) {
  await page.goto("/trust");
  if (id === null) {
    await page
      .getByRole("button", { name: "Back to the server's view" })
      .click();
    await expect(page.locator("main")).toContainText("Selected by this server");
    return;
  }
  await page.getByLabel("Signed view event ID").fill(id);
  await page.getByRole("button", { name: "Use this view" }).click();
  // The page shows the chosen ID only after the preference is saved.
  await expect(page.locator("main")).toContainText(`Signed view in use: ${id}`);
  await expect(page.locator("main")).toContainText(
    "Chosen by you by its event ID",
  );
}
async function choosePersonal(page: Page) {
  await page.goto("/trust");
  await page
    .getByRole("radio", { name: "Mine: site view + my choices" })
    .check();
  await expect(
    page.getByRole("link", { name: "Trust: personal view" }),
  ).toBeVisible();
}
/** The score control of the dunda definition whose text starts as given. */
const score = (page: Page, text: string) =>
  page.locator("article.definition", { hasText: text }).getByRole("img");
/** The server's ranking of dunda under a view, as the page's data layer reads it. */
async function serverWeights(page: Page, wordId: string, view: string) {
  return page.evaluate(
    async ({ wordId, view }) => {
      const { getWord } = await import(String("/src/data/api.ts"));
      const word = await getWord(wordId, {
        view,
        reviewers: true,
        fresh: true,
      });
      return {
        algorithm: word.calculation?.algorithm,
        exact: word.calculation?.exact,
        scores: Object.fromEntries(
          word.scores.map((s: any) => [
            s.target,
            {
              net: `${s.net[0].numerator}/${s.net[0].denominator}`,
              reviewers: s.direct_reviewers,
              weights: Object.fromEntries(
                s.reviewers.map((r: any) => [
                  r.identity,
                  r.weight
                    ? `${r.weight[0].numerator}/${r.weight[0].denominator}`
                    : null,
                ]),
              ),
            },
          ]),
        ),
      };
    },
    { wordId, view },
  );
}

test("choosing a signed view changes the calculation profile, and the page shows the real result of each view", async ({
  page,
}) => {
  const f = fixture();
  await createIdentity(page);
  const shun = await serverWeights(page, f.words.dunda, f.views.shun);
  const bounds = await serverWeights(
    page,
    f.words.dunda,
    f.views.shunGraphBounds,
  );
  expect(shun.algorithm).toBe("simple-routes-shun-v1");
  expect(bounds.algorithm).toBe("simple-routes-bounds-v1");
  // The refusal profile gives less to the shunned routes, keeps the independent
  // route and the own allowance, and counts the zero-weight reviewer.
  const d1 = f.definitions.dunda1;
  expect(shun.scores[d1].weights[f.identities.outcast]).toBe("7/4");
  expect(bounds.scores[d1].weights[f.identities.outcast]).toBe("37/16");
  expect(shun.scores[d1].weights[f.identities.delegate2]).toBe("3/4");
  expect(bounds.scores[d1].weights[f.identities.delegate2]).toBe("9/4");
  expect(shun.scores[d1].weights[f.identities.loner]).toBe("0/1");
  expect(shun.scores[d1].reviewers).toBe(3);
  // The server's own view does not rank dunda: no root reaches its reviewers.
  await page.goto("/word/dunda");
  await expect(score(page, "Gives something")).toHaveAttribute(
    "aria-label",
    /^Score 0: 0 for, 0 against, 3 reviewers$/,
  );
  // Under the refusal view the page shows that view's result and its rule.
  await useView(page, f.views.shun);
  await expect(page.locator("main")).toContainText(
    "Calculation profile simple-routes-shun-v1: A public shun removes the issuer's own trust edge, and a route is refused",
  );
  await page.goto("/word/dunda");
  await expect(score(page, "Gives something")).toHaveAttribute(
    "title",
    new RegExp(`Exact value ${shun.scores[d1].net.replace("/1", "")}`),
  );
  await expect(score(page, "Gives something")).toHaveAttribute(
    "aria-label",
    /3 reviewers$/,
  );
  const details = page
    .locator("article.definition", { hasText: "Gives something" })
    .locator("details.judgment-details");
  await details.locator("summary").click();
  await expect(details).toContainText("Calculation simple-routes-shun-v1.");
  await expect(details).toContainText(
    "a route is refused where any earlier actor",
  );
  await expect(details).toContainText(
    "A reviewer with weight 0 still counts as a reviewer.",
  );
  await expect(details).toContainText(
    "Incoming trust lists public declarations.",
  );
  const reviewers = details.getByRole("region", { name: "Reviewers" });
  await expect(reviewers).toContainText("+7/4");
  await expect(reviewers).toContainText("+3/4");
  await expect(reviewers).toContainText("+0");
  // The same graph under the bounds profile shows that view's larger weights.
  await useView(page, f.views.shunGraphBounds);
  await page.goto("/word/dunda");
  await expect(score(page, "Gives something")).toHaveAttribute(
    "title",
    new RegExp(`Exact value ${bounds.scores[d1].net}`),
  );
  await details.locator("summary").click();
  await expect(details).toContainText("Calculation simple-routes-bounds-v1.");
  await expect(details).toContainText(
    "A public shun removes only the issuer's own trust edge.",
  );
  await expect(
    details.getByRole("region", { name: "Reviewers" }),
  ).toContainText("+37/16");
  // Back to the server's view: the cukta scores and the view bytes are untouched.
  await useView(page, null);
  await page.goto("/word/cukta");
  await expect(
    page.locator("article.definition").first().getByRole("img"),
  ).toHaveAttribute("aria-label", /^Score 6/);
  const unchanged = await page.evaluate(async (viewId) => {
    const { getManifest, loadRecord } = await import(
      String("/src/data/api.ts")
    );
    const manifest = await getManifest();
    const record = await loadRecord(viewId, manifest.snapshot);
    return { calculation: record.body.calculation, id: record.envelope.id };
  }, f.views.bounds);
  expect(unchanged).toEqual({
    calculation: "simple-routes-bounds-v1",
    id: f.views.bounds,
  });
});

test("the personal view follows the chosen profile, private blocks and own public shuns stay distinct, and a public clear leaves no refusal", async ({
  page,
}) => {
  const f = fixture();
  await createIdentity(page);
  await useView(page, f.views.shun);
  await choosePersonal(page);
  await page.goto("/word/dunda");
  const panel = page.getByRole("region", { name: "Personal view" });
  await expect(panel).toContainText(/Personal view calculated in this browser/);
  // The local calculation under the chosen view equals a direct core calculation
  // with the same overlay, which adds this identity as a root.
  const expected = await page.evaluate(
    async ({ corePath, view, wordId }) => {
      const core = await import(corePath);
      await core.initializeCore();
      const { loadRecords, syncRecords } = await import(
        String("/src/data/records.ts")
      );
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { effectiveOverlay } = await import(
        String("/src/data/personal.ts")
      );
      const store = new LocalStore();
      const inventory = await syncRecords(store);
      const records = await loadRecords(store, inventory);
      const identity = (await store.get("keys", "selected"))?.identity ?? null;
      const viewBody = JSON.parse(records.bodies[inventory.view]);
      const overlay = effectiveOverlay(
        await store.overlay(),
        view,
        { identity, shuns: [] },
        viewBody.roots.map((r: any) => r.identity),
      );
      const session = core.evaluateSession({
        events: records.events,
        bodies: records.bodies,
        selected_view: view,
        import_selections: records.selections,
        overlay,
      });
      const ranking = session.rankWord(wordId);
      session.free();
      return {
        view: inventory.view,
        algorithm: ranking.calculation.algorithm,
        nets: Object.fromEntries(
          ranking.scores.map((s: any) => [
            s.target,
            `${s.net[0].numerator}/${s.net[0].denominator}`,
          ]),
        ),
      };
    },
    { corePath, view: f.views.shun, wordId: f.words.dunda },
  );
  expect(expected.view).toBe(f.views.shun);
  expect(expected.algorithm).toBe("simple-routes-shun-v1");
  const d1 = f.definitions.dunda1;
  await expect(score(page, "Gives something")).toHaveAttribute(
    "title",
    new RegExp(
      `Exact value ${expected.nets[d1].replace("/1", "")}.*In your personal view`,
    ),
  );
  await expect(panel).toContainText(`snapshot`);
  // A private Ignore of curator2 removes every route through curator2 in the
  // personal view only. Outcast keeps D's route and its own allowance.
  await page.goto(`/identity/${encodeURIComponent(f.identities.curator2)}`);
  await page.getByRole("button", { name: "Ignore their judgments" }).click();
  await page.getByRole("radio", { name: /Just for me/ }).check();
  await page
    .getByRole("region", { name: /Ignore/ })
    .getByRole("button", { name: "Ignore", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Saved as a private block",
  );
  await page.goto("/word/dunda");
  const details = page
    .locator("article.definition", { hasText: "Gives something" })
    .locator("details.judgment-details");
  await details.locator("summary").click();
  const reviewers = details.getByRole("region", { name: "Reviewers" });
  await expect(reviewers).toContainText("+7/4");
  await expect(reviewers).toContainText("no route in this view");
  // The site view under the same signed view is unchanged by the private choice.
  const site = await serverWeights(page, f.words.dunda, f.views.shun);
  expect(site.scores[d1].weights[f.identities.delegate2]).toBe("3/4");
  // A public shun by this identity is a signed declaration. In the personal
  // view it is a block as well. The site view under the refusal profile has no
  // route through this identity, so it changes nothing there.
  await page.goto(`/identity/${encodeURIComponent(f.identities.scoped)}`);
  await page.getByRole("button", { name: "Ignore their judgments" }).click();
  await page.getByRole("radio", { name: /Publicly/ }).check();
  await page
    .getByRole("region", { name: /Ignore/ })
    .getByRole("button", { name: "Ignore", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: /Ignore publicly/ });
  await expect(dialog).toContainText("simple-routes-shun-v1");
  await expect(dialog).toContainText(
    "a route is refused where any earlier actor",
  );
  await expect(dialog).toContainText(
    "In your own personal view it also acts as a block.",
  );
  await dialog.getByRole("button", { name: "Ignore publicly" }).click();
  // The full page load locked the key, so signing asks for the passphrase first.
  const unlock = page.getByRole("dialog", { name: "Unlock your key" });
  await unlock.getByLabel("Passphrase").fill(PASSPHRASE);
  await unlock.getByRole("button", { name: "Unlock" }).click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toContainText(/Signed/);
  // Delivery runs after the signature. Wait until the server accepted the
  // shun, so the next page load and the recompute see one snapshot.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const { LocalStore } = await import(String("/src/data/store.ts"));
          const items = await new LocalStore().list("outbox");
          return items.map((item: any) => item.peers?.self?.state);
        }),
      { timeout: 20000 },
    )
    .toEqual(["accepted"]);
  await page.goto("/word/dunda");
  // The signed shun moved the snapshot. The personal view refuses the older
  // calculation until an explicit recompute, which includes the new record.
  await page
    .getByRole("button", { name: "Recompute for this snapshot" })
    .click();
  await expect(
    page.getByRole("region", { name: "Personal view" }),
  ).toContainText(/Personal view calculated in this browser/);
  const donate = page
    .locator("article.definition", { hasText: "Donates a gift" })
    .locator("details.judgment-details");
  // The recompute re-renders the page. Open the details of the rendered
  // element and read the breakdown of the same element.
  await expect(async () => {
    if ((await donate.getAttribute("open")) === null)
      await donate.locator("summary").click();
    expect(await donate.textContent()).toContain(
      "blocked in your personal view by your public shun",
    );
  }).toPass();
  const after = await serverWeights(page, f.words.dunda, f.views.shun);
  expect(after.scores[f.definitions.dunda2].weights[f.identities.scoped]).toBe(
    "3/16",
  );
});

test("an unknown profile or a resource failure leaves scores unavailable without another calculation, and the chosen view is isolated in the local cache", async ({
  page,
}) => {
  const f = fixture();
  await createIdentity(page);
  await useView(page, f.views.shun);
  await page.goto("/word/dunda");
  await expect(score(page, "Gives something")).toHaveAttribute(
    "title",
    /Exact value/,
  );
  // A response that names a profile this client does not know gives no score.
  await page.route("**/api/v1/words/**", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.calculation)
      body.calculation.algorithm = "simple-routes-future-v9";
    await route.fulfill({ response, json: body });
  });
  await page.goto("/word/dunda");
  await expect(score(page, "Gives something")).toHaveAttribute(
    "aria-label",
    "Score unavailable",
  );
  const details = page
    .locator("article.definition", { hasText: "Gives something" })
    .locator("details.judgment-details");
  await details.locator("summary").click();
  await expect(details).toContainText("Calculation simple-routes-future-v9.");
  await expect(details).toContainText(
    "This client does not know the route rule of this profile. Scores from it are not shown.",
  );
  await page.unroute("**/api/v1/words/**");
  // A resource failure reported by the server leaves scores unavailable.
  await page.route("**/api/v1/words/**", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.unavailable_scores = body.scores.map((s: any) => s.target);
    body.scores = [];
    body.calculation = null;
    await route.fulfill({ response, json: body });
  });
  await page.goto("/word/dunda");
  await expect(score(page, "Gives something")).toHaveAttribute(
    "aria-label",
    "Score unavailable",
  );
  await details.locator("summary").click();
  await expect(details).toContainText(
    "Ranking for this word is unavailable in this snapshot.",
  );
  await page.unroute("**/api/v1/words/**");
  // The local cache keys by view: a calculation for one view never answers for another.
  await choosePersonal(page);
  await page.goto("/word/dunda");
  await expect(
    page.getByRole("region", { name: "Personal view" }),
  ).toContainText(/calculated in this browser/);
  const underShun = await score(page, "Gives something").getAttribute("title");
  await useView(page, f.views.shunGraphBounds);
  await page.goto("/word/dunda");
  await expect(
    page.getByRole("region", { name: "Personal view" }),
  ).toContainText(/calculated in this browser/);
  const underBounds = await score(page, "Gives something").getAttribute(
    "title",
  );
  expect(underBounds).not.toBe(underShun);
  const states = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return (await new LocalStore().preferences()).view;
  });
  expect(states).toBe(f.views.shunGraphBounds);
});
