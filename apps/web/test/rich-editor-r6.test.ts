import { expect, test, type Locator, type Page } from "@playwright/test";
import { richNodes } from "./rich-helpers.ts";
import type { RichNode, RichText } from "../src/model/types.ts";

const soft = expect.configure({ soft: true, timeout: 400 });
const kinds = ["prose", "code", "word", "web"] as const;
type Kind = (typeof kinds)[number];
const inlineSelector =
  ".rich-literal,.rich-code,.rich-word-link,.rich-web-link";
const inputs = [
  "deleteContentBackward",
  "deleteContentForward",
  "deleteWordBackward",
  "deleteWordForward",
  "deleteSoftLineBackward",
  "deleteSoftLineForward",
  "deleteHardLineBackward",
  "deleteHardLineForward",
  "deleteByCut",
] as const;
const keys = [
  ["PC", "Backspace", -1],
  ["PC", "Shift+Backspace", -1],
  ["PC", "Control+Backspace", -1],
  ["PC", "Delete", 1],
  ["PC", "Control+Delete", 1],
  ["Mac binding", "Backspace", -1],
  ["Mac binding", "Shift+Backspace", -1],
  ["Mac binding", "Meta+Backspace", -1],
  ["Mac binding", "Meta+Delete", 1],
  ["Mac binding", "Delete", 1],
  ["Mac binding", "Alt+Backspace", -1],
  ["Mac binding", "Control+h", -1],
  ["Mac binding", "Control+d", 1],
  // This is the forward binding in the installed ProseMirror keymap.
  ["Mac binding", "Control+Alt+Backspace", 1],
  ["Mac binding", "Alt+Delete", 1],
  ["Mac binding", "Alt+d", 1],
] as const;

function node(kind: Kind, text: string): RichNode {
  if (kind === "prose") return text;
  if (kind === "code") return { code: text };
  if (kind === "word")
    return { word: { language: "jbo", spelling: "cukta" }, label: text };
  return { url: "https://example.org/target", label: text };
}

async function mount(page: Page, platform = "PC") {
  // These tests exercise platform bindings on the VM, not macOS devices.
  await page.addInitScript((platform) => {
    Object.defineProperty(navigator, "platform", {
      get: () => (platform === "PC" ? "Linux x86_64" : "MacIntel"),
    });
  }, platform);
  await page.goto("/");
  await page.evaluate(async () => {
    const { richField } = await import(String("/src/components/rich-field.ts"));
    const field = richField("Round six field", { value: [] });
    document.body.replaceChildren(field.wrapper);
    field.input.addEventListener("keydown", (event: KeyboardEvent) => {
      (window as any).r6KeyHandled = event.defaultPrevented;
    });
  });
  return page.getByRole("textbox", { name: "Round six field", exact: true });
}

async function reset(field: Locator, value: RichText) {
  await field.evaluate((field: any, value) => (field.value = value), value);
  expect(await richNodes(field)).toEqual(value);
}

type Point = [paragraph: number, inline: number, offset: number];
async function choose(field: Locator, anchor: Point, head = anchor) {
  await field.focus();
  await field.evaluate(
    (field, { anchor, head, inlineSelector }) => {
      const point = ([paragraph, inline, offset]: Point) => {
        const container = field
          .querySelectorAll("p")
          [paragraph].querySelectorAll(inlineSelector)[inline];
        return [container.firstChild ?? container, offset] as const;
      };
      const selection = getSelection()!;
      selection.setBaseAndExtent(...point(anchor), ...point(head));
      document.dispatchEvent(new Event("selectionchange"));
    },
    { anchor, head, inlineSelector },
  );
}

async function beforeinput(
  field: Locator,
  inputType: string,
  target?: [Point, Point],
  isComposing = false,
) {
  return field.evaluate(
    (field, { inputType, target, inlineSelector, isComposing }) => {
      const event = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType,
        isComposing,
      });
      if (target) {
        const point = ([paragraph, inline, offset]: Point) => {
          const container = field
            .querySelectorAll("p")
            [paragraph].querySelectorAll(inlineSelector)[inline];
          return [container.firstChild ?? container, offset] as const;
        };
        const range = document.createRange();
        range.setStart(...point(target[0]));
        range.setEnd(...point(target[1]));
        Object.defineProperty(event, "getTargetRanges", {
          value: () => [range],
        });
      }
      field.dispatchEvent(event);
      return event.defaultPrevented;
    },
    { inputType, target, inlineSelector, isComposing },
  );
}

