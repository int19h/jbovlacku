import { test, expect, type Page } from "@playwright/test";
import {
  acceptFirstSignature,
  corePath,
  createIdentity,
  fixture,
  openWord,
  PASSPHRASE,
} from "./helpers.ts";

async function outboxItems(page: Page) {
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().list("outbox");
  });
}
async function endorseFirst(page: Page, word = "cukta") {
  await openWord(page, word);
  const endorse = page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" });
  await endorse.click();
}
/** Creates the successor key on the handover page and passes its backup test. */
async function createSuccessor(page: Page) {
  await page.getByLabel("New passphrase for the new key").fill(PASSPHRASE);
  await page.getByLabel("Repeat passphrase").fill(PASSPHRASE);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Create the new key" }).click();
  await page
    .getByRole("button", { name: "Download the new key's backup" })
    .click();
  const download = await downloadPromise;
  const path = await download.path();
  const fingerprint = (
    await page
      .getByRole("region", { name: "New key" })
      .locator(".fingerprint")
      .innerText()
  ).replace(/\s+/g, "");
  await page.getByLabel("Backup file").setInputFiles(path!);
  await page.getByLabel("Its passphrase").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Test the backup" }).click();
  await expect(page.getByRole("status").last()).toContainText(
    "recovers the new key",
  );
  return "ed25519:" + fingerprint.replace(/^ed25519/, "");
}

// Mirror routes fetch from the page. A route handler that is still running
// when the test ends must not fail the test after the browser closes.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
test("a planned handover persists both events and the new key before upload, survives a partial upload, and retries without a new signature", async ({
  page,
}) => {
  const old = await createIdentity(page);
  await endorseFirst(page);
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toHaveText(
    "Your endorsement is published.",
  );
  let posts = 0;
  await page.route("**/api/v1/events", async (route) => {
    posts++;
    // The second upload, the acceptance, fails.
    if (posts === 2) {
      await route.fulfill({
        status: 503,
        json: { code: "busy", message: "Later.", event: null, field: null },
      });
      return;
    }
    await route.continue();
  });
  await page.getByRole("link", { name: /key (unlocked|locked)/ }).click();
  await page.getByRole("link", { name: "Start" }).click();
  await expect(
    page.getByRole("heading", { name: "Move to a new key" }),
  ).toBeVisible();
  const successor = await createSuccessor(page);
  await expect(page.getByText(/One known head/)).toBeVisible();
  await expect(page.getByText(/127\.0\.0\.1:\d+: one head/)).toBeVisible();
  const sign = page.getByRole("button", { name: "Sign the handover" });
  await expect(sign).toBeDisabled();
  for (const box of await page.getByRole("checkbox").all()) await box.check();
  await expect(sign).toBeEnabled();
  await sign.click();
  await expect(page.getByRole("status")).toContainText("Old key retired");
  await expect(
    page.getByRole("region", { name: "Handover status" }),
  ).toContainText("Old key retired, acceptance waiting.");
  // Both events and the new key were saved together.
  const items = await outboxItems(page);
  const transfer = items.find((i: any) => i.label.action === "key handover");
  const accept = items.find(
    (i: any) => i.label.action === "handover acceptance",
  );
  expect(transfer.identity).toBe(old.identity);
  expect(accept.identity).toBe(successor);
  expect(JSON.parse(accept.transport).envelope.header.previous).toEqual([]);
  expect(JSON.parse(accept.transport).envelope.header.action.transfer).toBe(
    transfer.id,
  );
  expect(transfer.peers.self.state).toBe("accepted");
  expect(accept.peers.self.state).toBe("unknown");
  const keys = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    return {
      selected: (await store.get("keys", "selected")).identity,
      retired: await store.keys("keys"),
    };
  });
  expect(keys.selected).toBe(successor);
  expect(keys.retired).toContain(`retired:${old.identity}`);
  // The page shows the new key and the old key's state.
  await expect(page.locator("main h1")).toContainText(
    `${successor.slice(8, 12)}…${successor.slice(-4)}`,
  );
  await expect(page.getByText("Unlocked", { exact: true })).toBeVisible();
  // Retry after a reload reuses the stored acceptance.
  await page.unroute("**/api/v1/events");
  await page.reload();
  await page.getByRole("link", { name: "1 not delivered" }).click();
  await expect(page.getByText(/handover acceptance/)).toBeVisible();
  await page.getByRole("button", { name: "Try now" }).click();
  await expect(page.getByRole("status")).toHaveText("Delivered.");
  const after = await outboxItems(page);
  expect(after.map((i: any) => i.id).sort()).toEqual(
    items.map((i: any) => i.id).sort(),
  );
  expect(after.find((i: any) => i.id === accept.id).peers.self.state).toBe(
    "accepted",
  );
  await page.goto("/identity");
  await expect(
    page.getByRole("region", { name: "Handover status" }),
  ).toContainText("Handover complete");
  // The server reports the succession, and the old key's ordinary signing is disabled.
  await page.goto(`/identity/${encodeURIComponent(old.identity)}`);
  await expect(page.getByText(/Known successor/)).toBeVisible();
  await page.goto("/identity/transfer");
  await expect(page.getByText(/is the successor of/)).toBeVisible();
  // The new key signs ordinary actions through its acceptance link.
  await page.goto("/identity");
  await page.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await openWord(page, "vlacku");
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await expect(page.getByRole("status")).toHaveText(
    "Your endorsement is published.",
  );
  const latest = (await outboxItems(page))
    .sort((a: any, b: any) => a.signedAt - b.signedAt)
    .at(-1);
  expect(latest.identity).toBe(successor);
  expect(JSON.parse(latest.transport).envelope.header.previous).toEqual([
    accept.id,
  ]);
  void fixture;
});

