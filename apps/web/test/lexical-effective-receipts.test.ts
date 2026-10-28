import { test, expect } from "@playwright/test";
import { corePath } from "./helpers.ts";

test("downloaded local search removes inert definitions after a transfer-only refresh without sending the query", async ({
  page,
}) => {
  await page.goto("/preferences");
  const records = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const publisher = new Uint8Array(32).fill(220);
    const definition = (seed: Uint8Array, spelling: string, nonce: string) => {
      const word = { language: "jbo", spelling };
      return core.createEvent(
        seed,
        [],
        nonce,
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
          text: [["lexicalreceiptprobe"]],
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
            url: "https://creativecommons.org/publicdomain/zero/1.0/",
            attribution: "",
          },
          legacy: null,
        },
      );
    };
    const concurrent = definition(publisher, "tcaprobi", "91".repeat(16));
    const control = definition(
      new Uint8Array(32).fill(221),
      "tcaprobu",
      "92".repeat(16),
    );
    const transfer = core.createEvent(
      publisher,
      [],
      "93".repeat(16),
      {
        kind: "identity.transfer",
        successor: core.identityFromSeed(new Uint8Array(32).fill(222)),
      },
      null,
    );
    for (const record of [concurrent, control]) {
      const response = await fetch("/api/v1/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(record),
      });
      if (!response.ok) throw new Error(await response.text());
    }
    return {
      concurrent: concurrent.envelope.id,
      control: control.envelope.id,
      transfer,
    };
  }, corePath);
  await expect
    .poll(async () => {
      const receipt = await (
        await page.request.get(`/api/v1/receipts/${records.control}`)
      ).json();
      return (
        receipt.snapshot !== null && receipt.interpretation === "effective"
      );
    })
    .toBe(true);
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.locator("#app > [role=status]")).toHaveText(
    "The English search package is saved in this browser.",
  );
  const cached = () =>
    page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const saved = await new LocalStore().get("packages", "en");
      return {
        snapshot: saved.snapshot,
        ids: saved.entries.map((entry: { event: string }) => entry.event),
      };
    });
  const prior = await cached();
  expect(prior.ids).toContain(records.concurrent);
  expect(prior.ids).toContain(records.control);
  const admitted = await page.request.post("/api/v1/events", {
    data: records.transfer,
  });
  expect(admitted.ok()).toBe(true);
  await expect
    .poll(async () => {
      const receipt = await (
        await page.request.get(`/api/v1/receipts/${records.concurrent}`)
      ).json();
      return (
        receipt.snapshot !== prior.snapshot &&
        receipt.interpretation === "inert"
      );
    })
    .toBe(true);
  await page
    .getByRole("button", { name: "Refresh English", exact: true })
    .click();
  await expect(page.locator("#app > [role=status]")).toHaveText(
    "The English package is refreshed.",
  );
  const forbidden: string[] = [];
  await page.route("**/api/v1/**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      request.method() === "GET" &&
      url.pathname === "/api/v1/capabilities" &&
      !url.search
    )
      return route.continue();
    forbidden.push(request.url());
    return route.abort();
  });
  await page.goto("/search?q=lexicalreceiptprobe&lang=en");
  const results = page.getByRole("region", { name: "Search results" });
  await expect(
    results.getByRole("link", { name: "tcaprobu", exact: true }),
  ).toBeVisible();
  await expect(
    results.getByRole("link", { name: "tcaprobi", exact: true }),
  ).toHaveCount(0);
  const current = await cached();
  expect(current.snapshot).not.toBe(prior.snapshot);
  expect(current.ids).toContain(records.control);
  expect(current.ids).not.toContain(records.concurrent);
  expect(forbidden).toEqual([]);
});
