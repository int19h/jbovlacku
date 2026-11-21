import { test, expect, type Page } from "@playwright/test";
import { acceptFirstSignature, createIdentity, openWord } from "./helpers.ts";

const firstScore = (page: Page) =>
  page.locator("article.definition").first().getByRole("img");

async function choosePersonal(page: Page) {
  await page.getByRole("link", { name: /^Trust:/ }).click();
  await page
    .getByRole("radio", { name: "Mine: site view + my choices" })
    .check();
  await expect(
    page.getByRole("link", { name: "Trust: personal view" }),
  ).toBeVisible();
}

test("server search rows show rafsi, attribution, date, and notes from the search response", async ({
  page,
}) => {
  // The row fields come from the search response itself. Reads that used to
  // fill them per row are refused, so a row that still needs them stays empty.
  await page.route("**/api/v1/words/**", (route) => route.abort());
  await page.route("**/api/v1/events/**", (route) => route.abort());
  await page.route("**/api/v1/bodies/**", (route) => route.abort());
  await page.goto("/search?q=book&lang=en");
  const results = page.getByRole("region", { name: "Search results" });
  const cukta = results.locator("article").filter({
    has: page.getByRole("link", { name: "cukta", exact: true }),
  });
  await expect(cukta.locator(".rafsi")).toHaveText("cku");
  await expect(
    cukta.locator(".attribution-line a[href^='/identity/']"),
  ).toBeVisible();
  await expect(cukta.getByRole("link", { name: "notes" })).toBeVisible();
  // The imported definition is the only "library" gloss. A shared test
  // server can hold other definitions of the same word from other suites,
  // so this query keeps the imported row the preview.
  await page.goto("/search?q=library&lang=en");
  const imported = results.locator("article").filter({
    has: page.getByRole("link", { name: "ckusro", exact: true }),
  });
  await expect(imported.locator(".attribution-line")).toContainText("arj");
  await expect(imported.locator(".attribution-line")).toContainText("Mar 2003");
});

test("a server search page with an over-long preview field still shows the hit", async ({
  page,
}) => {
  // The format allows any selma'o length, so one signer's long name must
  // not cost the page. The browser drops the long name and keeps the row.
  await page.route("**/api/v1/words/**", (route) => route.abort());
  await page.route("**/api/v1/events/**", (route) => route.abort());
  await page.route("**/api/v1/bodies/**", (route) => route.abort());
  await page.route("**/api/v1/search?*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const hit of body.hits ?? [])
      if (hit.preview && hit.word?.spelling === "cukta") {
        hit.preview.selmaho = ["X".repeat(200), "BAI"];
        hit.preview.rafsi = ["r".repeat(200), ...(hit.preview.rafsi ?? [])];
      }
    await route.fulfill({ response, json: body });
  });
  await page.goto("/search?q=book&lang=en");
  const results = page.getByRole("region", { name: "Search results" });
  const cukta = results.locator("article").filter({
    has: page.getByRole("link", { name: "cukta", exact: true }),
  });
  await expect(cukta.locator(".rafsi")).toHaveText("cku");
  await expect(cukta.getByText("BAI", { exact: true })).toBeVisible();
  await expect(
    cukta.locator(".attribution-line a[href^='/identity/']"),
  ).toBeVisible();
  await expect(page.getByText(/invalid search page/)).toHaveCount(0);
});

test("a server row upgrades its attribution line from the signed record", async ({
  page,
}) => {
  // With the reads allowed, the imported author links to the source-account
  // evidence, as the row did before the preview carried the fields.
  await page.goto("/search?q=library&lang=en");
  const results = page.getByRole("region", { name: "Search results" });
  const imported = results.locator("article").filter({
    has: page.getByRole("link", { name: "ckusro", exact: true }),
  });
  const author = imported.locator(".attribution-line a", { hasText: "arj" });
  await expect(author).toHaveAttribute("href", /^https:\/\//);
  await expect(author).toHaveAttribute("title", /evidence/);
  await expect(imported.locator(".attribution-line")).toContainText("Mar 2003");
});

test("the preview date bound keeps the date label the row reads", async ({
  page,
}) => {
  // The row keeps the preview line, so the date comes from the bounded
  // preview dates. Nine labels exceed the bound of eight.
  await page.route("**/api/v1/words/**", (route) => route.abort());
  await page.route("**/api/v1/events/**", (route) => route.abort());
  await page.route("**/api/v1/bodies/**", (route) => route.abort());
  await page.route("**/api/v1/search?*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const hit of body.hits ?? [])
      if (hit.preview?.attribution && hit.word?.spelling === "ckusro")
        hit.preview.attribution.dates = {
          a: "1",
          b: "2",
          c: "3",
          created_at: "2020-01-15T12:00:00Z",
          d: "4",
          e: "5",
          f: "6",
          g: "7",
          time: "1000000000",
        };
    await route.fulfill({ response, json: body });
  });
  await page.goto("/search?q=library&lang=en");
  const results = page.getByRole("region", { name: "Search results" });
  const imported = results.locator("article").filter({
    has: page.getByRole("link", { name: "ckusro", exact: true }),
  });
  await expect(imported.locator(".attribution-line")).toContainText("arj");
  // The SQL time label wins over created_at, as on the definition page.
  await expect(imported.locator(".attribution-line")).toContainText("Sep 2001");
  await expect(imported.locator(".attribution-line")).not.toContainText(
    "Jan 2020",
  );
});

