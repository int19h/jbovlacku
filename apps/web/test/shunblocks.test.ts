import { test, expect, type Page } from "@playwright/test";
import {
  acceptFirstSignature,
  createIdentity,
  fixture,
  PASSPHRASE,
} from "./helpers.ts";

/**
 * The personal view sends a version 2 overlay whose `public_shun_issuer` is the
 * session identity. The core resolves that issuer's effective public shuns into
 * personal blocks and names the reason of each block in the reviewer list.
 * The tests that read those results need a core that accepts version 2.
 */

/** Chooses a signed view by its event ID on the Trust page. */
async function useView(page: Page, id: string) {
  await page.goto("/trust");
  await page.getByLabel("Signed view event ID").fill(id);
  await page.getByRole("button", { name: "Use this view" }).click();
  await expect(page.locator("main")).toContainText(`Signed view in use: ${id}`);
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
/** The outbox delivery states, as stored. */
const outboxStates = (page: Page) =>
  page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const items = await new LocalStore().list("outbox");
    return items.map((item: any) => item.peers?.self?.state ?? "none");
  });
/**
 * Whether the loaded core accepts a version 2 overlay for a personal
 * calculation. A core without that support loads the records but leaves every
 * score unavailable, because an invalid overlay never substitutes another
 * calculation. The answer is null when a word has real scores.
 */
async function coreAcceptsVersion2(
  page: Page,
  wordId: string,
): Promise<string | null> {
  return page.evaluate(async (wordId) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { PersonalCalculator } = await import(
      String("/src/data/personal.ts")
    );
    const store = new LocalStore();
    const identity = (await store.get("keys", "selected"))?.identity ?? null;
    const calc = new PersonalCalculator(store, async () => ({ identity }));
    const status = await calc.ensure({ mode: "personal", refresh: true });
    if (status.state !== "ready") return JSON.stringify(status);
    const ranking = await calc.rankWord(wordId, { mode: "personal" });
    return ranking.scores.length && ranking.calculation
      ? null
      : `the version 2 overlay left every score unavailable (${ranking.unavailable_scores.length} targets)`;
  }, wordId);
}
/** The reviewer row of a definition's breakdown for one identity. */
function reviewerRow(page: Page, definitionText: string, identity: string) {
  const details = page
    .locator("article.definition", { hasText: definitionText })
    .locator("details.judgment-details");
  return {
    details,
    row: details.locator("tbody tr", {
      has: page.locator(`a[href="/identity/${encodeURIComponent(identity)}"]`),
    }),
  };
}
async function openDetails(page: Page, definitionText: string) {
  const details = page
    .locator("article.definition", { hasText: definitionText })
    .locator("details.judgment-details");
  await expect(async () => {
    if ((await details.getAttribute("open")) === null)
      await details.locator("summary").click();
    expect(await details.getAttribute("open")).not.toBeNull();
    await expect(details.locator("tbody tr").first()).toBeVisible();
  }).toPass();
}
async function unlockIfAsked(page: Page) {
  const unlock = page.getByRole("dialog", { name: "Unlock your key" });
  if (await unlock.isVisible().catch(() => false)) {
    await unlock.getByLabel("Passphrase").fill(PASSPHRASE);
    await unlock.getByRole("button", { name: "Unlock" }).click();
  }
}

test("every personal calculation sends a version 2 overlay with the session identity as issuer, the saved preferences stay version 1, and another identity or no identity gives another digest", async ({
  page,
}) => {
  await createIdentity(page);
  const f = await fixture();
  const outcome = await page.evaluate(
    async ({ other }) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { PersonalCalculator, overlayDigest } = await import(
        String("/src/data/personal.ts")
      );
      const store = new LocalStore();
      const identity = (await store.get("keys", "selected")).identity;
      // Every worker load is recorded, whatever the core answers.
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
        const context = { identity: identity as string | null };
        const calc = new PersonalCalculator(store, async () => ({
          ...context,
        }));
        await calc.ensure({ mode: "personal" });
        const mine = loads.at(-1).input.overlay;
        // The same browser as another identity, and as nobody.
        context.identity = other;
        calc.invalidate();
        await calc.ensure({ mode: "personal" });
        const theirs = loads.at(-1).input.overlay;
        context.identity = null;
        calc.invalidate();
        await calc.ensure({ mode: "personal" });
        const nobody = loads.at(-1).input.overlay;
        const saved = await store.overlay();
        return {
          identity,
          mine,
          theirsIssuer: theirs.public_shun_issuer,
          nobodyIssuer: nobody.public_shun_issuer,
          digests: [mine, theirs, nobody].map((o) => overlayDigest(o)),
          saved,
          siteLoads: loads.filter((l) => l.input.overlay === null).length,
        };
      } finally {
        window.Worker = RealWorker;
      }
    },
    { other: f.identities.curator2 },
  );
  expect(outcome.mine.version).toBe(2);
  expect(outcome.mine.public_shun_issuer).toBe(outcome.identity);
  expect(Object.keys(outcome.mine).sort()).toEqual([
    "base_view",
    "blocked",
    "public_shun_issuer",
    "root_changes",
    "trust",
    "version",
    "work",
  ]);
  // No block is derived in the browser.
  expect(outcome.mine.blocked).toEqual([]);
  expect(outcome.theirsIssuer).toBe(f.identities.curator2);
  expect(outcome.nobodyIssuer).toBeNull();
  expect(new Set(outcome.digests).size).toBe(3);
  // The saved preferences are untouched version 1 without an issuer.
  expect(outcome.saved.version).toBe(1);
  expect("public_shun_issuer" in outcome.saved).toBe(false);
  expect(outcome.saved.blocked).toEqual([]);
});

