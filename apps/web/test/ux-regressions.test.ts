import { test, expect, type Page } from "@playwright/test";
import {
  acceptFirstSignature,
  createIdentity,
  fixture,
  openWord,
} from "./helpers.ts";

const firstScore = (page: Page) =>
  page.locator("article.definition").first().getByRole("img");

type Hit = {
  word?: { spelling?: string };
  definitions: string[];
  preview?: Record<string, unknown> & {
    event?: string;
    attribution?:
      | ({ dates: Record<string, string> } & Record<string, unknown>)
      | null;
  };
};
/**
 * Routes server search pages so that the ckusro row previews the imported
 * definition. The shared test server can hold a newer native "library"
 * definition of ckusro from another suite, and the server previews the
 * lowest event ID among equal matches, so that definition can win. The
 * imported fields below are the seed's signed values, as the server sends
 * them. `edit` then changes each hit for one test.
 */
async function routeImportedPreview(page: Page, edit?: (hit: Hit) => void) {
  const f = fixture();
  await page.route("**/api/v1/search?*", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { hits?: Hit[] };
    for (const hit of body.hits ?? []) {
      if (
        hit.word?.spelling === "ckusro" &&
        hit.preview &&
        hit.preview.event !== f.definitions.imported &&
        hit.definitions.includes(f.definitions.imported)
      )
        hit.preview = {
          ...hit.preview,
          event: f.definitions.imported,
          word_kind: "lujvo",
          plain_text: "x1 is a library of books x2.",
          selmaho: [],
          issuer: f.identities.importer,
          notes: false,
          attribution: {
            source: "https://lensisku.invalid",
            author: "arj",
            account: { origin: "https://lensisku.invalid", account: 8 },
            dates: { created_at: "2003-03-12T10:00:00Z" },
          },
        };
      edit?.(hit);
    }
    await route.fulfill({ response, json: body });
  });
}

async function choosePersonal(page: Page) {
  await page.getByRole("link", { name: /^Trust:/ }).click();
  await page
    .getByRole("radio", { name: "Mine: site view + my choices" })
    .check();
  await expect(
    page.getByRole("link", { name: "Trust: personal view" }),
  ).toBeVisible();
}

test("server search rows show rafsi, attribution, date, and notes from the search response", async ({
  page,
}) => {
  // The row fields come from the search response itself. Reads that used to
  // fill them per row are refused, so a row that still needs them stays empty.
  await page.route("**/api/v1/words/**", (route) => route.abort());
  await page.route("**/api/v1/events/**", (route) => route.abort());
  await page.route("**/api/v1/bodies/**", (route) => route.abort());
  await page.goto("/search?q=book&lang=en");
  const results = page.getByRole("region", { name: "Search results" });
  const cukta = results.locator("article").filter({
    has: page.getByRole("link", { name: "cukta", exact: true }),
  });
  await expect(cukta.locator(".rafsi")).toHaveText("cku");
  await expect(
    cukta.locator(".attribution-line a[href^='/identity/']"),
  ).toBeVisible();
  await expect(cukta.getByRole("link", { name: "notes" })).toBeVisible();
  // The imported row needs the imported definition as its preview.
  await routeImportedPreview(page);
  await page.goto("/search?q=library&lang=en");
  const imported = results.locator("article").filter({
    has: page.getByRole("link", { name: "ckusro", exact: true }),
  });
  await expect(imported.locator(".attribution-line")).toContainText("arj");
  await expect(imported.locator(".attribution-line")).toContainText("Mar 2003");
});

