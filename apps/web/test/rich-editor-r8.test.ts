import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { richNodes } from "./rich-helpers.ts";
import type { RichText } from "../src/model/types.ts";

const inline = ".rich-literal,.rich-code,.rich-word-link,.rich-web-link";
type Point = [paragraph: number, node: number, offset: number];
const untouched = { url: "https://example.org/raw", label: "outside\r\n" };

async function mount(page: Page, value: RichText, main = false) {
  await page.goto("/");
  await page.evaluate(
    async ({ value, main }) => {
      const { richField } = await import(
        String("/src/components/rich-field.ts")
      );
      // Some engines discard input types that their constructor does not recognize.
      (window as any).r8ProtocolInput = (
        type: string,
        init: InputEventInit,
      ) => {
        const event = new InputEvent(type, init);
        if (event.inputType !== init.inputType)
          Object.defineProperty(event, "inputType", { value: init.inputType });
        return event;
      };
      const field = richField("Round eight field", { value, main });
      (window as any).r8Field = field;
      const before = document.createElement("button");
      before.textContent = "Before field";
      const after = document.createElement("button");
      after.textContent = "After field";
      document.body.replaceChildren(before, field.wrapper, after);
    },
    { value, main },
  );
  return page.getByRole("textbox", { name: "Round eight field", exact: true });
}

async function choose(field: Locator, anchor: Point, head = anchor) {
  await field.focus();
  await field.evaluate(
    (field, { anchor, head, inline }) => {
      const point = ([paragraph, index, offset]: Point) => {
        const node = field
          .querySelectorAll("p")
          [paragraph].querySelectorAll(inline)[index];
        return [node.firstChild ?? node, offset] as const;
      };
      getSelection()!.setBaseAndExtent(...point(anchor), ...point(head));
      document.dispatchEvent(new Event("selectionchange"));
    },
    { anchor, head, inline },
  );
}

async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function trace(field: Locator) {
  await field.evaluate((field) => {
    const records: unknown[] = [];
    const pending = new WeakMap<Event, { prevented: boolean }>();
    (window as any).r8Events = records;
    for (const type of [
      "keydown",
      "beforeinput",
      "input",
      "compositionstart",
      "compositionupdate",
      "compositionend",
      "cut",
      "paste",
      "dragstart",
      "dragover",
      "drop",
      "dragend",
    ]) {
      field.addEventListener(
        type,
        (event) => {
          const input = event as InputEvent;
          const record = {
            sequence: records.length,
            type: event.type,
            trusted: event.isTrusted,
            inputType: input.inputType ?? null,
            key: (event as KeyboardEvent).key ?? null,
            data: input.data ?? null,
            isComposing: input.isComposing ?? null,
            cancelable: event.cancelable,
            rangeCount: input.getTargetRanges?.().length ?? 0,
            prevented: false,
            dom: field.textContent,
            nodes: structuredClone((field as any).value),
          };
          records.push(record);
          pending.set(event, record);
        },
        true,
      );
      // The stable host receives bubbling after any recreated field handlers.
      field.parentElement!.addEventListener(type, (event) => {
        const record = pending.get(event);
        if (record) record.prevented = event.defaultPrevented;
      });
    }
  });
}

async function snapshot(field: Locator) {
  return field.evaluate((field) => {
    const selection = getSelection();
    const point = (node: Node | null, offset: number) => ({
      inside: Boolean(node && field.contains(node)),
      parentClass: node?.parentElement?.className ?? null,
      text: node?.textContent ?? null,
      offset,
    });
    return {
      dom: field.textContent,
      html: field.innerHTML,
      nodes: (field as any).value,
      focus: {
        tag: document.activeElement?.tagName,
        text: document.activeElement?.textContent,
        label: document.activeElement?.getAttribute("aria-label"),
        editor: document.activeElement === field,
      },
      anchor: point(
        selection?.anchorNode ?? null,
        selection?.anchorOffset ?? 0,
      ),
      head: point(selection?.focusNode ?? null, selection?.focusOffset ?? 0),
      pendingNodeRetained: (window as any).r8PendingNode
        ? field.contains((window as any).r8PendingNode)
        : null,
    };
  });
}

async function evidence(
  page: Page,
  field: Locator,
  info: TestInfo,
  name: string,
  extra: unknown = null,
) {
  await info.attach(name, {
    contentType: "application/json",
    body: JSON.stringify(
      {
        final: await snapshot(field),
        events: await page.evaluate(() => (window as any).r8Events ?? []),
        extra,
      },
      null,
      2,
    ),
  });
}

async function composition(
  field: Locator,
  type: "compositionstart" | "compositionend",
  data: string,
) {
  await field.evaluate(
    (field, { type, data }) => {
      field.dispatchEvent(new CompositionEvent(type, { bubbles: true, data }));
    },
    { type, data },
  );
}