test("a signed public shun is pending until delivered, an older snapshot's personal scores never include it, a recompute labels the block from the result, a private Ignore is labeled apart and survives a public clear", async ({
  page,
}) => {
  const f = await fixture();
  await createIdentity(page);
  await useView(page, f.views.shun);
  await choosePersonal(page);
  const support = await coreAcceptsVersion2(page, f.words.dunda);
  test.skip(
    support !== null,
    `needs the core that accepts a version 2 overlay: ${support}`,
  );
  await page.goto("/word/dunda");
  await expect(
    page.getByRole("region", { name: "Personal view" }),
  ).toContainText(/Personal view calculated in this browser/);
  const snapshotLine = page.locator("main p", { hasText: /^Snapshot / });
  const before = await snapshotLine.textContent();
  await openDetails(page, "Donates a gift");
  const curator = reviewerRow(page, "Donates a gift", f.identities.curator2);
  await expect(curator.row).toContainText("+9/2");
  // Delivery of the next record is slow. The shun is signed before it is delivered.
  await page.route("**/api/v1/events", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.continue();
  });
  await page.goto(`/identity/${encodeURIComponent(f.identities.curator2)}`);
  await page.getByRole("button", { name: "Ignore their judgments" }).click();
  await page.getByRole("radio", { name: /Publicly/ }).check();
  await page
    .getByRole("region", { name: /Ignore/ })
    .getByRole("button", { name: "Ignore", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: /Ignore publicly/ })
    .getByRole("button", { name: "Ignore publicly" })
    .click();
  await unlockIfAsked(page);
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toContainText(
    "Your personal view includes it after delivery, when you recompute for the snapshot that holds it.",
  );
  // While delivery is pending the stored record is not accepted, and the
  // personal scores of the older snapshot are unchanged.
  expect(await outboxStates(page)).not.toEqual(["accepted"]);
  await page.goto("/word/dunda");
  await expect(snapshotLine).toHaveText(before!);
  await expect(
    page.getByRole("button", { name: "Recompute for this snapshot" }),
  ).toBeHidden();
  await openDetails(page, "Donates a gift");
  await expect(curator.row).toContainText("+9/2");
  await expect(curator.row).not.toContainText("blocked");
  await page.unroute("**/api/v1/events");
  await expect
    .poll(() => outboxStates(page), { timeout: 20000 })
    .toEqual(["accepted"]);
  // The delivered shun moved the snapshot. The older calculation is refused
  // until an explicit recompute, which then blocks curator2 with its reason.
  await page.goto("/word/dunda");
  await page
    .getByRole("button", { name: "Recompute for this snapshot" })
    .click();
  await expect(
    page.getByRole("region", { name: "Personal view" }),
  ).toContainText(/Personal view calculated in this browser/);
  await expect(snapshotLine).not.toHaveText(before!);
  await openDetails(page, "Donates a gift");
  await expect(curator.row).toContainText(
    "blocked in your personal view by your public shun",
  );
  await expect(curator.row).not.toContainText("private choice");
  await expect(curator.row).toContainText("+0");
  // A private Ignore of delegate2 is labeled as a private choice.
  await page.goto(`/identity/${encodeURIComponent(f.identities.delegate2)}`);
  await page.getByRole("button", { name: "Ignore their judgments" }).click();
  await page.getByRole("radio", { name: /Just for me/ }).check();
  await expect(page.getByRole("region", { name: /Ignore/ })).toContainText(
    "A later public clear does not remove it.",
  );
  await page
    .getByRole("region", { name: /Ignore/ })
    .getByRole("button", { name: "Ignore", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Saved as a private block",
  );
  await page.goto("/word/dunda");
  await expect(
    page.getByRole("region", { name: "Personal view" }),
  ).toContainText(/Personal view calculated in this browser/);
  await openDetails(page, "Gives something");
  const delegate = reviewerRow(page, "Gives something", f.identities.delegate2);
  await expect(delegate.row).toContainText("blocked by your private choice");
  await expect(delegate.row).not.toContainText("public shun");
  // A public clear of curator2 lifts the public block after delivery and a
  // recompute. The private Ignore of delegate2 stays.
  await page.goto("/trust");
  await page.getByRole("button", { name: "Undo" }).click();
  await unlockIfAsked(page);
  await expect(page.getByRole("status")).toContainText(
    "A private Ignore stays until you remove it.",
  );
  await expect
    .poll(() => outboxStates(page), { timeout: 20000 })
    .toEqual(["accepted", "accepted"]);
  await page.goto("/word/dunda");
  await page
    .getByRole("button", { name: "Recompute for this snapshot" })
    .click();
  await expect(
    page.getByRole("region", { name: "Personal view" }),
  ).toContainText(/Personal view calculated in this browser/);
  await openDetails(page, "Donates a gift");
  await expect(curator.row).toContainText("+9/2");
  await expect(curator.row).not.toContainText("blocked");
  await openDetails(page, "Gives something");
  await expect(delegate.row).toContainText("blocked by your private choice");
});