test("a compromise notice previews retained and excluded records, needs approval for an empty frontier, and disables ordinary signing", async ({
  page,
}) => {
  const me = await createIdentity(page);
  await endorseFirst(page, "cukta");
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toHaveText(
    "Your endorsement is published.",
  );
  await endorseFirst(page, "vlacku");
  await expect(page.getByRole("status")).toHaveText(
    "Your endorsement is published.",
  );
  await page.getByRole("link", { name: /key (unlocked|locked)/ }).click();
  await page.getByRole("link", { name: "Report" }).click();
  await expect(
    page.getByRole("heading", { name: "Report a stolen key" }),
  ).toBeVisible();
  const records = page.getByRole("list", {
    name: "Own records in causal order",
  });
  await expect(records.getByRole("checkbox")).toHaveCount(2);
  // The format limit for named safe records is shown before signing.
  await expect(page.locator("main")).toContainText("0 of 64 records named.");
  await expect(page.locator("main")).toContainText(
    "A notice names at most 64 records.",
  );
  const preview = page.getByRole("region", { name: "Cutoff preview" });
  await expect(preview).toContainText("Retained: nothing");
  await expect(preview).toContainText(
    /Excluded: endorsement on .*; endorsement on/,
  );
  const sign = page.getByRole("button", { name: "Sign the notice" });
  await expect(sign).toBeDisabled();
  await expect(
    page.getByRole("checkbox", { name: /disabling all authority/ }),
  ).toBeVisible();
  // Choose the first endorsement as the last trusted record.
  await records.getByRole("checkbox").first().check();
  await expect(preview).toContainText(/Retained: endorsement on [^;]*\./);
  await expect(preview).toContainText(/Excluded: endorsement on [^;]*\./);
  await expect(
    page.getByRole("checkbox", { name: /disabling all authority/ }),
  ).toHaveCount(0);
  await page
    .getByRole("checkbox", { name: /cannot prove which holder/ })
    .check();
  await expect(sign).toBeEnabled();
  await sign.click();
  await expect(page.getByRole("status")).toContainText(
    "compromise notice is saved",
  );
  await expect(
    page.getByText(/Ordinary actions from this key are disabled/),
  ).toBeVisible();
  const items = await outboxItems(page);
  const notice = items.find((i: any) => i.label.action === "compromise notice");
  const action = JSON.parse(notice.transport).envelope.header.action;
  expect(action.safe).toHaveLength(1);
  await expect
    .poll(
      async () =>
        (await outboxItems(page)).find((i: any) => i.id === notice.id).peers
          .self.state,
    )
    .toBe("accepted");
  await page.goto(`/identity/${encodeURIComponent(me.identity)}`);
  await expect(page.getByText(/compromise notice/i).first()).toBeVisible();
  // Ordinary signing from the compromised key is refused.
  await page.getByRole("link", { name: /key (unlocked|locked)/ }).click();
  await page.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await openWord(page, "ckusro");
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "compromise notice. Ordinary actions from it are disabled",
  );
});

