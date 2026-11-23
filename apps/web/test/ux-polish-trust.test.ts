import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  acceptFirstSignature,
  corePath,
  createIdentity,
  fixture,
  openWord,
  PASSPHRASE,
  transferFixture,
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

test("the trust page panel says when the calculation starts in both views", async ({
  page,
}) => {
  await page.goto("/trust");
  const panel = page.getByRole("region", { name: "Local calculation" });
  const idle =
    "No local calculation yet. It starts when a page needs personal scores, or now with Recompute from records. Pages in the site view show this server's scores and need no local calculation.";
  await expect(
    page.getByRole("radio", { name: "Site view only" }),
  ).toBeChecked();
  await expect(panel).toContainText(idle);
  await page
    .getByRole("radio", { name: "Mine: site view + my choices" })
    .check();
  await expect(
    page.getByRole("link", { name: "Trust: personal view" }),
  ).toBeVisible();
  await expect(panel).toContainText(idle);
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
  // Both styles have the same box, so a change of state does not move the
  // controls in the panel or below it.
  const box = () =>
    panel.evaluate((node) => {
      const style = getComputedStyle(node);
      return [
        style.borderTopWidth,
        style.borderBottomWidth,
        style.paddingTop,
        style.paddingBottom,
        style.fontSize,
      ];
    });
  const quiet = await box();
  // A failure keeps the warning style.
  await page.route("**/api/v1/inventory?*", (route) =>
    route.fulfill({ status: 500, body: "broken" }),
  );
  await panel.getByRole("button", { name: "Recompute from records" }).click();
  await expect(panel).toContainText("Request failed (500).");
  await expect(panel).toHaveClass(/\bnotice\b/);
  expect(await box()).toEqual(quiet);
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
  // Focus stays on the chosen view.
  await expect(personal).toBeFocused();
});

test("a view change in another tab updates the radio", async ({
  page,
  context,
}) => {
  const other = await context.newPage();
  await page.goto("/trust");
  await other.goto("/trust");
  await other
    .getByRole("radio", { name: "Mine: site view + my choices" })
    .check();
  await expect(
    page.getByRole("link", { name: "Trust: personal view" }),
  ).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "Mine: site view + my choices" }),
  ).toBeChecked();
  await other.getByRole("radio", { name: "Site view only" }).check();
  await expect(
    page.getByRole("link", { name: "Trust: site view" }),
  ).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "Site view only" }),
  ).toBeChecked();
  await expect(
    page
      .getByRole("region", { name: "Local calculation" })
      .getByRole("button", { name: "Recompute from records" }),
  ).toBeVisible();
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

/** Holds every records download until the returned function runs. */
async function holdRecords(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v1/records?*", async (route) => {
    await gate;
    await route.continue();
  });
  return release;
}
/** Leaves the Trust page and returns to it inside the app. */
async function returnToTrust(page: Page) {
  await page.getByRole("link", { name: "About", exact: true }).last().click();
  await page
    .getByRole("link", { name: "Trust: personal view", exact: true })
    .click();
}

test("a calculation that ends keeps the reader's entry, focus and disclosure at 360x640", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await choosePersonal(page);
  const panel = page.getByRole("region", { name: "Local calculation" });
  const release = await holdRecords(page);
  await panel.getByRole("button", { name: "Recompute from records" }).click();
  await expect(panel).toContainText("Downloading records");
  // The run started on the earlier visit, so the panel on this visit did not start it.
  await returnToTrust(page);
  await expect(panel).toContainText("Downloading records");
  await page.locator("summary", { hasText: "Settings and history" }).click();
  await expect(
    page.getByText("Outward allowance (H)", { exact: true }),
  ).toBeVisible();
  const field = page.getByRole("textbox", { name: "Signed view event ID" });
  await field.fill("jve1:12345");
  await field.evaluate((node) => node.scrollIntoView({ block: "center" }));
  await frames(page);
  const capture = () =>
    page.evaluate(() => {
      const field = document.querySelector<HTMLInputElement>(
        "input[aria-label='Signed view event ID']",
      );
      return {
        focus: document.activeElement?.getAttribute("aria-label") ?? null,
        value: field?.value ?? null,
        open: [
          ...document.querySelectorAll("main details[open] > summary"),
        ].map((node) => node.textContent),
      };
    });
  const before = await capture();
  expect(before.focus).toBe("Signed view event ID");
  expect(before.open).toEqual(["Settings and history"]);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(200);
  release();
  await expect(panel).toContainText("Personal view calculated in this browser");
  await frames(page);
  expect(await capture()).toEqual(before);
});

