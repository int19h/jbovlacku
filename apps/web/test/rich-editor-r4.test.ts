import { expect, test, type Locator, type Page } from "@playwright/test";
import { richNodes } from "./rich-helpers.ts";
import { createIdentity, acceptFirstSignature } from "./helpers.ts";
import type { RichNode, RichText } from "../src/model/types.ts";

const original = "keep\r\nline\rbare\r\nexact";
const neighbor: RichText[number] = [
  "before\r\n",
  " adjacent\r",
  { code: "code\r\nexact" },
  { word: { language: "jbo", spelling: "cukta" }, label: "word\rexact" },
  { url: "https://example.org/", label: "web\r\nexact" },
];
const kinds = ["prose", "code", "word", "web"] as const;
function node(kind: (typeof kinds)[number], text: string): RichNode {
  return kind === "prose"
    ? text
    : kind === "code"
      ? { code: text }
      : kind === "word"
        ? { word: { language: "jbo", spelling: "cukta" }, label: text }
        : { url: "https://example.org/target", label: text };
}
async function mount(page: Page, value: RichText) {
  await page.goto("/");
  await page.evaluate(async (value) => {
    const { richField } = await import(String("/src/components/rich-field.ts"));
    const field = richField("Round four field", { value });
    document.body.replaceChildren(field.wrapper);
  }, value);
  return page.getByRole("textbox", { name: "Round four field", exact: true });
}
async function choose(field: Locator, offset: number, end = offset) {
  await field.focus();
  const selected = await field.evaluate(
    (field, { offset, end }) => {
      const containers = field
        .querySelector("p")!
        .querySelectorAll(
          ".rich-literal,.rich-code,.rich-word-link,.rich-web-link",
        );
      const text = containers[containers.length - 1].firstChild!;
      const range = document.createRange();
      range.setStart(text, offset);
      range.setEnd(text, end);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return {
        text: text.textContent,
        nodeType: text.nodeType,
        from: range.startOffset,
        to: range.endOffset,
      };
    },
    { offset, end },
  );
  expect(selected).toEqual({
    text: original,
    nodeType: 3,
    from: offset,
    to: end,
  });
}
for (const kind of kinds) {
  for (const inserted of ["X", "漢"]) {
    test(`r4 ${kind} ${inserted === "X" ? "typing" : "non-ASCII input"} normalizes only its edited node`, async ({
      page,
    }) => {
      const value: RichText = [
        [...neighbor, node(kind, original)],
        ["outer\r\n", " exact\r"],
      ];
      const field = await mount(page, value);
      const offset = original.indexOf("exact") + 3;
      await choose(field, offset);
      await page.keyboard.type(inserted);
      const changed = (
        original.slice(0, offset) +
        inserted +
        original.slice(offset)
      ).replace(/\r\n?/gu, "\n");
      await expect
        .poll(() => richNodes(field))
        .toEqual([[...neighbor, node(kind, changed)], value[1]]);
      await field.press("Control+z");
      await expect
        .poll(() => richNodes(field))
        .toEqual([
          [...neighbor, node(kind, original.replace(/\r\n?/gu, "\n"))],
          value[1],
        ]);
      await field.press("Control+Shift+z");
      await expect
        .poll(() => richNodes(field))
        .toEqual([[...neighbor, node(kind, changed)], value[1]]);
    });
  }
  test(`r4 ${kind} native composition normalizes only its edited node`, async ({
    page,
    browserName,
  }) => {
    const value: RichText = [[...neighbor, node(kind, original)]];
    const field = await mount(page, value);
    const offset = original.indexOf("exact") + 3;
    await choose(field, offset);
    await field.evaluate((field) => {
      (window as any).r4CompositionEvents = [];
      for (const type of [
        "compositionstart",
        "compositionend",
        "beforeinput",
        "input",
      ])
        field.addEventListener(type, (event) => {
          const input = event as InputEvent;
          (window as any).r4CompositionEvents.push({
            type: event.type,
            inputType: input.inputType,
            isComposing: input.isComposing,
            trusted: event.isTrusted,
            value: (field as any).value,
          });
        });
    });
    const changed = (
      original.slice(0, offset) +
      "漢" +
      original.slice(offset)
    ).replace(/\r\n?/gu, "\n");
    if (browserName === "chromium") {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Input.imeSetComposition", {
        text: "漢",
        selectionStart: 1,
        selectionEnd: 1,
      });
      await expect
        .poll(() => richNodes(field))
        .toEqual([[...neighbor, node(kind, changed)]]);
      const mirror = await field.evaluate((field: any) => {
        const nodes = field
          .querySelector("p")
          .querySelectorAll(
            ".rich-literal,.rich-code,.rich-word-link,.rich-web-link",
          );
        const target = nodes[nodes.length - 1];
        const text = target.textContent,
          native = target.firstChild;
        const selection = getSelection()!;
        const anchor = selection.anchorNode,
          offset = selection.anchorOffset;
        field.value = field.value;
        return {
          sameNode: target.firstChild === native,
          sameText: target.textContent === text,
          sameCaret:
            selection.anchorNode === anchor &&
            selection.anchorOffset === offset,
        };
      });
      expect(mirror).toEqual({
        sameNode: true,
        sameText: true,
        sameCaret: true,
      });
      await cdp.send("Input.insertText", { text: "漢" });
      await cdp.detach();
    } else await page.keyboard.type("漢");
    await expect
      .poll(() => richNodes(field))
      .toEqual([[...neighbor, node(kind, changed)]]);
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const events = (window as any).r4CompositionEvents as {
              type: string;
              inputType?: string;
              isComposing?: boolean;
            }[];
            return {
              start: events.some((event) => event.type === "compositionstart"),
              end: events.some((event) => event.type === "compositionend"),
              input: events.some(
                (event) =>
                  event.inputType === "insertCompositionText" &&
                  event.isComposing,
              ),
            };
          }),
        {
          message: "Native composition completes with its actual input events",
        },
      )
      .toEqual({ start: true, end: true, input: true });
    const events = await page.evaluate(
      () =>
        (window as any).r4CompositionEvents as {
          type: string;
          inputType?: string;
          isComposing?: boolean;
          trusted: boolean;
          value: RichText;
        }[],
    );
    expect(events.some((event) => event.type === "compositionstart")).toBe(
      true,
    );
    expect(events.some((event) => event.type === "compositionend")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.inputType === "insertCompositionText" && event.isComposing,
      ),
    ).toBe(true);
    const emitted = events.filter(
      (event) => event.type === "input" && !event.trusted,
    );
    expect(emitted.length).toBeGreaterThan(0);
    for (const event of emitted)
      expect(event.value).toEqual([[...neighbor, node(kind, changed)]]);
    await page
      .getByRole("button", { name: "Insert place 1", exact: true })
      .focus();
    expect(await richNodes(field)).toEqual([
      [...neighbor, node(kind, changed)],
    ]);
    await field.press("Control+z");
    await expect
      .poll(() => richNodes(field))
      .toEqual([[...neighbor, node(kind, original.replace(/\r\n?/gu, "\n"))]]);
  });
  test(`r4 ${kind} paste deletion and newline edits normalize only their node`, async ({
    page,
  }) => {
    const value: RichText = [[...neighbor, node(kind, original)]];
    const field = await mount(page, value);
    const offset = original.indexOf("exact") + 3;
    await choose(field, offset);
    await field.evaluate((field) => {
      const transfer = new DataTransfer();
      transfer.setData("text/plain", "P\r\nQ");
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "clipboardData", { value: transfer });
      field.dispatchEvent(event);
    });
    let changed = (
      original.slice(0, offset) +
      "P\nQ" +
      original.slice(offset)
    ).replace(/\r\n?/gu, "\n");
    expect(await richNodes(field)).toEqual([
      [...neighbor, node(kind, changed)],
    ]);
    await field.press("Control+z");
    expect(await richNodes(field)).toEqual([
      [...neighbor, node(kind, original.replace(/\r\n?/gu, "\n"))],
    ]);
    await mount(page, value);
    await choose(field, offset);
    await page.keyboard.press("Backspace");
    changed = (original.slice(0, offset - 1) + original.slice(offset)).replace(
      /\r\n?/gu,
      "\n",
    );
    expect(await richNodes(field)).toEqual([
      [...neighbor, node(kind, changed)],
    ]);
    await field.press("Control+z");
    expect(await richNodes(field)).toEqual([
      [...neighbor, node(kind, original.replace(/\r\n?/gu, "\n"))],
    ]);
    await mount(page, value);
    await choose(field, offset);
    await page.keyboard.press("Shift+Enter");
    changed = (
      original.slice(0, offset) +
      "\n" +
      original.slice(offset)
    ).replace(/\r\n?/gu, "\n");
    expect(await richNodes(field)).toEqual([
      [...neighbor, node(kind, changed)],
    ]);
  });
}

