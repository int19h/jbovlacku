import { test, expect, type Page } from "@playwright/test";
import {
  corePath,
  createIdentity,
  fixture,
  PASSPHRASE,
  openWord,
  acceptFirstSignature,
} from "./helpers.ts";

async function transferFixture(page: Page, accepted = false) {
  const old = await createIdentity(page);
  const data = await page.evaluate(
    async ({ old, accepted, corePath, passphrase }) => {
      const core = await import(corePath);
      await core.initializeCore();
      const { createKey, unlockKey } = await import(
        String("/src/data/keys.ts")
      );
      const { signWith } = await import(String("/src/data/lifecycle.ts"));
      const successor = await createKey(passphrase);
      const transfer = await signWith(
        await unlockKey(old, passphrase),
        old.identity,
        [],
        { kind: "identity.transfer", successor: successor.backup.identity },
      );
      const send = async (transport: unknown) => {
        const response = await fetch("/api/v1/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(transport),
        });
        if (!response.ok) throw new Error(await response.text());
      };
      await send(transfer);
      let accept = null;
      if (accepted) {
        accept = await signWith(successor.key, successor.backup.identity, [], {
          kind: "identity.accept",
          transfer: transfer.envelope.id,
        });
        await send(accept);
      }
      return {
        old,
        successor: successor.backup,
        transfer: transfer.envelope,
        accept: accept?.envelope,
      };
    },
    { old, accepted, corePath, passphrase: PASSPHRASE },
  );
  // Recovery tests require these peer records in the completed snapshot.
  for (const event of [data.transfer, ...(data.accept ? [data.accept] : [])]) {
    await expect
      .poll(async () => {
        const response = await page.request.get(
          `/api/v1/receipts/${encodeURIComponent(event.id)}`,
        );
        if (!response.ok()) return false;
        const receipt = await response.json();
        return (
          receipt.snapshot !== null &&
          !receipt.reasons.some((reason: string) =>
            ["index_lag", "evaluation_pending"].includes(reason),
          )
        );
      })
      .toBe(true);
  }
  return data;
}

test("private trust needs a key while private Ignore stays available", async ({
  page,
}) => {
  await page.goto(
    `/identity/${encodeURIComponent(fixture().identities.curator)}`,
  );
  await page.getByRole("button", { name: "Trust their judgments" }).click();
  const panel = page.getByRole("region", { name: /^Trust / });
  await expect(
    panel.getByRole("link", { name: "Create or restore your key" }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Trust", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "Create or restore a key",
  );
  expect(
    await page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      return (await new LocalStore().overlay()).trust;
    }),
  ).toEqual([]);
});

test("private scopes convert spellings and reject bad language tags before storage", async ({
  page,
}) => {
  await page.goto(
    `/identity/${encodeURIComponent(fixture().identities.curator)}`,
  );
  await page.getByRole("button", { name: "Ignore their judgments" }).click();
  const panel = page.getByRole("region", { name: /^Ignore / });
  await panel
    .getByRole("button", { name: "limit by language, word, or rafsi" })
    .click();
  await panel.getByLabel("Word ID").fill("klama");
  await panel.getByLabel("Definition language").fill("a-en");
  await panel.getByRole("button", { name: "Ignore", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("BCP 47");
  await panel.getByLabel("Definition language").fill("en");
  await panel.getByRole("button", { name: "Ignore", exact: true }).click();
  const result = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const overlay = await new LocalStore().overlay();
    return {
      blocked: overlay.blocked,
      word: core.wordId({ language: "jbo", spelling: "klama" }),
    };
  }, corePath);
  expect(result.blocked).toHaveLength(1);
  expect(result.blocked[0].scope).toEqual({
    kind: "*",
    word: result.word,
    language: "en",
  });
});

