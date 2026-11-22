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
    "No local calculation yet. It starts when a page needs personal scores, or now with Recompute from records.",
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
  // Other suites can also trust the author publicly, so the reader can be
  // one of several named trusters.
  await expect(authorRow).toContainText(/trusted by [^·]*\byou\b/);
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
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: "instant",
    }),
  );
  const footer = page.locator("footer.footer a").first();
  const footerBox = (await footer.boundingBox())!;
  const statusBox = (await status.boundingBox())!;
  expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(statusBox.y);
});

const statusRegion = (page: Page) => page.locator("#app > [role=status]");
/** Waits two frames, so a scroll that follows focus has happened. */
const frames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
/** Scrolls to the end of the page, also when content arrives late. */
async function scrollToEnd(page: Page) {
  await expect
    .poll(async () => {
      await page.evaluate(() =>
        window.scrollTo({
          top: document.documentElement.scrollHeight,
          behavior: "instant",
        }),
      );
      await frames(page);
      return page.evaluate(
        () =>
          Math.ceil(window.scrollY + window.innerHeight) >=
          document.documentElement.scrollHeight - 1,
      );
    })
    .toBe(true);
}
/** Endorses the first cukta definition and waits for the status message. */
async function endorseCukta(page: Page, keyboard = false) {
  await createIdentity(page);
  await openWord(page, "cukta");
  const endorse = page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" });
  if (keyboard) {
    await endorse.focus();
    await page.keyboard.press("Enter");
  } else await endorse.click();
  await acceptFirstSignature(page);
  await expect(statusRegion(page)).toHaveText("Your endorsement is published.");
}

