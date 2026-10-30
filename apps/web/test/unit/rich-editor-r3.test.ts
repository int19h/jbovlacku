import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { EditorState, TextSelection } from "prosemirror-state";
import { history, undo } from "prosemirror-history";
import {
  initializeCore,
  omitDefinitionDefaults,
} from "../../../../packages/core/src/index.ts";
import {
  newDraft,
  newPlace,
  draftToBody,
  normalizeDraft,
  type Draft,
} from "../../src/model/draft.ts";
import {
  richToEditor,
  editorToRich,
  deleteRichBackward,
  deleteRichForward,
  replaceInline,
  richEditorSchema,
} from "../../src/model/rich-editor.ts";
import type { RichNode, RichText } from "../../src/model/types.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL(
        "../../../../packages/core/generated/jvc_runtime_bg.wasm",
        import.meta.url,
      ),
    ),
  ),
);

test("r3 stored paragraphs omit all whitespace-only paragraphs and retain exact nonblank arrays", () => {
  const retained: RichText = [
    [" left ", "right", { code: "" }],
    [{ url: "https://example.org/", label: "" }],
  ];
  const value: RichText = [
    [" \n\t"],
    retained[0],
    ["\n"],
    [" ", "\t"],
    retained[1],
    ["\n"],
  ];
  assert.deepEqual(editorToRich(richToEditor(value)), retained);
  assert.deepEqual(editorToRich(richToEditor([["\n"]])), []);
});

test("r3 a saved single blank paragraph has one canonical value before edits and after undo", () => {
  let state = EditorState.create({
    doc: richToEditor([["\n"]]),
    plugins: [history()],
  });
  assert.deepEqual(editorToRich(state.doc), []);
  state = state.apply(
    state.tr.setSelection(TextSelection.atEnd(state.doc)).insertText("x"),
  );
  assert.deepEqual(editorToRich(state.doc), [["x"]]);
  assert.equal(
    undo(state, (tr) => {
      state = state.apply(tr);
    }),
    true,
  );
  assert.deepEqual(editorToRich(state.doc), []);
});

test("r3 edited empty notes stay absent while untouched draft fields keep their values", () => {
  const blank: RichText = [["\n"], [" \t"]];
  const retained: RichText = [[" first", " second ", { code: "" }]];
  const padded: RichText = [blank[0], retained[0], blank[1]];
  const place = newPlace(1);
  place.description = padded;
  place.constraints = [blank, padded];
  place.defaults = [
    {
      kind: "suggested",
      format: "prose",
      language: "en",
      text: "a default",
      condition: blank,
      explanation: padded,
    },
  ];
  const draft = newDraft({
    spelling: "broda",
    kind: "gismu",
    text: padded,
    notes: blank,
    etymologyText: blank,
    formNotes: blank,
    frameMode: "context",
    places: [place],
    frameConstraints: [blank, padded],
    operands: [
      {
        id: "bridi",
        category: "bridi",
        description: padded,
        minimum: 1,
        maximum: 1,
      },
    ],
    examples: [
      { language: "jbo", text: "mi klama", translation: blank, notes: padded },
    ],
  });
  const ai = {
    records: [
      {
        id: "preserve-evidence",
        key: "definition",
        label: "Definition",
        operation: "definition",
        fingerprint: "original",
        requested: {
          word_type: "gismu",
          classification: null,
          spelling: "broda",
          text: padded,
          frame: null,
          glosses: [],
          formation: null,
          compound: null,
        },
        result: {
          operation: "definition",
          draft_revision: "original",
          proposals: [{ path: "/notes", value: blank }],
          explanation: "Keep original evidence.",
          provenance: {
            provider: "mock",
            model: "mock",
            revision: null,
            recipe: "local-test",
            seed: null,
          },
          usage: null,
          log: { notes: blank, nested: { text: blank } },
        },
        log: { notes: blank },
        log_json: '{"notes":[[" "]]}',
        error: null,
        state: "done",
      },
    ],
  } as NonNullable<Draft["ai"]>;
  const withEvidence = newDraft({ ...draft, ai });
  assert.equal(
    withEvidence.ai,
    ai,
    "writer normalization keeps raw inference and proposal evidence untouched",
  );
  assert.deepEqual(
    withEvidence.ai!.records[0].result!.proposals[0].value,
    blank,
  );
  const originalText = structuredClone(draft.text);
  draft.notes = editorToRich(richToEditor(blank));
  const saved = normalizeDraft(draft);
  assert.deepEqual(saved.text, padded);
  assert.deepEqual(saved.notes, []);
  assert.deepEqual(saved.places[0].description, padded);
  const { body } = draftToBody(draft);
  assert.ok(body);
  assert.deepEqual(body.text, padded);
  assert.deepEqual(body.frame!.places[0].description, padded);
  assert.deepEqual(body.frame!.places[0].constraints, [blank, padded]);
  assert.deepEqual(body.frame!.constraints, [blank, padded]);
  assert.deepEqual(body.operands[0].description, padded);
  assert.deepEqual(body.examples[0].notes, padded);
  assert.deepEqual(body.examples[0].translation, blank);
  assert.deepEqual(body.notes, []);
  assert.deepEqual(body.etymology.text, [...blank, ...blank]);
  const wire = omitDefinitionDefaults(body) as any;
  assert.equal("notes" in wire, false);
  assert.deepEqual(wire.etymology.text, [...blank, ...blank]);
  assert.deepEqual(
    draft.text,
    originalText,
    "publication leaves the live input unchanged",
  );
});

