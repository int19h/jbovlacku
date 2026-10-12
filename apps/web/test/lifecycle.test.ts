import { test, expect, type Page } from "@playwright/test";
import {
  acceptFirstSignature,
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

test("a handover fetches a branch that only a second peer holds, includes it in the transfer, and blocks when that branch cannot be supplied", async ({
  page,
}) => {
  const old = await createIdentity(page);
  await endorseFirst(page, "cukta");
  await acceptFirstSignature(page);
  await expect(page.getByRole("status").last()).toHaveText(
    "Your endorsement is published.",
  );
  // Sign a second record that only the mirror will hold: capture its upload and keep it away from this server.
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
  expect(captured).not.toBeNull();
  const branch = captured!.envelope;
  const firstHead = branch.header.previous[0];
  // Forget the branch locally. Only the mirror knows it.
  await page.evaluate(
    async ({ id, identity, head }) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const store = new LocalStore();
      await store.delete("outbox", id);
      await store.put("heads", identity, [head]);
    },
    { id: branch.id, identity: old.identity, head: firstHead },
  );
  await addMirrorPeer(page);
  const manifestOf = async (route: import("@playwright/test").Route) => {
    const response = await route.fetch({
      url: new URL("/api/v1/manifest", page.url()).href,
    });
    return response.json();
  };
  let supplyBranch = true;
  await page.route("**/mirror/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname).replace(
      /^\/mirror\/api\/v1/,
      "",
    );
    if (path === "/manifest")
      return route.fulfill({ json: await manifestOf(route) });
    const manifest = await manifestOf(route);
    if (path.startsWith("/identity-heads/"))
      return route.fulfill({
        json: {
          snapshot: manifest.snapshot,
          identity: old.identity,
          heads: [branch.id],
          next: null,
        },
      });
    if (path.endsWith("/activity"))
      return route.fulfill({
        json: {
          snapshot: manifest.snapshot,
          view: "jve1:" + "0".repeat(64),
          identity: old.identity,
          items: [],
          next: null,
        },
      });
    if (path === `/events/${branch.id}`)
      return supplyBranch
        ? route.fulfill({ json: branch })
        : route.fulfill({
            status: 404,
            json: {
              code: "missing",
              message: "Event is unavailable.",
              event: null,
              field: null,
            },
          });
    if (path === "/events" && route.request().method() === "POST")
      return route.fulfill({
        status: 503,
        json: { code: "busy", message: "Later.", event: null, field: null },
      });
    return route.fulfill({
      status: 404,
      json: { code: "missing", message: "No route.", event: null, field: null },
    });
  });
  await page.getByRole("link", { name: /key (unlocked|locked)/ }).click();
  await page.getByRole("link", { name: "Start" }).click();
  await expect(
    page.getByRole("heading", { name: "Move to a new key" }),
  ).toBeVisible();
  const history = page.getByRole("region", {
    name: "Known history",
    exact: true,
  });
  await expect(history).toContainText(
    "One known head over 2 verified records, 1 fetched from other peers",
  );
  await expect(history).toContainText("mirror: one head, scan complete.");
  await createSuccessor(page);
  for (const box of await page.getByRole("checkbox").all()) await box.check();
  // The branch disappears from the mirror before signing. The refresh blocks the handover instead of dropping the branch.
  supplyBranch = false;
  await page.getByRole("button", { name: "Sign the handover" }).click();
  await expect(page.getByRole("status").last()).toContainText(
    "The known history changed",
  );
  await expect(history).toContainText(
    /could not supply it as a valid signed record/,
  );
  await expect(page.getByText(/blocks the handover/)).toBeVisible();
  expect(
    (await outboxItems(page)).some(
      (i: any) => i.label.action === "key handover",
    ),
  ).toBe(false);
  // The branch is available again. The preview needs renewed approval, then the transfer follows the fetched branch.
  supplyBranch = true;
  // A full page load locks the key. The signing step then opens the unlock dialog.
  await page.goto("/identity/transfer");
  await expect(history).toContainText("1 fetched from other peers");
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
  await expect(
    page.getByRole("button", { name: "Checking the known history…" }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Checking the known history…" })
    .click({ force: true });
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
