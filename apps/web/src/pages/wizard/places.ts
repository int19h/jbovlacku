import { richValue } from "../../model/rich-editor.ts";
import { richField } from "../../components/rich-field.ts";
import { wordFormStatus } from "../../components/word-form-feedback.ts";
import { isZeiCompound } from "../../model/builders.ts";
import { kindLabel } from "../../model/types.ts";
import { changeTypedWord } from "../../model/typed-headword.ts";
import { placeCountNote } from "../../components/place-count-note.ts";
import { hintLabel, mappingKind } from "../../model/assistance.ts";
import {
  assistanceAction,
  inferenceLog,
  assistanceVisibility,
} from "../../components/assistance.ts";
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
  retiredTagMeaning,
  replaceRetiredHintTag,
  editorText,
  editorToRichText,
  fieldsReferencing,
  literalLoss,
  literalize,
  newPlace,
  rewriteReferences,
  remapRich,
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
  formPath,
  removeFormationEvidence,
  DraftSaver,
  loadDraft,
  startDraft,
  stepBar,
  DRAFT_KEY,
} from "./common.ts";
import { describeArity } from "../../components/definition.ts";

type NumberingPart = ReturnType<typeof numberPlaceholders>["parts"][number] & {
  rich?: RichText;
};
function numberingParts(parts: NumberingPart[]): HTMLElement {
  const breakdown = el("ol", { "aria-label": "Places used in each part" });
  for (const [index, part] of parts.entries()) {
    breakdown.append(
      el(
        "li",
        { style: "margin:8px 0;overflow-wrap:anywhere" },
        p(
          `Part ${index + 1}: ${part.places.length ? `places ${part.places.join(", ")}` : "no places"}`,
          "meta",
        ),
        renderRichText(part.rich ?? editorToRichText(part.text, true), {
          placeHref: null,
        }),
      ),
    );
  }
  return breakdown;
}

/** Splits edited prose without treating literal glyphs as place references. */
function definitionParts(value: RichText): NumberingPart[] {
  const parts: { rich: RichText; places: Set<number> }[] = [
    { rich: [[]], places: new Set() },
  ];
  for (const [index, paragraph] of value.entries()) {
    if (index) parts.at(-1)!.rich.push([]);
    for (const node of paragraph) {
      if (typeof node === "string") {
        for (const [index, fragment] of node.split(";").entries()) {
          if (index) parts.push({ rich: [[]], places: new Set() });
          if (fragment) parts.at(-1)!.rich.at(-1)!.push(fragment);
        }
      } else {
        const part = parts.at(-1)!;
        part.rich.at(-1)!.push(node);
        if (typeof node === "number") part.places.add(node);
      }
    }
  }
  return parts.map((part) => ({
    text: "",
    rich: part.rich,
    places: [...part.places].sort((a, b) => a - b),
  }));
}