test("a late conflict-history read adds no second copy of the rules", async ({
  page,
}) => {
  const key = await createIdentity(page);
  await page.evaluate(
    async ({ key, subject, passphrase, corePath }) => {
      const core = await import(corePath);
      await core.initializeCore();
      const { unlockKey } = await import(String("/src/data/keys.ts"));
      const { signWith } = await import(String("/src/data/lifecycle.ts"));
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const unlocked = await unlockKey(key, passphrase);
      // Two records that no device has seen together: a public conflict.
      const events = [];
      for (const value of ["heed", "shun"])
        events.push(
          (
            await signWith(unlocked, key.identity, [], {
              kind: "trust.set",
              subject,
              scope: { kind: "*", word: "*", language: "*" },
              value,
            })
          ).envelope,
        );
      await new LocalStore().recordBranch(key.identity, events);
    },
    {
      key,
      subject: fixture().identities.curator,
      passphrase: PASSPHRASE,
      corePath,
    },
  );
  await page.goto("/trust");
  const conflicts = page.getByRole("heading", {
    name: "Conflicting public choices",
    exact: true,
  });
  await expect(conflicts).toBeVisible();
  await page
    .getByRole("radio", { name: "Mine: site view + my choices" })
    .check();
  const panel = page.getByRole("region", { name: "Local calculation" });
  const release = await holdRecords(page);
  await panel.getByRole("button", { name: "Recompute from records" }).click();
  await expect(panel).toContainText("Downloading records");
  await page.getByRole("link", { name: "About", exact: true }).last().click();
  let reads = 0;
  let history!: () => void;
  const historyGate = new Promise<void>((resolve) => (history = resolve));
  await page.route("**/identity-heads/**", async (route) => {
    if (++reads === 1) await historyGate;
    await route.continue();
  });
  await page
    .getByRole("link", { name: "Trust: personal view", exact: true })
    .click();
  await expect.poll(() => reads).toBe(1);
  release();
  await expect(panel).toContainText("Personal view calculated");
  history();
  await expect(
    page.getByRole("textbox", { name: "Signed view event ID" }),
  ).toBeVisible();
  await frames(page);
  await expect(conflicts).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "Site view", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.locator("main").getByRole("button", { name: "Undo", exact: true }),
  ).toHaveCount(1);
});

test("a public choice signed after a calculation ended shows on the open Trust page", async ({
  page,
}) => {
  const key = await createIdentity(page);
  await page.evaluate(
    async ({ issuer, subject }) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const store = new LocalStore();
      const overlay = await store.overlay();
      overlay.trust.push({
        issuer,
        subject,
        scope: { kind: "*", word: "*", language: "*" },
        value: "heed",
        weight: null,
      });
      await store.setOverlay(overlay);
      // Navigate inside the app so the key stays unlocked.
      (await import(String("/src/app/router.ts"))).navigate("/trust");
    },
    { issuer: key.identity, subject: fixture().identities.delegate },
  );
  await page
    .getByRole("radio", { name: "Mine: site view + my choices" })
    .check();
  const panel = page.getByRole("region", { name: "Local calculation" });
  const release = await holdRecords(page);
  await panel.getByRole("button", { name: "Recompute from records" }).click();
  await expect(panel).toContainText("Downloading records");
  await page.getByRole("button", { name: "Make public", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Trust: public signed record",
  });
  await expect(dialog).toBeVisible();
  release();
  await expect(panel).toContainText("Personal view calculated");
  await dialog.getByRole("button", { name: "Trust", exact: true }).click();
  await acceptFirstSignature(page);
  await expect(statusRegion(page)).toContainText(
    "Signed. Others can build on it.",
  );
  await expect(
    page.locator("main").getByRole("button", { name: "Undo", exact: true }),
  ).toHaveCount(1);
});

