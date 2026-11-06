import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { richNodes } from "./rich-helpers.ts";
import { acceptFirstSignature, corePath } from "./helpers.ts";
import type { RichText } from "../src/model/types.ts";

const inline = ".rich-literal,.rich-code,.rich-word-link,.rich-web-link";
type Point = [paragraph: number, node: number, offset: number];

async function mount(page: Page, value: RichText) {
  await page.goto("/");
  await page.evaluate(async (value) => {
    const { richField } = await import(String("/src/components/rich-field.ts"));
    const field = richField("Round seven field", { value });
    document.body.replaceChildren(field.wrapper);
  }, value);
  return page.getByRole("textbox", { name: "Round seven field", exact: true });
}

async function choose(field: Locator, anchor: Point, head = anchor) {
  await field.focus();
  await field.evaluate(
    (field, { anchor, head, inline }) => {
      const point = ([paragraph, index, offset]: Point) => {
        const container = field
          .querySelectorAll("p")
          [paragraph].querySelectorAll(inline)[index];
        return [container.firstChild ?? container, offset] as const;
      };
      getSelection()!.setBaseAndExtent(...point(anchor), ...point(head));
      document.dispatchEvent(new Event("selectionchange"));
    },
    { anchor, head, inline },
  );
}

/** Event records distinguish browser events from explicitly injected protocol fixtures. */
async function trace(field: Locator) {
  await field.evaluate((field) => {
    const records: unknown[] = [];
    const pending = new WeakMap<
      Event,
      { preventedAfterHandlers: boolean; clipboardPlain: string | null }
    >();
    (window as any).r7Events = records;
    for (const type of [
      "keydown",
      "cut",
      "paste",
      "beforeinput",
      "input",
      "compositionstart",
      "compositionupdate",
      "compositionend",
      "dragstart",
      "dragover",
      "drop",
      "dragend",
    ]) {
      field.addEventListener(
        type,
        (event) => {
          const input = event as InputEvent;
          const key = event as KeyboardEvent;
          const ranges = input.getTargetRanges?.() ?? [];
          const record = {
            sequence: records.length,
            type,
            trusted: event.isTrusted,
            inputType: input.inputType ?? null,
            key: key.key ?? null,
            data: input.data ?? null,
            isComposing: input.isComposing ?? null,
            cancelable: event.cancelable,
            rangeCount: ranges.length,
            preventedAtCapture: event.defaultPrevented,
            preventedAfterHandlers: false,
            clipboardPlain: null as string | null,
            domAtCapture: field.textContent,
            nodesAtCapture: structuredClone((field as any).value),
          };
          records.push(record);
          pending.set(event, record);
        },
        true,
      );
      // The stable host receives bubbling after any recreated field handlers.
      field.parentElement!.addEventListener(type, (event) => {
        const record = pending.get(event);
        if (!record) return;
        record.preventedAfterHandlers = event.defaultPrevented;
        if (event instanceof ClipboardEvent)
          record.clipboardPlain =
            event.clipboardData?.getData("text/plain") ?? null;
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
      focused: document.activeElement === field,
      anchor: point(
        selection?.anchorNode ?? null,
        selection?.anchorOffset ?? 0,
      ),
      head: point(selection?.focusNode ?? null, selection?.focusOffset ?? 0),
    };
  });
}

async function evidence(
  page: Page,
  field: Locator,
  info: TestInfo,
  label: string,
  extra: unknown = null,
) {
  await info.attach(label, {
    contentType: "application/json",
    body: JSON.stringify(
      {
        final: await snapshot(field),
        events: await page.evaluate(() => (window as any).r7Events ?? []),
        extra,
      },
      null,
      2,
    ),
  });
}

async function seed(page: Page, lujvo = false, high = false, context = false) {
  await page.goto("/");
  await page.evaluate(
    async ({ lujvo, high, context }) => {
      const { newDraft, newPlace } = await import(
        String("/src/model/draft.ts")
      );
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const places = high ? [51, 65535] : [1, 2];
      const draft = newDraft({
        spelling: lujvo ? "ckusni" : "broda",
        kind: lujvo ? "lujvo" : "gismu",
        meaning: "A private test meaning.",
        text: high ? [[51, " and ", 65535]] : [[1, " gives ", 2]],
        frameMode: high || context ? "context" : "fixed",
        places: places.map((n) => newPlace(n)),
        numberingApproved: true,
        operands: [
          {
            id: "bridi",
            category: "bridi",
            minimum: 1,
            maximum: 1,
            description: [],
          },
        ],
        step: 4,
      });
      draft.places[0].description = [[high ? 51 : 1, " role"]];
      await new LocalStore().put("drafts", "current", draft);
    },
    { lujvo, high, context },
  );
  await page.goto(lujvo ? "/new/lujvo" : "/new/editor");
  const field = page.getByRole("textbox", {
    name: lujvo ? "Current definition" : "Definition text",
    exact: true,
  });
  await expect(field).toHaveAttribute("contenteditable", "true");
  return field;
}

async function currentDraft(page: Page) {
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().get("drafts", "current");
  });
}

test("input native paragraph keeps a code container and untouched CR text", async ({
  page,
}, info) => {
  const field = await mount(page, [[{ code: "ab" }, "outside\r\n"]]);
  await choose(field, [0, 0, 1]);
  await trace(field);
  const invoked = await field.evaluate(() =>
    document.execCommand("insertParagraph"),
  );
  await evidence(page, field, info, "F1-native-paragraph", { invoked });
  await expect
    .poll(() => richNodes(field))
    .toEqual([[{ code: "a\nb" }, "outside\r\n"]]);
  await expect(field.locator("p")).toHaveCount(1);
  await expect(field.locator(".rich-code")).toHaveText("a\nb");
  await field.press("Control+z");
  await expect
    .poll(() => richNodes(field))
    .toEqual([[{ code: "ab" }, "outside\r\n"]]);
});

