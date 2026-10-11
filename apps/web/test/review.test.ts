import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
const corePath = `/@fs${resolve("packages/core/src/index.ts")}`;

for (const action of ["create", "import"] as const) {
  test(`a stale tab cannot ${action} another identity over the original encrypted backup`, async ({
    page,
    context,
  }) => {
    const other = await context.newPage();
    await Promise.all([page.goto("/identity"), other.goto("/identity")]);
    await expect(
      other.getByLabel("New passphrase", { exact: true }),
    ).toBeVisible();
    const passphrase = "original two-tab passphrase";
    await page.getByLabel("New passphrase", { exact: true }).fill(passphrase);
    await page.getByLabel("Repeat passphrase").fill(passphrase);
    await page
      .getByRole("button", { name: "Create a disposable identity" })
      .click();
    await expect(
      page.getByText("Unlocked for this session.", { exact: true }),
    ).toBeVisible();
    const original = await page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/storage.ts"));
      return new LocalStore().get("keys", "selected");
    });
    let refusedIdentity: string | undefined;
    if (action === "create") {
      await other
        .getByLabel("New passphrase", { exact: true })
        .fill("another passphrase");
      await other.getByLabel("Repeat passphrase").fill("another passphrase");
      await other
        .getByRole("button", { name: "Create a disposable identity" })
        .click();
    } else {
      const candidate = await other.evaluate(async () => {
        const { createKey } = await import(String("/src/keys.ts"));
        return (await createKey("another passphrase")).backup;
      });
      refusedIdentity = candidate.identity;
      await other.getByLabel("Backup file").setInputFiles({
        name: "other.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(candidate)),
      });
      await other.getByLabel("Backup passphrase").fill("another passphrase");
      await other.getByRole("button", { name: "Open backup locally" }).click();
    }
    await expect(other.getByRole("status")).toHaveText(
      "Another tab selected an identity. This browser kept its existing key. Unlock that identity or keep your backup file.",
    );
    await expect(
      other.getByText(original.identity, { exact: true }),
    ).toBeVisible();
    await expect(other.getByText("Locked.", { exact: true })).toBeVisible();
    await expect(
      other.getByLabel("New passphrase", { exact: true }),
    ).toHaveCount(0);
    const preserved = await other.evaluate(
      async ({ passphrase, refusedIdentity }) => {
        const { LocalStore } = await import(String("/src/storage.ts"));
        const { unlockKey } = await import(String("/src/keys.ts"));
        const store = new LocalStore();
        const backup = await store.get("keys", "selected");
        const key = await unlockKey(backup, passphrase);
        const publicKey = await crypto.subtle.importKey(
          "raw",
          Uint8Array.from(
            backup.identity.slice(8).match(/../g),
            (hex: string) => parseInt(hex, 16),
          ),
          { name: "Ed25519" },
          false,
          ["verify"],
        );
        const message = new TextEncoder().encode("original key still works");
        const signature = await crypto.subtle.sign("Ed25519", key, message);
        return {
          backup,
          extractable: key.extractable,
          signatureValid: await crypto.subtle.verify(
            "Ed25519",
            publicKey,
            signature,
            message,
          ),
          refusedTested: refusedIdentity
            ? await store.get("keys", `tested:${refusedIdentity}`)
            : undefined,
        };
      },
      { passphrase, refusedIdentity },
    );
    expect(preserved.backup).toEqual(original);
    expect(preserved.extractable).toBe(false);
    expect(preserved.signatureValid).toBe(true);
    expect(preserved.refusedTested).toBeUndefined();
    await page.reload();
    await expect(
      page.getByText(original.identity, { exact: true }),
    ).toBeVisible();
    await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect(
      page.getByText("Unlocked for this session.", { exact: true }),
    ).toBeVisible();
    // Restoring the selected identity is allowed after this file unlocks locally.
    await other.getByLabel("Backup file").setInputFiles({
      name: "original.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(original)),
    });
    await other.getByLabel("Backup passphrase").fill(passphrase);
    await other.getByRole("button", { name: "Open backup locally" }).click();
    await expect(other.getByRole("status")).toHaveText(
      "The backup opened locally. Keep the file in a safe place.",
    );
    const restored = await other.evaluate(async () => {
      const { LocalStore } = await import(String("/src/storage.ts"));
      const store = new LocalStore();
      const backup = await store.get("keys", "selected");
      return {
        backup,
        tested: await store.get("keys", `tested:${backup.identity}`),
      };
    });
    expect(restored).toEqual({ backup: original, tested: true });
    await other.close();
  });
}

