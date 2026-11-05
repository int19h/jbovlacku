import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import type { RichText } from "../src/model/types.ts";

const suffix = { url: "https://b.example/", label: "cd" };
const fixtures: {
  name: string;
  value: RichText;
  prefix: { url: string; label: string } | { code: string };
}[] = [
  {
    name: "two links",
    value: [[{ url: "https://a.example/", label: "ab" }, suffix]],
    prefix: { url: "https://a.example/", label: "a" },
  },
  {
    name: "code to link",
    value: [[{ code: "ab" }, suffix]],
    prefix: { code: "a" },
  },
];

async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function expectDialogStyle(dialog: Locator) {
  const style = await dialog.evaluate((node) => {
    const css = getComputedStyle(node);
    const probe = document.createElement("div");
    probe.style.background = "var(--surface)";
    probe.style.border = "1px solid var(--line2)";
    probe.style.boxShadow = "0 20px 60px rgba(0, 0, 0, 0.18)";
    probe.style.color = "#0008";
    document.body.append(probe);
    const expected = getComputedStyle(probe);
    const result = {
      background: css.backgroundColor,
      surface: expected.backgroundColor,
      border: css.borderColor,
      line: expected.borderColor,
      radius: css.borderRadius,
      shadow: css.boxShadow,
      expectedShadow: expected.boxShadow,
      expectedBackdrop: expected.color,
      backdrop: getComputedStyle(node, "::backdrop").backgroundColor,
      left: node.getBoundingClientRect().left,
      right: node.getBoundingClientRect().right,
      scrollWidth: document.documentElement.scrollWidth,
    };
    probe.remove();
    return result;
  });
  expect(style.background).toBe(style.surface);
  expect(style.border).toBe(style.line);
  expect(style.radius).toBe("16px");
  expect(style.shadow).toBe(style.expectedShadow);
  expect(style.backdrop).toBe(style.expectedBackdrop);
  expect(style.left).toBeGreaterThanOrEqual(0);
  expect(style.right).toBeLessThanOrEqual(360);
  expect(style.scrollWidth).toBeLessThanOrEqual(360);
}

async function mount(page: Page, value: RichText) {
  await page.goto("/");
  await page.evaluate(async (value) => {
    const { installRichEditorR9Trace } = await import(
      String("/test/rich-editor-r9-fixture.ts")
    );
    installRichEditorR9Trace();
    const { richField } = await import(String("/src/components/rich-field.ts"));
    const field = richField("Round nine field", { value, main: true });
    document.body.replaceChildren(field.wrapper);
    const input = field.input as any;
    // This public command captures the view through its first dispatch.
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "End",
        code: "End",
        ctrlKey: true,
      }),
    );
    if (!(window as any).r9View)
      throw new Error("The mounted editor did not dispatch Mod-End.");
    (window as any).r9Events = [];
    (window as any).r9Emissions = [];
    (window as any).r9Transactions = [];
    for (const type of [
      "keydown",
      "keypress",
      "beforeinput",
      "input",
      "compositionstart",
      "compositionupdate",
      "compositionend",
      "paste",
    ]) {
      input.addEventListener(
        type,
        (event: any) => {
          (window as any).r9Events.push({
            type,
            trusted: event.isTrusted,
            inputType: event.inputType ?? null,
            data: event.data ?? null,
            key: event.key ?? null,
            composing: event.isComposing ?? null,
            cancelable: event.cancelable,
            value: structuredClone(input.value),
            dom: input.innerHTML,
          });
          if (type === "input" && !event.isTrusted && !event.inputType)
            (window as any).r9Emissions.push(structuredClone(input.value));
        },
        true,
      );
    }
  }, value);
  return page.getByRole("textbox", { name: "Round nine field", exact: true });
}

async function choose(field: Locator) {
  await field.focus();
  await field.evaluate((field) => {
    const nodes = field.querySelectorAll(
      ".rich-literal,.rich-code,.rich-web-link",
    );
    getSelection()!.setBaseAndExtent(
      nodes[0].firstChild!,
      1,
      nodes[1].firstChild!,
      1,
    );
    document.dispatchEvent(new Event("selectionchange"));
  });
  await settle(field.page());
}

