import { test, expect } from "@playwright/test";
import {
  createIdentity,
  openWord,
  acceptFirstSignature,
  corePath,
} from "./helpers.ts";
import type { OutboxItem, PeerDelivery } from "../src/data/store.ts";

/** Saves synthetic own records without sending them to a peer. */
async function seed(page: import("@playwright/test").Page) {
  await page.goto("/outbox");
  await expect(page.locator("main h1")).toHaveText("Not delivered");
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { freshPeer } = await import(String("/src/data/delivery.ts"));
    const store = new LocalStore();
    const make = (id: string, previous: string[], stopped = true) => ({
      id,
      identity: "test",
      group: id,
      order: 0,
      stopped,
      signedAt: 1,
      transport: JSON.stringify({
        envelope: { id, header: { issuer: "test", previous } },
        body: { text: id },
      }),
      label: { subject: id, action: "test record", href: "/" },
      peers: {
        self: {
          ...freshPeer(),
          state: "refused",
          failure: "refused",
          nextAttempt: null,
        },
        mirror: { ...freshPeer(), state: "accepted", nextAttempt: null },
      },
    });
    await store.queueGroup([
      make("base", [], false),
      make("middle", ["base"]),
      make("leaf", ["middle"]),
    ]);
    (window as any).makeOutbox = make;
  });
  await page.reload();
}

test("stopped rows stay counted and only a leaf offers confirmed discard", async ({
  page,
}) => {
  await seed(page);
  await expect(
    page.getByRole("link", { name: "3 not delivered" }),
  ).toBeVisible();
  const middle = page.locator('[data-outbox-record="middle"]');
  const leaf = page.locator('[data-outbox-record="leaf"]');
  await expect(middle.getByText("Stopped", { exact: true })).toBeVisible();
  await expect(middle).toContainText("Later records depend on this record.");
  await expect(middle.getByRole("button", { name: "Discard" })).toHaveCount(0);
  await expect(
    middle.getByRole("button", { name: "Resume", exact: true }),
  ).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await middle
    .getByRole("button", { name: "Save as file", exact: true })
    .click();
  const download = await downloadPromise;
  const bytes = await (await download.createReadStream())
    .toArray()
    .then((chunks) => Buffer.concat(chunks as Buffer[]).toString());
  expect(JSON.parse(bytes).envelope.id).toBe("middle");
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain(
      "This does not retract a copy that a server already holds.",
    );
    void dialog.dismiss();
  });
  await leaf.getByRole("button", { name: "Discard" }).click();
  await expect(leaf).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await leaf.getByRole("button", { name: "Discard" }).click();
  await expect(leaf).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "2 not delivered" }),
  ).toBeVisible();
  const result = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    await store.mergeOutbox("leaf", () => {
      throw new Error("A late receipt recreated a discarded row.");
    });
    return {
      heads: await store.get("heads", "test"),
      leaf: await store.get("outbox", "leaf"),
    };
  });
  expect(result).toEqual({ heads: ["middle"], leaf: undefined });
  await expect(middle.getByRole("button", { name: "Discard" })).toBeVisible();
});

test("discard rechecks a stale row after another tab saves a dependent record", async ({
  page,
}) => {
  await seed(page);
  const leaf = page.locator('[data-outbox-record="leaf"]');
  await expect(leaf.getByRole("button", { name: "Discard" })).toBeVisible();
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const leaf = await store.get("outbox", "leaf");
    const later = {
      ...leaf,
      id: "later",
      group: "later",
      transport: JSON.stringify({
        envelope: {
          id: "later",
          header: { issuer: "test", previous: ["leaf"] },
        },
        body: null,
      }),
    };
    await store.queueGroup([later]);
  });
  page.once("dialog", (dialog) => void dialog.accept());
  await leaf.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Later records depend on this record.",
  );
  await expect(leaf).toBeVisible();
  await expect(leaf.getByRole("button", { name: "Discard" })).toHaveCount(0);
});