for (const mode of ["create", "restore"] as const) {
  test(`legacy private trust migrates in one overlay write on key ${mode}`, async ({
    page,
  }) => {
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
    }, fixture().identities.curator);
    if (mode === "create") await createIdentity(page);
    else {
      const backup = await page.evaluate(async (corePath) => {
        const core = await import(corePath);
        await core.initializeCore();
        const { createKey } = await import(String("/src/data/keys.ts"));
        return (await createKey("test passphrase with spaces")).backup;
      }, corePath);
      await page.getByLabel("Backup file").setInputFiles({
        name: "key.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(backup)),
      });
      await page.getByLabel("Backup passphrase").fill(PASSPHRASE);
      await page.getByRole("button", { name: "Open backup locally" }).click();
      await expect(page.getByText("Unlocked", { exact: true })).toBeVisible();
    }
    const result = await page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const store = new LocalStore();
      return {
        overlay: await store.overlay(),
        key: await store.get("keys", "selected"),
      };
    });
    expect(result.overlay.trust[0].issuer).toBe(result.key.identity);
  });
}

test("the Trust page names the publisher and isolates invalid or unrelated private rules", async ({
  page,
}) => {
  await createIdentity(page);
  await page.evaluate(async (f) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const overlay = await store.overlay();
    overlay.trust.push({
      issuer: f.identities.rootA,
      subject: f.identities.curator,
      scope: { kind: "*", word: "bad", language: "*" },
      value: "heed",
      weight: null,
    });
    overlay.trust.push({
      issuer: f.identities.rootB,
      subject: f.identities.delegate,
      scope: { kind: "*", word: "*", language: "*" },
      value: "heed",
      weight: null,
    });
    await store.setOverlay(overlay);
  }, fixture());
  await page.goto("/trust");
  await expect(page.getByText("Published by", { exact: false })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Private rules that need attention" }),
  ).toBeVisible();
  const rows = page
    .locator("main .row")
    .filter({ hasText: "Invalid saved scope" });
  await expect(rows).toHaveCount(1);
  await rows.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(
    page.getByText("Invalid saved scope", { exact: false }),
  ).toHaveCount(0);
  await expect(
    page.getByText(
      /This rule depends on accepted continuity in the next calculation snapshot/,
    ),
  ).toBeVisible();
});

test("conflicting public trust has its own section and names the shun effect", async ({
  page,
}) => {
  const backup = await createIdentity(page);
  await page.evaluate(
    async ({ backup, subject, passphrase, corePath }) => {
      const core = await import(corePath);
      await core.initializeCore();
      const { unlockKey } = await import(String("/src/data/keys.ts"));
      const { signWith } = await import(String("/src/data/lifecycle.ts"));
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const key = await unlockKey(backup, passphrase);
      const events = [];
      for (const value of ["heed", "shun"])
        events.push(
          (
            await signWith(key, backup.identity, [], {
              kind: "trust.set",
              subject,
              scope: { kind: "*", word: "*", language: "*" },
              value,
            })
          ).envelope,
        );
      await new LocalStore().recordBranch(backup.identity, events);
    },
    {
      backup,
      subject: fixture().identities.curator,
      passphrase: PASSPHRASE,
      corePath,
    },
  );
  await page.goto("/trust");
  await expect(
    page.getByRole("heading", { name: "Conflicting public choices" }),
  ).toBeVisible();
  await expect(
    page.locator("main .row").filter({ hasText: "your devices disagree" }),
  ).toContainText("conflict that contains shun refuses this issuer route");
});

test("an ordinary signature keeps the loaded personal calculation for its snapshot", async ({
  page,
}) => {
  await createIdentity(page);
  await page.getByRole("link", { name: /^Trust:/ }).click();
  await page
    .getByRole("radio", { name: "Mine: site view + my choices" })
    .check();
  await openWord(page, "cukta");
  const panel = page.getByRole("region", {
    name: "Personal view",
    exact: true,
  });
  await expect(panel).toContainText("Personal view calculated in this browser");
  const before = await panel.innerText();
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toContainText("published");
  await expect(panel).toContainText("Personal view calculated in this browser");
  expect(await panel.innerText()).toBe(before);
});

