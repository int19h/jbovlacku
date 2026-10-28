import { expect, test } from "@playwright/test";
import { corePath } from "./helpers.ts";

for (const status of [404, 503]) {
  test(`a direct definition read recovers from body HTTP ${status} without a reload`, async ({
    page,
  }) => {
    await page.goto("/");
    const record = await page.evaluate(async (path) => {
      const core = await import(path);
      await core.initializeCore();
      const { newDraft, draftToBody } = await import(
        String("/src/model/draft.ts")
      );
      const body = draftToBody(
        newDraft({
          spelling: "broda",
          kind: "gismu",
          text: "Recovered definition body.",
        }),
      ).body;
      return core.createEvent(
        new Uint8Array(32).fill(74),
        [],
        "c".repeat(32),
        {
          kind: "definition.publish",
          word: core.wordId(body.word),
          language: "en",
          parents: [],
          origin: "native",
        },
        body,
      );
    }, corePath);
    let recovered = false;
    let bodyCalls = 0;
    await page.route(
      `**/api/v1/events/${encodeURIComponent(record.envelope.id)}*`,
      (route) => route.fulfill({ json: record.envelope }),
    );
    await page.route(
      `**/api/v1/bodies/${encodeURIComponent(record.envelope.header.content.hash)}*`,
      (route) => {
        bodyCalls++;
        return route.fulfill(
          recovered
            ? { json: record.body }
            : {
                status,
                json: {
                  code: status === 404 ? "missing" : "unavailable",
                  message: "Synthetic body unavailable",
                },
              },
        );
      },
    );
    await page.goto(`/definition/${record.envelope.id}`);
    await expect(page.locator("main")).toContainText(
      "Synthetic body unavailable",
    );
    recovered = true;
    await page.getByRole("link", { name: "Add a word" }).click();
    await page.goBack();
    await expect(page.locator("main")).toContainText(
      "Recovered definition body.",
    );
    expect(bodyCalls).toBe(2);
    const loaded = await page.evaluate(async (id) => {
      const { loadRecord } = await import(String("/src/data/api.ts"));
      return loadRecord(id);
    }, record.envelope.id);
    expect(loaded.body).not.toBeNull();
    expect(loaded.bodyError).toBeNull();
    expect(bodyCalls).toBe(2);
    // A pinned missing body is a fact of that snapshot. A pinned HTTP 503 is not.
    recovered = false;
    const snapshot = "sha256:" + "d".repeat(64);
    const pinned = await page.evaluate(
      async ({ id, snapshot }) => {
        const { loadRecord } = await import(String("/src/data/api.ts"));
        return loadRecord(id, snapshot);
      },
      { id: record.envelope.id, snapshot },
    );
    expect(pinned.body).toBeNull();
    recovered = true;
    const retried = await page.evaluate(
      async ({ id, snapshot }) => {
        const { loadRecord } = await import(String("/src/data/api.ts"));
        return loadRecord(id, snapshot);
      },
      { id: record.envelope.id, snapshot },
    );
    if (status === 404) {
      expect(retried.body).toBeNull();
      expect(bodyCalls).toBe(3);
    } else {
      expect(retried.body).not.toBeNull();
      expect(retried.bodyError).toBeNull();
      expect(bodyCalls).toBe(4);
    }
  });
}