test("a stale personal calculation is not presented as this page's calculation", async ({
  page,
}) => {
  await createIdentity(page);
  await choosePersonal(page);
  await openWord(page, "cukta");
  const panel = page.getByRole("region", { name: "Personal view" });
  await expect(panel).toContainText(
    /Personal view calculated in this browser from \d+ verified records\./,
  );
  await expect(firstScore(page)).toHaveAttribute(
    "aria-label",
    /in your personal view$/,
  );
  // A new signed judgment moves the server to a newer snapshot.
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
  await page.evaluate(() => {
    const anchor = document.createElement("a");
    anchor.href = "/word/cukta?fresh=1";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  });
  await expect(page).toHaveTitle("cukta · jbovlacku");
  // Every part of the page now says the same thing: the ready calculation
  // belongs to another snapshot, and this page has no personal scores.
  await expect(
    page.getByText(
      /Personal scores are unavailable: The local calculation uses another snapshot or view/,
    ),
  ).toBeVisible();
  await expect(panel).toContainText(
    "Personal scores are unavailable for this snapshot.",
  );
  await expect(panel).not.toContainText(/verified records\./);
  await expect(firstScore(page)).toHaveAttribute(
    "aria-label",
    "Score unavailable in the personal view",
  );
  await page
    .getByRole("button", { name: "Recompute for this snapshot" })
    .click();
  await expect(firstScore(page)).toHaveAttribute(
    "aria-label",
    /in your personal view$/,
  );
  await expect(panel).toContainText(
    /Personal view calculated in this browser from \d+ verified records\./,
  );
  await expect(panel).not.toContainText("for another snapshot");
});

test("the unavailable note follows the latest calculation failure", async ({
  page,
}) => {
  await page.route("**/api/v1/inventory?*", (route) =>
    route.fulfill({ status: 500, body: "broken" }),
  );
  await page.goto("/trust");
  await page
    .getByRole("radio", { name: "Mine: site view + my choices" })
    .check();
  await openWord(page, "cukta");
  const panel = page.getByRole("region", { name: "Personal view" });
  const note = page.getByText(/Personal scores are unavailable:/);
  await expect(note).toContainText("Request failed (500).");
  // A retry that fails in a new way replaces the reason in both places.
  await page.unroute("**/api/v1/inventory?*");
  await page.route("**/api/v1/inventory?*", (route) => route.abort());
  await panel.getByRole("button", { name: "Recompute from records" }).click();
  await expect(panel).toContainText("No connection to the server.");
  await expect(note).toContainText("No connection to the server.");
  await expect(note).not.toContainText("Request failed (500).");
});

test("the recompute button keeps focus while the note follows the calculation", async ({
  page,
}) => {
  await createIdentity(page);
  await choosePersonal(page);
  await openWord(page, "cukta");
  const panel = page.getByRole("region", { name: "Personal view" });
  await expect(panel).toContainText(
    /Personal view calculated in this browser from \d+ verified records\./,
  );
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
  await page.evaluate(() => {
    const anchor = document.createElement("a");
    anchor.href = "/word/cukta?fresh=1";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  });
  await expect(page).toHaveTitle("cukta · jbovlacku");
  const recompute = page.getByRole("button", {
    name: "Recompute for this snapshot",
  });
  const note = page.getByText(/Personal scores are unavailable:/);
  await expect(recompute).toBeVisible();
  // Hold the inventory so the busy state lasts, then refuse it.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v1/inventory?*", async (route) => {
    await held;
    await route.abort();
  });
  await recompute.focus();
  await page.keyboard.press("Enter");
  await expect(note).toContainText("The local calculation is not ready yet.");
  await expect(recompute).toBeFocused();
  release();
  await expect(note).toContainText("No connection to the server.");
  await expect(recompute).toBeFocused();
});