test("a lost acceptance search shows authenticated peer evidence and blocks another signature", async ({
  page,
}) => {
  const data = await transferFixture(page, true);
  await page.goto("/identity/transfer");
  const recovery = page.getByRole("region", { name: "Acceptance recovery" });
  await expect(recovery).toContainText(data.accept!.id);
  await expect(recovery).toContainText("authenticated acceptance");
  await expect(
    recovery.getByRole("button", { name: "Sign one recovery acceptance" }),
  ).toHaveCount(0);
});

test("a complete negative acceptance scan allows one warned recovery and retires the old key", async ({
  page,
}) => {
  const data = await transferFixture(page);
  await page.route("**/api/v1/events", (route) =>
    route.fulfill({ status: 503, json: { code: "busy", message: "Later." } }),
  );
  await page.goto("/identity/transfer");
  const form = page.getByRole("form", { name: "Recover a lost acceptance" });
  await expect(form).toBeVisible();
  await form.getByLabel("Successor backup file").setInputFiles({
    name: "successor.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(data.successor)),
  });
  await form.getByLabel("Successor backup passphrase").fill(PASSPHRASE);
  const sign = form.getByRole("button", {
    name: "Sign one recovery acceptance",
  });
  await expect(sign).toBeDisabled();
  for (const checkbox of await form.getByRole("checkbox").all())
    await checkbox.check();
  await sign.dblclick();
  await expect(page.getByRole("status")).toContainText(
    "One recovery acceptance is saved",
  );
  const result = await page.evaluate(
    async ({ old, transfer }) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const store = new LocalStore();
      return {
        selected: await store.get("keys", "selected"),
        retired: await store.get("keys", `retired:${old}`),
        handover: await store.get("keys", `handover:${old}`),
        recovery: await store.get("keys", `recovery:${transfer}`),
        items: await store.list("outbox"),
      };
    },
    { old: data.old.identity, transfer: data.transfer.id },
  );
  expect(result.selected).toEqual(data.successor);
  expect(result.retired).toEqual(data.old);
  expect(result.items).toHaveLength(2);
  expect(result.handover.accept).toBe(result.recovery);
  const envelope = JSON.parse(
    result.items.find((item: any) => item.id === result.recovery).transport,
  ).envelope;
  expect(envelope.header.previous).toEqual([]);
  expect(envelope.header.action).toEqual({
    kind: "identity.accept",
    transfer: data.transfer.id,
  });
  await page.goto("/identity/transfer");
  await expect(
    page.getByRole("button", { name: "Sign one recovery acceptance" }),
  ).toHaveCount(0);
});

for (const outcome of ["unreachable", "malformed"] as const) {
  test(`lost acceptance recovery blocks a peer whose scan is ${outcome}`, async ({
    page,
  }) => {
    await transferFixture(page);
    await page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const store = new LocalStore();
      const prefs = await store.preferences();
      await store.setPreferences({
        peers: [
          ...prefs.peers,
          { id: "other", base: "/other-api", label: "other peer" },
        ],
      });
    });
    await page.route("**/other-api/**", async (route) => {
      if (outcome === "unreachable") return route.abort();
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/manifest")) {
        const response = await page.request.get("/api/v1/manifest");
        return route.fulfill({ json: await response.json() });
      }
      return route.fulfill({ json: { malformed: true } });
    });
    await page.goto("/identity/transfer");
    const recovery = page.getByRole("region", { name: "Acceptance recovery" });
    await expect(recovery).toContainText(
      "An unanswered or incomplete peer blocks it",
    );
    await expect(
      recovery.getByRole("button", { name: "Sign one recovery acceptance" }),
    ).toHaveCount(0);
  });
}