async function evidence(
  field: Locator,
  info: TestInfo,
  label: string,
  extra: unknown = null,
) {
  const result = await field.evaluate((field) => ({
    value: (field as any).value,
    dom: field.innerHTML,
    suffixes: [
      ...field.querySelectorAll(".rich-code,.rich-word-link,.rich-web-link"),
    ].map((node) => ({
      tag: node.tagName,
      text: node.textContent,
      attributes: Object.fromEntries(
        [...node.attributes].map((attr) => [attr.name, attr.value]),
      ),
    })),
    emissions: (window as any).r9Emissions,
    events: (window as any).r9Events,
    transactions: (window as any).r9Transactions,
  }));
  await info.attach(label, {
    contentType: "application/json",
    body: JSON.stringify({ ...result, extra }, null, 2),
  });
  return result;
}

function replaced(fixture: (typeof fixtures)[number], text: string): RichText {
  const first =
    "code" in fixture.prefix
      ? { code: fixture.prefix.code + text }
      : { ...fixture.prefix, label: fixture.prefix.label + text };
  return [[first, { ...suffix, label: "d" }]];
}

async function verify(
  field: Locator,
  info: TestInfo,
  expected: RichText,
  initial: RichText,
) {
  await settle(field.page());
  const edited = await evidence(field, info, "edited-value-dom-and-events");
  // Capture undo even when the preservation oracle fails on the baseline.
  await field.press("Control+z");
  await settle(field.page());
  const undone = await evidence(field, info, "undo-value-dom-and-events");
  await field.press("Control+Shift+z");
  await settle(field.page());
  const redone = await evidence(field, info, "redo-value-dom-and-events");
  expect(redone.value).toEqual(expected);
  expect(redone.emissions.at(-1)).toEqual(expected);
  expect(redone.suffixes).toEqual(edited.suffixes);
  expect(undone.value).toEqual(initial);
  expect(edited.value).toEqual(expected);
  expect(edited.emissions.at(-1)).toEqual(expected);
  const retained = edited.suffixes.at(-1)!;
  expect(retained.text).toBe("d");
  expect(retained.attributes["class"]).toContain("rich-web-link");
  expect(retained.attributes["aria-label"]).toContain("https://b.example/");
}

// This probe uses browser-managed composition without script changes to the DOM.
for (const fixture of fixtures) {
  test(`Chromium native parsed pending composition preserves ${fixture.name}`, async ({
    page,
    browserName,
  }, info) => {
    test.skip(
      browserName !== "chromium",
      "Chromium CDP supplies this native composition probe. Portable protocol controls are separate.",
    );
    const field = await mount(page, fixture.value);
    await choose(field);
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Input.imeSetComposition", {
        text: "漢字",
        selectionStart: 2,
        selectionEnd: 2,
      });
      await settle(page);
      const pending = await evidence(field, info, "native-pending-composition");
      await cdp.send("Input.insertText", { text: "漢字" });
      await settle(page);
      const trace = await evidence(
        field,
        info,
        "native-composition-reachability",
        {
          mechanism:
            "CDP preedit reaches native DOM parsing without script damage. The later insertText actuator is a capability observation. It does not establish compositionend, a physical IME commit, or composition undo.",
        },
      );
      expect(pending.value).toEqual(replaced(fixture, "漢字"));
      expect(pending.emissions.at(-1)).toEqual(replaced(fixture, "漢字"));
      for (const emitted of trace.emissions as RichText[]) {
        const nodes = emitted.flat();
        expect(
          nodes.some(
            (node) =>
              typeof node === "object" &&
              "url" in node &&
              node.url === "https://b.example/" &&
              ["cd", "d"].includes(node.label),
          ),
        ).toBe(true);
      }
      expect(
        trace.events.some(
          (event: any) => event.type === "compositionstart" && event.trusted,
        ),
      ).toBe(true);
      expect(
        trace.events.some(
          (event: any) =>
            event.type === "input" &&
            event.inputType === "insertCompositionText" &&
            event.trusted,
        ),
      ).toBe(true);
      expect(
        trace.transactions.some(
          (tr: any) => tr.changed && tr.composition !== null && !tr.explicit,
        ),
      ).toBe(true);
    } finally {
      await cdp.detach();
    }
  });
}

