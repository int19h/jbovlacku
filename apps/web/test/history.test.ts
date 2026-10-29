import { test, expect, type Page } from "@playwright/test";
import {
  acceptFirstSignature,
  corePath,
  createIdentity,
  fixture,
  openWord,
} from "./helpers.ts";

async function outboxItems(page: Page) {
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().list("outbox");
  });
}

test("a failed local write never reports a saved group and sends nothing", async ({
  page,
}) => {
  // This page runs no app, so every fetch during publish belongs to the signer under test.
  await page.route("**/failed-write-harness", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Failed write test</title>",
    }),
  );
  await page.goto("/failed-write-harness");
  const result = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { createKey } = await import(String("/src/data/keys.ts"));
    const { Signer } = await import(String("/src/app/actions.ts"));
    const created = await createKey("storage failure");
    let calls = 0;
    const oldFetch = window.fetch;
    window.fetch = async () => {
      calls++;
      return new Response("{}");
    };
    const store = {
      get: async () => [],
      list: async () => [],
      queueGroup: async () => {
        throw new Error("Storage failed");
      },
    };
    const session = {
      preferences: {
        peers: [{ id: "self", base: "/failed-write-test", label: "test peer" }],
      },
      storageAvailable: true,
      backup: created.backup,
      workingKey: created.key,
      store,
      touch() {},
      signingDisabled: async () => null,
    };
    const signer = new Signer(session as any, {} as any, () => true);
    try {
      await signer.publish([
        {
          action: {
            kind: "judgment.set",
            target: "jve1:" + "a".repeat(64),
            value: "bless",
          },
          body: null,
        },
      ]);
      return { calls, failed: false };
    } catch (error) {
      const offlineCalls = calls;
      // This probe uses the ordinary self peer, so a peer or offline bypass cannot hide a fetch.
      const onlineSigner = new Signer(session as any, {} as any, () => false);
      await onlineSigner
        .publish([
          {
            action: {
              kind: "judgment.set",
              target: "jve1:" + "a".repeat(64),
              value: "bless",
            },
            body: null,
          },
        ])
        .catch(() => {});
      return {
        calls: offlineCalls,
        foregroundProbeCalls: calls - offlineCalls,
        failed: true,
        message: String(error),
      };
    } finally {
      window.fetch = oldFetch;
    }
  }, corePath);
  expect(result.calls).toBe(0);
  expect(result.failed).toBe(true);
  expect(result.foregroundProbeCalls).toBeGreaterThan(0);
  expect(result.message).toContain("Storage failed");
});

test("two tabs preserve concurrent signed branches in one storage transaction", async ({
  page,
  context,
}) => {
  await page.goto("/");
  const fixture = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { createKey } = await import(String("/src/data/keys.ts"));
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
      items: [a, b, c, d].map((record, order) => ({
        id: record.envelope.id,
        identity: key.backup.identity,
        transport: JSON.stringify(record),
        group: `g${order}`,
        order: 0,
        label: { action: "merge", subject: "test", href: "/" },
        peers: {
          self: {
            state: "queued",
            attempts: 0,
            lastAttempt: null,
            nextAttempt: null,
            error: null,
            failure: null,
            receipt: null,
          },
        },
        stopped: false,
        signedAt: 0,
      })),
    };
  }, corePath);
  const name = `concurrent-${Date.now()}`;
  const queue = async (tab: typeof page, item: unknown) =>
    tab.evaluate(
      async ({ item, name }) => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        await new LocalStore(name).queueGroup([item]);
      },
      { item, name },
    );
  await queue(page, fixture.items[0]);
  const tab = await context.newPage();
  await tab.goto("/");
  await Promise.all([
    queue(page, fixture.items[1]),
    queue(tab, fixture.items[2]),
  ]);
  const frontier = await page.evaluate(
    async ({ name, identity }) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { ownHeads } = await import(String("/src/data/history.ts"));
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
  await queue(tab, fixture.items[3]);
  const merged = await tab.evaluate(
    async ({ name, identity }) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { ownHeads } = await import(String("/src/data/history.ts"));
      return ownHeads(new LocalStore(name), identity, true);
    },
    { name, identity: fixture.identity },
  );
  expect(merged).toEqual([fixture.items[3].id]);
  await tab.close();
});