async function history(
  page: Page,
  field: Locator,
  before: RichText,
  after: RichText,
  mac = false,
) {
  await page.keyboard.press(mac ? "Meta+z" : "Control+z");
  await soft.poll(() => richNodes(field), { timeout: 400 }).toEqual(before);
  await page.keyboard.press(mac ? "Meta+Shift+z" : "Control+Shift+z");
  await soft.poll(() => richNodes(field), { timeout: 400 }).toEqual(after);
}

async function boundaryMatrix(
  page: Page,
  field: Locator,
  lineBreak: string,
  direction: -1 | 1,
  action: () => Promise<unknown>,
  mac = false,
) {
  for (const kind of kinds) {
    for (const rightKind of kind === "prose" ? [false] : [false, true]) {
      await test.step(`${kind} ${rightKind ? "right" : "left"} node boundary`, async () => {
        const raw = `cd${lineBreak}ef`;
        const left: RichNode[] = [
          "keep\r\n",
          " exact\r",
          node(rightKind ? "prose" : kind, "ab"),
        ];
        const right: RichNode[] = [
          node(rightKind ? kind : "prose", raw),
          { code: "guard\r" },
          " tail\r\n",
        ];
        const outside: RichText[number] = ["outer\r\n", " exact\r"];
        await reset(field, [left, right, outside]);
        await choose(field, direction < 0 ? [1, 0, 0] : [0, 2, 2]);
        await action();
        const joined: RichText =
          kind === "prose"
            ? [[...left.slice(0, 2), "abcd\nef", ...right.slice(1)], outside]
            : [[...left, ...right], outside];
        await soft
          .poll(() => richNodes(field), { timeout: 400 })
          .toEqual(joined);
        const observed = await richNodes(field);
        console.log(
          "R6_CASE",
          JSON.stringify({
            test: test.info().title,
            kind,
            rightKind,
            observed,
            expected: joined,
          }),
        );
        const undone: RichText =
          kind === "prose"
            ? [left, ["cd\nef", ...right.slice(1)], outside]
            : [left, right, outside];
        await history(page, field, undone, joined, mac);
      });
    }
  }
  for (const kind of kinds) {
    const raw = `ab${lineBreak}cd`;
    await reset(field, [[node(kind, raw)]]);
    await choose(field, [0, 0, direction < 0 ? 0 : raw.length]);
    await action();
    console.log(
      "R6_CASE",
      JSON.stringify({
        test: test.info().title,
        kind,
        documentEdge: true,
        observed: await richNodes(field),
        expected: [[node(kind, raw)]],
      }),
    );
    expect.soft(await richNodes(field)).toEqual([[node(kind, raw)]]);
  }
}

for (const [ending, lineBreak] of [
  ["LF", "\n"],
  ["CRLF", "\r\n"],
] as const) {
  for (const [platform, key, direction] of keys) {
    test(`r6 ${platform} ${key} owns ${ending} paragraph boundaries`, async ({
      page,
    }) => {
      const field = await mount(page, platform);
      await boundaryMatrix(
        page,
        field,
        lineBreak,
        direction,
        async () => {
          await page.keyboard.press(key);
          expect
            .soft(await page.evaluate(() => (window as any).r6KeyHandled))
            .toBe(true);
        },
        platform !== "PC",
      );
    });
  }
  for (const inputType of inputs.filter((type) => type !== "deleteByCut")) {
    test(`r6 no-key ${inputType} owns ${ending} paragraph boundaries`, async ({
      page,
    }) => {
      const field = await mount(page);
      await boundaryMatrix(
        page,
        field,
        lineBreak,
        inputType.endsWith("Backward") ? -1 : 1,
        async () => {
          expect.soft(await beforeinput(field, inputType)).toBe(true);
        },
      );
    });
  }
}