// These injected events and DOM edits test a protocol branch, not a physical IME.
for (const fixture of fixtures) {
  test(`synthetic DOM composition preserves ${fixture.name}`, async ({
    page,
  }, info) => {
    const field = await mount(page, fixture.value);
    await choose(field);
    await field.evaluate((field) => {
      field.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true, data: "" }),
      );
      const range = getSelection()!.getRangeAt(0).cloneRange();
      const before = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: false,
        inputType: "insertCompositionText",
        data: "漢字",
        isComposing: true,
      });
      Object.defineProperty(before, "getTargetRanges", {
        value: () => [range],
      });
      field.dispatchEvent(before);
      range.deleteContents();
      const inserted = document.createTextNode("漢字");
      range.insertNode(inserted);
      getSelection()!.setBaseAndExtent(inserted, 2, inserted, 2);
      field.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertCompositionText",
          data: "漢字",
          isComposing: true,
        }),
      );
      field.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true, data: "漢字" }),
      );
    });
    await verify(
      field,
      info,
      [[fixture.prefix, "漢字", { ...suffix, label: "d" }]],
      fixture.value,
    );
  });
}

for (const fixture of fixtures) {
  for (const key of ["X", "Enter", "Shift+Enter"]) {
    test(`trusted ${key} preserves ${fixture.name}`, async ({ page }, info) => {
      const field = await mount(page, fixture.value);
      await choose(field);
      await field.press(key);
      const actionEvents = await page.evaluate(() =>
        structuredClone((window as any).r9Events),
      );
      await verify(
        field,
        info,
        replaced(fixture, key === "X" ? "X" : "\n"),
        fixture.value,
      );
      expect(
        actionEvents.some(
          (event: any) =>
            event.type === "keydown" &&
            event.key === (key === "X" ? "X" : "Enter") &&
            event.trusted,
        ),
      ).toBe(true);
      if (key === "X")
        expect(
          actionEvents.some(
            (event: any) =>
              event.type === "keypress" && event.key === "X" && event.trusted,
          ),
        ).toBe(true);
    });
  }
}

async function protocol(
  field: Locator,
  type: string,
  mode: "beforeinput" | "paired" | "input-only" | "keymap",
) {
  await field.evaluate(
    (field, { type, mode }) => {
      const view = (window as any).r9View;
      if (mode === "keymap") {
        const event = new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          shiftKey: type === "insertLineBreak",
        });
        for (const plugin of view.state.plugins) {
          if (plugin.props.handleKeyDown?.(view, event)) break;
        }
        return;
      }
      const make = (eventType: string, cancelable: boolean) => {
        const event = new InputEvent(eventType, {
          bubbles: true,
          cancelable,
          inputType: type,
          data: type === "insertText" ? "X" : null,
        });
        if (event.inputType !== type)
          Object.defineProperty(event, "inputType", { value: type });
        if (eventType === "beforeinput")
          Object.defineProperty(event, "getTargetRanges", {
            value: () => [getSelection()!.getRangeAt(0).cloneRange()],
          });
        return event;
      };
      if (mode !== "input-only")
        field.dispatchEvent(make("beforeinput", mode === "beforeinput"));
      if (mode === "paired" || mode === "input-only") {
        // Model a completed native paragraph operation. This is a synthetic protocol fixture.
        const range = getSelection()!.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode("\n"));
        field.dispatchEvent(make("input", false));
      }
    },
    { type, mode },
  );
}

for (const fixture of fixtures) {
  for (const type of ["insertText", "insertParagraph", "insertLineBreak"]) {
    const modes =
      type === "insertText"
        ? (["beforeinput"] as const)
        : (["beforeinput", "paired", "input-only", "keymap"] as const);
    for (const mode of modes) {
      test(`synthetic ${mode} ${type} preserves ${fixture.name}`, async ({
        page,
      }, info) => {
        const field = await mount(page, fixture.value);
        await choose(field);
        await protocol(field, type, mode);
        await verify(
          field,
          info,
          replaced(fixture, type === "insertText" ? "X" : "\n"),
          fixture.value,
        );
      });
    }
  }
}

