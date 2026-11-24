import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("status badges defer account evidence and the reader uses the exact pin", async ({
  page,
}) => {
  const fixture = JSON.parse(
    await readFile(process.env.JVC_FIXTURE_FILE!, "utf8"),
  );
  const visits: URL[] = [];
  await page.route("**/api/v1/account-control?**", async (route) => {
    const url = new URL(route.request().url());
    visits.push(url);
    await route.continue();
  });
  await page.goto("/word/ckusro");
  await expect(page.locator("article.definition").first()).toBeVisible();
  expect(visits).toHaveLength(0);

  const data = await page.evaluate(
    async ({ id, otherView }) => {
      const {
        getWord,
        getPublicationEvidence,
        getAccountControl,
        validateWord,
      } = await import(String("/src/data/api.ts"));
      const word = await getWord(id);
      const status = word.statuses.find(
        (status: any) => status.account_control,
      )!;
      const first = await getPublicationEvidence(status, word);
      const second = await getPublicationEvidence(status, word);
      const other = await getAccountControl(status.account_control, {
        snapshot: word.snapshot,
        view: otherView,
      });

      let rejectsInvalid = false;
      try {
        validateWord(
          {
            ...word,
            statuses: [
              {
                ...status,
                account_control: { origin: "http://example.test", account: 8 },
              },
            ],
          },
          id,
        );
      } catch {
        rejectsInvalid = true;
      }
      let expired = null;
      try {
        await getAccountControl(status.account_control, {
          ...word,
          snapshot: "sha256:" + "0".repeat(64),
        });
      } catch (error) {
        expired = (error as { code?: string }).code;
      }
      return {
        first,
        second,
        word,
        other,
        expired,
        rejectsInvalid,
      };
    },
    { id: fixture.words.ckusro, otherView: fixture.views.shun },
  );
  expect(data.word.status_version).toBe(2);
  expect(data.first).toEqual(data.second);
  expect(data.rejectsInvalid).toBe(true);
  expect(data.expired).toBe("snapshot_expired");
  expect(visits).toHaveLength(3);
  expect(data.other.view).toBe(fixture.views.shun);
  expect(visits[1].searchParams.get("snapshot")).toBe(data.word.snapshot);
  expect(visits[1].searchParams.get("view")).toBe(fixture.views.shun);
  expect(visits[0].searchParams.get("snapshot")).toBe(data.word.snapshot);
  expect(visits[0].searchParams.get("view")).toBe(data.word.view);
  expect(visits[0].searchParams.get("origin")).toBe("https://lensisku.invalid");
  expect(visits[0].searchParams.get("account")).toBe("8");
});