test("missing history blocks a confident compromise preview", async ({
  page,
}) => {
  await createIdentity(page);
  await endorseFirst(page, "cukta");
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toHaveText(
    "Your endorsement is published.",
  );
  // Remember a head that no server and no outbox copy can supply.
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const selected = await store.get("keys", "selected");
    const heads = (await store.get("heads", selected.identity)) ?? [];
    await store.put("heads", selected.identity, [
      ...heads,
      "jve1:" + "f".repeat(64),
    ]);
  });
  await page.goto("/identity/compromise");
  await expect(
    page.getByText(
      /could not be established|no signed record for a remembered history reference/,
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign the notice" }),
  ).toHaveCount(0);
});

/** Configures a second recipient served through a routed path on this origin and unlocks again. */
async function addMirrorPeer(page: Page) {
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().setPreferences({
      peers: [
        { id: "self", base: "/api/v1", label: "this server" },
        { id: "mirror", base: "/mirror/api/v1", label: "mirror" },
      ],
    });
  });
  await page.goto("/identity");
  await page.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByText("Unlocked", { exact: true })).toBeVisible();
}

test("a handover fetches a branch that only a second peer holds, blocks while that branch cannot be supplied, and then follows it", async ({
  page,
}) => {
  const { branch, mode } = await mirrorBranchSetup(page);
  // The mirror reports the branch but cannot supply it. The ordinary handover is blocked, not acknowledged away.
  mode.supply = false;
  await page.goto("/identity/transfer");
  await expect(knownHistory(page)).toContainText(
    /mirror reports record .* but could not supply it as a valid signed record/,
  );
  await createSuccessor(page);
  await expect(
    page.getByText("The old key's state blocks the handover."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign the handover" }),
  ).toHaveCount(0);
  expect(
    (await outboxItems(page)).some(
      (i: any) => i.label.action === "key handover",
    ),
  ).toBe(false);
  // The mirror supplies the branch. It is fetched, verified, kept, and the transfer follows it.
  mode.supply = true;
  await page.goto("/identity/transfer");
  await expect(knownHistory(page)).toContainText(
    "One known head over 2 verified records, 1 fetched from other peers",
  );
  await expect(knownHistory(page)).toContainText(
    "mirror: one head, scan complete.",
  );
  await createSuccessor(page);
  for (const box of await page.getByRole("checkbox").all()) await box.check();
  await page.getByRole("button", { name: "Sign the handover" }).click();
  const unlock = page.getByRole("dialog", { name: "Unlock your key" });
  await unlock.getByLabel("Passphrase").fill(PASSPHRASE);
  await unlock.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("status").last()).toContainText(
    "Old key retired",
  );
  const transfer = (await outboxItems(page)).find(
    (i: any) => i.label.action === "key handover",
  );
  expect(JSON.parse(transfer.transport).envelope.header.previous).toEqual([
    branch.id,
  ]);
});