test("r3 Backspace past an emptied literal deletes the preceding visible grapheme", () => {
  let state = EditorState.create({
    doc: richToEditor([["keep ", { code: "ab" }, "y"]]),
  });
  state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
  const erase = () =>
    assert.equal(
      deleteRichBackward(state, (tr) => {
        state = state.apply(tr);
      }),
      true,
    );
  erase();
  assert.deepEqual(editorToRich(state.doc), [["keep ", { code: "ab" }]]);
  erase();
  assert.deepEqual(editorToRich(state.doc), [["keep ", { code: "a" }]]);
});

test("r3 seeded edits choose interior positions, selections, commands, and containers with exact untouched ranges", () => {
  let seed = 0x3ed1751;
  const random = (limit: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
  const outer: RichText = [
    ["before", " exact", { code: "\r\n①" }],
    ["after", " exact", { url: "https://example.org/", label: "" }],
  ];
  const fragments = ["abc", "a🙂z", "a e\u0301 z", "one\ntwo"];
  const seen = new Set<string>();
  for (let sample = 0; sample < 160; sample++) {
    const kind = sample % 4;
    const make = (text: string): RichNode =>
      kind === 0
        ? text
        : kind === 1
          ? { code: text }
          : kind === 2
            ? { word: { language: "jbo", spelling: "cukta" }, label: text }
            : { url: "https://example.org/target", label: text };
    let text = fragments[random(fragments.length)];
    let state = EditorState.create({
      doc: richToEditor([
        outer[0],
        ["left", " boundary", make(text), " right", " boundary"],
        outer[1],
      ]),
    });
    const offset = state.doc.firstChild!.nodeSize + 1;
    const targetStart = () =>
      offset +
      state.doc.child(1).child(0).nodeSize +
      state.doc.child(1).child(1).nodeSize +
      1;
    const check = (expected: RichNode[], label: string) => {
      const stored = editorToRich(state.doc);
      assert.deepEqual(
        stored,
        [outer[0], expected, outer[1]],
        `${sample} ${label}`,
      );
      state.doc.check();
      for (const paragraph of stored)
        for (const node of paragraph) {
          const value =
            typeof node === "string"
              ? node
              : typeof node === "number" || "operand" in node
                ? ""
                : "code" in node
                  ? node.code
                  : node.label;
          assert.doesNotMatch(
            value,
            /[\uD800-\uDFFF]/u,
            `${sample} ${label} well-formed text`,
          );
        }
      assert.deepEqual(
        editorToRich(richToEditor(stored)),
        stored,
        `${sample} round trip`,
      );
    };
    for (let step = 0; step < 12; step++) {
      const boundaries = [
        ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
          text,
        ),
      ].map((part) => part.index);
      boundaries.push(text.length);
      const start = random(boundaries.length);
      const end = start + random(boundaries.length - start);
      const from = boundaries[start],
        to = boundaries[end];
      const command = random(4);
      const at = targetStart();
      state = state.apply(
        state.tr.setSelection(
          TextSelection.create(state.doc, at + from, at + to),
        ),
      );
      if (command < 2 || from !== to || !text) {
        const inserted = command === 0 ? "P\nQ" : "XY";
        state = state.apply(
          state.tr
            .insertText(inserted)
            .setMeta("uiEvent", command === 0 ? "paste" : "input"),
        );
        text = text.slice(0, from) + inserted + text.slice(to);
        seen.add(command === 0 ? "paste" : "selection");
      } else if (command === 2 && start > 0) {
        deleteRichBackward(state, (tr) => {
          state = state.apply(tr);
        });
        text = text.slice(0, boundaries[start - 1]) + text.slice(from);
        seen.add("backward");
      } else if (command === 3 && start < boundaries.length - 1) {
        deleteRichForward(state, (tr) => {
          state = state.apply(tr);
        });
        text = text.slice(0, from) + text.slice(boundaries[start + 1]);
        seen.add("forward");
      }
      check(
        [
          "left",
          " boundary",
          ...(text || kind ? [make(text)] : []),
          " right",
          " boundary",
        ],
        `step ${step}`,
      );
      if (!text && kind === 0) break;
    }
    // Pick a range across saved strings and a code or link boundary.
    const target = state.doc.child(1).child(2);
    const starts = [
      ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
        target.textContent,
      ),
    ].map((part) => part.index);
    starts.push(target.content.size);
    const from = targetStart() + starts[random(starts.length)];
    const right =
      offset +
      state.doc.child(1).child(0).nodeSize +
      state.doc.child(1).child(1).nodeSize +
      target.nodeSize +
      1;
    const to = right + 1 + random(5);
    const prefix = text.slice(0, from - targetStart());
    state = state.apply(
      replaceInline(
        state,
        from,
        to,
        richEditorSchema.nodes.place.create({ index: (sample % 50) + 1 }),
      ),
    );
    check(
      [
        "left",
        " boundary",
        ...(prefix ? [make(prefix)] : []),
        (sample % 50) + 1,
        " right".slice(to - right),
        " boundary",
      ].filter((node) => node !== ""),
      "cross-node insert",
    );
    seen.add(`kind${kind}`);
    // An emptied literal has no visible boundary to consume on its own.
    state = EditorState.create({
      doc: richToEditor([
        outer[0],
        [make("keep"), "x", { code: "suffix" }],
        outer[1],
      ]),
    });
    const literalEnd =
      state.doc.firstChild!.nodeSize +
      1 +
      state.doc.child(1).child(0).nodeSize +
      2;
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, literalEnd)),
    );
    deleteRichBackward(state, (tr) => {
      state = state.apply(tr);
    });
    const before = editorToRich(state.doc);
    deleteRichBackward(state, (tr) => {
      state = state.apply(tr);
    });
    assert.notDeepEqual(
      editorToRich(state.doc),
      before,
      `${sample} visible deletion`,
    );
    assert.deepEqual(editorToRich(state.doc)[0], outer[0]);
    assert.deepEqual(editorToRich(state.doc).at(-1), outer[1]);
  }
  assert.deepEqual([...seen].sort(), [
    "backward",
    "forward",
    "kind0",
    "kind1",
    "kind2",
    "kind3",
    "paste",
    "selection",
  ]);
});