test("SPA routes update the title, focus the heading, and identify dictionary languages", async ({
  page,
}) => {
  await page.goto("/search?q=klama&lang=es");
  await expect(page).toHaveTitle("Search: klama · jbovlacku");
  await page.getByRole("link", { name: "Identity", exact: true }).click();
  await expect(page).toHaveTitle("Your identity · jbovlacku");
  await expect(page.locator("main h1")).toBeFocused();
  await page.goBack();
  await expect(page).toHaveTitle("Search: klama · jbovlacku");
  await expect(page.locator("main h1")).toBeFocused();
  const fixture = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    const word = { language: "jbo", spelling: "klama" };
    const record = core.createEvent(
      new Uint8Array(32).fill(95),
      [],
      "8".repeat(32),
      {
        kind: "definition.publish",
        word: core.wordId(word),
        language: "es",
        parents: [],
        origin: "native",
      },
      {
        word,
        language: "es",
        text: [
          [
            "ir a algún lugar",
            { word: { language: "jbo", spelling: "cadzu" }, label: "cadzu" },
          ],
        ],
        frame: null,
        operands: [],
        glosses: [{ language: "es", text: "ir", sense: null }],
        notes: [],
        etymology: { text: [], formation: null, compound: null },
        examples: [
          {
            language: "jbo",
            text: "mi klama",
            translation: [["voy"]],
            notes: [],
          },
        ],
        classification: { kind: "gismu", selmaho: [] },
        labels: [],
        sources: [],
        license: {
          expression: "CC0-1.0",
          url: null,
          attribution: "Disposable fixture",
        },
        legacy: null,
      },
    );
    return { record, word, wordId: core.wordId(word) };
  }, corePath);
  const snapshot = "sha256:" + "c".repeat(64);
  await page.route("**/api/v1/search?**", (route) =>
    route.fulfill({
      json: {
        snapshot,
        view: "jve1:" + "a".repeat(64),
        next: null,
        hits: [
          {
            word: fixture.word,
            word_id: fixture.wordId,
            definitions: [fixture.record.envelope.id],
            match: "headword",
            preview: {
              event: fixture.record.envelope.id,
              word_kind: "gismu",
              plain_text: "ir a algún lugar",
              status: "active",
            },
          },
        ],
      },
    }),
  );
  await page.route("**/api/v1/words/**", (route) =>
    route.fulfill({
      json: {
        snapshot,
        word: fixture.word,
        definitions: [fixture.record.envelope.id],
        layers: [[fixture.record.envelope.id]],
        statuses: [{ event: fixture.record.envelope.id, state: "active" }],
        unavailable_scores: [],
        scores: [],
      },
    }),
  );
  await page.route("**/api/v1/events/**", (route) =>
    route.fulfill({ json: fixture.record.envelope }),
  );
  await page.route("**/api/v1/bodies/**", (route) =>
    route.fulfill({ json: fixture.record.body }),
  );
  await page.goto("/search?q=ir&lang=es");
  const results = page.getByRole("region", { name: "Search results" });
  await expect(
    results.getByRole("link", { name: "klama", exact: true }),
  ).toHaveAttribute("lang", "jbo");
  await expect(
    results.getByText("ir a algún lugar", { exact: true }),
  ).toHaveAttribute("lang", "es");
  await results.getByRole("link", { name: "klama", exact: true }).click();
  await expect(page).toHaveTitle("klama · jbovlacku");
  await expect(page.locator("main h1")).toBeFocused();
  await expect(page.locator("main h1")).toHaveAttribute("lang", "jbo");
  const definition = page.locator("article");
  await expect(
    definition
      .locator('div[lang="es"]')
      .filter({ hasText: "ir a algún lugar" }),
  ).toBeVisible();
  await expect(definition.getByText("cadzu", { exact: true })).toHaveAttribute(
    "lang",
    "jbo",
  );
  await expect(
    definition.getByText("mi klama", { exact: true }),
  ).toHaveAttribute("lang", "jbo");
  await expect(
    definition.getByText("voy", { exact: true }).locator("../.."),
  ).toHaveAttribute("lang", "es");
  await expect(definition.getByText("ir", { exact: true })).toHaveAttribute(
    "lang",
    "es",
  );
  await definition.getByRole("link", { name: "klama", exact: true }).click();
  await expect(page).toHaveTitle("Definition: klama · jbovlacku");
  await expect(page.locator("main h1")).toBeFocused();
});

