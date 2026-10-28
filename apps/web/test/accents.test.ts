import { test, expect, type Page } from "@playwright/test";
import {
  corePath,
  createIdentity,
  acceptFirstSignature,
  PASSPHRASE,
} from "./helpers.ts";

async function seedName(
  page: Page,
  spelling: string,
  kind: "cmevla" | "lujvo" = "cmevla",
) {
  await page.goto("/new/meaning");
  const seeded = await page.evaluate(
    async ({ corePath, spelling, kind }) => {
      const core = await import(corePath);
      await core.initializeCore();
      const record = core.createEvent(
        new Uint8Array(32).fill(94),
        [],
        Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
        {
          kind: "definition.publish",
          word: core.wordId({ language: "jbo", spelling }),
          language: "en",
          parents: [],
          origin: "native",
        },
        {
          word: { language: "jbo", spelling },
          language: "en",
          text: [["A synthetic accented name."]],
          classification: { kind },
          license: { expression: "CC0-1.0" },
        },
      );
      const response = await fetch("/api/v1/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      });
      if (!response.ok) throw new Error(await response.text());
      return {
        event: record.envelope.id,
        word: record.envelope.header.action.word,
      };
    },
    { corePath, spelling, kind },
  );
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/v1/words/${seeded.word}`);
      return (
        response.ok() &&
        (await response.json()).definitions.includes(seeded.event)
      );
    })
    .toBe(true);
  return seeded;
}
async function download(page: Page) {
  await page.goto("/preferences");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(
    "The English search package is saved in this browser.",
  );
}
async function typed(page: Page, spelling: string) {
  await page.goto("/new/meaning");
  await page
    .getByRole("textbox", { name: "Meaning", exact: true })
    .fill("A synthetic name definition.");
  await page
    .getByRole("textbox", { name: "Lojban word", exact: true })
    .fill(spelling);
}

test("reader and both search modes show acute names through plain identity", async ({
  page,
}) => {
  const seeded = await seedName(page, "ĺénan");
  for (const query of ["lenan", "ĺénan"]) {
    const response = await page.request.get(
      `/api/v1/search?q=${encodeURIComponent(query)}&language=en`,
    );
    const result = await response.json();
    expect(result.hits[0].word_id).toBe(seeded.word);
    expect(result.hits[0].word.spelling).toBe("ĺénan");
  }
  await page.goto("/word/lenan?lang=en");
  await expect(
    page.getByRole("heading", { name: "ĺénan", exact: true }),
  ).toBeVisible();
  await expect(page.locator("article.definition")).toContainText("ĺénan");
  await page.goto(`/definition/${encodeURIComponent(seeded.event)}`);
  await expect(
    page.getByRole("heading", { name: "ĺénan", exact: true }),
  ).toBeVisible();
  await download(page);
  for (const query of ["lenan", "ĺénan", "l\u0301e\u0301nan"]) {
    await page.goto(`/search?q=${encodeURIComponent(query)}&lang=en`);
    await expect(
      page
        .getByRole("region", { name: "Search results" })
        .getByRole("link", { name: "ĺénan", exact: true }),
    ).toBeVisible();
  }
  await typed(page, "lenan");
  await expect(
    page.getByRole("region", { name: "Typed word", exact: true }),
  ).toContainText("Already exists");
  await page
    .getByRole("textbox", { name: "Lojban word", exact: true })
    .fill("ĺénan");
  await expect(
    page.getByRole("region", { name: "Typed word", exact: true }),
  ).toContainText("Already exists");
});

test("uppercase and decomposed acute name input stays visible through wizard publication and revision", async ({
  page,
}) => {
  await createIdentity(page);
  const spelling = "M\u0301A'AN";
  await typed(page, spelling);
  await expect(
    page.getByRole("region", { name: "Typed word", exact: true }),
  ).toContainText("Detected form: cmevla");
  await page.getByRole("button", { name: "New word", exact: true }).click();
  await expect(page.getByRole("radio", { name: /^cmevla/ })).toBeChecked();
  await page
    .getByRole("button", { name: "Enter the form", exact: true })
    .click();
  await expect(page.getByLabel("Spelling", { exact: true })).toHaveValue(
    spelling,
  );
  await page.getByRole("button", { name: /^Use / }).click();
  await page
    .getByLabel("Definition text", { exact: true })
    .fill("A synthetic signed name.");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true })
    .click();
  const unlock = page.getByRole("dialog", { name: "Unlock your key" });
  if (await unlock.isVisible()) {
    await unlock.getByLabel("Passphrase").fill(PASSPHRASE);
    await unlock.getByRole("button", { name: "Unlock", exact: true }).click();
  }
  await acceptFirstSignature(page);
  await expect(page).toHaveURL(/\/word\//);
  await expect(
    page.getByRole("heading", { name: "ḾA'AN", exact: true }),
  ).toBeVisible();
  const published = await page.evaluate(async (corePath) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const core = await import(corePath);
    const rows: any[] = await new LocalStore().list("outbox");
    const record = rows
      .map((row) => JSON.parse(row.transport))
      .find((row) => row.envelope.header.action.kind === "definition.publish");
    return {
      event: record.envelope.id,
      body: record.body,
      plain: core.wordId({ language: "jbo", spelling: "MA'AN" }),
      word: record.envelope.header.action.word,
    };
  }, corePath);
  expect(published.body.word.spelling).toBe("ḾA'AN");
  expect(published.word).toBe(published.plain);
  await page.goto(`/new/editor?revise=${encodeURIComponent(published.event)}`);
  await expect(page.getByLabel("Headword", { exact: true })).toHaveValue(
    "ḾA'AN",
  );
});

test("zei linking preserves accented name sources and rejects acute gismu", async ({
  page,
}) => {
  await createIdentity(page);
  await seedName(page, "dján");
  await download(page);
  await typed(page, "dján zei blanu");
  await page.getByRole("button", { name: "New word", exact: true }).click();
  await page
    .getByRole("button", { name: "Link the lujvo parts", exact: true })
    .click();
  await expect(
    page.getByLabel("Form dján zei blanu", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Exact definition of dján", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Use dján zei blanu", exact: true })
    .click();
  await page
    .getByLabel("Definition text", { exact: true })
    .fill("A synthetic named compound.");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(
    page.locator("aside").getByRole("button", { name: "Publish", exact: true }),
  ).toBeEnabled();
  await page.goto("/new/editor");
  await page.getByLabel("Headword", { exact: true }).fill("blánu");
  await page.getByLabel("Type", { exact: true }).selectOption("gismu");
  await expect(
    page.getByRole("status", { name: "Word form", exact: true }),
  ).toContainText("Acute accents are allowed only on cmevla");
});

test("ordinary component entry keeps name accents and handles invalid accented queries", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await seedName(page, "dján");
  await download(page);
  await page.goto("/new/meaning");
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { newDraft } = await import(String("/src/model/draft.ts"));
    await new LocalStore().put(
      "drafts",
      "current",
      newDraft({
        kind: "lujvo",
        meaning: "A synthetic compound.",
        text: [["A synthetic compound."]],
      }),
    );
  });
  await page.goto("/new/lujvo");
  const field = page.getByLabel("Add a part", { exact: true });
  const matches = page.getByRole("list", { name: "Matching words" });
  await field.fill("\u0301djan");
  await expect(
    matches.getByRole("button", { name: "Add dján", exact: true }),
  ).toBeVisible();
  await expect(matches).not.toContainText("not in the local package");
  await field.fill("blánu");
  await expect(
    matches.getByRole("button", { name: "Add dján", exact: true }),
  ).toHaveCount(0);
  await expect(matches).not.toContainText("not in the local package");
  await field.fill("ḿark");
  await matches
    .getByRole("button", { name: "Add ḿark as entered", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        return (await new LocalStore().get("drafts", "current"))?.lujvo
          ?.components?.[0]?.spelling;
      }),
    )
    .toBe("ḿark");
  expect(errors).toEqual([]);
});

test("R2 automatic component entry normalizes accent aliases and reports the plain compound as taken", async ({
  page,
}) => {
  await seedName(page, "dzan zei blanu", "lujvo");
  await download(page);
  await page.goto("/new/meaning");
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { newDraft } = await import(String("/src/model/draft.ts"));
    await new LocalStore().put(
      "drafts",
      "current",
      newDraft({
        kind: "lujvo",
        meaning: "Synthetic compound.",
        text: [["Synthetic compound."]],
      }),
    );
  });
  await page.goto("/new/lujvo");
  await page.getByLabel("Add a part", { exact: true }).fill(".DŹÁN.");
  await page
    .getByRole("button", { name: "Add dźán as entered", exact: true })
    .click();
  await page.getByLabel("Add a part", { exact: true }).fill("blanu");
  await page
    .getByRole("button", { name: /^Add blanu(?: as entered)?$/ })
    .click();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        return (await new LocalStore().get("drafts", "current"))?.lujvo
          ?.components?.length;
      }),
    )
    .toBe(2);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const draft = await store.get("drafts", "current");
    if (draft.lujvo.components[0].spelling !== "dźán")
      throw new Error("Entered component was not normalized.");
    draft.lujvo.joins = [" zei "];
    await store.put("drafts", "current", draft);
  });
  await page.reload();
  await expect(
    page.getByLabel("Form dźán zei blanu", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Taken:" }),
  ).toContainText("dźán zei blanu is defined in the local package");
});

test("R2 restored accented source keeps its exact-definition selector", async ({
  page,
}) => {
  const plain = await seedName(page, "djan");
  const marked = await seedName(page, "dján");
  await download(page);
  await page.evaluate(async (corePath) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { newDraft, draftToBody, draftFromBody } = await import(
      String("/src/model/draft.ts")
    );
    const {
      changeTypedWord,
      prepareLujvoBuilder,
      buildLujvoState,
      selectLujvoCandidate,
    } = await import(String("/src/model/typed-headword.ts"));
    const { interpretDefinition } = await import(corePath);
    const store = new LocalStore();
    const cached = await store.get("packages", "en");
    cached.entries.sort(
      (a: any, b: any) =>
        Number(a.word.spelling === "dján") - Number(b.word.spelling === "dján"),
    );
    await store.put("packages", "en", cached);
    const draft = newDraft({
      kind: "lujvo",
      spelling: "dján zei blanu",
      text: [["Synthetic compound."]],
    });
    changeTypedWord(draft, draft.spelling);
    const state = prepareLujvoBuilder(draft, cached);
    const built = buildLujvoState(state);
    selectLujvoCandidate(draft, built, built.candidates[0], true);
    const restored = draftFromBody(
      interpretDefinition(draftToBody(draft).body),
      "jve1:" + "c".repeat(64),
      "native",
    );
    await store.put("drafts", "current", restored);
  }, corePath);
  await page.goto("/new/lujvo");
  const choices = page.getByLabel("Exact definition of dján", { exact: true });
  await expect(choices).toBeVisible();
  await expect(choices.locator(`option[value="${plain.event}"]`)).toHaveCount(
    1,
  );
  await expect(choices.locator(`option[value="${marked.event}"]`)).toHaveCount(
    1,
  );
  await choices.selectOption(plain.event);
  await choices.selectOption(marked.event);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        return (await new LocalStore().get("drafts", "current"))?.lujvo
          ?.components?.[0]?.definition;
      }),
    )
    .toBe(marked.event);
  await page.reload();
  await expect(choices).toHaveValue(marked.event);
});

test("R2 rafsi pages group name displays and publish plain claim sources without self-conflicts", async ({
  page,
}) => {
  await createIdentity(page);
  const plain = await seedName(page, "djans");
  await seedName(page, "djáns");
  const claim = await page.evaluate(
    async ({ corePath }) => {
      const core = await import(corePath);
      const word = { language: "jbo" as const, spelling: "djans" };
      const id = core.wordId(word);
      const record = core.createEvent(
        new Uint8Array(32).fill(95),
        [],
        "f".repeat(32),
        {
          kind: "rafsi.publish",
          word: id,
          assignment: core.rafsiPairId(id, "dzaz"),
          origin: "native",
        },
        { word, rafsi: "dzaz", rationale: [], sources: [], legacy: null },
      );
      const response = await fetch("/api/v1/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      });
      if (!response.ok) throw new Error(await response.text());
      return record.envelope.id;
    },
    { corePath },
  );
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/v1/words/${plain.word}`);
      return response.ok() && (await response.json()).rafsi.includes(claim);
    })
    .toBe(true);
  await download(page);
  await page.goto("/rafsi/dzaz");
  await expect(page.locator("section.definition")).toHaveCount(1);
  await page.goto("/claim/dj%C3%A1ns");
  await page.getByLabel("Rafsi spelling").fill("dzáz");
  await page.getByRole("button", { name: "Check claims and preview" }).click();
  await expect(page.getByRole("status")).toContainText("without acute accents");
  await page.getByLabel("Rafsi spelling").fill("dzaz");
  await page.getByRole("button", { name: "Check claims and preview" }).click();
  await expect(
    page.getByText(/No retained claim of dzaz for another word/),
  ).toBeVisible();
  await expect(page.getByText(/Conflict: dzaz/)).toHaveCount(0);
  await page
    .getByRole("button", { name: "Sign and publish the claim" })
    .click();
  const unlock = page.getByRole("dialog", { name: "Unlock your key" });
  if (await unlock.isVisible()) {
    await unlock.getByLabel("Passphrase").fill(PASSPHRASE);
    await unlock.getByRole("button", { name: "Unlock", exact: true }).click();
  }
  await acceptFirstSignature(page);
  await expect(page).toHaveURL(/\/word\//);
  const record = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return (await new LocalStore().list("outbox"))
      .map((row: any) => JSON.parse(row.transport))
      .find((row: any) => row.envelope.header.action.kind === "rafsi.publish");
  });
  expect(record.body.word.spelling).toBe("djans");
  expect(record.body.rafsi).toBe("dzaz");
});