test("a handover is refused without saving or sending when another tab retired the key, and a double click signs once", async ({
  page,
}) => {
  const old = await createIdentity(page);
  await endorseFirst(page, "cukta");
  await acceptFirstSignature(page);
  await expect(page.getByRole("status").last()).toHaveText(
    "Your endorsement is published.",
  );
  await page.getByRole("link", { name: /key (unlocked|locked)/ }).click();
  await page.getByRole("link", { name: "Start" }).click();
  await createSuccessor(page);
  await expect(page.getByText(/One known head/)).toBeVisible();
  for (const box of await page.getByRole("checkbox").all()) await box.check();
  // Another tab retires the key between the preview and the click.
  await page.evaluate(async (identity) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    await store.put("keys", `handover:${identity}`, {
      old: identity,
      successor: "ed25519:" + "9".repeat(64),
      transfer: "jve1:" + "9".repeat(64),
      accept: "jve1:" + "8".repeat(64),
      signedAt: 1,
    });
  }, old.identity);
  await page.getByRole("button", { name: "Sign the handover" }).click();
  await expect(page.getByRole("status").last()).toContainText(
    "retired or reported stolen meanwhile. Nothing was saved or sent",
  );
  let items = await outboxItems(page);
  expect(
    items.filter((i: any) => i.label.action === "key handover"),
  ).toHaveLength(0);
  expect(
    items.filter((i: any) => i.label.action === "handover acceptance"),
  ).toHaveLength(0);
  const selected = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return (await new LocalStore().get("keys", "selected")).identity;
  });
  expect(selected).toBe(old.identity);
  // Ordinary group persistence is refused for the retired key too.
  const refused = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const [item] = await store.list("outbox");
    try {
      await store.queueGroup([{ ...item, id: item.id }]);
      return null;
    } catch (error) {
      return String(error);
    }
  });
  expect(refused).toContain("retired");
  // Remove the simulated record. A delayed history check keeps a second click from signing twice.
  await page.evaluate(async (identity) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().delete("keys", `handover:${identity}`);
  }, old.identity);
  await page.route("**/api/v1/identity-heads/**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue();
  });
  for (const box of await page.getByRole("checkbox").all()) await box.check();
  const sign = page.getByRole("button", { name: "Sign the handover" });
  await sign.click();
  const checking = page.getByRole("button", {
    name: "Checking the known history…",
  });
  await expect(checking).toBeDisabled();
  // The disabled attribute alone would stop a click. Re-enable the button so
  // the second click reaches the handler, where the signing guard refuses it.
  await checking.evaluate((node: HTMLButtonElement) => {
    node.disabled = false;
  });
  await checking.click();
  await expect(checking).toHaveText("Checking the known history…");
  await expect(page.getByRole("status").last()).toContainText(
    "Old key retired",
  );
  items = await outboxItems(page);
  expect(
    items.filter((i: any) => i.label.action === "key handover"),
  ).toHaveLength(1);
  expect(
    items.filter((i: any) => i.label.action === "handover acceptance"),
  ).toHaveLength(1);
});