test("a full search snapshot hash fits a 390 pixel screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const snapshot = "sha256:" + "a".repeat(64);
  await page.route("**/api/v1/search?**", (route) =>
    route.fulfill({
      json: { snapshot, view: "jve1:" + "b".repeat(64), hits: [], next: null },
    }),
  );
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto("/search?q=klama&lang=en");
    await page.getByText("Search source and snapshot", { exact: true }).click();
    await expect(
      page.getByText(`Snapshot: ${snapshot}`, { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
  }
});

test("word pages use server layers and separate unavailable and deprecated definitions", async ({
  page,
}) => {
  await page.goto("/");
  const fixture = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    const seed = new Uint8Array(32).fill(81);
    const word = { language: "jbo", spelling: "broda" };
    const records = Array.from({ length: 4 }, (_, index) =>
      core.createEvent(
        seed,
        [],
        String(index).repeat(32),
        {
          kind: "definition.publish",
          word: core.wordId(word),
          language: "en",
          parents: [],
          origin: index === 0 ? "import" : "native",
        },
        {
          word,
          language: "en",
          text: [[`Definition ${index}`]],
          frame: null,
          operands: [],
          glosses: [],
          notes: [],
          etymology: { text: [], formation: null, compound: null },
          examples: [],
          classification: { kind: "other", selmaho: [] },
          labels: [],
          sources: [],
          license: {
            expression: "CC0-1.0",
            url: null,
            attribution: "Disposable fixture",
          },
          legacy:
            index === 0
              ? {
                  source: "https://example.invalid",
                  snapshot: "sha256:" + "d".repeat(64),
                  extraction: "fixture-v1",
                  record: { kind: "definition", id: 1 },
                  locator: "definitions/1",
                  original: {
                    author: "<b>Fixture author</b>",
                    value: { $source_number: "123456789012345678901.25" },
                  },
                  attribution: {
                    author: "<b>Fixture author</b>",
                    editor: "Fixture editor",
                    dates: { created: "2026-10-11" },
                    author_account: {
                      origin: "https://example.invalid",
                      account: 7,
                      username: "Fixture author",
                      evidence: {
                        kind: "source-id",
                        source: {
                          label: "Fixture",
                          url: null,
                          event: null,
                          locator: null,
                        },
                      },
                    },
                  },
                  conversion: {
                    method: "literal",
                    tool: "fixture",
                    version: "1",
                    model: null,
                    review: "unreviewed",
                    mappings: [],
                    warnings: [],
                  },
                  limitations: [],
                }
              : null,
        },
      ),
    ).sort((a, b) => a.envelope.id.localeCompare(b.envelope.id));
    return { word, records, wordId: core.wordId(word) };
  }, corePath);
  const ids = fixture.records.map((record) => record.envelope.id);
  const snapshot = "sha256:" + "c".repeat(64);
  const rational = { numerator: "0", denominator: "1" };
  let calculation: unknown = { exact: false };
  await page.route("**/api/v1/words/**", (route) =>
    route.fulfill({
      json: {
        snapshot,
        word: fixture.word,
        definitions: ids,
        calculation,
        layers: [[ids[2], ids[1]], [ids[0]]],
        statuses: ids.map((event, index) => ({
          event,
          state:
            index === 0 ? "deprecated" : index === 3 ? "unavailable" : "active",
        })),
        unavailable_scores: [ids[3]],
        scores: ids
          .slice(0, 3)
          .map((target) => ({ target, net: [rational, rational] })),
      },
    }),
  );
  await page.route("**/api/v1/events/**", (route) => {
    const record = fixture.records.find((record) =>
      route.request().url().includes(encodeURIComponent(record.envelope.id)),
    )!;
    return route.fulfill({ json: record.envelope });
  });
  await page.route("**/api/v1/bodies/**", (route) => {
    const record = fixture.records.find((record) =>
      route
        .request()
        .url()
        .includes(encodeURIComponent(record.envelope.header.content!.hash)),
    )!;
    return route.fulfill({ json: record.body });
  });
  await page.goto(`/word/${encodeURIComponent(fixture.wordId)}`);
  const first = page.getByRole("region", {
    name: "Definition layer 1",
    exact: true,
  });
  await expect(first.locator("article")).toHaveCount(2);
  expect(
    await first
      .locator("article > a:first-child")
      .evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
  ).toEqual(
    [ids[2], ids[1]].map((id) => `/definition/${encodeURIComponent(id)}`),
  );
  await expect(
    first.getByText(
      "2 alternatives. Order tied or unresolved within this layer.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      "This definition is deprecated in this snapshot. Its judgments are inactive.",
    ),
  ).toBeVisible();
  const unavailable = page.getByRole("region", {
    name: "Definitions without an available ranking",
  });
  await expect(unavailable.locator("article")).toHaveCount(1);
  await expect(
    unavailable.getByText("Score unavailable. No numeric score is assumed."),
  ).toBeVisible();
  await expect(
    page.getByText("Source author: <b>Fixture author</b>.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Source editor: Fixture editor.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Source account: https://example.invalid, account 7. Evidence: source-id.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.locator("main")).not.toContainText("[object Object]");
  expect(await page.locator("article b").count()).toBe(0);
  await page
    .getByText("Original source author, account, and import evidence", {
      exact: true,
    })
    .click();
  await expect(page.locator("details[open] pre")).toContainText(
    '"$source_number": "123456789012345678901.25"',
  );
  calculation = null;
  await page.reload();
  await expect(
    page.getByText("Ranking is unavailable. No numeric score is assumed."),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: /Definition layer/ }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "Definitions without an available ranking" })
      .locator("article"),
  ).toHaveCount(4);
  await expect(page.getByText(/Server net interval/)).toHaveCount(0);
});

