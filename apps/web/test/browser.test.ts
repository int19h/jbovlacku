import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
test("direct search and authoring routes preserve parameters through browser history", async ({
  page,
}) => {
  await page.goto("/search?q=klama&lang=en");
  await expect(page.getByLabel("Search words and meanings")).toHaveValue(
    "klama",
  );
  await expect(page.getByLabel("Definition language")).toHaveValue("en");
  await page.getByRole("link", { name: "Add", exact: true }).click();
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByLabel("Definition", { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/search\?q=klama&lang=en$/);
  await expect(page.getByLabel("Search words and meanings")).toHaveValue(
    "klama",
  );
  await page.goForward();
  await expect(page.getByLabel("Definition", { exact: true })).toBeVisible();
});
async function createIdentity(page: Page) {
  await page.goto("/identity");
  await page
    .getByLabel("New passphrase", { exact: true })
    .fill("test passphrase with spaces");
  await page
    .getByLabel("Repeat passphrase")
    .fill("test passphrase with spaces");
  await page
    .getByRole("button", { name: "Create a disposable identity" })
    .click();
  await expect(
    page.getByText("Unlocked for this session.", { exact: true }),
  ).toBeVisible();
}
test("browser keys use the backup profile and restore in another browser context", async ({
  page,
  browser,
}) => {
  await createIdentity(page);
  const backup = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/storage.ts"));
    return new LocalStore().get("keys", "selected");
  });
  expect(Object.keys(backup).sort()).toEqual([
    "format",
    "identity",
    "jwe",
    "version",
  ]);
  const header = JSON.parse(
    Buffer.from(backup.jwe.split(".")[0], "base64url").toString(),
  );
  expect(header.alg).toBe("PBES2-HS256+A128KW");
  expect(header.enc).toBe("A256GCM");
  expect(header.p2c).toBe(600000);
  expect(Object.keys(header).sort()).toEqual(["alg", "enc", "p2c", "p2s"]);
  const context = await browser.newContext();
  const restored = await context.newPage();
  await restored.goto("/identity");
  await restored.getByLabel("Backup file").setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await restored.getByLabel("Backup passphrase").fill("wrong");
  await restored.getByRole("button", { name: "Open backup locally" }).click();
  await expect(restored.getByRole("status")).toHaveText(
    "This file did not unlock with that passphrase.",
  );
  await expect(
    restored.getByLabel("New passphrase", { exact: true }),
  ).toBeVisible();
  await restored
    .getByLabel("Backup passphrase")
    .fill("test passphrase with spaces");
  await restored.getByRole("button", { name: "Open backup locally" }).click();
  await expect(
    restored.getByText(backup.identity, { exact: true }),
  ).toBeVisible();
  await expect(
    restored.getByText("Unlocked for this session.", { exact: true }),
  ).toBeVisible();
  const invalid = await restored.evaluate(async (backup) => {
    const { parseBackup } = await import(String("/src/keys.ts"));
    const bad = { ...backup, identity: "ed25519:" + "0".repeat(64) };
    const { unlockKey } = await import(String("/src/keys.ts"));
    try {
      await unlockKey(bad, "test passphrase with spaces");
      return "accepted";
    } catch (error) {
      return String(error);
    }
  }, backup);
  expect(invalid).toContain("This file did not unlock");
  await context.close();
});
test("a signed outbox survives an unknown delivery result and does not create another event", async ({
  page,
}) => {
  await createIdentity(page);
  await page.getByRole("link", { name: "Add", exact: true }).click();
  await page.getByLabel("Lojban word").fill("broda");
  await page.getByLabel("Definition language").fill("en");
  await page
    .getByLabel("Definition", { exact: true })
    .fill("① is a browser test with <script>window.bad=true</script>.");
  await page
    .getByLabel("Place descriptions, one per line")
    .fill("The test subject");
  await page.getByLabel("License expression").fill("CC0-1.0");
  await page.getByLabel("Attribution").fill("Disposable browser test");
  await page.getByLabel("Read circled numbers as place markers").check();
  await page.getByRole("button", { name: "Sign and save to outbox" }).click();
  await expect(page.getByText("Delivery: ready")).toBeVisible();
  const original = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/storage.ts"));
    return (await new LocalStore().list("outbox"))[0];
  });
  let posted = 0;
  await page.route("**/api/v1/events", async (route) => {
    posted++;
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Send to this test server" }).click();
  await expect(page.getByText("Delivery: unknown")).toBeVisible();
  await page.unroute("**/api/v1/events");
  await page.reload();
  await page.getByRole("button", { name: "Check receipt and retry" }).click();
  await expect(page.getByText("Delivery: stored")).toBeVisible();
  expect(posted).toBe(1);
  const after = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/storage.ts"));
    return await new LocalStore().list("outbox");
  });
  expect(after).toHaveLength(1);
  expect(after[0].transport).toBe(original.transport);
  expect(after[0].id).toBe(original.id);
  await page.getByRole("link", { name: original.id }).click();
  await expect(
    page.getByText(
      " is a browser test with <script>window.bad=true</script>.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(await page.evaluate(() => Boolean((window as any).bad))).toBe(false);
  await expect(
    page.getByRole("link", { name: "place 1", exact: true }),
  ).toBeVisible();
});
test("local storage failure keeps the draft and never reports a saved outbox", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/storage.ts"));
    const { sendItem } = await import(String("/src/api.ts"));
    const store = new LocalStore("storage-failure-test");
    await store.put("drafts", "current", { text: "Keep this draft" });
    const broken = {
      ...store,
      put: async () => {
        throw new Error("Storage failed");
      },
    };
    let calls = 0;
    const oldFetch = window.fetch;
    window.fetch = async () => {
      calls++;
      return new Response("{}");
    };
    try {
      await sendItem(broken as any, {
        id: "jve1:" + "1".repeat(64),
        identity: "ed25519:" + "2".repeat(64),
        transport: "{}",
        state: "ready",
      });
      return { calls, failed: false };
    } catch {
      return {
        calls,
        failed: true,
        draft: await store.get("drafts", "current"),
      };
    } finally {
      window.fetch = oldFetch;
    }
  });
  expect(result.calls).toBe(0);
  expect(result.failed).toBe(true);
  expect(result.draft).toEqual({ text: "Keep this draft" });
});
test("backup validation rejects extra headers and large files before password work", async ({
  page,
}) => {
  await page.goto("/");
  const results = await page.evaluate(
    async (corePath) => {
      const core = await import(corePath);
      await core.initializeCore();
      const { createKey, parseBackup } = await import(String("/src/keys.ts"));
      const created = await createKey("test");
      const parts = created.backup.jwe.split(".");
      const header = JSON.parse(
        atob(parts[0].replaceAll("-", "+").replaceAll("_", "/")),
      );
      header.jku = "https://example.invalid/keys";
      parts[0] = btoa(JSON.stringify(header))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
      const messages = [];
      for (const value of [
        JSON.stringify({ ...created.backup, jwe: parts.join(".") }),
        " ".repeat(16385),
      ]) {
        try {
          parseBackup(value);
          messages.push("accepted");
        } catch (error) {
          messages.push(String(error));
        }
      }
      if (created.key.extractable)
        throw new Error("The working key is exportable.");
      return messages;
    },
    `/@fs${resolve("packages/core/src/index.ts")}`,
  );
  expect(results[0]).toContain("not supported");
  expect(results[1]).toContain("exceeds 16 KiB");
});
test("search and navigation fit a 360 pixel screen in both themes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "A dictionary shaped by its readers" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("link", { name: "Add", exact: true }).click();
    await expect(page.getByLabel("Definition", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.goBack();
    await expect(
      page.getByRole("heading", { name: "A dictionary shaped by its readers" }),
    ).toBeVisible();
  }
});
test("two tabs preserve concurrent signed branches in one storage transaction", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "A dictionary shaped by its readers" }),
  ).toBeVisible();
  const fixture = await page.evaluate(
    async (corePath) => {
      const core = await import(corePath);
      await core.initializeCore();
      const { createKey } = await import(String("/src/keys.ts"));
      const key = await createKey("concurrency-test");
      const make = async (previous: string[], n: string) => {
        const prepared = core.prepareSigning(
          key.backup.identity,
          previous,
          n.repeat(32),
          { kind: "identity.merge" },
          null,
        );
        const signature = new Uint8Array(
          await crypto.subtle.sign("Ed25519", key.key, prepared.signing_bytes),
        );
        return core.finishSigning(prepared, signature);
      };
      const a = await make([], "a");
      const b = await make([a.envelope.id], "b");
      const c = await make([a.envelope.id], "c");
      const d = await make([b.envelope.id, c.envelope.id].sort(), "d");

      return {
        identity: key.backup.identity,
        items: [a, b, c, d].map((record) => ({
          id: record.envelope.id,
          identity: key.backup.identity,
          transport: JSON.stringify(record),
          state: "ready",
        })),
      };
    },
    `/@fs${resolve("packages/core/src/index.ts")}`,
  );
  const name = `concurrent-${Date.now()}`;
  await page.evaluate(
    async ({ fixture, name }) => {
      const { LocalStore } = await import(String("/src/storage.ts"));
      await new LocalStore(name).queue(fixture.items[0]);
    },
    { fixture, name },
  );
  const tab = await context.newPage();
  await tab.goto("/");
  await expect(
    tab.getByRole("heading", { name: "A dictionary shaped by its readers" }),
  ).toBeVisible();
  await Promise.all([
    page.evaluate(
      async ({ item, name }) => {
        const { LocalStore } = await import(String("/src/storage.ts"));
        await new LocalStore(name).queue(item);
      },
      { item: fixture.items[1], name },
    ),
    tab.evaluate(
      async ({ item, name }) => {
        const { LocalStore } = await import(String("/src/storage.ts"));
        await new LocalStore(name).queue(item);
      },
      { item: fixture.items[2], name },
    ),
  ]);
  const frontier = await page.evaluate(
    async ({ name, identity }) => {
      const { LocalStore } = await import(String("/src/storage.ts"));
      const { ownHeads } = await import(String("/src/api.ts"));
      return ownHeads(new LocalStore(name), identity, true);
    },
    { name, identity: fixture.identity },
  );
  expect(frontier).toEqual(
    fixture.items
      .slice(1, 3)
      .map((item) => item.id)
      .sort(),
  );
  const merged = await tab.evaluate(
    async ({ fixture, name }) => {
      const { LocalStore } = await import(String("/src/storage.ts"));
      const { ownHeads } = await import(String("/src/api.ts"));
      const store = new LocalStore(name);
      await store.queue(fixture.items[3]);
      return ownHeads(store, fixture.identity, true);
    },
    { fixture, name },
  );
  expect(merged).toEqual([fixture.items[3].id]);
  await tab.close();
});
test("downloaded search queries work without an API request and offline signing uses saved history", async ({
  page,
}) => {
  await createIdentity(page);
  await page.getByRole("link", { name: "Add", exact: true }).click();
  await page.getByLabel("Lojban word").fill("brode");
  await page
    .getByLabel("Definition", { exact: true })
    .fill("A disposable local search example.");
  await page.getByLabel("Gloss", { exact: true }).fill("search fixture");
  await page.getByLabel("License expression").fill("CC0-1.0");
  await page.getByLabel("Sign from history saved in this browser only").check();
  await page.route("**/api/v1/**", (route) => route.abort());
  await page.getByRole("button", { name: "Sign and save to outbox" }).click();
  await expect(page.getByText("Delivery: ready")).toBeVisible();
  await page.unroute("**/api/v1/**");
  await page.getByRole("button", { name: "Send to this test server" }).click();
  await expect(page.getByText("Delivery: stored")).toBeVisible();
  await page.getByRole("link", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: "Download search package" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "The search package is saved in this browser.",
  );
  let requests = 0;
  await page.route("**/api/v1/**", (route) => {
    requests++;
    return route.abort();
  });
  await page.getByLabel("Search words and meanings").fill("search fixture");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "brode", exact: true }),
  ).toBeVisible();
  expect(requests).toBe(0);
  await page.unroute("**/api/v1/**");
  await page.getByRole("link", { name: "brode", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "brode", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("A disposable local search example.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Bless", exact: true }).click();
  await expect(page.getByText("Delivery: ready")).toBeVisible();
  await page.getByRole("button", { name: "Send to this test server" }).click();
  await expect(page.getByText("Delivery: stored", { exact: true })).toHaveCount(
    2,
  );
  const opinions = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/storage.ts"));
    return (await new LocalStore().list("outbox")).map((item: any) => ({
      state: item.state,
      action: JSON.parse(item.transport).envelope.header.action,
    }));
  });
  expect(
    opinions.find((item: any) => item.action.kind === "judgment.set")?.state,
  ).toBe("stored");
});
test("a hash-correct signed body with an invalid schema stays unavailable", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "A dictionary shaped by its readers" }),
  ).toBeVisible();
  const id = await page.evaluate(
    async (corePath) => {
      const core = await import(corePath);
      await core.initializeCore();
      const fixtureSeed = crypto.getRandomValues(new Uint8Array(32));
      const body = {
        text: [["This malformed body must not become a readable definition."]],
      };
      const bytes = core.utf8(
        core.canonicalize(core.utf8(JSON.stringify(body))),
      );
      const envelope = core.signHeader(fixtureSeed, {
        version: 1,
        issuer: core.identityFromSeed(fixtureSeed),
        previous: [],
        nonce: "f".repeat(32),
        action: {
          kind: "definition.publish",
          word: core.wordId({ language: "jbo", spelling: "brodi" }),
          language: "en",
          parents: [],
          origin: "native",
        },
        content: { hash: core.contentHash(bytes), bytes: bytes.length },
      });
      fixtureSeed.fill(0);
      const response = await fetch("/api/v1/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ envelope, body }),
      });
      if (!response.ok)
        throw new Error("The malformed fixture was not retained.");
      return envelope.id;
    },
    `/@fs${resolve("packages/core/src/index.ts")}`,
  );
  await page.goto(`/definition/${encodeURIComponent(id)}`);
  await expect(
    page.getByText(
      "This signed body does not satisfy the definition format. Its content is unavailable.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      "This malformed body must not become a readable definition.",
      { exact: true },
    ),
  ).toHaveCount(0);
});