test("recovery unchanged no-op and orphan inputs keep the live paragraph", async ({
  page,
}, info) => {
  const field = await mount(page, [["ab"]]);
  await choose(field, [0, 0, 0]);
  await trace(field);
  const result = await field.evaluate(async (field) => {
    const paragraph = field.querySelector("p");
    field.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: false,
        inputType: "deleteContentBackward",
      }),
    );
    field.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "deleteContentBackward",
      }),
    );
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const noOpRetained = paragraph === field.querySelector("p");
    field.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "deleteContentBackward",
      }),
    );
    return {
      noOpRetained,
      orphanRetained: paragraph === field.querySelector("p"),
    };
  });
  await evidence(page, field, info, "F3-F4-noop-recovery", result);
  expect(result).toEqual({ noOpRetained: true, orphanRetained: true });
  await expect(field).toHaveText("ab");
  expect(await richNodes(field)).toEqual([["ab"]]);
  await expect(field).toBeFocused();
});

for (const dialog of [false, true]) {
  test(`paste captures the same-task native range${dialog ? " through the choice dialog" : ""}`, async ({
    page,
  }, info) => {
    const field = await mount(page, [["abcd"]]);
    await field.press("Control+End");
    await trace(field);
    await field.evaluate((field, dialog) => {
      const text = field.querySelector(".rich-literal")!.firstChild!;
      getSelection()!.setBaseAndExtent(text, 1, text, 1);
      const data = new DataTransfer();
      data.setData("text/plain", dialog ? "①" : "X");
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      });
      // This protocol fixture keeps its supplied data when a constructor discards it.
      if (event.clipboardData !== data)
        Object.defineProperty(event, "clipboardData", { value: data });
      field.dispatchEvent(event);
    }, dialog);
    if (dialog)
      await page
        .getByRole("dialog", { name: "Paste circled numbers" })
        .getByRole("button", { name: "Keep literal text" })
        .click();
    await evidence(page, field, info, "F5-paste-range", { dialog });
    const expected = dialog ? "a①bcd" : "aXbcd";
    await expect(field).toHaveText(expected);
    expect(await richNodes(field)).toEqual([[expected]]);
  });
}

test("ranges rejects two disjoint cancelable targets as one operation", async ({
  page,
}, info) => {
  const field = await mount(page, [["abcdef"]]);
  await choose(field, [0, 0, 6]);
  await trace(field);
  const prevented = await field.evaluate((field) => {
    const text = field.querySelector(".rich-literal")!.firstChild!;
    const event = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "deleteContentBackward",
    });
    Object.defineProperty(event, "getTargetRanges", {
      value: () => [
        new StaticRange({
          startContainer: text,
          startOffset: 0,
          endContainer: text,
          endOffset: 1,
        }),
        new StaticRange({
          startContainer: text,
          startOffset: 3,
          endContainer: text,
          endOffset: 4,
        }),
      ],
    });
    field.dispatchEvent(event);
    return event.defaultPrevented;
  });
  await evidence(page, field, info, "F7-disjoint-targets", { prevented });
  expect(prevented).toBe(true);
  expect(await richNodes(field)).toEqual([["abcdef"]]);
  await expect(field).toHaveText("abcdef");
  await expect(
    page.locator(".rich-field > p.hint").filter({
      hasText:
        "This selection cannot be edited at once. Select one range and try again.",
    }),
  ).toBeVisible();
});

test("integration T3 deletion saves actual draft nodes and visible content after reload", async ({
  page,
}, info) => {
  const field = await seed(page);
  await trace(field);
  await field.press("Control+End");
  await field.press("Backspace");
  await expect(
    field.getByRole("img", { name: "place 2", exact: true }),
  ).toHaveCount(0);
  await expect(field).toHaveText("1 gives ");
  await expect
    .poll(async () => (await currentDraft(page)).text)
    .toEqual([[1, " gives "]]);
  await evidence(page, field, info, "T3-draft-deletion", {
    stored: await currentDraft(page),
  });
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Definition text", exact: true }),
  ).toHaveText("1 gives ");
  expect((await currentDraft(page)).text).toEqual([[1, " gives "]]);
});

test("ranges dirty noncancelable disjoint input restores the complete model", async ({
  page,
}, info) => {
  const field = await mount(page, [["abcdef"]]);
  await choose(field, [0, 0, 6]);
  await trace(field);
  await field.evaluate((field) => {
    const text = field.querySelector(".rich-literal")!.firstChild!;
    const event = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: false,
      inputType: "deleteContentBackward",
    });
    Object.defineProperty(event, "getTargetRanges", {
      value: () => [
        new StaticRange({
          startContainer: text,
          startOffset: 0,
          endContainer: text,
          endOffset: 1,
        }),
        new StaticRange({
          startContainer: text,
          startOffset: 3,
          endContainer: text,
          endOffset: 4,
        }),
      ],
    });
    field.dispatchEvent(event);
    text.textContent = "bcef";
    field.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "deleteContentBackward",
      }),
    );
  });
  await evidence(page, field, info, "F7-dirty-disjoint-input", {
    limit:
      "Synthetic noncancelable protocol sequence. No physical input surface is claimed.",
  });
  await expect(field).toHaveText("abcdef");
  expect(await richNodes(field)).toEqual([["abcdef"]]);
});

test("lujvo M1 human definition edits invalidate persisted numbering approval", async ({
  page,
}, info) => {
  const field = await seed(page, true);
  await trace(field);
  await field.press("Control+End");
  await field.pressSequentially("__1__");
  await expect(
    field.getByRole("img", { name: "place 1", exact: true }),
  ).toHaveCount(2);
  await expect
    .poll(async () => (await currentDraft(page)).text)
    .toEqual([[1, " gives ", 2, 1]]);
  await evidence(page, field, info, "M1-human-approval", {
    stored: await currentDraft(page),
  });
  await expect
    .poll(async () => (await currentDraft(page)).numberingApproved)
    .toBe(false);
  await page.reload();
  expect((await currentDraft(page)).numberingApproved).toBe(false);
});