test("a retired key signs a compromise notice through a masked passphrase field", async ({
  page,
}) => {
  const old = await createIdentity(page);
  await endorseFirst(page, "cukta");
  await acceptFirstSignature(page);
  await expect(page.getByRole("status").last()).toHaveText(
    "Your endorsement is published.",
  );
  await page.getByRole("link", { name: /key (unlocked|locked)/ }).click();
  await page.getByRole("link", { name: "Start" }).click();
  await createSuccessor(page);
  await expect(page.getByText(/One known head/)).toBeVisible();
  for (const box of await page.getByRole("checkbox").all()) await box.check();
  await page.getByRole("button", { name: "Sign the handover" }).click();
  await expect(page.getByRole("status").last()).toContainText(
    "Old key retired",
  );
  await expect
    .poll(async () =>
      (await outboxItems(page)).every(
        (i: any) => i.peers.self.state === "accepted",
      ),
    )
    .toBe(true);
  // The retired key is offered on the notice page. Its passphrase is entered in a password field.
  await page.goto("/identity/compromise");
  await page.getByLabel("Which key").selectOption(old.identity);
  const records = page.getByRole("list", {
    name: "Own records in causal order",
  });
  await expect(records.getByRole("checkbox")).toHaveCount(2);
  await records.getByRole("checkbox").first().check();
  await page
    .getByRole("checkbox", { name: /cannot prove which holder/ })
    .check();
  await page.getByRole("button", { name: "Sign the notice" }).click();
  const dialog = page.getByRole("dialog", { name: /Unlock the retired key/ });
  await expect(dialog).toBeVisible();
  const pass = dialog.getByLabel("Passphrase of the retired key");
  await expect(pass).toHaveAttribute("type", "password");
  await pass.fill("wrong passphrase here");
  await dialog.getByRole("button", { name: "Unlock" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await pass.fill(PASSPHRASE);
  await dialog.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("status").last()).toContainText(
    "compromise notice is saved",
  );
  const notice = (await outboxItems(page)).find(
    (i: any) => i.label.action === "compromise notice",
  );
  expect(notice.identity).toBe(old.identity);
  expect(JSON.parse(notice.transport).envelope.header.action.safe).toHaveLength(
    1,
  );
});

/** The mirror's behavior, changed by the test between phases. */
interface MirrorMode {
  down: boolean;
  supply: boolean;
  activity: "ok" | "repeat" | "wrong-snapshot" | "abort" | "hang" | "bad-shape";
  heads: "ok" | "endless";
}
/**
 * Creates a key with one record on this server and one record that only the
 * mirror holds, then routes the mirror according to the mode.
 */
async function mirrorBranchSetup(page: Page) {
  const old = await createIdentity(page);
  await endorseFirst(page, "cukta");
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toHaveText(
    "Your endorsement is published.",
  );
  let captured: {
    envelope: { id: string; header: { previous: string[] } };
  } | null = null;
  await page.route("**/api/v1/events", async (route) => {
    if (route.request().method() !== "POST" || captured)
      return route.continue();
    captured = JSON.parse(route.request().postData() ?? "{}");
    await route.fulfill({
      status: 503,
      json: { code: "busy", message: "Later.", event: null, field: null },
    });
  });
  await endorseFirst(page, "vlacku");
  await expect(
    page.getByRole("link", { name: "1 not delivered" }),
  ).toBeVisible();
  await page.unroute("**/api/v1/events");
  const branch = captured!.envelope;
  await page.evaluate(
    async ({ id, identity, head }) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const store = new LocalStore();
      await store.delete("outbox", id);
      await store.put("heads", identity, [head]);
    },
    { id: branch.id, identity: old.identity, head: branch.header.previous[0] },
  );
  await addMirrorPeer(page);
  const mode: MirrorMode = {
    down: false,
    supply: true,
    activity: "ok",
    heads: "ok",
  };
  let headPage = 0;
  await page.route("**/mirror/api/v1/**", async (route) => {
    const fail = (status: number, message: string) =>
      route.fulfill({
        status,
        json: { code: "busy", message, event: null, field: null },
      });
    if (mode.down) return fail(503, "The mirror is down.");
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname).replace(
      /^\/mirror\/api\/v1/,
      "",
    );
    const manifest = await (
      await route.fetch({ url: new URL("/api/v1/manifest", page.url()).href })
    ).json();
    if (path === "/manifest") return route.fulfill({ json: manifest });
    if (path.startsWith("/identity-heads/")) {
      if (mode.heads === "endless") {
        headPage++;
        const head = "jve1:" + headPage.toString(16).padStart(64, "0");
        return route.fulfill({
          json: {
            snapshot: manifest.snapshot,
            identity: old.identity,
            heads: [head],
            next: head,
          },
        });
      }
      return route.fulfill({
        json: {
          snapshot: manifest.snapshot,
          identity: old.identity,
          heads: [branch.id],
          next: null,
        },
      });
    }
    if (path.endsWith("/activity")) {
      // Real transport failures after the heads arrived.
      if (mode.activity === "abort") return route.abort("connectionreset");
      if (mode.activity === "hang") {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        return route.abort("timedout");
      }
      if (mode.activity === "bad-shape")
        return route.fulfill({
          json: {
            snapshot: manifest.snapshot,
            identity: old.identity,
            items: "not an array",
            next: null,
          },
        });
      const base = {
        view: "jve1:" + "0".repeat(64),
        identity: old.identity,
        items: [],
        next: null,
      };
      if (mode.activity === "repeat")
        return route.fulfill({
          json: {
            ...base,
            snapshot: manifest.snapshot,
            next: "jve1:" + "f".repeat(64),
          },
        });
      if (mode.activity === "wrong-snapshot")
        return route.fulfill({
          json: { ...base, snapshot: "sha256:" + "b".repeat(64) },
        });
      return route.fulfill({ json: { ...base, snapshot: manifest.snapshot } });
    }
    if (path === `/events/${branch.id}`)
      return mode.supply
        ? route.fulfill({ json: branch })
        : fail(404, "Event is unavailable.");
    if (path === "/events") return fail(503, "Later.");
    return fail(404, "No route.");
  });
  return { old, branch, mode };
}
const knownHistory = (page: Page) =>
  page.getByRole("region", { name: "Known history", exact: true });

