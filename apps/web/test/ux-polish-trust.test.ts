import { test, expect, type Page } from "@playwright/test";
import {
  acceptFirstSignature,
  createIdentity,
  fixture,
  openWord,
} from "./helpers.ts";

/** Chooses the personal view on the Trust page. */
async function choosePersonal(page: Page) {
  await page.goto("/trust");
  await page
    .getByRole("radio", { name: "Mine: site view + my choices" })
    .check();
  await expect(
    page.getByRole("link", { name: "Trust: personal view" }),
  ).toBeVisible();
}

/** Saves a private Trust or Ignore choice from the open person page. */
async function choosePrivately(page: Page, mode: "Trust" | "Ignore") {
  await page.getByRole("button", { name: `${mode} their judgments` }).click();
  const panel = page.getByRole("region", { name: new RegExp(`^${mode} `) });
  await panel.getByRole("radio", { name: /Just for me/ }).check();
  await panel.getByRole("button", { name: mode, exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    mode === "Trust" ? "Saved as a private rule" : "Saved as a private block",
  );
}

test("the trust page keeps the long explanation in a closed disclosure", async ({
  page,
}) => {
  await page.goto("/trust");
  await expect(
    page.getByText("Whose judgments order the definitions you see."),
  ).toBeVisible();
  const explanation = page.getByText(
    /The personal view downloads the snapshot's records/,
  );
  await expect(explanation).toBeHidden();
  await page.getByText("How the two views work", { exact: true }).click();
  await expect(explanation).toBeVisible();
  // The Trust page still says how a private Ignore and a public clear interact.
  await expect(
    page.getByText(/A private Ignore stays until you remove it/),
  ).toBeVisible();
});

test("the trust page panel follows the chosen view and says when the calculation starts", async ({
  page,
}) => {
  await page.goto("/trust");
  const panel = page.getByRole("region", { name: "Local calculation" });
  // The site view needs no local calculation, so it shows no panel.
  await expect(
    page.getByRole("radio", { name: "Site view only" }),
  ).toBeChecked();
  await expect(panel).toHaveCount(0);
  await expect(
    page.getByText("It needs no calculation in this browser."),
  ).toBeVisible();
  await page
    .getByRole("radio", { name: "Mine: site view + my choices" })
    .check();
  await expect(panel).toContainText(
    "No local calculation yet. It starts when you open a word page, or now with Recompute from records.",
  );
  await expect(
    panel.getByRole("button", { name: "Use the site view" }),
  ).toBeVisible();
  await page.getByRole("radio", { name: "Site view only" }).check();
  await expect(panel).toHaveCount(0);
});

test("a finished personal calculation is not shown in the warning style", async ({
  page,
}) => {
  await choosePersonal(page);
  await openWord(page, "cukta");
  const panel = page.getByRole("region", { name: "Personal view" });
  await expect(panel).toContainText(
    /Personal view calculated in this browser from \d+ verified records\./,
  );
  await expect(panel).not.toHaveClass(/\bnotice\b/);
  const colors = await panel.evaluate((node) => {
    const style = getComputedStyle(node);
    const probe = document.createElement("div");
    probe.className = "notice";
    document.body.append(probe);
    const notice = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { panel: style.backgroundColor, notice };
  });
  expect(colors.panel).not.toBe(colors.notice);
  // A failure keeps the warning style.
  await page.route("**/api/v1/inventory?*", (route) =>
    route.fulfill({ status: 500, body: "broken" }),
  );
  await panel.getByRole("button", { name: "Recompute from records" }).click();
  await expect(panel).toContainText("Request failed (500).");
  await expect(panel).toHaveClass(/\bnotice\b/);
});

test("the unavailable note follows a failure, a lost connection, and a cancel", async ({
  page,
}) => {
  await page.route("**/api/v1/inventory?*", (route) =>
    route.fulfill({ status: 500, body: "broken" }),
  );
  await choosePersonal(page);
  await openWord(page, "cukta");
  const panel = page.getByRole("region", { name: "Personal view" });
  const note = page.getByText(/^Personal scores are unavailable:/);
  await expect(note).toContainText("Request failed (500).");
  await page.unroute("**/api/v1/inventory?*");
  await page.route("**/api/v1/inventory?*", (route) => route.abort());
  await panel.getByRole("button", { name: "Recompute from records" }).click();
  await expect(note).toContainText("No connection to the server.");
  await expect(note).not.toContainText("Request failed (500).");
  // Cancel while the records download.
  await page.unroute("**/api/v1/inventory?*");
  await page.route("**/api/v1/records?*", () => new Promise(() => {}));
  await panel.getByRole("button", { name: "Recompute from records" }).click();
  await expect(panel).toContainText("Downloading records");
  await panel.getByRole("button", { name: "Cancel" }).click();
  await expect(panel).toContainText("cancelled");
  await expect(note).toContainText("cancelled");
  await expect(note).not.toContainText("No connection to the server.");
  // A record download that the server refuses with 503 ends in its reason.
  await page.unroute("**/api/v1/records?*");
  await page.route("**/api/v1/records?*", (route) =>
    route.fulfill({ status: 503, body: "busy" }),
  );
  await panel.getByRole("button", { name: "Recompute from records" }).click();
  await expect(panel).toContainText("Request failed (503).", {
    timeout: 60000,
  });
  await expect(note).toContainText("Request failed (503).");
});

test("the trust panel names the person as the page heading does", async ({
  page,
}) => {
  const f = fixture();
  await page.goto(`/identity/${encodeURIComponent(f.identities.author)}`);
  const heading = (await page.locator("main h1").textContent())!.trim();
  await page.getByRole("button", { name: "Trust their judgments" }).click();
  await expect(
    page.getByRole("region", { name: /^Trust / }).getByRole("heading"),
  ).toHaveText(`Trust ${heading}`);
});

test("the person page names each choice in plain words and follows a new choice", async ({
  page,
}) => {
  const f = fixture();
  await createIdentity(page);
  await page.goto(`/identity/${encodeURIComponent(f.identities.author)}`);
  const choices = page.locator("main p", { hasText: /^Your choices:/ });
  await expect(choices).toHaveCount(0);
  await choosePrivately(page, "Trust");
  await expect(choices).toHaveText(
    "Your choices: Trusted privately for all judgments. Manage on the Trust page",
  );
  await choosePrivately(page, "Ignore");
  await expect(choices).toHaveText(
    "Your choices: Trusted privately for all judgments; Ignored privately for all judgments. Manage on the Trust page",
  );
  await expect(choices).not.toContainText("*");
});

test("the reviewer table names the reader as you", async ({ page }) => {
  const f = fixture();
  await createIdentity(page);
  await page.goto(`/identity/${encodeURIComponent(f.identities.author)}`);
  await choosePrivately(page, "Trust");
  await choosePersonal(page);
  await openWord(page, "cukta");
  await expect(
    page.getByRole("region", { name: "Personal view" }),
  ).toContainText(/Personal view calculated in this browser/);
  const third = page.locator("article.definition", {
    hasText: "Third meaning",
  });
  await third.locator("details.judgment-details summary").click();
  const reviewers = third.getByRole("region", { name: "Reviewers" });
  // Other suites on the shared server can add reviewers, so the row is
  // found by the author's link in its first cell.
  const authorRow = reviewers.getByRole("row").filter({
    has: page.locator(
      `td:first-child a[href="/identity/${encodeURIComponent(f.identities.author)}"]`,
    ),
  });
  await expect(authorRow).toContainText("trusted by you");
  await expect(authorRow.getByRole("link", { name: "you" })).toHaveAttribute(
    "href",
    /^\/identity\/ed25519/,
  );
});

test("an empty report explanation says why the preview did not open", async ({
  page,
}) => {
  const f = fixture();
  await createIdentity(page);
  await page.goto(`/identity/${encodeURIComponent(f.identities.author)}`);
  await page.getByRole("button", { name: "Report abuse" }).click();
  const dialog = page.getByRole("dialog", { name: "Report identity abuse" });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Preview the public report" })
    .click();
  const alert = dialog.getByRole("alert");
  await expect(alert).toHaveText(
    "Write an explanation before the preview. A report needs one.",
  );
  await expect(alert).toBeVisible();
  const explanation = dialog.getByRole("textbox", { name: "Explanation" });
  await expect(explanation).toBeFocused();
  await expect(explanation).toHaveAttribute("aria-invalid", "true");
  await explanation.pressSequentially("Many fake keys.");
  await expect(alert).toBeHidden();
  await dialog
    .getByRole("button", { name: "Preview the public report" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Preview the public report" }),
  ).toContainText("Many fake keys.");
});

test("the status message lets clicks through and leaves room below the page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await createIdentity(page);
  await openWord(page, "cukta");
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await acceptFirstSignature(page);
  const status = page.getByRole("status").filter({
    hasText: "Your endorsement is published.",
  });
  await expect(status).toBeVisible();
  // A control under the message still receives the click.
  const underneath = await status.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const hit = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2,
    );
    return hit ? node.contains(hit) : null;
  });
  expect(underneath).toBe(false);
  // At the end of the page the footer links clear the message.
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  const footer = page.locator("footer.footer a").first();
  const footerBox = (await footer.boundingBox())!;
  const statusBox = (await status.boundingBox())!;
  expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(statusBox.y);
});