/**
 * Selects a successor key and saves a private Trust rule for the delegate
 * under its predecessor. The snapshot holds the signed handover.
 */
async function handoverRule(page: Page) {
  const data = await transferFixture(page, true);
  const subject = fixture().identities.delegate;
  await page.evaluate(
    async ({ data, subject }) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const store = new LocalStore();
      await store.put("keys", "selected", data.successor);
      const overlay = await store.overlay();
      overlay.trust.push({
        issuer: data.old.identity,
        subject,
        scope: { kind: "*", word: "*", language: "*" },
        value: "heed",
        weight: null,
      });
      await store.setOverlay(overlay);
    },
    { data, subject },
  );
  return subject;
}

test("the person page moves a rule to Your choices when a calculation confirms its handover", async ({
  page,
}) => {
  const subject = await handoverRule(page);
  await choosePersonal(page);
  const panel = page.getByRole("region", { name: "Local calculation" });
  const release = await holdRecords(page);
  await page.evaluate(async () => {
    // Records when the calculation that the panel starts is ready.
    const { PersonalCalculator } = await import(
      String("/src/data/personal.ts")
    );
    const ensure = PersonalCalculator.prototype.ensure;
    PersonalCalculator.prototype.ensure = function (...args: unknown[]) {
      const result = ensure.apply(this, args as never);
      void result.then((status: { state: string }) => {
        (window as unknown as { seenReady: string }).seenReady = status.state;
      });
      return result;
    };
  });
  await panel.getByRole("button", { name: "Recompute from records" }).click();
  await expect(panel).toContainText("Downloading records");
  await page.evaluate(
    async (subject) =>
      (await import(String("/src/app/router.ts"))).navigate(
        `/identity/${encodeURIComponent(subject)}`,
      ),
    subject,
  );
  const line = page.locator("main p", { hasText: "Manage on the Trust page" });
  await expect(line).toContainText("Private rules saved under another key");
  const manage = page.getByRole("link", { name: "Manage on the Trust page" });
  await manage.focus();
  release();
  await page.waitForFunction(
    () => (window as unknown as { seenReady?: string }).seenReady === "ready",
  );
  await expect(line).toHaveText(
    "Your choices: Trusted privately for all judgments. Manage on the Trust page",
  );
  await expect(manage).toBeFocused();
});

test("a cancel that clears the loaded calculation updates the rule reasons at once", async ({
  page,
}) => {
  await handoverRule(page);
  await choosePersonal(page);
  const panel = page.getByRole("region", { name: "Local calculation" });
  await panel.getByRole("button", { name: "Recompute from records" }).click();
  await expect(panel).toContainText("Personal view calculated");
  const source = page.getByText(
    /^Private rule labels use personal calculation snapshot/,
  );
  const attention = page.getByRole("heading", {
    name: "Private rules that need attention",
  });
  await expect(source).toBeVisible();
  await expect(attention).toHaveCount(0);
  let finish!: () => void;
  const held = new Promise<void>((resolve) => (finish = resolve));
  await page.route("**/api/v1/inventory?*", async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  await panel.getByRole("button", { name: "Recompute from records" }).click();
  await expect(panel).toContainText("Downloading");
  await panel.getByRole("button", { name: "Cancel" }).click();
  await expect(panel).toContainText("cancelled");
  await expect(attention).toBeVisible();
  await expect(
    page.getByText(/No personal calculation is loaded/),
  ).toBeVisible();
  await expect(source).toBeHidden();
  finish();
});

test("a rule saved before this browser had a key is described as such", async ({
  page,
}) => {
  const subject = fixture().identities.curator;
  await page.goto("/identity");
  await page.evaluate(async (subject) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const overlay = await store.overlay();
    overlay.trust.push({
      issuer: "local",
      subject,
      scope: { kind: "*", word: "*", language: "*" },
      value: "heed",
      weight: null,
    });
    await store.setOverlay(overlay);
  }, subject);
  await page.goto(`/identity/${encodeURIComponent(subject)}`);
  await expect(
    page.locator("main p", { hasText: "Manage on the Trust page" }),
  ).toHaveText(
    "Private rules saved before this browser had a key: Trusted privately for all judgments. They move to your key when you create or restore one. Manage on the Trust page",
  );
  await page.goto("/trust");
  await expect(
    page.locator("main .row", { hasText: "all judgments" }),
  ).toContainText(
    "This rule was saved before this browser had a key. It moves to your key when you create or restore one.",
  );
});