test("hash-correct packages reject malformed descriptors and every entry field before activation", async ({
  page,
}) => {
  await page.goto("/");
  const results = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    const { downloadPackage } = await import(String("/src/api.ts"));
    const snapshot = "sha256:" + "a".repeat(64);
    const entry = {
      event: "jve1:" + "b".repeat(64),
      word: { language: "jbo", spelling: "broda" },
      language: "en",
      glosses: [{ language: "en", text: "test", sense: null }],
      plain_text: "Literal <script> text",
      classification: { kind: "other", selmaho: [] },
      body: null,
    };
    const bytes = (value: unknown) =>
      core.utf8(core.canonicalize(core.utf8(JSON.stringify(value))));
    const oldFetch = window.fetch;
    const results: { name: string; accepted: boolean; partRequests: number }[] =
      [];
    try {
      const scenarios = [
        { name: "valid", data: [entry] },
        { name: "fractional bytes", descriptor: { bytes: 2.5 } },
        { name: "negative count", descriptor: { count: -1 } },
        { name: "fractional count", descriptor: { count: 1.5 } },
        { name: "missing hash", descriptor: { hash: null } },
        { name: "too many parts", parts: 129 },
        { name: "too many bytes", parts: 33, huge: true },
        { name: "too many entries", parts: 101, many: true },
        ...[
          "event",
          "word",
          "language",
          "glosses",
          "plain_text",
          "classification",
          "body",
        ].map((field) => ({
          name: `invalid ${field}`,
          data: [{ ...entry, [field]: 7 }],
        })),
        {
          name: "invalid gloss",
          data: [
            { ...entry, glosses: [{ language: "en", text: 7, sense: null }] },
          ],
        },
        {
          name: "invalid classification",
          data: [
            { ...entry, classification: { kind: "invalid", selmaho: [] } },
          ],
        },
        { name: "duplicate entries", data: [entry, entry] },
      ];
      for (const scenario of scenarios) {
        const partBytes = bytes(scenario.data ?? [entry]);
        const parts = Array.from(
          { length: scenario.parts ?? 1 },
          (_, index) => ({
            hash:
              index === 0
                ? core.contentHash(partBytes)
                : "sha256:" + index.toString(16).padStart(64, "0"),
            bytes: scenario.huge ? 4194304 : partBytes.length,
            count: scenario.many ? 2000 : (scenario.data ?? [entry]).length,
            ...scenario.descriptor,
          }),
        );
        const pkgBytes = core.utf8(
          JSON.stringify({ version: 1, language: "en", snapshot, parts }),
        );
        const manifest = {
          snapshot,
          packages: [
            {
              language: "en",
              hash: core.contentHash(pkgBytes),
              bytes: pkgBytes.length,
            },
          ],
        };
        let partRequests = 0;
        window.fetch = async (url) => {
          if (String(url).endsWith("/manifest"))
            return new Response(JSON.stringify(manifest));
          if (String(url).includes("/package-parts/")) {
            partRequests++;
            return new Response(partBytes);
          }
          return new Response(pkgBytes);
        };
        try {
          const result = await downloadPackage("en");
          results.push({
            name: scenario.name,
            accepted: result.entries[0].plain_text === entry.plain_text,
            partRequests,
          });
        } catch {
          results.push({ name: scenario.name, accepted: false, partRequests });
        }
      }
      return results;
    } finally {
      window.fetch = oldFetch;
    }
  }, corePath);
  expect(results[0]).toEqual({
    name: "valid",
    accepted: true,
    partRequests: 1,
  });
  for (const result of results.slice(1))
    expect(result.accepted, result.name).toBe(false);
  for (const result of results.filter(
    (result) =>
      !result.name.startsWith("invalid") &&
      result.name !== "duplicate entries" &&
      result.name !== "valid",
  ))
    expect(result.partRequests, result.name).toBe(0);
});

