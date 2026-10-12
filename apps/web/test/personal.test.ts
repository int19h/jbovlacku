import { test, expect, type Page } from "@playwright/test";
import {
  acceptFirstSignature,
  createIdentity,
  fixture,
  openWord,
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
  await page.goto("/word/cukta");
  await expect(firstScore(page)).toHaveAttribute("aria-label", /^Score 6/);
  const site = await scores(page);
  expect(site[0]).toMatch(/^Score 6/);
  await choosePersonal(page);
  await openWord(page, "cukta");
  const panel = page.getByRole("region", { name: "Personal view" });
  await expect(panel).toContainText(
    /Personal view calculated in this browser from \d+ verified records/,
  );
  await expect(firstScore(page)).toHaveAttribute(
    "aria-label",
    /^Score 6.*in your personal view$/,
  );
  // Without private choices the personal scores equal the site scores.
  expect(
    (await scores(page)).map((s) => s?.replace(/, in your personal view$/, "")),
  ).toEqual(site);
  await ignorePrivately(page, f.identities.curator);
  await openWord(page, "cukta");
  await expect(firstScore(page)).toHaveAttribute(
    "aria-label",
    /^Score 0: 0 for, 0 against, 1 reviewer, in your personal view$/,
  );
  // The breakdown lists the ignored reviewer without a route and comes from the local calculation.
  const details = page
    .locator("article.definition details.judgment-details")
    .first();
  await details.locator("summary").click();
  await expect(details).toContainText("no route in this view");
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
  await expect(firstScore(page)).toHaveAttribute("aria-label", /^Score 6/);
  await expect(firstScore(page)).not.toHaveAttribute("aria-label", /personal/);
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
  await expect(page.getByRole("status").last()).toContainText(
    /The local calculation from \d+ verified records matches the server's \d+ scores and layers for this word\./,
  );
  await expect(
    page.getByRole("region", { name: "Local calculation" }),
  ).toContainText(/Site view calculated in this browser/);
});

test("the personal view adds the signing identity as a root so its own endorsement counts after a refresh", async ({
  page,
}) => {
  await createIdentity(page);
  await choosePersonal(page);
  await openWord(page, "cukta");
  const third = page.locator("article.definition", {
    hasText: "Third meaning",
  });
  await expect(third.getByRole("img")).toHaveAttribute(
    "aria-label",
    /^Score minus 3: 0 for, 3 against, 2 reviewers, in your personal view$/,
  );
  await third.getByRole("button", { name: "Endorse" }).click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toHaveText(
    "Your endorsement is published.",
  );
  // The delivered endorsement is in a newer snapshot. The local calculation names the snapshot it used until a refresh.
  await page
    .getByRole("region", { name: "Personal view" })
    .getByRole("button", { name: "Recompute from records" })
    .click();
  await expect(
    page
      .locator("article.definition", { hasText: "Third meaning" })
      .getByRole("img"),
  ).toHaveAttribute("aria-label", /3 reviewers, in your personal view$/);
  const details = page
    .locator("article.definition", { hasText: "Third meaning" })
    .locator("details.judgment-details");
  await details.locator("summary").click();
  await expect(details).toContainText("root of the view (q=1)");
});