test("personal roots use accepted continuity from the cached snapshot, including zero and removal", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(
    async ({ corePath, f }) => {
      const core = await import(corePath);
      await core.initializeCore();
      const { loadRecord } = await import(String("/src/data/api.ts"));
      const { LocalStore, emptyOverlay } = await import(
        String("/src/data/store.ts")
      );
      const { PersonalCalculator, effectiveOverlay, overlayDigest } =
        await import(String("/src/data/personal.ts"));
      const oldSeed = crypto.getRandomValues(new Uint8Array(32));
      const nextSeed = crypto.getRandomValues(new Uint8Array(32));
      const old = core.identityFromSeed(oldSeed),
        successor = core.identityFromSeed(nextSeed);
      const source = await loadRecord(f.definitions.cukta1);
      const sourceView = await loadRecord(f.view);
      const create = (
        seed: Uint8Array,
        previous: string[],
        action: unknown,
        body: unknown = null,
      ) =>
        core.createEvent(
          seed,
          previous,
          crypto.randomUUID().replaceAll("-", ""),
          action,
          body,
        );
      const definition = create(
        oldSeed,
        [],
        { ...source.envelope.header.action, parents: [] },
        source.body,
      );
      const judgment = create(oldSeed, [definition.envelope.id], {
        kind: "judgment.set",
        target: definition.envelope.id,
        value: "bless",
      });
      const transfer = create(oldSeed, [judgment.envelope.id], {
        kind: "identity.transfer",
        successor,
      });
      const accept = create(nextSeed, [], {
        kind: "identity.accept",
        transfer: transfer.envelope.id,
      });
      const view = create(
        crypto.getRandomValues(new Uint8Array(32)),
        [],
        { kind: "view.publish", parents: [] },
        {
          ...sourceView.body,
          roots: [{ identity: old, q: { numerator: 1, denominator: 2 } }],
          import_sets: [],
        },
      );
      const store = new LocalStore(`continuity-${crypto.randomUUID()}`);
      const records = [definition, judgment, transfer, accept, view];
      for (const item of records)
        await store.put("records", item.envelope.id, {
          id: item.envelope.id,
          envelope: core.canonicalize(core.utf8(JSON.stringify(item.envelope))),
          body: item.body
            ? core.canonicalize(core.utf8(JSON.stringify(item.body)))
            : null,
          bodyHash: item.envelope.header.content?.hash ?? null,
          bodyStatus: item.body ? "present" : "none",
        });
      let revision = 1;
      const inventory = async (items: any[]) => {
        await store.put("inventory", "latest", {
          snapshot: "sha256:" + String(revision++).padStart(64, "0"),
          logical_inventory: "sha256:" + "a".repeat(64),
          view: view.envelope.id,
          events: items.map((i) => i.envelope.id).sort(),
          bodies: items
            .filter((i) => i.body)
            .map((i) => i.envelope.header.content.hash)
            .sort(),
          selections: [],
        });
      };
      await inventory(records);
      const calculator = new PersonalCalculator(store, async () => ({
        identity: successor,
      }));
      const supports = [];
      for (const change of [
        undefined,
        { numerator: 0, denominator: 1 },
        null,
      ]) {
        const overlay = emptyOverlay();
        if (change !== undefined)
          overlay.root_changes.push({ identity: old, q: change });
        await store.setOverlay(overlay);
        calculator.invalidate();
        const ranked = await calculator.rankWord(f.words.cukta);
        if (!ranked.scores.length)
          throw new Error(
            JSON.stringify({ ranked, status: calculator.status }),
          );
        supports.push(ranked.scores[0].support);
      }
      await store.setOverlay(emptyOverlay());
      await store.put("keys", `handover-of:${successor}`, { old, successor });
      // The next snapshot omits the acceptance. Local lifecycle metadata cannot supply continuity.
      await inventory(records.filter((item) => item !== accept));
      calculator.invalidate();
      const status = await calculator.ensure();
      const expected = overlayDigest(
        effectiveOverlay(
          emptyOverlay(),
          view.envelope.id,
          { identity: successor, actors: {} },
          [old],
        ),
      );
      calculator.cancel();
      const db = await store.database;
      db.close();
      indexedDB.deleteDatabase(db.name);
      return { supports, digest: status.overlay, expected };
    },
    { corePath, f: fixture() },
  );
  expect(result.supports).toEqual([
    [
      { numerator: "1", denominator: "2" },
      { numerator: "1", denominator: "2" },
    ],
    [
      { numerator: "0", denominator: "1" },
      { numerator: "0", denominator: "1" },
    ],
    [
      { numerator: "0", denominator: "1" },
      { numerator: "0", denominator: "1" },
    ],
  ]);
  expect(result.digest).toBe(result.expected);
});