for (const [width, height] of [
  [360, 640],
  [1280, 720],
] as const) {
  test(`a cleared status message keeps the page height and scroll position at ${width}x${height}`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height });
    await endorseCukta(page);
    await scrollToEnd(page);
    const before = await page.evaluate(() => ({
      y: window.scrollY,
      height: document.documentElement.scrollHeight,
    }));
    // At the end of the page the footer links clear the message.
    const statusBox = (await statusRegion(page).boundingBox())!;
    for (const footerLink of await page.locator("footer.footer a").all()) {
      const box = (await footerLink.boundingBox())!;
      expect(box.y + box.height).toBeLessThanOrEqual(statusBox.y);
    }
    await expect(statusRegion(page)).toHaveText("", { timeout: 12000 });
    await frames(page);
    const after = await page.evaluate(() => ({
      y: window.scrollY,
      height: document.documentElement.scrollHeight,
    }));
    expect(after).toEqual(before);
  });

  test(`a normal click on a control under the status message activates it at ${width}x${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await endorseCukta(page);
    const add = page.getByRole("link", { name: "Add a definition" });
    // Put the link in the band of the status message.
    await add.evaluate((node) => {
      const status = document
        .querySelector("#app > [role=status]")!
        .getBoundingClientRect();
      const box = node.getBoundingClientRect();
      window.scrollBy({
        top: box.top + box.height / 2 - (status.top + status.height / 2),
        behavior: "instant",
      });
    });
    await frames(page);
    const box = (await add.boundingBox())!;
    const status = (await statusRegion(page).boundingBox())!;
    expect(box.y + box.height).toBeGreaterThan(status.y);
    expect(box.y).toBeLessThan(status.y + status.height);
    // A pointer press of normal length: down, a short hold, then up.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(80);
    await page.mouse.up();
    await expect(page).not.toHaveURL(/\/word\/cukta/);
  });
}

test("a long status message uses the phone width and the footer clears it", async ({
  page,
}) => {
  const f = fixture();
  await page.setViewportSize({ width: 360, height: 640 });
  await createIdentity(page);
  await page.goto(`/identity/${encodeURIComponent(f.identities.author)}`);
  await choosePrivately(page, "Ignore");
  const box = (await statusRegion(page).boundingBox())!;
  // The box may use the width between the 16px margins, not only half.
  expect(box.width).toBeGreaterThan(300);
  expect(box.x).toBeGreaterThanOrEqual(15);
  expect(box.x + box.width).toBeLessThanOrEqual(345);
  await scrollToEnd(page);
  const statusBox = (await statusRegion(page).boundingBox())!;
  for (const footerLink of await page.locator("footer.footer a").all()) {
    const link = (await footerLink.boundingBox())!;
    expect(link.y + link.height).toBeLessThanOrEqual(statusBox.y);
  }
});

test("a running download keeps its panel and Cancel after a switch to the site view", async ({
  page,
}) => {
  await choosePersonal(page);
  const panel = page.getByRole("region", { name: "Local calculation" });
  const siteNote = page.getByText("It needs no calculation in this browser.");
  await page.route("**/api/v1/records?*", () => new Promise(() => {}));
  await panel.getByRole("button", { name: "Recompute from records" }).click();
  await expect(panel).toContainText("Downloading records");
  await page.getByRole("radio", { name: "Site view only" }).check();
  await expect(
    page.getByRole("link", { name: "Trust: site view" }),
  ).toBeVisible();
  await expect(panel).toContainText("Downloading records");
  await expect(siteNote).toHaveCount(0);
  await panel.getByRole("button", { name: "Cancel" }).click();
  await expect(panel).toHaveCount(0);
  await expect(siteNote).toBeVisible();
  // The same holds for Use the site view in the panel.
  await page
    .getByRole("radio", { name: "Mine: site view + my choices" })
    .check();
  await panel.getByRole("button", { name: "Recompute from records" }).click();
  await expect(panel).toContainText("Downloading records");
  await panel.getByRole("button", { name: "Use the site view" }).click();
  await expect(
    page.getByRole("link", { name: "Trust: site view" }),
  ).toBeVisible();
  await expect(panel).toContainText("Downloading records");
  await expect(panel.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(siteNote).toHaveCount(0);
});

test("the unlock request keeps a profile name in its own direction", async ({
  page,
}) => {
  const f = fixture();
  const name = "‮ecila";
  await page.route(
    `**/api/v1/identities/${encodeURIComponent(f.identities.author)}*`,
    async (route) => {
      if (new URL(route.request().url()).pathname.endsWith("/activity"))
        return route.continue();
      const response = await route.fetch();
      const json = await response.json();
      json.profile = {
        state: "known",
        claims: [
          {
            event: `jve1:${"a".repeat(64)}`,
            issuer: f.identities.author,
            body_hash: null,
            body: { name, bio: [], links: [] },
            body_status: "present",
          },
        ],
        claims_count: 1,
        claims_complete: true,
      };
      await route.fulfill({ response, json });
    },
  );
  await page.goto(`/identity/${encodeURIComponent(f.identities.author)}`);
  await expect(page.locator("main h1")).toHaveText(name);
  await page.getByRole("button", { name: "Trust their judgments" }).click();
  const panel = page.getByRole("region", { name: /^Trust / });
  await panel.getByRole("radio", { name: /Publicly/ }).check();
  await panel.getByRole("button", { name: "Trust", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Trust", exact: true })
    .click();
  await expect(page).toHaveURL(/\/identity$/);
  await expect(
    page.getByText(/will continue after you create or import a key/),
  ).toContainText(`Trusting ⁨${name}⁩ publicly`);
});

test("focus inside a dialog does not scroll the page behind it", async ({
  page,
}) => {
  const f = fixture();
  await page.setViewportSize({ width: 360, height: 640 });
  await createIdentity(page);
  await page.goto(`/identity/${encodeURIComponent(f.identities.author)}`);
  await choosePrivately(page, "Ignore");
  await page.getByRole("button", { name: "Report abuse" }).click();
  const dialog = page.getByRole("dialog", { name: "Report identity abuse" });
  await expect(dialog).toBeVisible();
  await expect(statusRegion(page)).not.toHaveText("");
  const before = await page.evaluate(() => window.scrollY);
  for (let step = 0; step < 12; step++) {
    await page.keyboard.press("Tab");
    await frames(page);
  }
  await dialog.getByRole("button", { name: "Cancel" }).focus();
  await frames(page);
  await expect(statusRegion(page)).not.toHaveText("");
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
});

test("the busy panel in the site view offers Cancel and no switch to the site view", async ({
  page,
}) => {
  await choosePersonal(page);
  const panel = page.getByRole("region", { name: "Local calculation" });
  await page.route("**/api/v1/records?*", () => new Promise(() => {}));
  await panel.getByRole("button", { name: "Recompute from records" }).click();
  await expect(panel).toContainText("Downloading records");
  await expect(
    panel.getByRole("button", { name: "Use the site view" }),
  ).toBeVisible();
  await page.getByRole("radio", { name: "Site view only" }).check();
  await expect(
    page.getByRole("link", { name: "Trust: site view" }),
  ).toBeVisible();
  await expect(panel).toContainText("Downloading records");
  await expect(panel.getByRole("button")).toHaveText([
    "Cancel",
    "Recompute from records",
  ]);
});

/** Saves a private Trust rule for all judgments under another issuer key. */
async function saveForeignRule(page: Page, issuer: string, subject: string) {
  await page.evaluate(
    async ({ issuer, subject }) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const store = new LocalStore();
      const overlay = await store.overlay();
      overlay.trust.push({
        issuer,
        subject,
        value: "heed",
        scope: { kind: "*", word: "*", language: "*" },
        weight: null,
      });
      await store.setOverlay(overlay);
    },
    { issuer, subject },
  );
}

test("a calculation that ends after a view switch updates the private rule reasons", async ({
  page,
}) => {
  const f = fixture();
  await createIdentity(page);
  await saveForeignRule(page, f.identities.rootB, f.identities.delegate);
  await page.goto("/trust");
  const rule = page.locator("main .row", {
    hasText: /No personal calculation is loaded|does not apply in the loaded/,
  });
  await expect(rule).toContainText("No personal calculation is loaded.");
  const personal = page.getByRole("radio", {
    name: "Mine: site view + my choices",
  });
  await personal.check();
  const panel = page.getByRole("region", { name: "Local calculation" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v1/records?*", async (route) => {
    await gate;
    await route.continue();
  });
  await panel.getByRole("button", { name: "Recompute from records" }).click();
  await expect(panel).toContainText("Downloading records");
  await page.getByRole("radio", { name: "Site view only" }).check();
  await expect(
    page.getByRole("link", { name: "Trust: site view" }),
  ).toBeVisible();
  await personal.check();
  await expect(
    page.getByRole("link", { name: "Trust: personal view" }),
  ).toBeVisible();
  release();
  await expect(panel).toContainText("Personal view calculated in this browser");
  await expect(rule).toContainText(
    "This rule does not apply in the loaded personal calculation.",
  );
  await expect(
    page.getByText(/^Private rule labels use personal calculation snapshot/),
  ).toHaveCount(1);
  // The page renders again, and focus stays on the chosen view.
  await expect(personal).toBeFocused();
});

test("a view change in another tab updates the radio and the panel", async ({
  page,
  context,
}) => {
  const other = await context.newPage();
  await page.goto("/trust");
  await other.goto("/trust");
  const panel = page.getByRole("region", { name: "Local calculation" });
  const siteNote = page.getByText("It needs no calculation in this browser.");
  await expect(siteNote).toBeVisible();
  await other
    .getByRole("radio", { name: "Mine: site view + my choices" })
    .check();
  await expect(
    page.getByRole("link", { name: "Trust: personal view" }),
  ).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "Mine: site view + my choices" }),
  ).toBeChecked();
  await expect(
    panel.getByRole("button", { name: "Recompute from records" }),
  ).toBeVisible();
  await expect(siteNote).toHaveCount(0);
  await other.getByRole("radio", { name: "Site view only" }).check();
  await expect(
    page.getByRole("link", { name: "Trust: site view" }),
  ).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "Site view only" }),
  ).toBeChecked();
  await expect(panel).toHaveCount(0);
  await expect(siteNote).toBeVisible();
  await other.close();
});

test("a refresh of the choices keeps focus on the Manage link", async ({
  page,
}) => {
  const f = fixture();
  const own = await createIdentity(page);
  await page.evaluate(
    async ({ own, subject }) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const store = new LocalStore();
      const overlay = await store.overlay();
      overlay.trust.push({
        issuer: own,
        subject,
        value: "heed",
        scope: { kind: "*", word: "*", language: "*" },
        weight: null,
      });
      await store.setOverlay(overlay);
      (await import(String("/src/app/router.ts"))).navigate(
        `/identity/${encodeURIComponent(subject)}`,
      );
    },
    {
      own: (own as { identity: string }).identity,
      subject: f.identities.author,
    },
  );
  const manage = page.getByRole("link", { name: "Manage on the Trust page" });
  await expect(manage).toBeVisible();
  // Hold the history read that follows the public save.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held = 0;
  await page.route("**/identity-heads/**", async (route) => {
    const status = await page.locator("#app > [role=status]").textContent();
    if (status?.includes("Your personal view includes it")) {
      held++;
      await gate;
    }
    await route.continue();
  });
  const opener = page.getByRole("button", { name: "Trust their judgments" });
  await opener.click();
  const panel = page.getByRole("region", { name: /^Trust / });
  await panel.getByRole("radio", { name: /Publicly/ }).check();
  await panel.getByRole("button", { name: "Trust", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Trust", exact: true })
    .click();
  await acceptFirstSignature(page);
  await expect(opener).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(manage).toBeFocused();
  await expect.poll(() => held).toBeGreaterThan(0);
  release();
  await expect(
    page.locator("main p", { hasText: /^Your choices:/ }),
  ).toContainText("Trusted publicly");
  await expect(manage).toBeFocused();
});

test("an empty code span does not count as a report explanation", async ({
  page,
}) => {
  const f = fixture();
  await createIdentity(page);
  await page.goto(`/identity/${encodeURIComponent(f.identities.author)}`);
  await page.getByRole("button", { name: "Report abuse" }).click();
  const dialog = page.getByRole("dialog", { name: "Report identity abuse" });
  await dialog
    .getByRole("button", { name: "Preview the public report" })
    .click();
  const alert = dialog.getByRole("alert");
  await expect(alert).toBeVisible();
  const field = dialog.getByRole("textbox", { name: "Explanation" });
  await field.click();
  await dialog
    .getByRole("button", { name: "Insert code", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Insert code" })
    .getByRole("button", { name: "Insert", exact: true })
    .click();
  await expect
    .poll(() => field.evaluate((n) => JSON.stringify((n as any).value)))
    .toContain('{"code":""}');
  await expect(alert).toBeVisible();
  await dialog
    .getByRole("button", { name: "Preview the public report" })
    .click();
  await expect(alert).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign and publish the report" }),
  ).toHaveCount(0);
});

test("a private rule from another key is not listed as the reader's choice", async ({
  page,
}) => {
  const f = fixture();
  await createIdentity(page);
  await saveForeignRule(page, f.identities.rootB, f.identities.delegate);
  await page.goto(`/identity/${encodeURIComponent(f.identities.delegate)}`);
  const line = page.locator("main p", { hasText: "Manage on the Trust page" });
  await expect(line).toHaveText(
    "Private rules saved under another key: Trusted privately for all judgments. They apply only when the personal calculation connects that key to yours. Manage on the Trust page",
  );
  await choosePrivately(page, "Ignore");
  await expect(line).toHaveText(
    "Your choices: Ignored privately for all judgments. Private rules saved under another key: Trusted privately for all judgments. They apply only when the personal calculation connects that key to yours. Manage on the Trust page",
  );
});

test("the footer room grows when a visible status message wraps after a resize", async ({
  page,
}) => {
  const f = fixture();
  await page.setViewportSize({ width: 900, height: 500 });
  await createIdentity(page);
  // Navigate inside the app so the key stays unlocked.
  await page.evaluate(async (subject) => {
    (await import(String("/src/app/router.ts"))).navigate(
      `/identity/${encodeURIComponent(subject)}`,
    );
  }, f.identities.author);
  await page.getByRole("button", { name: "Trust their judgments" }).click();
  const panel = page.getByRole("region", { name: /^Trust / });
  await panel.getByRole("radio", { name: /Publicly/ }).check();
  await panel.getByRole("button", { name: "Trust", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Trust", exact: true })
    .click();
  await acceptFirstSignature(page);
  const status = page.locator("#app > [role=status]");
  await expect(status).toContainText("Your personal view includes it");
  await page.setViewportSize({ width: 320, height: 640 });
  const overlap = () =>
    page.evaluate(async () => {
      window.scrollTo({
        top: document.documentElement.scrollHeight,
        behavior: "instant",
      });
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      );
      const toast = document.querySelector("#app > [role=status]")!;
      if (!toast.textContent) return 9999;
      const top = toast.getBoundingClientRect().top;
      return Math.max(
        ...[...document.querySelectorAll("footer a")].map(
          (a) => a.getBoundingClientRect().bottom - top,
        ),
      );
    });
  await expect.poll(overlap, { timeout: 5000 }).toBeLessThanOrEqual(0);
  // Click-through stays.
  await expect(status).toHaveCSS("pointer-events", "none");
});