/** Injected input types test the protocol, not a physical input device. */
async function intent(
  field: Locator,
  type: string,
  data: string | null = null,
  ranges: [Point, Point][] = [],
  cancelable = true,
  composing = false,
) {
  return field.evaluate(
    (field, { type, data, ranges, cancelable, composing, inline }) => {
      const point = ([paragraph, index, offset]: Point) => {
        const node = field
          .querySelectorAll("p")
          [paragraph].querySelectorAll(inline)[index];
        return { node: node.firstChild ?? node, offset };
      };
      const event: InputEvent = (window as any).r8ProtocolInput("beforeinput", {
        bubbles: true,
        cancelable,
        inputType: type,
        data,
        isComposing: composing,
      });
      Object.defineProperty(event, "getTargetRanges", {
        value: () =>
          ranges.map(([start, end]) => {
            const a = point(start),
              b = point(end);
            return new StaticRange({
              startContainer: a.node,
              startOffset: a.offset,
              endContainer: b.node,
              endOffset: b.offset,
            });
          }),
      });
      field.dispatchEvent(event);
      return event.defaultPrevented;
    },
    { type, data, ranges, cancelable, composing, inline },
  );
}

for (const dialog of ["Link a word", "Web link", "Insert code", "Edit link"]) {
  test(`r8 N1 secondary ${dialog} cancellation restores a usable focus target`, async ({
    page,
  }, info) => {
    const field = await mount(page, [
      [{ url: "https://example.org/", label: "label" }],
    ]);
    await choose(field, [0, 0, 2]);
    const name =
      dialog === "Link a word" ? "Word link, link a Lojban word" : dialog;
    const invoker = page
      .getByRole("toolbar")
      .getByRole("button", { name, exact: true });
    await invoker.click();
    await page
      .getByRole("dialog", { name: dialog, exact: true })
      .press("Escape");
    await settle(page);
    await evidence(page, field, info, "N1-after-dialog-close", { dialog });
    expect(
      await field.evaluate((field) => {
        const active = document.activeElement;
        return (
          active === field ||
          Boolean(
            active &&
            field
              .closest(".rich-field")!
              .querySelector(".rich-toolbar")!
              .contains(active),
          )
        );
      }),
    ).toBe(true);
    expect(
      await page.evaluate(() => document.activeElement === document.body),
    ).toBe(false);
  });
}

test("r8 N1 secondary dialogs restore focus after Cancel and successful insertion", async ({
  page,
}, info) => {
  const field = await mount(page, [["ab"]]);
  await choose(field, [0, 0, 1]);
  const web = page.getByRole("button", { name: "Web link", exact: true });
  await web.click();
  await page
    .getByRole("dialog", { name: "Web link", exact: true })
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(web).toBeFocused();
  const code = page.getByRole("button", { name: "Insert code", exact: true });
  await code.click();
  const dialog = page.getByRole("dialog", { name: "Insert code", exact: true });
  await dialog.getByLabel("Code", { exact: true }).fill("X");
  await dialog.getByRole("button", { name: "Insert", exact: true }).click();
  await settle(page);
  await evidence(page, field, info, "N1-successful-dialog-close");
  await expect(code).toBeFocused();
  expect(await richNodes(field)).toEqual([["a", { code: "X" }, "b"]]);
});

for (const point of [
  "text-zero",
  "paragraph-zero",
  "root-zero",
  "pointer-middle",
] as const) {
  test(`r8 F11 external reset keeps deliberate ${point} caret`, async ({
    page,
  }, info) => {
    const field = await mount(page, [["old"]]);
    await page
      .getByRole("button", { name: "Before field", exact: true })
      .focus();
    await field.evaluate((field, point) => {
      (field as any).value = [["abcd"]];
      (window as any).r8Field.moved();
      if (point !== "pointer-middle") {
        const target =
          point === "text-zero"
            ? field.querySelector(".rich-literal")!.firstChild!
            : point === "paragraph-zero"
              ? field.querySelector("p")!
              : field;
        getSelection()!.setBaseAndExtent(target, 0, target, 0);
        document.dispatchEvent(new Event("selectionchange"));
      }
    }, point);
    if (point === "pointer-middle") {
      const position = await field.evaluate((field) => {
        const text = field.querySelector(".rich-literal")!.firstChild!;
        const range = document.createRange();
        range.setStart(text, 2);
        range.setEnd(text, 3);
        const box = range.getBoundingClientRect();
        return { x: box.left + 0.1, y: box.top + box.height / 2 };
      });
      await page.mouse.click(position.x, position.y);
    } else await field.focus();
    await page.keyboard.type("X");
    await evidence(page, field, info, "F11-external-reset-deliberate-caret", {
      point,
    });
    expect(await richNodes(field)).toEqual([
      [point === "pointer-middle" ? "abXcd" : "Xabcd"],
    ]);
  });
}