test("the optional rule headings stay hidden while the history loads", async ({
  page,
}) => {
  await createIdentity(page);
  let reads = 0;
  let history!: () => void;
  const gate = new Promise<void>((resolve) => (history = resolve));
  await page.route("**/identity-heads/**", async (route) => {
    reads++;
    await gate;
    await route.continue();
  });
  await page.goto("/trust");
  await expect(
    page.getByRole("heading", { name: "People I trust", exact: true }),
  ).toBeVisible();
  await expect.poll(() => reads).toBeGreaterThan(0);
  await frames(page);
  const optional = page.getByRole("heading", {
    name: /^(Conflicting public choices|Private rules that need attention)$/,
  });
  await expect(optional).toHaveCount(0);
  history();
  await expect(
    page.getByText(
      "Nobody yet. Open an identity page and choose Trust their judgments.",
    ),
  ).toBeVisible();
  await expect(optional).toHaveCount(0);
});

test("Remove of the only rule that needs attention moves focus to a heading that stays", async ({
  page,
}) => {
  const f = fixture();
  await createIdentity(page);
  await saveForeignRule(page, f.identities.rootB, f.identities.delegate);
  await page.goto("/trust");
  const attention = page.getByRole("heading", {
    name: "Private rules that need attention",
    exact: true,
  });
  await expect(attention).toBeVisible();
  const rule = page.locator("main .row", {
    hasText: "No personal calculation is loaded.",
  });
  await rule.getByRole("button", { name: "Remove", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(rule).toHaveCount(0);
  await expect(attention).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "People I ignore", exact: true }),
  ).toBeFocused();
});

/** Whether the point is on the control. */
const under = (control: Locator, point: { x: number; y: number }) =>
  control.evaluate(
    (node, { x, y }) => node.contains(document.elementFromPoint(x, y)),
    point,
  );

/**
 * Opens the Trust page in the personal view with a calculation that holds its
 * final result until `window.releaseResult()` runs. The rule saved under the
 * predecessor key waits in "Private rules that need attention", and the
 * result moves it to "People I trust".
 */
async function heldHandoverResult(page: Page) {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await handoverRule(page);
  await choosePersonal(page);
  await page.evaluate(async () => {
    const { PersonalCalculator } = await import(
      String("/src/data/personal.ts")
    );
    const proto = PersonalCalculator.prototype;
    const request = proto.request;
    const held = window as unknown as {
      held?: boolean;
      releaseResult?: () => void;
    };
    const gate = new Promise<void>((resolve) => (held.releaseResult = resolve));
    proto.request = async function (...args: unknown[]) {
      const result = await request.apply(this, args as never);
      if (
        args.some(
          (arg) => (arg as { type?: string } | null)?.type === "overlay",
        )
      ) {
        held.held = true;
        await gate;
      }
      return result;
    };
  });
  const panel = page.getByRole("region", { name: "Local calculation" });
  await panel.getByRole("button", { name: "Recompute from records" }).click();
  await page.waitForFunction(
    () => (window as unknown as { held?: boolean }).held === true,
  );
  // The run started on the earlier visit, as in a reader's own navigation.
  await returnToTrust(page);
  await expect(
    page.getByRole("textbox", { name: "Signed view event ID" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Private rules that need attention",
      exact: true,
    }),
  ).toBeVisible();
  return panel;
}