test("own-history pagination rejects loops and malformed pages while preserving concurrent heads", async ({
  page,
}) => {
  await page.goto("/");
  const results = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { loadOwnHistory } = await import(String("/src/data/history.ts"));
    const peer = {
      id: "isolated",
      base: "/own-history-test",
      label: "test peer",
    };
    const ownHeads = async (
      store: any,
      identity: string,
      offline = false,
      signal?: AbortSignal,
    ) =>
      (await loadOwnHistory(store, identity, { offline, signal, peer }))
        .frontier;
    const seed = new Uint8Array(32).fill(103);
    const parent = core.createEvent(
      seed,
      [],
      "0".repeat(32),
      { kind: "identity.merge" },
      null,
    ).envelope;
    const heads = Array.from(
      { length: 65 },
      (_, index) =>
        core.createEvent(
          seed,
          [parent.id],
          (index + 1).toString(16).padStart(32, "0"),
          { kind: "identity.merge" },
          null,
        ).envelope,
    ).sort((a, b) => a.id.localeCompare(b.id));
    const identity = parent.header.issuer;
    const snapshot = "sha256:" + "a".repeat(64);
    const records = new Map(
      [parent, ...heads].map((record) => [record.id, record]),
    );
    const headPage = (ids: string[], next: string | null) => ({
      snapshot,
      identity,
      heads: ids,
      next,
    });
    const scenarios: any[] = [
      {
        name: "normal concurrent frontier",
        pages: [
          headPage([heads[0].id], heads[0].id),
          headPage([heads[1].id], null),
        ],
        remembered: [parent.id, heads[64].id],
      },
      {
        name: "repeated cursor",
        pages: [
          headPage([heads[0].id], heads[0].id),
          headPage([heads[0].id], heads[0].id),
        ],
      },
      { name: "no progress", pages: [headPage([], heads[0].id)] },
      {
        name: "wrong last cursor",
        pages: [headPage([heads[0].id], heads[1].id)],
      },
      {
        name: "oversized page",
        pages: [headPage(Array(257).fill(heads[0].id), null)],
      },
      {
        name: "invalid heads",
        pages: [{ ...headPage([], null), heads: null }],
      },
      { name: "invalid head ID", pages: [headPage(["not-an-event"], null)] },
      { name: "invalid cursor", pages: [{ ...headPage([], null), next: 7 }] },
      { name: "empty cursor", pages: [headPage([], "")] },
      { name: "missing cursor", pages: [{ snapshot, identity, heads: [] }] },
      {
        name: "wrong snapshot",
        pages: [
          headPage([heads[0].id], heads[0].id),
          { ...headPage([], null), snapshot: "sha256:" + "b".repeat(64) },
        ],
      },
      {
        name: "descending heads",
        pages: [headPage([heads[1].id, heads[0].id], null)],
      },
      {
        name: "too many pages",
        pages: heads.map((head) => headPage([head.id], head.id)),
      },
    ];
    const oldFetch = window.fetch;
    const results: {
      name: string;
      frontier?: string[];
      error?: string;
      pages: number;
      eventReads: number;
    }[] = [];
    try {
      for (const scenario of scenarios) {
        let pages = 0;
        let eventReads = 0;
        const store = {
          get: async () => scenario.remembered ?? [],
          list: async () =>
            scenario.remembered
              ? [
                  {
                    identity,
                    id: heads[64].id,
                    transport: JSON.stringify({ envelope: heads[64] }),
                  },
                ]
              : [],
        };
        window.fetch = async (url, options) => {
          const path = String(url);
          if (!path.includes("/own-history-test/"))
            return oldFetch(url, options);
          if (path.endsWith("/manifest"))
            return new Response(JSON.stringify({ snapshot, packages: [] }));
          if (path.includes("/identity-heads/")) {
            if (!path.includes("limit=256"))
              throw new Error("No explicit page limit");
            const nextPage = scenario.pages[pages++] ?? scenario.pages.at(-1);
            return new Response(JSON.stringify(nextPage));
          }
          eventReads++;
          const id = decodeURIComponent(
            path.split("/events/")[1].split("?")[0],
          );
          return new Response(JSON.stringify(records.get(id)));
        };
        try {
          results.push({
            name: scenario.name,
            frontier: await ownHeads(store as any, identity),
            pages,
            eventReads,
          });
        } catch (error) {
          results.push({
            name: scenario.name,
            error: (error as Error).message,
            pages,
            eventReads,
          });
        }
      }
      return {
        results,
        expected: [heads[0].id, heads[1].id, heads[64].id].sort(),
      };
    } finally {
      window.fetch = oldFetch;
    }
  }, corePath);
  expect(results.results[0].frontier).toEqual(results.expected);
  expect(results.results[0].pages).toBe(2);
  for (const result of results.results.slice(1))
    expect(result.frontier, result.name).toBeUndefined();
  expect(
    results.results.find((result) => result.name === "repeated cursor"),
  ).toMatchObject({
    pages: 2,
    eventReads: 1,
    error: expect.stringContaining("repeated a cursor"),
  });
  expect(
    results.results.find((result) => result.name === "too many pages"),
  ).toMatchObject({
    pages: 64,
    error: expect.stringContaining("browser work limit"),
  });
  expect(
    results.results.find((result) => result.name === "wrong snapshot"),
  ).toMatchObject({
    pages: 2,
    eventReads: 1,
    error: expect.stringContaining("invalid own-history page"),
  });
  for (const result of results.results
    .slice(2, -1)
    .filter((result) => result.name !== "wrong snapshot"))
    expect(result.eventReads, result.name).toBe(0);
});