test("lujvo L1 declared operands can be inserted on the builder route", async ({
  page,
}, info) => {
  const field = await seed(page, true);
  await field.press("Control+End");
  await trace(field);
  await page
    .getByRole("toolbar", {
      name: "Current definition formatting",
      exact: true,
    })
    .getByRole("button", { name: "Insert operand", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Insert operand",
    exact: true,
  });
  await expect(dialog.getByLabel("Operand", { exact: true })).toHaveValue(
    "bridi",
  );
  await dialog.getByRole("button", { name: "Insert", exact: true }).click();
  await expect(
    field.getByRole("img", { name: "operand bridi", exact: true }),
  ).toHaveCount(1);
  await expect
    .poll(async () => (await currentDraft(page)).text)
    .toEqual([[1, " gives ", 2, { operand: "bridi" }]]);
  await evidence(page, field, info, "L1-lujvo-operand", {
    stored: await currentDraft(page),
  });
});

test("contract reference renumbering starts history without reviving the old reference", async ({
  page,
}, info) => {
  await seed(page, false, false, true);
  const field = page.getByRole("textbox", {
    name: "Description for place 1",
    exact: true,
  });
  await field.press("Control+End");
  await field.pressSequentially(" edited");
  await expect
    .poll(async () => (await currentDraft(page)).places[0].description)
    .toEqual([[1, " role edited"]]);
  await trace(field);
  const retained = await field.elementHandle();
  await page.getByLabel("Place number 1", { exact: true }).fill("4");
  await page.getByLabel("Place number 1", { exact: true }).press("Tab");
  const renamed = page.getByRole("textbox", {
    name: "Description for place 4",
    exact: true,
  });
  const caretPhases: unknown[] = [];
  const recordCaret = async (phase: string) => {
    const state = await snapshot(renamed);
    const prefix = await renamed.evaluate((field) => {
      const selection = getSelection();
      if (!selection?.focusNode || !field.contains(selection.focusNode))
        return null;
      const range = document.createRange();
      range.selectNodeContents(field);
      range.setEnd(selection.focusNode, selection.focusOffset);
      return range.toString();
    });
    caretPhases.push({ phase, prefix, state });
    return prefix;
  };
  const afterTabPrefix = await recordCaret("after-rewrite-and-Tab");
  await expect(
    renamed.getByRole("img", { name: "place 4", exact: true }),
  ).toHaveCount(1);
  expect(await retained!.evaluate((node) => node.isConnected)).toBe(true);
  await renamed.focus();
  await recordCaret("after-renamed-focus");
  await renamed.press("Control+z");
  await recordCaret("after-empty-history-Control-z");
  await evidence(page, renamed, info, "F11-caret-phases", { caretPhases });
  expect(afterTabPrefix).toBe("4 role edited");
  expect(await richNodes(renamed)).toEqual([[4, " role edited"]]);
  await expect(
    renamed.getByRole("img", { name: "place 1", exact: true }),
  ).toHaveCount(0);
  expect(
    await renamed.evaluate((field) => {
      const selection = getSelection();
      const range = document.createRange();
      range.selectNodeContents(field);
      range.setEnd(selection!.focusNode!, selection!.focusOffset);
      return range.toString();
    }),
  ).toBe("4 role edited");
  await page.keyboard.type("X");
  await expect.poll(() => richNodes(renamed)).toEqual([[4, " role editedX"]]);
  await evidence(page, renamed, info, "F11-reference-rewrite", {
    stored: await currentDraft(page),
  });
});

test("gate actual Shift-Delete copies before removing the selected range", async ({
  page,
  browserName,
}, info) => {
  const field = await mount(page, [["ab", { code: "code" }, "cd"]]);
  await choose(field, [0, 0, 1], [0, 2, 1]);
  await trace(field);
  if (browserName === "chromium")
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
  await field.evaluate((field) =>
    field.addEventListener("cut", (event) => {
      (window as any).r7Copied = (
        event as ClipboardEvent
      ).clipboardData?.getData("text/plain");
    }),
  );
  await page.keyboard.press("Shift+Delete");
  const copied = await page.evaluate(() => (window as any).r7Copied ?? null);
  const clipboard =
    browserName === "chromium"
      ? await page.evaluate(() => navigator.clipboard.readText())
      : null;
  await page.evaluate(() => {
    const probe = document.createElement("input");
    probe.setAttribute("aria-label", "Clipboard round trip");
    probe.addEventListener("paste", (event) => {
      (window as any).r7NativePaste = {
        trusted: event.isTrusted,
        text: event.clipboardData?.getData("text/plain"),
      };
    });
    document.body.append(probe);
  });
  const probe = page.getByRole("textbox", {
    name: "Clipboard round trip",
    exact: true,
  });
  await probe.focus();
  await page.keyboard.press("Control+v");
  const nativePaste = await page.evaluate(() => (window as any).r7NativePaste);
  await evidence(page, field, info, "F2-real-cut", {
    copied,
    clipboard,
    nativePaste,
  });
  expect(nativePaste).toEqual({ trusted: true, text: "bcodec" });
  await expect(probe).toHaveValue("bcodec");
  const events = await page.evaluate(() => (window as any).r7Events);
  expect(
    events.some(
      (event: any) =>
        event.type === "cut" && event.trusted && event.preventedAfterHandlers,
    ),
  ).toBe(true);
  expect(copied).toBe("bcodec");
  if (browserName === "chromium") expect(clipboard).toBe("bcodec");
  await expect.poll(() => richNodes(field)).toEqual([["ad"]]);
  await expect(field).toHaveText("ad");
});