test("revision authorship uses actor responses at the displayed snapshot and falls back when unavailable", async ({
  page,
}) => {
  await page.goto("/word/cukta");
  await page.waitForLoadState("networkidle");
  const ids = fixture().identities;
  const actorRequests: string[] = [];
  await page.route("**/api/v1/identities/*?snapshot=*", async (route) => {
    const url = new URL(route.request().url());
    actorRequests.push(url.searchParams.get("snapshot")!);
    const identity = decodeURIComponent(url.pathname.split("/").at(-1)!);
    await route.fulfill({
      json: {
        snapshot: url.searchParams.get("snapshot"),
        identity,
        actor: ids.author,
        successor: null,
        retired: false,
        compromised: false,
        suspended: false,
        profile: { state: "none", claims: [] },
        counts: {},
      },
    });
  });
  const snapshot = await page.evaluate(
    async ({ f }) => {
      const { definitionBlock } = await import(
        String("/src/components/definition.ts")
      );
      const { getWord, loadRecord } = await import(String("/src/data/api.ts"));
      const word = await getWord(f.words.cukta);
      const original = await loadRecord(f.definitions.cukta1, word.snapshot);
      const revision = {
        ...original,
        envelope: {
          ...original.envelope,
          id: "jve1:" + "d".repeat(64),
          header: {
            ...original.envelope.header,
            issuer: f.identities.rootB,
            action: {
              ...original.envelope.header.action,
              parents: [original.envelope.id],
            },
          },
        },
      };
      const app = {
        session: {
          subscribe: () => () => {},
          preferences: {},
          storageAvailable: true,
        },
        own: { registers: async () => null, subscribe: () => () => {} },
        delivery: { items: async () => [], subscribe: () => () => {} },
        offlineSigning: { value: false },
      };
      const host = document.createElement("div");
      host.id = "revision-probe";
      host.append(
        definitionBlock(app, original, {
          score: null,
          unavailable: true,
          revisions: [revision],
          word,
        }),
      );
      document.body.append(host);
      (window as any).__revisionProbe = { app, original, revision, word };
      return word.snapshot;
    },
    { f: fixture() },
  );
  await expect(page.locator("#revision-probe .revision-notice")).toContainText(
    "the author through accepted key continuity",
  );
  expect(actorRequests).toEqual([snapshot, snapshot]);
  await page.unroute("**/api/v1/identities/*?snapshot=*");
  await page.route("**/api/v1/identities/*?snapshot=*", (route) =>
    route.abort(),
  );
  await page.evaluate(async () => {
    const { definitionBlock } = await import(
      String("/src/components/definition.ts")
    );
    const { app, original, revision, word } = (window as any).__revisionProbe;
    document.querySelector("#revision-probe")!.replaceChildren(
      definitionBlock(app, original, {
        score: null,
        unavailable: true,
        revisions: [revision],
        word,
      }),
    );
  });
  await expect(page.locator("#revision-probe .revision-notice")).toContainText(
    "a different key",
  );
});