for (const inputType of inputs) {
  test(`r6 ${inputType} deletes a selected range across nodes and paragraphs`, async ({
    page,
  }) => {
    const field = await mount(page);
    for (const reversed of [false, true]) {
      const original: RichText = [
        ["keep\r", "ab", node("code", "cut")],
        [node("web", "remove"), "cd\r\nef"],
        ["outer\r\n"],
      ];
      await reset(field, original);
      const a: Point = [0, 1, 1],
        b: Point = [1, 1, 1];
      await choose(field, reversed ? b : a, reversed ? a : b);
      expect(await beforeinput(field, inputType)).toBe(true);
      const after: RichText = [["keep\r", "ad\nef"], ["outer\r\n"]];
      await soft.poll(() => richNodes(field), { timeout: 400 }).toEqual(after);
      await history(
        page,
        field,
        [
          ["keep\r", "ab", node("code", "cut")],
          [node("web", "remove"), "cd\nef"],
          ["outer\r\n"],
        ],
        after,
      );
    }
  });
}

test("r6 cut copies selected text once and collapsed cut keeps the value", async ({
  page,
  browserName,
}) => {
  const field = await mount(page);
  const original: RichText = [
    ["ab", node("code", "code"), "cd\r\nef"],
    ["outer\r"],
  ];
  await reset(field, original);
  await choose(field, [0, 2, 1]);
  expect(await beforeinput(field, "deleteByCut")).toBe(true);
  await page.keyboard.press("Shift+Delete");
  expect(await richNodes(field)).toEqual(original);
  await choose(field, [0, 0, 1], [0, 2, 1]);
  await field.evaluate((field) =>
    field.addEventListener("cut", (event) => {
      (window as any).r6CutText = (
        event as ClipboardEvent
      ).clipboardData?.getData("text/plain");
    }),
  );
  if (browserName === "chromium")
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.keyboard.press("Shift+Delete");
  expect(await page.evaluate(() => (window as any).r6CutText)).toBe("bcodec");
  if (browserName === "chromium")
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "bcodec",
    );
  await expect.poll(() => richNodes(field)).toEqual([["ad\nef"], ["outer\r"]]);
  await reset(field, original);
  await choose(field, [0, 0, 1], [0, 2, 1]);
  const copied = await field.evaluate((field) => {
    const clipboardData = new DataTransfer();
    field.dispatchEvent(
      new ClipboardEvent("cut", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
    return clipboardData.getData("text/plain");
  });
  expect(copied).toBe("bcodec");
  await expect.poll(() => richNodes(field)).toEqual([["ad\nef"], ["outer\r"]]);
});

test("r6 no-key deletion reads the current caret before a word target range", async ({
  page,
}) => {
  const field = await mount(page);
  await reset(field, [["ab"], ["cd\r\nef"]]);
  // Leave the model at the document end and change only the native selection.
  await choose(field, [1, 0, 0]);
  expect(
    await beforeinput(field, "deleteWordBackward", [
      [0, 0, 0],
      [1, 0, 0],
    ]),
  ).toBe(true);
  await expect.poll(() => richNodes(field)).toEqual([["abcd\nef"]]);
});

for (const [inputType, start, end, caret] of [
  ["deleteWordBackward", [0, 0, 0], [0, 2, 2], [0, 2, 2]],
  ["deleteWordForward", [0, 0, 1], [0, 2, 3], [0, 0, 1]],
  ["deleteSoftLineBackward", [0, 0, 0], [0, 2, 2], [0, 2, 2]],
  ["deleteSoftLineForward", [0, 0, 1], [0, 2, 3], [0, 0, 1]],
  ["deleteHardLineBackward", [0, 0, 0], [0, 2, 2], [0, 2, 2]],
  ["deleteHardLineForward", [0, 0, 1], [0, 2, 3], [0, 0, 1]],
] as const) {
  test(`r6 ${inputType} owns its requested extent across inline nodes`, async ({
    page,
  }) => {
    const field = await mount(page);
    for (const kind of kinds.filter((kind) => kind !== "prose")) {
      await reset(field, [
        ["ab", node(kind, "middle\r\n"), "cde\r\nf"],
        ["outside\r"],
      ]);
      await choose(field, [...caret]);
      expect(await beforeinput(field, inputType, [[...start], [...end]])).toBe(
        true,
      );
      await expect
        .poll(() => richNodes(field))
        .toEqual(
          inputType.endsWith("Backward")
            ? [["e\nf"], ["outside\r"]]
            : [["a\nf"], ["outside\r"]],
        );
    }
  });
}

test("r6 word and line deletion without target ranges keeps its full extent", async ({
  page,
}) => {
  const field = await mount(page);
  for (const kind of kinds) {
    for (const inputType of [
      "deleteWordBackward",
      "deleteWordForward",
      "deleteSoftLineBackward",
      "deleteSoftLineForward",
      "deleteHardLineBackward",
      "deleteHardLineForward",
    ]) {
      const backward = inputType.endsWith("Backward");
      await reset(field, [
        [node(kind, "first second\r\nthird")],
        ["outside\r"],
      ]);
      await choose(field, [0, 0, backward ? 12 : 6]);
      expect(await beforeinput(field, inputType)).toBe(true);
      const expected =
        inputType === "deleteHardLineForward"
          ? "first "
          : inputType === "deleteHardLineBackward" ||
              inputType === "deleteSoftLineBackward"
            ? "\nthird"
            : "first \nthird";
      await expect
        .poll(() => richNodes(field))
        .toEqual([[node(kind, expected)], ["outside\r"]]);
    }
  }
});

test("r6 no-key character deletion restores an immediate place conversion", async ({
  page,
}) => {
  const field = await mount(page);
  await field.focus();
  await page.keyboard.type("___");
  await expect.poll(() => richNodes(field)).toEqual([[1]]);
  expect(await beforeinput(field, "deleteContentBackward")).toBe(true);
  await expect.poll(() => richNodes(field)).toEqual([["___"]]);
});

test("r6 cancelable deletion with a composition marker still owns the boundary", async ({
  page,
}) => {
  const field = await mount(page);
  await reset(field, [["ab"], ["cd\r\nef"]]);
  await choose(field, [1, 0, 0]);
  expect(
    await beforeinput(field, "deleteContentBackward", undefined, true),
  ).toBe(true);
  await expect.poll(() => richNodes(field)).toEqual([["abcd\nef"]]);
});

for (const inputType of inputs) {
  test(`r6 noncancelable ${inputType} recovers once from native DOM changes`, async ({
    page,
  }) => {
    const field = await mount(page);
    const outside: RichText[number] = [
      "outside\r",
      node("code", "raw\r\ncode"),
      node("word", "raw\rword"),
      node("web", "raw\r\nweb"),
    ];
    for (const kind of kinds) {
      const raw = "cd\r\nef";
      const original: RichText = [["keep\r", node(kind, "ab")], [raw], outside];
      await reset(field, original);
      const backward = inputType.endsWith("Backward");
      const cut = inputType === "deleteByCut";
      await choose(
        field,
        cut ? [0, 1, 1] : backward ? [1, 0, 0] : [0, 1, 2],
        cut ? [1, 0, 1] : undefined,
      );
      const prevented = await field.evaluate((field, inputType) => {
        const event = new InputEvent("beforeinput", {
          bubbles: true,
          inputType,
        });
        field.dispatchEvent(event);
        (field as any).value = JSON.parse(JSON.stringify((field as any).value));
        field.innerHTML = "<p>browser result</p><p>ef</p>";
        field.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType }),
        );
        field.innerHTML = "<p>duplicate native mutation</p>";
        field.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType }),
        );
        return event.defaultPrevented;
      }, inputType);
      expect(prevented).toBe(false);
      const expected: RichText =
        kind === "prose"
          ? [["keep\r", cut ? "ad\nef" : "abcd\nef"], outside]
          : [
              ["keep\r", node(kind, cut ? "a" : "ab"), cut ? "d\nef" : raw],
              outside,
            ];
      await expect.poll(() => richNodes(field)).toEqual(expected);
      await expect(field.locator("p")).toHaveCount(2);
      await history(
        page,
        field,
        [
          ["keep\r", node(kind, "ab")],
          [cut || kind === "prose" ? "cd\nef" : raw],
          outside,
        ],
        expected,
      );
    }
  });
}

