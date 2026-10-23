import { assistanceAction } from "../../components/assistance.ts";
/**
 * Step 3C: the manual Form screen. Spelling, attributed morphology notes, and
 * selma'o for cmavo. The lujvo builder and the gismu generator have their own
 * pages and link back here for manual entry.
 */
import { el, p, text, field, link, button } from "../../lib/dom.ts";
import { navigate, type RenderContext, type Route } from "../../app/router.ts";
import type { App } from "../../app/context.ts";
import type { Draft } from "../../model/draft.ts";
import { manualFormation, syncFormationSources } from "../../model/builders.ts";
import {
  actionBar,
  DraftSaver,
  loadDraft,
  stepBar,
  removeFormationEvidence,
} from "./common.ts";

export async function formPage(route: Route, context: RenderContext, app: App) {
  const { main } = context;
  context.title("Add a word: Form");
  main.className = "surface-wizard";
  const draft = await loadDraft(app);
  if (!context.live()) return;
  if (!draft) {
    navigate("/new/meaning", { replace: true });
    return;
  }
  const saver = new DraftSaver(app, draft);
  main.append(stepBar(draft, 3));
  const kind = draft.kind;
  const section = el("section", {
    "aria-labelledby": "h1",
    style: "max-width:40rem",
  });
  const title =
    kind === "cmavo"
      ? "Enter the cmavo"
      : kind === "lujvo"
        ? "Enter the lujvo"
        : kind === "gismu"
          ? "Enter the gismu"
          : "Enter the form";
  section.append(el("h1", { id: "h1", class: "page", text: title }));
  const evidenceNotice = el("div");
  const renderEvidence = () => {
    evidenceNotice.replaceChildren();
    if (!draft.compound && !draft.formation) return;
    evidenceNotice.append(
      p(
        `This draft keeps ${draft.compound ? "construction" : "generation"} evidence for ${draft.evidenceForm ?? draft.spelling}. Manual entry does not remove it.`,
        "small",
      ),
      button(
        "Remove formation evidence",
        () => {
          if (!removeFormationEvidence(draft)) return;
          saver.touch();
          renderEvidence();
        },
        { class: "btn btn-quiet" },
      ),
    );
    if (syncFormationSources(draft))
      evidenceNotice.append(
        p(
          "The source scoring inputs changed. Using this form without generation removes the old scores.",
          "small",
        ),
      );
  };
  if (kind === "lujvo" || kind === "gismu")
    section.append(
      el(
        "p",
        { class: "small" },
        text(
          kind === "lujvo"
            ? "Manual entry adds no construction evidence. "
            : "Manual entry adds no generation evidence. ",
        ),
        link(
          kind === "lujvo"
            ? "Open the lujvo builder"
            : "Open the gismu generator",
          kind === "lujvo" ? "/new/lujvo" : "/new/gismu",
        ),
      ),
    );
  else if (route.params.get("manual"))
    section.append(
      p(
        "Manual entry. The notes stay attributed to you and never become a parser rule.",
        "small",
      ),
    );
  renderEvidence();
  section.append(evidenceNotice);
  const spelling = field("Spelling", {
    value: draft.spelling,
    spellcheck: false,
    lang: "jbo",
    hint: "Lojban letters, apostrophes, periods, commas, and single spaces. Case is preserved.",
  });
  spelling.input.style.fontSize = "24px";
  spelling.input.addEventListener("input", () => {
    if (draft.spelling !== spelling.input.value) draft.publishAcknowledged = [];
    draft.spelling = spelling.input.value;
    saver.touch();
    refresh();
  });
  section.append(spelling.wrapper);
  if (kind === "cmavo" || kind === "compound" || kind === "letteral") {
    const selmaho = field("selma'o", {
      value: draft.selmaho.join(", "),
      placeholder: "for example UI, or BAI*",
      hint: "The grammatical class as a claim. Separate alternatives with commas. An unknown or proposed selma'o is permitted.",
    });
    selmaho.input.addEventListener("input", () => {
      draft.selmaho = selmaho.input.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      saver.touch();
    });
    section.append(
      selmaho.wrapper,
      kind === "cmavo"
        ? assistanceAction(app, draft, saver, context, {
            key: "cmavo-class",
            label: "Suggest a selma'o",
            operation: "cmavo-class",
          })
        : el("span", { hidden: true }),
    );
  }
  const notes = field("Morphology notes", {
    multiline: true,
    rows: 3,
    value: draft.formNotes,
    hint: "Optional. Why this form, which parts it comes from, or an experimental classification. Saved as etymology text under your name, after any etymology kept from a revised parent.",
  });
  notes.input.addEventListener("input", () => {
    draft.formNotes = notes.input.value;
    saver.touch();
  });
  section.append(notes.wrapper);
  if (
    kind === "fuivla" ||
    kind === "cmevla" ||
    kind === "other" ||
    kind === "compound" ||
    kind === "letteral"
  )
    section.append(
      p(
        "Morphology assistance is not available in this build. A morphology disagreement is a warning, not a rejection. You can proceed with an explicit experimental classification.",
        "meta",
      ),
    );
  section.append(
    el(
      "p",
      { class: "meta" },
      text(
        "Formation evidence from a builder describes one exact form. If the spelling changes, publishing is blocked until the form is built again or the evidence is removed. Changing the form never rewrites your prose. ",
      ),
      link("Change the type", "/new/type"),
    ),
  );
  main.append(section);
  const bar = actionBar(saver, {
    back: { label: "Back", href: "/new/type" },
    primary: {
      label: `Use ${draft.spelling.trim() || "this form"}`,
      disabled: !draft.spelling.trim(),
      action: async () => {
        if (!draft.spelling.trim()) return;
        if (
          kind === "gismu" &&
          draft.gismu &&
          (!draft.formation || syncFormationSources(draft))
        ) {
          draft.formation = manualFormation(
            draft.gismu.rows,
            draft.gismu.reason,
          );
          if (draft.formation) draft.evidenceForm = draft.spelling;
        }
        draft.step = Math.max(draft.step, 4) as Draft["step"];
        if (!(await saver.flush())) return;
        navigate("/new/places");
      },
    },
  });
  const refresh = () => {
    const button = bar.querySelector<HTMLButtonElement>(".btn-primary");
    if (!button) return;
    button.textContent = `Use ${draft.spelling.trim() || "this form"}`;
    button.disabled = !draft.spelling.trim();
  };
  main.append(bar);
}
