/** Direct mappings keep every stored inline node and paragraph boundary. */
import { Schema, type Node as EditorNode } from "prosemirror-model";
import {
  EditorState,
  Plugin,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import { InputRule, inputRules } from "prosemirror-inputrules";
import { CIRCLED_SOURCE, circledPlace, placeGlyph } from "./place-glyphs.ts";
import type { RichNode, RichText } from "./types.ts";

const inlineText = (tag: string, className: string) => ({
  inline: true,
  group: "inline",
  content: "text*",
  defining: true,
  toDOM: () =>
    [tag, { class: className }, 0] as [string, Record<string, string>, number],
});
export const richEditorSchema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "inline*", toDOM: () => ["p", 0] },
    text: { group: "inline" },
    // Containers preserve boundaries between adjacent stored strings.
    literal: inlineText("span", "rich-literal"),
    place: {
      inline: true,
      group: "inline",
      atom: true,
      attrs: { index: {} },
      leafText: (node) => placeGlyph(node.attrs.index),
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
          "data-target": node.attrs.url,
        },
        0,
      ],
    },
  },
});
const schema = richEditorSchema;
const contents = (value: string) => (value ? schema.text(value) : undefined);
export function richToEditor(value: RichText): EditorNode {
  const inline = (node: RichNode): EditorNode => {
    if (typeof node === "string")
      return schema.nodes.literal.create(null, contents(node));
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
  return schema.nodes.doc.create(
    null,
    value.length
      ? value.map((paragraph) =>
          schema.nodes.paragraph.create(null, paragraph.map(inline)),
        )
      : schema.nodes.paragraph.create(),
  );
}
export function editorToRich(doc: EditorNode): RichText {
  const value: RichText = [];
  doc.forEach((paragraph) => {
    const nodes: RichNode[] = [];
    paragraph.forEach((node) => {
      switch (node.type.name) {
        case "text":
        case "literal":
          if (node.textContent) nodes.push(node.textContent);
          break;
        case "place":
          nodes.push(node.attrs.index);
          break;
        case "operand":
          nodes.push({ operand: node.attrs.id });
          break;
        case "code":
          nodes.push({ code: node.textContent });
          break;
        case "word_link":
          nodes.push({ word: { ...node.attrs.word }, label: node.textContent });
          break;
        case "web_link":
          nodes.push({ url: node.attrs.url, label: node.textContent });
          break;
      }
    });
    if (nodes.length) value.push(nodes);
  });
  return value;
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
  if ($from.sameParent($to) && $from.parent.type.name === "literal") {
    const before = $from.parent.textContent.slice(0, $from.parentOffset);
    const after = $from.parent.textContent.slice($to.parentOffset);
    const nodes = [];
    if (before)
      nodes.push(schema.nodes.literal.create(null, schema.text(before)));
    nodes.push(node);
    if (after)
      nodes.push(schema.nodes.literal.create(null, schema.text(after)));
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
  if ($from.parent.isInline && $from.parent.type.name !== "literal") {
    const start = $from.after();
    const tr = state.tr.insert(start, node);
    return tr.setSelection(
      TextSelection.near(tr.doc.resolve(start + node.nodeSize)),
    );
  }
  return state.tr.replaceWith(from, to, node);
}

const rulePattern = new RegExp(
  `(__([1-9]|[1-4][0-9]|50)__|___|[${CIRCLED_SOURCE}])$`,
  "u",
);
export interface PlaceRuleOptions {
  enabled: () => boolean;
  composing?: () => boolean;
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
  const rules = inputRules({
    rules: [new InputRule(rulePattern, replacement)],
  });
  const fallback = new Plugin({
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
      if (
        !transactions.some(
          (tr) => tr.docChanged || tr.getMeta("richCompositionEnd"),
        )
      )
        return null;
      const { $from, empty } = state.selection;
      if (!empty || !["paragraph", "literal"].includes($from.parent.type.name))
        return null;
      const before = $from.parent.textBetween(
        0,
        $from.parentOffset,
        undefined,
        "\ufffc",
      );
      const match = rulePattern.exec(before);
      if (!match) return null;
      const tr = replacement(
        state,
        match,
        $from.pos - match[0].length,
        $from.pos,
      );
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
      if (!convertPlaces) return paragraph ? [paragraph] : [];
      return paragraph
        .split(new RegExp(`([${CIRCLED_SOURCE}])`, "u"))
        .filter(Boolean)
        .map((part) => circledPlace(part) ?? part);
    });
}

/** Older private drafts stored a few rich fields as plain strings. */
export function richValue(value: RichText | string | undefined): RichText {
  return typeof value === "string"
    ? value
      ? pastedRichText(value, false)
      : []
    : (value ?? []);
}