test("r6 noncancelable deletion can be canceled or replaced without replay", async ({
  page,
}) => {
  const field = await mount(page);
  const original: RichText = [["ab"], ["cd\r\nef"]];
  await reset(field, original);
  await choose(field, [1, 0, 0]);
  await field.evaluate((field) =>
    field.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "deleteWordBackward",
      }),
    ),
  );
  await page.waitForTimeout(30);
  expect(await richNodes(field)).toEqual(original);
  await field.evaluate((field) => {
    field.innerHTML = "<p>late canceled mutation</p>";
    field.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "deleteWordBackward",
      }),
    );
  });
  expect(await richNodes(field)).toEqual(original);
  await choose(field, [1, 0, 0]);
  await field.evaluate((field: any) => {
    field.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "deleteWordBackward",
      }),
    );
    field.value = [["replacement\r\nvalue"]];
    field.innerHTML = "<p>late replaced mutation</p>";
    field.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "deleteWordBackward",
      }),
    );
  });
  expect(await richNodes(field)).toEqual([["replacement\r\nvalue"]]);
  await reset(field, original);
  await choose(field, [1, 0, 0]);
  await field.evaluate((field) => {
    field.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "deleteWordBackward",
      }),
    );
    // A replacement cut with a collapsed selection cancels the earlier join.
    field.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "deleteByCut",
      }),
    );
    field.innerHTML = "<p>native mutation</p>";
    field.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "deleteByCut" }),
    );
  });
  await expect.poll(() => richNodes(field)).toEqual(original);
  await expect(field.locator("p")).toHaveCount(2);
});