test("invalid downloaded and cached packages leave server search usable", async ({
  page,
}) => {
  await page.goto("/");
  const fixture = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    const { LocalStore } = await import(String("/src/storage.ts"));
    const snapshot = "sha256:" + "a".repeat(64);
    await new LocalStore().put("packages", "en", {
      snapshot,
      entries: [{ word: null }],
    });
    const part = core.utf8(core.canonicalize(core.utf8(JSON.stringify([{}]))));
    const pkg = core.utf8(
      core.canonicalize(
        core.utf8(
          JSON.stringify({
            version: 1,
            language: "en",
            snapshot,
            parts: [
              { hash: core.contentHash(part), bytes: part.length, count: 1 },
            ],
          }),
        ),
      ),
    );
    return {
      snapshot,
      part: new TextDecoder().decode(part),
      pkg: new TextDecoder().decode(pkg),
      hash: core.contentHash(pkg),
      bytes: pkg.length,
    };
  }, corePath);
  await page.route("**/api/v1/manifest", (route) =>
    route.fulfill({
      json: {
        snapshot: fixture.snapshot,
        packages: [
          { language: "en", hash: fixture.hash, bytes: fixture.bytes },
        ],
      },
    }),
  );
  await page.route("**/api/v1/packages/**", (route) =>
    route.fulfill({ body: fixture.pkg }),
  );
  await page.route("**/api/v1/package-parts/**", (route) =>
    route.fulfill({ body: fixture.part }),
  );
  await page.route("**/api/v1/search?**", (route) =>
    route.fulfill({
      json: {
        snapshot: fixture.snapshot,
        view: "jve1:" + "d".repeat(64),
        next: null,
        hits: [
          {
            word: { language: "jbo", spelling: "broda" },
            word_id: "jvw1:" + "b".repeat(64),
            definitions: ["jve1:" + "c".repeat(64)],
            match: "headword",
          },
        ],
      },
    }),
  );
  await page.goto("/search?q=broda&lang=en");
  await expect(page.getByRole("status")).toContainText(
    "The search package is invalid",
  );
  await expect(
    page.getByRole("link", { name: "broda", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Download search package" }).click();
  await expect(page.getByRole("status")).toContainText(
    "The search package is invalid",
  );
  await expect(
    page.getByRole("link", { name: "broda", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/storage.ts"));
      return (await new LocalStore().get("packages", "en")).entries;
    }),
  ).toEqual([{ word: null }]);
});

test("object and package waits expire and oversized streams are cancelled", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    const { api, getEnvelope, downloadPackage } = await import(
      String("/src/api.ts")
    );
    const oldFetch = window.fetch;
    const oldTimeout = AbortSignal.timeout;
    const requestedTimeouts: number[] = [];
    AbortSignal.timeout = (ms) => {
      requestedTimeouts.push(ms);
      return oldTimeout.call(AbortSignal, 25);
    };
    const snapshot = "sha256:" + "a".repeat(64);
    const part = core.utf8("[]");
    const pkg = core.utf8(
      core.canonicalize(
        core.utf8(
          JSON.stringify({
            version: 1,
            language: "en",
            snapshot,
            parts: [
              { hash: core.contentHash(part), bytes: part.length, count: 0 },
            ],
          }),
        ),
      ),
    );
    const manifest = {
      snapshot,
      packages: [
        { language: "en", hash: core.contentHash(pkg), bytes: pkg.length },
      ],
    };
    const outcomes: string[] = [];
    let cancelled = 0;
    try {
      for (const stage of [
        "envelope headers",
        "envelope body",
        "package headers",
        "part body",
        "generic custom signal",
      ]) {
        window.fetch = async (url, options) => {
          const path = String(url);
          if (stage.includes("package") || stage.includes("part")) {
            if (path.endsWith("/manifest"))
              return new Response(JSON.stringify(manifest));
            if (stage === "part body" && path.includes("/packages/"))
              return new Response(pkg);
          }
          if (stage.includes("body"))
            return new Response(
              new ReadableStream({
                cancel() {
                  cancelled++;
                },
              }),
            );
          return new Promise((_, reject) =>
            options!.signal!.addEventListener(
              "abort",
              () => reject(options!.signal!.reason),
              { once: true },
            ),
          );
        };
        try {
          if (stage === "generic custom signal")
            await api("/unused", { signal: new AbortController().signal });
          else if (stage.startsWith("envelope"))
            await getEnvelope("/events/test");
          else await downloadPackage("en");
          outcomes.push("accepted");
        } catch (error) {
          outcomes.push((error as Error).name);
        }
      }
      for (const withLength of [true, false]) {
        window.fetch = async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                if (!withLength) controller.enqueue(new Uint8Array(20481));
              },
              cancel() {
                cancelled++;
              },
            }),
            { headers: withLength ? { "content-length": "20481" } : {} },
          );
        try {
          await getEnvelope("/events/test");
          outcomes.push("accepted");
        } catch (error) {
          outcomes.push((error as Error).message);
        }
      }
      return { outcomes, cancelled, requestedTimeouts };
    } finally {
      window.fetch = oldFetch;
      AbortSignal.timeout = oldTimeout;
    }
  }, corePath);
  expect(result.outcomes.slice(0, 5)).toEqual(Array(5).fill("TimeoutError"));
  expect(result.outcomes.slice(5)).toEqual(
    Array(2).fill("The response exceeds the browser byte limit."),
  );
  expect(result.cancelled).toBe(4);
  expect(result.requestedTimeouts).toContain(20000);
  expect(result.requestedTimeouts).toContain(120000);
});

