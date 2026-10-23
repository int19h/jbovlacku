import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fixture, PASSPHRASE } from "./helpers.ts";
import { BROWSER_HEADERS } from "../../server/src/security.ts";
import type { CachedPackage } from "../src/data/search.ts";

test.beforeAll(async () => {
  test.setTimeout(120000);
  await promisify(execFile)("npm", ["run", "build:web"], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    timeout: 90000,
  });
});

const policyViolations = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  page.on("dialog", (dialog) => void dialog.accept());
  const violations: string[] = [];
  policyViolations.set(page, violations);
  await page.exposeFunction(
    "recordLayoutPolicyViolation",
    (violation: string) => {
      violations.push(violation);
    },
  );
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      void (
        window as unknown as {
          recordLayoutPolicyViolation: (violation: string) => Promise<void>;
        }
      ).recordLayoutPolicyViolation(
        `${location.pathname}: ${event.effectiveDirective}: ${event.blockedURI}`,
      );
    });
  });
});

async function expectPolicyClean(page: Page) {
  // Deliver policy events before a navigation replaces the document.
  await page.evaluate(
    () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  );
  expect
    .soft(
      policyViolations.get(page),
      "No browser policy violations on any visited screen",
    )
    .toEqual([]);
}

test.afterEach(async ({ page }) => {
  await expectPolicyClean(page);
});

async function open(page: Page, path: string) {
  await expectPolicyClean(page);
  const response = await page.goto(`${fixture().origin}${path}`);
  expect(response?.headers()["content-security-policy"]).toBe(
    BROWSER_HEADERS["content-security-policy"],
  );
  await page.locator("main h1").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
}

async function createAuditIdentity(page: Page) {
  await open(page, "/identity");
  await page.getByLabel("New passphrase", { exact: true }).fill(PASSPHRASE);
  await page.getByLabel("Repeat passphrase").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Create a key", exact: true }).click();
  await expect(page.getByText("Unlocked", { exact: true })).toBeVisible();
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

async function addCompetingClaimFixture(page: Page) {
  // This synthetic browser fixture is not authenticated package evidence.
  // A third-party claim must conflict with both selected cku components.
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const request = indexedDB.open("jbovlacku-browser-v1", 3);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("packages", "readwrite");
          let claimants: string[] = [];
          tx.oncomplete = () => {
            db.close();
            resolve(claimants);
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
          tx.onabort = () => {
            db.close();
            reject(new Error("Fixture package update aborted."));
          };
          const store = tx.objectStore("packages");
          const get = store.get("en");
          get.onsuccess = () => {
            const pkg = get.result as CachedPackage;
            const entries = pkg?.entries.filter(
              (entry) => entry.word.spelling === "vlacku",
            );
            if (
              pkg?.version !== 2 ||
              !entries?.length ||
              entries.some((entry) => !("rafsi" in entry))
            ) {
              tx.abort();
              return;
            }
            for (const entry of entries) {
              const row = entry as CachedPackage["entries"][number] & {
                rafsi: string[];
              };
              row.rafsi = [...new Set([...row.rafsi, "cku"])].sort();
            }
            claimants = [
              ...new Set(
                pkg.entries
                  .filter(
                    (entry) =>
                      "rafsi" in entry &&
                      Array.isArray(entry.rafsi) &&
                      entry.rafsi.includes("cku"),
                  )
                  .map((entry) => entry.word.spelling),
              ),
            ].sort();
            store.put(pkg, "en");
          };
        };
      }),
  );
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