test("discard guards cached own branches and rejects a pre-signed group after deletion", async ({
  page,
}) => {
  await seed(page);
  const result = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const leaf = await store.get("outbox", "leaf");
    const own = {
      id: "cached",
      header: { issuer: "test", previous: ["leaf"] },
    };
    await store.put("ownhistory", "cached", own);
    const blocked = await store.discardOutbox("middle").then(
      () => false,
      () => true,
    );
    const cachedBlocked = await store.discardOutbox("leaf").then(
      () => false,
      () => true,
    );
    await store.delete("ownhistory", "cached");
    await store.discardOutbox("leaf");
    const stale = {
      ...leaf,
      id: "later",
      transport: JSON.stringify({
        envelope: {
          id: "later",
          header: { issuer: "test", previous: ["leaf"] },
        },
        body: null,
      }),
    };
    const staleBlocked = await store.queueGroup([stale]).then(
      () => false,
      () => true,
    );
    return {
      blocked,
      cachedBlocked,
      staleBlocked,
      later: await store.get("outbox", "later"),
      heads: await store.get("heads", "test"),
    };
  });
  expect(result).toEqual({
    blocked: true,
    cachedBlocked: true,
    staleBlocked: true,
    later: undefined,
    heads: ["middle"],
  });
});

test("a stopped in-flight row clears when all recipients accept", async ({
  page,
}) => {
  await seed(page);
  const result = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { isNotDelivered } = await import(String("/src/data/delivery.ts"));
    const store = new LocalStore();
    const leaf = await store.mergeOutbox("leaf", (item: OutboxItem) => ({
      ...item,
      peers: Object.fromEntries(
        Object.entries(item.peers).map(([id, peer]) => [
          id,
          { ...peer, state: "accepted" },
        ]),
      ),
    }));
    return isNotDelivered(leaf!);
  });
  expect(result).toBe(false);
  await page.reload();
  await expect(
    page.locator(
      '[aria-label="Unfinished records"] [data-outbox-record="leaf"]',
    ),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "2 not delivered" }),
  ).toBeVisible();
});

test("lifecycle commits refuse an unverified discarded predecessor", async ({
  page,
}) => {
  await seed(page);
  const result = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { queueCompromise, queueHandover } = await import(
      String("/src/data/lifecycle.ts")
    );
    const store = new LocalStore();
    const leaf = await store.get("outbox", "leaf");
    await store.discardOutbox("leaf");
    // An ID without its authenticated server envelope cannot clear the discard marker.
    await store.put("heads", "test", ["leaf"]);
    const old = { identity: "test" };
    const successor = { identity: "next" };
    await store.put("keys", "selected", old);
    const item = (
      id: string,
      issuer: string,
      previous: string[],
      action: unknown,
    ) => ({
      ...leaf,
      id,
      identity: issuer,
      transport: JSON.stringify({
        envelope: { id, header: { issuer, previous, action } },
        body: null,
      }),
    });
    const compromise = item("compromise", "test", ["leaf"], {
      kind: "identity.compromise",
    });
    const transfer = item("transfer", "test", ["leaf"], {
      kind: "identity.transfer",
      successor: "next",
    });
    const accept = item("accept", "next", [], {
      kind: "identity.accept",
      transfer: "transfer",
    });
    const compromiseError = await queueCompromise(store, compromise, [
      "leaf",
    ]).then(
      () => "",
      (error: Error) => error.message,
    );
    const handoverError = await queueHandover(store, {
      transfer,
      accept,
      old,
      successor,
      successorTested: false,
      expectedHeads: ["leaf"],
    }).then(
      () => "",
      (error: Error) => error.message,
    );
    return {
      compromiseError,
      handoverError,
      compromise: await store.get("outbox", "compromise"),
      transfer: await store.get("outbox", "transfer"),
      selected: await store.get("keys", "selected"),
      heads: await store.get("heads", "test"),
    };
  });
  expect(result.compromiseError).toContain("discarded local record");
  expect(result.handoverError).toContain("discarded local record");
  expect(result.compromise).toBeUndefined();
  expect(result.transfer).toBeUndefined();
  expect(result.selected).toEqual({ identity: "test" });
  expect(result.heads).toEqual(["leaf"]);
});

