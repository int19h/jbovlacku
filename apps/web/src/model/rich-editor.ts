/** Direct mappings keep every stored inline node and paragraph boundary. */
import { Schema, type Node as EditorNode, type Slice } from "prosemirror-model";
import {
  EditorState,
  Plugin,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import { inputRules } from "prosemirror-inputrules";
import { CIRCLED_SOURCE, circledPlace, placeDisplay } from "./place-glyphs.ts";
import type { RichNode, RichText } from "./types.ts";
import { canonicalRich } from "./rich-values.ts";

const inlineText = (tag: string, className: string) => ({
  inline: true,
  group: "inline",
  content: "text*",
  whitespace: "pre" as const,
  defining: true,
  toDOM: () =>
    [tag, { class: className }, 0] as [string, Record<string, string>, number],
});
export const richEditorSchema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "inline*", whitespace: "pre", toDOM: () => ["p", 0] },
    text: { group: "inline" },
    // Containers preserve boundaries between adjacent stored strings.
    literal: {
      ...inlineText("span", "rich-literal"),
      selectable: false,
      attrs: { origin: { default: null } },
    },
    place: {
      inline: true,
      group: "inline",
      atom: true,
      attrs: { index: {} },
      leafText: (node) => placeDisplay(node.attrs.index),
      toDOM: (node) => [
        "span",
        {
          class: "rich-chip",
          role: "img",
          "aria-label": `place ${node.attrs.index}`,
          contenteditable: "false",
          "data-place": String(node.attrs.index),
        },
        String(node.attrs.index),
      ],
    },
    operand: {
      inline: true,
      group: "inline",
      atom: true,
      attrs: { id: {} },
      leafText: (node) => `[${node.attrs.id}]`,
      toDOM: (node) => [
        "span",
        {
          class: "rich-chip operand",
          role: "img",
          "aria-label": `operand ${node.attrs.id}`,
          contenteditable: "false",
        },
        String(node.attrs.id),
      ],
    },
    code: { ...inlineText("code", "rich-code"), code: true },
    word_link: {
      ...inlineText("span", "rich-word-link"),
      attrs: { word: {} },
      toDOM: (node) => [
        "span",
        {
          class: "rich-word-link",
          title: `Word: ${node.attrs.word.spelling}`,
          role: "group",
          "aria-roledescription": "word link",
          "aria-label": `${node.textContent || "Empty label"}, word link to ${node.attrs.word.spelling}`,
          "data-target": node.attrs.word.spelling,
        },
        0,
      ],
    },
    web_link: {
      ...inlineText("span", "rich-web-link"),
      attrs: { url: {} },
      toDOM: (node) => [
        "span",
        {
          class: "rich-web-link",
          title: node.attrs.url,
          role: "group",
          "aria-roledescription": "web link",
          "aria-label": `${node.textContent || "Empty label"}, web link to ${node.attrs.url}`,
          "data-target": node.attrs.url,
        },
        0,
      ],
    },
  },
});
const schema = richEditorSchema;
const contents = (value: string) => (value ? schema.text(value) : undefined);
interface StoredNodeGroup {
  prose: boolean;
  parts: { node: EditorNode; position: number }[];
}
/** Use the same saved boundaries for serialization and edit detection. */
function storedNodeGroups(doc: EditorNode): StoredNodeGroup[][] {
  const paragraphs: StoredNodeGroup[][] = [];
  doc.forEach((paragraph, paragraphPosition) => {
    const groups: StoredNodeGroup[] = [];
    let previousOrigin: {
      source: number;
      paragraph: number;
      index: number;
    } | null = null;
    paragraph.forEach((node, offset) => {
      const prose = node.isText || node.type.name === "literal";
      if (prose && !node.textContent) return;
      const origin = node.type.name === "literal" ? node.attrs.origin : null;
      const retainedBoundary =
        origin &&
        previousOrigin &&
        origin.source === previousOrigin.source &&
        origin.paragraph === previousOrigin.paragraph &&
        origin.index === previousOrigin.index + 1;
      const previous = groups.at(-1);
      const part = { node, position: paragraphPosition + 1 + offset };
      if (prose && previous?.prose && !retainedBoundary)
        previous.parts.push(part);
      else groups.push({ prose, parts: [part] });
      previousOrigin = prose ? origin : null;
    });
    paragraphs.push(groups);
  });
  return paragraphs;
}
/** Normalize edited containers in the same history event as their input. */
export function editedTextPlugin(
  options: { composing?: () => boolean } = {},
): Plugin {
  const plugin = new Plugin<EditorNode | null>({
    state: {
      init: () => null,
      apply(transaction, previous) {
        if (transaction.getMeta("richCompositionStart")) return transaction.doc;
        if (transaction.getMeta("richCompositionEnd")) return null;
        return previous;
      },
    },
    appendTransaction(transactions, before, state) {
      if (options.composing?.()) return null;
      const composition = plugin.getState(before);
      if (
        !transactions.some(
          (transaction) =>
            transaction.docChanged ||
            (composition && transaction.getMeta("richCompositionEnd")),
        )
      )
        return null;
      const retained = new Set<EditorNode>();
      (composition ?? before.doc).descendants((node) => {
        retained.add(node);
      });
      const transaction = state.tr;
      for (;;) {
        const changes: { from: number; to: number; text: string }[] = [];
        for (const paragraph of storedNodeGroups(transaction.doc))
          for (const group of paragraph)
            for (const [index, { node, position }] of group.parts.entries()) {
              const combined = group.prose && group.parts.length > 1;
              if (
                !node.isText &&
                !["literal", "code", "word_link", "web_link"].includes(
                  node.type.name,
                )
              )
                continue;
              if (
                (!combined && retained.has(node)) ||
                !node.textContent.includes("\r")
              )
                continue;
              // A changed target does not make its unchanged link label an edit.
              let original = transaction.mapping.invert().map(position, 1);
              for (const prior of [...transactions].reverse())
                original = prior.mapping.invert().map(original, 1);
              const previous = before.doc.nodeAt(original);
              if (
                !combined &&
                previous?.type === node.type &&
                !previous.sameMarkup(node) &&
                previous.content.eq(node.content)
              )
                continue;
              const from = position + (node.isText ? 0 : 1);
              // Keep maps outside each line ending, including the typed text, exact.
              for (const match of node.textContent.matchAll(/\r\n?/gu)) {
                changes.push({
                  from: from + match.index,
                  to: from + match.index + match[0].length,
                  text: "\n",
                });
                // A stored CRLF pair can cross two editor containers.
                const next = group.parts[index + 1];
                if (
                  combined &&
                  match[0] === "\r" &&
                  match.index === node.textContent.length - 1 &&
                  next?.node.textContent.startsWith("\n")
                ) {
                  const at = next.position + (next.node.isText ? 0 : 1);
                  changes.push({ from: at, to: at + 1, text: "" });
                }
              }
            }
        if (!changes.length) break;
        for (const change of changes.reverse())
          transaction.insertText(change.text, change.from, change.to);
      }
      if (!transaction.docChanged) return null;
      for (const plugin of state.plugins) {
        if (!plugin.spec.isInputRules) continue;
        const rule = plugin.getState(state) as {
          transform: Transaction;
          from: number;
          to: number;
          text: string;
        } | null;
        if (!rule || !rule.transform.doc.eq(state.doc)) continue;
        // Backspace must undo the conversion and its line-ending changes together.
        const combined = EditorState.create({ doc: rule.transform.before }).tr;
        for (const step of [...rule.transform.steps, ...transaction.steps])
          combined.step(step);
        transaction.setMeta(plugin, { ...rule, transform: combined });
      }
      return transaction
        .setMeta("addToHistory", false)
        .setMeta("richNormalization", true);
    },
  });
  return plugin;
}
let nextOrigin = 0;
export function richToEditor(value: RichText): EditorNode {
  const source = nextOrigin++;
  const inline = (
    node: RichNode,
    paragraph: number,
    index: number,
  ): EditorNode => {
    if (typeof node === "string")
      return schema.nodes.literal.create(
        { origin: { source, paragraph, index } },
        contents(node),
      );
    if (typeof node === "number")
      return schema.nodes.place.create({ index: node });
    if ("operand" in node)
      return schema.nodes.operand.create({ id: node.operand });
    if ("code" in node)
      return schema.nodes.code.create(null, contents(node.code));
    if ("word" in node)
      return schema.nodes.word_link.create(
        { word: { ...node.word } },
        contents(node.label),
      );
    return schema.nodes.web_link.create(
      { url: node.url },
      contents(node.label),
    );
  };
  const doc = schema.nodes.doc.create(
    null,
    value.length
      ? value.map((paragraph, p) =>
          paragraph.length === 1 && paragraph[0] === "\n"
            ? schema.nodes.paragraph.create()
            : schema.nodes.paragraph.create(
                null,
                paragraph.map((node, i) => inline(node, p, i)),
              ),
        )
      : schema.nodes.paragraph.create(),
  );
  return doc;
}
/** Active composition exports LF text without rewriting its native DOM. */
export function editorToRich(
  doc: EditorNode,
  editedFrom?: EditorNode,
): RichText {
  const retained = new Set<EditorNode>();
  editedFrom?.descendants((node) => {
    retained.add(node);
  });
  const text = (node: EditorNode) =>
    editedFrom && !retained.has(node)
      ? node.textContent.replace(/\r\n?/gu, "\n")
      : node.textContent;
  const value: RichText = [];
  for (const paragraph of storedNodeGroups(doc)) {
    const nodes: RichNode[] = [];
    for (const group of paragraph) {
      if (group.prose) {
        const joined = group.parts.map(({ node }) => node.textContent).join("");
        const edited =
          editedFrom &&
          (group.parts.length > 1 ||
            group.parts.some(({ node }) => !retained.has(node)));
        nodes.push(edited ? joined.replace(/\r\n?/gu, "\n") : joined);
        continue;
      }
      const node = group.parts[0].node;
      switch (node.type.name) {
        case "place":
          nodes.push(node.attrs.index);
          break;
        case "operand":
          nodes.push({ operand: node.attrs.id });
          break;
        case "code":
          nodes.push({ code: text(node) });
          break;
        case "word_link":
          nodes.push({ word: { ...node.attrs.word }, label: text(node) });
          break;
        case "web_link":
          nodes.push({ url: node.attrs.url, label: text(node) });
          break;
      }
    }
    if (nodes.length) value.push(nodes);
  }
  return canonicalRich(value);
}

