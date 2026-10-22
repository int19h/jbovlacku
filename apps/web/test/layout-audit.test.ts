import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fixture, PASSPHRASE } from "./helpers.ts";
import { BROWSER_HEADERS } from "../../server/src/security.ts";

test.beforeAll(async () => {
  test.setTimeout(120000);
  await promisify(execFile)("npm", ["run", "build:web"], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    timeout: 90000,
  });
});

test.beforeEach(({ page }) => {
  page.on("dialog", (dialog) => void dialog.accept());
});

async function open(page: Page, path: string) {
  const response = await page.goto(`${fixture().origin}${path}`);
  expect(response?.headers()["content-security-policy"]).toBe(
    BROWSER_HEADERS["content-security-policy"],
  );
  await page.locator("main h1").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
}

async function beginDraft(page: Page, kind?: "lujvo" | "gismu") {
  await open(page, "/new/meaning");
  await page
    .getByLabel("Meaning", { exact: true })
    .fill("___ is a book for ___.");
  await page.getByRole("button", { name: "New word", exact: true }).click();
  await page.getByRole("heading", { name: "What kind of word?" }).waitFor();
  if (kind) {
    await page.locator(`[data-kind="${kind}"] input`).check();
    await page
      .getByRole("button", {
        name: kind === "lujvo" ? "Build the lujvo" : "Make a gismu",
        exact: true,
      })
      .click();
  }
}

async function populateGismu(page: Page) {
  for (const [name, value] of Object.entries({
    "Mandarin Chinese": "moku",
    Hindi: "kukurmutta",
    English: "macrum",
    Spanish: "ongo",
    Russian: "grip",
    Arabic: "futr",
  }))
    await page
      .getByLabel(`Scoring letters for ${name}`, { exact: true })
      .fill(value);
  await expect(
    page
      .getByRole("region", { name: "Candidates", exact: true })
      .getByRole("button", { name: /^Choose / })
      .first(),
  ).toBeVisible();
  await page
    .getByRole("region", { name: "Candidates", exact: true })
    .getByRole("button", { name: /^Choose / })
    .first()
    .click();
  await expect(
    page
      .getByRole("region", { name: "Selected form", exact: true })
      .locator("h2"),
  ).toBeVisible();
}

async function populatePlaces(page: Page) {
  await page
    .getByRole("button", { name: "+ Add a place", exact: true })
    .click();
  await page
    .getByLabel("Kind of thing for place 1", { exact: true })
    .selectOption("custom");
  await page
    .getByRole("button", { name: "Add an alternative", exact: true })
    .click();
}

async function preparePublish(page: Page) {
  await open(page, "/new/editor");
  await page.getByLabel("Headword", { exact: true }).fill("broda");
  await page.getByLabel("Type", { exact: true }).selectOption("other");
  await page
    .getByLabel("Definition text", { exact: true })
    .fill("A test definition.");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.locator(".preview-card")).toBeVisible();
}

async function expandDetails(page: Page) {
  for (let pass = 0; pass < 100; pass++) {
    const closed = page
      .locator("details:not([open]) > summary:visible")
      .first();
    if (!(await closed.count())) break;
    const toggled = closed.evaluate(
      (summary) =>
        new Promise<void>((resolve) => {
          summary.parentElement!.addEventListener("toggle", () => resolve(), {
            once: true,
          });
        }),
    );
    await closed.click();
    await toggled;
    await page.waitForLoadState("networkidle");
  }
}

