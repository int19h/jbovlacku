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
      if (
        surface === "search" &&
        new URL(route.request().url()).searchParams.get("group") ===
          "definitions"
      )
        return route.continue();
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
    await expect(main.locator(".notice:visible")).toHaveCount(1);
    await expect(main).not.toContainText("Still unavailable after retry");
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
    await expect(main).toContainText("Still unavailable after retry 1.");
    await expect(page.getByRole("status")).toHaveText(
      "Still unavailable after retry 1. This view is temporarily unavailable while the next snapshot is published.",
    );
    await expect(main.locator("h1")).toBeFocused();
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => requests).toBe(3);
    await expect(main).toContainText("Still unavailable after retry 2.");
    await expect(page.getByRole("status")).toHaveText(
      "Still unavailable after retry 2. This view is temporarily unavailable while the next snapshot is published.",
    );
    await expect(main.locator("h1")).toBeFocused();
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
    await expect(main).not.toContainText("Still unavailable after retry");
    await retry.click();
    await expect(main).toContainText("Still unavailable after retry 1.");
    await expect(page.getByRole("status")).toHaveText(
      "Still unavailable after retry 1. This view is temporarily unavailable while the next snapshot is published.",
    );
    await page.getByRole("link", { name: "About", exact: true }).click();
    await expect(
      main.getByRole("heading", { name: "About jbovlacku", exact: true }),
    ).toBeVisible();
    await page.goBack();
    await expect(retry).toBeVisible();
    await expect(main).not.toContainText("Still unavailable after retry");
  });

for (const surface of ["word", "search"] as const)
  for (const failure of ["HTTP 500", "connection failure"] as const)
    test(`a ${surface} retry announces its number and new reason after ${failure}`, async ({
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
      const pattern =
        surface === "word"
          ? `**/api/v1/words/${encodeURIComponent(f.words.cukta)}*`
          : "**/api/v1/search*";
      const reason =
        failure === "HTTP 500"
          ? "The server could not read the selected view."
          : "No connection to the server.";
      let requests = 0;
      await page.route(pattern, async (route) => {
        expect(new URL(route.request().url()).searchParams.get("view")).toBe(
          f.views.shun,
        );
        if (
          surface === "search" &&
          new URL(route.request().url()).searchParams.get("group") ===
            "definitions"
        )
          return route.continue();
        expect(route.request().method()).toBe("GET");
        requests++;
        if (requests === 1)
          return route.fulfill({
            status: 503,
            json: {
              code: "resource_unavailable",
              message: "The selected view is temporarily unavailable.",
              event: null,
              field: null,
            },
          });
        if (failure === "connection failure") return route.abort("failed");
        return route.fulfill({
          status: 500,
          json: {
            code: "internal_error",
            message: reason,
            event: null,
            field: null,
          },
        });
      });
      await page.goto(url);
      const main = page.locator("main");
      await expect(main).toContainText(
        "The selected view is temporarily unavailable.",
      );
      await page.evaluate(() =>
        history.replaceState({ retained: "reader state" }, ""),
      );
      const historyLength = await page.evaluate(() => history.length);
      const writes: string[] = [];
      page.on("request", (request) => {
        if (
          request.method() === "POST" &&
          new URL(request.url()).pathname === "/api/v1/events"
        )
          writes.push(request.url());
      });
      const retry = main.getByRole("button", {
        name: "Retry reading",
        exact: true,
      });
      await retry.focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => requests).toBe(2);
      await expect(main).toContainText(reason);
      await expect(main).toContainText("Still unavailable after retry 1.");
      await expect(page.getByRole("status")).toHaveText(
        `Still unavailable after retry 1. ${reason}`,
      );
      await expect(main).not.toContainText(
        "The selected view is temporarily unavailable.",
      );
      await expect(retry).toHaveCount(0);
      await expect(main.locator("h1")).toBeFocused();
      expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(
        url,
      );
      expect(await page.evaluate(() => history.length)).toBe(historyLength);
      expect(await page.evaluate(() => history.state.retained)).toBe(
        "reader state",
      );
      expect(await page.evaluate(() => history.state.jvcReadRetry)).toBeNull();
      expect(writes).toEqual([]);
      if (surface === "search" && failure === "connection failure")
        await expect(main).toContainText(
          "Download a search package in Settings to search without a connection.",
        );
    });