for (const backwards of [false, true]) {
  test(`gate real cut then type records ${backwards ? "backward" : "forward"} selection context`, async ({
    page,
  }, info) => {
    const field = await mount(page, [[{ code: "ab" }, "cd"]]);
    await choose(
      field,
      backwards ? [0, 1, 1] : [0, 0, 1],
      backwards ? [0, 0, 1] : [0, 1, 1],
    );
    await trace(field);
    await page.keyboard.press("Shift+Delete");
    const afterCut = await snapshot(field);
    await page.keyboard.type("x");
    await evidence(page, field, info, "F8-cut-context", {
      backwards,
      afterCut,
      threshold: "A cut/Delete affinity difference alone is not a defect.",
    });
    const events = await page.evaluate(() => (window as any).r7Events);
    expect(
      events.some(
        (event: any) =>
          event.type === "cut" && event.trusted && event.preventedAfterHandlers,
      ),
    ).toBe(true);
    expect(
      events.some((event: any) => event.type === "keydown" && event.trusted),
    ).toBe(true);
    await expect(field).toHaveText("axd");
    expect(
      (await richNodes(field))[0].filter((node) => typeof node === "number"),
    ).toEqual([]);
  });
}

test("gate trusted internal drag keeps text when the drop is canceled", async ({
  page,
}, info) => {
  const original: RichText = [["alpha beta gamma delta omega"]];
  const field = await mount(page, original);
  await choose(field, [0, 0, 0], [0, 0, 5]);
  await trace(field);
  const points = await field.evaluate((field) => {
    const text = field.querySelector(".rich-literal")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 1);
    range.setEnd(text, 2);
    const start = range.getBoundingClientRect();
    range.setStart(text, 25);
    range.setEnd(text, 26);
    const end = range.getBoundingClientRect();
    return {
      x: start.x + 2,
      y: start.y + start.height / 2,
      targetX: end.right,
      targetY: end.y + end.height / 2,
    };
  });
  await page.mouse.move(points.x, points.y);
  await page.mouse.down();
  // Native dragging of selected text requires the press to remain held first.
  await page.waitForTimeout(350);
  await page.mouse.move(points.targetX, points.targetY, { steps: 20 });
  await page.mouse.up();
  const events = await page.evaluate(() => (window as any).r7Events);
  await evidence(page, field, info, "F10-trusted-drag", {
    points,
    trustedDropObserved: events.some(
      (event: any) => event.type === "drop" && event.trusted,
    ),
  });
  for (const type of ["dragstart", "dragover", "drop", "dragend"])
    expect(
      events.some((event: any) => event.type === type && event.trusted),
    ).toBe(true);
  expect(
    events.some(
      (event: any) =>
        event.type === "drop" && event.trusted && event.preventedAfterHandlers,
    ),
  ).toBe(true);
  expect(await richNodes(field)).toEqual(original);
  await expect(field).toHaveText("alpha beta gamma delta omega");
});

test("gate S1 stored places 51 and 65535 survive nearby edits and draft reload", async ({
  page,
}, info) => {
  const field = await seed(page, false, true);
  await trace(field);
  await expect(
    field.getByRole("img", { name: "place 51", exact: true }),
  ).toHaveCount(1);
  await expect(
    field.getByRole("img", { name: "place 65535", exact: true }),
  ).toHaveCount(1);
  await field.press("Control+End");
  await field.pressSequentially(" tail");
  await expect
    .poll(async () => (await currentDraft(page)).text)
    .toEqual([[51, " and ", 65535, " tail"]]);
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("checkbox", {
      name: "Read circled numbers as place references",
      exact: true,
    })
    .uncheck();
  await expect(field).toHaveText("{place 51} and {place 65535} tail");
  await field.press("Control+End");
  await field.pressSequentially(" again");
  await page
    .getByRole("checkbox", {
      name: "Read circled numbers as place references",
      exact: true,
    })
    .check();
  await expect
    .poll(async () => (await currentDraft(page)).text)
    .toEqual([[51, " and ", 65535, " tail again"]]);
  await evidence(page, field, info, "S1-high-stored-places", {
    stored: await currentDraft(page),
    threshold:
      "The intentional insertion cap and bare numeric clipboard form are not defects.",
  });
  await page.reload();
  expect((await currentDraft(page)).text).toEqual([
    [51, " and ", 65535, " tail again"],
  ]);
});

test("literal S3 ordinary mode editing keeps invalid numeric notation as text", async ({
  page,
}, info) => {
  const field = await seed(page);
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("checkbox", {
      name: "Read circled numbers as place references",
      exact: true,
    })
    .uncheck();
  await field.press("Control+a");
  await field.press("Backspace");
  await field.pressSequentially("{place 0} and {place 99999}");
  await trace(field);
  await page
    .getByRole("checkbox", {
      name: "Read circled numbers as place references",
      exact: true,
    })
    .check();
  await evidence(page, field, info, "S3-literal-mode-edit", {
    stored: await currentDraft(page),
  });
  await expect(field).toHaveText("{place 0} and {place 99999}");
  await expect(field.getByRole("img")).toHaveCount(0);
  await expect
    .poll(async () => (await currentDraft(page)).text)
    .toEqual([["{place 0} and {place 99999}"]]);
  await page.reload();
  expect((await currentDraft(page)).text).toEqual([
    ["{place 0} and {place 99999}"],
  ]);
});

test("gate T8 literal line-ending and glyph requirements have independent vectors", async ({
  page,
}, info) => {
  const original: RichText = [
    [{ code: "a\r\nb\rc" }, " keep\r\n", 21, 36, 50, 51, 65535],
  ];
  const field = await mount(page, original);
  await choose(field, [0, 0, 1]);
  await trace(field);
  await page.keyboard.type("X");
  await expect
    .poll(() => richNodes(field))
    .toEqual([[{ code: "aX\nb\nc" }, " keep\r\n", 21, 36, 50, 51, 65535]]);
  await field.press("Control+a");
  const copied = await field.evaluate((field) => {
    const clipboardData = new DataTransfer();
    const event = new ClipboardEvent("copy", {
      bubbles: true,
      cancelable: true,
      clipboardData,
    });
    // This protocol fixture keeps its supplied data when a constructor discards it.
    if (event.clipboardData !== clipboardData)
      Object.defineProperty(event, "clipboardData", { value: clipboardData });
    field.dispatchEvent(event);
    return clipboardData.getData("text/plain");
  });
  await evidence(page, field, info, "T8-literal-oracles", { copied });
  expect(copied).toBe("aX\nb\nc keep\r\n㉑㊱㊿5165535");
  await expect(
    field.getByRole("img", { name: "place 36", exact: true }),
  ).toHaveText("36");
});