/** Reserve explicit places throughout the current semicolon part. */
export function nextAutomaticPlace(
  doc: EditorNode,
  position: number,
): number | null {
  let start = 0,
    end = doc.content.size;
  const places: { position: number; index: number }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "place")
      places.push({ position: pos, index: node.attrs.index });
    if (["code", "word_link", "web_link", "operand"].includes(node.type.name))
      return false;
    if (node.isText)
      for (let i = 0; i < node.text!.length; i++) {
        if (node.text![i] !== ";") continue;
        if (pos + i < position) start = pos + i;
        else end = Math.min(end, pos + i);
      }
  });
  const used = new Set(
    places
      .filter((place) => place.position > start && place.position < end)
      .map((place) => place.index),
  );
  for (let next = 1; next <= 50; next++) if (!used.has(next)) return next;
  return null;
}

/** Split a literal container when an inline node replaces part of its text. */
export function replaceInline(
  state: EditorState,
  from: number,
  to: number,
  node: EditorNode,
): Transaction {
  const $from = state.doc.resolve(from),
    $to = state.doc.resolve(to);
  if (
    $from.sameParent($to) &&
    $from.parent.isInline &&
    ($from.parent.type.name === "literal" || from !== to)
  ) {
    const before = $from.parent.textContent.slice(0, $from.parentOffset);
    const after = $from.parent.textContent.slice($to.parentOffset);
    const nodes = [];
    if (before)
      nodes.push(
        $from.parent.type.create($from.parent.attrs, schema.text(before)),
      );
    nodes.push(node);
    if (after)
      nodes.push(
        $from.parent.type.create($from.parent.attrs, schema.text(after)),
      );
    const start = $from.before();
    const tr = state.tr.replaceWith(start, $from.after(), nodes);
    return tr.setSelection(
      TextSelection.near(
        tr.doc.resolve(
          start + (before ? before.length + 2 : 0) + node.nodeSize,
        ),
      ),
    );
  }
  // Code and link labels contain text only. Insert beside them.
  if (
    from === to &&
    $from.parent.isInline &&
    $from.parent.type.name !== "literal"
  ) {
    const start = $from.after();
    const tr = state.tr.insert(start, node);
    return tr.setSelection(
      TextSelection.near(tr.doc.resolve(start + node.nodeSize)),
    );
  }
  if ($from.parent.isInline && $from.parentOffset === 0) from = $from.before();
  if ($to.parent.isInline && $to.parentOffset === $to.parent.content.size)
    to = $to.after();
  return state.tr.replaceWith(from, to, node);
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Prefer the current DOM target without moving an equivalent outer caret inward. */
export function richInsertionSelection(
  state: EditorState,
  from: number,
  to: number,
) {
  const current = state.selection;
  if (from === to && current.empty && current.$from.parent.isTextblock) {
    const editable = (node: EditorNode | null) =>
      node?.isInline && !node.isText && !node.isAtom;
    if (
      (from === current.from - 1 && editable(current.$from.nodeBefore)) ||
      (from === current.from + 1 && editable(current.$from.nodeAfter))
    )
      return current;
  }
  return TextSelection.between(state.doc.resolve(from), state.doc.resolve(to));
}

/** Join from the paragraph edge so native editing cannot split saved text. */
function joinRichParagraph(
  tr: Transaction,
  position: number,
  direction: -1 | 1,
  dispatch?: (tr: Transaction) => void,
): boolean {
  const $cursor = tr.doc.resolve(position);
  const boundary = direction < 0 ? $cursor.before(1) : $cursor.after(1);
  if (boundary > 0 && boundary < tr.doc.content.size) {
    // The schema contains only paragraphs at this depth. Keep every step on tr.
    tr.join(boundary);
    tr.setSelection(
      TextSelection.near(tr.doc.resolve(boundary - 1), direction),
    );
  }
  if (tr.docChanged) dispatch?.(tr.scrollIntoView());
  // Consume the key even when there is no neighboring paragraph to join.
  return true;
}

/** Delete one character cluster without selecting a whole inline container. */
export function deleteRichBackward(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
): boolean {
  return deleteBackward(state.tr, dispatch);
}
function deleteBackward(
  tr: Transaction,
  dispatch?: (tr: Transaction) => void,
): boolean {
  if (!tr.selection.empty) return false;
  let $cursor = tr.selection.$from;
  if ($cursor.parent.isInline && !$cursor.parent.content.size) {
    const literal = $cursor.parent.type.name === "literal";
    tr.delete($cursor.before(), $cursor.after());
    if (!literal) {
      dispatch?.(tr.scrollIntoView());
      return true;
    }
    // Empty prose has no visible node to remove. Continue the same key press.
    $cursor = tr.selection.$from;
  }
  if (!$cursor.nodeBefore && $cursor.parent.isInline)
    $cursor = tr.doc.resolve($cursor.before());
  let previous = $cursor.nodeBefore;
  while (previous?.type.name === "literal" && !previous.content.size) {
    const position = $cursor.pos - previous.nodeSize;
    tr.delete(position, $cursor.pos);
    $cursor = tr.doc.resolve(position);
    previous = $cursor.nodeBefore;
  }
  if (!previous) return joinRichParagraph(tr, $cursor.pos, -1, dispatch);
  let end = $cursor.pos;
  let source: string;
  if (previous.isText) source = previous.text!;
  else if (previous.isInline && !previous.isAtom && previous.textContent) {
    source = previous.textContent;
    end--;
  } else if (previous.isAtom || (previous.isInline && !previous.content.size)) {
    dispatch?.(
      tr.delete($cursor.pos - previous.nodeSize, $cursor.pos).scrollIntoView(),
    );
    return true;
  } else return false;
  const last = graphemes.segment(source).containing(source.length - 1)?.segment;
  if (!last) return false;
  const from = end - last.length;
  tr.delete(from, end);
  tr.setSelection(TextSelection.near(tr.doc.resolve(from), -1));
  dispatch?.(tr.scrollIntoView());
  return true;
}

/** Forward Delete removes one character cluster or one atomic chip. */
export function deleteRichForward(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
): boolean {
  return deleteForward(state.tr, dispatch);
}
function deleteForward(
  tr: Transaction,
  dispatch?: (tr: Transaction) => void,
): boolean {
  if (!tr.selection.empty) return false;
  let $cursor = tr.selection.$from;
  if ($cursor.parent.isInline && !$cursor.parent.content.size) {
    dispatch?.(tr.delete($cursor.before(), $cursor.after()).scrollIntoView());
    return true;
  }
  if (!$cursor.nodeAfter && $cursor.parent.isInline)
    $cursor = tr.doc.resolve($cursor.after());
  const next = $cursor.nodeAfter;
  if (!next) return joinRichParagraph(tr, $cursor.pos, 1, dispatch);
  if (
    (!next.isText && next.isAtom) ||
    (next.isInline && !next.isText && !next.content.size)
  ) {
    dispatch?.(
      tr.delete($cursor.pos, $cursor.pos + next.nodeSize).scrollIntoView(),
    );
    return true;
  }
  const source = next.textContent;
  const first = graphemes.segment(source).containing(0)?.segment;
  if (!first) return false;
  const start = $cursor.pos + (next.isText ? 0 : 1);
  tr.delete(start, start + first.length);
  tr.setSelection(TextSelection.near(tr.doc.resolve($cursor.pos), 1));
  dispatch?.(tr.scrollIntoView());
  return true;
}

export type RichDeleteType = string;
const deleteTypes = new Set<string>([
  "deleteContentBackward",
  "deleteContentForward",
  "deleteWordBackward",
  "deleteWordForward",
  "deleteSoftLineBackward",
  "deleteSoftLineForward",
  "deleteHardLineBackward",
  "deleteHardLineForward",
  "deleteByCut",
]);
export function isRichDeleteType(
  inputType: string,
): inputType is RichDeleteType {
  return inputType.startsWith("delete");
}
export interface RichDeleteRange {
  from: number;
  to: number;
}

/** Flatten one paragraph for bounded word motion without changing its nodes. */
function paragraphText(tr: Transaction) {
  const $cursor = tr.selection.$from;
  const units: RichDeleteRange[] = [];
  let text = "";
  $cursor.node(1).descendants((node, position) => {
    const from = $cursor.start(1) + position;
    if (node.isText) {
      for (let offset = 0; offset < node.nodeSize; offset++)
        units.push({ from: from + offset, to: from + offset + 1 });
      text += node.text;
    } else if (
      node.isAtom ||
      (node.isInline && !node.content.size && node.type.name !== "literal")
    ) {
      text += "\ufffc";
      units.push({ from, to: from + node.nodeSize });
    }
  });
  const next = units.findIndex((unit) => unit.to > $cursor.pos);
  return { text, units, offset: next < 0 ? units.length : next };
}
const words = new Intl.Segmenter(undefined, { granularity: "word" });

function equivalentCaret(doc: EditorNode, position: number) {
  const $position = doc.resolve(position);
  if ($position.parent.isInline) {
    if ($position.parentOffset === 0) return $position.before();
    if ($position.parentOffset === $position.parent.content.size)
      return $position.after();
  }
  return position;
}

/** Trim each inline node separately so a range cannot merge different types. */
function deleteRichRange(tr: Transaction, from: number, to: number) {
  const paragraphs: { node: EditorNode; position: number }[] = [];
  tr.doc.forEach((node, position) => {
    if (position < to && position + node.nodeSize > from)
      paragraphs.push({ node, position });
  });
  if (!paragraphs.length) return tr;
  const nodes: EditorNode[] = [];
  let size = 0,
    caret: number | null = null;
  const append = (node: EditorNode) => {
    nodes.push(node);
    size += node.nodeSize;
  };
  for (const paragraph of paragraphs)
    paragraph.node.forEach((node, offset) => {
      const start = paragraph.position + 1 + offset,
        end = start + node.nodeSize;
      if (end <= from || start >= to) {
        if (start >= to && caret === null) caret = size;
        append(node);
        return;
      }
      const contentStart = start + (node.isText ? 0 : 1);
      const left = Math.max(
        0,
        Math.min(node.textContent.length, from - contentStart),
      );
      const right = Math.max(
        left,
        Math.min(node.textContent.length, to - contentStart),
      );
      if (caret === null)
        caret = size + (from <= start ? 0 : (node.isText ? 0 : 1) + left);
      if (from <= start && to >= end) return;
      if (left === right) {
        append(node);
        return;
      }
      if (node.isText) {
        const text = node.text!.slice(0, left) + node.text!.slice(right);
        if (text) append(schema.text(text));
      } else
        append(
          node.copy(node.content.cut(0, left).append(node.content.cut(right))),
        );
    });
  const first = paragraphs[0],
    last = paragraphs.at(-1)!;
  const paragraph = first.node.type.create(first.node.attrs, nodes);
  if (paragraphs.length > 1 || !first.node.eq(paragraph))
    tr.replaceWith(
      first.position,
      last.position + last.node.nodeSize,
      paragraph,
    );
  return tr.setSelection(
    TextSelection.near(tr.doc.resolve(first.position + 1 + (caret ?? size))),
  );
}

/** Own every deletion, including browser ranges that cross inline containers. */
export function deleteRichInput(
  tr: Transaction,
  inputType: RichDeleteType,
  dispatch?: (tr: Transaction) => void,
  target?: RichDeleteRange | null,
): boolean {
  if (!tr.selection.empty) {
    dispatch?.(
      deleteRichRange(tr, tr.selection.from, tr.selection.to)
        .setMeta("uiEvent", inputType === "deleteByCut" ? "cut" : "input")
        .scrollIntoView(),
    );
    return true;
  }
  if (inputType === "deleteByCut") return true;
  if (
    target &&
    (target.from < 0 ||
      target.to > tr.doc.content.size ||
      target.from >= target.to)
  )
    target = null;
  if (!deleteTypes.has(inputType) && inputType !== "deleteEntireSoftLine") {
    // Without a known direction, only an explicit target gives a safe extent.
    if (target) {
      tr.setSelection(
        TextSelection.between(
          tr.doc.resolve(target.from),
          tr.doc.resolve(target.to),
        ),
      );
      dispatch?.(deleteRichRange(tr, target.from, target.to).scrollIntoView());
    }
    return true;
  }
  const backward = inputType.endsWith("Backward");
  const character = backward ? deleteBackward : deleteForward;
  const { text, units, offset } = paragraphText(tr);
  // Paragraph edges take precedence over a browser's word or line extent.
  if (
    inputType !== "deleteEntireSoftLine" &&
    ((backward ? offset === 0 : offset === units.length) ||
      inputType.startsWith("deleteContent"))
  )
    return character(tr, dispatch);
  const caret = tr.selection.from;
  if (
    target &&
    target.from < target.to &&
    (inputType === "deleteEntireSoftLine" ||
      (backward
        ? equivalentCaret(tr.doc, target.to) === equivalentCaret(tr.doc, caret)
        : equivalentCaret(tr.doc, target.from) ===
          equivalentCaret(tr.doc, caret)))
  ) {
    tr.setSelection(
      TextSelection.between(
        tr.doc.resolve(target.from),
        tr.doc.resolve(target.to),
      ),
    );
  } else {
    let edge = backward ? 0 : units.length;
    if (inputType.startsWith("deleteWord")) {
      const segments = [...words.segment(text)];
      if (backward) {
        const segment = segments
          .reverse()
          .find((segment) => segment.index < offset && segment.segment.trim());
        edge = segment?.index ?? 0;
      } else {
        const segment = segments.find(
          (segment) =>
            segment.index + segment.segment.length > offset &&
            segment.segment.trim(),
        );
        edge = segment ? segment.index + segment.segment.length : units.length;
      }
    } else if (
      inputType.startsWith("deleteSoftLine") ||
      inputType === "deleteEntireSoftLine"
    ) {
      // A view normally supplies visual motion. Without it, use an inline LF.
      if (backward || inputType === "deleteEntireSoftLine") {
        const prefix = text.slice(0, offset);
        edge = Math.max(prefix.lastIndexOf("\n"), prefix.lastIndexOf("\r")) + 1;
      } else {
        const next = text.slice(offset).search(/[\r\n]/u);
        edge = next < 0 ? units.length : offset + next;
      }
    }
    if (edge === offset && inputType !== "deleteEntireSoftLine")
      return character(tr, dispatch);
    let end = Math.max(edge, offset);
    if (inputType === "deleteEntireSoftLine") {
      const next = text.slice(offset).search(/[\r\n]/u);
      end = next < 0 ? units.length : offset + next;
    }
    if (!units.length || edge === end) return true;
    const from = units[Math.min(edge, offset)].from;
    const to = units[end - 1].to;
    tr.setSelection(
      TextSelection.between(tr.doc.resolve(from), tr.doc.resolve(to)),
    );
  }
  dispatch?.(
    deleteRichRange(tr, tr.selection.from, tr.selection.to).scrollIntoView(),
  );
  return true;
}

const rulePattern = new RegExp(
  `(__([1-9]|[1-4][0-9]|50)__|___|[${CIRCLED_SOURCE}])$`,
  "u",
);
const maxPlaceTokenLength = "__50__".length;
/** Map the eligible text suffix to positions across literal containers. */
function placeMatch(doc: EditorNode, position: number, typed = "") {
  const $cursor = doc.resolve(position);
  const parent = $cursor.parent.type.name;
  if (parent !== "paragraph" && parent !== "literal") return null;
  const depth = $cursor.depth - (parent === "literal" ? 1 : 0);
  const paragraph = $cursor.node(depth);
  const start = $cursor.start(depth);
  let before = "";
  let positions: number[] = [];
  paragraph.forEach((node, offset) => {
    const nodeStart = start + offset;
    if (nodeStart >= position) return;
    if (!node.isText && node.type.name !== "literal") {
      before = "";
      positions = [];
      return;
    }
    const textStart = nodeStart + (node.isText ? 0 : 1);
    const count = Math.max(
      0,
      Math.min(node.textContent.length, position - textStart),
    );
    const text = node.textContent.slice(
      Math.max(0, count - maxPlaceTokenLength),
      count,
    );
    before += text;
    for (let index = count - text.length; index < count; index++)
      positions.push(textStart + index);
    before = before.slice(-maxPlaceTokenLength);
    positions = positions.slice(-maxPlaceTokenLength);
  });
  const value = before + typed;
  const match = rulePattern.exec(value);
  if (
    !match ||
    match[0].length < typed.length ||
    match.index + match[0].length !== value.length
  )
    return null;
  const existing = match[0].length - typed.length;
  return {
    match,
    from: existing ? positions[positions.length - existing] : position,
  };
}
export interface PlaceRuleOptions {
  enabled: () => boolean;
  composing?: () => boolean;
}
function insertedContent(transaction: Transaction): boolean {
  return transaction.steps.some((step, index) => {
    const { slice, from, to } = step as {
      slice?: Slice;
      from?: number;
      to?: number;
    };
    if (!slice?.size || from === undefined || to === undefined) return false;
    const inserted = slice.content.textBetween(
      0,
      slice.content.size,
      "",
      "\ufffc",
    );
    const removed = transaction.docs[index].textBetween(from, to, "", "\ufffc");
    // DOM deletion may replace a whole container with its remaining text.
    let matched = 0;
    for (let offset = 0; offset < removed.length; offset++)
      if (removed[offset] === inserted[matched]) matched++;
    return matched < inserted.length;
  });
}
interface CompositionState {
  before: EditorNode | null;
  inserted: boolean;
  committed: boolean;
}
export function placeInputPlugins(options: PlaceRuleOptions): Plugin[] {
  const replacement = (
    state: EditorState,
    match: RegExpMatchArray,
    from: number,
    to: number,
  ) => {
    if (!options.enabled()) return null;
    const parent = state.doc.resolve(from).parent.type.name;
    if (parent !== "paragraph" && parent !== "literal") return null;
    const index = match[2]
      ? Number(match[2])
      : (circledPlace(match[1]) ?? nextAutomaticPlace(state.doc, from));
    return index === null
      ? null
      : replaceInline(state, from, to, schema.nodes.place.create({ index }));
  };
  const rules = inputRules({ rules: [] });
  // The stock matcher counts text characters without inline container positions.
  rules.props.handleTextInput = (view, from, to, text) => {
    if (view.composing) return false;
    const found = placeMatch(view.state.doc, from, text);
    if (!found) return false;
    const tr = replacement(view.state, found.match, found.from, to);
    if (!tr) return false;
    view.dispatch(tr.setMeta(rules, { transform: tr, from, to, text }));
    return true;
  };
  // The tracked fallback owns completion, so a canceled IME cannot read old paste.
  rules.props.handleDOMEvents!.compositionend = () => false;
  const fallback: Plugin<CompositionState> = new Plugin<CompositionState>({
    state: {
      init: () => ({ before: null, inserted: false, committed: false }),
      apply(tr, previous) {
        if (tr.getMeta("richNormalization")) return previous;
        if (tr.getMeta("richCompositionStart"))
          return { before: tr.doc, inserted: false, committed: false };
        if (tr.getMeta("richCompositionEnd"))
          return {
            before: null,
            inserted: false,
            committed:
              previous.inserted &&
              previous.before !== null &&
              !tr.doc.eq(previous.before),
          };
        if (
          tr.getMeta(rules) ||
          tr.getMeta("richExternal") ||
          tr.getMeta("richRuleUndo")
        )
          return { before: null, inserted: false, committed: false };
        const pasted = ["paste", "drop"].includes(tr.getMeta("uiEvent"));
        return {
          ...previous,
          committed: false,
          inserted:
            previous.inserted ||
            (previous.before !== null && !pasted && insertedContent(tr)),
        };
      },
    },
    appendTransaction(transactions, _old, state) {
      if (
        !options.enabled() ||
        options.composing?.() ||
        transactions.some(
          (tr) =>
            tr.getMeta("richRuleUndo") ||
            tr.getMeta("richExternal") ||
            tr.getMeta("uiEvent") === "paste" ||
            tr.getMeta("uiEvent") === "drop" ||
            tr.getMeta(rules),
        )
      )
        return null;
      const committed =
        transactions.some((tr) => tr.getMeta("richCompositionEnd")) &&
        fallback.getState(state)?.committed;
      if (
        !committed &&
        !transactions.some((tr) => tr.docChanged && insertedContent(tr))
      )
        return null;
      const { $from, empty } = state.selection;
      if (!empty || !["paragraph", "literal"].includes($from.parent.type.name))
        return null;
      const found = placeMatch(state.doc, $from.pos);
      if (!found) return null;
      const tr = replacement(state, found.match, found.from, $from.pos);
      if (!tr) return null;
      return tr.setMeta(rules, {
        transform: tr,
        from: $from.pos,
        to: $from.pos,
        text: "",
      });
    },
  });
  return [rules, fallback];
}

/** Plain paste never interprets HTML, links, code, or underscore syntax. */
export function pastedRichText(text: string, convertPlaces: boolean): RichText {
  return text
    .replace(/\r\n?/gu, "\n")
    .split(/\n\n/u)
    .map((paragraph) => {
      if (!convertPlaces) return paragraph ? [paragraph] : ["\n"];
      return paragraph
        ? paragraph
            .split(new RegExp(`([${CIRCLED_SOURCE}])`, "u"))
            .filter(Boolean)
            .map((part) => circledPlace(part) ?? part)
        : ["\n"];
    });
}

/** Older private drafts stored a few rich fields as plain strings. */
export { richValue } from "./rich-values.ts";
