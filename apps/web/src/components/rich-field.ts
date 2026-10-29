/** One accessible editor per rich field. The draft owns its RichText value. */
import { Slice } from "prosemirror-model";
import { EditorState, Plugin, TextSelection } from "prosemirror-state";
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
  pastedRichText,
  placeInputPlugins,
  replaceInline,
  richEditorSchema,
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
  const rulePlugins = placeInputPlugins({
    enabled,
    composing: () => view?.composing ?? false,
  });
  const state = () =>
    EditorState.create({
      doc: richToEditor(current),
      plugins: [
        ...rulePlugins,
        new Plugin({
          props: {
            handleTextInput(view, from, to, value) {
              if (view.composing) return false;
              const { selection } = view.state;
              const previous = selection.$from.nodeBefore;
              // Native DOM input can inherit the previous code or link style.
              if (
                selection.empty &&
                selection.$from.parent.isTextblock &&
                previous?.isInline &&
                !previous.isText &&
                !previous.isAtom &&
                from === to &&
                to === selection.from - 1
              )
                from = to = selection.from;
              view.dispatch(
                view.state.tr.insertText(value, from, to).scrollIntoView(),
              );
              return true;
            },
          },
        }),
        history(),
        keymap({
          "Mod-End": (state, dispatch) => {
            dispatch?.(state.tr.setSelection(TextSelection.atEnd(state.doc)));
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
  const placeControls: (HTMLButtonElement | HTMLSelectElement)[] = [];
  let placeMenu: HTMLSelectElement | undefined;
  const syncMode = () => {
    for (const control of placeControls) control.disabled = !enabled();
    if (placeMenu) {
      const declared = new Set(options.places?.() ?? []);
      for (const option of placeMenu.options) {
        const label = `Place ${option.value}${declared.has(Number(option.value)) ? " (declared)" : ""}`;
        if (option.textContent !== label) option.textContent = label;
      }
    }
  };
  view = new EditorView(host, {
    state: state(),
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
      if (result.transactions.some((tr) => tr.docChanged)) {
        current = editorToRich(view.state.doc);
        view.dom.dispatchEvent(new Event("input", { bubbles: true }));
      }
    },
    handleDOMEvents: {
      compositionstart() {
        view.dispatch(view.state.tr.setMeta("richCompositionStart", true));
        return false;
      },
      paste(_view, event) {
        event.preventDefault();
        const pasted = event.clipboardData?.getData("text/plain") ?? "";
        if (enabled() && CIRCLED.test(pasted)) pasteDialog(pasted);
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
  input.style.minHeight = `${Math.max(2, options.rows ?? 3) * 1.7 + 1}em`;
  if (options.spellcheck === false) input.spellcheck = false;
  Object.defineProperty(input, "value", {
    get: () => current,
    set: (value: RichText) => {
      current = value;
      if (view.isDestroyed) return;
      const mode = enabled();
      // External draft changes start a new history for this field.
      if (mode !== previousMode || !view.state.doc.eq(richToEditor(value)))
        view.updateState(state());
      previousMode = mode;
      syncMode();
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
      toolbar.append(operand);
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
  syncMode();

  function openDialog(
    title: string,
    invoker: HTMLElement,
    fields: HTMLElement[],
    submit: () => boolean,
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
      text: "Insert",
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
    const doc = richToEditor(pastedRichText(text, convert));
    const tr = view.state.tr
      .replaceSelection(new Slice(doc.content, 1, 1))
      .setMeta("uiEvent", "paste");
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