test("a branch fetched from a peer stays known after that peer stops answering, and the transfer still follows it", async ({
  page,
}) => {
  const { branch, mode } = await mirrorBranchSetup(page);
  await page.goto("/identity/transfer");
  await expect(knownHistory(page)).toContainText("1 fetched from other peers");
  const stored = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const selected = await store.get("keys", "selected");
    return {
      heads: await store.get("heads", selected.identity),
      branches: (await store.list("ownhistory")).length,
    };
  });
  expect(stored.heads).toEqual([branch.id]);
  expect(stored.branches).toBe(1);
  // The mirror goes down. The branch is still known history, not an acknowledged loss.
  mode.down = true;
  await page.goto("/identity/transfer");
  await expect(knownHistory(page)).toContainText(
    "One known head over 2 verified records",
  );
  await expect(knownHistory(page)).toContainText("mirror: did not answer");
  await expect(knownHistory(page)).not.toContainText(
    "fetched from other peers",
  );
  await createSuccessor(page);
  for (const box of await page.getByRole("checkbox").all()) await box.check();
  await page.getByRole("button", { name: "Sign the handover" }).click();
  const unlock = page.getByRole("dialog", { name: "Unlock your key" });
  await unlock.getByLabel("Passphrase").fill(PASSPHRASE);
  await unlock.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("status").last()).toContainText(
    "Old key retired",
  );
  const transfer = (await outboxItems(page)).find(
    (i: any) => i.label.action === "key handover",
  );
  expect(JSON.parse(transfer.transport).envelope.header.previous).toEqual([
    branch.id,
  ]);
});

test("a repeated cursor, another snapshot, or a partial head scan from a peer blocks the handover page", async ({
  page,
}) => {
  const { mode } = await mirrorBranchSetup(page);
  mode.activity = "repeat";
  await page.goto("/identity/transfer");
  await expect(knownHistory(page)).toContainText(
    "mirror: malformed answer: the activity scan repeated or malformed a cursor",
  );
  await expect(knownHistory(page)).toContainText(
    "needs a complete scan of every configured peer",
  );
  await createSuccessor(page);
  await expect(
    page.getByText("The old key's state blocks the handover."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign the handover" }),
  ).toHaveCount(0);
  mode.activity = "wrong-snapshot";
  await page.goto("/identity/transfer");
  await expect(knownHistory(page)).toContainText(
    "mirror: malformed answer: the activity scan answered for another snapshot",
  );
  await expect(knownHistory(page)).toContainText("needs a complete scan");
  mode.activity = "ok";
  mode.heads = "endless";
  await page.goto("/identity");
  await page.evaluate(async () => {
    const { SCAN_LIMITS } = await import(String("/src/data/lifecycle.ts"));
    SCAN_LIMITS.pages = 2;
  });
  await page.getByRole("link", { name: "Start" }).click();
  await expect(knownHistory(page)).toContainText(
    "mirror: incomplete: the head scan did not end within 2 pages",
  );
  await expect(knownHistory(page)).toContainText("needs a complete scan");
  expect(
    (await outboxItems(page)).some(
      (i: any) => i.label.action === "key handover",
    ),
  ).toBe(false);
});

test("a key restored into fresh storage signs a notice about its server history", async ({
  page,
  browser,
}) => {
  const me = await createIdentity(page);
  await endorseFirst(page, "cukta");
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toHaveText(
    "Your endorsement is published.",
  );
  await page.getByRole("link", { name: /key (unlocked|locked)/ }).click();
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download the encrypted backup" })
    .click();
  const backup = await (await downloadPromise).path();
  const fresh = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  const restored = await fresh.newPage();
  await restored.goto("/identity");
  await restored.getByLabel("Backup file").setInputFiles(backup!);
  await restored.getByLabel("Backup passphrase").fill(PASSPHRASE);
  await restored.getByRole("button", { name: "Open backup locally" }).click();
  await expect(restored.getByText("Unlocked", { exact: true })).toBeVisible();
  const localHeads = await restored.evaluate(async (identity) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return (await new LocalStore().get("heads", identity)) ?? [];
  }, me.identity);
  expect(localHeads).toEqual([]);
  await restored.getByRole("link", { name: "Report" }).click();
  const records = restored.getByRole("list", {
    name: "Own records in causal order",
  });
  await expect(records.getByRole("checkbox")).toHaveCount(1);
  await records.getByRole("checkbox").first().check();
  await restored
    .getByRole("checkbox", { name: /cannot prove which holder/ })
    .check();
  await restored.getByRole("button", { name: "Sign the notice" }).click();
  await expect(restored.getByRole("status")).toContainText(
    "compromise notice is saved",
  );
  const items = await restored.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().list("outbox");
  });
  const notice = items.find((i: any) => i.label.action === "compromise notice");
  expect(JSON.parse(notice.transport).envelope.header.previous).toHaveLength(1);
  expect(JSON.parse(notice.transport).envelope.header.action.safe).toHaveLength(
    1,
  );
  await fresh.close();
});

