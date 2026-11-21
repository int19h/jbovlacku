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
  const imported = results.locator("article").filter({
    has: page.getByRole("link", { name: "ckusro", exact: true }),
  });
  await expect(imported.locator(".attribution-line")).toContainText("arj");
  await expect(imported.locator(".attribution-line")).toContainText("Mar 2003");
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
