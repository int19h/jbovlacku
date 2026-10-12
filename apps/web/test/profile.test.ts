import { test, expect, type Page } from "@playwright/test";
import {
  acceptFirstSignature,
  corePath,
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
  await expect(editor.getByLabel("Name", { exact: true })).toBeFocused();
  // Every problem is named before a preview exists.
  await editor.getByLabel("Name", { exact: true }).fill("x".repeat(81));
  await editor
    .getByLabel("Links", { exact: true })
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
  // The biography node limit and the link count limit are checked too.
  await editor.getByLabel("Name", { exact: true }).fill("Short");
  // 8193 paragraphs are 8193 text parts. The value is set directly, which is faster than typing.
  await editor
    .getByLabel("Biography", { exact: true })
    .evaluate((node: HTMLTextAreaElement) => {
      node.value = Array(8193).fill("p").join("\n\n");
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
  await editor
    .getByLabel("Links", { exact: true })
    .fill(
      Array.from({ length: 9 }, (_, i) => `https://example.org/${i}`).join(
        "\n",
      ),
    );
  await editor
    .getByRole("button", { name: "Preview the signed claim" })
    .click();
  await expect(editor).toContainText(
    "The biography has 8193 text parts. The limit is 8192.",
  );
  await expect(editor).toContainText("There are 9 links. The limit is 8.");
  await expect(
    page.getByRole("region", { name: "Profile preview" }),
  ).toHaveCount(0);
  await editor.getByLabel("Name", { exact: true }).fill("Disposable Tester");
  await editor
    .getByLabel("Biography", { exact: true })
    .fill("A disposable profile for a test.\n\nSecond paragraph.");
  await editor
    .getByLabel("Links", { exact: true })
    .fill("https://example.org/a");
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
  await expect(editor.getByLabel("Name", { exact: true })).toHaveValue(
    "Disposable Tester",
  );
  await expect(editor.getByLabel("Links", { exact: true })).toHaveValue(
    "https://example.org/a",
  );
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

/** Signs a profile claim with links and code in the biography, as another client can. */
async function signRichProfile(page: Page) {
  await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { createKey } = await import(String("/src/data/keys.ts"));
    const { signWith, outboxItem } = await import(
      String("/src/data/lifecycle.ts")
    );
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const created = await createKey("test passphrase with spaces");
    await store.put("keys", "selected", created.backup);
    const body = {
      name: "Rich Tester",
      bio: [
        [
          "See ",
          { url: "https://example.org/site", label: "the site" },
          " and the word ",
          { code: "zo'e" },
          ".",
        ],
        ["Second paragraph."],
      ],
      links: ["https://example.org/site"],
    };
    const prepared = core.prepareSigning(
      created.backup.identity,
      [],
      Array.from(crypto.getRandomValues(new Uint8Array(16)), (n: number) =>
        n.toString(16).padStart(2, "0"),
      ).join(""),
      { kind: "identity.profile" },
      body,
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign("Ed25519", created.key, prepared.signing_bytes),
    );
    const transport = core.finishSigning(prepared, signature);
    void signWith;
    const item = outboxItem(transport, crypto.randomUUID(), 0, {
      self: { origin: location.origin, base: "/api/v1", label: "this server" },
    });
    await store.queueGroup([item]);
  }, corePath);
}

test("changing only the name keeps a rich biography exact, and replacing it needs an explicit choice", async ({
  page,
}) => {
  await page.goto("/");
  await signRichProfile(page);
  // Delivery runs by itself once a page is open.
  await page.goto("/outbox");
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        const [item] = await new LocalStore().list("outbox");
        return item?.peers.self.state;
      }),
    )
    .toBe("accepted");
  await page.goto("/identity");
  await page
    .getByLabel("Passphrase", { exact: true })
    .fill("test passphrase with spaces");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByText("Unlocked", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Rich Tester",
  );
  await page.getByRole("link", { name: "Edit public profile" }).click();
  const editor = page.getByRole("region", { name: "Edit public profile" });
  await expect(editor.getByLabel("Biography", { exact: true })).toHaveValue(
    "See the site and the word zo'e.\n\nSecond paragraph.",
  );
  await expect(editor).toContainText(
    "The current biography has links or code that this editor shows as plain text.",
  );
  // Only the name changes. The signed body carries the exact current biography.
  await editor.getByLabel("Name", { exact: true }).fill("Renamed Tester");
  await editor
    .getByRole("button", { name: "Preview the signed claim" })
    .click();
  const preview = page.getByRole("region", { name: "Profile preview" });
  await expect(
    preview.getByRole("link", { name: /the site/ }).first(),
  ).toHaveAttribute("href", "https://example.org/site");
  await preview
    .getByRole("button", { name: "Sign and publish the profile" })
    .click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status").last()).toContainText(
    "The profile is signed and published.",
  );
  const bodies = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const items = await new LocalStore().list("outbox");
    return items
      .sort((a: any, b: any) => a.signedAt - b.signedAt)
      .map((item: any) => JSON.parse(item.transport).body);
  });
  expect(bodies).toHaveLength(2);
  expect(bodies[1].name).toBe("Renamed Tester");
  // The exact nodes of the first claim, kept through the name change.
  expect(bodies[1].bio).toEqual([
    [
      "See ",
      { url: "https://example.org/site", label: "the site" },
      " and the word ",
      { code: "zo'e" },
      ".",
    ],
    ["Second paragraph."],
  ]);
  expect(bodies[1].bio).toEqual(bodies[0].bio);
  expect(bodies[1].links).toEqual(["https://example.org/site"]);
  // The page rendered again with the new claim. An edited biography names
  // what the plain text drops and waits for the choice.
  await expect(editor.getByLabel("Name", { exact: true })).toHaveValue(
    "Renamed Tester",
  );
  await editor
    .getByLabel("Biography", { exact: true })
    .fill("A plain biography now.");
  await editor
    .getByRole("button", { name: "Preview the signed claim" })
    .click();
  await expect(editor).toContainText(
    'Signing it drops from the current biography: the link "the site" to https://example.org/site; the code "zo\'e".',
  );
  await expect(preview).toHaveCount(0);
  await editor
    .getByLabel(
      "Replace the links and code of the current biography with this plain text",
    )
    .check();
  await editor
    .getByRole("button", { name: "Preview the signed claim" })
    .click();
  await expect(preview).toContainText("A plain biography now.");
  await expect(preview.getByRole("link", { name: /the site/ })).toHaveCount(0);
  await preview
    .getByRole("button", { name: "Sign and publish the profile" })
    .click();
  // The earlier announcement is still in the live region. Wait for the third record itself.
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        return (await new LocalStore().list("outbox")).length;
      }),
    )
    .toBe(3);
  const last = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const items = await new LocalStore().list("outbox");
    return JSON.parse(
      items.sort((a: any, b: any) => a.signedAt - b.signedAt).at(-1).transport,
    ).body;
  });
  expect(last.bio).toEqual([["A plain biography now."]]);
});
