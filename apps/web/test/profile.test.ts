import { test, expect } from "@playwright/test";
import {
  acceptFirstSignature,
  createIdentity,
  fingerprintText,
  fixture,
} from "./helpers.ts";

test("the public profile editor checks every limit, previews the signed claim, and publishes it", async ({
  page,
}) => {
  const identity = (await createIdentity(page)).identity as string;
  await page.getByRole("link", { name: "Edit public profile" }).click();
  await expect(page).toHaveURL(/#edit$/);
  const editor = page.getByRole("region", { name: "Edit public profile" });
  await expect(editor).toContainText("public signed claim");
  await expect(editor).toContainText("At most 80 characters.");
  await expect(editor).toContainText("at most 8.");
  await expect(editor.getByLabel("Name")).toBeFocused();
  // Every problem is named before a preview exists.
  await editor.getByLabel("Name").fill("x".repeat(81));
  await editor
    .getByLabel("Links")
    .fill("https://example.org/a\nhttp://example.org/b");
  await editor
    .getByRole("button", { name: "Preview the signed claim" })
    .click();
  await expect(editor).toContainText(
    "The name has 81 characters. The limit is 80.",
  );
  await expect(editor).toContainText(
    '"http://example.org/b" is not an absolute HTTPS address.',
  );
  await expect(
    page.getByRole("region", { name: "Profile preview" }),
  ).toHaveCount(0);
  await editor.getByLabel("Name").fill("Disposable Tester");
  await editor
    .getByLabel("Biography")
    .fill("A disposable profile for a test.\n\nSecond paragraph.");
  await editor.getByLabel("Links").fill("https://example.org/a");
  await editor
    .getByRole("button", { name: "Preview the signed claim" })
    .click();
  const preview = page.getByRole("region", { name: "Profile preview" });
  await expect(preview).toContainText("Disposable Tester");
  await expect(preview).toContainText(fingerprintText(identity));
  await expect(preview).toContainText("A disposable profile for a test.");
  await expect(
    preview.getByRole("link", { name: "https://example.org/a" }),
  ).toBeVisible();
  await expect(preview).toContainText(
    "This is a public signed claim with retained history.",
  );
  await preview
    .getByRole("button", { name: "Sign and publish the profile" })
    .click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status").last()).toContainText(
    "The profile is signed and published.",
  );
  // The page shows the server's effective profile, and the key page shows the name.
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Disposable Tester",
  );
  await expect(page.locator("main")).toContainText(
    "A disposable profile for a test.",
  );
  await expect(
    page
      .locator("main")
      .getByRole("link", { name: "https://example.org/a" })
      .first(),
  ).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Recent activity" }),
  ).toContainText("Updated the public profile");
  const record = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const [item] = await new LocalStore().list("outbox");
    return JSON.parse(item.transport);
  });
  expect(record.envelope.header.action).toEqual({ kind: "identity.profile" });
  expect(record.body).toEqual({
    name: "Disposable Tester",
    bio: [["A disposable profile for a test."], ["Second paragraph."]],
    links: ["https://example.org/a"],
  });
  await page.getByRole("link", { name: "Manage it" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Disposable Tester",
  );
  // The editor starts from the current claim.
  await page.getByRole("link", { name: "Edit public profile" }).click();
  await expect(editor.getByLabel("Name")).toHaveValue("Disposable Tester");
  await expect(editor.getByLabel("Links")).toHaveValue("https://example.org/a");
});

test("a rafsi pair link opens the pair's word, rafsi, and judgment, and an unknown pair stays unavailable", async ({
  page,
}) => {
  const f = fixture();
  await page.goto(`/identity/${encodeURIComponent(f.identities.curator)}`);
  const pairLink = page
    .getByRole("list", { name: "Recent activity" })
    .locator('a[href^="/rafsi-pair/"]')
    .first();
  await expect(pairLink).toBeVisible();
  const href = await pairLink.getAttribute("href");
  await pairLink.click();
  await expect(page).toHaveTitle("Rafsi cku for cukta · jbovlacku");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("cku");
  await expect(
    page.getByRole("link", { name: "cukta", exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "all words with cku" }),
  ).toBeVisible();
  const card = page.getByRole("region", { name: "cku for cukta" });
  await expect(card).toContainText("Eligible pair");
  await expect(card.getByRole("button", { name: "Endorse" })).toBeVisible();
  await expect(card).toContainText("Claimed by");
  await expect(page.locator("main")).toContainText(
    decodeURIComponent(href!.slice("/rafsi-pair/".length)),
  );
  // A pair that no retained claim in the packages names stays unavailable.
  await page.goto(`/rafsi-pair/jvr1:${"0".repeat(64)}`);
  await expect(
    page.getByRole("heading", { name: "Rafsi pair unavailable" }),
  ).toBeVisible();
  await expect(page.locator("main")).toContainText(
    "the word and the rafsi are unknown here",
  );
  await page.goto("/rafsi-pair/not-a-pair");
  await expect(page.locator("main")).toContainText(
    "does not name a rafsi pair ID",
  );
});
