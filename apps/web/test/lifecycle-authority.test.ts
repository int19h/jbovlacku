import { test, expect, type Page } from "@playwright/test";
import { corePath } from "./helpers.ts";

async function harness(page: Page) {
  await page.route("**/authority-harness", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Authority test</title>",
    }),
  );
  await page.goto("/authority-harness");
}

for (const kind of ["identity.transfer", "identity.compromise"]) {
  test(`a restored key refuses ordinary signing after it learns ${kind}`, async ({
    page,
    browser,
  }) => {
    await harness(page);
    const restored = await page.evaluate(
      async ({ corePath, kind }) => {
        const core = await import(corePath);
        await core.initializeCore();
        const { createKey } = await import(String("/src/data/keys.ts"));
        const { signWith } = await import(String("/src/data/lifecycle.ts"));
        const created = await createKey("restored authority passphrase");
        const action =
          kind === "identity.transfer"
            ? {
                kind,
                successor: core.identityFromSeed(new Uint8Array(32).fill(87)),
              }
            : { kind, safe: [] };
        const record = await signWith(
          created.key,
          created.backup.identity,
          [],
          action,
        );
        return { backup: created.backup, envelope: record.envelope };
      },
      { corePath, kind },
    );
    const context = await browser.newContext();
    try {
      const second = await context.newPage();
      await harness(second);
      const result = await second.evaluate(
        async ({ corePath, restored }) => {
          const core = await import(corePath);
          await core.initializeCore();
          const { LocalStore } = await import(String("/src/data/store.ts"));
          const { Session } = await import(String("/src/app/session.ts"));
          const { Signer } = await import(String("/src/app/actions.ts"));
          const databaseName = `restored-authority-${crypto.randomUUID()}`;
          const store = new LocalStore(databaseName);
          await store.installIdentity(restored.backup, "restore");
          const session = new Session(store);
          await session.load();
          await session.unlock("restored authority passphrase");
          const original = window.fetch;
          const snapshot = "sha256:" + "a".repeat(64);
          let fetched = 0;
          window.fetch = async (input) => {
            const url = new URL(String(input), location.origin);
            let body;
            if (url.pathname.endsWith("/manifest"))
              body = { snapshot, packages: [] };
            else if (url.pathname.includes("/identity-heads/"))
              body = {
                snapshot,
                identity: restored.backup.identity,
                heads: [restored.envelope.id],
                next: null,
              };
            else if (url.pathname.includes("/events/")) {
              fetched++;
              body = restored.envelope;
            } else throw new Error(`Unexpected mocked request: ${url}`);
            return new Response(JSON.stringify(body));
          };
          const attempt = async (offline: boolean) => {
            try {
              await new Signer(
                session,
                { invalidate: async () => {} } as any,
                () => offline,
              ).sign([
                {
                  action: {
                    kind: "judgment.set",
                    target: "jve1:" + "b".repeat(64),
                    value: "bless",
                  },
                  body: null,
                },
              ]);
              return "signed";
            } catch (error) {
              return String(error);
            }
          };
          try {
            const online = await attempt(false);
            const offline = await attempt(true);
            const otherSession = new Session(new LocalStore(databaseName));
            await otherSession.load();
            const disabledInOtherTab = await otherSession.signingDisabled(
              restored.backup.identity,
            );
            return {
              online,
              offline,
              fetched,
              disabledInOtherTab,
              remembered: (await store.list("ownhistory")).some(
                (record: { id: string }) => record.id === restored.envelope.id,
              ),
              outbox: (await store.list("outbox")).length,
            };
          } finally {
            window.fetch = original;
            session.lock();
          }
        },
        { corePath, restored },
      );
      expect(result.online).toContain(
        kind === "identity.transfer" ? "retired" : "compromise notice",
      );
      expect(result.offline).toContain(
        kind === "identity.transfer" ? "retired" : "compromise notice",
      );
      expect(result.disabledInOtherTab).toContain(
        kind === "identity.transfer" ? "retired" : "compromise notice",
      );
      expect(result.fetched).toBe(1);
      expect(result.remembered).toBe(true);
      expect(result.outbox).toBe(0);
    } finally {
      await context.close();
    }
  });
}