test("a server search page with an over-long preview field still shows the hit", async ({
  page,
}) => {
  // The format allows any selma'o length, so one signer's long name must
  // not cost the page. The browser drops the long name and keeps the row.
  await page.route("**/api/v1/words/**", (route) => route.abort());
  await page.route("**/api/v1/events/**", (route) => route.abort());
  await page.route("**/api/v1/bodies/**", (route) => route.abort());
  await page.route("**/api/v1/search?*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const hit of body.hits ?? [])
      if (hit.preview && hit.word?.spelling === "cukta") {
        hit.preview.selmaho = ["X".repeat(200), "BAI"];
        hit.preview.rafsi = ["r".repeat(200), ...(hit.preview.rafsi ?? [])];
      }
    await route.fulfill({ response, json: body });
  });
  await page.goto("/search?q=book&lang=en");
  const results = page.getByRole("region", { name: "Search results" });
  const cukta = results.locator("article").filter({
    has: page.getByRole("link", { name: "cukta", exact: true }),
  });
  await expect(cukta.locator(".rafsi")).toHaveText("cku");
  await expect(cukta.getByText("BAI", { exact: true })).toBeVisible();
  await expect(
    cukta.locator(".attribution-line a[href^='/identity/']"),
  ).toBeVisible();
  await expect(page.getByText(/invalid search page/)).toHaveCount(0);
});