test("r6 soft line deletion follows visual wrapping inside saved prose", async ({
  page,
}) => {
  const field = await mount(page);
  const raw =
    "first second third fourth fifth sixth seventh eighth ninth tenth";
  await reset(field, [[raw], ["outside\r"]]);
  await field.evaluate((field) => {
    field.style.width = "180px";
    field.style.font = "16px monospace";
  });
  const line = await field.evaluate((field) => {
    const text = field.querySelector(".rich-literal")!.firstChild!;
    const top = (offset: number) => {
      const range = document.createRange();
      range.setStart(text, offset);
      range.setEnd(text, offset + 1);
      return range.getBoundingClientRect().top;
    };
    const first = top(0);
    let start = 0;
    while (start < text.textContent!.length - 1 && top(start) === first)
      start++;
    const second = top(start);
    let end = start;
    while (end < text.textContent!.length - 1 && top(end) === second) end++;
    return { start, end };
  });
  expect(line.start).toBeGreaterThan(0);
  expect(line.end).toBeGreaterThan(line.start + 1);
  const caret = line.start + 1;
  await choose(field, [0, 0, caret]);
  expect(await beforeinput(field, "deleteSoftLineBackward")).toBe(true);
  await expect
    .poll(() => richNodes(field))
    .toEqual([[raw.slice(0, line.start) + raw.slice(caret)], ["outside\r"]]);
});

for (const [platform, key, direction] of keys) {
  test(`r6 ${platform} ${key} preserves its extent inside text`, async ({
    page,
  }) => {
    const field = await mount(page, platform);
    const character = [
      "Backspace",
      "Delete",
      "Shift+Backspace",
      "Control+h",
      "Control+d",
    ].includes(key);
    const line = key.startsWith("Meta+");
    for (const kind of kinds) {
      await reset(field, [
        [node(kind, "first second\r\nthird")],
        ["outside\r"],
      ]);
      await choose(field, [0, 0, direction < 0 ? 12 : 6]);
      await page.keyboard.press(key);
      const text = character
        ? direction < 0
          ? "first secon\nthird"
          : "first econd\nthird"
        : direction < 0 && line
          ? "\nthird"
          : "first \nthird";
      await expect
        .poll(() => richNodes(field))
        .toEqual([[node(kind, text)], ["outside\r"]]);
    }
  });
}

