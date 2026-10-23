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
    kind: "fuivla",
    title: "fu'ivla",
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
    explanation: "Letteral, compound cmavo, experimental form.",
    example: "",
  },
];
const otherKinds: { kind: LexicalKind; label: string }[] = [
  { kind: "compound", label: "compound cmavo" },
  { kind: "letteral", label: "letteral" },
  { kind: "other", label: "other experimental form" },
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
  const draft = await loadDraft(app);
  if (!context.live()) return;
  if (!draft) {
    navigate("/new/meaning", { replace: true });
    return;
  }
  const saver = new DraftSaver(app, draft);
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
      draft.kind = select.value as LexicalKind;
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
    p(
      "Type suggestions by AI are not configured on this server. Choose the type yourself.",
      "meta",
    ),
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
    button.textContent = nextActionLabel(draft.kind);
    button.disabled = !draft.kind;
  };
  primary = actionBar(saver, {
    back: { label: "Back", href: "/new/meaning" },
    primary: {
      label: nextActionLabel(draft.kind),
      disabled: !draft.kind,
      action: async () => {
        if (!draft.kind) return;
        draft.step = Math.max(draft.step, 3) as Draft["step"];
        if (!(await saver.flush())) return;
        navigate(formPath(draft));
      },
    },
  });
  main.append(primary);
}