test("a server row upgrades its attribution line from the signed record", async ({
  page,
}) => {
  // With the reads allowed, the imported author links to the source-account
  // evidence, as the row did before the preview carried the fields.
  await routeImportedPreview(page);
  await page.goto("/search?q=library&lang=en");
  const results = page.getByRole("region", { name: "Search results" });
  const imported = results.locator("article").filter({
    has: page.getByRole("link", { name: "ckusro", exact: true }),
  });
  const author = imported.locator(".attribution-line a", { hasText: "arj" });
  await expect(author).toHaveAttribute("href", /^https:\/\//);
  await expect(author).toHaveAttribute("title", /evidence/);
  await expect(imported.locator(".attribution-line")).toContainText("Mar 2003");
});

test("a refused body read keeps the preview attribution line", async ({
  page,
}) => {
  // The envelope read succeeds and the body read fails. The record line
  // would then lose the source author, the date, and the notes link.
  let refused = 0;
  await page.route("**/api/v1/bodies/**", (route) => {
    refused += 1;
    return route.abort();
  });
  const results = page.getByRole("region", { name: "Search results" });
  await routeImportedPreview(page);
  await page.goto("/search?q=library&lang=en");
  const imported = results.locator("article").filter({
    has: page.getByRole("link", { name: "ckusro", exact: true }),
  });
  await expect(imported.locator(".hit-judgment")).not.toBeEmpty();
  await expect.poll(() => refused).toBeGreaterThan(0);
  // Give the row time to apply the failed read.
  await page.waitForTimeout(1500);
  const line = imported.locator(".attribution-line");
  await expect(line).toContainText("arj");
  await expect(line).toContainText("imported by");
  await expect(line).toContainText("Mar 2003");
  refused = 0;
  await page.goto("/search?q=book&lang=en");
  const cukta = results.locator("article").filter({
    has: page.getByRole("link", { name: "cukta", exact: true }),
  });
  await expect(cukta.locator(".hit-judgment")).not.toBeEmpty();
  await expect.poll(() => refused).toBeGreaterThan(0);
  await page.waitForTimeout(1500);
  await expect(cukta.getByRole("link", { name: "notes" })).toBeVisible();
});

test("the preview date bound keeps the date label the row reads", async ({
  page,
}) => {
  // The row keeps the preview line, so the date comes from the bounded
  // preview dates. Nine labels exceed the bound of eight.
  await page.route("**/api/v1/words/**", (route) => route.abort());
  await page.route("**/api/v1/events/**", (route) => route.abort());
  await page.route("**/api/v1/bodies/**", (route) => route.abort());
  await routeImportedPreview(page, (hit) => {
    if (hit.preview?.attribution && hit.word?.spelling === "ckusro")
      hit.preview.attribution.dates = {
        a: "1",
        b: "2",
        c: "3",
        created_at: "2020-01-15T12:00:00Z",
        d: "4",
        e: "5",
        f: "6",
        g: "7",
        time: "1000000000",
      };
  });
  await page.goto("/search?q=library&lang=en");
  const results = page.getByRole("region", { name: "Search results" });
  const imported = results.locator("article").filter({
    has: page.getByRole("link", { name: "ckusro", exact: true }),
  });
  await expect(imported.locator(".attribution-line")).toContainText("arj");
  // The SQL time label wins over created_at, as on the definition page.
  await expect(imported.locator(".attribution-line")).toContainText("Sep 2001");
  await expect(imported.locator(".attribution-line")).not.toContainText(
    "Jan 2020",
  );
});

test("a stale personal calculation is not presented as this page's calculation", async ({
  page,
}) => {
  await createIdentity(page);
  await choosePersonal(page);
  await openWord(page, "cukta");
  const panel = page.getByRole("region", { name: "Personal view" });
  await expect(panel).toContainText(
    /Personal view calculated in this browser from \d+ verified records\./,
  );
  await expect(firstScore(page)).toHaveAttribute(
    "aria-label",
    /in your personal view$/,
  );
  // A new signed judgment moves the server to a newer snapshot.
  await openWord(page, "vlacku");
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toHaveText(
    "Your endorsement is published.",
  );
  await page.evaluate(() => {
    const anchor = document.createElement("a");
    anchor.href = "/word/cukta?fresh=1";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  });
  await expect(page).toHaveTitle("cukta · jbovlacku");
  // Every part of the page now says the same thing: the ready calculation
  // belongs to another snapshot, and this page has no personal scores.
  await expect(
    page.getByText(
      /Personal scores are unavailable: The local calculation uses another snapshot or view/,
    ),
  ).toBeVisible();
  await expect(panel).toContainText(
    "Personal scores are unavailable for this snapshot.",
  );
  await expect(panel).not.toContainText(/verified records\./);
  await expect(firstScore(page)).toHaveAttribute(
    "aria-label",
    "Score unavailable in the personal view",
  );
  await page
    .getByRole("button", { name: "Recompute for this snapshot" })
    .click();
  await expect(firstScore(page)).toHaveAttribute(
    "aria-label",
    /in your personal view$/,
  );
  await expect(panel).toContainText(
    /Personal view calculated in this browser from \d+ verified records\./,
  );
  await expect(panel).not.toContainText("for another snapshot");
});

test("the unavailable note follows the latest calculation failure", async ({
  page,
}) => {
  await page.route("**/api/v1/inventory?*", (route) =>
    route.fulfill({ status: 500, body: "broken" }),
  );
  await page.goto("/trust");
  await page
    .getByRole("radio", { name: "Mine: site view + my choices" })
    .check();
  await openWord(page, "cukta");
  const panel = page.getByRole("region", { name: "Personal view" });
  const note = page.getByText(/Personal scores are unavailable:/);
  await expect(note).toContainText("Request failed (500).");
  // A retry that fails in a new way replaces the reason in both places.
  await page.unroute("**/api/v1/inventory?*");
  await page.route("**/api/v1/inventory?*", (route) => route.abort());
  await panel.getByRole("button", { name: "Recompute from records" }).click();
  await expect(panel).toContainText("No connection to the server.");
  await expect(note).toContainText("No connection to the server.");
  await expect(note).not.toContainText("Request failed (500).");
});

test("the recompute button keeps focus while the note follows the calculation", async ({
  page,
}) => {
  await createIdentity(page);
  await choosePersonal(page);
  await openWord(page, "cukta");
  const panel = page.getByRole("region", { name: "Personal view" });
  await expect(panel).toContainText(
    /Personal view calculated in this browser from \d+ verified records\./,
  );
  await openWord(page, "vlacku");
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toHaveText(
    "Your endorsement is published.",
  );
  await page.evaluate(() => {
    const anchor = document.createElement("a");
    anchor.href = "/word/cukta?fresh=1";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  });
  await expect(page).toHaveTitle("cukta · jbovlacku");
  const recompute = page.getByRole("button", {
    name: "Recompute for this snapshot",
  });
  const note = page.getByText(/Personal scores are unavailable:/);
  await expect(recompute).toBeVisible();
  // Hold the inventory so the busy state lasts, then refuse it.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v1/inventory?*", async (route) => {
    await held;
    await route.abort();
  });
  await recompute.focus();
  await page.keyboard.press("Enter");
  await expect(note).toContainText("The local calculation is not ready yet.");
  await expect(recompute).toBeFocused();
  release();
  await expect(note).toContainText("No connection to the server.");
  await expect(recompute).toBeFocused();
});