test("r8 N2 forward Tab reaches the secondary toolbar after its editor", async ({
  page,
}, info) => {
  const field = await mount(page, [["text"]]);
  await trace(field);
  await page.getByRole("button", { name: "Before field", exact: true }).focus();
  const sequence = [];
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Tab");
    sequence.push(await snapshot(field));
  }
  await evidence(page, field, info, "N2-forward-tab", { sequence });
  expect(sequence[0].focus.editor).toBe(true);
  expect(sequence[1].focus.label).toBe("Insert place 1");
  expect(sequence[2].focus.text).toBe("After field");
  const events = await page.evaluate(() => (window as any).r8Events);
  expect(
    events.some((event: any) => event.type === "keydown" && event.trusted),
  ).toBe(true);
});

for (const kind of ["word", "web"] as const) {
  test(`r8 N4 editing an existing multiline ${kind} label keeps its line breaks`, async ({
    page,
  }, info) => {
    const node =
      kind === "word"
        ? {
            word: { language: "jbo" as const, spelling: "cukta" },
            label: "first\r\nlast",
          }
        : { url: "https://example.org/", label: "first\r\nlast" };
    const field = await mount(page, [[node, " untouched\r\n"]]);
    await choose(field, [0, 0, 2]);
    await page.getByRole("button", { name: "Edit link", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Edit link", exact: true });
    const label = dialog.getByLabel("Link label", { exact: true });
    const opened = await label.evaluate((node) => ({
      tag: node.tagName,
      value: (node as HTMLInputElement).value,
    }));
    // Append to the displayed value so a one-line control cannot conceal lost breaks.
    await label.press("Control+End");
    await label.press("X");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await settle(page);
    await evidence(page, field, info, "N4-edited-label", { kind, opened });
    expect(await richNodes(field)).toEqual([
      [{ ...node, label: "first\nlastX" }, " untouched\r\n"],
    ]);
    await expect(
      field.locator(kind === "word" ? ".rich-word-link" : ".rich-web-link"),
    ).toHaveText("first\nlastX");
  });
}

test("r8 N5 native execCommand history preserves a loaded complete literal token", async ({
  page,
}, info) => {
  const field = await mount(page, [["__50__"], [untouched]]);
  await choose(field, [0, 0, 0], [0, 0, 6]);
  await trace(field);
  const phases = [];
  for (const [command, value] of [
    ["insertText", "x"],
    ["undo", ""],
    ["redo", ""],
  ]) {
    const result = await field.evaluate(
      (_field, { command, value }) => {
        try {
          return {
            returned: document.execCommand(command, false, value),
            error: null,
          };
        } catch (error) {
          return { returned: null, error: String(error) };
        }
      },
      { command, value },
    );
    await settle(page);
    phases.push({ command, result, state: await snapshot(field) });
  }
  const events = await page.evaluate(() => (window as any).r8Events);
  await evidence(page, field, info, "N5-native-command-capability-and-values", {
    phases,
    limit:
      "Browser commands are real. Returned booleans do not establish emitted input types or physical-device behavior.",
  });
  expect(
    events.some((event: any) => event.trusted && event.type === "input"),
  ).toBe(true);
  expect(phases[0].state.nodes).toEqual([["x"], [untouched]]);
  const nativeUndo = events.some(
    (event: any) => event.trusted && event.inputType === "historyUndo",
  );
  test.skip(
    !nativeUndo,
    "This engine emitted no trusted historyUndo. The attachment records the unavailable native-history surface.",
  );
  expect(phases[1].state.nodes).toEqual([["__50__"], [untouched]]);
  const nativeRedo = events.some(
    (event: any) => event.trusted && event.inputType === "historyRedo",
  );
  expect(phases[2].state.nodes).toEqual([
    [nativeRedo ? "x" : "__50__"],
    [untouched],
  ]);
  if (nativeRedo) {
    await page.keyboard.press("Control+z");
    await expect
      .poll(() => richNodes(field))
      .toEqual([["__50__"], [untouched]]);
  }
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(() => richNodes(field)).toEqual([["x"], [untouched]]);
});

async function literalPaste(field: Locator, text: string) {
  await field.evaluate((field, text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    });
    if (event.clipboardData !== data)
      Object.defineProperty(event, "clipboardData", { value: data });
    field.dispatchEvent(event);
  }, text);
}

for (const type of ["historyUndo", "historyRedo"] as const) {
  test(`r8 N5 protocol ${type} restores a complete literal through editor history`, async ({
    page,
  }, info) => {
    const initial = type === "historyUndo" ? "__50__" : "x";
    const replacement = type === "historyUndo" ? "x" : "__50__";
    const field = await mount(page, [[initial], [untouched]]);
    await choose(field, [0, 0, 0], [0, 0, initial.length]);
    await literalPaste(field, replacement);
    if (type === "historyRedo") await page.keyboard.press("Control+z");
    await trace(field);
    const prevented = await intent(field, type);
    await settle(page);
    await evidence(page, field, info, "N5-protocol-history", {
      type,
      prevented,
      protocolOnly: true,
    });
    expect(prevented).toBe(true);
    expect(await richNodes(field)).toEqual([["__50__"], [untouched]]);
    // An unchanged completion must not consume a later edit's history.
    await choose(field, [0, 0, 6]);
    await page.keyboard.type("Q");
    await field.evaluate((field, type) => {
      field.dispatchEvent(
        (window as any).r8ProtocolInput("input", {
          bubbles: true,
          inputType: type,
        }),
      );
    }, type);
    await expect
      .poll(() => richNodes(field))
      .toEqual([["__50__Q"], [untouched]]);
  });
}