test("r4 an untouched field keeps blank paragraphs on save and publication", async ({
  page,
}) => {
  await page.goto("/");
  const exact = await page.evaluate(async () => {
    const { newDraft } = await import(String("/src/model/draft.ts"));
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const draft = newDraft({ spelling: "broda", kind: "gismu", step: 4 });
    draft.text = [["first\r\n", " adjacent\r"], [" \t"], ["last"]];
    draft.notes = [["note\r\n", " adjacent\r"], [" \t"]];
    await new LocalStore().put("drafts", "current", draft);
    return { text: draft.text, notes: draft.notes };
  });
  await createIdentity(page);
  await page.getByRole("link", { name: "Add a word", exact: true }).click();
  await page
    .getByRole("link", { name: "Skip to the full editor", exact: true })
    .click();
  const field = page.getByRole("textbox", {
    name: "Definition text",
    exact: true,
  });
  await expect(field).toBeVisible();
  await page.getByLabel("Headword", { exact: true }).fill("brode");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        const { draftToBody } = await import(String("/src/model/draft.ts"));
        const draft = await new LocalStore().get("drafts", "current");
        const { body } = draftToBody(draft);
        return {
          spelling: draft.spelling,
          saved: { text: draft.text, notes: draft.notes },
          published: { text: body?.text, notes: body?.notes },
        };
      }),
    )
    .toEqual({ spelling: "brode", saved: exact, published: exact });
  expect(await richNodes(field)).toEqual(exact.text);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true })
    .click();
  await acceptFirstSignature(page);
  await expect(page).toHaveTitle("brode · jbovlacku");
  const published = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const records = await new LocalStore().list("outbox");
    const record = records
      .map((row: any) => JSON.parse(row.transport))
      .find((transport: any) => transport.body?.word?.spelling === "brode");
    return { text: record?.body.text, notes: record?.body.notes };
  });
  expect(published).toEqual(exact);
});