for (const change of ["judgment", "transfer"] as const) {
  test(`a peer ${change} history change during the handover unlock wait needs new approval`, async ({
    page,
  }) => {
    const old = await createIdentity(page);
    await page.getByRole("link", { name: "Start", exact: true }).click();
    await page.getByLabel("New passphrase for the new key").fill(PASSPHRASE);
    await page.getByLabel("Repeat passphrase").fill(PASSPHRASE);
    await page.getByRole("button", { name: "Create the new key" }).click();
    const downloadPromise = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download the new key's backup" })
      .click();
    const backupPath = await (await downloadPromise).path();
    await page.getByLabel("Backup file").setInputFiles(backupPath!);
    await page.getByLabel("Its passphrase").fill(PASSPHRASE);
    await page.getByRole("button", { name: "Test the backup" }).click();
    await expect(page.getByRole("status").last()).toContainText(
      "recovers the new key",
    );
    await expect(page.getByRole("checkbox")).toHaveCount(3);
    for (const box of await page.getByRole("checkbox").all()) await box.check();
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await page.getByRole("button", { name: "Sign the handover" }).click();
    const dialog = page.getByRole("dialog", { name: "Unlock your key" });
    await expect(dialog).toBeVisible();
    const learned = await page.evaluate(
      async ({ old, passphrase, target, change }) => {
        const { unlockKey } = await import(String("/src/data/keys.ts"));
        const { signWith } = await import(String("/src/data/lifecycle.ts"));
        const { createKey } = await import(String("/src/data/keys.ts"));
        const successor =
          change === "transfer" ? await createKey(passphrase) : null;
        const transport = await signWith(
          await unlockKey(old, passphrase),
          old.identity,
          [],
          successor
            ? {
                kind: "identity.transfer",
                successor: successor.backup.identity,
              }
            : { kind: "judgment.set", target, value: "bless" },
        );
        const response = await fetch("/api/v1/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(transport),
        });
        if (!response.ok) throw new Error(await response.text());
        return transport.envelope.id;
      },
      {
        old,
        passphrase: PASSPHRASE,
        target: fixture().definitions.cukta1,
        change,
      },
    );
    await dialog.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
    await dialog.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect(page.locator(".status")).toContainText(
      "The known history changed",
    );
    if (change === "transfer") {
      const recovery = page.getByRole("region", {
        name: "Acceptance recovery",
      });
      await expect(recovery).toContainText(learned);
      await expect(recovery).toContainText(
        "No acceptance for this transfer was found",
      );
      await expect(
        page.getByRole("button", { name: "Sign the handover" }),
      ).toHaveCount(0);
    }
    for (const box of await page.getByRole("checkbox").all())
      await expect(box).not.toBeChecked();
    expect(
      await page.evaluate(async () => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        return (await new LocalStore().list("outbox")).length;
      }),
    ).toBe(0);
  });
}

test("a late acceptance found by the final recovery scan prevents a new signature", async ({
  page,
}) => {
  const data = await transferFixture(page);
  await page.goto("/identity/transfer");
  const form = page.getByRole("form", { name: "Recover a lost acceptance" });
  await expect(form).toBeVisible();
  await form.getByLabel("Successor backup file").setInputFiles({
    name: "successor.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(data.successor)),
  });
  await form.getByLabel("Successor backup passphrase").fill(PASSPHRASE);
  for (const checkbox of await form.getByRole("checkbox").all())
    await checkbox.check();
  const acceptance = await page.evaluate(
    async ({ data, passphrase }) => {
      const { unlockKey } = await import(String("/src/data/keys.ts"));
      const { signWith } = await import(String("/src/data/lifecycle.ts"));
      const transport = await signWith(
        await unlockKey(data.successor, passphrase),
        data.successor.identity,
        [],
        { kind: "identity.accept", transfer: data.transfer.id },
      );
      await fetch("/api/v1/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(transport),
      });
      return transport.envelope.id;
    },
    { data, passphrase: PASSPHRASE },
  );
  await form
    .getByRole("button", { name: "Sign one recovery acceptance" })
    .click();
  await expect(
    page.getByRole("region", { name: "Acceptance recovery" }),
  ).toContainText(acceptance);
  await expect(page.getByRole("status")).toContainText(
    "acceptance search changed",
  );
  expect(
    await page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      return (await new LocalStore().list("outbox")).length;
    }),
  ).toBe(0);
});