test("own-history has an overall deadline and respects caller cancellation", async ({
  page,
}) => {
  await page.goto("/");
  const results = await page.evaluate(async () => {
    const { loadOwnHistory } = await import(String("/src/data/history.ts"));
    const peer = {
      id: "isolated",
      base: "/own-history-test",
      label: "test peer",
    };
    const ownHeads = async (
      store: any,
      identity: string,
      offline = false,
      signal?: AbortSignal,
    ) =>
      (await loadOwnHistory(store, identity, { offline, signal, peer }))
        .frontier;
    const oldFetch = window.fetch;
    const oldTimeout = AbortSignal.timeout;
    const timeouts: number[] = [];
    AbortSignal.timeout = (milliseconds) => {
      timeouts.push(milliseconds);
      return oldTimeout.call(
        AbortSignal,
        milliseconds === 120000 ? 25 : milliseconds,
      );
    };
    let requests = 0;
    window.fetch = async (input, options) => {
      if (!String(input).includes("/own-history-test/"))
        return oldFetch(input, options);
      requests++;
      return new Promise((_, reject) =>
        options!.signal!.addEventListener(
          "abort",
          () => reject(options!.signal!.reason),
          { once: true },
        ),
      );
    };
    const store = { get: async () => [], list: async () => [] };
    const errors: string[] = [];
    try {
      try {
        await ownHeads(store as any, "ed25519:" + "1".repeat(64));
      } catch (error) {
        errors.push((error as Error).name + ":" + (error as any).kind);
      }
      const requestsAfterTimeout = requests;
      const controller = new AbortController();
      controller.abort();
      try {
        await ownHeads(
          store as any,
          "ed25519:" + "1".repeat(64),
          false,
          controller.signal,
        );
      } catch (error) {
        errors.push((error as Error).name);
      }
      // A browser storage read that never finishes still ends at the deadline, without any request.
      const stalledStore = {
        get: () => new Promise<never>(() => {}),
        list: async () => [],
      };
      try {
        await ownHeads(stalledStore as any, "ed25519:" + "1".repeat(64), true);
      } catch (error) {
        errors.push((error as Error).name);
      }
      // Caller cancellation also stops a stalled local read.
      const cancel = new AbortController();
      setTimeout(() => cancel.abort(), 10);
      try {
        await ownHeads(
          stalledStore as any,
          "ed25519:" + "1".repeat(64),
          true,
          cancel.signal,
        );
      } catch (error) {
        errors.push((error as Error).name);
      }
      return { errors, requests, requestsAfterTimeout, timeouts };
    } finally {
      window.fetch = oldFetch;
      AbortSignal.timeout = oldTimeout;
    }
  });
  expect(results.errors).toEqual([
    "Error:timeout",
    "AbortError",
    "TimeoutError",
    "AbortError",
  ]);
  // A caller signal that is already aborted never reaches the network.
  expect(results.requests).toBe(results.requestsAfterTimeout);
  expect(results.timeouts).toContain(120000);
  expect(results.timeouts).toContain(20000);
});