for (const type of ["historyUndo", "historyRedo"] as const) {
  test(`r8 N5 dirty input-only protocol ${type} owns model history once`, async ({
    page,
  }, info) => {
    const field = await mount(page, [["__50__"], [untouched]]);
    await choose(field, [0, 0, 0], [0, 0, 6]);
    await literalPaste(field, "x");
    if (type === "historyRedo") await page.keyboard.press("Control+z");
    await trace(field);
    await field.evaluate((field, type) => {
      field.querySelector(".rich-literal")!.firstChild!.textContent =
        "native mutation";
      field.dispatchEvent(
        (window as any).r8ProtocolInput("input", {
          bubbles: true,
          inputType: type,
        }),
      );
      field.dispatchEvent(
        (window as any).r8ProtocolInput("input", {
          bubbles: true,
          inputType: type,
        }),
      );
    }, type);
    await settle(page);
    await evidence(page, field, info, "N5-dirty-input-only", {
      type,
      protocolOnly: true,
    });
    expect(await richNodes(field)).toEqual([
      [type === "historyUndo" ? "__50__" : "x"],
      [untouched],
    ]);
  });
}

test("r8 N5 protocol replacement owns its code-label range", async ({
  page,
}, info) => {
  const field = await mount(page, [[{ code: "abcd" }], [untouched]]);
  await choose(field, [0, 0, 1], [0, 0, 3]);
  await trace(field);
  const prevented = await intent(field, "insertReplacementText", "X", [
    [
      [0, 0, 1],
      [0, 0, 3],
    ],
  ]);
  await settle(page);
  await evidence(page, field, info, "N5-protocol-replacement", {
    prevented,
    protocolOnly: true,
  });
  expect(prevented).toBe(true);
  expect(await richNodes(field)).toEqual([[{ code: "aXd" }], [untouched]]);
  await expect(field.locator(".rich-code")).toHaveText("aXd");
});

for (const type of [
  "historyUndo",
  "historyRedo",
  "insertReplacementText",
] as const) {
  test(`r8 N5 noncancelable paired ${type} restores native damage and applies once`, async ({
    page,
  }, info) => {
    const replacement = type === "insertReplacementText";
    const field = await mount(
      page,
      replacement
        ? [[{ code: "abcd" }], [untouched]]
        : [["__50__"], [untouched]],
    );
    if (replacement) await choose(field, [0, 0, 1], [0, 0, 3]);
    else {
      await choose(field, [0, 0, 0], [0, 0, 6]);
      await literalPaste(field, "x");
      if (type === "historyRedo") await page.keyboard.press("Control+z");
    }
    await trace(field);
    await field.evaluate(
      (field, { type, replacement }) => {
        const event = (window as any).r8ProtocolInput("beforeinput", {
          bubbles: true,
          inputType: type,
          data: replacement ? "X" : null,
        });
        if (replacement) {
          const text = field.querySelector(".rich-code")!.firstChild!;
          Object.defineProperty(event, "getTargetRanges", {
            value: () => [
              new StaticRange({
                startContainer: text,
                startOffset: 1,
                endContainer: text,
                endOffset: 3,
              }),
            ],
          });
        }
        field.dispatchEvent(event);
        field.innerHTML = "<p>native damage</p>";
        field.dispatchEvent(
          (window as any).r8ProtocolInput("input", {
            bubbles: true,
            inputType: type,
          }),
        );
        field.dispatchEvent(
          (window as any).r8ProtocolInput("input", {
            bubbles: true,
            inputType: type,
          }),
        );
      },
      { type, replacement },
    );
    await settle(page);
    await evidence(page, field, info, "N5-noncancelable-paired", {
      type,
      protocolOnly: true,
    });
    expect(await richNodes(field)).toEqual(
      replacement
        ? [[{ code: "aXd" }], [untouched]]
        : [[type === "historyUndo" ? "__50__" : "x"], [untouched]],
    );
  });
}

