import { test, expect } from "@playwright/test";
import { fixture } from "./helpers.ts";

test("a fresh word read retries a transient receipt 503 and displays the completed word", async ({
  page,
}) => {
  const f = fixture();
  await page.goto("/word/cukta");
  await expect(page).toHaveTitle("cukta · jbovlacku");
  await page.evaluate(async (id) => {
    const { getReceipt, rememberAcceptedReceipt, selfPeer } = await import(
      String("/src/data/api.ts")
    );
    const accepted = await getReceipt(id);
    rememberAcceptedReceipt(
      {
        ...accepted,
        snapshot: null,
        interpretation: "unavailable",
        reasons: ["index_lag", "evaluation_pending"],
      },
      selfPeer,
    );
  }, f.definitions.cukta1);
  let polls = 0;
  let releaseReceipt!: () => void;
  const completed = new Promise<void>((resolve) => {
    releaseReceipt = resolve;
  });
  await page.route("**/api/v1/receipts/*", async (route) => {
    polls++;
    if (polls === 1) {
      await route.fulfill({
        status: 503,
        json: { code: "busy", message: "The service is busy." },
      });
      return;
    }
    await completed;
    await route.continue();
  });
  await page.evaluate(async () => {
    const { navigate } = await import(String("/src/app/router.ts"));
    navigate("/word/cukta?fresh=1");
  });
  try {
    await expect.poll(() => polls).toBe(2);
    await expect(
      page.getByText(
        "This server stored your records. Its word view is updating.",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Refresh the word" }),
    ).toHaveCount(0);
  } finally {
    releaseReceipt();
  }
  await expect(page.locator("article.definition").first()).toBeVisible();
  await expect(
    page.getByText(
      "This server stored your records. Its word view is updating.",
    ),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Refresh the word" }),
  ).toHaveCount(0);
  expect(polls).toBe(2);
  expect(
    await page.evaluate(async () => {
      const { hasPendingMaterialization } = await import(
        String("/src/data/api.ts")
      );
      return hasPendingMaterialization();
    }),
  ).toBe(false);
});