test("r6 no-key character deletion removes CRLF and a grapheme as complete units", async ({
  page,
}) => {
  const field = await mount(page);
  for (const kind of kinds) {
    for (const [inputType, offset, text] of [
      ["deleteContentBackward", 5, "a🙂b"],
      ["deleteContentForward", 3, "a🙂b"],
      ["deleteContentBackward", 3, "a\nb"],
      ["deleteContentForward", 1, "a\nb"],
    ] as const) {
      await reset(field, [[node(kind, "a🙂\r\nb")], ["outside\r"]]);
      await choose(field, [0, 0, offset]);
      expect(await beforeinput(field, inputType)).toBe(true);
      await expect
        .poll(() => richNodes(field))
        .toEqual([[node(kind, text)], ["outside\r"]]);
    }
  }
});

test("r6 word deletion has a bounded fallback without native selection motion", async ({
  page,
}) => {
  const field = await mount(page);
  await reset(field, [
    ["first ", node("code", "second"), " third\r\nfourth"],
    ["outside\r"],
  ]);
  await choose(field, [0, 2, 0]);
  await page.evaluate(() =>
    Object.defineProperty(Selection.prototype, "modify", {
      value: undefined,
      configurable: true,
    }),
  );
  expect(await beforeinput(field, "deleteWordBackward")).toBe(true);
  await expect
    .poll(() => richNodes(field))
    .toEqual([["first ", node("code", ""), " third\r\nfourth"], ["outside\r"]]);
});

for (const inputType of [
  "deleteHardLineBackward",
  "deleteHardLineForward",
] as const) {
  test(`r6 ${inputType} crosses inline newlines and containers without a target range`, async ({
    page,
  }) => {
    const field = await mount(page);
    for (const kind of kinds) {
      const outside: RichText[number] = ["outside\r", node("code", "raw\r\n")];
      const backward = inputType.endsWith("Backward");
      await reset(field, [
        ["before\r\n", node(kind, "one\r\ntwo"), " after\r\nend"],
        outside,
      ]);
      await choose(field, [0, 1, 7]);
      expect(await beforeinput(field, inputType)).toBe(true);
      await expect
        .poll(() => richNodes(field))
        .toEqual(
          backward
            ? [[node(kind, "o"), " after\r\nend"], outside]
            : [["before\r\n", node(kind, "one\ntw")], outside],
        );
    }
  });
}

test("r6 removing an editor cancels its staged deletion", async ({ page }) => {
  const field = await mount(page);
  await reset(field, [["ab"], ["cd\r\nef"]]);
  await choose(field, [1, 0, 0]);
  const value = await field.evaluate(async (field: any) => {
    field.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "deleteContentBackward",
      }),
    );
    field.closest(".field-group")!.remove();
    await new Promise((resolve) => setTimeout(resolve, 30));
    field.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "deleteContentBackward",
      }),
    );
    return field.value;
  });
  expect(value).toEqual([["ab"], ["cd\r\nef"]]);
});

for (const inputType of [
  "deleteContent",
  "deleteByDrag",
  "deleteUnrecognized",
  "deleteCompositionText",
]) {
  test(`r6 ${inputType} owns selections and explicit targets outside composition`, async ({
    page,
  }) => {
    const field = await mount(page);
    const original: RichText = [
      ["ab", node("code", "middle")],
      [node("word", "link"), "cd\r\nef"],
      ["outside\r"],
    ];
    for (const selected of [true, false]) {
      await reset(field, original);
      await choose(field, [0, 0, 1], selected ? [1, 1, 1] : undefined);
      expect(
        await beforeinput(field, inputType, [
          [0, 0, 1],
          [1, 1, 1],
        ]),
      ).toBe(true);
      await expect
        .poll(() => richNodes(field))
        .toEqual([["ad\nef"], ["outside\r"]]);
    }
    await reset(field, original);
    await choose(field, [1, 1, 0]);
    expect(await beforeinput(field, inputType)).toBe(true);
    expect(await richNodes(field)).toEqual(original);
  });
}