for (const next of ["historyUndo", "insertReplacementText"] as const) {
  test(`r8 N5 old delete stage is canceled before ${next}`, async ({
    page,
  }, info) => {
    const field = await mount(page, [[{ code: "abcd" }], [untouched]]);
    await choose(field, [0, 0, 4]);
    await page.keyboard.type("Q");
    await choose(field, [0, 0, 1], [0, 0, 3]);
    await trace(field);
    await field.evaluate((field, next) => {
      const text = field.querySelector(".rich-code")!.firstChild!;
      const first = (window as any).r8ProtocolInput("beforeinput", {
        bubbles: true,
        inputType: "deleteContentForward",
      });
      field.dispatchEvent(first);
      const second = (window as any).r8ProtocolInput("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: next,
        data: next === "insertReplacementText" ? "X" : null,
      });
      Object.defineProperty(second, "getTargetRanges", {
        value: () => [
          new StaticRange({
            startContainer: text,
            startOffset: 1,
            endContainer: text,
            endOffset: 3,
          }),
        ],
      });
      field.dispatchEvent(second);
    }, next);
    await settle(page);
    await evidence(page, field, info, "N5-delete-stage-superseded", {
      next,
      protocolOnly: true,
    });
    expect(await richNodes(field)).toEqual([
      [{ code: next === "historyUndo" ? "abcd" : "aXdQ" }],
      [untouched],
    ]);
  });
}

for (const first of ["historyUndo", "insertReplacementText"] as const) {
  test(`r8 N5 staged ${first} is canceled by a new insertion`, async ({
    page,
  }, info) => {
    const field = await mount(page, [[{ code: "abcd" }], [untouched]]);
    await choose(field, [0, 0, 4]);
    await page.keyboard.type("Q");
    await choose(field, [0, 0, 1]);
    await trace(field);
    await field.evaluate((field, first) => {
      const make = (inputType: string, data: string, cancelable: boolean) => {
        const text = field.querySelector(".rich-code")!.firstChild!;
        const event = (window as any).r8ProtocolInput("beforeinput", {
          bubbles: true,
          cancelable,
          inputType,
          data,
        });
        Object.defineProperty(event, "getTargetRanges", {
          value: () => [
            new StaticRange({
              startContainer: text,
              startOffset: 1,
              endContainer: text,
              endOffset: 1,
            }),
          ],
        });
        return event;
      };
      field.dispatchEvent(make(first, "X", false));
      field.dispatchEvent(make("insertText", "Y", true));
      field.dispatchEvent(
        (window as any).r8ProtocolInput("input", {
          bubbles: true,
          inputType: first,
        }),
      );
    }, first);
    await settle(page);
    await evidence(page, field, info, "N5-named-stage-superseded", {
      first,
      protocolOnly: true,
    });
    expect(await richNodes(field)).toEqual([[{ code: "aYbcdQ" }], [untouched]]);
  });
}

test("r8 N6 a successful edit clears an obsolete retry notice", async ({
  page,
}, info) => {
  const field = await mount(page, [["abcdef"]]);
  await choose(field, [0, 0, 6]);
  await trace(field);
  const prevented = await intent(field, "deleteContentBackward", null, [
    [
      [0, 0, 0],
      [0, 0, 1],
    ],
    [
      [0, 0, 3],
      [0, 0, 4],
    ],
  ]);
  const notice = page.locator(".rich-field > p.hint").filter({
    hasText:
      "This selection cannot be edited at once. Select one range and try again.",
  });
  const announcer = page.locator('.rich-field [aria-live="polite"]');
  const rejected = {
    state: await snapshot(field),
    visible: await notice.isVisible(),
  };
  await page.keyboard.type("X");
  await settle(page);
  await evidence(page, field, info, "N6-after-successful-edit", {
    prevented,
    rejected,
    noticeVisible: await notice.isVisible(),
  });
  expect(prevented).toBe(true);
  expect(rejected.state.nodes).toEqual([["abcdef"]]);
  expect(rejected.visible).toBe(true);
  expect(await richNodes(field)).toEqual([["abcdefX"]]);
  await expect(notice).toBeHidden();
  await expect(announcer).toHaveCount(1);
  await expect(announcer).toBeEmpty();
});

