import { wordFormStatus } from "../../components/word-form-feedback.ts";
import { kindLabel } from "../../model/types.ts";
import { detectWord, typedWord } from "../../model/typed-headword.ts";
import {
  cachedPackage,
  inventoryFromPackage,
  currentRootConflicts,
} from "../../model/builders.ts";
import {
  assistanceAction,
  assistanceVisibility,
} from "../../components/assistance.ts";
/** Step 2: the word type, with manual entry for authors who already have the spelling. */
import { el, p, text, link, button } from "../../lib/dom.ts";
import { navigate, type RenderContext, type Route } from "../../app/router.ts";
import type { App } from "../../app/context.ts";
import type { Draft } from "../../model/draft.ts";
import type { LexicalKind } from "../../model/types.ts";
import {
  confirmKindChange,
  actionBar,
  DraftSaver,
  formPath,
  loadDraft,
  stepBar,
} from "./common.ts";

const cards: {
  kind: LexicalKind;
  title: string;
  explanation: string;
  example: string;
}[] = [
  {
    kind: "lujvo",
    title: "lujvo",
    explanation: "Compound of existing words.",
    example: "vlaste = valsi + liste",
  },
  {
    kind: "gismu",
    title: "gismu",
    explanation: "New five-letter root, built from several languages.",
    example: "bangu",
  },
  {
    kind: "fuhivla",
    title: kindLabel("fuhivla"),
    explanation: "Borrowed word.",
    example: "leksiko",
  },
  {
    kind: "cmavo",
    title: "cmavo",
    explanation: "Grammar word.",
    example: "lo, ka'a",
  },
  {
    kind: "cmevla",
    title: "cmevla",
    explanation: "Name.",
    example: ".lojban.",
  },
  {
    kind: "other",
    title: "Other",
    explanation: "Fixed phrase or another word type.",
    example: "",
  },
];
const otherKinds: { kind: LexicalKind; label: string }[] = [
  { kind: "compound", label: "compound cmavo" },
  { kind: "letteral", label: "letteral" },
  { kind: "other", label: "other fixed phrase or form" },
];
export function nextActionLabel(kind: LexicalKind | null): string {
  switch (kind) {
    case "lujvo":
      return "Build the lujvo";
    case "gismu":
      return "Make a gismu";
    case "cmavo":
      return "Enter the cmavo";
    default:
      return "Enter the form";
  }
}
export async function typePage(
  _route: Route,
  context: RenderContext,
  app: App,
) {
  const { main } = context;
  context.title("Add a word: Type");
  main.className = "surface-wizard";
  const draft = await loadDraft(app, { signal: context.signal });
  if (!context.live()) return;
  if (!draft) {
    navigate("/new/meaning", { replace: true });
    return;
  }
  const saver = new DraftSaver(app, draft);
  const spelling = typedWord(draft.spelling);
  const analysis = spelling ? detectWord(spelling) : null;
  const detected = analysis
    ? analysis.kind === "unknown"
      ? "other"
      : analysis.kind
    : null;
  if (draft.detectionFor !== spelling) {
    if (draft.kind === null || draft.kind === draft.autoDetectedKind) {
      if (confirmKindChange(draft, detected)) {
        if (detected) draft.autoDetectedKind = detected;
      } else {
        draft.review = [...new Set([...draft.review, "word type"])];
      }
    } else if (detected && draft.kind !== detected) {
      draft.review = [...new Set([...draft.review, "word type"])];
    }
    draft.detectionFor = spelling;
    saver.touch();
  }
  if (
    detected &&
    draft.kind === detected &&
    draft.review.includes("word type")
  ) {
    draft.review = draft.review.filter((field) => field !== "word type");
    saver.touch();
  }
  const labelFor = () =>
    spelling && (draft.kind === "gismu" || draft.kind === "fuhivla")
      ? "Continue to places"
      : spelling && draft.kind === "lujvo"
        ? "Link the lujvo parts"
        : nextActionLabel(draft.kind);
  main.append(stepBar(draft, 2));
  const columns = el("div", { class: "two-col" });
  const section = el("section", { "aria-labelledby": "h1", class: "main-col" });
  section.append(
    el("h1", {
      id: "h1",
      class: "page",
      style: "margin-bottom:20px",
      text: "What kind of word?",
    }),
  );
  const detection = el("div", { role: "status", "aria-live": "polite" });
  const typeReview = p(
    "The spelling changed. Review the word type that you chose.",
    "small",
  );
  typeReview.hidden = !draft.review.includes("word type");
  detection.append(typeReview);
  if (analysis) {
    detection.append(
      p(
        `Detected form: ${kindLabel(analysis.kind)}. You can choose another kind.`,
        "small",
      ),
    );
    for (const diagnostic of analysis.diagnostics)
      detection.append(p(diagnostic, "meta"));
  }
  const formStatus = wordFormStatus(draft, () => saver.touch());
  section.append(detection, formStatus.wrapper);
  main.addEventListener("assist-change", formStatus.refresh);
  const rootWarnings = el("div", {
    role: "region",
    "aria-label": "Gismu closeness",
  });
  const packageData = await cachedPackage(app.store);
  if (!context.live()) return;
  const renderRoots = () => {
    rootWarnings.replaceChildren();
    if (!spelling || draft.kind !== "gismu") return;
    if (!packageData)
      rootWarnings.append(
        p(
          "Gismu closeness could not be checked. No local package is downloaded.",
          "small",
        ),
      );
    else {
      try {
        const conflicts = currentRootConflicts(
          spelling,
          inventoryFromPackage(packageData),
        );
        rootWarnings.append(
          p(
            `Gismu closeness in local snapshot ${packageData.snapshot}. Other inventories are unknown.`,
            "meta",
          ),
        );
        if (!conflicts.length)
          rootWarnings.append(
            p("No known gismu is too close in this package.", "small"),
          );
        for (const conflict of conflicts)
          rootWarnings.append(
            el(
              "p",
              { class: "small" },
              text(
                conflict.rule === "identical"
                  ? "Identical to "
                  : conflict.rule === "final-vowel"
                    ? "Last vowel differs from "
                    : "Too close to ",
              ),
              link(
                conflict.spelling,
                `/word/${encodeURIComponent(conflict.word)}`,
              ),
            ),
          );
      } catch (error) {
        rootWarnings.append(
          p(`Gismu closeness could not be checked: ${String(error)}`, "small"),
        );
      }
    }
    rootWarnings.append(
      link("Add source-language evidence", "/new/gismu?evidence=1", {
        class: "touch-link",
      }),
    );
  };
  renderRoots();
  section.append(rootWarnings);
  const fieldset = el("fieldset", { style: "border:0;margin:0;padding:0" });
  fieldset.append(el("legend", { class: "sr", text: "Word type" }));
  const grid = el("div", { class: "type-grid" });
  const otherChoice = el("div", { style: "margin-top:12px" });
  const labels: HTMLLabelElement[] = [];
  const isOther = (kind: LexicalKind | null) =>
    kind === "compound" || kind === "letteral" || kind === "other";
  const renderOther = () => {
    otherChoice.replaceChildren();
    if (!isOther(draft.kind)) return;
    const select = el("select", {
      class: "field",
      id: "other-kind",
      style: "max-width:20rem",
    });
    for (const option of otherKinds)
      select.append(
        el("option", {
          value: option.kind,
          text: option.label,
          selected: option.kind === draft.kind,
        }),
      );
    select.addEventListener("change", () => {
      if (!confirmKindChange(draft, select.value as LexicalKind)) {
        select.value = draft.kind ?? "other";
        return;
      }
      saver.touch();
      refreshPrimary();
    });
    otherChoice.append(
      el("label", {
        for: "other-kind",
        class: "field-label",
        text: "Which other kind? Every lexical kind that the format permits is listed.",
      }),
      select,
    );
  };
  const choose = async (kind: LexicalKind) => {
    if (!confirmKindChange(draft, kind)) {
      for (const l of labels)
        l.querySelector("input")!.checked =
          l.dataset.kind === draft.kind ||
          (isOther(draft.kind) && l.dataset.kind === "other");
      return;
    }
    for (const l of labels)
      l.classList.toggle("on", l.querySelector("input")!.checked);
    renderOther();
    saver.touch();
    refreshPrimary();
  };
  for (const card of cards) {
    const input = el("input", {
      type: "radio",
      name: "kind",
      value: card.kind,
    });
    input.checked =
      card.kind === draft.kind ||
      (card.kind === "other" && isOther(draft.kind));
    const label = el(
      "label",
      { class: `opt${input.checked ? " on" : ""}`, "data-kind": card.kind },
      input,
      el(
        "span",
        {},
        el("span", {
          style: "display:block;font-weight:650",
          text: card.title,
        }),
        el(
          "span",
          { class: "small", style: "display:block" },
          text(card.explanation + " "),
          card.example
            ? el("span", { class: "meta", lang: "jbo", text: card.example })
            : null,
        ),
      ),
    );
    input.addEventListener("change", () => void choose(card.kind));
    labels.push(label);
    grid.append(label);
  }
  fieldset.append(grid);
  section.append(fieldset, otherChoice);
  const visibility = assistanceVisibility(app, context);
  const markAiPick = () => {
    for (const label of labels) label.querySelector(".ai-pick")?.remove();
    if (!visibility.enabled) return;
    const record = draft.ai?.records.findLast(
      (r) => r.key === "type" && (r.state === "done" || r.state === "accepted"),
    );
    const pick = record?.result?.proposals.find((p) => p.path === "/word_type")
      ?.value as LexicalKind | undefined;
    const target = labels.find(
      (label) =>
        label.dataset.kind === pick ||
        (isOther(pick ?? null) && label.dataset.kind === "other"),
    );
    if (target) target.append(text("AI pick", "ai-tag ai-pick"));
  };
  main.addEventListener("assist-change", markAiPick);
  const unsubscribeAi = visibility.subscribe(markAiPick);
  context.signal.addEventListener("abort", unsubscribeAi, { once: true });
  markAiPick();
  renderOther();
  section.append(
    el(
      "p",
      { class: "small", style: "margin-top:14px" },
      text("Have the spelling already? "),
      link("Type it in and skip the builder", "/new/form?manual=1", {
        class: "touch-link",
      }),
    ),
  );
  section.append(
    assistanceAction(app, draft, saver, context, {
      key: "type",
      label: "Recommend a type",
      operation: "type",
    }),
  );
  const aside = el("aside", {
    class: "side-col",
    style: "flex:1 1 260px;display:flex;flex-direction:column;gap:14px",
  });
  aside.append(
    el(
      "div",
      { class: "card" },
      p("Your meaning", "meta"),
      el(
        "p",
        { style: "margin-top:4px" },
        el("bdi", { text: draft.meaning || "(no meaning yet)" }),
      ),
    ),
  );
  columns.append(section, aside);
  main.append(columns);
  let primary: HTMLElement;
  const refreshPrimary = () => {
    const button = primary.querySelector<HTMLButtonElement>(".btn-primary");
    if (!button) return;
    button.textContent = labelFor();
    typeReview.hidden = !draft.review.includes("word type");
    renderRoots();
    formStatus.refresh();
    button.disabled = !draft.kind;
  };
  primary = actionBar(saver, {
    back: { label: "Back", href: "/new/meaning" },
    primary: {
      label: labelFor(),
      disabled: !draft.kind,
      action: async () => {
        if (!draft.kind || !confirmKindChange(draft, draft.kind)) return;
        const places =
          spelling && (draft.kind === "gismu" || draft.kind === "fuhivla");
        draft.step = Math.max(draft.step, places ? 4 : 3) as Draft["step"];
        if (!(await saver.flush())) return;
        navigate(places ? "/new/places" : formPath(draft));
      },
    },
  });
  main.append(primary);
  main.addEventListener("assist-change", refreshPrimary, {
    signal: context.signal,
  });
}
