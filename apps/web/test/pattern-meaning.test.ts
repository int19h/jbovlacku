import { test, expect } from "@playwright/test";
import { resolve } from "node:path";

test("R2 consented remote nearby meanings preserve literal punctuation", async ({
  page,
}) => {
  const language = "en-x-r2lit";
  const spelling = "r2literalremote";
  await page.goto("/");
  await page.evaluate(
    async ({ corePath, language, spelling }) => {
      const core = await import(corePath);
      await core.initializeCore();
      const word = { language: "jbo", spelling };
      const record = core.createEvent(
        crypto.getRandomValues(new Uint8Array(32)),
        [],
        "01".repeat(16),
        {
          kind: "definition.publish",
          word: core.wordId(word),
          language,
          parents: [],
          origin: "native",
        },
        {
          word,
          language,
          text: [["Synthetic literal meaning fixture."]],
          glosses: [
            { language, text: "c*-algebra", sense: null },
            { language, text: "name@example.org", sense: null },
          ],
          classification: { kind: "other" },
          license: { expression: "CC0-1.0" },
        },
      );
      const response = await fetch("/api/v1/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(record),
      });
      if (!response.ok) throw new Error(await response.text());
    },
    {
      corePath: `/@fs${resolve("packages/core/src/browser.ts")}`,
      language,
      spelling,
    },
  );
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/api/v1/search?${new URLSearchParams({ q: spelling, language })}`,
      );
      return response.ok() && (await response.json()).hits.length;
    })
    .toBe(1);
  const requests: any[] = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname === "/api/v1/search" &&
      request.method() === "POST"
    )
      requests.push(request.postDataJSON());
  });
  await page.goto(
    `/new/meaning?${new URLSearchParams({ meaning: "x1 is a C*-algebra", lang: language })}`,
  );
  for (const meaning of ["x1 is a C*-algebra", "name@example.org"]) {
    const input = page.getByLabel("Meaning", { exact: true });
    if ((await input.inputValue()) !== meaning) await input.fill(meaning);
    page.once("dialog", (dialog) => dialog.accept());
    const [response] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/v1/search" &&
          response.request().method() === "POST",
      ),
      page
        .getByRole("button", { name: "search this server", exact: true })
        .click(),
    ]);
    expect(response.status()).toBe(200);
    await expect(
      page.getByRole("link", { name: spelling, exact: true }),
    ).toBeVisible();
  }
  expect(
    [...new Set(requests.map((request) => JSON.stringify(request)))]
      .map((request) => JSON.parse(request))
      .map(({ q, literal, language }) => ({ q, literal, language })),
  ).toEqual([
    { q: "c*-algebra", literal: "1", language },
    { q: "name@example.org", literal: "1", language },
  ]);
});