test("focus stays on a row link when the signed record upgrades the attribution line", async ({
  page,
}) => {
  await routeImportedPreview(page);
  for (const [query, spelling, selector] of [
    ["book", "cukta", ".attribution-line a[href$='#notes']"],
    ["library", "ckusro", ".attribution-line a.identity-link"],
  ] as const) {
    let release = () => {};
    let held = 0;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/v1/bodies/**", async (route) => {
      held += 1;
      await gate;
      await route.continue();
    });
    await page.goto(`/search?q=${query}&lang=en`);
    const row = page
      .getByRole("region", { name: "Search results" })
      .locator("article")
      .filter({ has: page.getByRole("link", { name: spelling, exact: true }) });
    const target = row.locator(selector);
    await expect(target).toBeVisible();
    await expect.poll(() => held).toBeGreaterThan(0);
    await target.focus();
    await expect(target).toBeFocused();
    release();
    // The upgraded line carries the signed record's date or author link.
    if (spelling === "ckusro")
      await expect(
        row.locator(".attribution-line a", { hasText: "arj" }),
      ).toHaveAttribute("href", /^https:\/\//);
    else await expect(row.getByRole("img", { name: "place 1" })).toBeVisible();
    await expect(row.locator(selector)).toBeFocused();
    await page.unroute("**/api/v1/bodies/**");
  }
});

test("a malformed preview list takes the documented fallback", async ({
  page,
}) => {
  await page.route("**/api/v1/search?*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const hit of body.hits ?? [])
      if (hit.preview && hit.word?.spelling === "cukta")
        hit.preview.rafsi = [42];
    await route.fulfill({ response, json: body });
  });
  await page.goto("/search?q=book&lang=en");
  const cukta = page
    .getByRole("region", { name: "Search results" })
    .locator("article")
    .filter({ has: page.getByRole("link", { name: "cukta", exact: true }) });
  // The row reads the rafsi from the word's claims, as an older response does.
  await expect(cukta.locator(".rafsi")).toHaveText("cku");
});

test("score titles and the source line follow a cancelled recompute", async ({
  page,
}) => {
  await createIdentity(page);
  await choosePersonal(page);
  await openWord(page, "cukta");
  const panel = page.getByRole("region", { name: "Personal view" });
  await expect(panel).toContainText(/verified records\./);
  await openWord(page, "vlacku");
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toHaveText(
    "Your endorsement is published.",
  );
  await page.evaluate(() => {
    const anchor = document.createElement("a");
    anchor.href = "/word/cukta?fresh=1";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  });
  await expect(page).toHaveTitle("cukta · jbovlacku");
  const sourceLine = page.locator("details.word-source .body p", {
    hasText: "The local calculation is for snapshot",
  });
  await expect(sourceLine).toHaveCount(1);
  await expect(firstScore(page)).toHaveAttribute(
    "title",
    /The local calculation is for snapshot/,
  );
  // Hold the inventory so the recompute stays busy, then cancel it.
  await page.route("**/api/v1/inventory?*", () => new Promise(() => {}));
  await page
    .getByRole("button", { name: "Recompute for this snapshot" })
    .click();
  await panel.getByRole("button", { name: "Cancel" }).click();
  await expect(panel).toContainText("cancelled");
  // No local calculation exists any more, so nothing on the page names one.
  await expect(firstScore(page)).toHaveAttribute("title", /cancelled/);
  await expect(sourceLine).toHaveCount(0);
  await page.getByText("Score details").first().click();
  await expect(
    page.locator("details.judgment-details .body").first(),
  ).toContainText("cancelled");
});