for (const action of [
  "replace-and-commit",
  "cancel",
  "boundary-delete",
  "multiple-range",
  "boundary-cancel",
  "boundary-replacement",
  "boundary-duplicate",
  "dirty-multiple-range",
] as const) {
  test(`composition actual Chromium pending text ${action}`, async ({
    page,
    browserName,
  }, info) => {
    test.skip(
      browserName !== "chromium",
      "Chromium CDP supplies actual pending text. Firefox has a separate protocol fixture.",
    );
    const untouched = { url: "https://example.org/", label: "outside\r\n" };
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
      await expect(field.locator(".rich-code")).toContainText("漢字");
      const pending = await snapshot(field);
      if (action === "replace-and-commit") {
        await cdp.send("Input.imeSetComposition", {
          text: "漢",
          selectionStart: 1,
          selectionEnd: 1,
        });
        await cdp.send("Input.insertText", { text: "漢" });
      } else if (action === "cancel") {
        await cdp.send("Input.imeSetComposition", {
          text: "",
          selectionStart: 0,
          selectionEnd: 0,
        });
      } else {
        // This boundary intent is a protocol fixture over real pending text, not a physical IME sequence.
        await field.evaluate((field, action) => {
          const code = field.querySelector(".rich-code")!.firstChild!;
          const outside = field.querySelector(".rich-web-link")!.firstChild!;
          (window as any).r7PendingCode = code;
          const event = new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: action !== "dirty-multiple-range",
            inputType: "deleteCompositionText",
            isComposing: true,
          });
          if (event.inputType !== "deleteCompositionText")
            Object.defineProperty(event, "inputType", {
              value: "deleteCompositionText",
            });
          Object.defineProperty(event, "getTargetRanges", {
            value: () =>
              action === "multiple-range" || action === "dirty-multiple-range"
                ? [
                    new StaticRange({
                      startContainer: code,
                      startOffset: 1,
                      endContainer: code,
                      endOffset: 2,
                    }),
                    new StaticRange({
                      startContainer: outside,
                      startOffset: 0,
                      endContainer: outside,
                      endOffset: 1,
                    }),
                  ]
                : [
                    new StaticRange({
                      startContainer: code,
                      startOffset: 0,
                      endContainer: outside,
                      endOffset: 0,
                    }),
                  ],
          });
          field.dispatchEvent(event);
          if (action === "boundary-duplicate") field.dispatchEvent(event);
          if (action === "dirty-multiple-range") {
            code.textContent = "a字b";
            const dirty = new InputEvent("input", {
              bubbles: true,
              inputType: "deleteCompositionText",
              isComposing: true,
            });
            // This protocol fixture retains the type if the constructor drops it.
            if (dirty.inputType !== "deleteCompositionText")
              Object.defineProperty(dirty, "inputType", {
                value: "deleteCompositionText",
              });
            field.dispatchEvent(dirty);
          }
        }, action);
        const afterBoundaryIntent = await snapshot(field);
        const compositionNodeRetained = await field.evaluate((field) =>
          field.contains((window as any).r7PendingCode),
        );
        await evidence(page, field, info, "F6-pending-intent", {
          action,
          pending,
          afterBoundaryIntent,
          compositionNodeRetained,
        });
        expect(compositionNodeRetained).toBe(true);
        expect(afterBoundaryIntent.nodes).toEqual(pending.nodes);
        if (action !== "dirty-multiple-range")
          expect(afterBoundaryIntent.dom).toBe(pending.dom);
        if (action === "boundary-cancel")
          await cdp.send("Input.imeSetComposition", {
            text: "",
            selectionStart: 0,
            selectionEnd: 0,
          });
        else if (action === "dirty-multiple-range") {
          // Script damage ends native composition. Commit this dirty protocol
          // explicitly, rather than treating a later ordinary CDP insertion as its end.
          await field.evaluate((field) =>
            field.dispatchEvent(
              new CompositionEvent("compositionend", {
                bubbles: true,
                data: "漢字",
              }),
            ),
          );
        } else {
          if (action === "boundary-replacement")
            await cdp.send("Input.imeSetComposition", {
              text: "漢",
              selectionStart: 1,
              selectionEnd: 1,
            });
          await cdp.send("Input.insertText", {
            text: action === "boundary-replacement" ? "漢" : "漢字",
          });
        }
        const applied =
          action === "boundary-delete" || action === "boundary-duplicate";
        const committed = [
          [
            {
              code:
                action === "boundary-cancel"
                  ? "ab"
                  : action === "boundary-replacement"
                    ? "a漢b"
                    : "a漢字b",
            },
          ],
          [untouched],
        ];
        const expected = applied ? [[{ code: "" }, untouched]] : committed;
        await expect.poll(() => richNodes(field)).toEqual(expected);
        await evidence(page, field, info, "F6-after-commit", {
          action,
          expected,
          statuses: await page.locator('[role="status"]').evaluateAll((nodes) =>
            nodes.map((node) => ({
              text: node.textContent,
              hidden: (node as HTMLElement).hidden,
              visibility: getComputedStyle(node).visibility,
            })),
          ),
        });
        await expect(field.locator(".rich-web-link")).toHaveText("outside\r\n");
        if (applied) {
          await field.press("Control+z");
          await expect.poll(() => richNodes(field)).toEqual(committed);
          await field.press("Control+Shift+z");
          await expect.poll(() => richNodes(field)).toEqual(expected);
        } else {
          await expect(
            page
              .locator(".rich-field > p.hint")
              .filter({ hasText: "try again" }),
          ).toContainText("try again");
        }
        await evidence(page, field, info, "F6-settled-intent", {
          action,
          expected,
        });
        if (action === "dirty-multiple-range") {
          await choose(field, [0, 0, 3]);
          await page.keyboard.type("X");
          await evidence(
            page,
            field,
            info,
            "F6-dirty-protocol-then-native-input",
            {
              limit:
                "The complete commit is an explicit synthetic compositionend after script damage. X is separate real keyboard input.",
            },
          );
          const events = await page.evaluate(() => (window as any).r7Events);
          expect(
            events.some(
              (event: any) =>
                event.type === "beforeinput" &&
                event.inputType === "insertText" &&
                event.data === "X" &&
                event.trusted &&
                !event.isComposing &&
                event.preventedAfterHandlers,
            ),
          ).toBe(true);
          await expect
            .poll(() => richNodes(field))
            .toEqual([[{ code: "a漢字Xb" }], [untouched]]);
        }
        return;
      }
      await evidence(page, field, info, "F6-native-pending", {
        action,
        pending,
      });
      const events = await page.evaluate(() => (window as any).r7Events);
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
            event.type === "compositionend" &&
            event.data === (action === "cancel" ? "" : "漢"),
        ),
      ).toBe(true);
      await expect
        .poll(() => richNodes(field))
        .toEqual([
          [{ code: action === "cancel" ? "ab" : "a漢b" }],
          [untouched],
        ]);
      await expect(field.locator(".rich-code")).toHaveText(
        action === "cancel" ? "ab" : "a漢b",
      );
    } finally {
      await cdp.detach();
    }
  });
}