test("authenticated history disables signing in its storage transaction and ignores malformed lifecycle actions", async ({
  page,
}) => {
  await harness(page);
  const result = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { Session } = await import(String("/src/app/session.ts"));
    const { loadOwnHistory } = await import(String("/src/data/history.ts"));
    const seed = new Uint8Array(32).fill(71);
    const identity = core.identityFromSeed(seed);
    const outcomes = [];
    for (const method of [
      "restoreServerOwn",
      "rememberOwn",
      "recordBranch",
      "cached",
    ] as const) {
      for (const action of [
        {
          kind: "identity.transfer",
          successor: core.identityFromSeed(new Uint8Array(32).fill(87)),
        },
        { kind: "identity.compromise", safe: [] },
        { kind: "identity.transfer", successor: "invalid" },
        { kind: "identity.compromise", safe: ["invalid"] },
        { kind: "identity.transfer", successor: identity, extra: true },
      ]) {
        const store = new LocalStore(`stored-authority-${crypto.randomUUID()}`);
        const envelope = core.signHeader(seed, {
          version: 1,
          issuer: identity,
          previous: [],
          nonce: "1".repeat(32),
          action,
          content: null,
        });
        if (method === "cached") {
          await store.put("ownhistory", envelope.id, envelope);
          await loadOwnHistory(store, identity, { offline: true });
        } else await store[method](identity, [envelope]);
        const session = new Session(store);
        const disabled = await session.signingDisabled(identity);
        const transport = core.createEvent(
          seed,
          [envelope.id],
          "2".repeat(32),
          { kind: "identity.merge" },
          null,
        );
        let saved = true;
        try {
          await store.queueGroup([
            {
              id: transport.envelope.id,
              identity,
              transport: JSON.stringify(transport),
              group: "test",
              order: 0,
              label: { kind: "identity.merge" },
              recipients: {},
              peers: {},
              stopped: false,
              signedAt: 0,
            } as any,
          ]);
        } catch {
          saved = false;
        }
        outcomes.push({
          method,
          valid: core.validateAction(core.utf8(JSON.stringify(envelope))),
          disabled: Boolean(disabled),
          saved,
        });
      }
    }
    return outcomes;
  }, corePath);
  for (const outcome of result) {
    expect(outcome.disabled, JSON.stringify(outcome)).toBe(outcome.valid);
    expect(outcome.saved, JSON.stringify(outcome)).toBe(!outcome.valid);
  }
});

test("distinct authenticated transfers keep the recovery conflict marker within one batch and across calls", async ({
  page,
}) => {
  await harness(page);
  const markers = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const seed = new Uint8Array(32).fill(71);
    const identity = core.identityFromSeed(seed);
    const transfers = [87, 88].map(
      (successor, index) =>
        core.createEvent(
          seed,
          [],
          String(index + 1).repeat(32),
          {
            kind: "identity.transfer",
            successor: core.identityFromSeed(
              new Uint8Array(32).fill(successor),
            ),
          },
          null,
        ).envelope,
    );
    const results = [];
    for (const method of [
      "restoreServerOwn",
      "rememberOwn",
      "recordBranch",
    ] as const) {
      for (const batch of [false, true]) {
        const store = new LocalStore(
          `transfer-conflict-${crypto.randomUUID()}`,
        );
        if (batch) await store[method](identity, transfers);
        else {
          await store[method](identity, [transfers[0]]);
          await store[method](identity, [transfers[0]]);
          results.push(
            (await store.get("keys", `transfer-known:${identity}`)) ===
              transfers[0].id,
          );
          await store[method](identity, [transfers[1]]);
        }
        results.push(
          (await store.get("keys", `transfer-known:${identity}`)) ===
            "conflicting-transfers",
        );
        await store[method](identity, [transfers[0]]);
        results.push(
          (await store.get("keys", `transfer-known:${identity}`)) ===
            "conflicting-transfers",
        );
      }
    }
    return results;
  }, corePath);
  expect(markers.every(Boolean)).toBe(true);
});
