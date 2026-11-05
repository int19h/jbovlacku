/** One accessible editor per rich field. The draft owns its RichText value. */
import "prosemirror-view/style/prosemirror.css";
import { Slice, type Node as EditorNode } from "prosemirror-model";
import {
  EditorState,
  Plugin,
  TextSelection,
  type Selection,
  type Transaction,
  type Command,
} from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { baseKeymap } from "prosemirror-commands";
import { history, undo, redo, closeHistory } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { undoInputRule } from "prosemirror-inputrules";
import { button, el, field, fieldId, type FieldOptions } from "../lib/dom.ts";
import { onDisconnect } from "../lib/lifetime.ts";
import { CIRCLED } from "../model/place-glyphs.ts";
import {
  editorToRich,
  editedTextPlugin,
  deleteRichInput,
  isRichDeleteType,
  type RichDeleteType,
  type RichDeleteRange,
  type RichRangeSnapshot,
  snapshotRichRange,
  mapRichRange,
  replaceRichText,
  pastedRichText,
  placeInputPlugins,
  replaceInline,
  richEditorSchema,
  richInsertionSelection,
  sameRichCaret,
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
  main?: boolean;
}
export interface RichInput extends HTMLDivElement {
  value: RichText;
}
/** DOM parsing normalizes CR outside an IME edit. Keep those nodes exact. */
function preserveOutsideNativeEdit(
  transaction: Transaction,
  edit: { doc: EditorNode; from: number; to: number },
) {
  if (transaction.before !== edit.doc) return;
  edit.doc.descendants((node, position) => {
    if (!["literal", "code", "word_link", "web_link"].includes(node.type.name))
      return;
    if (
      !node.textContent.includes("\r") ||
      !(position + node.nodeSize <= edit.from || position >= edit.to)
    )
      return false;
    const mapped = transaction.mapping.map(position, 1);
    const parsed = transaction.doc.nodeAt(mapped);
    if (
      parsed &&
      node.sameMarkup(parsed) &&
      node.textContent !== parsed.textContent &&
      node.textContent.replace(/\r\n?/gu, "\n") === parsed.textContent
    )
      transaction.replaceWith(mapped, mapped + parsed.nodeSize, node);
    return false;
  });
}
/** Keep the active native composition intact until its commit event. */
function preserveComposingText(
  view: EditorView,
  transaction: Transaction,
  edit: { doc: EditorNode; from: number; to: number },
) {
  if (transaction.before !== edit.doc) return;
  const selection = view.dom.ownerDocument.getSelection();
  const points: {
    position: number;
    mapping: number;
    anchor?: number;
    head?: number;
  }[] = [];
  edit.doc.descendants((node, position) => {
    if (!["literal", "code", "word_link", "web_link"].includes(node.type.name))
      return;
    if (position + node.nodeSize <= edit.from || position >= edit.to)
      return false;
    const dom = view.nodeDOM(position);
    const mapped = transaction.mapping.map(position, 1);
    const parsed = transaction.doc.nodeAt(mapped);
    const raw = dom?.textContent;
    if (
      !dom ||
      !parsed ||
      !raw?.includes("\r") ||
      !node.sameMarkup(parsed) ||
      raw === parsed.textContent ||
      raw.replace(/\r\n?/gu, "\n") !== parsed.textContent
    )
      return false;
    const offset = (point: Node | null, at: number) => {
      if (!point || !dom.contains(point)) return undefined;
      const range = view.dom.ownerDocument.createRange();
      range.selectNodeContents(dom);
      range.setEnd(point, at);
      return range.toString().length;
    };
    const anchor = offset(
      selection?.anchorNode ?? null,
      selection?.anchorOffset ?? 0,
    );
    const head = offset(
      selection?.focusNode ?? null,
      selection?.focusOffset ?? 0,
    );
    transaction.replaceWith(
      mapped,
      mapped + parsed.nodeSize,
      parsed.type.create(parsed.attrs, richEditorSchema.text(raw)),
    );
    points.push({
      position: mapped,
      mapping: transaction.mapping.maps.length,
      anchor,
      head,
    });
    return false;
  });
  let anchor = transaction.selection.anchor,
    head = transaction.selection.head;
  for (const point of points) {
    const start =
      transaction.mapping.slice(point.mapping).map(point.position, -1) + 1;
    if (point.anchor !== undefined) anchor = start + point.anchor;
    if (point.head !== undefined) head = start + point.head;
  }
  if (points.length)
    transaction.setSelection(
      TextSelection.between(
        transaction.doc.resolve(anchor),
        transaction.doc.resolve(head),
      ),
    );
}
/** Native selection changes can still be pending when beforeinput runs. */
function insertionSelection(
  view: EditorView,
  input: InputEvent,
  resolve = richInsertionSelection,
) {
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
    return resolve(view.state, from, to);
  } catch {
    // Let the native input path read DOM changes that are not mapped yet.
    return null;
  }
}

/** Read a deletion extent separately from the actual native caret. */
function deletionRange(
  view: EditorView,
  input?: InputEvent,
): RichDeleteRange | null {
  const range = input?.getTargetRanges?.()[0];
  if (
    !range ||
    !view.dom.contains(range.startContainer) ||
    !view.dom.contains(range.endContainer)
  )
    return null;
  try {
    return {
      from: view.posAtDOM(range.startContainer, range.startOffset, -1),
      to: view.posAtDOM(range.endContainer, range.endOffset, 1),
    };
  } catch {
    return null;
  }
}

/** Ask only for selection motion. Never let the browser delete text. */
function deletionMotion(
  view: EditorView,
  type: RichDeleteType,
): RichDeleteRange | null {
  if (
    !type.startsWith("deleteWord") &&
    !type.startsWith("deleteSoftLine") &&
    type !== "deleteEntireSoftLine"
  )
    return null;
  const selection = view.dom.ownerDocument.getSelection();
  if (!selection?.anchorNode || !selection.focusNode || !selection.modify)
    return null;
  const anchor = selection.anchorNode,
    head = selection.focusNode;
  const anchorOffset = selection.anchorOffset,
    headOffset = selection.focusOffset;
  try {
    if (type === "deleteEntireSoftLine")
      selection.modify("move", "backward", "lineboundary");
    selection.modify(
      "extend",
      type.endsWith("Backward") ? "backward" : "forward",
      type.startsWith("deleteWord") ? "word" : "lineboundary",
    );
    const range = selection.rangeCount ? selection.getRangeAt(0) : null;
    if (
      !range ||
      !view.dom.contains(range.startContainer) ||
      !view.dom.contains(range.endContainer)
    )
      return null;
    return {
      from: view.posAtDOM(range.startContainer, range.startOffset, -1),
      to: view.posAtDOM(range.endContainer, range.endOffset, 1),
    };
  } catch {
    return null;
  } finally {
    // Queued selectionchange events must observe the restored or dispatched caret.
    selection.setBaseAndExtent(anchor, anchorOffset, head, headOffset);
  }
}

