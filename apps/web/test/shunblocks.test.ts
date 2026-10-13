import { test, expect, type Page } from "@playwright/test";
import {
  acceptFirstSignature,
  createIdentity,
  fixture,
  openWord,
  PASSPHRASE,
} from "./helpers.ts";

/**
 * The personal view sends a version 2 overlay whose `public_shun_issuer` is the
 * session identity. The core resolves that issuer's effective public shuns into
 * personal blocks and names the reason of each block in the reviewer list.
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
/** A locked key asks for the passphrase before the first-signature notice. */
async function unlockIfAsked(page: Page) {
  const unlock = page.getByRole("dialog", { name: "Unlock your key" });
  const first = page.getByRole("dialog", {
    name: "Before your first public signature",
  });
  await expect(unlock.or(first)).toBeVisible();
  if (await unlock.isVisible()) {
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

/**
 * Signs a public trust choice from the identity page. The full page load locks
 * the key, so the passphrase is asked first. Only the first signature of a key
 * shows the first-signature notice. The caller waits for delivery.
 */
async function signPublic(
  page: Page,
  identity: string,
  mode: "trust" | "ignore",
  options: {
    first?: boolean;
    scope?: { kind: "definition" | "rafsi"; language?: string };
  } = {},
) {
  await page.goto(`/identity/${encodeURIComponent(identity)}`);
  await page
    .getByRole("button", {
      name:
        mode === "trust" ? "Trust their judgments" : "Ignore their judgments",
    })
    .click();
  const region = page.getByRole("region", {
    name: mode === "trust" ? /Trust/ : /Ignore/,
  });
  await region.getByRole("radio", { name: /Publicly/ }).check();
  if (options.scope) {
    await region
      .getByRole("button", { name: "limit by language, word, or rafsi" })
      .click();
    await region.getByLabel("Kind").selectOption(options.scope.kind);
    if (options.scope.language)
      await region
        .getByLabel("Definition language")
        .fill(options.scope.language);
  }
  await region
    .getByRole("button", {
      name: mode === "trust" ? "Trust" : "Ignore",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: mode === "trust" ? /^Trust: public/ : /Ignore publicly/,
  });
  await dialog
    .getByRole("button", {
      name: mode === "trust" ? "Trust" : "Ignore publicly",
    })
    .click();
  const unlock = page.getByRole("dialog", { name: "Unlock your key" });
  await expect(unlock).toBeVisible();
  await unlock.getByLabel("Passphrase").fill(PASSPHRASE);
  await unlock.getByRole("button", { name: "Unlock" }).click();
  if (options.first) await acceptFirstSignature(page);
}
const PENDING_NOTE =
  "Your personal view includes it after delivery, when you recompute for the snapshot that holds it.";
async function recomputeForSnapshot(page: Page, path: string) {
  await page.goto(path);
  await page
    .getByRole("button", { name: "Recompute for this snapshot" })
    .click();
  await expect(
    page.getByRole("region", { name: "Personal view" }),
  ).toContainText(/Personal view calculated in this browser/);
}

test("a signed public shun is pending until delivered and never changes an older snapshot, a recompute labels the block from the result, a private Trust rule does not cancel it, both reasons show on one reviewer, and the private reason survives a public clear", async ({
  page,
}) => {
  const f = await fixture();
  await createIdentity(page);
  await useView(page, f.views.shun);
  await choosePersonal(page);
  await page.goto("/word/dunda");
  await expect(
    page.getByRole("region", { name: "Personal view" }),
  ).toContainText(/Personal view calculated in this browser/);
  const snapshotLine = page.locator("main p", { hasText: /^Snapshot / });
  const before = await snapshotLine.textContent();
  await openDetails(page, "Donates a gift");
  const curator = reviewerRow(page, "Donates a gift", f.identities.curator2);
  await expect(curator.row).toContainText("+9/2");
  // The first delivery is held by the test, then answered with a server
  // error. Delivery stays pending until the test releases it.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v1/events", async (route) => {
    await held;
    await route.fulfill({ status: 503, json: { error: "held by the test" } });
  });
  await signPublic(page, f.identities.curator2, "ignore", { first: true });
  // The signed record is stored and its delivery is still pending.
  await expect.poll(() => outboxStates(page)).toEqual(["queued"]);
  // The older snapshot is unchanged: same snapshot, same weight, no recompute
  // offer. The word page opens inside the app, so the pending request lives on.
  await openWord(page, "dunda");
  await expect(snapshotLine).toHaveText(before!);
  await expect(
    page.getByRole("button", { name: "Recompute for this snapshot" }),
  ).toBeHidden();
  await openDetails(page, "Donates a gift");
  await expect(curator.row).toContainText("+9/2");
  await expect(curator.row).not.toContainText("blocked");
  expect(await outboxStates(page)).toEqual(["queued"]);
  // The test releases the request. The server error leaves delivery unknown,
  // and the status says what the signature means for the personal view.
  release();
  await expect
    .poll(() => outboxStates(page), { timeout: 20000 })
    .toEqual(["unknown"]);
  await expect(page.getByRole("status")).toContainText(
    "Delivery is not finished.",
  );
  await expect(page.getByRole("status")).toContainText(PENDING_NOTE);
  await expect(
    page.getByRole("link", { name: "1 not delivered" }),
  ).toBeVisible();
  // An explicit retry delivers the record.
  await page.unroute("**/api/v1/events");
  await page.getByRole("link", { name: "1 not delivered" }).click();
  await page.getByRole("button", { name: "Try now" }).click();
  await expect
    .poll(() => outboxStates(page), { timeout: 20000 })
    .toEqual(["accepted"]);
  // The delivered shun moved the snapshot. The older calculation is refused
  // until an explicit recompute, which then blocks curator2 with its reason.
  await recomputeForSnapshot(page, "/word/dunda");
  await expect(snapshotLine).not.toHaveText(before!);
  await openDetails(page, "Donates a gift");
  await expect(curator.row).toContainText(
    "blocked in your personal view by your public shun",
  );
  await expect(curator.row).not.toContainText("private choice");
  await expect(curator.row).toContainText("+0");
  // A private Trust rule for curator2 does not cancel the public block.
  await page.goto(`/identity/${encodeURIComponent(f.identities.curator2)}`);
  await page.getByRole("button", { name: "Trust their judgments" }).click();
  const trustRegion = page.getByRole("region", { name: /Trust/ });
  await trustRegion.getByRole("radio", { name: /Just for me/ }).check();
  await expect(trustRegion).toContainText(
    "It does not cancel a block from your own public shun.",
  );
  await trustRegion.getByRole("button", { name: "Trust", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "Saved as a private rule",
  );
  await page.goto("/word/dunda");
  await expect(
    page.getByRole("region", { name: "Personal view" }),
  ).toContainText(/Personal view calculated in this browser/);
  await openDetails(page, "Donates a gift");
  await expect(curator.row).toContainText(
    "blocked in your personal view by your public shun",
  );
  await expect(curator.row).toContainText("+0");
  // A private Ignore of the same person adds the second reason.
  await page.goto(`/identity/${encodeURIComponent(f.identities.curator2)}`);
  await page.getByRole("button", { name: "Ignore their judgments" }).click();
  const ignoreRegion = page.getByRole("region", { name: /Ignore/ });
  await ignoreRegion.getByRole("radio", { name: /Just for me/ }).check();
  await expect(ignoreRegion).toContainText(
    "A later public clear does not remove it.",
  );
  await ignoreRegion
    .getByRole("button", { name: "Ignore", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Saved as a private block",
  );
  await page.goto("/word/dunda");
  await expect(
    page.getByRole("region", { name: "Personal view" }),
  ).toContainText(/Personal view calculated in this browser/);
  await openDetails(page, "Donates a gift");
  await expect(curator.row).toContainText(
    "blocked in your personal view by your public shun and blocked by your private choice",
  );
  // A public clear lifts the public reason after delivery and a recompute.
  // The private reason stays.
  await page.goto("/trust");
  await page.getByRole("button", { name: "Undo" }).click();
  await unlockIfAsked(page);
  await expect(
    page.getByRole("status").filter({ hasText: /Signed a clear/ }),
  ).toContainText("A private Ignore stays until you remove it.");
  await expect
    .poll(() => outboxStates(page), { timeout: 20000 })
    .toEqual(["accepted", "accepted"]);
  await recomputeForSnapshot(page, "/word/dunda");
  await openDetails(page, "Donates a gift");
  await expect(curator.row).toContainText("blocked by your private choice");
  await expect(curator.row).not.toContainText("public shun");
  await expect(curator.row).toContainText("+0");
});

test("a broad public shun with a narrower public heed blocks a reviewer in the rafsi context only, and the English definition context keeps the route", async ({
  page,
}) => {
  const f = await fixture();
  await createIdentity(page);
  await choosePersonal(page);
  // The curator judged an English definition of cukta and the rafsi claim cku.
  await signPublic(page, f.identities.curator, "ignore", { first: true });
  await expect
    .poll(() => outboxStates(page), { timeout: 20000 })
    .toEqual(["accepted"]);
  await signPublic(page, f.identities.curator, "trust", {
    scope: { kind: "definition", language: "en" },
  });
  await expect(page.getByRole("status")).toContainText(PENDING_NOTE);
  await expect
    .poll(() => outboxStates(page), { timeout: 20000 })
    .toEqual(["accepted", "accepted"]);
  // The Trust page lists both public choices with their scopes.
  await page.goto("/trust");
  await expect(page.locator("main")).toContainText(
    "definitions, language en only",
  );
  // No personal calculation ran before the signatures, so the first one is
  // for the snapshot that holds both records.
  await page.goto("/word/cukta");
  await expect(
    page.getByRole("region", { name: "Personal view" }),
  ).toContainText(/Personal view calculated in this browser/);
  // English definition context: the narrower heed overrides the broad shun.
  const curated = page.locator("article.definition", {
    has: page.locator(
      `a[href="/definition/${encodeURIComponent(f.definitions.cukta1)}"]`,
    ),
  });
  await expect(async () => {
    const details = curated.locator("details.judgment-details");
    if ((await details.getAttribute("open")) === null)
      await details.locator("summary").click();
    await expect(details.locator("tbody tr").first()).toBeVisible();
  }).toPass();
  const curatorRow = curated.locator("tbody tr", {
    has: page.locator(
      `a[href="/identity/${encodeURIComponent(f.identities.curator)}"]`,
    ),
  });
  await expect(curatorRow).not.toContainText("blocked");
  await expect(curatorRow).toContainText("trusted by");
  await expect(curatorRow).not.toContainText("+0");
  // Rafsi context: the broad shun stands, and the result names the reason.
  await page.goto("/rafsi/cku");
  const card = page.getByRole("region", { name: "cku for cukta" });
  await expect(card.getByRole("img")).toHaveAttribute(
    "aria-label",
    /in your personal view$/,
  );
  await expect(async () => {
    const details = card.locator("details.judgment-details");
    if ((await details.getAttribute("open")) === null)
      await details.locator("summary").click();
    await expect(details.locator("tbody tr").first()).toBeVisible();
  }).toPass();
  const rafsiRow = card.locator("tbody tr", {
    has: page.locator(
      `a[href="/identity/${encodeURIComponent(f.identities.curator)}"]`,
    ),
  });
  await expect(rafsiRow).toContainText(
    "blocked in your personal view by your public shun",
  );
  await expect(rafsiRow).not.toContainText("private choice");
  await expect(rafsiRow).toContainText("+0");
});