test("version 1 browser data migrates without losing bytes, branches, or body evidence", async ({
  page,
}) => {
  await page.goto("/");
  // Freeze a version 1 database in a separate name, then open it with the current store.
  const result = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const seed = new Uint8Array(32).fill(111);
    const a = core.createEvent(
      seed,
      [],
      "1".repeat(32),
      { kind: "identity.merge" },
      null,
    );
    const b = core.createEvent(
      seed,
      [a.envelope.id],
      "2".repeat(32),
      { kind: "identity.merge" },
      null,
    );
    const c = core.createEvent(
      seed,
      [a.envelope.id],
      "3".repeat(32),
      { kind: "identity.merge" },
      null,
    );
    const d = core.createEvent(
      seed,
      [b.envelope.id],
      "4".repeat(32),
      { kind: "identity.merge" },
      null,
    );
    const e = core.createEvent(
      seed,
      [d.envelope.id],
      "5".repeat(32),
      { kind: "identity.profile" },
      { name: "migrated", bio: [], links: [] },
    );
    const identity = a.envelope.header.issuer;
    const name = `migration-${Date.now()}`;
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        for (const store of ["keys", "drafts", "outbox", "heads", "packages"])
          request.result.createObjectStore(store);
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(["outbox", "heads", "drafts"], "readwrite");
        const old = (record: any, state: string, receipt?: unknown) => ({
          id: record.envelope.id,
          identity,
          transport: JSON.stringify(record),
          state,
          receipt,
        });
        const receipt = (record: any, patch: Record<string, unknown>) => ({
          id: record.envelope.id,
          admission: "accepted",
          interpretation: "effective",
          body_status: "none",
          cursor: "1",
          snapshot: null,
          view: "jve1:" + "0".repeat(64),
          reasons: [],
          envelope_hash: core.contentHash(
            core.utf8(
              core.canonicalize(core.utf8(JSON.stringify(record.envelope))),
            ),
          ),
          ...patch,
        });
        // a: full evidence. b: no receipt. c: unknown. d: contradictory envelope hash. e: body without its hash.
        tx.objectStore("outbox").put(
          old(a, "stored", receipt(a, {})),
          a.envelope.id,
        );
        tx.objectStore("outbox").put(old(b, "stored"), b.envelope.id);
        tx.objectStore("outbox").put(old(c, "unknown"), c.envelope.id);
        tx.objectStore("outbox").put(
          old(
            d,
            "stored",
            receipt(d, { envelope_hash: "sha256:" + "1".repeat(64) }),
          ),
          d.envelope.id,
        );
        tx.objectStore("outbox").put(
          old(
            e,
            "stored",
            receipt(e, { body_status: "present", body_hash: null }),
          ),
          e.envelope.id,
        );
        tx.objectStore("heads").put(
          [e.envelope.id, c.envelope.id].sort(),
          identity,
        );
        tx.objectStore("drafts").put({ text: "old draft" }, "current");
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { ownHeads } = await import(String("/src/data/history.ts"));
    const { classifyReceipt } = await import(String("/src/data/delivery.ts"));
    const store = new LocalStore(name);
    const before = Object.fromEntries(
      (await store.list("outbox")).map((item: any) => [
        item.id,
        item.peers.self.state,
      ]),
    );
    await store.reconcileMigrated((item: any, receipt: any) =>
      classifyReceipt(item, receipt, () =>
        Promise.reject(new Error("no variant lookup")),
      ),
    );
    const items = await store.list("outbox");
    const frontier = await ownHeads(store, identity, true);
    return {
      states: Object.fromEntries(
        items.map((item: any) => [item.id, item.peers.self.state]),
      ),
      transports: items.map((item: any) => item.transport),
      expectedTransports: [a, b, c, d, e].map((r) => JSON.stringify(r)).sort(),
      frontier,
      expectedFrontier: [e.envelope.id, c.envelope.id].sort(),
      draft: await store.get("drafts", "current"),
      ids: {
        a: a.envelope.id,
        b: b.envelope.id,
        c: c.envelope.id,
        d: d.envelope.id,
        e: e.envelope.id,
      },
      before,
      migratedFlags: items.map((item: any) => item.migrated ?? null),
    };
  }, corePath);
  // Before the receipt rules run, every stored row is unknown. Nothing is accepted by its old mark alone.
  expect(result.before[result.ids.a]).toBe("unknown");
  expect(result.before[result.ids.d]).toBe("unknown");
  // Full evidence: the receipt names the stored envelope hash and the required body status.
  expect(result.states[result.ids.a]).toBe("accepted");
  // A stored mark without receipt evidence does not prove delivery. The bytes stay and a receipt is requested.
  expect(result.states[result.ids.b]).toBe("unknown");
  expect(result.states[result.ids.c]).toBe("unknown");
  // A contradictory envelope hash and a body receipt without its hash stay unknown.
  expect(result.states[result.ids.d]).toBe("unknown");
  expect(result.states[result.ids.e]).toBe("unknown");
  expect(result.migratedFlags.every((flag: unknown) => flag === null)).toBe(
    true,
  );
  expect([...result.transports].sort()).toEqual(result.expectedTransports);
  expect(result.frontier).toEqual(result.expectedFrontier);
  expect(result.draft).toEqual({ text: "old draft" });
});