const standardTags = [
  "referent",
  "agent",
  "event",
  "state",
  "process",
  "relation",
  "proposition",
  "number",
  "text",
  "set",
  "sequence",
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
/** The complete type hint editor, for custom kinds. */
function hintEditor(
  current: TypeHint | null,
  structured: boolean,
  onChange: (hint: TypeHint | null) => void,
  draft: Draft,
): HTMLElement {
  const box = el("div", { class: "sunk", style: "margin-top:8px" });
  const alternatives = current?.alternatives.map((a) => ({
    ...a,
    tags: [...a.tags],
  })) ?? [{ tags: [], abstractor: null, relation_arity: null }];
  // The note keeps its exact rich value through direct node edits.
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
  const retiredNotices = el("div");
  const renderRetiredNotices = () => {
    retiredNotices.replaceChildren();
    for (const tag of new Set(
      alternatives.flatMap((alternative) => alternative.tags),
    )) {
      const meaning = retiredTagMeaning(tag);
      if (!meaning) continue;
      const retired = el("div", { class: "notice" }, p(meaning));
      if (tag === "entity" || tag === "tuple") {
        const replacement = tag === "entity" ? "referent" : "sequence";
        retired.append(
          button(
            `Replace ${tag} with ${replacement}`,
            () => {
              const updated = replaceRetiredHintTag(
                { alternatives, note },
                tag,
              );
              alternatives.splice(
                0,
                alternatives.length,
                ...updated.alternatives,
              );
              note = updated.note;
              emit();
              render();
              box.querySelector<HTMLInputElement>("input")?.focus();
            },
            { class: "btn btn-quiet" },
          ),
        );
      }
      retiredNotices.append(retired);
    }
  };
  const render = () => {
    box.replaceChildren(
      p(
        "Kind of thing in full. Each alternative applies its fields together. Custom tags use an HTTPS URI.",
        "meta",
      ),
      retiredNotices,
    );
    renderRetiredNotices();
    alternatives.forEach((alt, index) => {
      const row = el("div", {
        style:
          "display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;margin-top:8px",
      });
      const tags = field(`Tags for alternative ${index + 1}`, {
        value: alt.tags.join(", "),
        placeholder: standardTags.slice(0, 4).join(", ") + "…",
        wrapperClass: "",
      });
      const tagsHint = p(`Standard: ${standardTags.join(", ")}`, "hint");
      tagsHint.id = `${tags.input.id}-hint`;
      tags.input.setAttribute("aria-describedby", tagsHint.id);
      tags.wrapper.append(tagsHint);
      tags.input.addEventListener("input", () => {
        alt.tags = tags.input.value
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        emit();
        renderRetiredNotices();
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
      count.input.step = "1";
      const syncArity = () => {
        const n = Math.max(
          0,
          Math.min(65535, Math.trunc(Number(count.input.value) || 0)),
        );
        alt.relation_arity =
          arityMode.input.value === "fixed"
            ? { mode: "fixed", count: n }
            : arityMode.input.value === "variadic"
              ? { mode: "variadic", minimum: n }
              : arityMode.input.value === "context"
                ? { mode: "context" }
                : null;
        emit();
        return n;
      };
      arityMode.input.addEventListener("change", () => {
        count.input.value = String(syncArity());
      });
      count.input.addEventListener("input", syncArity);
      count.input.addEventListener("change", () => {
        count.input.value = String(syncArity());
      });
      tags.wrapper.style.flex = "2 1 220px";
      row.append(
        tags.wrapper,
        abstractor.wrapper,
        arityMode.wrapper,
        count.wrapper,
      );
      if (alternatives.length > 1)
        row.append(
          el(
            "div",
            {},
            el("span", {
              class: "field-label alternative-remove-spacer",
              "aria-hidden": "true",
            }),
            button(
              `Remove alternative ${index + 1}`,
              () => {
                alternatives.splice(index, 1);
                emit();
                render();
              },
              { class: "btn btn-quiet" },
            ),
          ),
        );
      box.append(
        el(
          "fieldset",
          { class: "hint-alternative" },
          el("legend", { text: `Alternative ${index + 1}` }),
          row,
        ),
      );
    });
    // The note follows the selected mode like every other rich field.
    // Each paragraph stays a separate node.
    const noteField = richField("Type note", {
      multiline: true,
      structured,
      places: () =>
        draft.frameMode === "none"
          ? []
          : draft.places.map((place) => place.index),
      operands: () => draft.operands.map((operand) => operand.id),
      rows: 2,
      value: note,
      wrapperClass: "",
      placeholder: "optional",
    });
    noteField.input.addEventListener("input", () => {
      note = noteField.input.value;
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
  let draft = await loadDraft(app, { signal: context.signal });
  if (!context.live()) return;
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
      draft = draftFromBody(record.body, reviseId, origin, record.rawBody);
      draft.savedDrafts = await app.store.savedDrafts();
      draft.revisionNotice = revisionChanges(record.body, origin);
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
  if (draft.revisionNotice) {
    const changes = draft.revisionNotice;
    delete draft.revisionNotice;
    saver.touch();
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
    text: `${kindLabel(draft.kind ?? "type not chosen")} · ${draft.language}`,
  });
  headline.append(
    h1,
    kindTag,
    assistanceAction(app, draft, saver, context, {
      key: "places-glosses",
      label: "Suggest places and glosses",
      operation: "places-glosses",
    }),
  );
  main.append(headline);
  if (draft.ai?.records.some((record) => record.key === "definition"))
    main.append(
      assistanceAction(app, draft, saver, context, {
        key: "definition",
        label: "Rewrite definition",
        operation: "definition",
      }),
    );
  if (draft.parents.length)
    main.append(
      el(
        "p",
        { class: "small", style: "margin-top:8px" },
        text("Revision of "),
        link(draft.parents[0], routes.definition(draft.parents[0]), {
          class: "fingerprint touch-link",
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
        `Marked for review after a change of ${draft.review.join(", ")}: retained evidence, places, and glosses stay unchanged. Review them for the current word and language.`,
        "notice",
      ),
    );
  let syncLabels = () => {};
  const formStatus = wordFormStatus(draft, () => {
    syncLabels();
    saver.touch();
    refreshPreview();
  });
  main.addEventListener("assist-change", formStatus.refresh);
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
      changeTypedWord(draft, spelling.input.value);
      h1.textContent = draft.spelling || "Full editor";
      formStatus.refresh();
      saver.touch();
      refreshPreview();
    });
    const kind = field("Type", {
      options: [
        { value: "", label: "choose" },
        ...lexicalKinds.map((k) => ({
          value: k,
          label: kindLabel(k),
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
      kindTag.textContent = `${kindLabel(draft.kind ?? "type not chosen")} · ${draft.language}`;
      formStatus.refresh();
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
      kindTag.textContent = `${kindLabel(draft.kind ?? "type not chosen")} · ${draft.language}`;
      saver.touch();
    });
    const selmaho = field("selma'o", {
      value: draft.selmaho.join(", "),
      wrapperClass: "",
      placeholder: "for example BY",
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
    main.append(identity, formStatus.wrapper);
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
  /** Inputs that mirror draft fields a reference rewrite can change. */
  const mirrors = new Set<() => void>();
  const syncMirrors = () => {
    for (const sync of mirrors) sync();
  };
  const editor = richField("Definition text", {
    multiline: true,
    structured: () => draft.structured,
    places: () =>
      draft.frameMode === "none"
        ? []
        : draft.places.map((place) => place.index),
    operands: () => draft.operands.map((operand) => operand.id),
    rows: 4,
    value: draft.text,
    labelClass: "sr",
  });
  editor.input.style.fontSize = "19px";
  editor.input.style.lineHeight = "1.7";
  const nextPlaceNumber = () =>
    Math.max(0, ...draft.places.map((place) => place.index)) + 1;
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
          `Literal mode turns the place references in ${lost.join(", ")} into circled characters as text, or into {place N} above 50. Links, code, and operands stay. Continue?`,
        )
      ) {
        structured.querySelector("input")!.checked = true;
        return;
      }
      switchMode(draft, value);
      syncMirrors();
      renderPlaces();
      refreshNumbering();
      saver.touch();
      refreshPreview();
    },
  );
  defSection.append(
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
      if (problem.richFieldKey)
        note.append(
          button(
            "Convert references to literal text",
            () => {
              rewriteReferences(draft, () => "literal", true, [
                problem.richFieldKey!,
              ]);
              syncMirrors();
              renderPlaces();
              saver.touch();
              refreshPreview();
            },
            { class: "btn btn-quiet" },
          ),
        );
      preview.append(note);
    }
  };
  mirrors.add(() => {
    editor.input.value = draft.text;
  });
  editor.input.addEventListener("input", () => {
    draft.text = editor.input.value;
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
          ? `Your meaning has ${proposal.count} place${proposal.count === 1 ? "" : "s"}. `
          : "Start from your meaning. ",
      ),
      button(
        proposal.count
          ? "Use the meaning with numbered places"
          : "Use the meaning as the definition",
        () => {
          draft.text = editorToRichText(proposal.text, true);
          if (!draft.structured)
            draft.text = remapRich(draft.text, () => "literal");
          editor.input.value = draft.text;
          if (proposal.count && !draft.places.length) {
            draft.places = Array.from(
              { length: Math.min(256, proposal.count) },
              (_, i) => newPlace(i + 1),
            );
            if (draft.frameMode === "none") draft.frameMode = "fixed";
            draft.fixedZeroApproved = false;
          }
          saver.touch();
          refreshPreview();
          renderPlaces();
          suggest.remove();
        },
        { class: "btn" },
      ),
      text(" You approve the numbering below before publishing."),
    );
    if (proposal.count) suggest.append(numberingParts(proposal.parts));
    defSection.append(suggest);
  }
  // Glosses. Each gloss keeps its own language and sense.
  const glossRow = glossChips(
    draft.glosses,
    "",
    () => saver.touch(),
    () => draft.language,
  );
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
  });
  const arityOptions = (): { value: FrameMode; label: string }[] => [
    { value: "fixed", label: `exactly ${draft.places.length}` },
    {
      value: "variadic",
      label: `${draft.variadicMinimum} or more`,
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
    draft.fixedZeroApproved =
      draft.frameMode === "fixed" && draft.places.length === 0;
    if (draft.frameMode === "variadic") {
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
  const placeAdvice = el("div");
  placesSection.append(placeAdvice, list, tailBox, numbering);
  const refreshPlaceAdvice = () => {
    const note = placeCountNote(draft, () => {
      draft.placeCountNoteHidden = true;
      saver.touch();
      refreshPlaceAdvice();
      arity.focus();
    });
    placeAdvice.replaceChildren(...(note ? [note] : []));
  };
  const addPlace = () => {
    if (draft.places.length >= 256) {
      app.announce("A frame declares at most 256 places.");
      return;
    }
    draft.places.push(newPlace(nextPlaceNumber()));
    draft.fixedZeroApproved = false;
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
        style: "width:5rem;padding:4px 8px",
      });
      idx.value = String(place.index);
      idx.addEventListener("change", () => {
        const previous = place.index;
        const next = Math.max(
          1,
          Math.min(65535, Number(idx.value) || previous),
        );
        // A number another place holds is refused before anything changes,
        // so two sets of references never merge.
        const taken = draft.places.find(
          (other) => other !== place && other.index === next,
        );
        if (taken) {
          idx.value = String(previous);
          app.announce(
            `Place ${next} is already declared (${editorText(taken.description, draft.structured).trim() || "without a description"}). Give that place another number first.`,
          );
          return;
        }
        place.index = next;
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
    const description = richField(`Description for place ${place.index}`, {
      multiline: true,
      structured: () => draft.structured,
      places: () =>
        draft.frameMode === "none"
          ? []
          : draft.places.map((place) => place.index),
      operands: () => draft.operands.map((operand) => operand.id),
      rows: 2,
      value: place.description,
      wrapperClass: "span-3",
      labelClass: "field-label",
    });
    description.label.textContent = "Description";
    description.label.append(
      el("span", { class: "sr", text: ` for place ${place.index}` }),
    );
    description.input.addEventListener("input", () => {
      place.description = description.input.value;
      saver.touch();
    });
    const gloss = {
      wrapper: el(
        "div",
        { class: "span-3" },
        glossChips(
          place.glosses,
          ` for place ${place.index}`,
          () => {
            saver.touch();
            refreshPreview();
          },
          () => draft.language,
        ),
      ),
    };
    const kind = field(`Kind of thing for place ${place.index}`, {
      options: kindChoices,
      value: place.kind,
      wrapperClass: "",
    });
    if (place.kind === "custom" && place.hint)
      kind.input.querySelector<HTMLOptionElement>(
        'option[value="custom"]',
      )!.textContent = hintLabel(place.hint);
    kind.label.textContent = "Kind of thing";
    kind.label.append(
      el("span", { class: "sr", text: ` for place ${place.index}` }),
    );
    const customSlot = el("div", { class: "span-3" });
    const renderCustom = () => {
      customSlot.replaceChildren();
      if (place.kind === "custom")
        customSlot.append(
          hintEditor(
            place.hint ?? hintForChoice("object"),
            draft.structured,
            (hint) => {
              place.hint = hint;
              saver.touch();
              refreshPreview();
            },
            draft,
          ),
        );
    };
    kind.input.addEventListener("change", () => {
      place.kind = kind.input.value as KindChoice;
      if (place.kind !== "custom") place.hint = null;
      saver.touch();
      renderCustom();
      refreshPreview();
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
    if (place.hint?.note.length) {
      const reason = el(
        "div",
        { class: "span-3 ai-hint-line" },
        renderRichText(place.hint.note, { placeHref: null }),
      );
      const aiRecord = draft.ai?.records.findLast(
        (r) => r.key === "places-glosses" && r.state === "accepted",
      );
      if (aiRecord)
        reason.append(
          button("How the assistant decided", () => inferenceLog(aiRecord), {
            class: "btn btn-quiet small",
          }),
        );
      const unsubscribe = assistanceVisibility(app, context).bind(reason);
      context.signal.addEventListener("abort", unsubscribe, { once: true });
      grid.append(reason);
    }
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
            if (!draft.places.length && !draft.fixedZeroApproved)
              draft.frameMode = "none";
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
    const parts = definitionParts(draft.text);
    if (parts.some((part) => part.places.length))
      numbering.append(numberingParts(parts));
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
          { class: "btn" },
        ),
      ),
    );
  };
  const rebuildHooks: (() => void)[] = [];
  const renderPlaces = () => {
    syncMirrors();
    refreshArity();
    refreshPlaceAdvice();
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
      minimum.input.max = "256";
      minimum.input.step = "1";
      minimum.input.addEventListener("input", () => {
        draft.variadicMinimum = Math.min(
          256,
          Math.max(0, Math.trunc(Number(minimum.input.value) || 0)),
        );
        saver.touch();
        refreshArity();
      });
      minimum.input.addEventListener("change", () => {
        minimum.input.value = String(draft.variadicMinimum);
      });
      const tailDescription = richField(
        `Places ${draft.places.length + 1} and on`,
        {
          multiline: true,
          structured: () => draft.structured,
          places: () =>
            draft.frameMode === "none"
              ? []
              : draft.places.map((place) => place.index),
          operands: () => draft.operands.map((operand) => operand.id),
          rows: 2,
          value: draft.tail?.description ?? [],
          placeholder: "what the repeated places are",
          wrapperClass: "",
        },
      );
      tailDescription.input.addEventListener("input", () => {
        draft.tail = {
          ...draft.tail,
          description: tailDescription.input.value,
          kind: draft.tail?.kind ?? "unspecified",
          hint: draft.tail?.hint ?? null,
        };
        saver.touch();
      });
      const tailKind = field("Kind of thing for the repeated places", {
        options: kindChoices,
        value: draft.tail?.kind ?? "unspecified",
        wrapperClass: "",
      });
      tailKind.input.addEventListener("change", () => {
        draft.tail = {
          ...draft.tail,
          description: draft.tail?.description ?? [],
          kind: tailKind.input.value as KindChoice,
          hint:
            tailKind.input.value === "custom"
              ? (draft.tail?.hint ?? hintForChoice("object"))
              : null,
        };
        saver.touch();
        renderTailCustom();
        refreshPreview();
      });
      const custom = el("div");
      const renderTailCustom = () => {
        custom.replaceChildren();
        if (draft.tail?.kind === "custom")
          custom.append(
            hintEditor(
              draft.tail.hint,
              draft.structured,
              (hint) => {
                draft.tail!.hint = hint;
                saver.touch();
                refreshPreview();
              },
              draft,
            ),
          );
      };
      renderTailCustom();
      const row = el("div", {
        style: "display:flex;flex-wrap:wrap;gap:12px 16px;margin-top:8px",
      });
      for (const f of [minimum, tailDescription, tailKind]) {
        f.wrapper.style.flex = "1 1 160px";
        row.append(f.wrapper);
      }
      tailBox.append(row, custom);
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
            renderDefaults();
          });
          const language = field(
            `Default language ${i + 1} for place ${place.index}`,
            { value: d.language, wrapperClass: "" },
          );
          language.wrapper.hidden = d.format !== "prose";
          language.input.addEventListener("input", () => {
            d.language = language.input.value;
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
          const condition = richField(
            `Condition ${i + 1} for place ${place.index}`,
            {
              multiline: true,
              structured: () => draft.structured,
              places: () =>
                draft.frameMode === "none"
                  ? []
                  : draft.places.map((place) => place.index),
              operands: () => draft.operands.map((operand) => operand.id),
              rows: 2,
              value: d.condition,
              wrapperClass: "",
              placeholder: "when…",
            },
          );
          condition.input.addEventListener("input", () => {
            d.condition = condition.input.value;
            saver.touch();
          });
          const explanation = richField(
            `Explanation of default ${i + 1} for place ${place.index}`,
            {
              multiline: true,
              structured: () => draft.structured,
              places: () =>
                draft.frameMode === "none"
                  ? []
                  : draft.places.map((place) => place.index),
              operands: () => draft.operands.map((operand) => operand.id),
              rows: 2,
              value: d.explanation,
              wrapperClass: "",
            },
          );
          explanation.input.addEventListener("input", () => {
            d.explanation = explanation.input.value;
            saver.touch();
          });
          for (const f of [
            kind,
            format,
            language,
            value,
            condition,
            explanation,
          ]) {
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
      const constraints = constraintEditor(
        place.constraints,
        `for place ${place.index}`,
        draft,
        () => saver.touch(),
        place,
      );
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
        constraints,
      );
      box.append(block);
    }
    const frameConstraints = constraintEditor(
      draft.frameConstraints,
      "between places",
      draft,
      () => saver.touch(),
      draft,
    );
    box.append(
      frameConstraints,
      p(
        "A missing default does not mean zo'e or an empty value. Version 1 does not execute conditions.",
        "meta",
      ),
    );
    return box;
  });
  const rebuildDefaults = () => {
    const body = defaultsDetails.querySelector(":scope > .body");
    if (!body) return;
    body.replaceChildren();
    if (defaultsDetails.open)
      defaultsDetails.dispatchEvent(new Event("toggle"));
  };
  rebuildHooks.push(rebuildDefaults);
  open("Notes", () => {
    const notes = richField("Notes", {
      multiline: true,
      structured: () => draft.structured,
      places: () =>
        draft.frameMode === "none"
          ? []
          : draft.places.map((place) => place.index),
      operands: () => draft.operands.map((operand) => operand.id),
      rows: 3,
      value: draft.notes,
      labelClass: "sr",
      wrapperClass: "",
    });
    mirrors.add(() => {
      notes.input.value = draft.notes;
    });
    notes.input.addEventListener("input", () => {
      draft.notes = notes.input.value;
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
        const language = field(`Language of example ${i + 1}`, {
          value: example.language,
          wrapperClass: "",
        });
        language.input.addEventListener("input", () => {
          example.language = language.input.value;
          saver.touch();
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
        const translation = richField(`Translation of example ${i + 1}`, {
          multiline: true,
          structured: () => draft.structured,
          places: () =>
            draft.frameMode === "none"
              ? []
              : draft.places.map((place) => place.index),
          operands: () => draft.operands.map((operand) => operand.id),
          local: false,
          rows: 2,
          value: example.translation,
          wrapperClass: "",
        });
        mirrors.add(() => {
          translation.input.value = example.translation;
        });
        translation.input.addEventListener("input", () => {
          example.translation = translation.input.value;
          saver.touch();
        });
        const notesField = richField(`Notes for example ${i + 1}`, {
          multiline: true,
          structured: () => draft.structured,
          places: () =>
            draft.frameMode === "none"
              ? []
              : draft.places.map((place) => place.index),
          operands: () => draft.operands.map((operand) => operand.id),
          local: false,
          rows: 2,
          value: example.notes,
          wrapperClass: "",
        });
        mirrors.add(() => {
          notesField.input.value = example.notes;
        });
        notesField.input.addEventListener("input", () => {
          example.notes = notesField.input.value;
          saver.touch();
        });
        for (const f of [language, textField, translation, notesField]) {
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
      const etym = richField("Etymology", {
        multiline: true,
        structured: () => draft.structured,
        places: () =>
          draft.frameMode === "none"
            ? []
            : draft.places.map((place) => place.index),
        operands: () => draft.operands.map((operand) => operand.id),
        local: false,
        rows: 3,
        value: draft.etymologyText,
        labelClass: "sr",
        wrapperClass: "",
        hint: "Descriptive text without place references. Morphology notes from the Form step are added after it.",
      });
      mirrors.add(() => {
        etym.input.value = draft.etymologyText;
      });
      etym.input.addEventListener("input", () => {
        draft.etymologyText = etym.input.value;
        saver.touch();
      });
      const nodes: Node[] = [etym.wrapper];
      if (draft.compound)
        nodes.push(
          p(
            isZeiCompound(draft.compound)
              ? `Component words: ${draft.compound.components.map((c) => c.word.spelling).join(" zei ")}. Read-only.`
              : `Compound evidence: ${draft.compound.components.map((c) => `${c.word.spelling} (${c.rafsi})`).join(" + ")}${draft.compound.score !== null ? ` · score ${draft.compound.score}` : ""}. Read-only.`,
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
      if (draft.compound || draft.formation) {
        const evidence = el("div", {}, ...nodes);
        evidence.append(
          button(
            "Remove formation evidence",
            () => {
              if (!removeFormationEvidence(draft)) return;
              saver.touch();
              evidence.replaceChildren(
                etym.wrapper,
                p(
                  'No structured formation evidence in this draft. "Use" in a builder saves it. Manual entry adds none.',
                  "meta",
                ),
              );
            },
            { class: "btn btn-quiet" },
          ),
        );
        return evidence;
      }
      if (!draft.compound && !draft.formation)
        nodes.push(
          p(
            'No structured formation evidence in this draft. "Use" in a builder saves it. Manual entry adds none.',
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
          const description = richField(`Operand ${i + 1} description`, {
            multiline: true,
            structured: () => draft.structured,
            places: () =>
              draft.frameMode === "none"
                ? []
                : draft.places.map((place) => place.index),
            operands: () => draft.operands.map((operand) => operand.id),
            rows: 2,
            value: operand.description,
            wrapperClass: "",
          });
          mirrors.add(() => {
            description.input.value = operand.description;
          });
          description.input.addEventListener("input", () => {
            operand.description = description.input.value;
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
      syncLabels = () => {
        labels.input.value = draft.labels.join(", ");
      };
      labels.input.addEventListener("input", () => {
        draft.labels = labels.input.value
          .split(",")
          .map((l) => l.trim())
          .filter(Boolean);
        formStatus.refresh();
        saver.touch();
        refreshPreview();
      });
      return labels.wrapper;
    });
    open("Rafsi claims", () => {
      const box = el("div", { class: "stack" });
      const render = () => {
        box.replaceChildren(
          p(
            "Each claim is a separate signed record with its own author blessing of the word and rafsi pair. Publish compares claims with the downloaded package and names that snapshot. Missing package coverage is unknown.",
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
            refreshPreview();
          });
          const rationale = richField(`Rationale for rafsi ${i + 1}`, {
            local: false,
            multiline: true,
            rows: 2,
            value: richValue(claim.rationale),
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
                draft.rafsiClaims.push({ rafsi: "", rationale: [] });
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
    const fixedFields = open("Fixed fields", () => [
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
    const inspector = open("JSON inspector", () => {
      const { body } = draftToBody(draft);
      return el("pre", { class: "json", text: JSON.stringify(body, null, 2) });
    });
    const refreshInspection = () => {
      const pre = inspector.querySelector("pre");
      if (pre)
        pre.textContent = JSON.stringify(draftToBody(draft).body, null, 2);
      const frame = fixedFields.querySelector(".body p:last-child");
      if (frame)
        frame.textContent = `Word ID and event ID are derived at signing. Frame: ${draft.frameMode === "none" ? "null" : describeArity(draft.frameMode === "fixed" ? { mode: "fixed", count: draft.places.length } : draft.frameMode === "variadic" ? { mode: "variadic", minimum: draft.variadicMinimum } : { mode: "context" })}.`;
    };
    main.addEventListener("input", refreshInspection);
    main.addEventListener("change", refreshInspection);
    main.addEventListener("keydown", refreshInspection);
    main.addEventListener("click", refreshInspection);
    inspector.addEventListener("toggle", refreshInspection);
    fixedFields.addEventListener("toggle", refreshInspection);
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
            : formPath(draft)
          : formPath(draft),
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
  definitionLanguage: () => string,
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
      const language = languageMatch ? languageMatch[1] : definitionLanguage();
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
        "A sense in parentheses, such as great (in a property), is optional. A language prefix, such as fr: grand, sets the gloss language. Without one, the gloss keeps the current definition language.",
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
        refreshMapping();
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
        refreshMapping();
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
        refreshMapping();
        changed();
      });
      const explanation = richField(
        `Explanation of derivation ${n} for place ${place.index}`,
        {
          multiline: true,
          structured,
          local: false,
          rows: 2,
          value: derivation.explanation,
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
        derivation.explanation = explanation.input.value;
        refreshMapping();
        changed();
      });
      const mapping = el("p", {
        class: "meta span-3",
        text: `${derivation.word} ${derivation.place ?? "?"}${mappingKind(derivation.explanation) ? ` · ${mappingKind(derivation.explanation)}` : ""}`,
      });
      const refreshMapping = () => {
        mapping.textContent = `${derivation.word} ${derivation.place ?? "?"}${mappingKind(derivation.explanation) ? ` · ${mappingKind(derivation.explanation)}` : ""}`;
      };
      row.append(
        mapping,
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
          style: "margin-top:6px;",
        },
      ),
    );
  };
  render();
  return box;
}

/** Each constraint keeps its paragraphs and rich nodes in a separate editor. */
function constraintEditor(
  values: RichText[],
  suffix: string,
  draft: Draft,
  changed: () => void,
  owner: object,
): HTMLElement {
  const box = el("div");
  const render = () => {
    box.replaceChildren();
    values.forEach((value, i) => {
      const input = richField(`Constraint ${i + 1} ${suffix}`, {
        multiline: true,
        structured: () => draft.structured,
        places: () =>
          draft.frameMode === "none"
            ? []
            : draft.places.map((place) => place.index),
        operands: () => draft.operands.map((operand) => operand.id),
        rows: 2,
        value: value,
        wrapperClass: "",
      });
      input.input.addEventListener("input", () => {
        values[i] = input.input.value;
        changed();
      });
      box.append(
        input.wrapper,
        button(
          `Remove constraint ${i + 1} ${suffix}`,
          () => {
            values.splice(i, 1);
            (owner as { constraintIds?: string[] }).constraintIds?.splice(i, 1);
            changed();
            render();
          },
          { class: "btn btn-quiet" },
        ),
      );
    });
    box.append(
      button(
        `Add a constraint ${suffix}`,
        () => {
          values.push([]);
          changed();
          render();
        },
        { class: "btn btn-quiet" },
      ),
    );
  };
  render();
  return box;
}