test("r8 N6 repeated failures update one persistent polite announcer", async ({
  page,
}, info) => {
  const field = await mount(page, [["abcdef"]]);
  await choose(field, [0, 0, 6]);
  const announcer = page.locator('.rich-field [aria-live="polite"]');
  await field.evaluate((field) => {
    const node = field
      .closest(".rich-field")!
      .querySelector('[aria-live="polite"]');
    const messages: string[] = [];
    (window as any).r8Announcements = messages;
    if (node)
      new MutationObserver(() => messages.push(node.textContent ?? "")).observe(
        node,
        { childList: true, subtree: true, characterData: true },
      );
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    await intent(field, "deleteContentBackward", null, [
      [
        [0, 0, 0],
        [0, 0, 1],
      ],
      [
        [0, 0, 3],
        [0, 0, 4],
      ],
    ]);
    await settle(page);
  }
  const messages = await page.evaluate(() => (window as any).r8Announcements);
  await evidence(page, field, info, "N6-live-region-updates", {
    messages,
    limit: "DOM mutations only. No physical screen-reader proof.",
  });
  await expect(announcer).toHaveCount(1);
  await expect(announcer).toHaveAttribute("aria-atomic", "true");
  await expect(announcer).not.toHaveAttribute("role", "status");
  expect(
    messages.filter(
      (text: string) =>
        text ===
        "This selection cannot be edited at once. Select one range and try again.",
    ),
  ).toHaveLength(2);
});

/** All DOM changes and events here are an explicit synthetic composition protocol. */
async function syntheticPending(page: Page, field: Locator) {
  await composition(field, "compositionstart", "");
  await intent(
    field,
    "insertCompositionText",
    "漢字",
    [
      [
        [0, 0, 1],
        [0, 0, 1],
      ],
    ],
    false,
    true,
  );
  await field.evaluate((field) => {
    const text = field.querySelector(".rich-code")!.firstChild!;
    text.textContent = "a漢字b";
    (window as any).r8PendingNode = text;
    getSelection()!.setBaseAndExtent(text, 3, text, 3);
    field.dispatchEvent(
      (window as any).r8ProtocolInput("input", {
        bubbles: true,
        inputType: "insertCompositionText",
        data: "漢字",
        isComposing: true,
      }),
    );
  });
  await settle(page);
}

for (const change of [
  "start-insertion",
  "end-insertion",
  "changed-content",
] as const) {
  test(`r8 N7 protocol deferred deletion rejects widening after ${change}`, async ({
    page,
  }, info) => {
    const edge = { url: "https://example.org/edge", label: "edge\r\n" };
    const field = await mount(page, [[{ code: "ab" }], [edge], [untouched]]);
    await choose(field, [0, 0, 1]);
    await trace(field);
    await syntheticPending(page, field);
    const pending = await snapshot(field);
    const prevented = await intent(
      field,
      "deleteCompositionText",
      null,
      [
        [
          [0, 0, 0],
          [1, 0, 0],
        ],
      ],
      true,
      true,
    );
    const captured = await snapshot(field);
    await field.evaluate((field, change) => {
      if (change === "end-insertion")
        field.querySelector(".rich-web-link")!.firstChild!.textContent =
          "Yedge\r\n";
      else
        field.querySelector(".rich-code")!.firstChild!.textContent =
          change === "start-insertion" ? "Xa漢字b" : "Z漢字b";
      field.dispatchEvent(
        (window as any).r8ProtocolInput("input", {
          bubbles: true,
          inputType: "insertCompositionText",
          data: "漢字",
          isComposing: true,
        }),
      );
    }, change);
    await settle(page);
    const changed = await snapshot(field);
    await composition(field, "compositionend", "漢字");
    await settle(page);
    await evidence(page, field, info, "N7-protocol-mapping", {
      change,
      pending,
      captured,
      changed,
      prevented,
      limit:
        "Synthetic composition, target ranges and DOM mutation. No physical IME reachability is claimed.",
    });
    expect(prevented).toBe(true);
    expect(pending.nodes).toEqual([[{ code: "a漢字b" }], [edge], [untouched]]);
    expect(captured.pendingNodeRetained).toBe(true);
    const expected: RichText =
      change === "start-insertion"
        ? [[{ code: "X" }, edge], [untouched]]
        : change === "end-insertion"
          ? [[{ code: "" }, { ...edge, label: "Yedge\n" }], [untouched]]
          : [[{ code: "Z漢字b" }], [edge], [untouched]];
    expect(await richNodes(field)).toEqual(expected);
    await expect(
      field.locator('.rich-web-link[data-target="https://example.org/raw"]'),
    ).toHaveText("outside\r\n");
  });
}

test("r8 N7 protocol dirty cross-container composition preserves all committed text", async ({
  page,
}, info) => {
  const word = {
    word: { language: "jbo" as const, spelling: "cukta" },
    label: "cd",
  };
  const field = await mount(page, [[{ code: "ab" }, word], [untouched]]);
  await choose(field, [0, 0, 1], [0, 1, 1]);
  await trace(field);
  const start = await snapshot(field);
  await composition(field, "compositionstart", "");
  await intent(
    field,
    "insertCompositionText",
    "漢",
    [
      [
        [0, 0, 1],
        [0, 1, 1],
      ],
    ],
    false,
    true,
  );
  await field.evaluate((field) => {
    const code = field.querySelector(".rich-code")!.firstChild!;
    code.textContent = "a漢";
    field.querySelector(".rich-word-link")!.firstChild!.textContent = "d";
    (window as any).r8PendingNode = code;
    field.dispatchEvent(
      (window as any).r8ProtocolInput("input", {
        bubbles: true,
        inputType: "insertCompositionText",
        data: "漢",
        isComposing: true,
      }),
    );
  });
  await settle(page);
  await field.evaluate((field) => {
    (window as any).r8PendingNode =
      field.querySelector(".rich-code")!.firstChild;
  });
  const pending = await snapshot(field);
  await intent(
    field,
    "deleteCompositionText",
    null,
    [
      [
        [0, 0, 0],
        [1, 0, 0],
      ],
    ],
    false,
    true,
  );
  await field.evaluate((field) => {
    field.querySelector(".rich-code")!.firstChild!.textContent = "a";
    field.dispatchEvent(
      (window as any).r8ProtocolInput("input", {
        bubbles: true,
        inputType: "deleteCompositionText",
        isComposing: true,
      }),
    );
  });
  const dirty = await snapshot(field);
  await composition(field, "compositionend", "漢字");
  await settle(page);
  await evidence(page, field, info, "N7-dirty-cross-container-commit", {
    start,
    pending,
    dirty,
    limit:
      "The injected final commit differs from preedit. This is a protocol case, not proof of a physical IME sequence.",
  });
  expect(dirty.pendingNodeRetained).toBe(true);
  expect(await richNodes(field)).toEqual([
    [{ code: "a漢字" }, { ...word, label: "d" }],
    [untouched],
  ]);
  await expect(field.locator(".rich-code")).toHaveText("a漢字");
  await expect(field.locator(".rich-web-link")).toHaveText("outside\r\n");
});

test("r8 N7 protocol ordinary input resumes after a missing compositionend", async ({
  page,
}, info) => {
  const field = await mount(page, [[{ code: "ab" }], [untouched]]);
  await choose(field, [0, 0, 1]);
  await trace(field);
  await syntheticPending(page, field);
  const pending = await snapshot(field);
  await intent(
    field,
    "deleteCompositionText",
    null,
    [
      [
        [0, 0, 0],
        [1, 0, 0],
      ],
    ],
    false,
    true,
  );
  await field.evaluate((field) => {
    field.querySelector(".rich-code")!.firstChild!.textContent = "a字b";
    field.dispatchEvent(
      (window as any).r8ProtocolInput("input", {
        bubbles: true,
        inputType: "deleteCompositionText",
        isComposing: true,
      }),
    );
  });
  const dirty = await snapshot(field);
  await field.evaluate((field) => {
    const text = field.querySelector(".rich-code")!.firstChild!;
    getSelection()!.setBaseAndExtent(text, 1, text, 1);
  });
  const prevented = await intent(
    field,
    "insertText",
    "X",
    [
      [
        [0, 0, 1],
        [0, 0, 1],
      ],
    ],
    true,
    false,
  );
  if (!prevented)
    await field.evaluate((field) => {
      field.querySelector(".rich-code")!.firstChild!.textContent = "aX漢字b";
      field.dispatchEvent(
        (window as any).r8ProtocolInput("input", {
          bubbles: true,
          inputType: "insertText",
          data: "X",
          isComposing: false,
        }),
      );
    });
  await settle(page);
  await evidence(page, field, info, "N7-missing-end-resumption", {
    pending,
    dirty,
    prevented,
    protocolOnly: true,
  });
  expect(dirty.pendingNodeRetained).toBe(true);
  expect(await richNodes(field)).toEqual([[{ code: "aX漢字b" }], [untouched]]);
  await expect(field.locator(".rich-code")).toHaveText("aX漢字b");
  const retry = page.locator(".rich-field > p.hint").filter({
    hasText:
      "That edit could not be applied during text entry. Finish entering text, select one range and try again.",
  });
  const announcer = page.locator('.rich-field [aria-live="polite"]');
  await expect(retry).toBeVisible();
  await expect(announcer).toHaveText(
    "That edit could not be applied during text entry. Finish entering text, select one range and try again.",
  );
  await page.keyboard.type("Y");
  await expect
    .poll(() => richNodes(field))
    .toEqual([[{ code: "aXY漢字b" }], [untouched]]);
  await expect(retry).toBeHidden();
  await expect(announcer).toBeEmpty();
});

test("r8 N7 Chromium managed pending text survives a noncancelable boundary intent", async ({
  page,
  browserName,
}, info) => {
  test.skip(
    browserName !== "chromium",
    "Browser-managed pending text uses Chromium CDP. Other N7 cases are explicit protocol fixtures.",
  );
  const field = await mount(page, [[{ code: "ab" }], [untouched]]);
  await choose(field, [0, 0, 1]);
  await trace(field);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.imeSetComposition", {
      text: "漢字",
      selectionStart: 2,
      selectionEnd: 2,
    });
    await settle(page);
    const pending = await snapshot(field);
    await field.evaluate((field) => {
      (window as any).r8PendingNode =
        field.querySelector(".rich-code")!.firstChild;
    });
    await intent(
      field,
      "deleteCompositionText",
      null,
      [
        [
          [0, 0, 0],
          [1, 0, 0],
        ],
      ],
      false,
      true,
    );
    const dirty = await snapshot(field);
    await cdp.send("Input.insertText", { text: "漢字" });
    await settle(page);
    await evidence(page, field, info, "N7-CDP-pending-dirty-intent", {
      pending,
      dirty,
      limit:
        "Pending text and commit use CDP without script damage. Only the noncancelable boundary intent is injected. No physical IME sequence is claimed.",
    });
    const events = await page.evaluate(() => (window as any).r8Events);
    expect(
      events.some(
        (event: any) => event.type === "compositionstart" && event.trusted,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event: any) =>
          event.type === "input" &&
          event.inputType === "insertCompositionText" &&
          event.trusted,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event: any) =>
          event.type === "compositionend" && event.data === "漢字",
      ),
    ).toBe(true);
    expect(dirty.pendingNodeRetained).toBe(true);
    expect(await richNodes(field)).toEqual([[{ code: "a漢字b" }], [untouched]]);
    await choose(field, [0, 0, 4]);
    await page.keyboard.type("X");
    await settle(page);
    await evidence(page, field, info, "N7-CDP-subsequent-ordinary-input", {
      endTrust: events
        .filter((event: any) => event.type === "compositionend")
        .map((event: any) => event.trusted),
      limit:
        "The observed end carries the commit text. Its native trust is not established by this control.",
    });
    const resumed = await page.evaluate(() => (window as any).r8Events);
    expect(
      resumed.some(
        (event: any) =>
          event.type === "beforeinput" &&
          event.inputType === "insertText" &&
          event.data === "X" &&
          event.trusted &&
          event.prevented &&
          !event.isComposing,
      ),
    ).toBe(true);
    expect(await richNodes(field)).toEqual([
      [{ code: "a漢字bX" }],
      [untouched],
    ]);
  } finally {
    await cdp.detach();
  }
});

