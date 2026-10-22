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
  let disclosure = "";
  page.once("dialog", async (dialog) => {
    disclosure = dialog.message();
    await dialog.accept();
  });
  await page
    .getByRole("button", { name: "search this server", exact: true })
    .click();
  await expect(
    page
      .locator("ol.similar")
      .getByRole("link", { name: "cukta", exact: true }),
  ).toBeVisible();
  expect(disclosure).toContain('"book"');
  expect(disclosure).toContain('"en"');
  expect(disclosure).not.toContain("private committee");
  expect(searches).toHaveLength(1);
  expect(searches[0].method).toBe("POST");
  expect(new URL(searches[0].url).search).toBe("");
  expect(searches[0].body).toEqual({ q: "book", language: "en", limit: 10 });
  await page
    .getByLabel("Meaning", { exact: true })
    .fill("another private phrase");
  await expect(
    page.getByRole("button", { name: "search this server", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Download a search package in Settings", { exact: false }),
  ).toBeVisible();
  expect(searches).toHaveLength(1);
  page.once("dialog", async (dialog) => {
    disclosure = dialog.message();
    await dialog.dismiss();
  });
  await page
    .getByRole("button", { name: "search this server", exact: true })
    .click();
  expect(disclosure).toContain('"another"');
  expect(searches).toHaveLength(1);
  await page
    .getByLabel("Meaning", { exact: true })
    .fill("book private committee");
  await expect(
    page.getByRole("button", { name: "search this server", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Download a search package in Settings", { exact: false }),
  ).toBeVisible();
  expect(searches).toHaveLength(1);
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