async function artifact(
  info: TestInfo,
  name: string,
  value: unknown,
  page?: Page,
) {
  const phase = process.env.JVC_LAYOUT_PHASE ?? "layout";
  const stem = `${phase}-${name}`;
  const path = info.outputPath(`${stem}.json`);
  await writeFile(path, JSON.stringify(value, null, 2));
  await info.attach(stem, { path, contentType: "application/json" });
  const evidence = process.env.JVC_LAYOUT_EVIDENCE_DIR;
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await copyFile(path, resolve(evidence, `${stem}.json`));
  }
  if (page) {
    const shot = info.outputPath(`${stem}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    await info.attach(stem, { path: shot, contentType: "image/png" });
    if (evidence) await copyFile(shot, resolve(evidence, `${stem}.png`));
  }
}

async function inventory(page: Page) {
  return page.evaluate(() => {
    const path = (node: Element) => {
      const parts: string[] = [];
      for (
        let n: Element | null = node;
        n && n !== document.body;
        n = n.parentElement
      ) {
        parts.unshift(
          `${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : `:nth-child(${[...n.parentElement!.children].indexOf(n) + 1})`}`,
        );
      }
      return parts.join(" > ");
    };
    const rect = (node: Element) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y + scrollY, width: r.width, height: r.height };
    };
    const entries = [];
    for (const node of document.querySelectorAll<HTMLElement>(
      'button,input:not([type="hidden"]),select,textarea,a[href],summary,[role="button"],[role="switch"],[tabindex]:not([tabindex^="-"]),[contenteditable="true"]',
    )) {
      let target: HTMLElement = node;
      let exception: string | null = null;
      let labelTarget = false;
      if (
        node instanceof HTMLInputElement &&
        ["checkbox", "radio"].includes(node.type)
      ) {
        target = node.labels?.[0] ?? node;
        labelTarget = target !== node;
      }
      const style = getComputedStyle(target);
      if (
        !target.getClientRects().length ||
        style.visibility === "hidden" ||
        style.display === "none"
      )
        continue;
      if (node.matches("a.pl"))
        exception = "Inline place marker: ui-design.md shared components.";
      else if (
        node.matches("a[href]") &&
        !node.matches(".btn") &&
        !node.closest("header,footer,nav")
      ) {
        const prose = node.closest("p,.rich-text,.text");
        if (
          prose &&
          [...prose.childNodes].some(
            (sibling) =>
              sibling !== node &&
              !(sibling instanceof Element && sibling.matches("a,button")) &&
              /[a-z]{2}/i.test(sibling.textContent ?? ""),
          )
        ) {
          exception =
            "Link within running prose: ui-design.md inline exception.";
        }
      }
      entries.push({
        element: node.tagName.toLowerCase(),
        type: node.getAttribute("type"),
        role: node.getAttribute("role"),
        name: (
          (node.getAttribute("aria-label") ??
            (node instanceof HTMLInputElement
              ? [...(node.labels ?? [])].map((l) => l.textContent).join(" ")
              : "")) ||
          node.textContent ||
          node.getAttribute("title") ||
          ""
        )
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 180),
        path: path(node),
        href: node.getAttribute("href"),
        disabled: node.matches(":disabled"),
        elementBounds: rect(node),
        targetBounds: rect(target),
        labelTarget,
        exception,
      });
    }
    return {
      url: location.href,
      viewport: { width: innerWidth, height: innerHeight },
      pageWidth: document.documentElement.scrollWidth,
      entries,
    };
  });
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone", width: 360, height: 800 },
]) {
  test.describe(viewport.name, () => {
    test.use({ viewport });

    test("F2 and Grok3: Meaning and Type use the specified column gap", async ({
      page,
    }, info) => {
      await open(page, "/new/meaning");
      expect
        .soft(
          await page
            .locator("main > .two-col")
            .evaluate((node) => getComputedStyle(node).columnGap),
          "Meaning gap",
        )
        .toBe("40px");
      await beginDraft(page);
      expect
        .soft(
          await page
            .locator("main > .two-col")
            .evaluate((node) => getComputedStyle(node).columnGap),
          "Type gap",
        )
        .toBe("40px");
      await artifact(
        info,
        `gaps-${viewport.name}`,
        await page.locator("main > .two-col").evaluate((node) => ({
          columnGap: getComputedStyle(node).columnGap,
        })),
        page,
      );
    });

    test("F3: the selected gismu uses the specified builder type scale", async ({
      page,
    }, info) => {
      await beginDraft(page, "gismu");
      await populateGismu(page);
      const form = page
        .getByRole("region", { name: "Selected form", exact: true })
        .locator("h2");
      const styles = await form.evaluate((node) => {
        const s = getComputedStyle(node);
        return {
          size: s.fontSize,
          weight: s.fontWeight,
          line: s.lineHeight,
          spacing: s.letterSpacing,
        };
      });
      await artifact(info, `gismu-type-${viewport.name}`, styles, page);
      expect.soft(styles.size).toBe("44px");
      expect.soft(styles.weight).toBe("680");
      expect.soft(parseFloat(styles.line)).toBeCloseTo(48.4, 1);
      expect.soft(parseFloat(styles.spacing)).toBeCloseTo(-1.1, 2);
    });

    test("the publication preview uses the word heading type scale", async ({
      page,
    }, info) => {
      await beginDraft(page);
      await preparePublish(page);
      const heading = page.locator(".preview-card p[lang=jbo]").first();
      const styles = await heading.evaluate((node) => {
        const s = getComputedStyle(node);
        return {
          size: s.fontSize,
          weight: s.fontWeight,
          line: s.lineHeight,
          spacing: s.letterSpacing,
        };
      });
      await artifact(info, `publish-type-${viewport.name}`, styles, page);
      expect.soft(styles.size).toBe("44px");
      expect.soft(styles.weight).toBe("680");
      expect.soft(parseFloat(styles.line)).toBeCloseTo(48.4, 1);
      expect.soft(parseFloat(styles.spacing)).toBeCloseTo(-1.1, 2);
    });

    test("F4 F5 and Grok1: each alternative keeps its hint beside Tags and controls fit their rows", async ({
      page,
    }, info) => {
      await beginDraft(page);
      await open(page, "/new/places");
      await populatePlaces(page);
      const rows = [];
      for (const index of [1, 2]) {
        const tags = page.getByLabel(`Tags for alternative ${index}`, {
          exact: true,
        });
        const group = page.getByRole("group", {
          name: `Alternative ${index}`,
          exact: true,
        });
        await expect(group).toBeVisible();
        const hintId = await tags.getAttribute("aria-describedby");
        const hint = page.locator(`[id="${hintId}"]`);
        const controls = [
          tags,
          page.getByLabel(`Abstractor for alternative ${index}`, {
            exact: true,
          }),
          page.getByLabel(`Relation arity for alternative ${index}`, {
            exact: true,
          }),
          page.getByLabel(`Count for alternative ${index}`, { exact: true }),
          page.getByRole("button", {
            name: `Remove alternative ${index}`,
            exact: true,
          }),
        ];
        const boxes = await Promise.all(
          controls.map(async (control) => (await control.boundingBox())!),
        );
        const groupBox = (await group.boundingBox())!;
        for (const box of boxes) {
          expect
            .soft(box.x, `Alternative ${index} control stays inside its group`)
            .toBeGreaterThanOrEqual(groupBox.x);
          expect
            .soft(
              box.x + box.width,
              `Alternative ${index} control stays inside its group`,
            )
            .toBeLessThanOrEqual(groupBox.x + groupBox.width);
        }
        const hintBox = (await hint.boundingBox())!;
        rows.push({ index, boxes, hint: hintBox });
        expect
          .soft(hintBox.y, `Alternative ${index} hint follows its Tags input`)
          .toBeGreaterThanOrEqual(boxes[0].y + boxes[0].height);
        expect
          .soft(
            hintBox.y - boxes[0].y - boxes[0].height,
            `Alternative ${index} hint is adjacent to Tags`,
          )
          .toBeLessThanOrEqual(8);
        expect
          .soft(await hint.evaluate((node) => getComputedStyle(node).fontSize))
          .toBe("13px");
        if (viewport.width === 360) {
          for (let i = 1; i < boxes.length; i++) {
            expect
              .soft(
                boxes[i].y,
                `Alternative ${index} control ${i} stacks below the preceding control`,
              )
              .toBeGreaterThanOrEqual(boxes[i - 1].y + boxes[i - 1].height + 4);
          }
          expect
            .soft(boxes[1].y)
            .toBeGreaterThanOrEqual(hintBox.y + hintBox.height + 4);
          if (index === 1) {
            const next = (await page
              .getByLabel("Tags for alternative 2", { exact: true })
              .boundingBox())!;
            expect
              .soft(hintBox.y - boxes[0].y - boxes[0].height)
              .toBeLessThan(next.y - hintBox.y - hintBox.height);
          }
        } else {
          for (const box of boxes.slice(1, 4))
            expect
              .soft(
                Math.abs(box.y - boxes[0].y),
                `Alternative ${index} input alignment`,
              )
              .toBeLessThan(1);
          const remove = boxes[4];
          const sameLine = boxes
            .slice(0, 4)
            .filter((box) => Math.abs(box.y - remove.y) < box.height);
          if (sameLine.length)
            for (const box of sameLine)
              expect
                .soft(
                  Math.abs(box.y + box.height - remove.y - remove.height),
                  `Alternative ${index} removal alignment`,
                )
                .toBeLessThan(1);
          else
            expect
              .soft(remove.y)
              .toBeGreaterThanOrEqual(
                Math.max(
                  ...boxes.slice(0, 4).map((box) => box.y + box.height),
                ) + 4,
              );
        }
      }
      await artifact(info, `alternatives-${viewport.name}`, rows, page);
    });

    test("F1 and Grok2: every visible interactive target meets its measured size rule", async ({
      page,
    }, info) => {
      test.setTimeout(240000);
      const manifest: {
        state: string;
        count: number;
        exceptions: number;
        failures: number;
      }[] = [];
      const check = async (state: string) => {
        await page.waitForLoadState("networkidle");
        await page.evaluate(() => document.fonts.ready);
        const data = await inventory(page);
        const failures = data.entries.filter(
          (entry) =>
            !entry.exception &&
            (entry.targetBounds.width < 43.99 ||
              entry.targetBounds.height < 43.99),
        );
        manifest.push({
          state,
          count: data.entries.length,
          exceptions: data.entries.filter((e) => e.exception).length,
          failures: failures.length,
        });
        await artifact(info, `targets-${state}-${viewport.name}`, data, page);
        expect
          .soft(data.entries.length, `${state} has a nonempty target inventory`)
          .toBeGreaterThan(8);
        expect
          .soft(
            failures.map(
              (entry) =>
                `${entry.element} ${entry.name}: ${entry.targetBounds.width.toFixed(2)} x ${entry.targetBounds.height.toFixed(2)}`,
            ),
            `${state}: measured standalone targets must be at least 44 by 44`,
          )
          .toEqual([]);
        expect
          .soft(data.pageWidth, `${state} fits the viewport`)
          .toBeLessThanOrEqual(viewport.width);
      };
      await open(page, "/search?q=cukta");
      await expect(
        page.getByRole("region", { name: "Search results" }),
      ).toContainText("cukta");
      await expandDetails(page);
      await check("search-expanded");
      await open(page, `/word/${fixture().words.cukta}`);
      await expect(page.locator("article.definition").first()).toBeVisible();
      await expandDetails(page);
      await check("word-expanded");
      await page.getByRole("button", { name: /copy/i }).first().click();
      await check("word-copy");
      await open(page, "/preferences");
      await expandDetails(page);
      await check("preferences");
      await page.getByRole("button", { name: "Download", exact: true }).click();
      await expect(page.getByRole("status")).toContainText(
        "saved in this browser",
      );
      await open(page, "/identity");
      await expandDetails(page);
      await check("identity-new");
      await page.getByLabel("New passphrase", { exact: true }).fill(PASSPHRASE);
      await page.getByLabel("Repeat passphrase").fill(PASSPHRASE);
      await page
        .getByRole("button", { name: "Create a key", exact: true })
        .click();
      await expect(page.getByText("Unlocked", { exact: true })).toBeVisible();
      await expandDetails(page);
      await check("identity-unlocked");
      await page.getByRole("button", { name: "Lock", exact: true }).click();
      await expect(page.getByText("Locked", { exact: true })).toBeVisible();
      await check("identity-locked");
      await page.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
      await page.getByRole("button", { name: "Unlock", exact: true }).click();
      await expect(page.getByText("Unlocked", { exact: true })).toBeVisible();
      await open(
        page,
        `/identity/${encodeURIComponent(fixture().identities.author)}`,
      );
      await page
        .getByRole("button", { name: "Trust their judgments", exact: true })
        .click();
      await page
        .getByRole("button", {
          name: "limit by language, word, or rafsi",
          exact: true,
        })
        .click();
      await check("person-scope");
      await page.getByRole("button", { name: "Trust", exact: true }).click();
      await open(page, "/trust");
      await expandDetails(page);
      await check("trust-expanded");
      await open(page, `/word/${fixture().words.cukta}`);
      await page.route("**/api/v1/events", (route) =>
        route.fulfill({
          status: 503,
          json: {
            code: "unavailable",
            message: "Layout test delivery is unavailable.",
            event: null,
            field: null,
          },
        }),
      );
      await page
        .locator("article.definition")
        .first()
        .getByRole("button", { name: "Endorse", exact: true })
        .click();
      await page.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
      await page.getByRole("button", { name: "Unlock", exact: true }).click();
      const firstSignature = page.getByRole("dialog", {
        name: "Before your first public signature",
      });
      await firstSignature
        .getByRole("button", { name: "Continue", exact: true })
        .click();
      await expect(
        page.getByRole("link", { name: /not delivered/ }),
      ).toBeVisible();
      await open(page, "/outbox");
      await expandDetails(page);
      await check("outbox-unfinished");
      await page
        .getByRole("button", { name: "Stop retrying", exact: true })
        .first()
        .click();
      await expect(
        page.getByRole("button", { name: "Try now", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.locator("summary").filter({ hasText: "1 stopped" }),
      ).toBeVisible();
      await expandDetails(page);
      await expect(
        page.getByRole("button", { name: "Resume delivery", exact: true }),
      ).toBeVisible();
      await check("outbox-stopped");
      await open(page, "/about");
      await check("about");
      await beginDraft(page);
      await open(page, "/new/meaning");
      await check("meaning-nearby");
      await page.getByRole("button", { name: "New word", exact: true }).click();
      await page.getByRole("heading", { name: "What kind of word?" }).waitFor();
      await check("type");
      await page.locator('[data-kind="lujvo"] input').check();
      await page
        .getByRole("button", { name: "Build the lujvo", exact: true })
        .click();
      for (const word of ["cukta", "sinxa"]) {
        await page.getByLabel("Add a part", { exact: true }).fill(word);
        await page
          .getByRole("button", {
            name: word === "cukta" ? "Add cukta" : "Add sinxa as entered",
            exact: true,
          })
          .click();
      }
      await expect(
        page.getByRole("region", { name: "Result", exact: true }),
      ).toContainText("ckusinxa");
      await expandDetails(page);
      await check("lujvo-two-parts");
      await open(page, "/new/gismu");
      await populateGismu(page);
      await expandDetails(page);
      await check("gismu-candidates");
      await page.getByLabel("Weights", { exact: true }).selectOption("custom");
      await check("gismu-custom");
      await open(page, "/new/places");
      await populatePlaces(page);
      await page
        .getByRole("button", {
          name: "Add a derivation for place 1",
          exact: true,
        })
        .click();
      await page.getByLabel("Add a gloss", { exact: true }).fill("book");
      await page.getByLabel("Add a gloss", { exact: true }).press("Enter");
      await expandDetails(page);
      await check("places-expanded");
      await open(page, "/new/editor");
      await expandDetails(page);
      await check("places-full-editor");
      await open(page, "/new/publish");
      await expandDetails(page);
      await check("publish");
      expect(manifest.length).toBe(20);
      await artifact(info, `manifest-${viewport.name}`, manifest);
    });
  });
}