test("concurrent recovery writes save one acceptance and finish delivery with the original transfer", async ({
  page,
}) => {
  const data = await transferFixture(page);
  await page.goto("/identity/transfer");
  await expect(
    page.getByRole("form", { name: "Recover a lost acceptance" }),
  ).toBeVisible();
  const results = await page.evaluate(
    async ({ data, passphrase }) => {
      const { unlockKey } = await import(String("/src/data/keys.ts"));
      const { signWith, queueRecoveryAcceptance, outboxItem } = await import(
        String("/src/data/lifecycle.ts")
      );
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { DeliveryEngine } = await import(String("/src/data/delivery.ts"));
      const store = new LocalStore();
      const key = await unlockKey(data.successor, passphrase);
      const concurrent = await signWith(
        await unlockKey(data.old, passphrase),
        data.old.identity,
        [],
        {
          kind: "trust.set",
          subject: data.successor.identity,
          scope: { kind: "*", word: "*", language: "*" },
          value: "clear",
        },
      );
      await store.recordBranch(data.old.identity, [concurrent.envelope]);
      const transports = await Promise.all(
        [0, 1].map(() =>
          signWith(key, data.successor.identity, [], {
            kind: "identity.accept",
            transfer: data.transfer.id,
          }),
        ),
      );
      const recipients = {
        self: {
          origin: location.origin,
          base: "/api/v1",
          label: "this server",
        },
      };
      const written = await Promise.allSettled(
        transports.map((transport) =>
          queueRecoveryAcceptance(
            store,
            data.transfer,
            outboxItem(transport, crypto.randomUUID(), 0, recipients),
            data.old,
            data.successor,
          ),
        ),
      );
      const record = written.find(
        (entry) => entry.status === "fulfilled",
      )!.value;
      const delivery = new DeliveryEngine(store);
      await delivery.deliver(record.transfer, true);
      await delivery.deliver(record.accept, true);
      const { loadOwnHistory } = await import(String("/src/data/history.ts"));
      const history = await loadOwnHistory(store, data.old.identity, {
        offline: true,
      });
      return {
        states: written.map((entry) => entry.status),
        items: await store.list("outbox"),
        oldEvents: [...history.events.keys()].sort(),
        expectedOldEvents: [data.transfer.id, concurrent.envelope.id].sort(),
        oldHeads: await store.get("heads", data.old.identity),
        concurrent: concurrent.envelope.id,
      };
    },
    { data, passphrase: PASSPHRASE },
  );
  expect(results.states.sort()).toEqual(["fulfilled", "rejected"]);
  expect(results.items).toHaveLength(2);
  expect(results.oldEvents).toEqual(results.expectedOldEvents);
  expect(results.oldHeads).toContain(results.concurrent);
  expect(
    results.items.every((item: any) => item.peers.self.state === "accepted"),
  ).toBe(true);
  expect(
    results.items.find((item: any) => item.id === data.transfer.id).transport,
  ).toContain(data.transfer.signature);
  await page.goto("/identity");
  await expect(
    page.getByRole("region", { name: "Handover status" }),
  ).toContainText("Handover complete");
});