test("r6 deleteEntireSoftLine owns its visual extent and explicit target", async ({
  page,
}) => {
  const field = await mount(page);
  const original: RichText = [
    ["before\r\n", node("code", "middle"), " after\r\nend"],
    ["outside\r"],
  ];
  await reset(field, original);
  await choose(field, [0, 1, 3]);
  expect(
    await beforeinput(field, "deleteEntireSoftLine", [
      [0, 0, 0],
      [0, 2, 6],
    ]),
  ).toBe(true);
  await expect.poll(() => richNodes(field)).toEqual([["\nend"], ["outside\r"]]);
  await reset(field, [["first second\r\nthird"], ["outside\r"]]);
  await choose(field, [0, 0, 8]);
  expect(await beforeinput(field, "deleteEntireSoftLine")).toBe(true);
  await expect
    .poll(() => richNodes(field))
    .toEqual([["\nthird"], ["outside\r"]]);
});

test("r6 composition deletion needs a mapped range inside one native text node", async ({
  page,
}) => {
  const field = await mount(page);
  const value: RichText = [
    ["left\r\n", node("code", "ab\r\ncd"), node("word", "raw\rword")],
    ["outside\r\n"],
  ];
  await reset(field, value);
  await choose(field, [0, 1, 2]);
  await field.dispatchEvent("compositionstart");
  expect(
    await beforeinput(
      field,
      "deleteCompositionText",
      [
        [0, 1, 1],
        [0, 1, 2],
      ],
      true,
    ),
  ).toBe(false);
  await field.evaluate((field) => {
    field.querySelector(".rich-code")!.firstChild!.textContent = "a\r\ncd";
    field.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "deleteCompositionText",
        isComposing: true,
      }),
    );
  });
  await page.waitForTimeout(30);
  await field.dispatchEvent("compositionend");
  await expect
    .poll(() => richNodes(field))
    .toEqual([
      ["left\r\n", node("code", "a\ncd"), node("word", "raw\rword")],
      ["outside\r\n"],
    ]);
  await reset(field, [
    ["ab"],
    [node("code", "cd\r\nef"), node("web", "raw\r\n")],
  ]);
  await choose(field, [1, 0, 0]);
  await field.dispatchEvent("compositionstart");
  expect(
    await beforeinput(
      field,
      "deleteCompositionText",
      [
        [0, 0, 2],
        [1, 0, 0],
      ],
      true,
    ),
  ).toBe(true);
  await field.dispatchEvent("compositionend");
  await expect
    .poll(() => richNodes(field))
    .toEqual([["ab", node("code", "cd\r\nef"), node("web", "raw\r\n")]]);
});

test("r6 partial ranges retain code and both link types", async ({ page }) => {
  const field = await mount(page);
  for (const [leftKind, rightKind] of [
    ["code", "word"],
    ["word", "web"],
    ["web", "code"],
  ] as const) {
    for (const paragraphs of [false, true]) {
      for (const inputType of [
        "deleteWordBackward",
        "deleteSoftLineForward",
        "deleteByCut",
      ]) {
        const original: RichText = paragraphs
          ? [
              ["before\r", node(leftKind, "prefix\r\n"), " middle\r"],
              ["middle", node(rightKind, "suffix\r\n"), " after\r"],
              ["outside\r"],
            ]
          : [
              [
                "before\r",
                node(leftKind, "prefix\r\n"),
                "middle",
                node(rightKind, "suffix\r\n"),
                " after\r",
              ],
              ["outside\r"],
            ];
        await reset(field, original);
        const from: Point = [0, 1, 3],
          to: Point = paragraphs ? [1, 1, 3] : [0, 3, 3];
        await choose(
          field,
          inputType.endsWith("Backward") ? to : from,
          inputType === "deleteByCut" ? to : undefined,
        );
        expect(await beforeinput(field, inputType, [from, to])).toBe(true);
        await expect
          .poll(() => richNodes(field))
          .toEqual([
            [
              "before\r",
              node(leftKind, "pre"),
              node(rightKind, "fix\n"),
              " after\r",
            ],
            ["outside\r"],
          ]);
      }
    }
  }
});

