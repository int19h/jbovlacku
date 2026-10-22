import { test, expect, type Page } from "@playwright/test";
import {
  acceptFirstSignature,
  corePath,
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
  ).toContainText(/Personal view calculated in this browser/, {
    // The calculation is CPU-bound and slows down late in a full browser run.
    timeout: 60000,
  });
}

test("a signed public shun is pending until delivered and never changes an older snapshot, a recompute labels the block from the result, a private Trust rule does not cancel it, both reasons show on one reviewer, and the private reason survives a public clear", async ({
  page,
}) => {
  test.slow();
  const f = await fixture();
  await createIdentity(page);
  await useView(page, f.views.shun);
  await choosePersonal(page);
  await page.goto("/word/dunda");
  await expect(
    page.getByRole("region", { name: "Personal view" }),
  ).toContainText(/Personal view calculated in this browser/, {
    // The calculation is CPU-bound and slows down late in a full browser run.
    timeout: 60000,
  });
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
  ).toContainText(/Personal view calculated in this browser/, {
    // The calculation is CPU-bound and slows down late in a full browser run.
    timeout: 60000,
  });
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
  ).toContainText(/Personal view calculated in this browser/, {
    // The calculation is CPU-bound and slows down late in a full browser run.
    timeout: 60000,
  });
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
  ).toContainText(/Personal view calculated in this browser/, {
    // The calculation is CPU-bound and slows down late in a full browser run.
    timeout: 60000,
  });
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

/** Holds every event POST and answers it with a server error. */
async function failDelivery(page: Page) {
  await page.route("**/api/v1/events", (route) =>
    route.fulfill({ status: 503, json: { error: "held by the test" } }),
  );
}
async function retryDelivery(page: Page, expected: string[]) {
  await page.unroute("**/api/v1/events");
  await page.getByRole("link", { name: /not delivered/ }).click();
  await page.getByRole("button", { name: "Try now" }).first().click();
  await expect
    .poll(() => outboxStates(page), { timeout: 20000 })
    .toEqual(expected);
}
const shellStatus = (page: Page) => page.locator("div.status[role=status]");

