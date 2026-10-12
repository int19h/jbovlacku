/**
 * Step 4 and the full editor. The definition, glosses, places, and the named
 * disclosures edit one draft. The full editor opens every section and also
 * permits the headword, type, operands, labels, and classification.
 */
import {
  el,
  p,
  text,
  button,
  field,
  link,
  checkbox,
  disclosure,
  describe,
} from "../../lib/dom.ts";
import {
  navigate,
  routes,
  type RenderContext,
  type Route,
} from "../../app/router.ts";
import type { App } from "../../app/context.ts";
import {
  draftFromBody,
  draftToBody,
  revisionChanges,
  hintForChoice,
  kindChoices,
  editorText,
  editorToRichText,
  fieldsReferencing,
  literalLoss,
  literalize,
  newPlace,
  rewriteReferences,
  richTextToEditor,
  switchMode,
  type DraftGloss,
  numberPlaceholders,
  renumber,
  type Draft,
  type DraftDefault,
  type DraftExample,
  type DraftPlace,
  type FrameMode,
  type KindChoice,
} from "../../model/draft.ts";
import {
  lexicalKinds,
  type LexicalKind,
  type TypeHint,
} from "../../model/types.ts";
import { loadDefinition } from "../../data/api.ts";
import {
  countNodes,
  placeMarker,
  renderRichText,
} from "../../model/richtext.ts";
import type { RichText } from "../../model/types.ts";
import {
  actionBar,
  confirmKindChange,
  DraftSaver,
  loadDraft,
  startDraft,
  stepBar,
  DRAFT_KEY,
} from "./common.ts";
import { describeArity } from "../../components/definition.ts";