test("local search keeps the strongest definition match and exposes unavailable view and status", async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: "tr-TR" });
  const page = await context.newPage();
  try {
    await page.goto("/");
    const expected = await page.evaluate(async (corePath) => {
      const core = await import(corePath);
      const { LocalStore } = await import(String("/src/storage.ts"));
      const entry = (
        event: number,
        spelling: string,
        glosses: string[],
        text: string,
      ) => ({
        event: "jve1:" + event.toString(16).padStart(64, "0"),
        word: { language: "jbo", spelling },
        language: "en",
        glosses: glosses.map((text) => ({ language: "en", text, sense: null })),
        plain_text: text,
        classification: {
          kind: "other",
          selmaho: event === 1 ? Array(8193).fill("BAI") : [],
        },
        body: null,
      });
      await new LocalStore().put("packages", "en", {
        snapshot: "sha256:" + "e".repeat(64),
        entries: [
          entry(1, "broda", [], "i travel"),
          entry(2, "brode", ["i"], "another retained publication"),
          entry(3, "broda", ["I"], "a stronger later match"),
          entry(4, "brodi", ["input"], "a prefix match"),
        ],
      });
      return ["broda", "brode"]
        .sort((a, b) =>
          core
            .wordId({ language: "jbo", spelling: a })
            .localeCompare(core.wordId({ language: "jbo", spelling: b }), "en"),
        )
        .concat("brodi");
    }, corePath);
    let requests = 0;
    await page.route("**/api/v1/**", (route) => {
      requests++;
      return route.abort();
    });
    await page.goto("/search?q=I&lang=en");
    await expect(
      page.getByText(
        "Local results can include unselected or deprecated definitions. Their current status is unavailable in this index.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        /It does not evaluate the current view or definition status/,
      ),
    ).toBeVisible();
    await expect(page.locator("main article")).toHaveCount(3);
    expect(
      await page.locator("main article > a:first-child").allTextContents(),
    ).toEqual(expected);
    const broda = page
      .locator("article")
      .filter({ has: page.getByRole("link", { name: "broda", exact: true }) });
    await expect(
      broda.getByText("2 definitions · gloss", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Definition status: unavailable in this local index.", {
        exact: true,
      }),
    ).toHaveCount(3);
    expect(requests).toBe(0);
  } finally {
    await context.close();
  }
});

test("a native IndexedDB open failure keeps a warning and allows anonymous online reading", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
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
      const request = indexedDB.open("jbovlacku-browser-v1", 2);
      request.onupgradeneeded = () => request.result.createObjectStore("keys");
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  });
  await page.route("**/*.wasm", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await route.continue();
  });
  const snapshot = "sha256:" + "f".repeat(64);
  await page.route("**/api/v1/search?**", (route) =>
    route.fulfill({
      json: {
        snapshot,
        view: "jve1:" + "d".repeat(64),
        next: null,
        hits: [
          {
            word: { language: "jbo", spelling: "broda" },
            word_id: "jvw1:" + "1".repeat(64),
            definitions: ["jve1:" + "2".repeat(64)],
            match: "headword",
          },
        ],
      },
    }),
  );
  await page.goto("/search?q=broda&lang=en");
  const warning = page.getByRole("alert");
  await expect(warning).toHaveText(
    "Browser storage is unavailable. You can read online. Drafts, keys, signing, and downloaded search are disabled. Restore storage access and reload this page.",
  );
  await expect(
    page.getByRole("link", { name: "broda", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Download search package" }),
  ).toBeDisabled();
  const fixture = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    const word = { language: "jbo", spelling: "broda" };
    return core.createEvent(
      new Uint8Array(32).fill(97),
      [],
      "9".repeat(32),
      {
        kind: "definition.publish",
        word: core.wordId(word),
        language: "en",
        parents: [],
        origin: "native",
      },
      {
        word,
        language: "en",
        text: [["Online reading still works without browser storage."]],
        frame: null,
        operands: [],
        glosses: [],
        notes: [],
        etymology: { text: [], formation: null, compound: null },
        examples: [],
        classification: { kind: "other", selmaho: [] },
        labels: [],
        sources: [],
        license: {
          expression: "CC0-1.0",
          url: null,
          attribution: "Disposable fixture",
        },
        legacy: null,
      },
    );
  }, corePath);
  const id = fixture.envelope.id;
  await page.route("**/api/v1/words/**", (route) =>
    route.fulfill({
      json: {
        snapshot,
        word: fixture.body.word,
        definitions: [id],
        calculation: { exact: true },
        layers: [[id]],
        statuses: [{ event: id, state: "active" }],
        unavailable_scores: [],
        scores: [],
      },
    }),
  );
  await page.route("**/api/v1/events/**", (route) =>
    route.fulfill({ json: fixture.envelope }),
  );
  await page.route("**/api/v1/bodies/**", (route) =>
    route.fulfill({ json: fixture.body }),
  );
  await page.getByRole("link", { name: "broda", exact: true }).click();
  await expect(
    page.getByText("Online reading still works without browser storage.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(warning).toBeVisible();
  await expect(
    page.getByLabel("Sign from history saved in this browser only"),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Bless", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Heed signer here" }),
  ).toBeDisabled();
  for (const name of ["Add", "Identity", "Outbox"]) {
    await page.getByRole("link", { name, exact: true }).click();
    await expect(
      page.getByRole("heading", {
        name: "Browser storage unavailable",
        exact: true,
      }),
    ).toBeVisible();
    await expect(warning).toBeVisible();
    await expect(page.locator("main form")).toHaveCount(0);
  }
  await page.getByRole("link", { name: "Search", exact: true }).click();
  await expect(warning).toBeVisible();
  await expect(page.getByLabel("Search words and meanings")).toBeEnabled();
  expect(
    await page.evaluate(() => (window as any).storageFailureEvents),
  ).toEqual({ openErrors: ["VersionError"], rejections: [] });
  expect(pageErrors).toEqual([]);
});