test("Make public and Undo on the Trust page say when delivery is not finished, and say that others can build on an accepted record", async ({
  page,
}) => {
  const f = await fixture();
  await createIdentity(page);
  // Two private choices: a block of curator2 and a rule for delegate2.
  await page.goto(`/identity/${encodeURIComponent(f.identities.curator2)}`);
  await page.getByRole("button", { name: "Ignore their judgments" }).click();
  await page.getByRole("radio", { name: /Just for me/ }).check();
  await page
    .getByRole("region", { name: /Ignore/ })
    .getByRole("button", { name: "Ignore", exact: true })
    .click();
  await expect(shellStatus(page)).toContainText("Saved as a private block");
  await page.goto(`/identity/${encodeURIComponent(f.identities.delegate2)}`);
  await page.getByRole("button", { name: "Trust their judgments" }).click();
  await page.getByRole("radio", { name: /Just for me/ }).check();
  await page
    .getByRole("region", { name: /Trust/ })
    .getByRole("button", { name: "Trust", exact: true })
    .click();
  await expect(shellStatus(page)).toContainText("Saved as a private rule");
  const blockedRow = page
    .locator("div.row", { hasText: "also blocks trust that passes through" })
    .filter({ hasText: f.identities.curator2.slice(8, 12) });
  const ruleRow = page
    .locator("div.row", { hasText: f.identities.delegate2.slice(8, 12) })
    .filter({ hasText: "private" })
    .filter({ hasNotText: "also blocks" });
  // Make public with a failing delivery: saved here, not finished, pending rule.
  await page.goto("/trust");
  await failDelivery(page);
  await blockedRow.getByRole("button", { name: "Make public" }).click();
  await page
    .getByRole("dialog", { name: "Ignore publicly: public signed record" })
    .getByRole("button", { name: "Ignore publicly" })
    .click();
  await unlockIfAsked(page);
  await acceptFirstSignature(page);
  await expect(shellStatus(page)).toContainText(
    "Signed and saved here. Delivery is not finished. See Not delivered.",
  );
  await expect(shellStatus(page)).toContainText(PENDING_NOTE);
  await expect(shellStatus(page)).not.toContainText("Others can build on it");
  expect(await outboxStates(page)).toEqual(["unknown"]);
  await retryDelivery(page, ["accepted"]);
  // Undo with a failing delivery: the clear is saved here and not finished,
  // and the private Ignore stays.
  await page.goto("/trust");
  await failDelivery(page);
  const publicRow = page
    .locator("div.row", { hasText: "public" })
    .filter({ hasText: f.identities.curator2.slice(8, 12) })
    .filter({ hasNotText: "private" });
  await publicRow.getByRole("button", { name: "Undo" }).click();
  await unlockIfAsked(page);
  await expect(shellStatus(page)).toContainText(
    "Signed a clear and saved here. Delivery is not finished. See Not delivered.",
  );
  await expect(shellStatus(page)).toContainText(
    "A private Ignore stays until you remove it.",
  );
  // The outbox lists records by ID, so the states are compared as a set.
  expect((await outboxStates(page)).sort()).toEqual(["accepted", "unknown"]);
  await retryDelivery(page, ["accepted", "accepted"]);
  // Control: an accepted delivery says that others can build on it.
  await page.goto("/trust");
  await ruleRow.getByRole("button", { name: "Make public" }).click();
  await page
    .getByRole("dialog", { name: "Trust: public signed record" })
    .getByRole("button", { name: "Trust" })
    .click();
  await unlockIfAsked(page);
  await expect(shellStatus(page)).toContainText(
    "Signed. Others can build on it. It stays in history after you undo it.",
  );
  await expect(shellStatus(page)).toContainText(PENDING_NOTE);
  await expect(shellStatus(page)).not.toContainText("saved here");
  expect(await outboxStates(page)).toEqual([
    "accepted",
    "accepted",
    "accepted",
  ]);
  // Control: an accepted clear.
  await page.goto("/trust");
  const publicRule = page
    .locator("div.row", { hasText: "public" })
    .filter({ hasText: f.identities.delegate2.slice(8, 12) })
    .filter({ hasNotText: "private" });
  await publicRule.getByRole("button", { name: "Undo" }).click();
  await unlockIfAsked(page);
  await expect(shellStatus(page)).toContainText(
    "Signed a clear. The earlier public choice stays in history.",
  );
  await expect(shellStatus(page)).not.toContainText("saved here");
  await expect(shellStatus(page)).toContainText(
    "A private Ignore stays until you remove it.",
  );
});