test("a native IndexedDB open failure keeps a warning and allows anonymous online reading", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  // Data that exists before the failure: a delivered record and a private trust rule.
  // The checks below then cover controls that only populated data shows.
  const curator = fixture().identities.curator;
  await createIdentity(page);
  await openWord(page, "cukta");
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await acceptFirstSignature(page);
  await expect
    .poll(async () => (await outboxItems(page))[0]?.peers.self.state)
    .toBe("accepted");
  await page.evaluate(async (curator) => {
    const { LocalStore, emptyOverlay } = await import(
      String("/src/data/store.ts")
    );
    const store = new LocalStore();
    await store.setOverlay({
      ...emptyOverlay(),
      trust: [
        {
          issuer: "local",
          subject: curator,
          scope: { kind: "*", word: "*", language: "*" },
          value: "heed",
          weight: null,
        },
      ],
    });
  }, curator);
  await page.goto("/trust");
  await expect(
    page.getByRole("button", { name: /Make public|Remove/ }).first(),
  ).toBeVisible();
  await page.goto("/outbox");
  await page.getByText(/Retained records \(1 delivered\)/).click();
  await expect(
    page.getByRole("button", { name: "Export every retained record" }),
  ).toBeVisible();
  await page.addInitScript(async () => {
    const events = { openErrors: [] as string[], rejections: [] as string[] };
    (window as any).storageFailureEvents = events;
    window.addEventListener("unhandledrejection", (event) =>
      events.rejections.push(String(event.reason)),
    );
    const nativeOpen = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args: Parameters<IDBFactory["open"]>) => {
      const request = nativeOpen(...args);
      request.addEventListener("error", () =>
        events.openErrors.push(request.error?.name ?? "unknown"),
      );
      return request;
    };
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("jbovlacku-browser-v1", 5);
      request.onupgradeneeded = () => {
        // The store exists when data was written before the failure.
        if (!request.result.objectStoreNames.contains("keys"))
          request.result.createObjectStore("keys");
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  });
  // A slow core load must not raise errors or rejections while storage is unavailable.
  await page.route("**/*.wasm", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await route.continue();
  });
  await page.goto("/search?q=book&lang=en");
  const warning = page.getByRole("alert");
  await expect(warning).toHaveText(
    "Browser storage is unavailable. You can read online. Drafts, keys, signing, and downloaded search are disabled. Restore storage access and reload this page.",
  );
  await expect(
    page.getByRole("link", { name: "cukta", exact: true }),
  ).toBeVisible();
  // Reading works, but every writing control is disabled with an explanation.
  await page.getByRole("link", { name: "cukta", exact: true }).first().click();
  await expect(page).toHaveTitle("cukta · jbovlacku");
  const endorse = page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" });
  await expect(endorse).toBeDisabled();
  await expect(endorse).toHaveAttribute(
    "title",
    /Browser storage is unavailable/,
  );
  await expect(warning).toBeVisible();
  await page.goto(
    `/identity/${encodeURIComponent(fixture().identities.curator)}`,
  );
  for (const name of [
    "Trust their judgments",
    "Ignore their judgments",
    "Report abuse",
  ])
    await expect(page.getByRole("button", { name })).toBeDisabled();
  await expect(warning).toBeVisible();
  // Each page names its explanation and hides the controls it offers with storage.
  for (const [path, heading, explanation, absent] of [
    [
      "/new/meaning",
      "Add a word",
      "drafts cannot be saved",
      () => page.getByRole("textbox", { name: "Meaning", exact: true }),
    ],
    [
      "/identity",
      "Browser storage unavailable",
      "Restore browser storage access",
      () => page.getByRole("button", { name: "Create a key", exact: true }),
    ],
    [
      "/outbox",
      "Browser storage unavailable",
      "Restore browser storage access",
      () => page.getByRole("button", { name: "Export every retained record" }),
    ],
    [
      "/preferences",
      "Settings",
      "Packages cannot be saved",
      () => page.getByRole("button", { name: "Download", exact: true }),
    ],
  ] as const) {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
    await expect(page.locator("main")).toContainText(explanation);
    await expect(warning).toBeVisible();
    await expect(absent()).toHaveCount(0);
  }
  // The Trust page shows the site view. The saved private rule has no controls now.
  await page.goto("/trust");
  await expect(
    page.getByRole("heading", { name: "Trust", exact: true }),
  ).toBeVisible();
  await expect(warning).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Make public|Remove|Undo/ }),
  ).toHaveCount(0);
  await page.goto("/search?q=book&lang=en");
  await expect(warning).toBeVisible();
  await expect(page.getByLabel("Search words and meanings")).toBeEnabled();
  await page.getByRole("link", { name: "cukta", exact: true }).click();
  await expect(page.locator("article.definition").first()).toBeVisible();
  await expect(warning).toBeVisible();
  for (const path of ["/identity", "/outbox"]) {
    await page.goto(path);
    await expect(
      page.getByRole("heading", {
        name: "Browser storage unavailable",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator("main form")).toHaveCount(0);
  }
  await page.goto("/search?q=book&lang=en");
  await expect(page.getByLabel("Search words and meanings")).toBeEnabled();
  expect(
    await page.evaluate(() => (window as any).storageFailureEvents),
  ).toEqual({ openErrors: ["VersionError"], rejections: [] });
  expect(pageErrors).toEqual([]);
});