test("r4 saving switching resuming and replacing drafts preserve untouched fields", async ({
  page,
}) => {
  await page.goto("/");
  const values = await page.evaluate(async () => {
    const { newDraft } = await import(String("/src/model/draft.ts"));
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const draft = newDraft({ spelling: "broda", kind: "gismu" });
    draft.text = [["first\r\n", " adjacent\r"], [" \t"], ["last"]];
    await store.saveDraft("current", draft, "absent");
    const saved = await store.get("drafts", "current");
    const second = await store.switchDraft(
      saved.revision,
      newDraft({ spelling: "brode", kind: "gismu" }),
    );
    const links = await store.savedDrafts();
    const retained = await store.get("drafts", links[0].key);
    const resumed = await store.switchDraft(second.revision, {
      resume: links[0].key,
    });
    const replacement = {
      ...resumed,
      spelling: "brodi",
      revision: crypto.randomUUID(),
    };
    await store.replaceDraft("current", replacement, resumed);
    const replaced = await store.get("drafts", "current");
    return {
      exact: draft.text,
      saved: saved.text,
      retained: retained.text,
      resumed: resumed.text,
      replaced: replaced.text,
    };
  });
  expect(values.saved).toEqual(values.exact);
  expect(values.retained).toEqual(values.exact);
  expect(values.resumed).toEqual(values.exact);
  expect(values.replaced).toEqual(values.exact);
});

for (const kind of ["word", "web"] as const) {
  test(`r4 ${kind} target-only changes preserve the exact label`, async ({
    page,
  }) => {
    const field = await mount(page, [[...neighbor, node(kind, original)]]);
    await choose(field, original.indexOf("exact"));
    await page.getByRole("button", { name: "Edit link", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Edit link", exact: true });
    await dialog
      .getByLabel(kind === "word" ? "Lojban word" : "HTTPS address", {
        exact: true,
      })
      .fill(kind === "word" ? "klama" : "https://example.org/changed");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    const changed =
      kind === "word"
        ? { word: { language: "jbo", spelling: "klama" }, label: original }
        : { url: "https://example.org/changed", label: original };
    expect(await richNodes(field)).toEqual([[...neighbor, changed]]);
  });
}