test("own-history pagination rejects loops and malformed pages while preserving concurrent heads", async ({
  page,
}) => {
  await page.goto("/");
  const results = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    const { ownHeads } = await import(String("/src/api.ts"));
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
    const scenarios = [
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
        window.fetch = async (url) => {
          const path = String(url);
          if (path.endsWith("/manifest"))
            return new Response(JSON.stringify({ snapshot }));
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
  for (const result of results.results.slice(2, -1))
    expect(result.eventReads, result.name).toBe(0);
});

test("own-history has an overall deadline and respects caller cancellation", async ({
  page,
}) => {
  await page.goto("/");
  const results = await page.evaluate(async () => {
    const { ownHeads } = await import(String("/src/api.ts"));
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
    window.fetch = async (_, options) => {
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
        errors.push((error as Error).name);
      }
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
      const stalledStore = {
        get: () => new Promise<never>(() => {}),
        list: async () => [],
      };
      try {
        await ownHeads(stalledStore as any, "ed25519:" + "1".repeat(64), true);
      } catch (error) {
        errors.push((error as Error).name);
      }
      return { errors, requests, timeouts };
    } finally {
      window.fetch = oldFetch;
      AbortSignal.timeout = oldTimeout;
    }
  });
  expect(results.errors).toEqual([
    "TimeoutError",
    "AbortError",
    "TimeoutError",
  ]);
  expect(results.requests).toBe(1);
  expect(results.timeouts).toContain(120000);
  expect(results.timeouts).toContain(20000);
});

test("remote search previews and later pages pin context and survive browser back", async ({
  page,
}) => {
  const snapshot = "sha256:" + "a".repeat(64);
  const view = "jve1:" + "b".repeat(64);
  const hit = (index: number) => {
    const event = "jve1:" + index.toString(16).padStart(64, "0");
    return {
      word: { language: "jbo", spelling: `fixture-${index}` },
      word_id: "jvw1:" + index.toString(16).padStart(64, "0"),
      definitions: [event],
      match: "token",
      preview: {
        event,
        word_kind: "gismu",
        plain_text: `Literal <script>window.bad=true</script> preview ${index}`,
        status: "active",
      },
    };
  };
  const requests: string[] = [];
  await page.route("**/api/v1/search?**", (route) => {
    const url = new URL(route.request().url());
    requests.push(url.search);
    expect(url.searchParams.get("limit")).toBe("50");
    const after = url.searchParams.get("after");
    if (after) {
      expect(after).toBe("next-page");
      expect(url.searchParams.get("snapshot")).toBe(snapshot);
      expect(url.searchParams.get("view")).toBe(view);
    }
    return route.fulfill({
      json: {
        snapshot,
        view,
        hits: Array.from({ length: after ? 3 : 50 }, (_, index) =>
          hit(index + (after ? 51 : 1)),
        ),
        next: after ? null : "next-page",
      },
    });
  });
  await page.goto("/search?q=fixture&lang=en");
  const results = page.getByRole("region", { name: "Search results" });
  await expect(results.locator("article")).toHaveCount(50);
  await expect(
    results.getByText("Literal <script>window.bad=true</script> preview 1", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(results.getByText("gismu", { exact: true })).toHaveCount(50);
  await expect(
    results.getByText("Server status: active.", { exact: true }),
  ).toHaveCount(50);
  await expect(
    page.getByText(
      "Search previews come from this server. They are not independently verified.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText(`Snapshot: ${snapshot}`, { exact: true }),
  ).not.toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(results.locator("article")).toHaveCount(53);
  expect(
    await results.locator("article > a:first-child").allTextContents(),
  ).toEqual(Array.from({ length: 53 }, (_, index) => `fixture-${index + 1}`));
  await expect(
    page.getByRole("button", { name: "Load more" }),
  ).not.toBeVisible();
  await expect(page).toHaveURL(/\/search\?q=fixture&lang=en$/);
  await page.getByRole("link", { name: "Add", exact: true }).click();
  await page.goBack();
  await expect(page.getByLabel("Search words and meanings")).toHaveValue(
    "fixture",
  );
  await expect(results.locator("article")).toHaveCount(53);
  expect(requests).toHaveLength(2);
  expect(await page.evaluate(() => Boolean((window as any).bad))).toBe(false);
});

test("remote search rejects repeated cursors and duplicate result IDs", async ({
  page,
}) => {
  const snapshot = "sha256:" + "a".repeat(64);
  const view = "jve1:" + "b".repeat(64);
  const hit = (index: number) => ({
    word: { language: "jbo", spelling: `fixture-${index}` },
    word_id: "jvw1:" + index.toString(16).padStart(64, "0"),
    definitions: ["jve1:" + "c".repeat(64)],
    match: "token",
  });
  await page.route("**/api/v1/search?**", (route) => {
    const url = new URL(route.request().url());
    const later = url.searchParams.has("after");
    return route.fulfill({
      json: {
        snapshot,
        view,
        hits: [hit(later && url.searchParams.get("q") === "loop" ? 2 : 1)],
        next:
          later && url.searchParams.get("q") === "duplicate" ? null : "repeat",
      },
    });
  });
  for (const query of ["loop", "duplicate"]) {
    await page.goto(`/search?q=${query}&lang=en`);
    await expect(
      page.getByRole("region", { name: "Search results" }).locator("article"),
    ).toHaveCount(1);
    await page.getByRole("button", { name: "Load more" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Search pagination repeated a cursor or result.",
    );
    await expect(
      page.getByRole("button", { name: "Load more" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("region", { name: "Search results" }).locator("article"),
    ).toHaveCount(1);
  }
});

test("local search renders fifty results per page with a literal strongest-match preview", async ({
  page,
}) => {
  await page.goto("/");
  const expected = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    const { LocalStore } = await import(String("/src/storage.ts"));
    const entries = Array.from({ length: 121 }, (_, index) => ({
      event: "jve1:" + (index + 1).toString(16).padStart(64, "0"),
      word: { language: "jbo", spelling: `broda${index}` },
      language: "en",
      glosses: [],
      plain_text: `needle token ${index}`,
      classification: { kind: "other", selmaho: [] },
      body: null,
    }));
    for (const [offset, text] of [
      "Chosen <img src=x onerror=window.bad=true> literal preview",
      "Later equal-class preview",
    ].entries())
      entries.push({
        ...entries[0],
        event: "jve1:" + (122 + offset).toString(16).padStart(64, "0"),
        glosses: [{ language: "en", text: "needle", sense: null }] as any,
        plain_text: text,
        classification: { kind: "lujvo", selmaho: [] },
      });
    await new LocalStore().put("packages", "en", {
      snapshot: "sha256:" + "d".repeat(64),
      entries,
    });
    return [
      "broda0",
      ...entries
        .slice(1, 121)
        .sort((a, b) =>
          core.wordId(a.word).localeCompare(core.wordId(b.word), "en"),
        )
        .map((entry) => entry.word.spelling),
    ];
  }, corePath);
  let apiRequests = 0;
  await page.route("**/api/v1/**", (route) => {
    apiRequests++;
    return route.abort();
  });
  await page.goto("/search?q=needle&lang=en");
  const results = page.getByRole("region", { name: "Search results" });
  await expect(results.locator("article")).toHaveCount(50);
  await expect(
    results.getByText(
      "Chosen <img src=x onerror=window.bad=true> literal preview",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    results.getByText("Later equal-class preview", { exact: true }),
  ).toHaveCount(0);
  await expect(results.getByText("lujvo", { exact: true })).toBeVisible();
  await expect(
    results.getByText("3 definitions · gloss", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(results.locator("article")).toHaveCount(100);
  await page.getByRole("link", { name: "Add", exact: true }).click();
  await page.goBack();
  await expect(results.locator("article")).toHaveCount(100);
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(results.locator("article")).toHaveCount(121);
  expect(
    await results.locator("article > a:first-child").allTextContents(),
  ).toEqual(expected);
  await expect(
    results.getByText("Definition status: unavailable in this local index.", {
      exact: true,
    }),
  ).toHaveCount(121);
  await expect(
    page.getByRole("button", { name: "Load more" }),
  ).not.toBeVisible();
  expect(apiRequests).toBe(0);
  expect(await results.locator("img").count()).toBe(0);
  expect(await page.evaluate(() => Boolean((window as any).bad))).toBe(false);
});
