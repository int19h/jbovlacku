import { test, expect } from "@playwright/test";
import { acceptFirstSignature, createIdentity } from "./helpers.ts";
import { typeRichText } from "./rich-helpers.ts";

for (const path of ["/word/", "/word/%20"]) {
  test(`a blank word link at ${path} shows the friendly unavailable page`, async ({
    page,
  }) => {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { name: "Page unavailable" }),
    ).toBeVisible();
    await expect(page).toHaveTitle("Page unavailable · jbovlacku");
    await expect(page.locator("main")).toContainText(
      "This link does not name a word.",
    );
    await expect(page.locator("main")).not.toContainText('{"code"');
  });
}

test("biography paragraphs stay separate in the preview and on the public profile", async ({
  page,
}) => {
  const identity = (await createIdentity(page)).identity as string;
  await page.getByRole("link", { name: "Edit public profile" }).click();
  const editor = page.getByRole("region", { name: "Edit public profile" });
  await editor.getByLabel("Name", { exact: true }).fill("Paragraph Tester");
  await typeRichText(
    editor.getByLabel("Biography", { exact: true }),
    "mi cuntu la lojban\n\nsecond para",
  );
  await editor
    .getByRole("button", { name: "Preview the signed claim" })
    .click();
  const preview = page.getByRole("region", { name: "Profile preview" });
  await expect(preview).toBeVisible();
  const previewText = await preview.innerText();
  expect(previewText).not.toContain("lojbansecond");
  expect(previewText).toContain("mi cuntu la lojban\nsecond para");
  await preview
    .getByRole("button", { name: "Sign and publish the profile" })
    .click();
  await acceptFirstSignature(page);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "The profile is signed and published." }),
  ).toHaveText("The profile is signed and published.");
  await expect
    .poll(() => page.url())
    .toContain(`/identity/${encodeURIComponent(identity)}`);
  await expect
    .poll(async () => page.locator("main").innerText(), { timeout: 20000 })
    .toContain("mi cuntu la lojban\nsecond para");
  const profileText = await page.locator("main").innerText();
  expect(profileText).not.toContain("lojbansecond");
  // The signed record itself keeps the two paragraphs separate.
  const bio = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const [item] = await new LocalStore().list("outbox");
    return JSON.parse(item.transport).body.bio;
  });
  expect(bio).toEqual([["mi cuntu la lojban"], ["second para"]]);
});

test("removing a package during its refresh keeps it removed", async ({
  page,
}) => {
  await page.goto("/preferences");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.locator("div.status[role=status]")).toContainText(
    "The English search package is saved in this browser.",
  );
  await expect(
    page.getByRole("button", { name: "Refresh English" }),
  ).toBeVisible();
  // Hold the refresh download open so Remove lands while it runs.
  await page.route("**/api/v1/packages/**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.continue();
  });
  await page.getByRole("button", { name: "Refresh English" }).click();
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(
    page.getByRole("button", { name: "Refresh English" }),
  ).toHaveCount(0);
  // Give the held refresh time to finish, then check the stored packages.
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const { LocalStore } = await import(String("/src/data/store.ts"));
          return new LocalStore().keys("packages");
        }),
      { timeout: 15000 },
    )
    .toEqual([]);
  await page.waitForTimeout(3000);
  await page.reload();
  await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(0);
  await expect(
    page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      return new LocalStore().keys("packages");
    }),
  ).resolves.toEqual([]);
});