test("r6 clipboard cut keeps partial code and link nodes", async ({ page }) => {
  const field = await mount(page);
  await reset(field, [
    [node("code", "prefix"), "middle", node("web", "suffix")],
    ["outside\r"],
  ]);
  await choose(field, [0, 0, 3], [0, 2, 3]);
  const copied = await field.evaluate((field) => {
    const clipboardData = new DataTransfer();
    field.dispatchEvent(
      new ClipboardEvent("cut", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
    return clipboardData.getData("text/plain");
  });
  expect(copied).toBe("fixmiddlesuf");
  await expect
    .poll(() => richNodes(field))
    .toEqual([[node("code", "pre"), node("web", "fix")], ["outside\r"]]);
});

test("r6 a superseding delete keeps its different caret and target range", async ({
  page,
}) => {
  const field = await mount(page);
  await reset(field, [["first second"], ["cd\r\nef"]]);
  await choose(field, [1, 0, 0]);
  const prevented = await field.evaluate((field) => {
    field.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "deleteWordBackward",
      }),
    );
    const text = field.querySelector(".rich-literal")!.firstChild!;
    getSelection()!.setBaseAndExtent(text, 12, text, 12);
    const range = document.createRange();
    range.setStart(text, 3);
    range.setEnd(text, 12);
    const event = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "deleteWordBackward",
    });
    Object.defineProperty(event, "getTargetRanges", { value: () => [range] });
    field.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
  await expect.poll(() => richNodes(field)).toEqual([["fir"], ["cd\r\nef"]]);
});

test("r6 superseding insertText and cut keep their new selections", async ({
  page,
}) => {
  const field = await mount(page);
  const original: RichText = [["ab"], ["cd\r\nef"]];
  await reset(field, original);
  await choose(field, [1, 0, 0]);
  await field.evaluate((field) => {
    field.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "deleteWordBackward",
      }),
    );
    const text = field.querySelector(".rich-literal")!.firstChild!;
    getSelection()!.setBaseAndExtent(text, 0, text, 1);
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 1);
    const event = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: "X",
    });
    Object.defineProperty(event, "getTargetRanges", { value: () => [range] });
    field.dispatchEvent(event);
  });
  await expect.poll(() => richNodes(field)).toEqual([["Xb"], ["cd\r\nef"]]);
  await reset(field, original);
  await choose(field, [1, 0, 0]);
  const copied = await field.evaluate((field) => {
    field.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "deleteWordBackward",
      }),
    );
    const text = field.querySelectorAll(".rich-literal");
    getSelection()!.setBaseAndExtent(
      text[0].firstChild!,
      1,
      text[1].firstChild!,
      1,
    );
    const clipboardData = new DataTransfer();
    field.dispatchEvent(
      new ClipboardEvent("cut", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
    return clipboardData.getData("text/plain");
  });
  expect(copied).toMatch(/^b\n+c$/u);
  await expect.poll(() => richNodes(field)).toEqual([["ad\nef"]]);
});

test("r6 deletion direction keeps the correct code or link context for later typing", async ({
  page,
}) => {
  const field = await mount(page);
  for (const [left, right] of [
    ["code", "prose"],
    ["code", "word"],
    ["word", "web"],
    ["web", "code"],
    ["prose", "web"],
  ] as const) {
    for (const [inputType, selected, end] of [
      ["deleteContentBackward", true, false],
      ["deleteContentForward", true, true],
      ["deleteWordForward", false, false],
    ] as const) {
      for (const reverse of selected ? [false, true] : [false]) {
        await reset(field, [
          [node(left, "prefix"), node(right, "suffix")],
          ["outside\r"],
        ]);
        const from: Point = [0, 0, 3],
          to: Point = [0, 1, 3];
        await choose(
          field,
          reverse ? to : from,
          selected ? (reverse ? from : to) : undefined,
        );
        expect(await beforeinput(field, inputType, [from, to])).toBe(true);
        await page.keyboard.type("X");
        await expect
          .poll(() => richNodes(field))
          .toEqual([
            [
              node(left, end ? "pre" : "preX"),
              node(right, end ? "Xfix" : "fix"),
            ],
            ["outside\r"],
          ]);
      }
    }
  }
});
