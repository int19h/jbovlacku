import { test, expect } from "@playwright/test";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { importSqlSnapshot } from "../../../packages/importer/src/sql.ts";
import {
  initializeCore,
  contentHash,
  utf8,
} from "../../../packages/core/src/index.ts";
import {
  importCapture,
  EXTRACTION,
} from "../../../packages/importer/src/index.ts";
import { admit } from "./seed.ts";
import { fixture } from "./helpers.ts";

test("imported places, official rafsi, source name and source date reach word and search pages", async ({
  page,
}) => {
  await initializeCore(
    await readFile("packages/core/generated/jvc_runtime_bg.wasm"),
  );
  const sourceBytes = utf8(
    JSON.stringify({
      definitions: [
        {
          definitionid: 89991,
          langid: 2,
          valsiword: "fildycku",
          type_name: "lujvo",
          selmaho: null,
          definition: "$x_{1}$ is a fidelity test book containing $x_{3}$.",
          notes: "Quoted g_1 and x_2 remain source notes.",
          etymology: null,
          jargon: null,
          user_id: 89992,
          username: "fidelity source author",
          time: 1046655416,
          created_at: "2026-01-01T00:00:00Z",
          official_rafsi: "fid",
          experimental_rafsi: "fai",
        },
      ],
    }),
  );
  const imported = importCapture({
    sourceBytes,
    manifest: {
      source: "https://lensisku.lojban.org",
      url: "https://lensisku.lojban.org/api/jbovlaste/definitions/list",
      retrieved_at: "2026-10-01T00:00:00Z",
      sha256: contentHash(sourceBytes),
      extraction: EXTRACTION,
      recipe: "lensisku-definitions-list-v1",
      unavailable_fields: [],
    },
    seed: new Uint8Array(32).fill(149),
    roots: [],
  });
  expect(imported.report.incomplete).toBe(false);
  expect(
    imported.journal.entries["89991"].versions[0].carrier.body.legacy
      .attribution.dates.time,
  ).toBe("1046655416");
  await admit(
    fixture().origin,
    imported.carriers,
    imported.view,
    imported.selection.canonical,
  );
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/v1/words/${String(imported.journal.entries["89991"].versions[0].carrier.envelope.header.action.word)}?view=${imported.view.envelope.id}`,
        );
        if (!response.ok()) return false;
        const word = await response.json();
        return (
          word.definitions?.includes(
            imported.journal.entries["89991"].selected,
          ) === true
        );
      },
      { timeout: 30000 },
    )
    .toBe(true);
  await page.goto("/search");
  await page.evaluate(async (view) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().setPreferences({
      view,
      searchMode: "remote",
      useAiAssistance: false,
    });
  }, imported.view.envelope.id);
  await page.goto("/word/fildycku?lang=en");
  const definition = page
    .locator("article.definition")
    .filter({ hasText: "fidelity source author" });
  await expect(definition).toBeVisible();
  await expect(definition.locator(".prose").first()).not.toContainText("$x_");
  await expect(
    definition
      .locator(".prose")
      .first()
      .getByRole("link", { name: "place 1", exact: true }),
  ).toBeVisible();
  await expect(
    definition
      .locator(".prose")
      .first()
      .getByRole("link", { name: "place 3", exact: true }),
  ).toBeVisible();
  await expect(definition.locator(".byline")).toContainText("Mar 2003");
  await expect(
    page.locator(".rafsi-line").getByRole("link", { name: "fid", exact: true }),
  ).toBeVisible();
  await definition.getByText("Source", { exact: true }).click();
  await expect(definition).toContainText(
    "$x_{1}$ is a fidelity test book containing $x_{3}$.",
  );
  await page.goto("/search?q=fildycku&lang=en");
  const row = page
    .locator("article.hit")
    .filter({ hasText: "fildycku" })
    .first();
  await expect(row.locator(".rafsi")).toContainText("fid");
  await expect(row.locator(".rafsi")).toContainText("fai");
  await expect(row).toContainText("fidelity source author");
  await expect(row).toContainText("Mar 2003");
  await expect(
    row.getByRole("img", { name: "place 1", exact: true }),
  ).toBeVisible();
});

test("SQL imported definitions show exact original text in the Source disclosure", async ({
  page,
}) => {
  await initializeCore(
    await readFile("packages/core/generated/jvc_runtime_bg.wasm"),
  );
  const parent = process.env.JVC_TEST_ROOT!;
  await mkdir(parent, { recursive: true });
  const output = await mkdtemp(join(parent, "sql-disclosure-"));
  try {
    await importSqlSnapshot({
      sourcePath: "packages/importer/fixtures/lensisku-sql-sample.sql",
      manifestPath:
        "packages/importer/fixtures/lensisku-sql-sample.manifest.json",
      output,
      seed: new Uint8Array(32).fill(150),
      roots: [],
    });
    const records = (await readFile(join(output, "carriers.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const view = JSON.parse(
      await readFile(join(output, "selected-view.json"), "utf8"),
    );
    const selection = await readFile(
      join(output, "import-selection.json"),
      "utf8",
    );
    const definition = records.find(
      (item) =>
        item.envelope.header.action.kind === "definition.publish" &&
        item.body.legacy.record.id === 4,
    );
    await admit(fixture().origin, records, view, selection);
    await expect
      .poll(async () => {
        const response = await page.request.get(
          `/api/v1/words/${definition.envelope.header.action.word}?view=${view.envelope.id}`,
        );
        return (
          response.ok() &&
          (await response.json()).definitions.includes(definition.envelope.id)
        );
      })
      .toBe(true);
    await page.goto("/search");
    await page.evaluate(async (id) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      await new LocalStore().setPreferences({
        view: id,
        searchMode: "remote",
        useAiAssistance: false,
      });
    }, view.envelope.id);
    await page.goto("/word/bajra?lang=en");
    const article = page
      .locator("article.definition")
      .filter({
        has: page.locator(`#def-${definition.envelope.id.slice(5, 17)}`),
      });
    await expect(article.locator(".prose").first()).not.toContainText("$x_");
    await article.getByText("Source", { exact: true }).click();
    await expect(
      article.locator("p").filter({ hasText: "Original text:" }),
    ).toHaveText(
      `Original text: ${definition.body.legacy.original.definitions.definition}`,
    );
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