test("a calculation that ends during a press on Make public opens the preview on the first click", async ({
  page,
}) => {
  const panel = await heldHandoverResult(page);
  const makePublic = page.getByRole("button", {
    name: "Make public",
    exact: true,
  });
  await makePublic.scrollIntoViewIfNeeded();
  const centre = () =>
    makePublic.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
  const before = await centre();
  await page.mouse.move(before.x, before.y);
  await page.mouse.down();
  // The calculation finishes while the button is pressed.
  await page.evaluate(() =>
    (window as unknown as { releaseResult: () => void }).releaseResult(),
  );
  await expect(panel).toContainText("Personal view calculated");
  await frames(page);
  // The panel text can wrap onto another line, as on main, but the button
  // stays under the pointer.
  expect(await under(makePublic, before)).toBe(true);
  await page.mouse.up();
  await expect(page.getByRole("dialog")).toBeVisible();
  // After the click, the rule moves to the section that it now belongs to.
  await expect(
    page.locator("main h2:text-is('People I trust') + div .row", {
      hasText: "all judgments",
    }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("heading", {
      name: "Private rules that need attention",
      exact: true,
    }),
  ).toHaveCount(0);
});

test("a focused rule heading that loses its last rule says that the section is empty", async ({
  page,
}) => {
  const panel = await heldHandoverResult(page);
  const old = page.getByRole("heading", {
    name: "Private rules that need attention",
    exact: true,
  });
  await old.click();
  await expect(old).toBeFocused();
  await page.evaluate(() =>
    (window as unknown as { releaseResult: () => void }).releaseResult(),
  );
  await expect(panel).toContainText("Personal view calculated");
  const empty = page.getByRole("heading", {
    name: "No private rules need attention.",
    exact: true,
  });
  await expect(empty).toBeFocused();
  await expect(old).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(empty).not.toBeFocused();
  await expect(old).toHaveCount(0);
});

test("a calculation that ends during a press on Manage keeps the link in place until the click", async ({
  page,
}) => {
  const subject = await handoverRule(page);
  await choosePersonal(page);
  await page.evaluate(async () => {
    const { PersonalCalculator } = await import(
      String("/src/data/personal.ts")
    );
    const proto = PersonalCalculator.prototype;
    const request = proto.request;
    const ensure = proto.ensure;
    const held = window as unknown as {
      held?: boolean;
      seenReady?: string;
      releaseResult?: () => void;
    };
    const gate = new Promise<void>((resolve) => (held.releaseResult = resolve));
    proto.request = async function (...args: unknown[]) {
      const result = await request.apply(this, args as never);
      if (
        args.some(
          (arg) => (arg as { type?: string } | null)?.type === "overlay",
        )
      ) {
        held.held = true;
        await gate;
      }
      return result;
    };
    proto.ensure = function (...args: unknown[]) {
      const result = ensure.apply(this, args as never);
      void result.then((status: { state: string }) => {
        held.seenReady = status.state;
      });
      return result;
    };
  });
  const panel = page.getByRole("region", { name: "Local calculation" });
  await panel.getByRole("button", { name: "Recompute from records" }).click();
  await page.waitForFunction(
    () => (window as unknown as { held?: boolean }).held === true,
  );
  await page.evaluate(
    async (subject) =>
      (await import(String("/src/app/router.ts"))).navigate(
        `/identity/${encodeURIComponent(subject)}`,
      ),
    subject,
  );
  const line = page.locator("main p", { hasText: "Manage on the Trust page" });
  await expect(line).toContainText("Private rules saved under another key");
  const manage = page.getByRole("link", { name: "Manage on the Trust page" });
  const centre = () =>
    manage.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
  const before = await centre();
  await page.mouse.move(before.x, before.y);
  await page.mouse.down();
  await page.evaluate(() =>
    (window as unknown as { releaseResult: () => void }).releaseResult(),
  );
  await page.waitForFunction(
    () => (window as unknown as { seenReady?: string }).seenReady === "ready",
  );
  await frames(page);
  expect(await under(manage, before)).toBe(true);
  await page.mouse.up();
  await expect(page).toHaveURL(/\/trust$/);
});