for (const [token, expected] of [
  ["____", [[1, "_"]]],
  ["__50___", [[50, "_"]]],
] as const) {
  test(`token S2 actual Chromium commit ${token} keeps incremental order`, async ({
    page,
    browserName,
  }, info) => {
    test.skip(
      browserName !== "chromium",
      "This case uses Chromium CDP. Unit tests cover the portable commit protocol.",
    );
    const field = await mount(page, []);
    await field.focus();
    await trace(field);
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Input.imeSetComposition", {
        text: token,
        selectionStart: token.length,
        selectionEnd: token.length,
      });
      await expect(field).toHaveText(token);
      const pending = await snapshot(field);
      await cdp.send("Input.insertText", { text: token });
      await evidence(page, field, info, "S2-native-overlong-commit", {
        token,
        pending,
      });
      await expect.poll(() => richNodes(field)).toEqual(expected);
      await expect(field.getByRole("img")).toHaveCount(1);
      await expect(field).toHaveText(token === "____" ? "1_" : "50_");
      await field.press("Backspace");
      await expect.poll(() => richNodes(field)).toEqual([[token]]);
      await expect(field).toHaveText(token);
      await evidence(page, field, info, "S2-following-backspace", { token });
    } finally {
      await cdp.detach();
    }
  });
}

test("composition Firefox protocol fixture includes pending DOM text", async ({
  page,
  browserName,
}, info) => {
  test.skip(
    browserName !== "firefox",
    "Firefox protocol fixture only. Chromium uses CDP pending text.",
  );
  const field = await mount(page, [[{ code: "ab" }], ["outside\r\n"]]);
  await choose(field, [0, 0, 1]);
  await trace(field);
  const observations = await field.evaluate((field) => {
    field.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true, data: "" }),
    );
    const text = field.querySelector(".rich-code")!.firstChild!;
    const start = new InputEvent("beforeinput", {
      bubbles: true,
      inputType: "insertCompositionText",
      data: "漢字",
      isComposing: true,
    });
    Object.defineProperty(start, "getTargetRanges", {
      value: () => [
        new StaticRange({
          startContainer: text,
          startOffset: 1,
          endContainer: text,
          endOffset: 1,
        }),
      ],
    });
    field.dispatchEvent(start);
    text.textContent = "a漢字b";
    field.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertCompositionText",
        data: "漢字",
        isComposing: true,
      }),
    );
    const pendingDOM = field.textContent;
    const outside = field.querySelectorAll(".rich-literal")[0].firstChild!;
    const deletion = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "deleteCompositionText",
      isComposing: true,
    });
    if (deletion.inputType !== "deleteCompositionText")
      Object.defineProperty(deletion, "inputType", {
        value: "deleteCompositionText",
      });
    Object.defineProperty(deletion, "getTargetRanges", {
      value: () => [
        new StaticRange({
          startContainer: text,
          startOffset: 0,
          endContainer: outside,
          endOffset: 0,
        }),
      ],
    });
    field.dispatchEvent(deletion);
    const afterDeletionDOM = field.textContent;
    field.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "漢字" }),
    );
    return {
      pendingDOM,
      afterDeletionDOM,
      prevented: deletion.defaultPrevented,
      limit:
        "All events and DOM mutation in this fixture are synthetic. This proves no physical-device sequence.",
    };
  });
  await evidence(page, field, info, "F6-firefox-protocol-only", observations);
  expect(observations.afterDeletionDOM).toBe(observations.pendingDOM);
  await expect
    .poll(() => richNodes(field))
    .toEqual([[{ code: "a漢字b" }], ["outside\r\n"]]);
  await expect(
    page.locator(".rich-field > p.hint").filter({ hasText: "try again" }),
  ).toContainText("try again");
});