test("a migrated row keeps fresh receipt evidence recorded while its old receipt was being checked", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { outboxItem } = await import(String("/src/data/lifecycle.ts"));
    const seed = new Uint8Array(32).fill(188);
    const head = core.createEvent(
      seed,
      [],
      "c".repeat(32),
      { kind: "identity.merge" },
      null,
    );
    const store = new LocalStore(`migration-race-${Date.now()}`);
    const item = outboxItem(head, "race", 0, {
      self: { origin: location.origin, base: "/api/v1", label: "self" },
    });
    item.migrated = true;
    item.peers.self.state = "unknown";
    item.peers.self.receipt = { id: head.envelope.id, admission: "accepted" };
    await store.put("outbox", item.id, item);
    let begin: () => void = () => {};
    const started = new Promise<void>((resolve) => (begin = resolve));
    let finish: () => void = () => {};
    const held = new Promise<void>((resolve) => (finish = resolve));
    const reconcile = store.reconcileMigrated(async () => {
      begin();
      await held;
      return {
        state: "unknown",
        error: "Earlier receipt lacks complete evidence.",
      };
    });
    await started;
    // A delivery attempt records a fresh accepted receipt while the old one is being checked.
    await store.mergeOutbox(item.id, (stored: any) => ({
      ...stored,
      peers: {
        ...stored.peers,
        self: {
          ...stored.peers.self,
          state: "accepted",
          error: null,
          receipt: {
            id: head.envelope.id,
            admission: "accepted",
            proof: "fresh",
          },
        },
      },
    }));
    finish();
    await reconcile;
    const after = await store.get("outbox", item.id);
    return {
      state: after.peers.self.state,
      receipt: after.peers.self.receipt,
      migrated: after.migrated ?? null,
    };
  }, corePath);
  expect(result.state).toBe("accepted");
  expect(result.receipt.proof).toBe("fresh");
  expect(result.migrated).toBeNull();
});