test("own records fetched from the server are kept locally, so later signatures fetch nothing again", async ({
  page,
}) => {
  await createIdentity(page);
  // Counts fetches of this key's first record. Word pages fetch other records too.
  let firstId = "";
  let envelopeFetches = 0;
  page.on("request", (request) => {
    if (
      firstId &&
      request.method() === "GET" &&
      request.url().includes(`/api/v1/events/${encodeURIComponent(firstId)}`)
    )
      envelopeFetches++;
  });
  // These signatures judge words that no exact-count assertion reads, so
  // the seeded cukta scores stay as the fixture contract states them.
  await openWord(page, "vlacku");
  const articles = page.locator("article.definition");
  await articles.nth(0).getByRole("button", { name: "Endorse" }).click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toContainText(/ndorse/);
  await expect
    .poll(async () => (await outboxItems(page))[0]?.peers.self.state)
    .toBe("accepted");
  firstId = (await outboxItems(page))[0].id;
  // A restored key holds no local history. Only the server knows the first record.
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    for (const name of ["outbox", "ownhistory", "heads"])
      for (const key of await store.keys(name)) await store.delete(name, key);
  });
  await page.goto("/identity");
  await page
    .getByLabel("Passphrase", { exact: true })
    .fill("test passphrase with spaces");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByText("Unlocked", { exact: true })).toBeVisible();
  await openWord(page, "ckusro");
  await articles.nth(0).getByRole("button", { name: "Endorse" }).click();
  await expect(page.getByRole("status")).toContainText(/ndorse/);
  await expect.poll(async () => (await outboxItems(page)).length).toBe(1);
  // The first signature after the restore fetched the one unknown record and kept it.
  expect(envelopeFetches).toBe(1);
  const kept = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().list("ownhistory");
  });
  expect(kept).toHaveLength(1);
  expect(kept[0].id).toBe(firstId);
  // The next signature reads that record here. Nothing is fetched again.
  await openWord(page, "vlacku");
  await articles.nth(0).getByRole("button", { name: "Oppose" }).click();
  await expect(page.getByRole("status")).toContainText(/ppos/);
  await expect.poll(async () => (await outboxItems(page)).length).toBe(2);
  expect(envelopeFetches).toBe(1);
  // The restored history is the chain: the third record follows the second, which follows the first.
  const items = (await outboxItems(page)).sort(
    (a: any, b: any) => a.signedAt - b.signedAt,
  );
  const second = JSON.parse(items[0].transport).envelope;
  const third = JSON.parse(items[1].transport).envelope;
  expect(second.header.previous).toEqual([firstId]);
  expect(third.header.previous).toEqual([second.id]);
});

test("a record without a saved recipient address says that export is the only path", async ({
  page,
}) => {
  await createIdentity(page);
  await openWord(page, "cukta");
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await acceptFirstSignature(page);
  await expect
    .poll(async () => (await outboxItems(page))[0]?.peers.self.state)
    .toBe("accepted");
  // A migrated row keeps its bytes and no address. Current preferences never supply one.
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { freshPeer } = await import(String("/src/data/delivery.ts"));
    const store = new LocalStore();
    const [item] = await store.list("outbox");
    await store.put("outbox", item.id, {
      ...item,
      recipients: {},
      peers: { self: freshPeer() },
      stopped: false,
    });
  });
  await page.goto("/outbox");
  const row = page
    .getByRole("list", { name: "Unfinished records" })
    .getByRole("listitem");
  await expect(row).toContainText("is not configured in this record");
  await expect(row).toContainText(
    "Export is the only path: save the record as a file and submit it with another client, then stop retrying here.",
  );
  await expect(row).not.toContainText("Next try");
});