for (const mode of ["ignore", "trust"] as const) {
  test(`concurrent private ${mode} controls retain both identities and scopes`, async ({
    page,
  }) => {
    await page.goto("/");
    const results = await page.evaluate(async (mode) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { trustPanel } = await import(
        String("/src/components/trustpanel.ts")
      );
      const dbname = `private-overlap-${crypto.randomUUID()}`;
      const stores = [new LocalStore(dbname), new LocalStore(dbname)];
      const identity = "ed25519:" + "a".repeat(64);
      const all = { kind: "*", word: "*", language: "*" };
      const results = [];
      try {
        for (const scoped of [false, true]) {
          await stores[0].put("prefs", "overlay", {
            version: 1,
            base_view: null,
            root_changes: [{ identity, q: { numerator: 2, denominator: 1 } }],
            trust: [],
            blocked: [],
            work: 2000,
          });
          let completed = 0;
          const errors: string[] = [];
          const panels = stores.map((store, index) => {
            const app = {
              store,
              session: { identity },
              announce: (message: string) => errors.push(message),
            };
            const panel = trustPanel(app, {
              subject:
                "ed25519:" + (scoped ? "1" : String(index + 1)).repeat(64),
              name: `Test ${index}`,
              mode,
              onDone: () => completed++,
            });
            document.body.append(panel);
            if (scoped) {
              const language = [...panel.querySelectorAll("input")].find(
                (input) => input.placeholder === "any",
              )!;
              language.value = index ? "ru" : "en";
              language.dispatchEvent(new Event("input", { bubbles: true }));
            }
            return panel;
          });
          // Start both real controls in the same turn, through separate database connections.
          for (const panel of panels)
            [...panel.querySelectorAll("button")]
              .find(
                (button) =>
                  button.textContent ===
                  (mode === "trust" ? "Trust" : "Ignore"),
              )!
              .click();
          const deadline = Date.now() + 5000;
          while (completed < 2 && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 5));
          const overlay = await stores[0].overlay();
          results.push({
            scoped,
            completed,
            errors,
            entries: mode === "trust" ? overlay.trust : overlay.blocked,
            roots: overlay.root_changes,
            work: overlay.work,
          });
          panels.forEach((panel) => panel.remove());
        }
      } finally {
        for (const store of stores) (await store.database).close();
        indexedDB.deleteDatabase(dbname);
      }
      return results;
    }, mode);
    for (const result of results) {
      expect.soft(result.completed, JSON.stringify(result.errors)).toBe(2);
      expect.soft(result.entries, `scoped=${result.scoped}`).toHaveLength(2);
      expect.soft(result.work).toBe(2000);
      expect.soft(result.roots).toHaveLength(1);
      if (result.scoped)
        expect
          .soft(result.entries.map((entry: any) => entry.scope.language).sort())
          .toEqual(["en", "ru"]);
    }
  });
}

for (const mode of ["ignore", "trust"] as const) {
  test(`a private ${mode} removal retains a concurrent unrelated addition`, async ({
    page,
  }) => {
    await page.goto("/");
    const result = await page.evaluate(
      async ({ mode, path }) => {
        const core = await import(path);
        await core.initializeCore();
        const { LocalStore, emptyOverlay, defaultPreferences } = await import(
          String("/src/data/store.ts")
        );
        const { trustPanel } = await import(
          String("/src/components/trustpanel.ts")
        );
        const { trustPage } = await import(String("/src/pages/trust.ts"));
        const dbname = `private-remove-${crypto.randomUUID()}`;
        const stores = [new LocalStore(dbname), new LocalStore(dbname)];
        const identity = "ed25519:" + "a".repeat(64);
        const removed = "ed25519:" + "1".repeat(64);
        const added = "ed25519:" + "2".repeat(64);
        const scope = { kind: "*", word: "*", language: "*" };
        const initial = emptyOverlay();
        if (mode === "trust")
          initial.trust.push({
            issuer: identity,
            subject: removed,
            scope,
            value: "heed",
            weight: null,
          });
        else initial.blocked.push({ identity: removed, scope });
        await stores[0].setOverlay(initial);
        const main = document.createElement("main");
        document.body.append(main);
        let done = false;
        let changed = false;
        let live = true;
        const app = {
          store: stores[0],
          session: { identity, preferences: defaultPreferences },
          own: { registers: async () => null },
          personal: { loadedContinuity: null, subscribe: () => () => {} },
          announce: () => {},
        };
        try {
          await trustPage(
            {},
            {
              main,
              signal: new AbortController().signal,
              live: () => live,
              title: () => {},
            },
            app,
          );
          const panel = trustPanel(
            { ...app, store: stores[1] },
            {
              subject: added,
              name: "Added",
              mode,
              onDone: () => (done = true),
            },
          );
          document.body.append(panel);
          stores[0].onOverlayChange = () => (changed = true);
          // Stop the page redraw after removal. Both controls retain their original exact targets.
          live = false;
          [...main.querySelectorAll("button")]
            .find((button) => button.textContent === "Remove")!
            .click();
          [...panel.querySelectorAll("button")]
            .find(
              (button) =>
                button.textContent === (mode === "trust" ? "Trust" : "Ignore"),
            )!
            .click();
          const deadline = Date.now() + 5000;
          while ((!done || !changed) && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 5));
          const overlay = await stores[0].overlay();
          panel.remove();
          return {
            done,
            changed,
            targets:
              mode === "trust"
                ? overlay.trust.map((rule: any) => rule.subject)
                : overlay.blocked.map((block: any) => block.identity),
            added,
          };
        } finally {
          live = false;
          main.remove();
          for (const store of stores) (await store.database).close();
          indexedDB.deleteDatabase(dbname);
        }
      },
      { mode, path: corePath },
    );
    expect(result.done).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.targets).toEqual([result.added]);
  });
}