test("private rule labels use the loaded calculation continuity across a newer accepted handover", async ({
  page,
}) => {
  const transfer = await transferFixture(page);
  const result = await page.evaluate(
    async ({ transfer, corePath, passphrase, subject }) => {
      const core = await import(corePath);
      const { LocalStore, emptyOverlay } = await import(
        String("/src/data/store.ts")
      );
      const { syncRecords } = await import(String("/src/data/records.ts"));
      const { PersonalCalculator } = await import(
        String("/src/data/personal.ts")
      );
      const { trustPage } = await import(String("/src/pages/trust.ts"));
      const { signWith } = await import(String("/src/data/lifecycle.ts"));
      const { unlockKey } = await import(String("/src/data/keys.ts"));
      const store = new LocalStore(`trust-snapshot-${crypto.randomUUID()}`);
      const overlay = emptyOverlay();
      overlay.trust.push({
        issuer: transfer.old.identity,
        subject,
        scope: { kind: "*", word: "*", language: "*" },
        value: "heed",
        weight: { numerator: 1, denominator: 1 },
      });
      await store.setOverlay(overlay);
      const cached = await syncRecords(store);
      const personal = new PersonalCalculator(store, async () => ({
        identity: transfer.successor.identity,
      }));
      const initial = await personal.ensure();
      if (initial.state !== "ready") throw new Error(JSON.stringify(initial));
      const acceptance = await signWith(
        await unlockKey(transfer.successor, passphrase),
        transfer.successor.identity,
        [],
        { kind: "identity.accept", transfer: transfer.transfer.id },
      );
      const response = await fetch("/api/v1/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(acceptance),
      });
      if (!response.ok) throw new Error(await response.text());
      // Admission precedes evaluation. Wait before requesting the newer calculation.
      const deadline = Date.now() + 10000;
      for (;;) {
        const response = await fetch(
          `/api/v1/receipts/${encodeURIComponent(acceptance.envelope.id)}`,
        );
        if (!response.ok) throw new Error(await response.text());
        const receipt = await response.json();
        if (
          receipt.snapshot !== null &&
          !receipt.reasons.some((reason: string) =>
            ["index_lag", "evaluation_pending"].includes(reason),
          )
        )
          break;
        if (Date.now() >= deadline)
          throw new Error("The handover evaluation did not finish.");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const main = document.createElement("main");
      const app = {
        store,
        personal,
        session: {
          identity: transfer.successor.identity,
          preferences: { viewMode: "personal" },
        },
        own: { registers: async () => null },
      };
      const render = async () => {
        main.replaceChildren();
        await trustPage(
          {} as any,
          {
            main,
            title() {},
            live: () => true,
            signal: new AbortController().signal,
          } as any,
          app as any,
        );
        const trusted = [...main.querySelectorAll("h2")].find(
          (node) => node.textContent === "People I trust",
        )!.nextElementSibling!;
        return {
          trusted: Boolean(
            trusted.querySelector(
              `a[href='/identity/${encodeURIComponent(subject)}']`,
            ),
          ),
          text: main.textContent,
        };
      };
      const beforeRefresh = await render();
      const refreshed = await personal.ensure({ refresh: true });
      if (refreshed.state !== "ready")
        throw new Error(JSON.stringify(refreshed));
      const afterRefresh = await render();
      personal.invalidate();
      const withoutCalculation = await render();
      personal.cancel();
      const db = await store.database;
      db.close();
      indexedDB.deleteDatabase(db.name);
      return {
        cached: cached.snapshot,
        refreshed: refreshed.snapshot,
        beforeRefresh,
        afterRefresh,
        withoutCalculation,
      };
    },
    {
      transfer,
      corePath,
      passphrase: PASSPHRASE,
      subject: fixture().identities.curator,
    },
  );
  expect(result.cached).not.toBe(result.refreshed);
  expect(result.beforeRefresh.trusted).toBe(false);
  expect(result.beforeRefresh.text).toContain(result.cached);
  expect(result.beforeRefresh.text).toContain(
    "This rule does not apply in the loaded personal calculation.",
  );
  expect(result.afterRefresh.trusted).toBe(true);
  expect(result.afterRefresh.text).toContain(result.refreshed);
  expect(result.withoutCalculation.trusted).toBe(false);
  expect(result.withoutCalculation.text).toContain(
    "No personal calculation is loaded. This rule depends on accepted continuity in the next calculation snapshot.",
  );
});