test("biography L2 a name-only signed profile edit preserves stored whitespace", async ({
  page,
}, info) => {
  await page.goto("/");
  await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { createKey } = await import(String("/src/data/keys.ts"));
    const { outboxItem } = await import(String("/src/data/lifecycle.ts"));
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const created = await createKey("test passphrase with spaces");
    await store.put("keys", "selected", created.backup);
    const prepared = core.prepareSigning(
      created.backup.identity,
      [],
      Array.from(crypto.getRandomValues(new Uint8Array(16)), (n: number) =>
        n.toString(16).padStart(2, "0"),
      ).join(""),
      { kind: "identity.profile" },
      { name: "Whitespace Tester", bio: [[" \t"]], links: [] },
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign("Ed25519", created.key, prepared.signing_bytes),
    );
    const item = outboxItem(
      core.finishSigning(prepared, signature),
      crypto.randomUUID(),
      0,
      {
        self: {
          origin: location.origin,
          base: "/api/v1",
          label: "this server",
        },
      },
    );
    await store.queueGroup([item]);
  }, corePath);
  await page.goto("/outbox");
  const deliveryStates: unknown[] = [];
  let previousDelivery = "";
  try {
    // The first attempt can take 20 seconds. Its 15-second retry delay starts
    // at attempt start, so those waits overlap. Allow the larger wait, then
    // a 20-second receipt lookup, a possible 20-second resend, and 5 seconds
    // for scheduling and polling. Keep the accepted assertion without test retries.
    const deliveryTimeout = Math.max(20000, 15000) + 20000 + 20000 + 5000;
    await expect
      .poll(
        async () => {
          const peer = await page.evaluate(async () => {
            const { LocalStore } = await import(String("/src/data/store.ts"));
            return (await new LocalStore().list("outbox"))[0]?.peers.self;
          });
          const state = JSON.stringify(peer);
          if (state !== previousDelivery) {
            deliveryStates.push({ observedAt: Date.now(), peer });
            previousDelivery = state;
          }
          return peer?.state;
        },
        { timeout: deliveryTimeout },
      )
      .toBe("accepted");
  } finally {
    await info.attach("L2-initial-delivery-states", {
      contentType: "application/json",
      body: JSON.stringify(deliveryStates, null, 2),
    });
  }
  await page.goto("/identity");
  await page
    .getByLabel("Passphrase", { exact: true })
    .fill("test passphrase with spaces");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByText("Unlocked", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Whitespace Tester",
  );
  await page.getByRole("link", { name: "Edit public profile" }).click();
  const editor = page.getByRole("region", { name: "Edit public profile" });
  const bio = editor.getByLabel("Biography", { exact: true });
  expect(await richNodes(bio)).toEqual([[" \t"]]);
  await bio.dispatchEvent("input");
  expect(await richNodes(bio)).toEqual([[" \t"]]);
  await editor.getByLabel("Name", { exact: true }).fill("Renamed Tester");
  await editor
    .getByRole("button", { name: "Preview the signed claim" })
    .click();
  await page
    .getByRole("region", { name: "Profile preview" })
    .getByRole("button", { name: "Sign and publish the profile" })
    .click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status").last()).toContainText(
    "The profile is signed and published.",
  );
  const bodies = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return (await new LocalStore().list("outbox")).map(
      (item: any) => JSON.parse(item.transport).body,
    );
  });
  await info.attach("L2-signed-profile-bodies", {
    contentType: "application/json",
    body: JSON.stringify(bodies, null, 2),
  });
  expect(
    bodies.find((body: any) => body.name === "Renamed Tester")?.bio,
  ).toEqual([[" \t"]]);
});

