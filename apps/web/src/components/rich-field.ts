/** One accessible editor per rich field. The draft owns its RichText value. */
import "prosemirror-view/style/prosemirror.css";
import { Slice, type Node as EditorNode } from "prosemirror-model";
import {
  EditorState,
  Plugin,
  TextSelection,
  type Selection,
} from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { baseKeymap } from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { undoInputRule } from "prosemirror-inputrules";
import { button, el, field, fieldId, type FieldOptions } from "../lib/dom.ts";
import { onDisconnect } from "../lib/lifetime.ts";
import { CIRCLED, placeGlyph } from "../model/place-glyphs.ts";
import {
  editorToRich,
  deleteRichBackward,
  deleteRichForward,
  pastedRichText,
  placeInputPlugins,
  replaceInline,
  richEditorSchema,
  richInsertionSelection,
  richToEditor,
} from "../model/rich-editor.ts";
import type { RichText } from "../model/types.ts";

export interface RichFieldOptions extends Omit<
  FieldOptions,
  "value" | "options"
> {
  value: RichText;
  structured?: boolean | (() => boolean);
  local?: boolean;
  places?: () => number[];
  operands?: () => string[];
}
export interface RichInput extends HTMLDivElement {
  value: RichText;
}
/** Native selection changes can still be pending when beforeinput runs. */
function insertionSelection(view: EditorView, input: InputEvent) {
  const target = input.getTargetRanges?.()[0];
  const selection = view.dom.ownerDocument.getSelection();
  const range =
    target ?? (selection?.rangeCount ? selection.getRangeAt(0) : null);
  if (
    !range ||
    !view.dom.contains(range.startContainer) ||
    !view.dom.contains(range.endContainer)
  )
    return view.state.selection;
  try {
    const from = view.posAtDOM(range.startContainer, range.startOffset, -1);
    const to = range.collapsed
      ? from
      : view.posAtDOM(range.endContainer, range.endOffset, 1);
    return richInsertionSelection(view.state, from, to);
  } catch {
    // Let the native input path read DOM changes that are not mapped yet.
    return null;
  }
}
/** ProseMirror can reuse a link's span when only its label changes. */
function linkNodeView(node: EditorNode) {
  const type = node.type.name;
  const word = type === "word_link";
  const dom = el("span", {
    class: word ? "rich-word-link" : "rich-web-link",
    role: "group",
    "aria-roledescription": word ? "word link" : "web link",
  });
  const update = (next: EditorNode) => {
    if (next.type.name !== type) return false;
    const target = word ? next.attrs.word.spelling : next.attrs.url;
    dom.title = word ? `Word: ${target}` : target;
    dom.setAttribute("data-target", target);
    dom.setAttribute(
      "aria-label",
      `${next.textContent || "Empty label"}, ${word ? "word" : "web"} link to ${target}`,
    );
    return true;
  };
  update(node);
  return { dom, contentDOM: dom, update };
}
export function richField(label: string, options: RichFieldOptions) {
  const id = fieldId("rich"),
    labelId = `${id}-label`,
    hintId = `${id}-hint`;
  const labelNode = el("label", {
    id: labelId,
    for: id,
    class: options.labelClass ?? "field-label",
    text: label,
  });
  const toolbar = el("div", {
    role: "toolbar",
    "aria-label": `${label} formatting`,
    class: "rich-toolbar",
  });
  const host = el("div", { class: "rich-host" });
  const toolbarHintId = `${id}-toolbar-hint`;
  const toolbarHint = el("p", {
    id: toolbarHintId,
    class: "hint",
    text: "Use Left, Right, Home, and End to move through the toolbar. In More places, use Alt with those keys.",
  });
  toolbar.setAttribute("aria-describedby", toolbarHintId);
  const hint = el("p", {
    id: hintId,
    class: "hint",
    text:
      options.hint ??
      (options.local === false
        ? "Use the controls to insert links and code. Pasted text stays literal."
        : "Type ___ for the next free place, __N__ for place N, or ① to ㊿. Paste can keep circled numbers literal."),
  });
  const wrapper = el(
    "div",
    { class: options.wrapperClass ?? "field-group" },
    labelNode,
    toolbar,
    toolbarHint,
    host,
    hint,
  );
  const enabled = () =>
    options.local !== false &&
    (typeof options.structured === "function"
      ? options.structured()
      : options.structured !== false);
  let previousMode = enabled();
  let view: EditorView;
  let current = options.value;
  let dialog: HTMLDialogElement | null = null;
  let editLink: HTMLButtonElement | undefined;
  const rulePlugins = placeInputPlugins({
    enabled,
    composing: () => view?.composing ?? false,
  });
  const state = (doc = richToEditor(current), selection?: Selection) => {
    return EditorState.create({
      doc,
      selection: selection ?? TextSelection.atEnd(doc),
      plugins: [
        ...rulePlugins,
        new Plugin({
          props: {
            handleTextInput(view, from, to, value) {
              if (view.composing) return false;
              const selection = richInsertionSelection(view.state, from, to);
              view.dispatch(
                view.state.tr
                  .setSelection(selection)
                  .insertText(value)
                  .scrollIntoView(),
              );
              return true;
            },
          },
        }),
        history(),
        keymap({
          "Mod-End": (state, dispatch, view) => {
            dispatch?.(state.tr.setSelection(TextSelection.atEnd(state.doc)));
            // Native focus can differ when the model already has this selection.
            view?.focus();
            return true;
          },
          "Mod-Home": (state, dispatch, view) => {
            dispatch?.(
              state.tr.setSelection(TextSelection.create(state.doc, 1)),
            );
            view?.focus();
            return true;
          },
          Home: (state, dispatch) => {
            const { $from, empty } = state.selection;
            if (!empty || !$from.parent.isInline || $from.parentOffset !== 0)
              return false;
            dispatch?.(
              state.tr.setSelection(
                TextSelection.create(state.doc, $from.before()),
              ),
            );
            return true;
          },
          ArrowLeft: (state, dispatch) => {
            const { $from, empty } = state.selection;
            if (!empty || !$from.parent.isInline || $from.parentOffset !== 0)
              return false;
            dispatch?.(
              state.tr.setSelection(
                TextSelection.create(state.doc, $from.before()),
              ),
            );
            return true;
          },
          ArrowRight: (state, dispatch) => {
            const { $from, empty } = state.selection;
            if (
              !empty ||
              !$from.parent.isInline ||
              $from.parentOffset !== $from.parent.content.size
            )
              return false;
            dispatch?.(
              state.tr.setSelection(
                TextSelection.near(state.doc.resolve($from.after()), 1),
              ),
            );
            return true;
          },
          "Shift-Enter": (state, dispatch) => {
            dispatch?.(state.tr.insertText("\n"));
            return true;
          },
          Enter: (state, dispatch) => {
            if (
              !["code", "word_link", "web_link"].includes(
                state.selection.$from.parent.type.name,
              )
            )
              return false;
            dispatch?.(state.tr.insertText("\n"));
            return true;
          },
          Backspace: (state, dispatch) =>
            undoInputRule(
              state,
              dispatch && ((tr) => dispatch(tr.setMeta("richRuleUndo", true))),
            ) || deleteRichBackward(state, dispatch),
          Delete: deleteRichForward,
          "Mod-z": (state, dispatch) =>
            undo(
              state,
              dispatch && ((tr) => dispatch(tr.setMeta("richRuleUndo", true))),
            ),
          "Shift-Mod-z": (state, dispatch) =>
            redo(
              state,
              dispatch && ((tr) => dispatch(tr.setMeta("richRuleUndo", true))),
            ),
          "Mod-y": (state, dispatch) =>
            redo(
              state,
              dispatch && ((tr) => dispatch(tr.setMeta("richRuleUndo", true))),
            ),
        }),
        keymap(baseKeymap),
      ],
    });
  };
  const placeControls: (HTMLButtonElement | HTMLSelectElement)[] = [];
  let placeMenu: HTMLSelectElement | undefined;
  let operandControl: HTMLButtonElement | undefined;
  let operandReason: HTMLElement | undefined;
  let activeToolbarControl: HTMLElement | undefined;
  const toolbarControls = () =>
    [
      ...toolbar.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(
        "button,select",
      ),
    ].filter((node) => !node.disabled && !node.hidden);
  const rove = (control?: HTMLElement) => {
    const controls = toolbarControls();
    activeToolbarControl =
      control && controls.includes(control as HTMLButtonElement)
        ? control
        : controls.includes(activeToolbarControl as HTMLButtonElement)
          ? activeToolbarControl
          : controls[0];
    for (const node of toolbar.querySelectorAll<HTMLElement>("button,select"))
      node.tabIndex = node === activeToolbarControl ? 0 : -1;
  };
  const syncMode = () => {
    for (const control of placeControls) control.disabled = !enabled();
    if (placeMenu) {
      const declared = new Set(options.places?.() ?? []);
      for (const option of placeMenu.options) {
        const label = `Place ${option.value}${declared.has(Number(option.value)) ? " (declared)" : ""}`;
        if (option.textContent !== label) option.textContent = label;
      }
    }
    if (operandControl)
      operandControl.disabled = !enabled() || !options.operands?.().length;
    if (operandReason) operandReason.hidden = !!options.operands?.().length;
    hint.textContent =
      !enabled() && options.local !== false
        ? "Literal mode keeps typed characters as text. Pasted text stays literal."
        : (options.hint ??
          (options.local === false
            ? "Use the controls to insert links and code. Pasted text stays literal."
            : "Type ___ for the next free place, __N__ for place N, or ① to ㊿. Paste can keep circled numbers literal."));
    rove();
  };
  view = new EditorView(host, {
    state: state(),
    nodeViews: { word_link: linkNodeView, web_link: linkNodeView },
    attributes: {
      id,
      class: "field rich-editor",
      role: "textbox",
      "aria-multiline": "true",
      "aria-labelledby": labelId,
      "aria-describedby": hintId,
      ...(options.lang ? { lang: options.lang } : {}),
    },
    dispatchTransaction(transaction) {
      const result = view.state.applyTransaction(transaction);
      view.updateState(result.state);
      syncLinkAction();
      if (result.transactions.some((tr) => tr.docChanged)) {
        current = editorToRich(view.state.doc);
        view.dom.dispatchEvent(new Event("input", { bubbles: true }));
      }
    },
    handleDOMEvents: {
      focus(view) {
        // Reparenting a retained editor can clear only the native caret.
        view.focus();
        return false;
      },
      beforeinput(view, event) {
        const input = event as InputEvent;
        if (
          !input.cancelable ||
          input.inputType !== "insertText" ||
          input.data === null ||
          input.isComposing ||
          view.composing
        )
          return false;
        const selection = insertionSelection(view, input);
        if (!selection) return false;
        input.preventDefault();
        if (!selection.eq(view.state.selection))
          view.dispatch(view.state.tr.setSelection(selection));
        const { from, to } = view.state.selection;
        const text = input.data;
        const insert = () =>
          view.state.tr.insertText(text, from, to).scrollIntoView();
        if (
          !view.someProp("handleTextInput", (handler) =>
            handler(view, from, to, text, insert),
          )
        )
          view.dispatch(insert());
        return true;
      },
      compositionstart() {
        view.dispatch(view.state.tr.setMeta("richCompositionStart", true));
        return false;
      },
      paste(_view, event) {
        event.preventDefault();
        const pasted = event.clipboardData?.getData("text/plain") ?? "";
        if (!pasted) return true;
        const selection = view.state.selection;
        const inlineContext =
          selection.$from.sameParent(selection.$to) &&
          ["code", "word_link", "web_link"].includes(
            selection.$from.parent.type.name,
          );
        if (enabled() && !inlineContext && CIRCLED.test(pasted))
          pasteDialog(pasted);
        else paste(pasted, false);
        return true;
      },
      drop(_view, event) {
        event.preventDefault();
        return true;
      },
      compositionend() {
        // Android can commit DOM changes without handleTextInput.
        setTimeout(() => {
          if (!view.isDestroyed)
            view.dispatch(view.state.tr.setMeta("richCompositionEnd", true));
        }, 0);
        return false;
      },
    },
  });
  const input = view.dom as RichInput;
  input.style.setProperty(
    "--target-min-height",
    `${Math.max(2, options.rows ?? 3) * 1.7 + 1}em`,
  );
  if (options.spellcheck === false) input.spellcheck = false;
  Object.defineProperty(input, "value", {
    get: () => current,
    set: (value: RichText) => {
      current = value;
      if (view.isDestroyed) return;
      // External draft changes start a new history for this field.
      if (
        JSON.stringify(editorToRich(view.state.doc)) !== JSON.stringify(value)
      )
        view.updateState(state());
      else if (enabled() !== previousMode)
        // Mode changes start a new undo boundary without moving the caret.
        view.updateState(state(view.state.doc, view.state.selection));
      previousMode = enabled();
      syncMode();
      syncLinkAction();
    },
  });
  labelNode.addEventListener("click", () => view.focus());
  const insert = (
    node: ReturnType<typeof richEditorSchema.node>,
    focus = true,
  ) => {
    const { from, to } = view.state.selection;
    view.dispatch(
      replaceInline(view.state, from, to, node)
        .scrollIntoView()
        .setMeta("richExternal", true),
    );
    if (focus) view.focus();
  };
  const addPlace = (index: number) => {
    if (enabled()) insert(richEditorSchema.nodes.place.create({ index }));
  };
  if (options.local !== false) {
    for (const index of [1, 2, 3]) {
      const control = button(placeGlyph(index), () => addPlace(index), {
        class: "btn rich-place-button",
        "aria-label": `Insert place ${index}`,
      });
      placeControls.push(control);
      toolbar.append(control);
    }
    const place = field("More places", {
      value: "4",
      options: Array.from({ length: 47 }, (_, index) => ({
        value: String(index + 4),
        label: `Place ${index + 4}${options.places?.().includes(index + 4) ? " (declared)" : ""}`,
      })),
      wrapperClass: "rich-place-menu",
      labelClass: "sr",
    });
    placeMenu = place.input;
    place.input.addEventListener("focus", syncMode);
    const apply = button(
      "Insert selected place",
      () => addPlace(Number(place.input.value)),
      { class: "btn btn-quiet" },
    );
    placeControls.push(place.input, apply);
    toolbar.append(place.wrapper, apply);
    if (options.operands) {
      const operand = button(
        "Insert operand",
        () => {
          const ids = options.operands!();
          const choice = field("Operand", {
            options: ids.map((id) => ({ value: id, label: id })),
          });
          openDialog("Insert operand", operand, [choice.wrapper], () => {
            if (!choice.input.value) return false;
            insert(
              richEditorSchema.nodes.operand.create({ id: choice.input.value }),
              false,
            );
            return true;
          });
        },
        { class: "btn btn-quiet" },
      );
      placeControls.push(operand);
      operandControl = operand;
      const reasonId = `${id}-operand-reason`;
      operand.setAttribute("aria-describedby", reasonId);
      operandReason = el("span", {
        id: reasonId,
        class: "hint",
        text: "Declare an operand first.",
      });
      toolbar.append(operand);
      wrapper.append(operandReason);
      operand.addEventListener("focus", syncMode);
    }
  }
  const selectedText = () =>
    view.state.doc.textBetween(
      view.state.selection.from,
      view.state.selection.to,
      "\n",
      "",
    );
  const linkWord = button(
    "Link a word",
    () => {
      const spelling = field("Lojban word", {
        value: selectedText(),
        spellcheck: false,
        lang: "jbo",
        required: true,
      });
      const label = field("Link label", {
        value: selectedText(),
        multiline: true,
        rows: 2,
        hint: "The label can be empty.",
      });
      openDialog(
        "Link a word",
        linkWord,
        [spelling.wrapper, label.wrapper],
        () => {
          if (!spelling.input.value.trim()) return false;
          insert(
            richEditorSchema.nodes.word_link.create(
              {
                word: {
                  language: "jbo",
                  spelling: spelling.input.value.trim(),
                },
              },
              label.input.value
                ? richEditorSchema.text(label.input.value)
                : undefined,
            ),
            false,
          );
          return true;
        },
      );
    },
    { class: "btn btn-quiet" },
  );
  const linkWeb = button(
    "Web link",
    () => {
      const target = field("HTTPS address", { type: "url", required: true });
      const label = field("Link label", {
        value: selectedText(),
        multiline: true,
        rows: 2,
        hint: "The label can be empty.",
      });
      const error = el("p", { role: "status", class: "notice", hidden: true });
      openDialog(
        "Web link",
        linkWeb,
        [target.wrapper, label.wrapper, error],
        () => {
          try {
            if (new URL(target.input.value).protocol !== "https:")
              throw new Error();
          } catch {
            error.hidden = false;
            error.textContent = "Enter an HTTPS address.";
            target.input.focus();
            return false;
          }
          insert(
            richEditorSchema.nodes.web_link.create(
              { url: target.input.value },
              label.input.value
                ? richEditorSchema.text(label.input.value)
                : undefined,
            ),
            false,
          );
          return true;
        },
      );
    },
    { class: "btn btn-quiet" },
  );
  const code = button(
    "Insert code",
    () => {
      const content = field("Code", {
        value: selectedText(),
        multiline: true,
        rows: 3,
      });
      openDialog("Insert code", code, [content.wrapper], () => {
        insert(
          richEditorSchema.nodes.code.create(
            null,
            content.input.value
              ? richEditorSchema.text(content.input.value)
              : undefined,
          ),
          false,
        );
        return true;
      });
    },
    { class: "btn btn-quiet" },
  );
  toolbar.append(linkWord, linkWeb, code);
  editLink = button(
    "Edit link",
    () => {
      const existing = selectedLink();
      if (!existing) return;
      const word = existing.node.type.name === "word_link";
      const target = field(word ? "Lojban word" : "HTTPS address", {
        value: word
          ? existing.node.attrs.word.spelling
          : existing.node.attrs.url,
        ...(word ? { lang: "jbo", spellcheck: false } : { type: "url" }),
        required: true,
      });
      const label = field("Link label", {
        value: existing.node.textContent,
        multiline: true,
        rows: 2,
        hint: "The label can be empty.",
      });
      const error = el("p", { role: "status", class: "notice", hidden: true });
      openDialog(
        "Edit link",
        editLink!,
        [target.wrapper, label.wrapper, error],
        () => {
          const value = target.input.value.trim();
          try {
            if (!value || (!word && new URL(value).protocol !== "https:"))
              throw new Error();
          } catch {
            error.hidden = false;
            error.textContent = word
              ? "Enter a Lojban word."
              : "Enter an HTTPS address.";
            target.input.focus();
            return false;
          }
          const replacement = existing.node.type.create(
            word
              ? { word: { language: "jbo", spelling: value } }
              : { url: value },
            label.input.value
              ? richEditorSchema.text(label.input.value)
              : undefined,
          );
          const tr = view.state.tr.replaceWith(
            existing.position,
            existing.position + existing.node.nodeSize,
            replacement,
          );
          tr.setSelection(
            TextSelection.create(
              tr.doc,
              existing.position +
                1 +
                Math.min(existing.offset, replacement.content.size),
            ),
          );
          view.dispatch(tr.setMeta("richExternal", true));
          return true;
        },
        "Save",
      );
    },
    { class: "btn btn-quiet" },
  );
  toolbar.append(editLink);
  toolbar.addEventListener("focusin", (event) => {
    if (
      event.target instanceof HTMLElement &&
      event.target.matches("button,select")
    )
      rove(event.target);
  });
  toolbar.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    if (event.target instanceof HTMLSelectElement && !event.altKey) return;
    const controls = toolbarControls();
    const index = controls.indexOf(event.target as HTMLButtonElement);
    if (index < 0 || !controls.length) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? controls.length - 1
          : (index + (event.key === "ArrowLeft" ? -1 : 1) + controls.length) %
            controls.length;
    rove(controls[next]);
    controls[next].focus();
  });
  syncLinkAction();
  syncMode();

  function selectedLink() {
    const { $from, $to } = view.state.selection;
    if (
      !$from.sameParent($to) ||
      !["word_link", "web_link"].includes($from.parent.type.name)
    )
      return null;
    return {
      node: $from.parent,
      position: $from.before(),
      offset: $from.parentOffset,
    };
  }
  function syncLinkAction() {
    if (!editLink) return;
    editLink.hidden = !selectedLink();
    rove();
  }

  function openDialog(
    title: string,
    invoker: HTMLElement,
    fields: HTMLElement[],
    submit: () => boolean,
    applyText = "Insert",
  ) {
    dialog?.close();
    const node = el("dialog", {
      class: "rich-dialog",
      "aria-labelledby": `${id}-dialog-title`,
    });
    dialog = node;
    const form = el(
      "form",
      {},
      el("h2", { id: `${id}-dialog-title`, class: "section", text: title }),
      ...fields,
    );
    const apply = el("button", {
      type: "submit",
      class: "btn btn-primary",
      text: applyText,
    });
    form.append(
      el(
        "div",
        { class: "actions" },
        apply,
        button("Cancel", () => node.close(), { class: "btn" }),
      ),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (submit()) node.close();
    });
    node.append(form);
    node.addEventListener(
      "close",
      () => {
        node.remove();
        if (dialog === node) dialog = null;
        if (invoker.isConnected) invoker.focus();
      },
      { once: true },
    );
    document.body.append(node);
    node.showModal();
  }
  function paste(text: string, convert: boolean) {
    if (!text) return;
    const { $from, $to } = view.state.selection;
    const inlineContext =
      $from.sameParent($to) &&
      ["code", "word_link", "web_link"].includes($from.parent.type.name);
    const tr = inlineContext
      ? view.state.tr.insertText(text.replace(/\r\n?/gu, "\n"))
      : view.state.tr.replaceSelection(
          new Slice(richToEditor(pastedRichText(text, convert)).content, 1, 1),
        );
    tr.setMeta("uiEvent", "paste");
    tr.setSelection(TextSelection.near(tr.doc.resolve(tr.selection.to), -1));
    view.dispatch(tr.scrollIntoView());
    view.focus();
  }
  function pasteDialog(text: string) {
    const literal = button(
      "Keep literal text",
      () => {
        dialog?.close();
        paste(text, false);
      },
      { class: "btn btn-primary" },
    );
    const convert = button(
      "Convert circled numbers",
      () => {
        dialog?.close();
        paste(text, true);
      },
      { class: "btn" },
    );
    const node: HTMLDialogElement = el(
      "dialog",
      { class: "rich-dialog", "aria-label": "Paste circled numbers" },
      el("p", {
        text: "The pasted text contains circled numbers. Choose how to insert them.",
      }),
      el(
        "div",
        { class: "actions" },
        literal,
        convert,
        button("Cancel", () => node.close(), { class: "btn" }),
      ),
    );
    dialog = node;
    node.addEventListener(
      "close",
      () => {
        node.remove();
        if (dialog === node) dialog = null;
      },
      { once: true },
    );
    document.body.append(node);
    node.showModal();
  }
  onDisconnect(wrapper, () => {
    dialog?.close();
    view.destroy();
  });
  return { wrapper, input, label: labelNode };
}
