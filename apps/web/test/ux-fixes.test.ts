import { test, expect, type Page } from "@playwright/test";
import { acceptFirstSignature, createIdentity } from "./helpers.ts";
import { typeRichText } from "./rich-helpers.ts";

/** The languages of the packages in the browser store. */
async function storedPackageKeys(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().keys("packages");
  });
}

/** Counts renders of the Settings package list on this page. */
async function watchPackageList(page: Page): Promise<void> {
  await page.evaluate(() => {
    const box = document.querySelector("main .stack")!;
    const view = window as unknown as { packageListRenders: number };
    view.packageListRenders = 0;
    new MutationObserver(() => {
      view.packageListRenders++;
    }).observe(box, { childList: true });
  });
}

async function packageListRenders(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { packageListRenders: number }).packageListRenders,
  );
}

/** Holds every package request on this page until `release` is called. */
function holdPackageRequests(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  void page.route("**/api/v1/packages/**", async (route) => {
    started++;
    await gate;
    await route.continue();
  });
  return { release: () => release(), started: () => started };
}

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
  await watchPackageList(page);
  // Hold the refresh download open so Remove lands while it runs.
  const held = holdPackageRequests(page);
  const responseDone = page.waitForResponse(
    (response) => response.url().includes("/api/v1/packages/") && response.ok(),
  );
  await page.getByRole("button", { name: "Refresh English" }).click();
  await expect.poll(() => held.started()).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(
    page.getByRole("button", { name: "Refresh English" }),
  ).toHaveCount(0);
  expect(await storedPackageKeys(page)).toEqual([]);
  // Wait for the held refresh itself to end: its response completes and
  // the refresh renders the list again. No fixed sleep is involved.
  const rendersBeforeEnd = await packageListRenders(page);
  held.release();
  await responseDone;
  await expect
    .poll(async () => packageListRenders(page))
    .toBeGreaterThan(rendersBeforeEnd);
  expect(await storedPackageKeys(page)).toEqual([]);
  await page.reload();
  await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(0);
  expect(await storedPackageKeys(page)).toEqual([]);
});

test("a download that finishes after a remove in another tab does not save", async ({
  context,
}) => {
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  await tabA.goto("/preferences");
  await expect(
    tabA.getByRole("button", { name: "Download", exact: true }),
  ).toBeVisible();
  await watchPackageList(tabA);
  // Tab A's download is held open while tab B downloads and removes.
  const held = holdPackageRequests(tabA);
  await tabA.getByRole("button", { name: "Download", exact: true }).click();
  await expect.poll(() => held.started()).toBeGreaterThan(0);
  await tabB.goto("/preferences");
  await tabB.getByRole("button", { name: "Download", exact: true }).click();
  await expect(tabB.locator("div.status[role=status]")).toContainText(
    "The English search package is saved in this browser.",
  );
  await tabB.getByRole("button", { name: "Remove" }).click();
  await expect.poll(async () => storedPackageKeys(tabB)).toEqual([]);
  // Let tab A's download finish and wait until it renders the list again,
  // which is the end of its save attempt.
  const rendersBeforeEnd = await packageListRenders(tabA);
  held.release();
  await expect
    .poll(async () => packageListRenders(tabA))
    .toBeGreaterThan(rendersBeforeEnd);
  expect(await storedPackageKeys(tabA)).toEqual([]);
  await tabB.reload();
  await expect(tabB.getByRole("button", { name: "Remove" })).toHaveCount(0);
  expect(await storedPackageKeys(tabB)).toEqual([]);
});

test("opening a rafsi page does not save back a removed package", async ({
  page,
}) => {
  await page.goto("/preferences");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.locator("div.status[role=status]")).toContainText(
    "The English search package is saved in this browser.",
  );
  await page.getByRole("button", { name: "Remove" }).click();
  await expect.poll(async () => storedPackageKeys(page)).toEqual([]);
  await page.goto("/rafsi/klama");
  // The lookup has settled when the page reports its outcome.
  await expect
    .poll(async () => {
      const text = await page.locator("main").innerText();
      return /No retained claim assigns|Rafsi lookup needs|claim/i.test(text);
    })
    .toBe(true);
  expect(await storedPackageKeys(page)).toEqual([]);
  await page.goto("/preferences");
  await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(0);
  expect(await storedPackageKeys(page)).toEqual([]);
});