test("R2 experimental name feedback permits unknown names and blocks a wrong recognized type accurately", async ({
  page,
}) => {
  await page.goto("/new/editor");
  await page.getByLabel("Type", { exact: true }).selectOption("cmevla");
  await page.getByLabel("Headword", { exact: true }).fill("dján smit");
  await page.getByLabel("Labels", { exact: true }).fill("experimental");
  const feedback = page.getByRole("status", { name: "Word form", exact: true });
  await expect(feedback).toContainText(
    "The experimental label permits this classification.",
  );
  await expect(feedback).not.toContainText("Acute accents are allowed only");
  await page.getByLabel("Headword", { exact: true }).fill("dján");
  await page.getByLabel("Type", { exact: true }).selectOption("gismu");
  await expect(feedback).toContainText(
    "Acute name stress requires the cmevla type",
  );
  await expect(feedback).not.toContainText("permits this classification");
});

test("R2 zbalermorna renders accented names in word and search views", async ({
  page,
}) => {
  await seedName(page, "dján");
  await download(page);
  await page
    .getByLabel("Lojban orthography beside headwords")
    .selectOption("zbalermorna");
  await page.goto("/word/djan?lang=en");
  await expect(page.locator(".word-head .zbalermorna")).toBeVisible();
  await page.goto("/search?q=djan&lang=en");
  await expect(
    page
      .locator("article.hit")
      .filter({ has: page.getByRole("link", { name: "dján", exact: true }) })
      .locator(".zbalermorna"),
  ).toBeVisible();
});