async function populatePlaces(page: Page, count = 2) {
  await page
    .getByRole("button", { name: "+ Add a place", exact: true })
    .click();
  await page
    .getByLabel("Kind of thing for place 1", { exact: true })
    .selectOption("custom");
  if (count === 2)
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
      let exceptionContainer: string | null = null;
      let exceptionSentence: string | null = null;
      let labelTarget = false;
      let labelAssociation: boolean | null = null;
      if (
        node instanceof HTMLInputElement &&
        ["checkbox", "radio"].includes(node.type)
      ) {
        target = node.labels?.[0] ?? node;
        labelTarget = target !== node;
        labelAssociation =
          node.labels?.length === 1 && node.labels[0].control === node;
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
        !node.matches(".btn,.touch-link") &&
        !node.closest("header,footer,nav")
      ) {
        const prose = node.closest("p,.rich-text,.text,.inline-prose");
        if (prose) {
          const before = document.createRange();
          before.selectNodeContents(prose);
          before.setEndBefore(node);
          const start = before.toString().length;
          const end = start + (node.textContent?.length ?? 0);
          const segments = new Intl.Segmenter("en", {
            granularity: "sentence",
          });
          // Ignore other links when identifying words around this link.
          const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
          let plainText = "";
          while (walker.nextNode()) {
            const text = walker.currentNode.textContent ?? "";
            plainText += walker.currentNode.parentElement?.closest("a,button")
              ? " ".repeat(text.length)
              : text;
          }
          for (const sentence of segments.segment(prose.textContent ?? "")) {
            if (
              sentence.index > start ||
              sentence.index + sentence.segment.length < end
            )
              continue;
            const surrounding = plainText.slice(
              sentence.index,
              sentence.index + sentence.segment.length,
            );
            // A metadata label or a separate sentence cannot supply prose.
            const afterLabel = surrounding.slice(
              surrounding.lastIndexOf(":") + 1,
            );
            if (
              /[.!?]["')\]]?\s*$/.test(sentence.segment) &&
              /[a-z]{2}/i.test(afterLabel) &&
              !/·/.test(surrounding)
            ) {
              exception =
                "Link within a sentence: ui-design.md inline exception.";
              exceptionContainer = path(prose);
              exceptionSentence = sentence.segment.trim();
            }
            break;
          }
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
        labelAssociation,
        exception,
        exceptionContainer,
        exceptionSentence,
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

async function checkTargets(
  page: Page,
  info: TestInfo,
  state: string,
  viewport: { name: string; width: number },
) {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await expectPolicyClean(page);
  const data = await inventory(page);
  const failures = data.entries.filter(
    (entry) =>
      !entry.exception &&
      (entry.targetBounds.width < 43.99 || entry.targetBounds.height < 43.99),
  );
  await artifact(info, `targets-${state}-${viewport.name}`, data, page);
  expect
    .soft(data.entries.length, `${state}: nonempty inventory`)
    .toBeGreaterThan(8);
  expect
    .soft(
      failures.map(
        (entry) =>
          `${entry.element} ${entry.name}: ${entry.targetBounds.width.toFixed(2)} x ${entry.targetBounds.height.toFixed(2)}`,
      ),
      `${state}: standalone targets must be at least 44 by 44`,
    )
    .toEqual([]);
  expect
    .soft(
      data.entries
        .filter((entry) => entry.labelAssociation === false)
        .map((entry) => entry.path),
      `${state}: each checkbox or radio has one label for its own control`,
    )
    .toEqual([]);
  expect
    .soft(data.pageWidth, `${state} fits the viewport`)
    .toBeLessThanOrEqual(viewport.width);
  return {
    state,
    count: data.entries.length,
    exceptions: data.entries.filter((entry) => entry.exception).length,
    failures: failures.length,
  };
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone", width: 360, height: 800 },
]) {
  test.describe(viewport.name, () => {
    test.use({ viewport });

    test("N1: the audit separates sentence links from labeled metadata and standalone actions", async ({
      page,
    }, info) => {
      await open(page, `/word/${fixture().words.cukta}`);
      await page.evaluate(() => {
        const samples = [
          ["sentence", "Read the ", "guide", " for details."],
          ["sentence-start", "", "This guide", " explains the process."],
          ["sentence-end", "Read the ", "guide", "."],
          [
            "sentence-colon",
            "For example: read the ",
            "guide",
            " for details.",
          ],
          [
            "sentence-colon-start",
            "For example: ",
            "this guide",
            " explains the process.",
          ],
          ["metadata", "Source: ", "record", ""],
          ["metadata-period", "Source: ", "record", "."],
          ["action-before-sentence", "", "Claim one", ". Read the guide."],
          ["action-after-sentence", "Read the guide. ", "Claim one", ""],
        ];
        for (const [id, before, caption, after] of samples) {
          const paragraph = document.createElement("p");
          paragraph.id = `audit-${id}`;
          const anchor = document.createElement("a");
          anchor.href = "#sample";
          anchor.textContent = caption;
          paragraph.append(before, anchor, after);
          document.querySelector("main")!.append(paragraph);
        }
      });
      const data = await inventory(page);
      await artifact(info, `sentence-exceptions-${viewport.name}`, data);
      for (const id of [
        "sentence",
        "sentence-start",
        "sentence-end",
        "sentence-colon",
        "sentence-colon-start",
        "metadata",
        "metadata-period",
        "action-before-sentence",
        "action-after-sentence",
      ]) {
        const entry = data.entries.find((entry) =>
          entry.path.includes(`#audit-${id} >`),
        )!;
        expect
          .soft(Boolean(entry.exception), id)
          .toBe(id.startsWith("sentence"));
        if (entry.exception) {
          expect.soft(entry.exceptionContainer).toContain(`#audit-${id}`);
          expect.soft(entry.exceptionSentence).toMatch(/[.!?]$/);
        }
      }
      for (const href of ["/rafsi/cku", "/claim/cukta"]) {
        const entry = data.entries.find((entry) => entry.href === href)!;
        expect.soft(entry.exception, href).toBeNull();
        expect.soft(entry.targetBounds.width, href).toBeGreaterThanOrEqual(44);
        expect.soft(entry.targetBounds.height, href).toBeGreaterThanOrEqual(44);
      }
    });

    test("R3: composition links and Edit have touch targets with centered short labels", async ({
      page,
    }, info) => {
      await open(page, `/word/${fixture().words.vlacku}`);
      await expect(page.locator("article.definition").first()).toBeVisible();
      const data = await inventory(page);
      await artifact(info, `composition-${viewport.name}`, data, page);
      const components = await page
        .locator("main > p")
        .filter({ hasText: /valsi.*\+.*cukta.*·/ })
        .locator("a")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href")));
      expect(components).toHaveLength(2);
      for (const href of components) {
        const entry = data.entries.find((entry) => entry.href === href)!;
        expect
          .soft(entry.exception, `Component ${href} has no inline exception`)
          .toBeNull();
        expect
          .soft(entry.targetBounds.width, `Component ${href} width`)
          .toBeGreaterThanOrEqual(44);
        expect
          .soft(entry.targetBounds.height, `Component ${href} height`)
          .toBeGreaterThanOrEqual(44);
      }
      await open(page, `/word/${fixture().words.cukta}`);
      const geometry = await page
        .locator('.rafsi-line a[href="/rafsi/cku"]')
        .evaluate((node) => {
          const target = node.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(node);
          const text = range.getBoundingClientRect();
          return {
            targetWidth: target.width,
            textWidth: text.width,
            left: text.left - target.left,
            right: target.right - text.right,
            justifyContent: getComputedStyle(node).justifyContent,
          };
        });
      await artifact(info, `short-label-${viewport.name}`, geometry, page);
      expect
        .soft(
          geometry.targetWidth - geometry.textWidth,
          "The short label leaves measurable free space",
        )
        .toBeGreaterThan(8);
      expect.soft(geometry.justifyContent).toBe("center");
      expect
        .soft(
          Math.abs(geometry.left - geometry.right),
          "The label is centered inside the target",
        )
        .toBeLessThan(1);
      await preparePublish(page);
      const edit = page.getByRole("link", { name: "Edit", exact: true });
      const box = (await edit.boundingBox())!;
      await artifact(info, `publish-edit-${viewport.name}`, box, page);
      expect.soft(box.width, "Publish Edit width").toBeGreaterThanOrEqual(44);
      expect.soft(box.height, "Publish Edit height").toBeGreaterThanOrEqual(44);
    });

    test("R5: rafsi, records, manual forms, and unsigned publication cover standalone links", async ({
      page,
    }, info) => {
      test.setTimeout(240000);
      const manifest: Awaited<ReturnType<typeof checkTargets>>[] = [];
      const check = async (state: string) =>
        manifest.push(await checkTargets(page, info, state, viewport));
      await open(page, `/word/${fixture().words.vlacku}`);
      await expect(page.locator("article.definition").first()).toBeVisible();
      await expandDetails(page);
      await check("word-lujvo-expanded");
      await open(page, "/rafsi/cku");
      await expect(
        page.getByRole("region", { name: "cku for cukta", exact: true }),
      ).toContainText("Claimed by");
      await expandDetails(page);
      await check("rafsi-claims");
      await open(page, `/rafsi-pair/${encodeURIComponent(fixture().pair)}`);
      await expect(
        page.getByRole("region", { name: "cku for cukta", exact: true }),
      ).toContainText("Claimed by");
      await expandDetails(page);
      await check("rafsi-pair");
      await open(page, "/claim/vlacku");
      await page.getByLabel("Rafsi spelling", { exact: true }).fill("cku");
      await page
        .getByRole("button", { name: "Check claims and preview", exact: true })
        .click();
      await expect(page.locator("main .notice")).toContainText("Conflict: cku");
      await expect(
        page.getByRole("heading", { name: "Preview", exact: true }),
      ).toBeVisible();
      await check("claim-conflict-preview");
      await open(
        page,
        `/definition/${fixture().definitions.cuktaRev}?compare=${fixture().definitions.cukta1}`,
      );
      await expect(
        page.getByRole("region", { name: "Changed fields", exact: true }),
      ).toBeVisible();
      await expandDetails(page);
      await check("definition-comparison");
      await open(page, `/definition/${fixture().claim}`);
      await expect(
        page.getByRole("heading", {
          name: "Signed rafsi.publish record",
          exact: true,
        }),
      ).toBeVisible();
      await check("record-rafsi");
      for (const kind of ["lujvo", "gismu"] as const) {
        await beginDraft(page, kind);
        await open(page, "/new/form?manual=1");
        await expect(
          page.getByRole("link", {
            name:
              kind === "lujvo"
                ? "Open the lujvo builder"
                : "Open the gismu generator",
            exact: true,
          }),
        ).toBeVisible();
        await check(`form-manual-${kind}`);
      }
      await open(page, "/new/gismu");
      await populateGismu(page);
      await page
        .getByLabel("Type a form yourself", { exact: true })
        .fill("cukta");
      await page
        .getByRole("button", { name: "Choose cukta", exact: true })
        .click();
      const selected = page.getByRole("region", {
        name: "Selected form",
        exact: true,
      });
      await expect(selected).toContainText("identical to cukta");
      await expect(selected).toContainText("cku is claimed by cukta");
      await check("gismu-root-and-rafsi-conflicts");
      await preparePublish(page);
      await page.getByRole("link", { name: "Edit", exact: true }).click();
      await open(page, "/new/editor");
      await page.getByLabel("Headword", { exact: true }).fill("cukta");
      await page.getByRole("button", { name: "Review", exact: true }).click();
      await expect(
        page.getByRole("link", { name: "Open the word", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Create or import a key", exact: true }),
      ).toBeVisible();
      await check("publish-existing-without-key");
      await createAuditIdentity(page);
      await open(page, "/new/publish");
      // Change only the synthetic cached package's version during review.
      await page.evaluate(
        () =>
          new Promise<void>((resolve, reject) => {
            const request = indexedDB.open("jbovlacku-browser-v1", 3);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result;
              const tx = db.transaction("packages", "readwrite");
              const store = tx.objectStore("packages");
              const get = store.get("en");
              get.onsuccess = () =>
                store.put(
                  { ...get.result, snapshot: `sha256:${"9".repeat(64)}` },
                  "en",
                );
              tx.oncomplete = () => {
                db.close();
                resolve();
              };
              tx.onerror = () => {
                db.close();
                reject(tx.error);
              };
            };
          }),
      );
      await page
        .locator("aside")
        .getByRole("button", { name: "Publish", exact: true })
        .click();
      const unlock = page.getByRole("dialog", {
        name: "Unlock your key",
        exact: true,
      });
      await unlock.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
      await unlock.getByRole("button", { name: "Unlock", exact: true }).click();
      await page
        .getByRole("dialog", {
          name: "Before your first public signature",
          exact: true,
        })
        .getByRole("button", { name: "Continue", exact: true })
        .click();
      await expect(
        page.getByRole("link", {
          name: "Review updated conflicts",
          exact: true,
        }),
      ).toBeVisible();
      await check("publish-package-changed");
      await page
        .getByRole("link", { name: "Review updated conflicts", exact: true })
        .click();
      await page.route("**/api/v1/events", (route) =>
        route.fulfill({
          status: 503,
          json: {
            code: "unavailable",
            message: "Layout fixture pauses delivery.",
            event: null,
            field: null,
          },
        }),
      );
      await page
        .locator("aside")
        .getByRole("button", { name: "Publish", exact: true })
        .click();
      await expect(
        page.getByRole("region", { name: "Saved publication", exact: true }),
      ).toContainText("Not delivered yet");
      await check("publish-pending-group");
      await open(page, `/new/editor?revise=${fixture().definitions.cuktaRev}`);
      const parent = page
        .locator("main > p")
        .filter({ hasText: /^Revision of / })
        .getByRole("link");
      await expect(parent).toBeVisible();
      const parentBox = (await parent.boundingBox())!;
      expect
        .soft(parentBox.width, "Revision parent width")
        .toBeGreaterThanOrEqual(44);
      expect
        .soft(parentBox.height, "Revision parent height")
        .toBeGreaterThanOrEqual(44);
      await expandDetails(page);
      await check("editor-revision");
      expect(manifest).toHaveLength(13);
      await artifact(info, `route-gap-manifest-${viewport.name}`, manifest);
    });

    test("R5: populated profiles, conflicts, and the profile preview cover standalone links", async ({
      page,
    }, info) => {
      test.setTimeout(180000);
      const manifest: Awaited<ReturnType<typeof checkTargets>>[] = [];
      const check = async (state: string) =>
        manifest.push(await checkTargets(page, info, state, viewport));
      await createAuditIdentity(page);
      let profileState = "known";
      // These bounded response variants test layout, not signed profile evidence.
      await page.route(
        (url) => /^\/api\/v1\/identities\/[^/]+$/.test(url.pathname),
        async (route) => {
          const response = await route.fetch();
          const body = await response.json();
          const identity = decodeURIComponent(
            new URL(route.request().url()).pathname.split("/").at(-1)!,
          );
          const claim = {
            event: `jve1:${"1".repeat(64)}`,
            issuer: identity,
            body_hash: null,
            body_status: "present",
            body: {
              name: "Layout profile",
              bio: [["A synthetic profile for layout."]],
              links: ["https://example.org/layout"],
            },
          };
          body.profile = {
            state: profileState,
            claims:
              profileState === "known"
                ? [claim]
                : [
                    claim,
                    {
                      ...claim,
                      event: `jve1:${"2".repeat(64)}`,
                      body: null,
                      body_status: "omitted",
                    },
                  ],
            claims_count: profileState === "known" ? 1 : 2,
            claims_complete: true,
          };
          if (identity === fixture().identities.author)
            body.successor = fixture().identities.delegate;
          await route.fulfill({ response, json: body });
        },
      );
      await open(
        page,
        `/identity/${encodeURIComponent(fixture().identities.author)}`,
      );
      await expect(
        page.locator("main").getByRole("link", {
          name: "https://example.org/layout",
          exact: true,
        }),
      ).toBeVisible();
      await expandDetails(page);
      await check("person-profile-and-activity");
      await open(page, "/identity");
      await page
        .getByRole("link", { name: "Edit public profile", exact: true })
        .click();
      await expect(
        page.getByRole("link", { name: "Manage it", exact: true }),
      ).toBeVisible();
      const editor = page.getByRole("region", {
        name: "Edit public profile",
        exact: true,
      });
      await editor
        .getByRole("button", { name: "Preview the signed claim", exact: true })
        .click();
      await expect(
        page.getByRole("region", { name: "Profile preview", exact: true }),
      ).toBeVisible();
      await check("person-self-profile-preview");
      profileState = "conflicted";
      await open(
        page,
        `/identity/${encodeURIComponent(fixture().identities.author)}`,
      );
      await expect(page.locator("main .card a.fingerprint")).toHaveCount(2);
      await check("person-profile-conflict");
      expect(manifest).toHaveLength(3);
      await artifact(info, `profile-manifest-${viewport.name}`, manifest);
    });

    test("R5: handover recovery and stored status cover standalone links", async ({
      page,
    }, info) => {
      test.setTimeout(180000);
      const manifest: Awaited<ReturnType<typeof checkTargets>>[] = [];
      const check = async (state: string) =>
        manifest.push(await checkTargets(page, info, state, viewport));
      await createAuditIdentity(page);
      await open(page, "/identity/transfer");
      await expect(page.getByText(/0 known heads/)).toBeVisible();
      await check("handover-new-key");
      await open(page, "/identity/compromise");
      await expect(
        page.getByRole("heading", { name: "Preview", exact: true }),
      ).toBeVisible();
      await check("compromise-empty-frontier");
      await open(page, "/identity/transfer");
      await page.getByLabel("New passphrase for the new key").fill(PASSPHRASE);
      await page.getByLabel("Repeat passphrase").fill(PASSPHRASE);
      await page
        .getByRole("button", { name: "Create the new key", exact: true })
        .click();
      const download = page.waitForEvent("download");
      await page
        .getByRole("button", {
          name: "Download the new key's backup",
          exact: true,
        })
        .click();
      await page
        .getByLabel("Backup file", { exact: true })
        .setInputFiles((await (await download).path())!);
      await page.getByLabel("Its passphrase", { exact: true }).fill(PASSPHRASE);
      await page
        .getByRole("button", { name: "Test the backup", exact: true })
        .click();
      await expect(page.getByRole("status").last()).toContainText(
        "recovers the new key",
      );
      await check("handover-successor-ready");
      for (const box of await page.getByRole("checkbox").all())
        await box.check();
      await page
        .getByRole("button", { name: "Sign the handover", exact: true })
        .click();
      const unlock = page.getByRole("dialog", {
        name: "Unlock your key",
        exact: true,
      });
      await unlock.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
      await unlock.getByRole("button", { name: "Unlock", exact: true }).click();
      await expect(
        page.getByRole("region", { name: "Handover status", exact: true }),
      ).toContainText("Handover complete");
      // Restore the disposable old backup without its local status record.
      // The recovery screen must discover the signed records on the fixture API.
      const handover = await page.evaluate(
        () =>
          new Promise<{
            old: string;
            transfer: string;
            accept: string;
            successor: string;
            signedAt: number;
          }>((resolve, reject) => {
            const request = indexedDB.open("jbovlacku-browser-v1", 3);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result;
              const tx = db.transaction("keys", "readwrite");
              const keys = tx.objectStore("keys");
              let handover: any;
              const cursor = keys.openCursor();
              cursor.onsuccess = () => {
                const item = cursor.result;
                if (!item) return;
                if (String(item.key).startsWith("handover:")) {
                  handover = item.value;
                  const old = keys.get(`retired:${handover.old}`);
                  old.onsuccess = () => keys.put(old.result, "selected");
                  item.delete();
                }
                item.continue();
              };
              tx.oncomplete = () => {
                db.close();
                resolve(handover);
              };
              tx.onerror = () => {
                db.close();
                reject(tx.error);
              };
            };
          }),
      );
      await open(page, "/identity/transfer");
      await expect(
        page.getByRole("region", { name: "Acceptance recovery", exact: true }),
      ).toContainText("authenticated acceptance");
      await check("handover-authenticated-acceptance");
      // A saved status with no outbox rows represents an unfinished local retry.
      await page.evaluate(
        (record) =>
          new Promise<void>((resolve, reject) => {
            const request = indexedDB.open("jbovlacku-browser-v1", 3);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result;
              const tx = db.transaction(["keys", "outbox"], "readwrite");
              tx.objectStore("keys").put(record, `handover:${record.old}`);
              tx.objectStore("outbox").delete(record.transfer);
              tx.objectStore("outbox").delete(record.accept);
              tx.oncomplete = () => {
                db.close();
                resolve();
              };
              tx.onerror = () => {
                db.close();
                reject(tx.error);
              };
            };
          }),
        handover,
      );
      await open(page, "/identity/transfer");
      await expect(
        page.getByRole("region", { name: "Handover status", exact: true }),
      ).toContainText("waiting to upload");
      await expect(
        page
          .locator("main")
          .getByRole("link", { name: "Not delivered", exact: true }),
      ).toBeVisible();
      await check("handover-stored-pending");
      expect(manifest).toHaveLength(5);
      await artifact(info, `lifecycle-manifest-${viewport.name}`, manifest);
    });

    test("R5: unavailable browser storage keeps a usable return link", async ({
      page,
    }, info) => {
      await page.addInitScript(() => {
        indexedDB.open = () => {
          throw new Error("Layout fixture blocks browser storage.");
        };
      });
      await open(page, "/identity");
      await expect(
        page.getByRole("heading", {
          name: "Browser storage unavailable",
          exact: true,
        }),
      ).toBeVisible();
      await checkTargets(page, info, "storage-unavailable", viewport);
    });

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

    test("F4 F5 and Grok1: one and two alternatives keep hints below Tags and controls inside their groups", async ({
      page,
    }, info) => {
      await beginDraft(page);
      await open(page, "/new/places");
      await populatePlaces(page, 1);
      const rows = [];
      for (const count of [1, 2]) {
        if (count === 2)
          await page
            .getByRole("button", { name: "Add an alternative", exact: true })
            .click();
        for (let index = 1; index <= count; index++) {
          const tags = page.getByLabel(`Tags for alternative ${index}`, {
            exact: true,
          });
          const group = page.getByRole("group", {
            name: `Alternative ${index}`,
            exact: true,
          });
          await expect(group).toBeVisible();
          await expect
            .soft(group.getByText("Alternative", { exact: true }))
            .toHaveCount(0);
          const removeButton = group.getByRole("button", {
            name: `Remove alternative ${index}`,
            exact: true,
          });
          await expect(removeButton).toHaveCount(count === 1 ? 0 : 1);
          if (count === 2) {
            const spacer = group.locator(".alternative-remove-spacer");
            await expect.soft(spacer).toHaveCount(1);
            if (await spacer.count()) {
              await expect.soft(spacer).toHaveAttribute("aria-hidden", "true");
              await expect.soft(spacer).toBeEmpty();
              const label = group.locator("label.field-label").first();
              expect
                .soft((await spacer.boundingBox())!.height)
                .toBeCloseTo((await label.boundingBox())!.height, 1);
            }
          }
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
            ...(count === 2 ? [removeButton] : []),
          ];
          const boxes = await Promise.all(
            controls.map(async (control) => (await control.boundingBox())!),
          );
          const groupBox = (await group.boundingBox())!;
          for (const box of boxes) {
            expect
              .soft(
                box.x,
                `Alternative ${index} control stays inside its group`,
              )
              .toBeGreaterThanOrEqual(groupBox.x);
            expect
              .soft(
                box.x + box.width,
                `Alternative ${index} control stays inside its group`,
              )
              .toBeLessThanOrEqual(groupBox.x + groupBox.width);
          }
          const hintBox = (await hint.boundingBox())!;
          rows.push({ count, index, boxes, hint: hintBox });
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
            .soft(
              await hint.evaluate((node) => getComputedStyle(node).fontSize),
            )
            .toBe("13px");
          if (viewport.width === 360) {
            for (let i = 1; i < boxes.length; i++) {
              expect
                .soft(
                  boxes[i].y,
                  `Alternative ${index} control ${i} stacks below the preceding control`,
                )
                .toBeGreaterThanOrEqual(
                  boxes[i - 1].y + boxes[i - 1].height + 4,
                );
            }
            expect
              .soft(boxes[1].y)
              .toBeGreaterThanOrEqual(hintBox.y + hintBox.height + 4);
            if (index === 1 && count === 2) {
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
            if (!remove) continue;
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
        const last = page.getByRole("group", {
          name: `Alternative ${count}`,
          exact: true,
        });
        const lastBox = (await last.boundingBox())!;
        const noteLabel = page
          .locator("label")
          .filter({ hasText: /^Type note$/ });
        const noteBox = (await noteLabel.boundingBox())!;
        expect
          .soft(
            noteBox.y - lastBox.y - lastBox.height,
            "The Type note is separate from the last alternative",
          )
          .toBeGreaterThanOrEqual(12);
        await expectPolicyClean(page);
        await artifact(
          info,
          `alternatives-${count}-${viewport.name}`,
          rows.filter((row) => row.count === count),
          page,
        );
      }
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
        manifest.push(await checkTargets(page, info, state, viewport));
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
      const expectedClaimants = await addCompetingClaimFixture(page);
      expect(expectedClaimants).toEqual(
        expect.arrayContaining(["cukta", "vlacku"]),
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
      await open(
        page,
        `/identity/${encodeURIComponent(fixture().identities.author)}`,
      );
      await expect(
        page.getByRole("link", {
          name: "Manage on the Trust page",
          exact: true,
        }),
      ).toBeVisible();
      await check("person-saved-choice");
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
      // The fixture claims cku for cukta and vlacku. Entering it for sinxa
      // repeats the vlacku conflict across two parts with one review key.
      await page.getByLabel("Other rafsi you know").nth(1).fill("cku");
      await page.getByLabel("Other rafsi you know").nth(1).press("Tab");
      const competing = page.getByRole("group", {
        name: "Competing rafsi claims",
        exact: true,
      });
      await expect(
        competing.getByRole("link", { name: "cukta", exact: true }),
      ).toBeVisible();
      const rows = competing.locator("label.check");
      const associations = await rows.evaluateAll((labels) =>
        labels.map((node) => {
          const label = node as HTMLLabelElement;
          const input = label.querySelector("input")!;
          return {
            id: input.id,
            spelling: label.querySelector("a")!.textContent!.trim(),
            ownControl: label.control === input,
            ownLabel: input.labels?.length === 1 && input.labels[0] === label,
          };
        }),
      );
      await artifact(info, `competing-labels-${viewport.name}`, associations);
      expect
        .soft(
          associations.map((row) => row.spelling).sort(),
          "One row per retained claim",
        )
        .toEqual(expectedClaimants);
      expect
        .soft(
          new Set(associations.map((row) => row.id)).size,
          "Acknowledgment IDs are unique",
        )
        .toBe(associations.length);
      expect
        .soft(
          associations.every((row) => row.ownControl && row.ownLabel),
          "Every label identifies its own checkbox",
        )
        .toBe(true);
      const checked = () =>
        rows
          .locator("input")
          .evaluateAll((inputs) =>
            inputs.map((input) => (input as HTMLInputElement).checked),
          );
      for (let index = 0; index < (await rows.count()); index++) {
        const label = rows.nth(index);
        const input = label.locator("input");
        const before = await checked();
        const desired = before.map((value, i) =>
          i === index ? !value : value,
        );
        await label.locator(".inline-prose > span").first().click();
        expect
          .soft(await checked(), `Label ${index} toggles only its own checkbox`)
          .toEqual(desired);
        const afterClick = await checked();
        await input.focus();
        await input.press("Space");
        expect
          .soft(await checked(), `Space toggles only checkbox ${index}`)
          .toEqual(
            afterClick.map((value, i) => (i === index ? !value : value)),
          );
      }
      for (const label of await competing.locator("label.check").all()) {
        const anchor = label.getByRole("link");
        const spelling = (await anchor.textContent())!.trim();
        await expect
          .soft(label)
          .toHaveText(`cku is also claimed by ${spelling}. I keep this form.`);
        expect
          .soft(
            await label.locator(":scope > .inline-prose").count(),
            "The acknowledgment sentence has one prose container",
          )
          .toBe(1);
        await expect.soft(anchor).toHaveCSS("display", "inline");
        const labelBox = (await label.boundingBox())!;
        const anchorBox = (await anchor.boundingBox())!;
        expect.soft(labelBox.width).toBeGreaterThanOrEqual(44);
        expect.soft(labelBox.height).toBeGreaterThanOrEqual(44);
        expect.soft(anchorBox.x).toBeGreaterThanOrEqual(labelBox.x);
        expect.soft(anchorBox.y).toBeGreaterThanOrEqual(labelBox.y);
        expect
          .soft(anchorBox.x + anchorBox.width)
          .toBeLessThanOrEqual(labelBox.x + labelBox.width);
        expect
          .soft(anchorBox.y + anchorBox.height)
          .toBeLessThanOrEqual(labelBox.y + labelBox.height);
      }
      await check("lujvo-competing-claims");
      await open(page, "/new/gismu");
      await populateGismu(page);
      await expandDetails(page);
      await check("gismu-candidates");
      await page.getByLabel("Weights", { exact: true }).selectOption("custom");
      await check("gismu-custom");
      await open(page, "/new/places");
      await populatePlaces(page, 1);
      await check("places-one-alternative");
      await page
        .getByRole("button", { name: "Add an alternative", exact: true })
        .click();
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
      expect(manifest.length).toBe(23);
      await artifact(info, `manifest-${viewport.name}`, manifest);
    });
  });
}
