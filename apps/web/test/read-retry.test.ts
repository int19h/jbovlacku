import { test, expect } from "@playwright/test";
import { fixture } from "./helpers.ts";

for (const surface of ["word", "search"] as const)
  test(`a reloaded ${surface} page offers a keyboard retry after HTTP 503`, async ({
    page,
  }) => {
    const f = fixture();
    await page.goto("/search");
    await page.evaluate(async (view) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      await new LocalStore().setPreferences({
        view,
        viewMode: "site",
        searchMode: "remote",
        remoteSearchDisclosed: true,
      });
    }, f.views.shun);
    const url =
      surface === "word" ? "/word/cukta?lang=ru" : "/search?q=cukta&lang=en";
    await page.goto(url);
    if (surface === "word")
      await expect(page.locator(".word-head")).toBeVisible();
    else
      await expect(
        page.getByRole("region", { name: "Search results" }),
      ).toContainText("cukta");
    let blocked = true;
    let requests = 0;
    const pattern =
      surface === "word"
        ? `**/api/v1/words/${encodeURIComponent(f.words.cukta)}*`
        : "**/api/v1/search*";
    await page.route(pattern, async (route) => {
      expect(new URL(route.request().url()).searchParams.get("view")).toBe(
        f.views.shun,
      );
      requests++;
      if (blocked)
        return route.fulfill({
          status: 503,
          json: {
            code: "resource_unavailable",
            message:
              "This view is temporarily unavailable while the next snapshot is published.",
            event: null,
            field: null,
          },
        });
      return route.continue();
    });
    await page.evaluate(() =>
      history.replaceState({ retained: "reader state" }, ""),
    );
    await page.reload();
    const main = page.locator("main");
    await expect(main).toContainText("This view is temporarily unavailable");
    const retry = main.getByRole("button", {
      name: "Retry reading",
      exact: true,
    });
    await expect(retry).toBeVisible();
    expect(requests).toBe(1);
    const historyLength = await page.evaluate(() => history.length);
    await page.evaluate(async () => {
      const { setNavigationGuard } = await import(String("/src/app/router.ts"));
      setNavigationGuard(() => false);
    });
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect(main.locator(".notice")).toHaveCount(1);
    expect(requests).toBe(1);
    await page.evaluate(async () => {
      const { setNavigationGuard } = await import(String("/src/app/router.ts"));
      setNavigationGuard(() => Promise.resolve(true));
    });
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => requests).toBe(2);
    await expect(retry).toBeVisible();
    await expect(main).toContainText("This view is temporarily unavailable");
    await expect(main).toContainText("Still unavailable after read attempt 1.");
    await expect(page.getByRole("status")).toHaveText(
      "Still unavailable after read attempt 1.",
    );
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => requests).toBe(3);
    await expect(main).toContainText("Still unavailable after read attempt 2.");
    await expect(page.getByRole("status")).toHaveText(
      "Still unavailable after read attempt 2.",
    );
    blocked = false;
    await retry.focus();
    await page.keyboard.press("Enter");
    if (surface === "word")
      await expect(page.locator("article.definition").first()).toBeVisible();
    else
      await expect(
        page.getByRole("region", { name: "Search results" }),
      ).toContainText("cukta");
    await expect(retry).toHaveCount(0);
    expect(requests).toBe(4);
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(url);
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
    await expect(main.locator("h1")).toBeFocused();
    expect(await page.evaluate(() => history.state.retained)).toBe(
      "reader state",
    );
    blocked = true;
    await page.evaluate(() => {
      const state = { ...history.state };
      delete state.dictionarySearch;
      history.replaceState(state, "");
    });
    await page.reload();
    await expect(retry).toBeVisible();
    await expect(main).not.toContainText(
      "Still unavailable after read attempt",
    );
    await retry.click();
    await expect(main).toContainText("Still unavailable after read attempt 1.");
    await expect(page.getByRole("status")).toHaveText(
      "Still unavailable after read attempt 1.",
    );
    await page.getByRole("link", { name: "About", exact: true }).click();
    await expect(
      main.getByRole("heading", { name: "About jbovlacku", exact: true }),
    ).toBeVisible();
    await page.goBack();
    await expect(retry).toBeVisible();
    await expect(main).not.toContainText(
      "Still unavailable after read attempt",
    );
  });