test("a lost connection, a timeout, or a malformed activity shape after the heads arrived blocks the handover page", async ({
  page,
}) => {
  const { mode } = await mirrorBranchSetup(page);
  // Lost connection: the browser's fetch rejects, which the HTTP layer reports as a transport error.
  mode.activity = "abort";
  await page.goto("/identity/transfer");
  await expect(knownHistory(page)).toContainText(
    "mirror: incomplete: the activity scan stopped (No connection to the server.)",
  );
  await expect(knownHistory(page)).toContainText("needs a complete scan");
  // Malformed shape: the shared activity reader rejects the page.
  mode.activity = "bad-shape";
  await page.goto("/identity/transfer");
  await expect(knownHistory(page)).toContainText(
    "mirror: malformed answer: The server returned an invalid activity page.",
  );
  await expect(knownHistory(page)).toContainText("needs a complete scan");
  // Timeout: the scan deadline aborts the pending request, which the HTTP layer reports as a timeout.
  mode.activity = "hang";
  await page.goto("/identity");
  await page.evaluate(async () => {
    const { SCAN_LIMITS } = await import(String("/src/data/lifecycle.ts"));
    SCAN_LIMITS.millis = 1500;
  });
  await page.getByRole("link", { name: "Start" }).click();
  await expect(knownHistory(page)).toContainText(
    "mirror: incomplete: the activity scan stopped (The server did not answer in time.)",
  );
  await expect(knownHistory(page)).toContainText("needs a complete scan");
  await createSuccessor(page);
  await expect(
    page.getByText("The old key's state blocks the handover."),
  ).toBeVisible();
  expect(
    (await outboxItems(page)).some(
      (i: any) => i.label.action === "key handover",
    ),
  ).toBe(false);
});

test("a compromise notice refuses a 65th safe record before any unlock, and saves and sends nothing", async ({
  page,
}) => {
  await page.goto("/");
  // Sixty-six own records in one chain, signed and kept locally without delivery.
  await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { createKey } = await import(String("/src/data/keys.ts"));
    const { signWith, outboxItem } = await import(
      String("/src/data/lifecycle.ts")
    );
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const created = await createKey("test passphrase with spaces");
    await store.put("keys", "selected", created.backup);
    let previous: string[] = [];
    for (let i = 0; i < 66; i++) {
      const transport = await signWith(
        created.key,
        created.backup.identity,
        previous,
        {
          kind: "judgment.set",
          target: "jve1:" + i.toString(16).padStart(64, "0"),
          value: "bless",
        },
      );
      const item = outboxItem(transport, crypto.randomUUID(), 0, {
        self: {
          origin: location.origin,
          base: "/api/v1",
          label: "this server",
        },
      });
      item.stopped = true;
      await store.queueGroup([item]);
      previous = [transport.envelope.id];
    }
  }, corePath);
  let posts = 0;
  await page.route("**/api/v1/events", (route) => {
    posts++;
    return route.continue();
  });
  await page.goto("/identity");
  await expect(page.getByText("Locked", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Report" }).click();
  await expect(
    page.getByRole("heading", { name: "Report a stolen key" }),
  ).toBeVisible();
  const records = page.getByRole("list", {
    name: "Own records in causal order",
  });
  const boxes = records.getByRole("checkbox");
  await expect(boxes).toHaveCount(66);
  for (let i = 0; i < 64; i++) await boxes.nth(i).check();
  await expect(page.locator("main")).toContainText(
    "64 of 64 records named. The limit is reached.",
  );
  // The 65th box is closed. A forced change leaves it unchecked.
  await expect(boxes.nth(64)).toBeDisabled();
  await expect(boxes.nth(64)).toHaveAttribute(
    "title",
    "At most 64 records can be named. Clear one to name another.",
  );
  await boxes.nth(64).evaluate((node: HTMLInputElement) => {
    node.checked = true;
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(boxes.nth(64)).not.toBeChecked();
  await expect(page.locator("main")).toContainText("64 of 64 records named.");
  // Nothing was unlocked, saved, or sent.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(/compromise notice is saved/)).toHaveCount(0);
  const items = await outboxItems(page);
  expect(items).toHaveLength(66);
  expect(
    items.filter((i: any) => i.label.action !== "endorsement"),
  ).toHaveLength(0);
  expect(posts).toBe(0);
  // Clearing one box opens the others again.
  await boxes.nth(0).uncheck();
  await expect(boxes.nth(64)).toBeEnabled();
  await expect(page.locator("main")).toContainText("63 of 64 records named.");
});