for (const fixture of fixtures) {
  for (const action of ["paste", "toolbar"]) {
    test(`${action} guard preserves ${fixture.name}`, async ({
      page,
    }, info) => {
      const field = await mount(page, fixture.value);
      await choose(field);
      if (action === "paste") {
        await field.evaluate((field) => {
          const data = new DataTransfer();
          data.setData("text/plain", "X");
          const event = new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: data,
          });
          if (event.clipboardData !== data)
            Object.defineProperty(event, "clipboardData", { value: data });
          if (
            data.getData("text/plain") !== "X" ||
            event.clipboardData?.getData("text/plain") !== "X"
          )
            throw new Error(
              "The paste fixture must supply and expose its exact plain text before dispatch.",
            );
          field.dispatchEvent(event);
        });
      } else
        await page
          .getByRole("button", { name: "Insert place 1", exact: true })
          .click();
      const first = fixture.prefix;
      const expected: RichText = [
        [first, action === "paste" ? "X" : 1, { ...suffix, label: "d" }],
      ];
      await verify(field, info, expected, fixture.value);
    });
  }
}

test("Word link accessible name starts with its visible label", async ({
  page,
}) => {
  await mount(page, [["text"]]);
  const control = page
    .getByRole("toolbar")
    .locator("button")
    .filter({ hasText: /^Word link$/u });
  await expect(control).toHaveAccessibleName(/^Word link/u);
});

for (const mode of [
  "trusted",
  "beforeinput",
  "paired",
  "input-only",
  "keymap",
] as const) {
  test(`${mode} paragraph Enter preserves a link suffix after prose`, async ({
    page,
  }, info) => {
    const initial: RichText = [["ab", suffix]];
    const field = await mount(page, initial);
    await choose(field);
    if (mode === "trusted") await field.press("Enter");
    else await protocol(field, "insertParagraph", mode);
    await verify(field, info, [["a"], [{ ...suffix, label: "d" }]], initial);
  });
}

const chipContainers: { name: string; value: RichText }[] = [
  { name: "code", value: [[{ code: "ab" }]] },
  {
    name: "word link",
    value: [[{ word: { language: "jbo", spelling: "cukta" }, label: "ab" }]],
  },
  { name: "web link", value: [[{ url: "https://b.example/", label: "ab" }]] },
];
for (const container of chipContainers) {
  test(`toolbar chip precedes ${container.name} at label offset zero`, async ({
    page,
  }, info) => {
    const field = await mount(page, container.value);
    await field.focus();
    await field.evaluate((field) => {
      const node = field.querySelector(
        ".rich-code,.rich-word-link,.rich-web-link",
      )!.firstChild!;
      getSelection()!.setBaseAndExtent(node, 0, node, 0);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await settle(page);
    await page
      .getByRole("button", { name: "Insert place 1", exact: true })
      .click();
    await settle(page);
    const edited = await evidence(field, info, "offset-zero-chip-and-emission");
    await field.press("Control+z");
    await settle(page);
    const undone = await evidence(field, info, "offset-zero-chip-undo");
    await field.press("Control+Shift+z");
    await settle(page);
    const redone = await evidence(field, info, "offset-zero-chip-redo");
    expect(redone.value).toEqual(edited.value);
    expect(redone.emissions.at(-1)).toEqual(edited.value);
    expect(edited.value).toEqual([[1, ...container.value[0]]]);
    expect(edited.emissions.at(-1)).toEqual(edited.value);
    expect(undone.value).toEqual(container.value);
  });
}

for (const blank of ["\n \n\n", "\r\n\r\n"]) {
  test(`plain paste splits blank-line runs ${JSON.stringify(blank)} into paragraphs`, async ({
    page,
  }, info) => {
    const initial: RichText = [["start"]];
    const field = await mount(page, initial);
    await field.press("Control+a");
    await field.evaluate((field, pasted) => {
      const data = new DataTransfer();
      data.setData("text/plain", pasted);
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      });
      if (event.clipboardData !== data)
        Object.defineProperty(event, "clipboardData", { value: data });
      if (
        data.getData("text/plain") !== pasted ||
        event.clipboardData?.getData("text/plain") !== pasted
      )
        throw new Error(
          "The paste fixture must supply and expose its exact plain text before dispatch.",
        );
      field.dispatchEvent(event);
    }, `a${blank}b`);
    await settle(page);
    const edited = await evidence(field, info, "blank-line-paste-and-emission");
    await field.press("Control+z");
    await settle(page);
    const undone = await evidence(field, info, "blank-line-paste-undo");
    await field.press("Control+Shift+z");
    await settle(page);
    const redone = await evidence(field, info, "blank-line-paste-redo");
    expect(redone.value).toEqual([["a"], ["b"]]);
    expect(redone.emissions.at(-1)).toEqual(redone.value);
    expect(edited.value).toEqual([["a"], ["b"]]);
    expect(edited.emissions.at(-1)).toEqual(edited.value);
    expect(undone.value).toEqual(initial);
  });
}