function deletionKey(event: KeyboardEvent): RichDeleteType | null {
  const mac = /Mac|iP(hone|[oa]d)/u.test(navigator.platform);
  const {
    key,
    ctrlKey: ctrl,
    altKey: alt,
    metaKey: meta,
    shiftKey: shift,
  } = event;
  if (mac && !meta && !shift) {
    if (ctrl && !alt && key === "h") return "deleteContentBackward";
    if (ctrl && !alt && key === "d") return "deleteContentForward";
    if (alt && !ctrl && key === "d") return "deleteWordForward";
    if (ctrl && alt && key === "Backspace") return "deleteWordForward";
  }
  if (key !== "Backspace" && key !== "Delete") return null;
  if (shift && key === "Delete") return null; // Keep the clipboard cut path.
  if (mac && meta && !ctrl && !alt)
    return key === "Backspace"
      ? "deleteSoftLineBackward"
      : "deleteSoftLineForward";
  if ((!mac && ctrl && !meta && !alt) || (mac && alt && !meta && !ctrl))
    return key === "Backspace" ? "deleteWordBackward" : "deleteWordForward";
  if (!ctrl && !meta && !alt)
    return key === "Backspace"
      ? "deleteContentBackward"
      : "deleteContentForward";
  return null;
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
    class: "sr",
    text: "Use Left, Right, Home, and End to move through the toolbar. In More places, use the arrow keys to choose a place. Escape returns to More places.",
  });
  toolbar.setAttribute("aria-describedby", toolbarHintId);
  toolbar.append(toolbarHint);
  const hint = el("p", {
    id: hintId,
    class: "hint",
    text:
      options.hint ??
      (options.main
        ? "Type ___ for the next free place, __N__ for place N, or ① to ㊿. Paste can keep circled numbers literal."
        : ""),
  });
  const wrapper = el(
    "div",
    {
      class: `${options.wrapperClass ?? "field-group"} rich-field${options.main ? " rich-field-main" : ""}`,
    },
    labelNode,
    ...(options.main ? [toolbar, host] : [host, toolbar]),
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
  let moved = false;
  let resetSelection: { doc: EditorNode; selection: Selection } | null = null;
  let pointerFocus = false;
  let tabSelection: boolean | null = null;
  let tabTimer: number | undefined;
  let blurSelection: { doc: EditorNode; selection: Selection | null } | null =
    null;
  let blurTimer: number | undefined;
  let nativeEdit: {
    doc: EditorNode;
    from: number;
    to: number;
    deletion?: boolean;
  } | null = null;
  let compositionDoc: EditorNode | null = null;
  let compositionGeneration = 0;
  let renderedDOM: Node[] = [];
  let lastAppliedTransactions: readonly Transaction[] = [];
  const rememberDOM = () => {
    renderedDOM = [...view.dom.childNodes].map((node) => node.cloneNode(true));
  };
  const matchesRenderedDOM = () =>
    renderedDOM.length === view.dom.childNodes.length &&
    renderedDOM.every((node, index) =>
      node.isEqualNode(view.dom.childNodes[index]),
    );
  const operationStatus = el("p", {
    class: "hint",
    hidden: true,
  });
  const operationAnnouncement = el("span", {
    class: "sr",
    "aria-live": "polite",
    "aria-atomic": "true",
  });
  wrapper.append(operationStatus, operationAnnouncement);
  let announcementGeneration = 0;
  let announcementFrame: number | undefined;
  let settlingComposition = false;
  const clearOperation = () => {
    if (settlingComposition) return;
    announcementGeneration++;
    if (announcementFrame !== undefined)
      cancelAnimationFrame(announcementFrame);
    announcementFrame = undefined;
    operationStatus.textContent = "";
    operationStatus.hidden = true;
    operationAnnouncement.textContent = "";
  };
  const retryOperation = (message: string) => {
    const generation = ++announcementGeneration;
    if (announcementFrame !== undefined)
      cancelAnimationFrame(announcementFrame);
    operationStatus.textContent = message;
    operationStatus.hidden = false;
    operationAnnouncement.textContent = "";
    announcementFrame = requestAnimationFrame(() => {
      announcementFrame = undefined;
      if (generation === announcementGeneration && wrapper.isConnected)
        operationAnnouncement.textContent = message;
    });
  };
  interface CompositionDelete extends RichRangeSnapshot {
    generation: number;
    text: string;
  }
  let compositionDelete: CompositionDelete | null = null;
  let compositionText = "";
  let compositionRetry = false;
  const announceCompositionRetry = () => {
    retryOperation(
      "That edit could not be applied during text entry. Finish entering text, select one range and try again.",
    );
    compositionRetry = false;
  };
  let compositionStartState: EditorState | null = null;
  let compositionStartSelection: Selection | null = null;
  let dirtyCompositionState: EditorState | null = null;
  const cancelCompositionDelete = () => {
    if (compositionDelete) compositionRetry = true;
    compositionDelete = null;
  };
  function rejectRanges(input: InputEvent) {
    if (deleteRecovery)
      settleDeleteRecovery(
        deleteRecovery,
        false,
        readNativeSelection() ?? deleteRecovery.selection,
      );
    if (input.cancelable) input.preventDefault();
    if (view.composing || input.isComposing) {
      cancelCompositionDelete();
      compositionRetry = true;
      if (!input.cancelable) dirtyCompositionState ??= view.state;
    } else {
      retryOperation(
        "This selection cannot be edited at once. Select one range and try again.",
      );
      if (!input.cancelable) {
        const stage: DeleteRecovery = {
          type: input.inputType,
          state: view.state,
          transaction: null,
          selection: view.state.selection,
          settling: false,
          timer: setTimeout(() => settleDeleteRecovery(stage, false), 0),
        };
        deleteRecovery = stage;
      }
    }
    return true;
  }
  let ownedInput: {
    type: string;
    state: EditorState;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  const markOwnedInput = (type: string) => {
    if (ownedInput) clearTimeout(ownedInput.timer);
    const marker = {
      type,
      state: view.state,
      timer: setTimeout(() => {
        if (ownedInput === marker) ownedInput = null;
      }, 0),
    };
    ownedInput = marker;
  };
  const historyTransaction = (type: string) => {
    let transaction: Transaction | null = null;
    (type === "historyUndo" ? undo : redo)(view.state, (tr) => {
      transaction = tr.setMeta("richRuleUndo", true);
    });
    return transaction;
  };
  let paragraphInput: {
    state: EditorState;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  const splitParagraph: Command = (state, dispatch, editor) => {
    if (state.selection.$from.sameParent(state.selection.$to))
      return baseKeymap.Enter(state, dispatch, editor);
    let tr = state.tr;
    deleteRichInput(tr, "deleteContentBackward", (next) => {
      tr = next;
    });
    const splits: Transaction[] = [];
    const trimmed = EditorState.create({
      doc: tr.doc,
      selection: tr.selection,
    });
    if (!baseKeymap.Enter(trimmed, (next) => splits.push(next), editor))
      return false;
    const split = splits[0];
    if (split) {
      for (const step of split.steps) tr.step(step);
      tr.setSelection(
        TextSelection.create(
          tr.doc,
          split.selection.anchor,
          split.selection.head,
        ),
      );
      dispatch?.(tr.setMeta("richDelete", false).scrollIntoView());
    }
    return true;
  };
  const insertLineBreak: Command = (state, dispatch) => {
    dispatch?.(replaceRichText(state.tr, "\n"));
    return true;
  };
  const paragraphCommand = (type: string, mark = true) => {
    const { selection } = view.state;
    const line =
      type === "insertLineBreak" ||
      ["code", "word_link", "web_link"].includes(
        selection.$from.parent.type.name,
      );
    const command = line ? insertLineBreak : splitParagraph;
    command(view.state, dispatchEdit, view);
    if (!mark) return;
    if (paragraphInput) clearTimeout(paragraphInput.timer);
    const marker = {
      state: view.state,
      timer: setTimeout(() => {
        if (paragraphInput === marker) paragraphInput = null;
      }, 0),
    };
    paragraphInput = marker;
  };
  interface DeleteRecovery {
    type: RichDeleteType;
    state: EditorState;
    transaction: Transaction | null;
    selection: Selection;
    timer: ReturnType<typeof setTimeout>;
    settling: boolean;
  }
  let deleteRecovery: DeleteRecovery | null = null;
  let restoringDelete = false;
  // A browser can move an unchanged visible caret into the neighboring node.
  // Retain the command's context until an edit or deliberate selection replaces it.
  let deletionCaret: { doc: EditorNode; selection: Selection } | null = null;
  function editingSelection(state: EditorState, from: number, to: number) {
    if (
      deletionCaret?.doc === state.doc &&
      from === to &&
      sameRichCaret(state.doc, from, deletionCaret.selection.from)
    )
      return deletionCaret.selection;
    deletionCaret = null;
    return richInsertionSelection(state, from, to);
  }
  function dispatchEdit(transaction: Transaction) {
    view.dispatch(transaction.setMeta("richExplicit", true));
  }
  function commandKeymap(bindings: Record<string, Command>) {
    return keymap(
      Object.fromEntries(
        Object.entries(bindings).map(([key, command]) => {
          const owned: Command = (state, dispatch, view) =>
            command(
              state,
              dispatch &&
                ((transaction) =>
                  dispatch(transaction.setMeta("richExplicit", true))),
              view,
            );
          return [key, owned];
        }),
      ),
    );
  }
  const nodeViews = { word_link: linkNodeView, web_link: linkNodeView };
  function cancelDeleteRecovery() {
    if (!deleteRecovery) return;
    clearTimeout(deleteRecovery.timer);
    deleteRecovery = null;
  }
  function restoreDeleteDOM(force = true) {
    if (restoringDelete || view.isDestroyed) return;
    if (!force && !view.composing && matchesRenderedDOM()) return;
    restoringDelete = true;
    try {
      const previous = view;
      const dom = previous.dom;
      const focused = previous.hasFocus();
      const props = { ...previous.props, nodeViews };
      // A destroyed observer cannot reparse records from before this recovery.
      // Keep the same field element and EditorState, including undo history.
      previous.destroy();
      if (!host.contains(dom)) host.append(dom);
      view = new EditorView({ mount: dom }, props);
      if (focused) view.focus();
      rememberDOM();
    } finally {
      restoringDelete = false;
    }
  }
  function syncDeletionCaret() {
    const selection = view.state.selection;
    if (!selection.empty || !view.hasFocus()) return;
    const $cursor = selection.$from;
    let point = view.domAtPos(selection.from);
    if ($cursor.parent.isInline) {
      const text = view.nodeDOM($cursor.before())?.firstChild;
      if (
        text?.nodeType === Node.TEXT_NODE &&
        text.textContent === $cursor.parent.textContent
      )
        point = { node: text, offset: $cursor.parentOffset };
    }
    view.dom.ownerDocument
      .getSelection()
      ?.setBaseAndExtent(point.node, point.offset, point.node, point.offset);
  }
  function settleDeleteRecovery(
    stage: DeleteRecovery,
    commit: boolean,
    selection = stage.selection,
  ) {
    if (deleteRecovery !== stage || stage.settling || view.isDestroyed) return;
    stage.settling = true;
    clearTimeout(stage.timer);
    // Keep the guard active while rendering can flush native parsed mutations.
    restoreDeleteDOM(Boolean(stage.transaction));
    deleteRecovery = null;
    if (view.state !== stage.state) return;
    if (commit && stage.transaction) dispatchEdit(stage.transaction);
    else if (!selection.eq(view.state.selection))
      dispatchEdit(view.state.tr.setSelection(selection));
  }
  function prepareDeletion(
    type: RichDeleteType,
    input?: InputEvent,
    incomingSelection?: Selection | null,
    incomingRange?: RichDeleteRange | null,
  ) {
    const selection =
      incomingSelection ?? readNativeSelection() ?? view.state.selection;
    let transaction: Transaction | null = null;
    const dispatch = (tr: Transaction) => {
      transaction = tr;
    };
    const ruleUndo =
      type === "deleteContentBackward" &&
      selection.empty &&
      selection.eq(view.state.selection) &&
      undoInputRule(view.state, (tr) =>
        dispatch(tr.setMeta("richRuleUndo", true).setMeta("richDelete", true)),
      );
    if (!ruleUndo)
      deleteRichInput(
        view.state.tr.setSelection(selection),
        type,
        dispatch,
        incomingRange ??
          deletionRange(view, input) ??
          (selection.empty ? deletionMotion(view, type) : null),
      );
    return { transaction, selection };
  }
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
        editedTextPlugin({ composing: () => view?.composing ?? false }),
        ...rulePlugins,
        new Plugin({
          props: {
            handleTextInput(view, from, to, value) {
              if (view.composing) return false;
              const selection = editingSelection(view.state, from, to);
              dispatchEdit(
                replaceRichText(
                  view.state.tr.setSelection(selection),
                  value,
                ).scrollIntoView(),
              );
              return true;
            },
          },
        }),
        history(),
        commandKeymap({
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
          "Shift-Enter": insertLineBreak,
          Enter: (state, dispatch) => {
            if (
              !["code", "word_link", "web_link"].includes(
                state.selection.$from.parent.type.name,
              )
            )
              return false;
            return insertLineBreak(state, dispatch);
          },
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
        commandKeymap({ ...baseKeymap, Enter: splitParagraph }),
      ],
    });
  };
  const placeControls: (HTMLButtonElement | HTMLSelectElement)[] = [];
  const placeButtons = new Map<number, HTMLButtonElement>();
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
    const declared = new Set(options.places?.() ?? []);
    for (const [index, control] of placeButtons) {
      control.setAttribute(
        "aria-label",
        `Place ${index}${declared.has(index) ? ", declared" : ""}`,
      );
      control.classList.toggle("rich-place-declared", declared.has(index));
      control.disabled = !enabled();
    }
    if (operandControl) {
      operandControl.hidden = !operandIds().length;
      operandControl.disabled = !enabled();
      operandControl.setAttribute(
        "aria-disabled",
        String(!enabled() || !operandIds().length),
      );
    }
    if (operandReason && (operandIds().length || !enabled()))
      operandReason.hidden = true;
    hint.textContent =
      !enabled() && options.local !== false && options.main
        ? "Literal mode keeps typed characters as text. Pasted text stays literal."
        : (options.hint ??
          (options.main
            ? "Type ___ for the next free place, __N__ for place N, or ① to ㊿. Paste can keep circled numbers literal."
            : ""));
    hint.hidden = !hint.textContent;
    rove();
  };
  view = new EditorView(host, {
    state: state(),
    nodeViews,
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
      if (restoringDelete) return;
      if (dirtyCompositionState && view.composing && transaction.docChanged)
        return;
      if (deleteRecovery) {
        if (transaction.docChanged) settleDeleteRecovery(deleteRecovery, true);
        return;
      }
      if (transaction.docChanged || transaction.getMeta("richExplicit"))
        resetSelection = null;
      const ownsCaret =
        transaction.getMeta("richDelete") ||
        transaction.getMeta("richRuleUndo");
      if (compositionDelete && transaction.getMeta("richExplicit"))
        cancelCompositionDelete();
      if (ownsCaret || transaction.getMeta("richExplicit")) nativeEdit = null;
      if (!ownsCaret && transaction.getMeta("richExplicit"))
        deletionCaret = null;
      if (transaction.docChanged && nativeEdit) {
        // Explicit editor commands do not carry the DOM reader's composition ID.
        if (
          nativeEdit.deletion ||
          transaction.getMeta("composition") !== undefined
        ) {
          preserveOutsideNativeEdit(transaction, nativeEdit);
          if (view.composing)
            preserveComposingText(view, transaction, nativeEdit);
        }
        nativeEdit = null;
      }
      const result = view.state.applyTransaction(transaction);
      lastAppliedTransactions = result.transactions;
      if (compositionDelete) {
        for (const applied of result.transactions) {
          const mapped = mapRichRange(compositionDelete, applied);
          if (!mapped) {
            cancelCompositionDelete();
            break;
          }
          compositionDelete = { ...compositionDelete, ...mapped };
        }
      }
      view.updateState(result.state);
      rememberDOM();
      // ProseMirror can leave a visually equal caret in another inline node.
      if (ownsCaret) {
        deletionCaret = view.state.selection.empty
          ? { doc: view.state.doc, selection: view.state.selection }
          : null;
        syncDeletionCaret();
      } else if (
        deletionCaret &&
        (deletionCaret.doc !== view.state.doc ||
          !view.state.selection.empty ||
          !sameRichCaret(
            view.state.doc,
            view.state.selection.from,
            deletionCaret.selection.from,
          ))
      )
        deletionCaret = null;
      syncLinkAction();
      if (result.transactions.some((tr) => tr.docChanged)) {
        clearOperation();
        current = editorToRich(view.state.doc, compositionDoc ?? undefined);
        view.dom.dispatchEvent(new Event("input", { bubbles: true }));
      }
    },
    handleDOMEvents: {
      keydown(_view, event) {
        if (
          /^(Arrow(?:Left|Right|Up|Down)|Home|End|PageUp|PageDown|Tab)$/u.test(
            event.key,
          ) ||
          ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a")
        )
          deletionCaret = null;
        if (event.isComposing || event.keyCode === 229 || view.composing)
          return false;
        if (event.key === "Tab") {
          const selection = readNativeSelection();
          if (selection && !selection.eq(view.state.selection))
            dispatchEdit(view.state.tr.setSelection(selection));
        }
        if (event.key === "Enter") {
          const selection = readNativeSelection();
          if (selection && !selection.eq(view.state.selection))
            dispatchEdit(view.state.tr.setSelection(selection));
          event.preventDefault();
          paragraphCommand(
            event.shiftKey ? "insertLineBreak" : "insertParagraph",
          );
          return true;
        }
        const type = deletionKey(event);
        if (!type) return false;
        const selection = readNativeSelection();
        if (deleteRecovery)
          settleDeleteRecovery(
            deleteRecovery,
            false,
            selection ?? deleteRecovery.selection,
          );
        event.preventDefault();
        const { transaction } = prepareDeletion(type, undefined, selection);
        if (transaction) dispatchEdit(transaction);
        return true;
      },
      input(_view, event) {
        const stage = deleteRecovery;
        const type = (event as InputEvent).inputType;
        if (
          type === "historyUndo" ||
          type === "historyRedo" ||
          type === "insertReplacementText"
        ) {
          if (stage) {
            settleDeleteRecovery(stage, type === stage.type);
            return true;
          }
          const dirty = !matchesRenderedDOM();
          if (
            ownedInput?.type === type &&
            (ownedInput.state === view.state || !event.isTrusted)
          ) {
            if (dirty) restoreDeleteDOM();
            return true;
          }
          // A genuine native command can name an old, replaced DOM history item.
          // Synthetic unchanged completions carry no new history authority.
          if (!dirty && (!event.isTrusted || type === "insertReplacementText"))
            return true;
          if (dirty) restoreDeleteDOM();
          if (type === "insertReplacementText") {
            retryOperation(
              "This selection cannot be edited at once. Select one range and try again.",
            );
          } else {
            const transaction = historyTransaction(type);
            if (transaction) dispatchEdit(transaction);
          }
          return true;
        }
        if (dirtyCompositionState && view.composing) return true;
        if (
          type === "deleteCompositionText" &&
          (view.composing || (event as InputEvent).isComposing) &&
          (compositionDelete || compositionRetry)
        )
          return true;
        if (
          (type === "insertParagraph" || type === "insertLineBreak") &&
          !view.composing
        ) {
          if (matchesRenderedDOM()) return true;
          const duplicate = paragraphInput?.state === view.state;
          if (stage) settleDeleteRecovery(stage, false);
          // Some browser commands emit only input. The model still holds the pre-edit state.
          restoreDeleteDOM();
          if (!duplicate) paragraphCommand(type, false);
          return true;
        }
        if (stage) {
          settleDeleteRecovery(stage, type === stage.type);
          return true;
        }
        if (!isRichDeleteType(type ?? "")) return false;
        if (type === "deleteCompositionText" && nativeEdit?.deletion)
          return false;
        // An orphan or duplicate delete input cannot replace the current model.
        restoreDeleteDOM(false);
        return true;
      },
      cut(_view, event) {
        nativeEdit = null;
        const selection = readNativeSelection() ?? view.state.selection;
        if (deleteRecovery)
          settleDeleteRecovery(deleteRecovery, false, selection);
        event.preventDefault();
        if (selection.empty || !event.clipboardData) return true;
        const { dom, text } = view.serializeForClipboard(selection.content());
        event.clipboardData.clearData();
        event.clipboardData.setData("text/html", dom.innerHTML);
        event.clipboardData.setData("text/plain", text);
        deleteRichInput(
          view.state.tr.setSelection(selection),
          "deleteByCut",
          dispatchEdit,
        );
        return true;
      },
      focus(view) {
        const reset =
          resetSelection?.doc === view.state.doc ? resetSelection : null;
        const before =
          blurSelection?.doc === view.state.doc ? blurSelection : null;
        const native = view.dom.ownerDocument.getSelection();
        // A reset can focus with a browser default at the root or first paragraph.
        // A known pre-focus selection or pointer choice takes precedence.
        const defaultStartCaret =
          native?.isCollapsed &&
          native.anchorOffset === 0 &&
          (native.anchorNode === view.dom ||
            native.anchorNode === view.dom.firstChild);
        const repairReset =
          reset &&
          !pointerFocus &&
          !before?.selection &&
          tabSelection !== true &&
          defaultStartCaret;
        resetSelection = null;
        const repair =
          moved &&
          !pointerFocus &&
          tabSelection !== true &&
          (before
            ? before.selection === null
            : tabSelection === false || !readNativeSelection());
        const chosen =
          moved && !pointerFocus && !repair
            ? (before?.selection ?? readNativeSelection())
            : null;
        clearMove();
        if (repairReset && reset) {
          if (!reset.selection.eq(view.state.selection))
            dispatchEdit(view.state.tr.setSelection(reset.selection));
          view.focus();
        } else {
          if (chosen && !chosen.eq(view.state.selection))
            dispatchEdit(view.state.tr.setSelection(chosen));
          if (repair) view.focus();
        }
        pointerFocus = false;
        return false;
      },
      pointerdown() {
        deletionCaret = null;
        pointerFocus = true;
        return false;
      },
      pointerup() {
        pointerFocus = false;
        return false;
      },
      pointercancel() {
        pointerFocus = false;
        return false;
      },
      beforeinput(_view, event) {
        const input = event as InputEvent;
        const resuming = Boolean(
          dirtyCompositionState &&
          !input.isComposing &&
          !input.inputType.includes("Composition"),
        );
        let resumedSelection: Selection | null = null;
        if (resuming) {
          resumedSelection = insertionSelection(view, input, editingSelection);
          settlingComposition = true;
          cancelCompositionDelete();
          compositionGeneration++;
          dirtyCompositionState = null;
          // The explicit ordinary event supplies settlement, without a timer.
          restoreDeleteDOM();
          view.dispatch(view.state.tr.setMeta("richCompositionEnd", true));
          if (resumedSelection)
            for (const applied of lastAppliedTransactions)
              resumedSelection = resumedSelection.map(
                applied.doc,
                applied.mapping,
              );
          compositionStartState = null;
          compositionStartSelection = null;
          compositionDoc = null;
          nativeEdit = null;
          if (resumedSelection && resumedSelection.$from.doc === view.state.doc)
            dispatchEdit(view.state.tr.setSelection(resumedSelection));
          // Announce after this input's handlers and model transactions finish.
          const generation = compositionGeneration;
          setTimeout(() => {
            if (view.isDestroyed || generation !== compositionGeneration)
              return;
            settlingComposition = false;
            if (compositionRetry) announceCompositionRetry();
          }, 0);
        }
        // A browser can leave composition without its end event after native repair.
        // Keep the failed operation visible when ordinary input resumes.
        if (
          compositionRetry &&
          !resuming &&
          !input.isComposing &&
          !input.inputType.startsWith("delete")
        )
          announceCompositionRetry();
        if ((input.getTargetRanges?.().length ?? 0) > 1)
          return rejectRanges(input);
        if (input.inputType === "insertCompositionText") {
          if (input.data !== null && input.data !== compositionText)
            cancelCompositionDelete();
          compositionText = input.data ?? compositionText;
        } else if (
          compositionDelete &&
          input.inputType !== "deleteCompositionText"
        ) {
          cancelCompositionDelete();
        }
        // Read incoming DOM points before an older stage rebuilds their nodes.
        const incomingSelection = deleteRecovery
          ? isRichDeleteType(input.inputType)
            ? readNativeSelection()
            : insertionSelection(view, input, editingSelection)
          : null;
        const incomingRange = deleteRecovery
          ? deletionRange(view, input)
          : null;
        if (deleteRecovery)
          settleDeleteRecovery(
            deleteRecovery,
            false,
            incomingSelection ?? deleteRecovery.selection,
          );
        if (
          ["historyUndo", "historyRedo", "insertReplacementText"].includes(
            input.inputType,
          )
        ) {
          if (input.isComposing || view.composing) return rejectRanges(input);
          const selection =
            resumedSelection ??
            incomingSelection ??
            insertionSelection(view, input, editingSelection);
          const replacement = input.inputType === "insertReplacementText";
          const transaction = replacement
            ? selection && input.data !== null
              ? replaceRichText(
                  view.state.tr.setSelection(selection),
                  input.data,
                ).scrollIntoView()
              : null
            : historyTransaction(input.inputType);
          if (input.cancelable) {
            input.preventDefault();
            if (transaction) dispatchEdit(transaction);
            else if (replacement)
              retryOperation(
                "This selection cannot be edited at once. Select one range and try again.",
              );
            markOwnedInput(input.inputType);
          } else {
            const stage: DeleteRecovery = {
              type: input.inputType,
              state: view.state,
              transaction,
              selection: selection ?? view.state.selection,
              settling: false,
              timer: setTimeout(() => settleDeleteRecovery(stage, false), 0),
            };
            deleteRecovery = stage;
            if (replacement && !transaction)
              retryOperation(
                "This selection cannot be edited at once. Select one range and try again.",
              );
          }
          return true;
        }
        if (
          (input.inputType === "insertParagraph" ||
            input.inputType === "insertLineBreak") &&
          input.cancelable &&
          !input.isComposing &&
          !view.composing
        ) {
          input.preventDefault();
          const selection = insertionSelection(view, input, editingSelection);
          if (selection && !selection.eq(view.state.selection))
            dispatchEdit(view.state.tr.setSelection(selection));
          if (paragraphInput?.state !== view.state)
            paragraphCommand(input.inputType);
          return true;
        }
        if (
          input.inputType === "deleteCompositionText" &&
          (input.isComposing || view.composing)
        ) {
          const ranges = input.getTargetRanges?.();
          const range = ranges?.length === 1 ? ranges[0] : null;
          const target = deletionRange(view, input);
          if (
            range &&
            target &&
            range.startContainer === range.endContainer &&
            range.startContainer.nodeType === Node.TEXT_NODE &&
            view.state.doc
              .resolve(target.from)
              .sameParent(view.state.doc.resolve(target.to))
          ) {
            nativeEdit = { doc: view.state.doc, ...target, deletion: true };
            return false;
          }
          if (input.cancelable) input.preventDefault();
          // Keep the browser's live composition node until its commit settles.
          const mapped =
            range &&
            target &&
            target.from < target.to &&
            [range.startContainer, range.endContainer].every((node, index) => {
              if (node.nodeType !== Node.TEXT_NODE) return false;
              const position = index ? target.to : target.from;
              const parent = view.state.doc.resolve(position).parent;
              return parent.isInline && parent.textContent === node.textContent;
            });
          if (input.cancelable && mapped && target) {
            if (
              compositionDelete &&
              (compositionDelete.from !== target.from ||
                compositionDelete.to !== target.to)
            ) {
              cancelCompositionDelete();
              compositionRetry = true;
            } else if (!compositionRetry) {
              compositionDelete ??= {
                generation: compositionGeneration,
                ...snapshotRichRange(view.state.doc, target.from, target.to),
                text: compositionText,
              };
            }
          } else {
            cancelCompositionDelete();
            compositionRetry = true;
            if (!input.cancelable) dirtyCompositionState ??= view.state;
          }
          return true;
        }
        if (isRichDeleteType(input.inputType)) {
          nativeEdit = null;
          const prepared = prepareDeletion(
            input.inputType,
            input,
            incomingSelection,
            incomingRange,
          );
          if (input.cancelable) {
            input.preventDefault();
            if (prepared.transaction) dispatchEdit(prepared.transaction);
          } else {
            const stage: DeleteRecovery = {
              ...prepared,
              type: input.inputType,
              state: view.state,
              settling: false,
              timer: setTimeout(() => settleDeleteRecovery(stage, false), 0),
            };
            deleteRecovery = stage;
          }
          return true;
        }
        if (!input.cancelable && input.inputType === "insertCompositionText") {
          const selection =
            incomingSelection ??
            insertionSelection(view, input, editingSelection);
          if (selection)
            nativeEdit = {
              doc: view.state.doc,
              from: selection.from,
              to: selection.to,
            };
        }
        if (
          !input.cancelable ||
          input.inputType !== "insertText" ||
          input.data === null ||
          input.isComposing ||
          view.composing
        )
          return false;
        const selection =
          resumedSelection ??
          incomingSelection ??
          insertionSelection(view, input, editingSelection);
        if (!selection) return false;
        input.preventDefault();
        nativeEdit = null;
        if (!selection.eq(view.state.selection))
          dispatchEdit(view.state.tr.setSelection(selection));
        const { from, to } = view.state.selection;
        const text = input.data;
        const insert = () =>
          replaceRichText(view.state.tr, text).scrollIntoView();
        if (
          !view.someProp("handleTextInput", (handler) =>
            handler(view, from, to, text, insert),
          )
        )
          dispatchEdit(insert());
        return true;
      },
      compositionstart() {
        settlingComposition = false;
        cancelCompositionDelete();
        // A replacement session must not erase an unannounced failed operation.
        dirtyCompositionState = null;
        compositionText = "";
        compositionStartState = view.state;
        compositionStartSelection =
          readNativeSelection() ?? view.state.selection;
        compositionGeneration++;
        compositionDoc = view.state.doc;
        view.dispatch(view.state.tr.setMeta("richCompositionStart", true));
        return false;
      },
      compositionupdate(_view, event) {
        const text = (event as CompositionEvent).data;
        if (text !== compositionText) cancelCompositionDelete();
        compositionText = text;
        return false;
      },
      paste(_view, event) {
        event.preventDefault();
        const pasted = event.clipboardData?.getData("text/plain") ?? "";
        if (!pasted) return true;
        const selection = readNativeSelection() ?? view.state.selection;
        if (!selection.eq(view.state.selection))
          dispatchEdit(view.state.tr.setSelection(selection));
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
      compositionend(_view, event) {
        const generation = compositionGeneration;
        const text = (event as CompositionEvent).data;
        if (!text || text !== compositionDelete?.text)
          cancelCompositionDelete();
        // Android can commit DOM changes without handleTextInput.
        setTimeout(() => {
          if (generation !== compositionGeneration) return;
          if (view.isDestroyed) return;
          settlingComposition = true;
          if (dirtyCompositionState) {
            cancelCompositionDelete();
            const start = compositionStartState;
            const selection = compositionStartSelection;
            const clean = dirtyCompositionState;
            dirtyCompositionState = null;
            if (start && selection && selection.$from.doc === start.doc) {
              view.updateState(start);
              if (text)
                dispatchEdit(
                  replaceRichText(view.state.tr.setSelection(selection), text),
                );
            } else view.updateState(clean);
            current = editorToRich(view.state.doc);
            restoreDeleteDOM();
            view.dom.dispatchEvent(new Event("input", { bubbles: true }));
          }
          view.dispatch(view.state.tr.setMeta("richCompositionEnd", true));
          const intent = compositionDelete;
          compositionDelete = null;
          if (
            intent &&
            intent.generation === generation &&
            intent.doc === view.state.doc &&
            intent.from < intent.to &&
            intent.to <= view.state.doc.content.size &&
            view.state.doc.slice(intent.from, intent.to).eq(intent.slice)
          ) {
            const tr = closeHistory(view.state.tr).setSelection(
              TextSelection.between(
                view.state.doc.resolve(intent.from),
                view.state.doc.resolve(intent.to),
              ),
            );
            deleteRichInput(tr, "deleteCompositionText", dispatchEdit);
          } else if (intent) compositionRetry = true;
          settlingComposition = false;
          if (compositionRetry) announceCompositionRetry();
          compositionStartState = null;
          compositionStartSelection = null;
          nativeEdit = null;
          compositionDoc = null;
        }, 0);
        return false;
      },
    },
  });
  rememberDOM();
  const input = view.dom as RichInput;
  function readNativeSelection(): Selection | null {
    const selection = input.ownerDocument.getSelection();
    if (
      !selection?.anchorNode ||
      !selection.focusNode ||
      !input.contains(selection.anchorNode) ||
      !input.contains(selection.focusNode)
    )
      return null;
    try {
      const from = view.posAtDOM(
        selection.anchorNode,
        selection.anchorOffset,
        -1,
      );
      const to = selection.isCollapsed
        ? from
        : view.posAtDOM(selection.focusNode, selection.focusOffset, 1);
      return editingSelection(view.state, from, to);
    } catch {
      return null;
    }
  }
  function clearMove() {
    moved = false;
    tabSelection = null;
    window.clearTimeout(tabTimer);
    window.clearTimeout(blurTimer);
    blurSelection = null;
    input.ownerDocument.removeEventListener("keydown", beforeTab, true);
    input.ownerDocument.removeEventListener("blur", beforeBlur, true);
  }
  function beforeTab(event: KeyboardEvent) {
    if (event.key !== "Tab") return;
    tabSelection = readNativeSelection() !== null;
    window.clearTimeout(tabTimer);
    tabTimer = window.setTimeout(() => {
      tabSelection = null;
    }, 0);
  }
  function beforeBlur() {
    // Native focus can create a default caret after the old control blurs.
    blurSelection = { doc: view.state.doc, selection: readNativeSelection() };
    window.clearTimeout(blurTimer);
    blurTimer = window.setTimeout(() => {
      blurSelection = null;
    }, 0);
  }
  function watchNativeFocus() {
    moved = true;
    input.ownerDocument.addEventListener("keydown", beforeTab, true);
    input.ownerDocument.addEventListener("blur", beforeBlur, true);
  }
  input.style.setProperty(
    "--target-min-height",
    `${Math.max(2, options.rows ?? 3) * 1.7 + 1}em`,
  );
  if (options.spellcheck === false) input.spellcheck = false;
  Object.defineProperty(input, "value", {
    get: () => current,
    set: (value: RichText) => {
      const unchanged = JSON.stringify(current) === JSON.stringify(value);
      current = value;
      nativeEdit = null;
      if (!unchanged) {
        settlingComposition = false;
        clearOperation();
        if (ownedInput) clearTimeout(ownedInput.timer);
        ownedInput = null;
        cancelCompositionDelete();
        compositionRetry = false;
        dirtyCompositionState = null;
        compositionStartState = null;
        deletionCaret = null;
        cancelDeleteRecovery();
        compositionGeneration++;
        compositionDoc = null;
      }
      if (view.isDestroyed) return;
      // External draft changes start a new history for this field.
      if (!unchanged) {
        const next = state();
        view.updateState(next);
        resetSelection = { doc: next.doc, selection: next.selection };
      } else if (enabled() !== previousMode) {
        // Mode changes start a new undo boundary without moving the caret.
        deletionCaret = null;
        view.updateState(state(view.state.doc, view.state.selection));
      }
      previousMode = enabled();
      rememberDOM();
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
    dispatchEdit(
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
      const control = button("", () => addPlace(index), {
        class: "btn rich-place-button",
        "aria-label": `Insert place ${index}`,
      });
      control.append(
        el("span", {
          class: "rich-place-face",
          "aria-hidden": "true",
          text: String(index),
        }),
      );
      placeControls.push(control);
      toolbar.append(control);
    }
    const grid = el("div", {
      id: `${id}-places`,
      class: "rich-place-grid",
      role: "grid",
      "aria-label": "Places 4 to 50",
      popover: "auto",
    });
    const more = button(
      "More places",
      () => {
        syncMode();
        if (!grid.isConnected || !enabled()) return;
        if (grid.matches(":popover-open")) closeGrid();
        else {
          grid.showPopover();
          more.setAttribute("aria-expanded", "true");
          placeButtons.get(4)!.focus();
        }
      },
      {
        class: "btn rich-action",
        "aria-haspopup": "grid",
        "aria-expanded": "false",
        "aria-controls": `${id}-places`,
      },
    );
    const closeGrid = () => {
      if (grid.isConnected && grid.matches(":popover-open")) grid.hidePopover();
      more.setAttribute("aria-expanded", "false");
    };
    grid.addEventListener("focusout", () => {
      setTimeout(() => {
        if (!grid.contains(document.activeElement)) closeGrid();
      });
    });
    grid.addEventListener("toggle", () =>
      more.setAttribute("aria-expanded", String(grid.matches(":popover-open"))),
    );
    let row: HTMLElement;
    for (let index = 4; index <= 50; index++) {
      if ((index - 4) % 6 === 0) {
        row = el("div", { role: "row", class: "rich-place-grid-row" });
        grid.append(row);
      }
      const control = button(
        "",
        () => {
          closeGrid();
          addPlace(index);
        },
        {
          class: "btn rich-place-button",
          tabindex: index === 4 ? "0" : "-1",
        },
      );
      control.append(
        el("span", {
          class: "rich-place-face",
          "aria-hidden": "true",
          text: String(index),
        }),
      );
      control.addEventListener("focus", () => {
        control.scrollIntoView({ block: "nearest", inline: "nearest" });
        for (const [number, cell] of placeButtons)
          cell.tabIndex = number === index ? 0 : -1;
      });
      placeButtons.set(index, control);
      row!.append(
        el("div", { role: "gridcell", class: "rich-place-cell" }, control),
      );
    }
    grid.addEventListener("keydown", (event) => {
      const index = [...placeButtons].find(
        ([, control]) => control === event.target,
      )?.[0];
      if (event.key === "Escape") {
        event.preventDefault();
        closeGrid();
        more.focus();
        return;
      }
      if (index === undefined) return;
      const movement: Record<string, number> = {
        ArrowLeft: -1,
        ArrowRight: 1,
        ArrowUp: -6,
        ArrowDown: 6,
      };
      const next =
        event.key === "Home"
          ? 4
          : event.key === "End"
            ? 50
            : movement[event.key] === undefined
              ? null
              : Math.max(4, Math.min(50, index + movement[event.key]));
      if (next === null) return;
      event.preventDefault();
      placeButtons.get(next)!.focus();
    });
    placeControls.push(more);
    toolbar.append(more);
    wrapper.append(grid);
    if (options.operands) {
      const operand = button(
        "Operand",
        () => {
          const ids = operandIds();
          if (!ids.length) {
            operandReason!.hidden = false;
            return;
          }
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
        { class: "btn rich-action", "aria-label": "Insert operand" },
      );
      placeControls.push(operand);
      operandControl = operand;
      const reasonId = `${id}-operand-reason`;
      operand.setAttribute("aria-describedby", reasonId);
      operandReason = el("span", {
        id: reasonId,
        class: "hint",
        hidden: true,
        role: "status",
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
    "Word link",
    () => {
      const spelling = field("Lojban word", {
        value: selectedText(),
        spellcheck: false,
        lang: "jbo",
        required: true,
      });
      const label = field("Link label", {
        value: selectedText().replace(/\r\n?|\n/gu, " "),
        hint: "The label can be empty. New labels use one line. Line breaks become spaces.",
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
    { class: "btn rich-action", "aria-label": "Word link, link a Lojban word" },
  );
  const linkWeb = button(
    "Web link",
    () => {
      const target = field("HTTPS address", { type: "url", required: true });
      const label = field("Link label", {
        value: selectedText().replace(/\r\n?|\n/gu, " "),
        hint: "The label can be empty. New labels use one line. Line breaks become spaces.",
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
    { class: "btn rich-action" },
  );
  const code = button(
    "Code",
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
    { class: "btn rich-action", "aria-label": "Insert code" },
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
        multiline: /[\r\n]/u.test(existing.node.textContent),
        rows: 3,
        hint: "The label can be empty.",
      });
      let labelEdited = false;
      label.input.addEventListener("input", () => {
        labelEdited = true;
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
          const labelText = labelEdited
            ? label.input.value
            : existing.node.textContent;
          const replacement = existing.node.type.create(
            word
              ? { word: { language: "jbo", spelling: value } }
              : { url: value },
            labelText ? richEditorSchema.text(labelText) : undefined,
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
          dispatchEdit(tr.setMeta("richExternal", true));
          return true;
        },
        "Save",
      );
    },
    { class: "btn rich-action" },
  );
  toolbar.append(editLink);
  toolbar.addEventListener("focusin", (event) => {
    const selection = readNativeSelection();
    if (selection && !selection.eq(view.state.selection))
      dispatchEdit(view.state.tr.setSelection(selection));
    if (
      event.target instanceof HTMLElement &&
      event.target.matches("button,select")
    )
      rove(event.target);
  });
  toolbar.addEventListener("pointerdown", () => {
    const selection = readNativeSelection();
    if (selection && !selection.eq(view.state.selection))
      dispatchEdit(view.state.tr.setSelection(selection));
  });
  toolbar.addEventListener("focusout", (event) => {
    if (
      event.relatedTarget instanceof Node &&
      toolbar.contains(event.relatedTarget)
    )
      return;
    if (operandReason) operandReason.hidden = true;
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
        button("Cancel", () => node.close(), { class: "btn" }),
        apply,
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
        const returning = dialog === node;
        if (returning) dialog = null;
        if (returning && wrapper.isConnected && !view.isDestroyed) {
          // Native focus can choose another caret while revealing the toolbar.
          const desired = {
            doc: view.state.doc,
            selection: view.state.selection,
          };
          watchNativeFocus();
          view.focus();
          if (
            view.state.doc === desired.doc &&
            !view.state.selection.eq(desired.selection)
          )
            dispatchEdit(view.state.tr.setSelection(desired.selection));
          if (invoker.isConnected) invoker.focus();
          if (document.activeElement !== invoker) view.focus();
        }
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
    dispatchEdit(tr.scrollIntoView());
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
    settlingComposition = false;
    clearOperation();
    if (ownedInput) clearTimeout(ownedInput.timer);
    ownedInput = null;
    resetSelection = null;
    compositionDelete = null;
    dirtyCompositionState = null;
    compositionStartState = null;
    if (paragraphInput) clearTimeout(paragraphInput.timer);
    paragraphInput = null;
    deletionCaret = null;
    cancelDeleteRecovery();
    nativeEdit = null;
    compositionGeneration++;
    compositionDoc = null;
    clearMove();
    dialog?.close();
    view.destroy();
  });
  function operandIds() {
    return (options.operands?.() ?? []).map((id) => id.trim()).filter(Boolean);
  }
  return {
    wrapper,
    input,
    label: labelNode,
    moved: watchNativeFocus,
    refresh: syncMode,
  };
}