test("r8 N8 L1 More places stays inside a 360 by 360 viewport", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 360, height: 360 });
  const field = await mount(page, [["text"]], true);
  await page.getByRole("button", { name: "More places", exact: true }).click();
  const grid = page.getByRole("grid", { name: "Places 4 to 50", exact: true });
  const geometry = () =>
    grid.evaluate((grid) => {
      const rect = grid.getBoundingClientRect();
      const button = (node: Element) => {
        const r = node.getBoundingClientRect();
        return {
          label: node.getAttribute("aria-label"),
          top: r.top,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
        };
      };
      return {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        viewport: { width: innerWidth, height: innerHeight },
        clientHeight: grid.clientHeight,
        scrollHeight: grid.scrollHeight,
        buttons: [...grid.querySelectorAll("button")].map(button),
        focused:
          document.activeElement && grid.contains(document.activeElement)
            ? button(document.activeElement)
            : null,
      };
    });
  const opened = await geometry();
  await page.keyboard.press("End");
  const last = await geometry();
  await page.keyboard.press("Home");
  const first = await geometry();
  await evidence(page, field, info, "N8-L1-short-viewport", {
    opened,
    last,
    first,
  });
  expect(opened.top).toBeGreaterThanOrEqual(0);
  expect(opened.bottom).toBeLessThanOrEqual(360);
  expect(opened.left).toBeGreaterThanOrEqual(0);
  expect(opened.right).toBeLessThanOrEqual(360);
  expect(opened.buttons).toHaveLength(47);
  expect(last.focused?.label).toBe("Place 50");
  expect(first.focused?.label).toBe("Place 4");
  for (const state of [last, first]) {
    expect(state.focused!.top).toBeGreaterThanOrEqual(Math.max(0, state.top));
    expect(state.focused!.bottom).toBeLessThanOrEqual(
      Math.min(360, state.bottom),
    );
    expect(state.focused!.height).toBeGreaterThanOrEqual(44);
    expect(state.focused!.width).toBeGreaterThanOrEqual(44);
  }
});