for (const theme of ["light", "dark"]) {
  for (const action of [
    { button: "Word link, link a Lojban word", dialog: "Link a word" },
    { button: "Web link", dialog: "Web link" },
    { button: "Insert code", dialog: "Insert code" },
  ]) {
    test(`${action.dialog} dialog fits 360px with surface styling in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 360, height: 640 });
      const field = await mount(page, [["text"]]);
      await page.evaluate(
        (theme) => (document.documentElement.dataset.theme = theme),
        theme,
      );
      await field.focus();
      await page
        .getByRole("button", { name: action.button, exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: action.dialog,
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await expectDialogStyle(dialog);
      await expect(dialog.locator(".actions button")).toHaveText([
        "Cancel",
        "Insert",
      ]);
      const cancel = await dialog
        .getByRole("button", { name: "Cancel", exact: true })
        .boundingBox();
      const insert = await dialog
        .getByRole("button", { name: "Insert", exact: true })
        .boundingBox();
      expect(cancel!.x + cancel!.width).toBeLessThanOrEqual(insert!.x);
      if (action.dialog !== "Insert code")
        await expect(
          dialog.getByLabel("Link label", { exact: true }),
        ).toHaveJSProperty("tagName", "INPUT");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: action.button, exact: true }),
      ).toBeFocused();
    });
  }
}

for (const theme of ["light", "dark"]) {
  test(`circled-number paste dialog keeps Cancel beside its primary action at 360px in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    const initial: RichText = [["text"]];
    const field = await mount(page, initial);
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    await field.focus();
    await field.evaluate((field) => {
      const data = new DataTransfer();
      data.setData("text/plain", "①");
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      });
      if (event.clipboardData !== data)
        Object.defineProperty(event, "clipboardData", { value: data });
      if (event.clipboardData?.getData("text/plain") !== "①")
        throw new Error("The paste fixture must expose its circled number.");
      field.dispatchEvent(event);
    });
    const dialog = page.getByRole("dialog", {
      name: "Paste circled numbers",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expectDialogStyle(dialog);
    await expect(dialog.locator(".actions button")).toHaveText([
      "Convert circled numbers",
      "Cancel",
      "Keep literal text",
    ]);
    const primary = dialog.getByRole("button", {
      name: "Keep literal text",
      exact: true,
    });
    await expect(primary).toHaveClass(/btn-primary/u);
    await expect(primary).toBeFocused();
    const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
    const actions = await dialog
      .locator(":scope > .actions")
      .evaluate((node) => getComputedStyle(node).justifyContent);
    expect(actions).toBe("flex-end");
    const cancelBox = (await cancel.boundingBox())!;
    const primaryBox = (await primary.boundingBox())!;
    const box = (await dialog.boundingBox())!;
    expect(cancelBox.y).toBe(primaryBox.y);
    expect(cancelBox.x + cancelBox.width).toBeLessThanOrEqual(primaryBox.x);
    expect(primaryBox.x + primaryBox.width).toBeCloseTo(
      box.x + box.width - 21,
      0,
    );
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(360);
    await cancel.click();
    await expect(dialog).toHaveCount(0);
    expect(await field.evaluate((node) => (node as any).value)).toEqual(
      initial,
    );
  });
}