test("composition settled deletion persists the exact draft and survives reload", async ({
  page,
  browserName,
}, info) => {
  test.skip(
    browserName !== "chromium",
    "Chromium CDP supplies actual pending text. Firefox protocol coverage is separate.",
  );
  await seed(page);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const draft = await store.get("drafts", "current");
    draft.text = [
      [{ code: "ab" }],
      [{ url: "https://example.org/", label: "outside\r\n" }],
    ];
    await store.put("drafts", "current", draft);
  });
  await page.reload();
  const field = page.getByRole("textbox", {
    name: "Definition text",
    exact: true,
  });
  await choose(field, [0, 0, 1]);
  await trace(field);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.imeSetComposition", {
      text: "漢字",
      selectionStart: 2,
      selectionEnd: 2,
    });
    await expect
      .poll(() => richNodes(field))
      .toEqual([
        [{ code: "a漢字b" }],
        [{ url: "https://example.org/", label: "outside\r\n" }],
      ]);
    await field.evaluate((field) => {
      const code = field.querySelector(".rich-code")!.firstChild!;
      const link = field.querySelector(".rich-web-link")!.firstChild!;
      const event = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "deleteCompositionText",
        isComposing: true,
      });
      if (event.inputType !== "deleteCompositionText")
        Object.defineProperty(event, "inputType", {
          value: "deleteCompositionText",
        });
      Object.defineProperty(event, "getTargetRanges", {
        value: () => [
          new StaticRange({
            startContainer: code,
            startOffset: 0,
            endContainer: link,
            endOffset: 0,
          }),
        ],
      });
      field.dispatchEvent(event);
    });
    await cdp.send("Input.insertText", { text: "漢字" });
    const expected = [
      [{ code: "" }, { url: "https://example.org/", label: "outside\r\n" }],
    ];
    await expect
      .poll(async () => (await currentDraft(page)).text)
      .toEqual(expected);
    await evidence(page, field, info, "F6-draft-persistence", {
      stored: await currentDraft(page),
    });
    await page.reload();
    expect((await currentDraft(page)).text).toEqual(expected);
    await expect(
      page
        .getByRole("textbox", { name: "Definition text", exact: true })
        .locator(".rich-web-link"),
    ).toHaveText("outside\r\n");
  } finally {
    await cdp.detach();
  }
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`design compact toolbar, reserved focus space and six-column grid in ${colorScheme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 900 });
    await page.emulateMedia({ colorScheme });
    const field = await seed(page);
    const mainToolbar = page.getByRole("toolbar", {
      name: "Definition text formatting",
      exact: true,
    });
    await expect(mainToolbar).toBeVisible();
    const description = page.getByRole("textbox", {
      name: "Description for place 1",
      exact: true,
    });
    const secondaryToolbar = page.getByRole("toolbar", {
      name: "Description for place 1 formatting",
      exact: true,
      includeHidden: true,
    });
    await expect(secondaryToolbar).toBeHidden();
    const documentY = () =>
      description.evaluate((node) => node.getBoundingClientRect().y + scrollY);
    const before = await documentY();
    await description.focus();
    await expect(secondaryToolbar).toBeVisible();
    expect(await documentY()).toBe(before);
    await field.focus();
    await expect(secondaryToolbar).toBeHidden();
    await expect(
      page.getByText(
        "Type ___ for the next free place, __N__ for place N, or ① to ㊿. Paste can keep circled numbers literal.",
        { exact: true },
      ),
    ).toHaveCount(1);
    const controls = await mainToolbar.getByRole("button").all();
    const rows = new Set<number>();
    for (const control of controls) {
      const box = (await control.boundingBox())!;
      rows.add(Math.round(box.y));
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    expect(rows.size).toBeLessThan(4);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const more = mainToolbar.getByRole("button", {
      name: "More places",
      exact: true,
    });
    await more.click();
    const grid = page.getByRole("grid", { name: "Places 4 to 50" });
    await expect(grid.getByRole("gridcell")).toHaveCount(47);
    const gridRows = await grid.getByRole("row").evaluateAll((rows) =>
      rows.map((row) =>
        [...row.children].map((cell) => {
          const { x, y, width, height } = cell.getBoundingClientRect();
          return { x, y, width, height };
        }),
      ),
    );
    expect(gridRows).toHaveLength(8);
    expect(gridRows[0]).toHaveLength(6);
    for (const [index, row] of gridRows.entries()) {
      expect(row).toHaveLength(index === gridRows.length - 1 ? 5 : 6);
      for (const [column, cell] of row.entries()) {
        expect(cell.width).toBeGreaterThanOrEqual(44);
        expect(cell.height).toBeGreaterThanOrEqual(44);
        expect(Math.abs(cell.x - gridRows[0][column].x)).toBeLessThanOrEqual(1);
        expect(Math.abs(cell.y - row[0].y)).toBeLessThanOrEqual(1);
        if (column)
          expect(cell.x).toBeGreaterThanOrEqual(
            row[column - 1].x + row[column - 1].width,
          );
      }
      if (index)
        expect(row[0].y).toBeGreaterThanOrEqual(
          gridRows[index - 1][0].y + gridRows[index - 1][0].height,
        );
    }
    expect(
      await grid.evaluate(
        (node) => getComputedStyle(node).gridTemplateColumns.split(" ").length,
      ),
    ).toBe(6);
    await expect(
      grid.getByRole("button", { name: "Place 4", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(
      grid.getByRole("button", { name: "Place 10", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(more).toBeFocused();
    await more.press("Enter");
    await page.keyboard.press("End");
    await page.keyboard.press("Home");
    await expect(
      grid.getByRole("button", { name: "Place 4", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("End");
    await page.keyboard.press("Space");
    await expect(grid).toBeHidden();
    await expect(
      field.getByRole("img", { name: "place 50", exact: true }),
    ).toHaveCount(1);
    await expect(field).toBeFocused();
    for (const size of [16, 21]) {
      await field.evaluate((node, size) => {
        (node as HTMLElement).style.fontSize = `${size}px`;
      }, size);
      const geometry = await field.evaluate((node) => {
        const one = node.querySelector<HTMLElement>('[data-place="1"]')!;
        const two = node.querySelector<HTMLElement>('[data-place="50"]')!;
        const box = one.getBoundingClientRect();
        return {
          height: box.height,
          width: box.width,
          wide: two.getBoundingClientRect().width,
          line: node.querySelector("p")!.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(getComputedStyle(node).lineHeight),
        };
      });
      expect(Math.abs(geometry.height - size * 1.45)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.width - geometry.height)).toBeLessThanOrEqual(1);
      expect(geometry.wide).toBeGreaterThan(geometry.width);
      expect(geometry.lineHeight).toBe(size * 1.5);
      expect(Math.abs(geometry.line - geometry.lineHeight)).toBeLessThanOrEqual(
        1,
      );
    }
    const chip = field.getByRole("img", { name: "place 1", exact: true });
    await chip.click();
    await expect(chip).toHaveClass(/ProseMirror-selectednode/);
    const selected = await chip.evaluate((node) => {
      const style = getComputedStyle(node);
      const probe = document.createElement("span");
      probe.style.color = style.getPropertyValue("--focus");
      document.body.append(probe);
      const focus = getComputedStyle(probe).color;
      probe.remove();
      return {
        outline: style.outlineColor,
        width: style.outlineWidth,
        offset: style.outlineOffset,
        shadow: style.boxShadow,
        focus,
      };
    });
    expect(selected).toEqual({
      outline: selected.focus,
      width: "2px",
      offset: "1px",
      shadow: "none",
      focus: selected.focus,
    });
    const hintId = await mainToolbar.getAttribute("aria-describedby");
    const instructions = page.locator(`[id="${hintId}"]`);
    await expect(instructions).toHaveClass("sr");
    expect((await instructions.boundingBox())!.height).toBeLessThanOrEqual(1);
    await expect(mainToolbar).toHaveAccessibleDescription(
      /Use Left, Right, Home, and End/,
    );
    await page
      .getByRole("button", { name: "Remove operand 1", exact: true })
      .click();
    await expect(
      mainToolbar.getByRole("button", {
        name: "Insert operand",
        exact: true,
        includeHidden: true,
      }),
    ).toBeHidden();
  });
}

test("dialog multiline label keeps its exact stored value on target edits", async ({
  page,
}) => {
  const field = await mount(page, [
    [{ url: "https://example.org/old", label: "first\r\nlast" }],
  ]);
  await choose(field, [0, 0, 1]);
  await page.getByRole("button", { name: "Edit link", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit link", exact: true });
  expect(
    await dialog
      .getByLabel("Link label", { exact: true })
      .evaluate((node) => node.tagName),
  ).toBe("TEXTAREA");
  await dialog
    .getByLabel("HTTPS address", { exact: true })
    .fill("https://example.org/new");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  expect(await richNodes(field)).toEqual([
    [{ url: "https://example.org/new", label: "first\r\nlast" }],
  ]);
});