test("authenticated rediscovery restores signing and shows its notice once across navigation", async ({
  page,
}) => {
  await createIdentity(page);
  await openWord(page, "cukta");
  // The server stores the signed record, but the first client sees no receipt.
  await page.route("**/api/v1/events", async (route) => {
    await route.fetch();
    await route.abort("failed");
  });
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse", exact: true })
    .click();
  await acceptFirstSignature(page);
  await expect(
    page.getByRole("link", { name: "1 not delivered" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "1 not delivered" }).click();
  await page
    .getByRole("button", { name: "Stop retrying", exact: true })
    .click();
  const saved = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return (await new LocalStore().list("outbox"))[0];
  });
  // Admission can precede the completed snapshot that supplies identity heads.
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/api/v1/identity-heads/${encodeURIComponent(saved.identity)}?limit=256`,
      );
      return (await response.json()).heads ?? [];
    })
    .toContain(saved.id);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByText("No unfinished records.")).toBeVisible();
  expect(
    await page.evaluate(async (id) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      return new LocalStore().get("keys", `discarded:${id}`);
    }, saved.id),
  ).toBe(true);
  await page.unroute("**/api/v1/events");
  // The next ordinary public action loads authenticated server history and signs after it.
  await openWord(page, "ckusro");
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Your endorsement is published.",
  );
  const notice = page.getByRole("region", {
    name: "Rediscovered public record",
    exact: true,
  });
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText("reached a server after all");
  await expect(notice).toContainText("You can keep signing.");
  const after = await page.evaluate(async ({ id, identity }) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const records = await store.list("outbox");
    return {
      marker: await store.get("keys", `discarded:${id}`),
      recovered: await store.get("ownhistory", id),
      heads: await store.get("heads", identity),
      records,
    };
  }, saved);
  expect(after.marker).toBeUndefined();
  expect(after.recovered.id).toBe(saved.id);
  expect(after.records).toHaveLength(1);
  expect(
    JSON.parse(after.records[0].transport).envelope.header.previous,
  ).toEqual([saved.id]);
  expect(after.records[0].peers.self.state).toBe("accepted");
  expect(after.heads).toEqual([after.records[0].id]);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(notice).toBeHidden();
  await page.evaluate(async ({ id, identity }) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { loadOwnHistory } = await import(String("/src/data/history.ts"));
    const store = new LocalStore();
    await store.delete("ownhistory", id);
    await loadOwnHistory(store, identity);
    await loadOwnHistory(store, identity);
  }, saved);
  await page.reload();
  await expect(page.locator("main h1")).toBeVisible();
  await expect(notice).toBeHidden();
});

test("only verified server evidence clears a discard marker and notice claims are atomic", async ({
  page,
}) => {
  await page.goto("/outbox");
  const result = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { freshPeer } = await import(String("/src/data/delivery.ts"));
    const store = new LocalStore("rediscovery-negative");
    const record = core.createEvent(
      new Uint8Array(32).fill(91),
      [],
      "1".repeat(32),
      { kind: "identity.merge" },
      null,
    );
    const envelope = record.envelope;
    const identity = envelope.header.issuer;
    const marker = `discarded:${envelope.id}`;
    await store.put("keys", marker, true);
    await store.recordBranch(identity, [envelope]);
    await store.rememberOwn(identity, [envelope]);
    const localMarker = await store.get("keys", marker);
    const localNotice = await store.takeOwnRediscoveries(identity);
    const stale = core.createEvent(
      new Uint8Array(32).fill(91),
      [envelope.id],
      "2".repeat(32),
      { kind: "identity.merge" },
      null,
    );
    const item = {
      id: stale.envelope.id,
      identity,
      transport: JSON.stringify(stale),
      group: "stale",
      order: 0,
      label: { subject: "test", action: "profile", href: "/" },
      peers: { self: freshPeer() },
      stopped: false,
      signedAt: 1,
    };
    const staleBlocked = await store.queueGroup([item]).then(
      () => false,
      () => true,
    );
    const invalid = structuredClone(envelope);
    invalid.header.nonce = "3".repeat(32);
    const invalidBlocked = await store
      .restoreServerOwn(identity, [invalid])
      .then(
        () => false,
        () => true,
      );
    const wrongIdentityBlocked = await store
      .restoreServerOwn("ed25519:" + "0".repeat(64), [envelope])
      .then(
        () => false,
        () => true,
      );
    const { loadOwnHistory } = await import(String("/src/data/history.ts"));
    const oldFetch = window.fetch;
    // Remove the local cache so the requested head must come from this synthetic server.
    await store.delete("ownhistory", envelope.id);
    const snapshot = "sha256:" + "a".repeat(64);
    let mismatchedBlocked = false;
    try {
      window.fetch = async (input, options) => {
        const path = String(input);
        if (!path.includes("/rediscovery-test/"))
          return oldFetch(input, options);
        if (path.endsWith("/manifest"))
          return new Response(JSON.stringify({ snapshot, packages: [] }));
        if (path.includes("/identity-heads/"))
          return new Response(
            JSON.stringify({
              snapshot,
              identity,
              heads: [envelope.id],
              next: null,
            }),
          );
        return new Response(JSON.stringify(stale.envelope));
      };
      mismatchedBlocked = await loadOwnHistory(store, identity, {
        peer: { id: "test", base: "/rediscovery-test", label: "test" },
      }).then(
        () => false,
        () => true,
      );
    } finally {
      window.fetch = oldFetch;
    }
    const negativeMarker = await store.get("keys", marker);
    const negativeNotice = await store.takeOwnRediscoveries(identity);
    // A separately authenticated server fetch can now restore the same public record.
    const unknownHead = "jve1:" + "e".repeat(64);
    await store.put("heads", identity, [unknownHead]);
    await store.restoreServerOwn(identity, [envelope]);
    const restoredHeads = await store.get("heads", identity);
    const claims = await Promise.all([
      store.takeOwnRediscoveries(identity),
      new LocalStore("rediscovery-negative").takeOwnRediscoveries(identity),
    ]);
    await store.queueGroup([item]);
    await store.restoreServerOwn(identity, [envelope]);
    const duplicateNotice = await store.takeOwnRediscoveries(identity);
    return {
      id: envelope.id,
      localMarker,
      localNotice,
      staleBlocked,
      invalidBlocked,
      wrongIdentityBlocked,
      mismatchedBlocked,
      negativeMarker,
      negativeNotice,
      restoredHeads,
      unknownHead,
      claims,
      duplicateNotice,
      marker: await store.get("keys", marker),
    };
  }, corePath);
  expect(result.localMarker).toBe(true);
  expect(result.localNotice).toEqual([]);
  expect(result.staleBlocked).toBe(true);
  expect(result.invalidBlocked).toBe(true);
  expect(result.wrongIdentityBlocked).toBe(true);
  expect(result.mismatchedBlocked).toBe(true);
  expect(result.negativeMarker).toBe(true);
  expect(result.negativeNotice).toEqual([]);
  expect(result.restoredHeads).toEqual([result.id, result.unknownHead].sort());
  expect(result.claims.flat()).toEqual([result.id]);
  expect(result.duplicateNotice).toEqual([]);
  expect(result.marker).toBeUndefined();
});

test("handover branch refresh restores authenticated discarded server history", async ({
  page,
}) => {
  await page.goto("/outbox");
  const result = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { fetchBranches } = await import(String("/src/data/lifecycle.ts"));
    const store = new LocalStore("branch-rediscovery");
    const envelope = core.createEvent(
      new Uint8Array(32).fill(92),
      [],
      "4".repeat(32),
      { kind: "identity.merge" },
      null,
    ).envelope;
    const identity = envelope.header.issuer;
    await store.put("keys", `discarded:${envelope.id}`, true);
    const history = {
      identity,
      snapshot: null,
      events: new Map(),
      frontier: [],
      complete: true,
    };
    const knowledge = [
      {
        peer: { id: "test", base: "/branch-test", label: "test" },
        snapshot: "sha256:" + "a".repeat(64),
        outcome: "complete",
        heads: [envelope.id],
      },
    ];
    const oldFetch = window.fetch;
    try {
      window.fetch = async (input, options) =>
        String(input).includes("/branch-test/events/")
          ? new Response(JSON.stringify(envelope))
          : oldFetch(input, options);
      await fetchBranches(store, history, knowledge);
      const notices = await store.takeOwnRediscoveries(identity);
      await fetchBranches(store, history, knowledge);
      return {
        id: envelope.id,
        marker: await store.get("keys", `discarded:${envelope.id}`),
        saved: (await store.get("ownhistory", envelope.id)).id,
        heads: await store.get("heads", identity),
        frontier: history.frontier,
        notices,
        repeatedNotices: await store.takeOwnRediscoveries(identity),
      };
    } finally {
      window.fetch = oldFetch;
    }
  }, corePath);
  expect(result.marker).toBeUndefined();
  expect(result.saved).toBe(result.id);
  expect(result.heads).toEqual([result.id]);
  expect(result.frontier).toEqual([result.id]);
  expect(result.notices).toEqual([result.id]);
  expect(result.repeatedNotices).toEqual([]);
});

test("history refresh keeps its exact stored-head guard and rejects an unseen concurrent branch", async ({
  page,
}) => {
  await page.goto("/outbox");
  const result = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { loadOwnHistory } = await import(String("/src/data/history.ts"));
    const { fetchBranches } = await import(String("/src/data/lifecycle.ts"));
    const { freshPeer } = await import(String("/src/data/delivery.ts"));
    const seed = new Uint8Array(32).fill(94);
    const remote = core.createEvent(
      seed,
      [],
      "5".repeat(32),
      { kind: "identity.merge" },
      null,
    );
    const concurrent = core.createEvent(
      seed,
      [],
      "6".repeat(32),
      { kind: "identity.merge" },
      null,
    );
    const identity = remote.envelope.header.issuer;
    const snapshot = "sha256:" + "a".repeat(64);
    const peer = { id: "test", base: "/guard-test", label: "test" };
    const oldFetch = window.fetch;
    const failures: boolean[] = [];
    const heads: string[][] = [];
    const item = {
      id: concurrent.envelope.id,
      identity,
      transport: JSON.stringify(concurrent),
      group: "concurrent",
      order: 0,
      label: { subject: "test", action: "merge", href: "/" },
      peers: { self: freshPeer() },
      stopped: false,
      signedAt: 1,
    };
    try {
      window.fetch = async (input, options) => {
        const path = String(input);
        if (!path.includes("/guard-test/")) return oldFetch(input, options);
        if (path.endsWith("/manifest"))
          return new Response(JSON.stringify({ snapshot, packages: [] }));
        if (path.includes("/identity-heads/"))
          return new Response(
            JSON.stringify({
              snapshot,
              identity,
              heads: [remote.envelope.id],
              next: null,
            }),
          );
        return new Response(JSON.stringify(remote.envelope));
      };
      for (const branch of [false, true]) {
        const store = new LocalStore(`guard-concurrent-${branch}`);
        const restore = store.restoreServerOwn.bind(store);
        store.restoreServerOwn = async (identity: string, envelopes: any[]) => {
          await store.queueGroup([item]);
          return restore(identity, envelopes);
        };
        const history = {
          identity,
          snapshot: null,
          events: new Map(),
          frontier: [],
          storedHeads: [],
          complete: true,
        };
        const work = branch
          ? fetchBranches(store, history, [
              {
                peer,
                snapshot,
                outcome: "complete",
                heads: [remote.envelope.id],
              },
            ])
          : loadOwnHistory(store, identity, { peer });
        failures.push(
          await work.then(
            () => false,
            (error: Error) => error.message.includes("changed during refresh"),
          ),
        );
        heads.push(await store.get("heads", identity));
      }
      const failedCache = new LocalStore("guard-cache-failure");
      failedCache.restoreServerOwn = async () => {
        throw new Error("Storage failed");
      };
      const uncached = await loadOwnHistory(failedCache, identity, { peer });
      return {
        failures,
        heads,
        expected: [remote.envelope.id, concurrent.envelope.id].sort(),
        initialGuard: uncached.storedHeads,
        reviewedFrontier: uncached.frontier,
        remote: remote.envelope.id,
      };
    } finally {
      window.fetch = oldFetch;
    }
  }, corePath);
  expect(result.failures).toEqual([true, true]);
  expect(result.heads).toEqual([result.expected, result.expected]);
  expect(result.initialGuard).toEqual([]);
  expect(result.reviewedFrontier).toEqual([result.remote]);
});

test("rediscovery shows the author a notice for an owned key that is not selected", async ({
  page,
}) => {
  await page.goto("/outbox");
  await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { createKey } = await import(String("/src/data/keys.ts"));
    const { signWith } = await import(String("/src/data/lifecycle.ts"));
    const { buildShell } = await import(String("/src/app/shell.ts"));
    const retired = await createKey("disposable retired passphrase");
    const selected = await createKey("disposable selected passphrase");
    const store = new LocalStore("nonselected-key-rediscovery");
    await store.installIdentity(selected.backup);
    await store.put(
      "keys",
      `retired:${retired.backup.identity}`,
      retired.backup,
    );
    const record = await signWith(retired.key, retired.backup.identity, [], {
      kind: "identity.merge",
    });
    await store.put("keys", `discarded:${record.envelope.id}`, true);
    const root = document.createElement("div");
    root.id = "nonselected-key-shell";
    document.body.append(root);
    buildShell(
      root,
      {
        store,
        storageAvailable: true,
        backup: selected.backup,
        identity: selected.backup.identity,
        unlocked: false,
        subscribe: () => () => {},
      },
      {
        subscribe: (listener: (items: unknown[]) => void) => {
          listener([]);
          return () => {};
        },
      },
    );
    await store.restoreServerOwn(retired.backup.identity, [record.envelope]);
  }, corePath);
  const shell = page.locator("#nonselected-key-shell");
  const notice = shell.getByRole("region", {
    name: "Rediscovered public record",
    exact: true,
  });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("reached a server after all");
  await notice.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(notice).toBeHidden();
});

test("stopped lifecycle records retain bytes and markers and never offer Discard", async ({
  page,
}) => {
  await page.goto("/outbox");
  const fixture = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { createKey } = await import(String("/src/data/keys.ts"));
    const { signWith, outboxItem, queueHandover, queueCompromise } =
      await import(String("/src/data/lifecycle.ts"));
    const store = new LocalStore();
    const old = await createKey("disposable old key");
    const next = await createKey("disposable next key");
    const stolen = await createKey("disposable stolen key");
    await store.installIdentity(old.backup);
    const recipients = {
      self: { origin: location.origin, base: "/api/v1", label: "test" },
    };
    const stopped = (transport: any) => {
      const item = outboxItem(transport, transport.envelope.id, 0, recipients);
      item.stopped = true;
      item.peers.self = {
        ...item.peers.self,
        state: "refused",
        failure: "refused",
        nextAttempt: null,
      };
      return item;
    };
    const transfer = stopped(
      await signWith(old.key, old.backup.identity, [], {
        kind: "identity.transfer",
        successor: next.backup.identity,
      }),
    );
    const accept = stopped(
      await signWith(next.key, next.backup.identity, [], {
        kind: "identity.accept",
        transfer: transfer.id,
      }),
    );
    await queueHandover(store, {
      transfer,
      accept,
      old: old.backup,
      successor: next.backup,
      successorTested: false,
      expectedHeads: [],
    });
    const notice = stopped(
      await signWith(stolen.key, stolen.backup.identity, [], {
        kind: "identity.compromise",
        safe: [],
      }),
    );
    notice.stopped = false;
    await queueCompromise(store, notice, []);
    const merge = stopped(
      core.createEvent(
        new Uint8Array(32).fill(103),
        [],
        "1".repeat(32),
        { kind: "identity.merge" },
        null,
      ),
    );
    await store.queueGroup([merge]);
    return {
      ids: [transfer.id, accept.id, notice.id],
      notice: notice.id,
      merge: merge.id,
    };
  }, corePath);
  await page.reload();
  const notice = page.locator(`[data-outbox-record="${fixture.notice}"]`);
  await notice
    .getByRole("button", { name: "Stop retrying", exact: true })
    .click();
  for (const id of fixture.ids) {
    const row = page.locator(`[data-outbox-record="${id}"]`);
    await expect(row.getByText("Stopped", { exact: true })).toBeVisible();
    await expect(row).toContainText("This lifecycle record must be delivered.");
    await expect(
      row.getByRole("button", { name: "Discard", exact: true }),
    ).toHaveCount(0);
    await expect(
      row.getByRole("button", { name: "Resume", exact: true }),
    ).toBeVisible();
    await expect(
      row.getByRole("button", { name: "Save as file", exact: true }),
    ).toBeVisible();
  }
  const result = await page.evaluate(async (ids) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const snapshot = async () =>
      JSON.stringify(
        await Promise.all(
          ["outbox", "ownhistory", "heads", "keys"].map(async (name) => [
            name,
            await Promise.all(
              (await store.keys(name)).map(async (id: string) => [
                id,
                await store.get(name, id),
              ]),
            ),
          ]),
        ),
      );
    const before = await snapshot();
    const errors = [];
    for (const id of ids)
      errors.push(
        await store.discardOutbox(id).then(
          () => "",
          (error: Error) => error.message,
        ),
      );
    return {
      before,
      after: await snapshot(),
      errors,
      markers: await Promise.all(
        ids.map((id) => store.get("keys", `discarded:${id}`)),
      ),
    };
  }, fixture.ids);
  expect(result.errors).toEqual(
    Array(3).fill(
      "This lifecycle record must be delivered. Resume it or save it as a file.",
    ),
  );
  expect(result.after).toBe(result.before);
  expect(result.markers).toEqual([undefined, undefined, undefined]);
  const merge = page.locator(`[data-outbox-record="${fixture.merge}"]`);
  page.once("dialog", (dialog) => void dialog.accept());
  await merge.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(merge).toHaveCount(0);
});

test("a stale Discard refuses a fully delivered stopped record and refreshes the list", async ({
  page,
}) => {
  await seed(page);
  const leaf = page.locator(
    '[aria-label="Unfinished records"] [data-outbox-record="leaf"]',
  );
  await expect(
    leaf.getByRole("button", { name: "Discard", exact: true }),
  ).toBeVisible();
  const accepted = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    return store.mergeOutbox("leaf", (item: any) => ({
      ...item,
      peers: Object.fromEntries(
        Object.entries(item.peers).map(([id, peer]: any) => [
          id,
          {
            ...peer,
            state: "accepted",
            receipt: {
              id: item.id,
              admission: "accepted",
              proof: "synthetic receipt",
            },
          },
        ]),
      ),
    }));
  });
  page.once("dialog", (dialog) => void dialog.accept());
  await leaf.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "delivered to every recipient",
  );
  await expect(leaf).toHaveCount(0);
  const kept = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    return {
      item: await store.get("outbox", "leaf"),
      marker: await store.get("keys", "discarded:leaf"),
      heads: await store.get("heads", "test"),
    };
  });
  expect(kept.item).toEqual(accepted);
  expect(kept.marker).toBeUndefined();
  expect(kept.heads).toEqual(["leaf"]);
});

for (const mixed of [false, true]) {
  test(`the Not delivered introduction separates stopped records${mixed ? " from waiting retries" : " without promising retries"}`, async ({
    page,
  }) => {
    await seed(page);
    await page.evaluate(async (mixed) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const store = new LocalStore();
      for (const item of await store.list("outbox"))
        await store.mergeOutbox(item.id, (current: any) => ({
          ...current,
          stopped: !mixed || current.id !== "base",
          peers: Object.fromEntries(
            Object.entries(current.peers).map(([id, peer]: any) => [
              id,
              {
                ...peer,
                state: mixed && current.id === "base" ? "refused" : "unknown",
                failure: "server",
                nextAttempt: null,
              },
            ]),
          ),
        }));
    }, mixed);
    await page.reload();
    const intro = page.locator("main > p.muted");
    await expect(intro).toContainText(
      "Stopped records stay in this browser and are not sent again until you select Resume.",
    );
    await expect(intro).not.toContainText("Some delivery outcomes are unknown");
    if (mixed) {
      await expect(intro).toContainText("A server refused some records.");
      await expect(intro).toContainText("Eligible retries continue");
    } else {
      await expect(intro).not.toContainText("Eligible retries continue");
      await expect(intro).not.toContainText("wait for another attempt");
    }
  });
}

test("an unreadable stopped record keeps its export path without crashing the list", async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().mergeOutbox("leaf", (item: any) => ({
      ...item,
      transport: "{",
    }));
  });
  await page.reload();
  const leaf = page.locator('[data-outbox-record="leaf"]');
  await expect(leaf).toContainText("Local history is unavailable.");
  await expect(
    leaf.getByRole("button", { name: "Save as file", exact: true }),
  ).toBeVisible();
  await expect(
    leaf.getByRole("button", { name: "Discard", exact: true }),
  ).toHaveCount(0);
});
