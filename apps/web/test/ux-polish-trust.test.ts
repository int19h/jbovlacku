import { test, expect, type Page } from "@playwright/test";
import {
  acceptFirstSignature,
  createIdentity,
  fixture,
  openWord,
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

test("the person page names each choice in plain words", async ({ page }) => {
  const f = fixture();
  await createIdentity(page);
  await page.goto(`/identity/${encodeURIComponent(f.identities.author)}`);
  const choices = choicesLine(page);
  await expect(choices).toHaveCount(0);
  await choosePrivately(page, "Trust");
  await choosePrivately(page, "Ignore");
  // The line is built when the page loads.
  await openPerson(page, f.identities.curator);
  await openPerson(page, f.identities.author);
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
  // The field's description includes the reason.
  await expect(explanation).toHaveAccessibleDescription(
    /Write an explanation before the preview\. A report needs one\./,
  );
  await explanation.pressSequentially("Many fake keys.");
  await expect(alert).toBeHidden();
  await expect(explanation).not.toHaveAccessibleDescription(
    /Write an explanation before the preview/,
  );
  await dialog
    .getByRole("button", { name: "Preview the public report" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Preview the public report" }),
  ).toContainText("Many fake keys.");
});

/** The line with the reader's choices on a person page, built when it loads. */
const choicesLine = (page: Page) =>
  page.locator("main p", { hasText: "Manage on the Trust page" });
/** Opens a person page inside the app, so the key stays unlocked. */
const openPerson = (page: Page, subject: string) =>
  page.evaluate(
    async (subject) =>
      (await import(String("/src/app/router.ts"))).navigate(
        `/identity/${encodeURIComponent(subject)}`,
      ),
    subject,
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

test("an open explanation stays open when a Remove renders the Trust page again", async ({
  page,
}) => {
  const f = fixture();
  await page.setViewportSize({ width: 360, height: 640 });
  await createIdentity(page);
  await saveForeignRule(page, f.identities.rootB, f.identities.curator);
  await saveForeignRule(page, f.identities.rootB, f.identities.delegate);
  await page.goto("/trust");
  const remove = page.getByRole("button", { name: "Remove", exact: true });
  await expect(remove).toHaveCount(2);
  await page.getByText("How the two views work", { exact: true }).click();
  const explanation = page.getByText(
    /The personal view downloads the snapshot's records/,
  );
  await expect(explanation).toBeVisible();
  // The first rule stays. Its place must not change when the page renders
  // again after the second rule is removed.
  const kept = page.locator("main .row").first();
  const top = () =>
    kept.evaluate((node) => node.getBoundingClientRect().top + window.scrollY);
  const before = await top();
  await remove.last().click();
  await expect(remove).toHaveCount(1);
  await expect(explanation).toBeVisible();
  await expect(page.locator("main details.disclosure").first()).toHaveAttribute(
    "open",
    "",
  );
  // Within half a pixel: Firefox rounds layout positions differently.
  expect(await top()).toBeCloseTo(before, 0);
});

// The reader opens or closes the explanation while a Remove is saving. The
// save finishes after the open state changed and before the toggle event.
for (const startOpen of [false, true])
  test(`a Remove that finishes right after the reader ${startOpen ? "closes" : "opens"} the explanation keeps that choice`, async ({
    page,
  }) => {
    const f = fixture();
    await page.setViewportSize({ width: 360, height: 640 });
    await createIdentity(page);
    await saveForeignRule(page, f.identities.rootB, f.identities.curator);
    await saveForeignRule(page, f.identities.rootB, f.identities.delegate);
    await page.goto("/trust");
    const remove = page.getByRole("button", { name: "Remove", exact: true });
    const summary = page.locator("summary", {
      hasText: "How the two views work",
    });
    const details = page.locator("details").filter({ has: summary });
    await expect(remove).toHaveCount(2);
    if (startOpen) {
      await summary.click();
      await expect(details.locator(".body p")).toHaveCount(4);
    }
    // The saved Remove waits until the open state of the current
    // explanation changes, then finishes before its toggle event.
    await page.evaluate(async (startOpen) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const update = LocalStore.prototype.updateOverlay;
      const old = [...document.querySelectorAll("main details")].find((node) =>
        node
          .querySelector("summary")
          ?.textContent?.includes("How the two views work"),
      ) as HTMLDetailsElement;
      const race = window as unknown as { saved?: boolean; old?: Element };
      race.old = old;
      const changed = new Promise<void>((resolve) => {
        const observer = new MutationObserver(() => {
          if (old.open === startOpen) return;
          observer.disconnect();
          resolve();
        });
        observer.observe(old, { attributes: true, attributeFilter: ["open"] });
      });
      LocalStore.prototype.updateOverlay = async function (...args: unknown[]) {
        const result = await update.apply(this, args as never);
        race.saved = true;
        await changed;
        return result;
      };
    }, startOpen);
    await remove.last().click();
    await page.waitForFunction(
      () => (window as unknown as { saved?: boolean }).saved === true,
    );
    await summary.click();
    await expect(remove).toHaveCount(1);
    const result = await details.evaluate((node) => ({
      rebuilt: node !== (window as unknown as { old: Element }).old,
      open: (node as HTMLDetailsElement).open,
      paragraphs: node.querySelectorAll(".body p").length,
    }));
    expect(result).toEqual({
      rebuilt: true,
      open: !startOpen,
      paragraphs: startOpen ? 0 : 4,
    });
  });

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
  const line = choicesLine(page);
  await expect(line).toHaveText(
    "Private rules saved under another key: Trusted privately for all judgments. They apply only when the personal calculation connects that key to yours. Manage on the Trust page",
  );
  await choosePrivately(page, "Ignore");
  await openPerson(page, f.identities.curator);
  await openPerson(page, f.identities.delegate);
  await expect(line).toHaveText(
    "Your choices: Ignored privately for all judgments. Private rules saved under another key: Trusted privately for all judgments. They apply only when the personal calculation connects that key to yours. Manage on the Trust page",
  );
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

test("the person page counts a rule as the reader's own when the loaded calculation confirms its handover", async ({
  page,
}) => {
  const subject = await handoverRule(page);
  await choosePersonal(page);
  const panel = page.getByRole("region", { name: "Local calculation" });
  await panel.getByRole("button", { name: "Recompute from records" }).click();
  await expect(panel).toContainText("Personal view calculated");
  await openPerson(page, subject);
  await expect(choicesLine(page)).toHaveText(
    "Your choices: Trusted privately for all judgments. Manage on the Trust page",
  );
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
  await expect(choicesLine(page)).toHaveText(
    "Private rules saved before this browser had a key: Trusted privately for all judgments. They move to your key when you create or restore one, unless your key already has a rule for the same person and scope. That rule then takes priority. Manage on the Trust page",
  );
  await page.goto("/trust");
  await expect(
    page.locator("main .row", { hasText: "all judgments" }),
  ).toContainText(
    "This rule was saved before this browser had a key. It moves to your key when you create or restore one, unless your key already has a rule for the same person and scope. That rule then takes priority.",
  );
});

test("public trust Undo cannot sign twice while its first clear is pending", async ({
  page,
}) => {
  const subject = fixture().identities.author;
  await createIdentity(page);
  await openPerson(page, subject);
  await page.getByRole("button", { name: "Trust their judgments" }).click();
  const panel = page.getByRole("region", { name: /^Trust\b/ });
  await panel.getByRole("radio", { name: /Publicly/ }).check();
  await panel.getByRole("button", { name: "Trust", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Trust", exact: true })
    .click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toContainText(
    "Signed. Others can build on it.",
  );
  await page.getByRole("link", { name: /^Trust:/ }).click();
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  const cleared = new Set<string>();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v1/events", async (route) => {
    if (route.request().method() === "POST") {
      const { id, header } = route.request().postDataJSON().envelope;
      if (
        header.action.kind === "trust.set" &&
        header.action.subject === subject &&
        header.action.value === "clear"
      ) {
        cleared.add(id);
        await held;
      }
    }
    await route.continue();
  });
  try {
    await undo.click();
    await expect.poll(() => cleared.size).toBe(1);
    await expect(undo).toBeDisabled();
    await undo.dispatchEvent("click");
  } finally {
    release();
  }
  await expect(undo).toHaveCount(0);
  expect(cleared.size).toBe(1);
});