test("the public shun preview says that the signed view did not load and why, on the identity page and the Trust page, for a failed manifest, a silent server, and an unavailable body", async ({
  page,
}) => {
  const f = await fixture();
  await createIdentity(page);
  await page.goto(`/identity/${encodeURIComponent(f.identities.curator2)}`);
  await page.getByRole("button", { name: "Ignore their judgments" }).click();
  await page.getByRole("radio", { name: /Just for me/ }).check();
  await page
    .getByRole("region", { name: /Ignore/ })
    .getByRole("button", { name: "Ignore", exact: true })
    .click();
  await expect(shellStatus(page)).toContainText("Saved as a private block");
  // The manifest request fails. The preview keeps the reason, on both pages.
  const manifest = "**/api/v1/manifest*";
  await page.route(manifest, (route) =>
    route.fulfill({
      status: 503,
      json: {
        code: "resource_unavailable",
        message: "Root manifest outage",
        event: null,
        field: null,
      },
    }),
  );
  const dialog = page.getByRole("dialog", { name: /Ignore publicly/ });
  await page.goto(`/identity/${encodeURIComponent(f.identities.curator2)}`);
  await page.getByRole("button", { name: "Ignore their judgments" }).click();
  await page.getByRole("radio", { name: /Publicly/ }).check();
  await page
    .getByRole("region", { name: /Ignore/ })
    .getByRole("button", { name: "Ignore", exact: true })
    .click();
  await expect(dialog).toContainText(
    "The signed view in use did not load, so its route rule is unavailable:",
  );
  await expect(dialog).toContainText("Root manifest outage");
  await expect(dialog).not.toContainText("does not know");
  await expect(dialog).not.toContainText("null");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.goto("/trust");
  const blockedRow = page
    .locator("div.row", { hasText: "also blocks trust that passes through" })
    .filter({ hasText: f.identities.curator2.slice(8, 12) });
  await blockedRow.getByRole("button", { name: "Make public" }).click();
  await expect(dialog).toContainText("Root manifest outage");
  await expect(dialog).not.toContainText("null");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.unroute(manifest);
  // The server does not answer the view probe. The view cannot load.
  const probe = "**/api/v1/words/jvw1%3A0000*";
  await page.route(probe, (route) =>
    route.fulfill({
      status: 503,
      json: {
        code: "resource_unavailable",
        message: "unavailable",
        event: null,
        field: null,
      },
    }),
  );
  await page.goto(`/identity/${encodeURIComponent(f.identities.curator2)}`);
  await page.getByRole("button", { name: "Ignore their judgments" }).click();
  await page.getByRole("radio", { name: /Publicly/ }).check();
  await page
    .getByRole("region", { name: /Ignore/ })
    .getByRole("button", { name: "Ignore", exact: true })
    .click();
  await expect(dialog).toContainText(
    "The signed view in use did not load, so its route rule is unavailable: The server did not report its selected view.",
  );
  await expect(dialog).not.toContainText("does not know");
  await expect(dialog).toContainText(
    "In your own personal view it also acts as a block.",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.goto("/trust");
  await blockedRow.getByRole("button", { name: "Make public" }).click();
  await expect(dialog).toContainText(
    "The signed view in use did not load, so its route rule is unavailable",
  );
  await expect(dialog).not.toContainText("does not know");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.unroute(probe);
  // A signed view that names a profile this client does not know does not
  // satisfy the core's body rules, so its body is unavailable. The preview
  // reports that load failure with its reason, not an unknown profile. The
  // test signs such a view with the core and serves its record.
  const future = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const canon = (value: unknown) =>
      core.canonicalize(core.utf8(JSON.stringify(value)));
    const seed = new Uint8Array(32).fill(203);
    const body = {
      name: "Future view",
      description: [["A profile this client does not know."]],
      roots: [
        {
          identity: core.identityFromSeed(seed),
          q: { numerator: 1, denominator: 1 },
        },
      ],
      rafsi_threshold: { numerator: 1, denominator: 1 },
      H: { numerator: 3, denominator: 1 },
      alpha: { numerator: 1, denominator: 2 },
      excluded: [],
      calculation: "simple-routes-future-v9",
      work: 10000,
      import_sets: [],
      account_witnesses: [],
      account_authority: false,
      notes: [],
    };
    const bodyText = canon(body);
    const hash = core.contentHash(core.utf8(bodyText));
    const envelope = core.signHeader(seed, {
      version: 1,
      issuer: core.identityFromSeed(seed),
      previous: [],
      nonce: "e".repeat(32),
      action: { kind: "view.publish", parents: [] },
      content: { hash, bytes: core.utf8(bodyText).length },
    });
    return { id: envelope.id, envelopeText: canon(envelope), bodyText, hash };
  }, corePath);
  await page.route(probe, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.view = future.id;
    await route.fulfill({ response, json: body });
  });
  await page.route(
    `**/api/v1/events/${encodeURIComponent(future.id)}*`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: future.envelopeText,
      }),
  );
  await page.route(
    `**/api/v1/bodies/${encodeURIComponent(future.hash)}*`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: future.bodyText,
      }),
  );
  await page.goto("/trust");
  await expect(page.locator("main")).toContainText(`View event ${future.id}`);
  await blockedRow.getByRole("button", { name: "Make public" }).click();
  await expect(dialog).toContainText(
    "The signed view in use did not load, so its route rule is unavailable: This signed body does not satisfy the format rules.",
  );
  await expect(dialog).not.toContainText("does not know");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(await outboxStates(page)).toEqual([]);
});