test("the note reconciles a status that changed during the own-history read", async ({
  page,
}) => {
  await createIdentity(page);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().setPreferences({
      viewMode: "personal",
      myJudgmentsFirst: true,
    });
  });
  let offline = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const heads = page.waitForRequest("**/api/v1/identity-heads/**");
  await page.route("**/api/v1/identity-heads/**", async (route) => {
    await gate;
    await route.continue();
  });
  await page.route("**/api/v1/inventory?*", (route) =>
    offline ? route.abort() : route.fulfill({ status: 500, body: "broken" }),
  );
  await page.goto("/word/cukta?lang=en");
  const panel = page.getByRole("region", { name: "Personal view" });
  const note = page.getByText(/^Personal scores are unavailable:/);
  try {
    await expect(panel).toContainText("Request failed (500).");
    await heads;
    offline = true;
    await panel.getByRole("button", { name: "Recompute from records" }).click();
    await expect(panel).toContainText("No connection to the server.");
  } finally {
    release();
  }
  await expect(note).toContainText("No connection to the server.");
  await expect(note).not.toContainText("Request failed (500).");
});

test("a previous site calculation is not named as personal", async ({
  page,
}) => {
  await createIdentity(page);
  await openWord(page, "cukta");
  await page.getByText("Source and scores", { exact: true }).click();
  await page.getByText("Check the scores locally", { exact: true }).click();
  await page.getByRole("button", { name: "Recompute from records" }).click();
  await expect(
    page.getByRole("region", { name: "Local calculation" }),
  ).toContainText("Site view calculated in this browser");
  await openWord(page, "vlacku");
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toHaveText(
    "Your endorsement is published.",
  );
  await choosePersonal(page);
  // Record every text the personal panel shows on the fresh word page.
  await page.evaluate(() => {
    const lines: string[] = [];
    (window as unknown as { panelLines: string[] }).panelLines = lines;
    const read = () => {
      const node = document.querySelector(
        '[role="region"][aria-label="Personal view"] p',
      );
      if (node?.textContent && lines.at(-1) !== node.textContent)
        lines.push(node.textContent);
    };
    new MutationObserver(read).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    const anchor = document.createElement("a");
    anchor.href = "/word/cukta?fresh=1";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  });
  await expect(page.locator("article.definition").first()).toBeVisible();
  const lines = await page.evaluate(
    () => (window as unknown as { panelLines: string[] }).panelLines,
  );
  // The last completed calculation is the site calculation, so the panel
  // names it as such until a personal calculation finishes.
  expect(lines[0], JSON.stringify(lines)).toMatch(
    /^Site view calculated in this browser from \d+ verified records for another snapshot\./,
  );
});

test("open score details follow a retry that fails differently", async ({
  page,
}) => {
  await page.goto("/preferences");
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().setPreferences({ viewMode: "personal" });
  });
  let offline = false;
  await page.route("**/api/v1/inventory?*", (route) =>
    offline ? route.abort() : route.fulfill({ status: 500, body: "broken" }),
  );
  await page.goto("/word/cukta?lang=en");
  const panel = page.getByRole("region", { name: "Personal view" });
  const note = page.getByText(/^Personal scores are unavailable:/);
  // One definition and one rafsi, each with its disclosure open.
  const blocks = [
    page.locator("article.definition").first(),
    page.locator('[aria-labelledby="rafsi-h"] .definition').first(),
  ].map((row) => row.locator("details.judgment-details").first());
  for (const block of blocks) {
    await block.locator("summary").click();
    await expect(block.locator(".body")).toContainText("Request failed (500).");
  }
  offline = true;
  await panel.getByRole("button", { name: "Recompute from records" }).click();
  await expect(panel).toContainText("No connection to the server.");
  await expect(note).toContainText("No connection to the server.");
  for (const block of blocks) {
    // The disclosure stays open, and its text gives the current reason.
    await expect(block).toHaveAttribute("open", "");
    const reason = block
      .locator(".body p.small")
      .filter({ hasText: "Your personal view" });
    await expect(reason).toContainText("No connection to the server.");
    await expect(reason).not.toContainText("Request failed (500).");
    await expect(
      block.getByRole("link", { name: "Open the Trust page" }),
    ).toBeVisible();
  }
});