test("r8 N8 every short-viewport grid row is reachable and Tab dismisses it", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 360, height: 360 });
  const field = await mount(page, [], true);
  const more = page.getByRole("button", { name: "More places", exact: true });
  await more.click();
  const grid = page.getByRole("grid", { name: "Places 4 to 50", exact: true });
  const rows = [];
  for (const index of [4, 10, 16, 22, 28, 34, 40, 46]) {
    const control = grid.getByRole("button", {
      name: `Place ${index}`,
      exact: true,
    });
    const bounds = await control.boundingBox();
    rows.push({ index, bounds });
    await expect(control).toBeFocused();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(360);
    if (index !== 46) await page.keyboard.press("ArrowDown");
  }
  await page.keyboard.press("Tab");
  await settle(page);
  await evidence(page, field, info, "N8-all-grid-rows", { rows });
  await expect(grid).toBeHidden();
  await expect(more).toHaveAttribute("aria-expanded", "false");
  expect(
    await page.evaluate(() => document.activeElement === document.body),
  ).toBe(false);
});

test("r8 N8 grid cells retain native activation buttons", async ({
  page,
}, info) => {
  const field = await mount(page, [], true);
  await page.getByRole("button", { name: "More places", exact: true }).click();
  const grid = page.getByRole("grid", { name: "Places 4 to 50", exact: true });
  await evidence(page, field, info, "N8-grid-semantics", {
    html: await grid.innerHTML(),
  });
  await expect(grid.getByRole("gridcell")).toHaveCount(47);
  await expect(grid.getByRole("button")).toHaveCount(47);
  await expect(
    grid
      .getByRole("gridcell")
      .first()
      .getByRole("button", { name: "Place 4", exact: true }),
  ).toBeFocused();
});
