import { test, expect } from "@playwright/test";
import { corePath } from "./helpers.ts";

test("nearby draft search discloses the exact query and sends only a POST body", async ({
  page,
}) => {
  const searches: { method: string; url: string; body: unknown }[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/search")
      searches.push({
        method: request.method(),
        url: request.url(),
        body: request.postDataJSON(),
      });
  });
  await page.goto("/new");
  await page
    .getByLabel("Meaning", { exact: true })
    .fill("book private committee");
  await expect(
    page.getByText("Download a search package in Settings", { exact: false }),
  ).toBeVisible();
  expect(searches).toHaveLength(0);
  await page
    .getByRole("button", { name: "search this server", exact: true })
    .click();
  const consent = page.getByRole("dialog", { name: "Search this server" });
  await expect(consent).toBeVisible();
  const disclosure = (await consent.textContent()) ?? "";
  await consent
    .getByRole("button", { name: "Search this server", exact: true })
    .click();
  await expect(
    page
      .locator("ol.similar")
      .getByRole("link", { name: "cukta", exact: true }),
  ).toBeVisible();
  expect(disclosure).toContain('"book private committee"');
  expect(disclosure).toContain('"en"');
  expect(searches.map((s) => (s.body as { q: string }).q).sort()).toEqual([
    "book",
    "committee",
    "private",
  ]);
  for (const search of searches) {
    expect(search.method).toBe("POST");
    expect(new URL(search.url).search).toBe("");
    expect(search.body).toMatchObject({ language: "en", literal: "1" });
  }
  await page
    .getByLabel("Meaning", { exact: true })
    .fill("another private phrase");
  await expect(
    page.getByRole("button", { name: "search this server", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Download a search package in Settings", { exact: false }),
  ).toBeVisible();
  expect(searches).toHaveLength(3);
  await page
    .getByRole("button", { name: "search this server", exact: true })
    .click();
  const declined = page.getByRole("dialog", { name: "Search this server" });
  await expect(declined).toBeVisible();
  expect((await declined.textContent()) ?? "").toContain(
    '"another private phrase"',
  );
  await declined.getByRole("button", { name: "Not now" }).click();
  expect(searches).toHaveLength(3);
  await page
    .getByLabel("Meaning", { exact: true })
    .fill("book private committee");
  await expect(
    page.getByRole("button", { name: "search this server", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Download a search package in Settings", { exact: false }),
  ).toBeVisible();
  expect(searches).toHaveLength(3);
});

test("the identity page describes a profile body absent from its snapshot", async ({
  page,
}) => {
  await page.goto("/");
  const identity = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const seed = new Uint8Array(32).fill(218);
    const event = core.createEvent(
      seed,
      [],
      "31".repeat(16),
      { kind: "identity.profile" },
      { name: "Missing", bio: [], links: [] },
    );
    const response = await fetch("/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...event, body: null }),
    });
    if (!response.ok) throw new Error(await response.text());
    return core.identityFromSeed(seed);
  }, corePath);
  await page.goto(`/identity/${encodeURIComponent(identity)}`);
  await expect(
    page.getByText("body absent from this snapshot", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("body unavailable on this server", { exact: false }),
  ).toHaveCount(0);
});