const standardTags = [
  "entity",
  "agent",
  "event",
  "state",
  "process",
  "relation",
  "proposition",
  "number",
  "text",
  "set",
  "mass",
  "sequence",
  "tuple",
];
const standardAbstractors = [
  "nu",
  "du'u",
  "ka",
  "ni",
  "jei",
  "li'i",
  "si'o",
  "su'u",
  "mu'e",
  "pu'u",
  "za'i",
  "zu'o",
];
function insertAtCursor(input: HTMLTextAreaElement, value: string) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.setRangeText(value, start, end, "end");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
}
/** The complete type hint editor, for custom kinds. */
function hintEditor(
  current: TypeHint | null,
  onChange: (hint: TypeHint | null) => void,
): HTMLElement {
  const box = el("div", { class: "sunk", style: "margin-top:8px" });
  const alternatives = current?.alternatives.map((a) => ({
    ...a,
    tags: [...a.tags],
  })) ?? [{ tags: [], abstractor: null, relation_arity: null }];
  // The note keeps its exact rich value. Only an edit of the note field parses text.
  let note: RichText = current ? current.note : [];
  const emit = () => {
    const cleaned = alternatives
      .map((a) => ({
        tags: [...new Set(a.tags.map((t) => t.trim()).filter(Boolean))].sort(),
        abstractor: a.abstractor?.trim() || null,
        relation_arity: a.relation_arity,
      }))
      .filter((a) => a.tags.length || a.abstractor || a.relation_arity);
    onChange(
      cleaned.length
        ? {
            alternatives: cleaned,
            note,
          }
        : null,
    );
  };
  const render = () => {
    box.replaceChildren(
      p(
        "Kind of thing in full. Each alternative applies its fields together. Custom tags use an HTTPS URI.",
        "meta",
      ),
    );
    alternatives.forEach((alt, index) => {
      const row = el("div", {
        style:
          "display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-top:8px",
      });
      const tags = field(`Tags for alternative ${index + 1}`, {
        value: alt.tags.join(", "),
        placeholder: standardTags.slice(0, 4).join(", ") + "…",
        wrapperClass: "",
        hint: `Standard: ${standardTags.join(", ")}`,
      });
      tags.input.addEventListener("input", () => {
        alt.tags = tags.input.value
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        emit();
      });
      const abstractor = field(`Abstractor for alternative ${index + 1}`, {
        options: [
          { value: "", label: "none" },
          ...standardAbstractors.map((a) => ({ value: a, label: a })),
        ],
        value: alt.abstractor ?? "",
        wrapperClass: "",
      });
      abstractor.input.addEventListener("change", () => {
        alt.abstractor = abstractor.input.value || null;
        emit();
      });
      const arityMode = field(`Relation arity for alternative ${index + 1}`, {
        options: [
          { value: "none", label: "none" },
          { value: "fixed", label: "exactly N" },
          { value: "variadic", label: "N or more" },
          { value: "context", label: "depends on context" },
        ],
        value: alt.relation_arity?.mode ?? "none",
        wrapperClass: "",
      });
      const count = field(`Count for alternative ${index + 1}`, {
        type: "number",
        value:
          alt.relation_arity && "count" in alt.relation_arity
            ? String(alt.relation_arity.count)
            : alt.relation_arity && "minimum" in alt.relation_arity
              ? String(alt.relation_arity.minimum)
              : "1",
        wrapperClass: "",
      });
      count.input.min = "0";
      count.input.max = "65535";
      const syncArity = () => {
        const n = Math.max(0, Math.min(65535, Number(count.input.value) || 0));
        alt.relation_arity =
          arityMode.input.value === "fixed"
            ? { mode: "fixed", count: n }
            : arityMode.input.value === "variadic"
              ? { mode: "variadic", minimum: n }
              : arityMode.input.value === "context"
                ? { mode: "context" }
                : null;
        emit();
      };
      arityMode.input.addEventListener("change", syncArity);
      count.input.addEventListener("input", syncArity);
      tags.wrapper.style.flex = "2 1 220px";
      row.append(
        tags.wrapper,
        abstractor.wrapper,
        arityMode.wrapper,
        count.wrapper,
      );
      if (alternatives.length > 1)
        row.append(
          button(
            `Remove alternative ${index + 1}`,
            () => {
              alternatives.splice(index, 1);
              emit();
              render();
            },
            { class: "btn btn-quiet" },
          ),
        );
      box.append(row);
    });
    const noteField = field("Type note", {
      value: richTextToEditor(note),
      wrapperClass: "",
      placeholder: "optional",
    });
    noteField.input.addEventListener("input", () => {
      note = editorToRichText(noteField.input.value, true);
      emit();
    });
    box.append(
      noteField.wrapper,
      el(
        "div",
        { class: "actions", style: "margin-top:8px" },
        button(
          "Add an alternative",
          () => {
            if (alternatives.length >= 32) return;
            alternatives.push({
              tags: [],
              abstractor: null,
              relation_arity: null,
            });
            render();
          },
          { class: "btn btn-quiet" },
        ),
      ),
    );
  };
  render();
  return box;
}
/** What the next render of the page says about a Revise copy. */
let reviseNotice: string[] | null = null;
export async function placesPage(
  route: Route,
  context: RenderContext,
  app: App,
) {
  const { main } = context;
  const full = route.path === "/new/editor";
  context.title(full ? "Full editor" : "Add a word: Places");
  main.className = "surface-wizard";
  if (!app.session.storageAvailable) {
    main.append(
      el("h1", { class: "page", text: "Add a word" }),
      p(
        "Browser storage is unavailable, so drafts cannot be saved. Restore storage access and reload.",
        "notice",
      ),
    );
    return;
  }
  let draft = await loadDraft(app);
  const reviseId = route.params.get("revise");
  if (reviseId && (!draft || draft.parents[0] !== reviseId)) {
    // Revise copies the publication into a new draft with its exact parent ID.
    if (
      draft &&
      (countNodes(draft.text) || draft.meaning.trim()) &&
      !confirm(
        `Revising replaces the saved draft for "${draft.spelling || "a new word"}". Continue?`,
      )
    ) {
      navigate("/new/meaning", { replace: true });
      return;
    }
    try {
      const record = await loadDefinition(reviseId);
      if (!context.live()) return;
      if (!record.body)
        throw new Error(
          record.bodyError ??
            "The parent body is unavailable, so it cannot be revised.",
        );
      const origin =
        record.envelope.header.action.origin === "import" ? "import" : "native";
      const replaced = draft;
      draft = draftFromBody(record.body, reviseId, origin);
      reviseNotice = revisionChanges(record.body, origin);
      await app.store.saveDraft(
        DRAFT_KEY,
        draft,
        replaced ? { revision: replaced.revision } : "absent",
      );
    } catch (error) {
      main.append(
        el("h1", { class: "page", text: "Revise" }),
        p(describe(error), "notice"),
      );
      return;
    }
  }
  if (!context.live()) return;
  if (!draft) {
    if (full)
      draft = await startDraft(
        app,
        {
          step: 4,
          language: app.session.preferences.definitionLanguage,
        },
        "absent",
      );
    else {
      navigate("/new/meaning", { replace: true });
      return;
    }
  }
  const saver = new DraftSaver(app, draft);
  main.append(stepBar(draft, 4));
  if (reviseNotice) {
    const changes = reviseNotice;
    reviseNotice = null;
    main.append(
      p(
        changes.length
          ? `This draft copies every field of the parent definition. A native revision changes ${changes.join("; ")}. Everything else stays as signed until you edit it.`
          : "This draft copies every field of the parent definition. It changes only the parent link. Everything else stays as signed until you edit it.",
        "notice",
      ),
    );
  }
  const headline = el("div", {
    style: "display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 20px",
  });
  const h1 = el("h1", {
    class: "page",
    lang: "jbo",
    text: draft.spelling || (full ? "Full editor" : "Places"),
  });
  const kindTag = el("span", {
    class: "meta",
    style: "font-size:15px",
    text: `${draft.kind ?? "type not chosen"} · ${draft.language}`,
  });
  headline.append(
    h1,
    kindTag,
    el("span", {
      class: "meta",
      style: "margin-left:auto",
      text: "AI fill-in is not configured on this server",
    }),
  );
  main.append(headline);
  if (draft.parents.length)
    main.append(
      el(
        "p",
        { class: "small", style: "margin-top:8px" },
        text("Revision of "),
        link(draft.parents[0], routes.definition(draft.parents[0]), {
          class: "fingerprint",
        }),
        text(
          draft.revisedImport
            ? ". The imported attribution stays with the parent. Your contribution is released under CC0 1.0."
            : ". It inherits no judgments.",
        ),
      ),
    );
  if (draft.review.length)
    main.append(
      p(
        `Marked for review after a change of ${draft.review.join(", ")}: translations and language-specific glosses were not relabeled.`,
        "notice",
      ),
    );
  // Headword and type, in the full editor.
  if (full) {
    const identity = el("div", {
      style: "display:flex;flex-wrap:wrap;gap:12px 16px;margin-top:16px",
    });
    const spelling = field("Headword", {
      value: draft.spelling,
      spellcheck: false,
      lang: "jbo",
      wrapperClass: "",
    });
    spelling.input.addEventListener("input", () => {
      draft.spelling = spelling.input.value;
      h1.textContent = draft.spelling || "Full editor";
      saver.touch();
    });
    const kind = field("Type", {
      options: [
        { value: "", label: "choose" },
        ...lexicalKinds.map((k) => ({
          value: k,
          label: k === "fuivla" ? "fu'ivla" : k,
        })),
      ],
      value: draft.kind ?? "",
      wrapperClass: "",
    });
    kind.input.addEventListener("change", () => {
      const next = (kind.input.value || null) as LexicalKind | null;
      if (!confirmKindChange(draft, next)) {
        kind.input.value = draft.kind ?? "";
        return;
      }
      kindTag.textContent = `${draft.kind ?? "type not chosen"} · ${draft.language}`;
      saver.touch();
      refreshPreview();
    });
    const language = field("Definition language", {
      value: draft.language,
      wrapperClass: "",
      spellcheck: false,
    });
    language.input.addEventListener("input", () => {
      if (
        language.input.value !== draft.language &&
        (draft.glosses.length || countNodes(draft.text))
      )
        draft.review = [...new Set([...draft.review, "language"])];
      draft.language = language.input.value.trim();
      kindTag.textContent = `${draft.kind ?? "type not chosen"} · ${draft.language}`;
      saver.touch();
    });
    const selmaho = field("selma'o", {
      value: draft.selmaho.join(", "),
      wrapperClass: "",
      placeholder: "cmavo only",
    });
    selmaho.input.addEventListener("input", () => {
      draft.selmaho = selmaho.input.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      saver.touch();
    });
    for (const f of [spelling, kind, language, selmaho]) {
      f.wrapper.style.flex = "1 1 160px";
      identity.append(f.wrapper);
    }
    main.append(identity);
  }
  // Definition editor.
  const defSection = el("section", {
    "aria-labelledby": "def-h",
    style: "margin-top:20px",
  });
  defSection.append(
    el("h2", {
      id: "def-h",
      class: "section",
      style: "margin-top:0",
      text: "Definition",
    }),
  );
  const toolbar = el("div", {
    role: "toolbar",
    "aria-label": "Insert",
    style:
      "display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;align-items:center",
  });
  /** Inputs that mirror draft fields a reference rewrite can change. */
  const mirrors = new Set<() => void>();
  const syncMirrors = () => {
    for (const sync of mirrors) sync();
  };
  const editor = field("Definition text", {
    multiline: true,
    rows: 4,
    value: editorText(draft.text, draft.structured),
    labelClass: "sr",
  });
  editor.input.style.fontSize = "19px";
  editor.input.style.lineHeight = "1.7";
  const nextPlaceNumber = () =>
    draft.places.length
      ? Math.max(...draft.places.map((pl) => pl.index)) + 1
      : 1;
  toolbar.append(
    button(
      "Place",
      () => {
        const n = draft.places.length
          ? draft.places[draft.places.length - 1].index
          : nextPlaceNumber();
        if (!draft.places.length) addPlace();
        insertAtCursor(
          editor.input,
          n <= 20 ? String.fromCodePoint(0x245f + n) : `{place ${n}}`,
        );
      },
      {
        class: "btn btn-quiet",
        style: "min-height:36px;font-size:14px",
        title: "Insert a reference to the last declared place",
      },
    ),
    button(
      "Link a word",
      () => {
        const spelling = prompt("Lojban word to link");
        if (spelling?.trim())
          insertAtCursor(editor.input, `[[${spelling.trim()}]]`);
      },
      { class: "btn btn-quiet", style: "min-height:36px;font-size:14px" },
    ),
    el("span", {
      class: "meta",
      style: "margin-left:6px",
      text: "or type ① ② ③. Places above 20 use {place N}.",
    }),
  );
  const structured = checkbox(
    "Read circled numbers as place references",
    draft.structured,
    (value) => {
      // Literal mode turns the place references of every field into circled
      // characters as text. Links, code, and operands stay. The author sees
      // the list of fields with references first.
      const lost = value ? [] : literalLoss(draft);
      if (
        lost.length &&
        !confirm(
          `Literal mode turns the place references in ${lost.join(", ")} into circled characters as text. Links and code stay. Continue?`,
        )
      ) {
        structured.querySelector("input")!.checked = true;
        return;
      }
      switchMode(draft, value);
      syncMirrors();
      renderPlaces();
      saver.touch();
      refreshPreview();
    },
  );
  defSection.append(
    toolbar,
    editor.wrapper,
    structured,
    p(
      "Literal mode keeps circled characters and underscores as text. Both modes produce the same rich text schema.",
      "meta",
    ),
  );
  const preview = el("div", {
    class: "sunk",
    style: "margin-top:8px",
    "aria-label": "Rendered definition",
    role: "region",
  });
  defSection.append(preview);
  const refreshPreview = () => {
    const { body, problems } = draftToBody(draft);
    preview.replaceChildren();
    if (body)
      preview.append(
        renderRichText(body.text, {
          language: draft.language,
          placeHref: null,
          className: "small",
        }),
      );
    // Every blocking problem is explained here, before the review step.
    const textProblems = problems.filter(
      (pr) => pr.blocking || pr.field === "text" || pr.field === "numbering",
    );
    for (const problem of textProblems) {
      const note = el(
        "p",
        { class: "notice", style: "margin-top:6px" },
        text(problem.message + " "),
      );
      if (problem.field === "text" && /referenced/.test(problem.message))
        note.append(
          button(
            "Convert references to literal text",
            () => {
              rewriteReferences(draft, () => "literal");
              syncMirrors();
              renderPlaces();
              saver.touch();
              refreshPreview();
            },
            { class: "btn btn-quiet", style: "min-height:32px" },
          ),
        );
      preview.append(note);
    }
  };
  // Pasted text is inert text. In structured mode, circled numerals in it
  // stay literal unless the author chooses to read them as references.
  editor.input.addEventListener("paste", (event) => {
    if (!draft.structured) return;
    const pasted = event.clipboardData?.getData("text/plain") ?? "";
    if (!/[①-⑳]|\{place \d/u.test(pasted)) return;
    event.preventDefault();
    const asReferences = confirm(
      "The pasted text contains circled numbers. OK reads them as place references. Cancel keeps them as literal text.",
    );
    const insert = asReferences ? pasted : literalize(pasted);
    const { selectionStart, selectionEnd, value } = editor.input;
    editor.input.value =
      value.slice(0, selectionStart) + insert + value.slice(selectionEnd);
    const caret = selectionStart + insert.length;
    editor.input.setSelectionRange(caret, caret);
    editor.input.dispatchEvent(new Event("input"));
  });
  mirrors.add(() => {
    editor.input.value = editorText(draft.text, draft.structured);
  });
  editor.input.addEventListener("input", () => {
    draft.text = editorToRichText(editor.input.value, draft.structured);
    draft.numberingApproved = false;
    saver.touch();
    refreshPreview();
    refreshNumbering();
  });
  // Placeholders from the meaning.
  if (!countNodes(draft.text) && draft.meaning.trim()) {
    const proposal = numberPlaceholders(draft.meaning);
    const suggest = el("div", { class: "notice", style: "margin-top:8px" });
    suggest.append(
      text(
        proposal.count
          ? `Your meaning has ${proposal.count} placeholder${proposal.count === 1 ? "" : "s"}. `
          : "Start from your meaning. ",
      ),
      button(
        proposal.count
          ? "Use the meaning with numbered places"
          : "Use the meaning as the definition",
        () => {
          draft.text = editorToRichText(proposal.text, draft.structured);
          editor.input.value = editorText(draft.text, draft.structured);
          if (proposal.count && !draft.places.length) {
            draft.places = Array.from({ length: proposal.count }, (_, i) =>
              newPlace(i + 1),
            );
            if (draft.frameMode === "none") draft.frameMode = "fixed";
          }
          saver.touch();
          refreshPreview();
          renderPlaces();
          suggest.remove();
        },
        { class: "btn", style: "min-height:36px" },
      ),
      text(" You approve the numbering below before publishing."),
    );
    defSection.append(suggest);
  }
  // Glosses. Each gloss keeps its own language and sense.
  const glossRow = glossChips(draft.glosses, "", () => saver.touch());
  defSection.append(glossRow);
  main.append(defSection);
  // Places.
  const placesSection = el("section", {
    "aria-labelledby": "pl-h",
    style: "margin-top:28px",
  });
  const placesHead = el("div", {
    style: "display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px",
  });
  placesHead.append(
    el("h2", {
      id: "pl-h",
      class: "section",
      style: "margin:0",
      text: "Places",
    }),
  );
  const arity = el("select", {
    class: "inline-select",
    "aria-label": "Number of places",
    style: "min-height:40px",
  });
  const arityOptions = (): { value: FrameMode; label: string }[] => [
    { value: "fixed", label: `exactly ${draft.places.length}` },
    {
      value: "variadic",
      label: `${draft.variadicMinimum || draft.places.length} or more`,
    },
    { value: "context", label: "depends on context" },
    { value: "none", label: "unspecified structure" },
  ];
  const refreshArity = () => {
    arity.replaceChildren();
    for (const option of arityOptions())
      arity.append(
        el("option", {
          value: option.value,
          text: option.label,
          selected: option.value === draft.frameMode,
        }),
      );
  };
  arity.addEventListener("change", () => {
    draft.frameMode = arity.value as FrameMode;
    if (draft.frameMode === "variadic") {
      draft.variadicMinimum = draft.variadicMinimum || draft.places.length;
      draft.tail ??= { description: [], kind: "unspecified", hint: null };
    }
    saver.touch();
    renderPlaces();
    refreshPreview();
  });
  placesHead.append(arity);
  const role = el("select", {
    class: "inline-select",
    "aria-label": "Frame role",
    style: "min-height:40px",
  });
  for (const option of [
    { value: "predicate", label: "predicate" },
    { value: "constructed-predicate", label: "constructed predicate" },
  ])
    role.append(
      el("option", {
        value: option.value,
        text: option.label,
        selected: option.value === draft.frameRole,
      }),
    );
  role.addEventListener("change", () => {
    draft.frameRole = role.value as Draft["frameRole"];
    saver.touch();
    refreshPreview();
  });
  placesHead.append(role);
  placesSection.append(
    placesHead,
    p(
      "Unspecified structure publishes no frame. It does not mean zero places.",
      "meta",
    ),
  );
  const list = el("ol", { class: "place-list" });
  const tailBox = el("div");
  const numbering = el("div");
  placesSection.append(list, tailBox, numbering);
  const addPlace = () => {
    if (draft.places.length >= 256) {
      app.announce("A frame declares at most 256 places.");
      return;
    }
    draft.places.push(newPlace(nextPlaceNumber()));
    if (draft.frameMode === "none") draft.frameMode = "fixed";
    draft.numberingApproved = false;
    saver.touch();
    renderPlaces();
    refreshPreview();
  };
  const placeRow = (place: DraftPlace, index: number): HTMLElement => {
    const li = el("li", { class: "place-row" });
    const marker = el("span", {
      style:
        "flex:none;display:flex;flex-direction:column;align-items:center;gap:4px",
    });
    marker.append(placeMarker(place.index, null));
    if (draft.frameMode !== "fixed") {
      const idx = el("input", {
        type: "number",
        class: "field",
        "aria-label": `Place number ${place.index}`,
        min: "1",
        max: "65535",
        style: "width:5rem;min-height:36px;padding:4px 8px",
      });
      idx.value = String(place.index);
      idx.addEventListener("change", () => {
        const previous = place.index;
        place.index = Math.max(
          1,
          Math.min(65535, Number(idx.value) || place.index),
        );
        // References to this place follow its new number.
        if (place.index !== previous) {
          rewriteReferences(draft, (n) => (n === previous ? place.index : n));
          syncMirrors();
        }
        draft.places.sort((a, b) => a.index - b.index);
        draft.numberingApproved = false;
        saver.touch();
        renderPlaces();
        refreshPreview();
      });
      marker.append(idx);
    }
    const grid = el("div", { class: "place-grid" });
    const description = field(`Description for place ${place.index}`, {
      value: editorText(place.description, draft.structured),
      wrapperClass: "span-3",
      labelClass: "field-label",
    });
    description.label.textContent = "Description";
    description.label.append(
      el("span", { class: "sr", text: ` for place ${place.index}` }),
    );
    description.input.addEventListener("input", () => {
      place.description = editorToRichText(
        description.input.value,
        draft.structured,
      );
      saver.touch();
    });
    const gloss = {
      wrapper: el(
        "div",
        { class: "span-3" },
        glossChips(place.glosses, ` for place ${place.index}`, () => {
          saver.touch();
          refreshPreview();
        }),
      ),
    };
    const kind = field(`Kind of thing for place ${place.index}`, {
      options: kindChoices,
      value: place.kind,
      wrapperClass: "",
    });
    kind.label.textContent = "Kind of thing";
    kind.label.append(
      el("span", { class: "sr", text: ` for place ${place.index}` }),
    );
    const customSlot = el("div", { class: "span-3" });
    const renderCustom = () => {
      customSlot.replaceChildren();
      if (place.kind === "custom")
        customSlot.append(
          hintEditor(place.hint ?? hintForChoice("object"), (hint) => {
            place.hint = hint;
            saver.touch();
          }),
        );
    };
    kind.input.addEventListener("change", () => {
      place.kind = kind.input.value as KindChoice;
      if (place.kind !== "custom") place.hint = null;
      saver.touch();
      renderCustom();
    });
    const from = {
      wrapper: el(
        "div",
        { class: "span-3" },
        derivationEditor(place, draft.structured, () => {
          saver.touch();
          refreshPreview();
        }),
      ),
    };
    grid.append(
      description.wrapper,
      gloss.wrapper,
      kind.wrapper,
      from.wrapper,
      customSlot,
    );
    renderCustom();
    const tools = el("div", {
      style: "display:flex;flex-direction:column;gap:2px;flex:none",
    });
    tools.append(
      button(
        "↑",
        () => {
          if (index === 0) return;
          [draft.places[index - 1], draft.places[index]] = [
            draft.places[index],
            draft.places[index - 1],
          ];
          if (draft.frameMode === "fixed") {
            // Each reference follows its place to the place's new number.
            const moved = new Map<number, number>();
            draft.places.forEach((pl, i) => moved.set(pl.index, i + 1));
            draft.places = renumber(draft.places);
            rewriteReferences(draft, (n) => moved.get(n) ?? n);
            syncMirrors();
          }
          draft.numberingApproved = false;
          saver.touch();
          renderPlaces();
          refreshPreview();
        },
        {
          class: "btn btn-quiet btn-icon",
          "aria-label": `Move place ${place.index} up`,
          disabled: index === 0 ? "true" : undefined,
          style: "text-decoration:none",
        },
      ),
      button(
        "↓",
        () => {
          if (index === draft.places.length - 1) return;
          [draft.places[index + 1], draft.places[index]] = [
            draft.places[index],
            draft.places[index + 1],
          ];
          if (draft.frameMode === "fixed") {
            // Each reference follows its place to the place's new number.
            const moved = new Map<number, number>();
            draft.places.forEach((pl, i) => moved.set(pl.index, i + 1));
            draft.places = renumber(draft.places);
            rewriteReferences(draft, (n) => moved.get(n) ?? n);
            syncMirrors();
          }
          draft.numberingApproved = false;
          saver.touch();
          renderPlaces();
          refreshPreview();
        },
        {
          class: "btn btn-quiet btn-icon",
          "aria-label": `Move place ${place.index} down`,
          disabled: index === draft.places.length - 1 ? "true" : undefined,
          style: "text-decoration:none",
        },
      ),
      button(
        "×",
        () => {
          const removed = place.index;
          const mentions = fieldsReferencing(draft, removed);
          if (
            mentions.length &&
            !confirm(
              `Place ${removed} is referenced in ${mentions.join(", ")}. Remove it anyway? Each reference to it becomes literal text, and references to higher places keep their meaning.`,
            )
          )
            return;
          draft.places.splice(index, 1);
          if (draft.frameMode === "fixed") {
            // Every reference keeps its referent: the removed place becomes
            // literal text, and higher places move down with their references.
            rewriteReferences(draft, (n) =>
              n === removed ? "literal" : n > removed ? n - 1 : n,
            );
            draft.places = renumber(draft.places);
          } else
            rewriteReferences(draft, (n) => (n === removed ? "literal" : n));
          syncMirrors();
          draft.numberingApproved = false;
          saver.touch();
          renderPlaces();
          refreshPreview();
        },
        {
          class: "btn btn-quiet btn-icon",
          "aria-label": `Remove place ${place.index}`,
          style: "text-decoration:none",
        },
      ),
    );
    li.append(marker, grid, tools);
    return li;
  };
  const refreshNumbering = () => {
    numbering.replaceChildren();
    const { problems } = draftToBody(draft);
    const needs = problems.some((pr) => pr.field === "numbering");
    if (!needs) {
      if (draft.numberingApproved && draft.places.length)
        numbering.append(p("Place numbering approved.", "meta"));
      return;
    }
    numbering.append(
      el(
        "div",
        { class: "notice", style: "margin-top:10px" },
        text(
          "The definition references numbered places. Check that each number names the right place, then approve the numbering. Textual order never changes place order. ",
        ),
        button(
          "Approve the numbering",
          () => {
            draft.numberingApproved = true;
            saver.touch();
            refreshNumbering();
            refreshPreview();
          },
          { class: "btn", style: "min-height:36px" },
        ),
      ),
    );
  };
  const rebuildHooks: (() => void)[] = [];
  const renderPlaces = () => {
    refreshArity();
    for (const hook of rebuildHooks) hook();
    list.replaceChildren();
    if (draft.frameMode === "none") {
      tailBox.replaceChildren();
      list.append(
        el("li", {
          class: "meta",
          style: "padding:8px 0",
          text: draft.places.length
            ? "Declared places stay in the draft but are not published while the structure is unspecified."
            : "No places declared.",
        }),
      );
    } else
      draft.places.forEach((place, index) =>
        list.append(placeRow(place, index)),
      );
    tailBox.replaceChildren();
    if (draft.frameMode === "variadic") {
      const minimum = field("Minimum number of places", {
        type: "number",
        value: String(draft.variadicMinimum),
        wrapperClass: "",
      });
      minimum.input.min = "0";
      minimum.input.addEventListener("input", () => {
        draft.variadicMinimum = Math.min(
          256,
          Math.max(0, Number(minimum.input.value) || 0),
        );
        saver.touch();
        refreshArity();
      });
      const tailDescription = field(
        `Places ${draft.places.length + 1} and on`,
        {
          value: editorText(draft.tail?.description ?? [], draft.structured),
          placeholder: "what the repeated places are",
          wrapperClass: "",
        },
      );
      tailDescription.input.addEventListener("input", () => {
        draft.tail = {
          description: editorToRichText(
            tailDescription.input.value,
            draft.structured,
          ),
          kind: draft.tail?.kind ?? "unspecified",
          hint: draft.tail?.hint ?? null,
        };
        saver.touch();
      });
      const tailKind = field("Kind of thing for the repeated places", {
        options: kindChoices.filter((c) => c.value !== "custom"),
        value: draft.tail?.kind ?? "unspecified",
        wrapperClass: "",
      });
      tailKind.input.addEventListener("change", () => {
        draft.tail = {
          description: draft.tail?.description ?? [],
          kind: tailKind.input.value as KindChoice,
          hint: null,
        };
        saver.touch();
      });
      const row = el("div", {
        style: "display:flex;flex-wrap:wrap;gap:12px 16px;margin-top:8px",
      });
      for (const f of [minimum, tailDescription, tailKind]) {
        f.wrapper.style.flex = "1 1 160px";
        row.append(f.wrapper);
      }
      tailBox.append(row);
    }
    refreshNumbering();
  };
  renderPlaces();
  refreshPreview();
  const placeActions = el("div", {
    style:
      "border-top:1px solid var(--line);display:flex;flex-wrap:wrap;gap:0 4px;align-items:center;margin-top:8px",
  });
  placeActions.append(
    button("+ Add a place", addPlace, {
      class: "btn btn-quiet",
      style: "margin-left:-10px",
    }),
  );
  placesSection.append(placeActions);
  main.append(placesSection);
  // Named disclosures.
  const sections = el("div", {
    style:
      "margin-top:16px;display:flex;flex-wrap:wrap;gap:0 4px;flex-direction:column",
  });
  const open = (
    title: string,
    body: () => Node | Node[],
    summaryExtra?: string,
  ) => {
    const details = disclosure(
      summaryExtra
        ? el("span", {}, text(title + " "), text(summaryExtra, "meta"))
        : title,
      body,
    );
    if (full) details.open = true;
    sections.append(details);
    return details;
  };
  // Defaults and constraints.
  const defaultsDetails = open("Defaults and constraints", () => {
    const box = el("div", { class: "stack" });
    if (!draft.places.length) box.append(p("Declare places first.", "meta"));
    for (const place of draft.places) {
      const block = el("div", { class: "sunk" });
      block.append(
        el(
          "p",
          { class: "small", style: "font-weight:640" },
          placeMarker(place.index, null),
          text(` place ${place.index}`),
        ),
      );
      const renderDefaults = () => {
        const holder =
          block.querySelector(".defaults") ?? el("div", { class: "defaults" });
        holder.replaceChildren();
        place.defaults.forEach((d: DraftDefault, i: number) => {
          const row = el("div", {
            style:
              "display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-top:6px",
          });
          const kind = field(`Default kind ${i + 1} for place ${place.index}`, {
            options: [
              { value: "conventional", label: "conventional" },
              { value: "suggested", label: "suggested" },
            ],
            value: d.kind,
            wrapperClass: "",
          });
          kind.input.addEventListener("change", () => {
            d.kind = kind.input.value as DraftDefault["kind"];
            saver.touch();
          });
          const format = field(
            `Default format ${i + 1} for place ${place.index}`,
            {
              options: [
                { value: "lojban", label: "Lojban" },
                { value: "prose", label: "prose" },
              ],
              value: d.format,
              wrapperClass: "",
            },
          );
          format.input.addEventListener("change", () => {
            d.format = format.input.value as DraftDefault["format"];
            saver.touch();
          });
          const value = field(
            `Default value ${i + 1} for place ${place.index}`,
            { value: d.text, wrapperClass: "", placeholder: "li pa" },
          );
          value.input.addEventListener("input", () => {
            d.text = value.input.value;
            saver.touch();
          });
          const condition = field(
            `Condition ${i + 1} for place ${place.index}`,
            {
              value: editorText(d.condition, draft.structured),
              wrapperClass: "",
              placeholder: "when…",
            },
          );
          condition.input.addEventListener("input", () => {
            d.condition = editorToRichText(
              condition.input.value,
              draft.structured,
            );
            saver.touch();
          });
          for (const f of [kind, format, value, condition]) {
            f.wrapper.style.flex = "1 1 140px";
            row.append(f.wrapper);
          }
          row.append(
            button(
              "Remove",
              () => {
                place.defaults.splice(i, 1);
                saver.touch();
                renderDefaults();
              },
              { class: "btn btn-quiet" },
            ),
          );
          holder.append(row);
        });
        block.append(holder);
      };
      renderDefaults();
      const constraints = field(`Constraints for place ${place.index}`, {
        multiline: true,
        rows: 2,
        value: place.constraints
          .map((c) => editorText(c, draft.structured))
          .join("\n"),
        wrapperClass: "",
        hint: "One per line. Descriptions, not executable rules.",
      });
      constraints.input.addEventListener("input", () => {
        place.constraints = constraints.input.value
          .split("\n")
          .filter((c) => c.trim())
          .map((c) => editorToRichText(c, draft.structured));
        saver.touch();
      });
      block.append(
        el(
          "div",
          { class: "actions", style: "margin-top:6px" },
          button(
            `Add a default for place ${place.index}`,
            () => {
              place.defaults.push({
                kind: "conventional",
                format: "lojban",
                language: draft.language,
                text: "",
                condition: [],
                explanation: [],
              });
              saver.touch();
              renderDefaults();
            },
            { class: "btn btn-quiet" },
          ),
        ),
        constraints.wrapper,
      );
      box.append(block);
    }
    const frameConstraints = field("Constraints between places", {
      multiline: true,
      rows: 2,
      value: draft.frameConstraints
        .map((c) => editorText(c, draft.structured))
        .join("\n"),
      wrapperClass: "",
      hint: "One per line.",
    });
    mirrors.add(() => {
      frameConstraints.input.value = draft.frameConstraints
        .map((c) => editorText(c, draft.structured))
        .join("\n");
    });
    frameConstraints.input.addEventListener("input", () => {
      draft.frameConstraints = frameConstraints.input.value
        .split("\n")
        .filter((c) => c.trim())
        .map((c) => editorToRichText(c, draft.structured));
      saver.touch();
    });
    box.append(
      frameConstraints.wrapper,
      p(
        "A missing default does not mean zo'e or an empty value. Version 1 does not execute conditions.",
        "meta",
      ),
    );
    return box;
  });
  const rebuildDefaults = () => {
    if (!defaultsDetails.open) return;
    const body = defaultsDetails.querySelector(":scope > .body");
    if (!body) return;
    body.replaceChildren();
    defaultsDetails.open = false;
    defaultsDetails.open = true;
    defaultsDetails.dispatchEvent(new Event("toggle"));
  };
  rebuildHooks.push(rebuildDefaults);
  open("Notes", () => {
    const notes = field("Notes", {
      multiline: true,
      rows: 3,
      value: editorText(draft.notes, draft.structured),
      labelClass: "sr",
      wrapperClass: "",
    });
    mirrors.add(() => {
      notes.input.value = editorText(draft.notes, draft.structured);
    });
    notes.input.addEventListener("input", () => {
      draft.notes = editorToRichText(notes.input.value, draft.structured);
      saver.touch();
      refreshPreview();
    });
    return [
      notes.wrapper,
      p(
        "Notes can reference places with circled numbers in structured mode.",
        "meta",
      ),
    ];
  });
  open("Examples", () => {
    const box = el("div", { class: "stack" });
    const render = () => {
      box.replaceChildren();
      draft.examples.forEach((example: DraftExample, i: number) => {
        const row = el("div", {
          class: "sunk",
          style: "display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end",
        });
        const textField = field(`Example ${i + 1}`, {
          value: example.text,
          wrapperClass: "",
          lang: "jbo",
          spellcheck: false,
        });
        textField.input.addEventListener("input", () => {
          example.text = textField.input.value;
          saver.touch();
        });
        const translation = field(`Translation of example ${i + 1}`, {
          value: editorText(example.translation, draft.structured),
          wrapperClass: "",
        });
        translation.input.addEventListener("input", () => {
          example.translation = editorToRichText(
            translation.input.value,
            draft.structured,
          );
          saver.touch();
        });
        const notesField = field(`Notes for example ${i + 1}`, {
          value: editorText(example.notes, draft.structured),
          wrapperClass: "",
        });
        notesField.input.addEventListener("input", () => {
          example.notes = editorToRichText(
            notesField.input.value,
            draft.structured,
          );
          saver.touch();
        });
        for (const f of [textField, translation, notesField]) {
          f.wrapper.style.flex = "1 1 180px";
          row.append(f.wrapper);
        }
        row.append(
          button(
            `Remove example ${i + 1}`,
            () => {
              draft.examples.splice(i, 1);
              saver.touch();
              render();
            },
            { class: "btn btn-quiet" },
          ),
        );
        box.append(row);
      });
      box.append(
        el(
          "div",
          { class: "actions" },
          button(
            "Add an example",
            () => {
              draft.examples.push({
                language: "jbo",
                text: "",
                translation: [],
                notes: [],
              });
              saver.touch();
              render();
            },
            { class: "btn btn-quiet" },
          ),
        ),
      );
    };
    render();
    return box;
  });
  open(
    "Etymology",
    () => {
      const etym = field("Etymology", {
        multiline: true,
        rows: 3,
        value: editorText(draft.etymologyText, draft.structured),
        labelClass: "sr",
        wrapperClass: "",
        hint: "Descriptive text without place references. Morphology notes from the Form step are added after it.",
      });
      etym.input.addEventListener("input", () => {
        draft.etymologyText = editorToRichText(
          etym.input.value,
          draft.structured,
        );
        saver.touch();
      });
      const nodes: Node[] = [etym.wrapper];
      if (draft.compound)
        nodes.push(
          p(
            `Compound evidence: ${draft.compound.components.map((c) => `${c.word.spelling} (${c.rafsi})`).join(" + ")}${draft.compound.score !== null ? ` · score ${draft.compound.score}` : ""}. Read-only.`,
            "small",
          ),
        );
      if (draft.formation)
        nodes.push(
          p(
            `Formation evidence: ${draft.formation.method}${draft.formation.generated ? `, generated ${draft.formation.generated}` : ""}. Read-only.`,
            "small",
          ),
        );
      if (!draft.compound && !draft.formation)
        nodes.push(
          p(
            "No structured formation evidence. The builders add it in a later stage. A manual word carries none.",
            "meta",
          ),
        );
      return nodes;
    },
    draft.compound
      ? `${draft.compound.components.map((c) => c.word.spelling).join(" + ")}, filled in`
      : undefined,
  );
  open("Sources", () => {
    const box = el("div", { class: "stack" });
    const render = () => {
      box.replaceChildren();
      draft.sources.forEach((source, i) => {
        const row = el("div", {
          class: "sunk",
          style: "display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end",
        });
        const label = field(`Source ${i + 1} label`, {
          value: source.label,
          wrapperClass: "",
        });
        label.input.addEventListener("input", () => {
          source.label = label.input.value.trim();
          saver.touch();
        });
        const url = field(`Source ${i + 1} link`, {
          value: source.url ?? "",
          wrapperClass: "",
          placeholder: "https://",
        });
        url.input.addEventListener("input", () => {
          source.url = url.input.value.trim() || null;
          saver.touch();
        });
        const event = field(`Source ${i + 1} record`, {
          value: source.event ?? "",
          wrapperClass: "",
          placeholder: "jve1:…",
        });
        event.input.addEventListener("input", () => {
          source.event = event.input.value.trim() || null;
          saver.touch();
        });
        const locator = field(`Source ${i + 1} position`, {
          value: source.locator ?? "",
          wrapperClass: "",
        });
        locator.input.addEventListener("input", () => {
          source.locator = locator.input.value.trim() || null;
          saver.touch();
        });
        for (const f of [label, url, event, locator]) {
          f.wrapper.style.flex = "1 1 150px";
          row.append(f.wrapper);
        }
        const fixed =
          draft.revisedImport &&
          (source.event === draft.revisedImport.event ||
            source.locator === "footer.publicDomainNotice");
        if (fixed)
          row.append(text("Required for a revision of imported text", "meta"));
        else
          row.append(
            button(
              `Remove source ${i + 1}`,
              () => {
                draft.sources.splice(i, 1);
                saver.touch();
                render();
              },
              { class: "btn btn-quiet" },
            ),
          );
        box.append(row);
      });
      box.append(
        el(
          "div",
          { class: "actions" },
          button(
            "Add a source",
            () => {
              draft.sources.push({
                label: "",
                url: null,
                event: null,
                locator: null,
              });
              saver.touch();
              render();
            },
            { class: "btn btn-quiet" },
          ),
        ),
      );
    };
    render();
    return box;
  });
  if (full) {
    open("Grammatical operands", () => {
      const box = el("div", { class: "stack" });
      const render = () => {
        box.replaceChildren(
          p(
            "Operands belong to a grammatical construction. They are not the numbered places of a relation.",
            "meta",
          ),
        );
        draft.operands.forEach((operand, i) => {
          const row = el("div", {
            class: "sunk",
            style: "display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end",
          });
          const id = field(`Operand ${i + 1} ID`, {
            value: operand.id,
            wrapperClass: "",
            placeholder: "bridi",
          });
          id.input.addEventListener("input", () => {
            operand.id = id.input.value;
            saver.touch();
          });
          const category = field(`Operand ${i + 1} category`, {
            value: operand.category,
            wrapperClass: "",
            placeholder: "bridi, selbri, sumti, number",
          });
          category.input.addEventListener("input", () => {
            operand.category = category.input.value;
            saver.touch();
          });
          const description = field(`Operand ${i + 1} description`, {
            value: editorText(operand.description, draft.structured),
            wrapperClass: "",
          });
          mirrors.add(() => {
            description.input.value = editorText(
              operand.description,
              draft.structured,
            );
          });
          description.input.addEventListener("input", () => {
            operand.description = editorToRichText(
              description.input.value,
              draft.structured,
            );
            saver.touch();
          });
          const minimum = field(`Operand ${i + 1} minimum`, {
            type: "number",
            value: String(operand.minimum),
            wrapperClass: "",
          });
          minimum.input.addEventListener("input", () => {
            operand.minimum = Math.max(0, Number(minimum.input.value) || 0);
            saver.touch();
          });
          const maximum = field(`Operand ${i + 1} maximum`, {
            value: operand.maximum === null ? "" : String(operand.maximum),
            wrapperClass: "",
            placeholder: "empty for no limit",
          });
          maximum.input.addEventListener("input", () => {
            operand.maximum =
              maximum.input.value.trim() === ""
                ? null
                : Math.max(0, Number(maximum.input.value) || 0);
            saver.touch();
          });
          for (const f of [id, category, description, minimum, maximum]) {
            f.wrapper.style.flex = "1 1 120px";
            row.append(f.wrapper);
          }
          row.append(
            button(
              `Remove operand ${i + 1}`,
              () => {
                draft.operands.splice(i, 1);
                saver.touch();
                render();
              },
              { class: "btn btn-quiet" },
            ),
          );
          box.append(row);
        });
        box.append(
          el(
            "div",
            { class: "actions" },
            button(
              "Add an operand",
              () => {
                draft.operands.push({
                  id: "",
                  category: "",
                  description: [],
                  minimum: 1,
                  maximum: 1,
                });
                saver.touch();
                render();
              },
              { class: "btn btn-quiet" },
            ),
          ),
        );
      };
      render();
      return box;
    });
    open("Labels", () => {
      const labels = field("Labels", {
        value: draft.labels.join(", "),
        labelClass: "sr",
        wrapperClass: "",
        hint: "Comma-separated. Labels have no ranking effect. Experimental or obsolete status belongs here.",
      });
      labels.input.addEventListener("input", () => {
        draft.labels = labels.input.value
          .split(",")
          .map((l) => l.trim())
          .filter(Boolean);
        saver.touch();
      });
      return labels.wrapper;
    });
    open("Rafsi claims", () => {
      const box = el("div", { class: "stack" });
      const render = () => {
        box.replaceChildren(
          p(
            "Each claim is a separate signed record with its own author blessing of the word and rafsi pair. Conflicts with other words are shown on the Publish step when the server reports them.",
            "meta",
          ),
        );
        draft.rafsiClaims.forEach((claim, i) => {
          const row = el("div", {
            class: "sunk",
            style: "display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end",
          });
          const rafsi = field(`Rafsi ${i + 1}`, {
            value: claim.rafsi,
            wrapperClass: "",
            lang: "jbo",
            spellcheck: false,
          });
          rafsi.input.addEventListener("input", () => {
            claim.rafsi = rafsi.input.value;
            saver.touch();
          });
          const rationale = field(`Rationale for rafsi ${i + 1}`, {
            value: claim.rationale,
            wrapperClass: "",
          });
          rationale.input.addEventListener("input", () => {
            claim.rationale = rationale.input.value;
            saver.touch();
          });
          rafsi.wrapper.style.flex = "1 1 120px";
          rationale.wrapper.style.flex = "3 1 220px";
          row.append(
            rafsi.wrapper,
            rationale.wrapper,
            button(
              `Remove rafsi ${i + 1}`,
              () => {
                draft.rafsiClaims.splice(i, 1);
                saver.touch();
                render();
              },
              { class: "btn btn-quiet" },
            ),
          );
          box.append(row);
        });
        box.append(
          el(
            "div",
            { class: "actions" },
            button(
              "Add a rafsi claim",
              () => {
                draft.rafsiClaims.push({ rafsi: "", rationale: "" });
                saver.touch();
                render();
              },
              { class: "btn btn-quiet" },
            ),
          ),
        );
      };
      render();
      return box;
    });
    open("Fixed fields", () => [
      p(
        "License: CC0-1.0, https://creativecommons.org/publicdomain/zero/1.0/, attribution empty. The signed issuer identifies the contributor.",
        "small",
      ),
      p(
        "Origin: native. Legacy: null. The editor cannot fabricate import origin or another author's source evidence.",
        "small",
      ),
      p(
        `Word ID and event ID are derived at signing. Frame: ${draft.frameMode === "none" ? "null" : describeArity(draft.frameMode === "fixed" ? { mode: "fixed", count: draft.places.length } : draft.frameMode === "variadic" ? { mode: "variadic", minimum: draft.variadicMinimum } : { mode: "context" })}.`,
        "small",
      ),
    ]);
    open("JSON inspector", () => {
      const { body } = draftToBody(draft);
      return el("pre", { class: "json", text: JSON.stringify(body, null, 2) });
    });
  }
  main.append(sections);
  for (const details of sections.querySelectorAll<HTMLDetailsElement>(
    "details[open]",
  ))
    details.dispatchEvent(new Event("toggle"));
  main.append(
    actionBar(saver, {
      back: {
        label: "Back",
        href: full
          ? draft.parents.length
            ? routes.definition(draft.parents[0])
            : "/new/form"
          : "/new/form",
      },
      primary: {
        label: "Review",
        action: async () => {
          draft.step = 5;
          if (!(await saver.flush())) return;
          navigate("/new/publish");
        },
      },
      extra: full
        ? []
        : [link("Full editor", "/new/editor", { class: "btn btn-quiet" })],
    }),
  );
}

/** A chip list of glosses. Each gloss keeps its language and sense. */
function glossChips(
  glosses: DraftGloss[],
  suffix: string,
  changed: () => void,
): HTMLElement {
  const row = el("div", {
    style:
      "margin-top:10px;display:flex;flex-wrap:wrap;align-items:center;gap:8px",
  });
  const render = () => {
    row.replaceChildren(text("Glosses", "meta"));
    glosses.forEach((gloss, index) => {
      const chip = el("span", { class: "gloss-chip" });
      chip.append(
        el("bdi", {
          text: gloss.sense ? `${gloss.text} (${gloss.sense})` : gloss.text,
          lang: gloss.language,
        }),
      );
      if (gloss.language) chip.append(text(` ${gloss.language}`, "meta"));
      chip.append(
        button(
          "×",
          () => {
            glosses.splice(index, 1);
            changed();
            render();
          },
          {
            class: "btn btn-quiet btn-icon",
            "aria-label": `Remove gloss ${gloss.text}${suffix}`,
            style: "min-height:44px;width:44px;padding:0;text-decoration:none",
          },
        ),
      );
      row.append(chip);
    });
    const add = el("input", {
      class: "field",
      "aria-label": `Add a gloss${suffix}`,
      placeholder: "add a gloss, Enter to add",
      style: "width:14rem;min-height:44px",
    });
    add.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const value = add.value.trim();
      if (!value) return;
      const languageMatch = value.match(
        /^([a-z]{2,8}(?:-[a-z0-9]{1,8})*):\s*(.+)$/u,
      );
      const language = languageMatch ? languageMatch[1] : "";
      const rest = languageMatch ? languageMatch[2] : value;
      const [textPart, sense] = rest.split(/\s*\(([^)]*)\)\s*$/);
      glosses.push({
        language,
        text: textPart.trim(),
        sense: sense?.trim() ?? "",
      });
      changed();
      render();
      row.querySelector<HTMLInputElement>("input")?.focus();
    });
    row.append(
      add,
      text(
        "A sense in parentheses, such as great (in a property), is optional. A language prefix, such as fr: grand, sets the gloss language. Without one the definition language applies.",
        "meta",
      ),
    );
  };
  render();
  return row;
}
/** The derivations of one place: source word, source place, exact definition, and explanation. */
function derivationEditor(
  place: DraftPlace,
  structured: boolean,
  changed: () => void,
): HTMLElement {
  const box = el("div");
  const render = () => {
    box.replaceChildren(text(`Derivations of place ${place.index}`, "meta"));
    place.derivations.forEach((derivation, index) => {
      const n = index + 1;
      const row = el("div", {
        class: "place-grid",
        style: "margin-top:6px",
      });
      const word = field(
        `Source word of derivation ${n} for place ${place.index}`,
        {
          value: derivation.word,
          placeholder: "sinxa",
          wrapperClass: "",
          spellcheck: false,
          lang: "jbo",
        },
      );
      word.label.textContent = "Source word";
      word.label.append(
        el("span", {
          class: "sr",
          text: ` of derivation ${n} for place ${place.index}`,
        }),
      );
      word.input.addEventListener("input", () => {
        derivation.word = word.input.value;
        changed();
      });
      const number = field(
        `Source place of derivation ${n} for place ${place.index}`,
        {
          value: derivation.place === null ? "" : String(derivation.place),
          type: "number",
          placeholder: "1",
          wrapperClass: "",
          hint: "Required. A word alone does not name a place.",
        },
      );
      number.label.textContent = "Source place";
      number.label.append(
        el("span", {
          class: "sr",
          text: ` of derivation ${n} for place ${place.index}`,
        }),
      );
      number.input.min = "1";
      number.input.max = "65535";
      number.input.addEventListener("input", () => {
        const value = number.input.value.trim();
        derivation.place = /^\d{1,5}$/.test(value) ? Number(value) : null;
        changed();
      });
      const definition = field(
        `Source definition of derivation ${n} for place ${place.index}`,
        {
          value: derivation.definition ?? "",
          placeholder: "jve1:… (optional)",
          wrapperClass: "",
          spellcheck: false,
        },
      );
      definition.label.textContent = "Exact definition";
      definition.label.append(
        el("span", {
          class: "sr",
          text: ` of derivation ${n} for place ${place.index}`,
        }),
      );
      definition.input.addEventListener("input", () => {
        derivation.definition = definition.input.value.trim() || null;
        changed();
      });
      const explanation = field(
        `Explanation of derivation ${n} for place ${place.index}`,
        {
          value: editorText(derivation.explanation, structured),
          wrapperClass: "span-3",
          placeholder: "optional, without place references",
        },
      );
      explanation.label.textContent = "Explanation";
      explanation.label.append(
        el("span", {
          class: "sr",
          text: ` of derivation ${n} for place ${place.index}`,
        }),
      );
      explanation.input.addEventListener("input", () => {
        derivation.explanation = editorToRichText(
          explanation.input.value,
          structured,
        );
        changed();
      });
      row.append(
        word.wrapper,
        number.wrapper,
        definition.wrapper,
        explanation.wrapper,
        button(
          "Remove",
          () => {
            place.derivations.splice(index, 1);
            changed();
            render();
          },
          {
            class: "btn btn-quiet",
            "aria-label": `Remove derivation ${n} for place ${place.index}`,
            style: "min-height:36px",
          },
        ),
      );
      box.append(row);
    });
    box.append(
      button(
        "Add a derivation",
        () => {
          place.derivations.push({
            word: "",
            definition: null,
            place: null,
            explanation: [],
          });
          changed();
          render();
          box.querySelector<HTMLInputElement>("input:last-of-type")?.focus();
        },
        {
          class: "btn btn-quiet",
          "aria-label": `Add a derivation for place ${place.index}`,
          style: "margin-top:6px;min-height:36px",
        },
      ),
    );
  };
  render();
  return box;
}
