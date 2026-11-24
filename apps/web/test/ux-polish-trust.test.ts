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
  const choices = choicesText(page);
  await expect(choices).toBeHidden();
  await choosePrivately(page, "Trust");
  await expect(choices).toHaveText(
    "Your choices: Trusted privately for all judgments.",
  );
  await choosePrivately(page, "Ignore");
  await expect(choices).toHaveText(
    "Your choices: Trusted privately for all judgments; Ignored privately for all judgments.",
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

const statusRegion = (page: Page) => page.locator("#app > [role=status]");
/** The description of the reader's choices on a person page, after its Manage link. */
const choicesText = (page: Page) =>
  page
    .locator("main p", { hasText: "Manage on the Trust page" })
    .locator(":scope > span");
/** Waits two frames, so a scroll that follows focus has happened. */
const frames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
// A name with a right-to-left override, a name that closes an isolate early
// and then reverses the text after it, a name of only an override, and a
// name of only a zero-width space. The unlock sentence names the person by
// the short identity, and the heading keeps the literal name.
for (const name of ["\u202eecila", "Dana\u2069\u202e", "\u202e", "\u200b"])
  test(`the unlock request names the person by the short identity for the profile name ${JSON.stringify(name)}`, async ({
    page,
  }) => {
    const f = fixture();
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
    // The panel title holds the literal name, which may be invisible.
    const panel = page.getByRole("region", { name: /^Trust\b/ });
    await panel.getByRole("radio", { name: /Publicly/ }).check();
    await panel.getByRole("button", { name: "Trust", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Trust", exact: true })
      .click();
    await expect(page).toHaveURL(/\/identity$/);
    await expect(
      page.getByText(/will continue after you create or import a key/),
    ).toHaveText(
      `Trusting ${f.identities.author.slice(8, 12)}…${f.identities.author.slice(-4)} publicly will continue after you create or import a key.`,
    );
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
});

test("a view change in another tab keeps Recompute in the panel", async ({
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
  await expect(choicesText(page)).toContainText("Trusted publicly");
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
  const line = choicesText(page);
  await expect(line).toHaveText(
    "Private rules saved under another key: Trusted privately for all judgments. They apply only when the personal calculation connects that key to yours.",
  );
  await choosePrivately(page, "Ignore");
  await expect(line).toHaveText(
    "Your choices: Ignored privately for all judgments. Private rules saved under another key: Trusted privately for all judgments. They apply only when the personal calculation connects that key to yours.",
  );
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
  const line = choicesText(page);
  await expect(line).toContainText("Private rules saved under another key");
  const manage = page.getByRole("link", { name: "Manage on the Trust page" });
  await manage.focus();
  release();
  await page.waitForFunction(
    () => (window as unknown as { seenReady?: string }).seenReady === "ready",
  );
  await expect(line).toHaveText(
    "Your choices: Trusted privately for all judgments.",
  );
  await expect(manage).toBeFocused();
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
  await expect(choicesText(page)).toHaveText(
    "Private rules saved before this browser had a key: Trusted privately for all judgments. They move to your key when you create or restore one, unless your key already has a rule for the same person and scope. That rule then takes priority.",
  );
  await page.goto("/trust");
  await expect(
    page.locator("main .row", { hasText: "all judgments" }),
  ).toContainText(
    "This rule was saved before this browser had a key. It moves to your key when you create or restore one, unless your key already has a rule for the same person and scope. That rule then takes priority.",
  );
});

/**
 * Opens the person page for a rule saved under the predecessor key, while a
 * calculation that the Trust page started holds its result. The choices
 * text is long until the result confirms the handover, then short. A later
 * Cancel clears the loaded calculation and makes it long again.
 */
async function personWithHeldHandover(page: Page) {
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
      calculator?: unknown;
      gate?: Promise<void> | null;
      held?: boolean;
      seen?: string;
      releaseResult?: () => void;
      holdNext?: () => void;
    };
    held.holdNext = () => {
      held.held = false;
      held.gate = new Promise<void>(
        (resolve) => (held.releaseResult = resolve),
      );
    };
    held.holdNext();
    proto.request = async function (...args: unknown[]) {
      const result = await request.apply(this, args as never);
      if (
        held.gate &&
        args.some(
          (arg) => (arg as { type?: string } | null)?.type === "overlay",
        )
      ) {
        held.held = true;
        await held.gate;
      }
      return result;
    };
    proto.ensure = function (...args: unknown[]) {
      held.calculator = this;
      const result = ensure.apply(this, args as never);
      void result.then((status: { state: string }) => {
        held.seen = status.state;
      });
      return result;
    };
  });
  await page
    .getByRole("region", { name: "Local calculation" })
    .getByRole("button", { name: "Recompute from records" })
    .click();
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
  const long =
    "Private rules saved under another key: Trusted privately for all judgments. They apply only when the personal calculation connects that key to yours.";
  const short = "Your choices: Trusted privately for all judgments.";
  await expect(choicesText(page)).toHaveText(long);
  return { long, short };
}
const box = (control: Locator) =>
  control.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
const centreOf = (rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}) => ({
  x: rect.x + rect.width / 2,
  y: rect.y + rect.height / 2,
});

for (const pointer of ["mouse", "touch"] as const)
  test.describe(() => {
    test.use({ hasTouch: pointer === "touch" });
    test(`Manage stays in place while the choices text changes during a ${pointer} press`, async ({
      page,
      browserName,
    }) => {
      const { long, short } = await personWithHeldHandover(page);
      const line = choicesText(page);
      const manage = page.getByRole("link", {
        name: "Manage on the Trust page",
      });
      const start = await box(manage);
      // Long to short: the result confirms the handover.
      await page.evaluate(() =>
        (window as unknown as { releaseResult: () => void }).releaseResult(),
      );
      await expect(line).toHaveText(short);
      await frames(page);
      expect(await box(manage)).toEqual(start);
      // Short to long during the press: a Cancel clears the loaded
      // calculation.
      const point = centreOf(start);
      const cdp =
        pointer === "touch" && browserName === "chromium"
          ? await page.context().newCDPSession(page)
          : null;
      if (pointer === "mouse") {
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
      } else if (cdp)
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: point.x, y: point.y }],
        });
      await page.evaluate(() =>
        (
          window as unknown as { calculator: { cancel: () => void } }
        ).calculator.cancel(),
      );
      await expect(line).toHaveText(long);
      await frames(page);
      expect(await box(manage)).toEqual(start);
      if (pointer === "mouse") await page.mouse.up();
      else if (cdp)
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
      // Firefox has no held touch input here, so it taps after the change.
      else await page.touchscreen.tap(point.x, point.y);
      await expect(page).toHaveURL(/\/trust$/);
    });
  });

test("the person page says that the choices could not be read after a failed read", async ({
  page,
}) => {
  await createIdentity(page);
  const subject = fixture().identities.author;
  await page.evaluate(async (subject) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    LocalStore.prototype.overlay = async () => {
      throw new DOMException("Storage transaction aborted.", "AbortError");
    };
    (await import(String("/src/app/router.ts"))).navigate(
      `/identity/${encodeURIComponent(subject)}`,
    );
  }, subject);
  await expect(choicesText(page)).toHaveText("Your choices could not be read.");
});
