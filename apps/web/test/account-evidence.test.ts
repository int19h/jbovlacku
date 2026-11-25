import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fixture as serverFixture } from "./helpers.ts";

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

test("cancellable readers share one account request and cancel independently", async ({
  page,
}) => {
  const id = serverFixture().words.ckusro;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v1/account-control?**", async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  await page.goto("/");
  const observed = page.waitForRequest("**/api/v1/account-control?**");
  const reads = page.evaluate(async (id) => {
    const { getWord, getAccountControl } = await import(
      String("/src/data/api.ts")
    );
    const word = await getWord(id);
    const reference = word.statuses.find(
      (status: any) => status.account_control,
    ).account_control;
    const original = window.fetch;
    let requests = 0;
    window.fetch = (input, init) => {
      if (String(input).includes("/account-control?")) requests++;
      return original(input, init);
    };
    const first = new AbortController();
    const second = new AbortController();
    const aborted = new Promise<void>((resolve) => {
      window.addEventListener(
        "cancel-account-wait",
        () => {
          first.abort();
          resolve();
        },
        { once: true },
      );
    });
    try {
      const response = Promise.allSettled([
        getAccountControl(reference, word, { signal: first.signal }),
        getAccountControl(
          reference,
          { snapshot: word.snapshot, view: word.view },
          { signal: second.signal },
        ),
      ]);
      await aborted;
      const [a, b] = await response;
      return {
        requests,
        aborted: a.status === "rejected" && a.reason.name === "AbortError",
        otherSucceeded: b.status === "fulfilled",
      };
    } finally {
      window.fetch = original;
    }
  }, id);
  try {
    await observed;
    await page.evaluate(() =>
      window.dispatchEvent(new Event("cancel-account-wait")),
    );
  } finally {
    release();
  }
  expect(await reads).toEqual({
    requests: 1,
    aborted: true,
    otherSucceeded: true,
  });
});

test("a successful account read stays cached while the word pin is in use", async ({
  page,
}) => {
  const id = serverFixture().words.ckusro;
  const requests: string[] = [];
  await page.route("**/api/v1/account-control?**", (route) => {
    requests.push(route.request().url());
    return route.continue();
  });
  await page.goto("/");
  await page.clock.install();
  await page.evaluate(async (id) => {
    const { getWord, getAccountControl } = await import(
      String("/src/data/api.ts")
    );
    const word = await getWord(id);
    const reference = word.statuses.find(
      (status: any) => status.account_control,
    ).account_control;
    const first = await getAccountControl(reference, word);
    // This handler retains the same word response and pin between reads.
    window.addEventListener(
      "read-account-again",
      () => {
        const result = document.createElement("output");
        result.id = "account-read-result";
        document.body.append(result);
        void getAccountControl(reference, word)
          .then((again: unknown) => {
            result.textContent = String(again === first);
          })
          .catch(() => {
            result.textContent = "failed";
          });
      },
      { once: true },
    );
  }, id);
  await page.clock.fastForward(16_000);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("read-account-again")),
  );
  await expect(page.locator("#account-read-result")).toHaveText("true");
  expect(requests).toHaveLength(1);
});

test("a missing publication account reference is distinct from an unclaimed row", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async (id) => {
    const { getWord, getAccountControl, getPublicationEvidence } = await import(
      String("/src/data/api.ts")
    );
    const word = await getWord(id);
    const status = word.statuses.find((status: any) => status.account_control);
    const reference = status.account_control;
    const real = await getAccountControl(reference, word);
    const realEvidence = await getPublicationEvidence(status, word);
    const missing = { ...reference, account: 9001 };
    const absent = await getAccountControl(missing, word);
    const error = await getPublicationEvidence(
      { ...status, account_control: missing },
      word,
    ).then(
      () => null,
      (error: Error) => error.message,
    );
    return { real, absent, realEvidence, error };
  }, serverFixture().words.ckusro);
  expect(result.error).toBe(
    "The publication refers to missing account evidence.",
  );
  expect(result.real).toMatchObject({ state: "unclaimed", row_present: true });
  expect(result.absent).toMatchObject({
    state: "unclaimed",
    row_present: false,
  });
  expect(result.realEvidence.witness_contributions).toEqual([]);
});

test("word statuses must match all returned definitions in event ID order", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async (id) => {
    const { getWord, validateWord } = await import(String("/src/data/api.ts"));
    const word = await getWord(id);
    const statuses = word.statuses;
    const mismatch = {
      ...statuses[0],
      event: "jve1:" + "0".repeat(64),
    };
    const mutations = [
      statuses.slice(1),
      [...statuses, statuses[0]],
      [mismatch, ...statuses.slice(1)],
      [statuses[0], statuses[0], ...statuses.slice(2)],
      [...statuses].reverse(),
    ];
    const invalid = mutations.map((statuses) => {
      try {
        validateWord({ ...word, statuses }, id);
        return false;
      } catch {
        return true;
      }
    });
    return { invalid, count: statuses.length };
  }, serverFixture().words.cukta);
  expect(result.count).toBeGreaterThan(1);
  expect(result.invalid).toEqual([true, true, true, true, true]);
});
