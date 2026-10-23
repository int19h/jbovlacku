import {
  assistanceAction,
  inferenceLog,
  assistanceVisibility,
  runAssistance,
} from "../../components/assistance.ts";
import {
  sourceCurrent,
  applySource,
  retainAssistance,
} from "../../model/assistance.ts";
/**
 * Step 3B: the gismu generator. Documented presets with pinned sources or
 * custom languages and weights, editable source rows, exact scores from the
 * shared core, tied ranks, per-language contributions, complete conflicts,
 * and a manual form without fabricated evidence.
 */
import {
  builderPresets,
  BuilderError,
  generateGismu,
  type BuilderPreset,
  type GismuCandidate,
  type GismuResult,
} from "../../../../../packages/core/src/index.ts";
import {
  el,
  p,
  text,
  button,
  link,
  field,
  icon,
  describe,
} from "../../lib/dom.ts";
import { navigate, type RenderContext, type Route } from "../../app/router.ts";
import type { App } from "../../app/context.ts";
import type { Draft } from "../../model/draft.ts";
import type { RichText } from "../../model/types.ts";
import { richTextToText, textToRichText } from "../../model/richtext.ts";
import type { CachedPackage } from "../../data/search.ts";
import {
  cachedPackage,
  decimal,
  formationMetadata,
  inventoryFromPackage,
  inventoryCoverage,
  rootConflictKey,
  newGismuState,
  sourceRowId,
  sourceRowKey,
  sourceRowsFromFormation,
  sourceNotes,
  syncFormationSources,
  alternativeSourceRow,
  editSourceNotes,
  sourceReviewMarks,
  resolveSourceReview,
  type GismuRowState,
  type PackageInventory,
} from "../../model/builders.ts";
import {
  actionBar,
  confirmKindChange,
  DraftSaver,
  loadDraft,
  stepBar,
} from "./common.ts";

function presetRows(
  preset: BuilderPreset,
  previous: GismuRowState[],
): GismuRowState[] {
  return preset.languages.map((language) => {
    const old = previous.find((r) => r.language === language.language);
    return {
      ...old,
      id: old?.id ?? sourceRowId(),
      language: language.language,
      name: language.name,
      word: old?.word ?? "",
      ...(!old ? { aiNoteGroup: [] } : {}),
      input: old?.input ?? "",
      weight: {
        numerator: String(language.numerator),
        denominator: String(preset.denominator),
      },
    };
  });
}
export async function gismuPage(
  _route: Route,
  context: RenderContext,
  app: App,
) {
  const { main } = context;
  context.title("Add a word: Make a gismu");
  main.className = "surface-wizard";
  const draft = await loadDraft(app);
  if (!context.live()) return;
  if (!draft) {
    navigate("/new/meaning", { replace: true });
    return;
  }
  const saver = new DraftSaver(app, draft);
  // Changes made while opening the generator are saved like any other edit.
  if (draft.kind !== "gismu") {
    if (!confirmKindChange(draft, "gismu")) {
      navigate("/new/type", { replace: true });
      return;
    }
    saver.touch();
  }
  const existingBuilder = draft.gismu;
  const state = (draft.gismu ??= newGismuState());
  const presets = builderPresets();
  if (!existingBuilder && draft.formation?.sources.length) {
    state.rows = sourceRowsFromFormation(
      draft.formation.sources,
      draft.retainedWordIpaNullSources ?? [],
    );
    saver.touch();
  } else if (state.preset === null && !state.rows.length && !existingBuilder) {
    state.preset = presets[0].id;
    state.rows = presetRows(presets[0], []);
    saver.touch();
  }
  const cached = await cachedPackage(app.store);
  if (!context.live()) return;
  const inventory: PackageInventory = inventoryFromPackage(cached);
  main.append(stepBar(draft, 3));
  const columns = el("div", { class: "two-col" });
  const section = el("section", {
    "aria-labelledby": "h1",
    class: "main-col",
    style: "flex-basis:520px",
  });
  section.append(el("h1", { id: "h1", class: "page", text: "Make a gismu" }));
  section.append(
    el(
      "p",
      { class: "muted", style: "margin:6px 0 16px" },
      text("for "),
      el("bdi", { text: draft.meaning || "(no meaning yet)" }),
    ),
  );
  const staleFormation = p(
    "The source scoring inputs changed. Use the form again to refresh its scores, enter it without generation, or remove the evidence before publication.",
    "small",
  );
  staleFormation.hidden = !syncFormationSources(draft);
  section.append(staleFormation);
  const saveSources = () => {
    staleFormation.hidden = !syncFormationSources(draft);
    saver.touch();
  };
  // Preset select.
  const head = el("div", {
    style:
      "display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px",
  });
  head.append(
    el("h2", {
      id: "src-h",
      class: "section",
      style: "margin:0",
      text: "Source words",
    }),
  );
  const presetField = field("Weights", {
    value: state.preset ?? "custom",
    options: [
      ...presets.map((pr) => ({ value: pr.id, label: pr.label })),
      { value: "custom", label: "Custom" },
    ],
    labelClass: "meta",
    wrapperClass: "",
  });
  presetField.wrapper.style.display = "inline-flex";
  presetField.wrapper.style.alignItems = "center";
  presetField.wrapper.style.gap = "8px";
  presetField.input.style.width = "auto";
  presetField.input.style.maxWidth = "100%";
  presetField.wrapper.style.maxWidth = "100%";
  presetField.wrapper.style.flexWrap = "wrap";
  presetField.input.addEventListener("change", () => {
    const chosen =
      presets.find((pr) => pr.id === presetField.input.value) ?? null;
    state.preset = chosen?.id ?? null;
    if (chosen) state.rows = presetRows(chosen, state.rows);
    state.acknowledged = [];
    saveSources();
    renderRows();
    schedule();
  });
  head.append(presetField.wrapper);
  section.append(head);
  const presetNote = el("p", {
    class: "meta",
    style: "overflow-wrap:anywhere",
  });
  const rowsBox = el("div", {
    class: "table-scroll",
    style: "margin-top:8px",
    tabindex: "0",
    role: "region",
    "aria-labelledby": "src-h",
  });
  const rowButtons = el("div", {
    style: "margin-top:10px;display:flex;flex-wrap:wrap;gap:8px",
  });
  const sourceActions = el("div", { class: "ai-source-actions" });
  const sourceControls = new Map<string, HTMLElement>();
  const sourceObservers = new Map<string, MutationObserver>();
  let rowCleanups: (() => void)[] = [];
  const cleanupRows = () => {
    for (const unsubscribe of rowCleanups) unsubscribe();
    rowCleanups = [];
  };
  context.signal.addEventListener(
    "abort",
    () => {
      cleanupRows();
      for (const observer of sourceObservers.values()) observer.disconnect();
    },
    { once: true },
  );
  const notesEditing = new Set<string>();
  const detailRows = new Map<
    string,
    { row: HTMLElement; notes: boolean; control: HTMLElement }
  >();
  const visibility = assistanceVisibility(app, context);
  const syncSourceVisibility = () => {
    sourceActions.hidden =
      !visibility.enabled ||
      !state.rows.length ||
      ![...sourceControls.values()].some((control) => !control.hidden);
    for (const details of detailRows.values())
      details.row.hidden = !details.notes && details.control.hidden;
  };
  const sourceControl = (row: GismuRowState) => {
    const key = sourceRowKey(row);
    const label = `Suggest source for ${row.name || row.language}`;
    let control = sourceControls.get(key);
    if (control && control.dataset.sourceLabel !== label) {
      control.dispatchEvent(new Event("assist-dispose"));
      sourceObservers.get(key)?.disconnect();
      sourceObservers.delete(key);
      sourceControls.delete(key);
      control.remove();
      control = undefined;
    }
    if (!control) {
      const id = row.id!;
      control = assistanceAction(app, draft, saver, context, {
        key,
        label,
        operation: "gismu-sources",
        current: () => sourceCurrent(draft, id),
        apply: (d, r) => applySource(d, id, r),
        sourceRow: () => state.rows.find((current) => current.id === id),
      });
      control.dataset.sourceLabel = label;
      sourceControls.set(key, control);
      const observer = new MutationObserver(syncSourceVisibility);
      observer.observe(control, {
        attributes: true,
        attributeFilter: ["hidden"],
      });
      sourceObservers.set(key, observer);
    }
    return control;
  };
  const renameManualLabels = (
    container: HTMLElement,
    before: string,
    after: string,
  ) => {
    const suffix = ` for ${before}`;
    for (const node of container.querySelectorAll<HTMLElement>(
      "[aria-label]",
    )) {
      if (node.closest(".ai-action")) continue;
      const label = node.getAttribute("aria-label")!;
      if (label.endsWith(suffix))
        node.setAttribute(
          "aria-label",
          `${label.slice(0, -suffix.length)} for ${after}`,
        );
    }
    for (const label of container.querySelectorAll("label"))
      if (label.textContent === `Source notes for ${before}`)
        label.textContent = `Source notes for ${after}`;
  };
  let bulkRunning = false;
  const fillSources = button(
    el("span", {}, text("AI", "ai-tag"), text(" Suggest source words")),
    async () => {
      if (bulkRunning) return;
      bulkRunning = true;
      fillSources.setAttribute("aria-disabled", "true");
      try {
        for (const control of [...sourceControls.values()]) {
          if (!context.live() || !visibility.enabled || !control.isConnected)
            break;
          if (!(await runAssistance(control))) break;
        }
      } finally {
        bulkRunning = false;
        fillSources.removeAttribute("aria-disabled");
        if (document.activeElement === document.body && context.live())
          fillSources.focus();
      }
    },
    { class: "btn btn-quiet", "aria-label": "Suggest source words" },
  );
  sourceActions.append(fillSources);
  sourceActions.hidden = true;
  section.append(presetNote, rowsBox, rowButtons, sourceActions);
  const recipeField = field("Candidate letters", {
    value: state.candidates,
    options: [
      {
        value: "source-letters",
        label: "Letters of the scoring inputs, as CLL 4.14 describes",
      },
      { value: "all-letters", label: "Every Lojban consonant and vowel" },
    ],
    labelClass: "meta",
  });
  recipeField.input.addEventListener("change", () => {
    state.candidates = recipeField.input.value as
      | "source-letters"
      | "all-letters";
    saver.touch();
    schedule();
  });
  section.append(recipeField.wrapper);
  const candidatesHead = el("h2", { class: "section", text: "Candidates" });
  const status = el("p", { class: "small", "aria-live": "polite" });
  const candidatesBox = el("div", {
    class: "table-scroll",
    tabindex: "0",
    role: "region",
    "aria-label": "Candidates",
  });
  const more = el("p", { class: "meta", style: "margin-top:8px" });
  section.append(candidatesHead, status, candidatesBox, more);
  const manualField = field("Type a form yourself", {
    value: state.manual,
    spellcheck: false,
    lang: "jbo",
    hint: "A manual form is scored under the same run. Outside the generated letters it has no rank. Without a run it carries no generation evidence.",
  });
  manualField.input.addEventListener("input", () => {
    if (state.manual !== manualField.input.value) {
      state.acknowledged = [];
      draft.publishAcknowledged = [];
    }
    state.manual = manualField.input.value;
    saver.touch();
    schedule();
  });
  const manualNote = el("p", { class: "meta", role: "status" });
  section.append(manualField.wrapper, manualNote);
  // Right column: the selected form.
  const aside = el("aside", { class: "side-col", style: "flex-basis:280px" });
  const selectedCard = el("div", {
    class: "card",
    "aria-live": "polite",
    role: "region",
    "aria-label": "Selected form",
  });
  aside.append(selectedCard);
  columns.append(section, aside);
  main.append(columns);
  let result: GismuResult | null = null;
  let resultFingerprint: string | null = null;
  let failure: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Native words, notes, and pronunciation do not affect the scores.
  const generationFingerprint = () =>
    JSON.stringify({
      preset: state.preset,
      sources: state.rows.map((row) => ({
        language: row.language.trim(),
        input: row.input,
        weight: row.weight,
      })),
      candidates: state.candidates,
      window: Math.max(state.window, 32),
      manual: state.manual.trim() || null,
      inventory,
      limits: { work: 60_000_000 },
    });
  context.signal.addEventListener("abort", () => clearTimeout(timer), {
    once: true,
  });
  const pendingLetters = () =>
    state.rows.some((row) =>
      sourceReviewMarks(row).some((mark) => mark.field === "input"),
    );
  const lettersReviewMessage =
    "Keep or clear the retained Letters before the generator runs.";
  const complete = () =>
    state.rows.length > 0 &&
    state.rows.every((r) => r.input.trim() && r.weight && r.language.trim());
  const renderRows = () => {
    cleanupRows();
    const activeKeys = new Set(state.rows.map(sourceRowKey));
    for (const [key, control] of sourceControls)
      if (!activeKeys.has(key)) {
        control.dispatchEvent(new Event("assist-dispose"));
        sourceObservers.get(key)?.disconnect();
        sourceObservers.delete(key);
        sourceControls.delete(key);
        control.remove();
      }
    if (draft.ai) {
      const kept = draft.ai.records.filter(
        (record) =>
          !record.key.startsWith("source-") || activeKeys.has(record.key),
      );
      if (kept.length !== draft.ai.records.length) {
        draft.ai.records = kept;
        retainAssistance(draft);
        saver.touch();
      }
    }
    detailRows.clear();
    const preset = presets.find((pr) => pr.id === state.preset) ?? null;
    presetNote.replaceChildren();
    if (preset) {
      presetNote.append(
        text(`${preset.description} Source: `),
        link(preset.source_url, preset.source_url, {
          class: "touch-link",
          rel: "noreferrer",
        }),
      );
      if (preset.reference_url)
        presetNote.append(
          text(" · reference: "),
          link(preset.reference_url, preset.reference_url, {
            class: "touch-link",
            rel: "noreferrer",
          }),
        );
      presetNote.append(
        text(
          ` New runs normalize the positive weights by their sum (normalize-positive-sum-v1) and aggregate alternatives by maximum per language.`,
        ),
      );
    } else
      presetNote.append(
        text(
          "Custom languages and weights. Enter nonnegative weights as fractions. At least one weight must be positive.",
        ),
      );
    rowsBox.replaceChildren();
    const table = el("table", { class: "small source-table" });
    table.append(
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", { scope: "col", text: "Language" }),
          el("th", { scope: "col", class: "right", text: "Weight" }),
          el("th", { scope: "col", text: "Word" }),
          el("th", { scope: "col", text: "Said" }),
          el("th", { scope: "col", text: "Stem" }),
          el("th", { scope: "col", text: "Stem said" }),
          el("th", { scope: "col", text: "Letters" }),
        ),
      ),
    );
    const tbody = el("tbody");
    state.rows.forEach((row, index) => {
      const sourceKey = sourceRowKey(row);
      const marked = (field: "input" | "word_ipa" | "stem" | "ipa") =>
        sourceReviewMarks(row).some((mark) => mark.field === field);
      const tr = el("tr");
      const languageCell = el("td");
      if (preset)
        languageCell.append(
          text(row.name || row.language),
          text(` ${row.language}`, "meta"),
        );
      else {
        const code = el("input", {
          class: "field",
          "aria-label": `Language tag of row ${index + 1}`,
          value: row.language,
          style: "width:6rem;",
        });
        code.addEventListener("change", () => {
          const previousName = row.name || row.language;
          row.language = code.value.trim();
          row.name = row.language;
          code.value = row.language;
          renameManualLabels(tr, previousName, row.name);
          const details = detailRows.get(sourceKey);
          if (details) {
            renameManualLabels(details.row, previousName, row.name);
            details.control = sourceControl(row);
            details.row.firstElementChild?.append(details.control);
          }
          syncSourceVisibility();
          saveSources();
          schedule();
        });
        languageCell.append(code);
      }
      const weightCell = el("td", { class: "right num" });
      if (preset) {
        const normalized = result?.languages.find(
          (l) => l.language === row.language,
        )?.normalized;
        weightCell.append(
          text(
            row.weight
              ? `${row.weight.numerator}/${row.weight.denominator}`
              : "none",
          ),
        );
        if (normalized)
          weightCell.append(text(` → ${decimal(normalized, 3)}`, "meta"));
      } else {
        const n = el("input", {
          class: "field",
          "aria-label": `Weight numerator of row ${index + 1}`,
          value: row.weight?.numerator ?? "",
          inputmode: "numeric",
          style: "width:4rem;",
        });
        const d = el("input", {
          class: "field",
          "aria-label": `Weight denominator of row ${index + 1}`,
          value: row.weight?.denominator ?? "1",
          inputmode: "numeric",
          style: "width:4rem;",
        });
        const update = () => {
          const numerator = n.value.trim();
          const denominator = d.value.trim() || "1";
          row.weight =
            /^\d+$/.test(numerator) && /^[1-9]\d*$/.test(denominator)
              ? { numerator, denominator }
              : null;
          saveSources();
          schedule();
        };
        n.addEventListener("change", update);
        d.addEventListener("change", update);
        weightCell.append(n, text(" / "), d);
      }
      const nativeCell = el("td", { class: "native" });
      const staleNotes = p(
        "The source word changed. Review the source notes.",
        "meta",
      );
      staleNotes.hidden = !row.notesStale;
      const native = el("input", {
        class: "field",
        "aria-label": `Native word for ${row.name || row.language}`,
        value: row.word,
        style: "min-width:8rem;",
      });
      native.addEventListener("input", () => {
        if (row.word !== native.value && sourceNotes(row).length) {
          row.notesStale = true;
          staleNotes.hidden = false;
        }
        row.word = native.value;
        saveSources();
      });
      nativeCell.append(native);
      const inputCell = el("td");
      const input = el("input", {
        class: "field",
        "aria-label": `Scoring letters for ${row.name || row.language}`,
        value: row.input,
        readonly: marked("input"),
        spellcheck: "false",
        lang: "jbo",
        style: "width:9rem;",
      });
      input.addEventListener("input", () => {
        if (marked("input")) return;
        row.input = input.value;
        delete row.inputOriginal;
        saveSources();
        schedule();
      });
      inputCell.append(input);
      if (row.inputOriginal?.format === "ipa") {
        inputCell.append(
          p(
            "IPA conversion is unavailable. The original input stays unchanged.",
            "meta",
          ),
          el("bdi", {
            "aria-label": `Original IPA input for ${row.name || row.language}`,
            text: row.inputOriginal.text,
            style: "white-space:pre-wrap",
          }),
        );
        input.disabled = true;
        inputCell.append(
          button(
            "Replace IPA input with scoring letters",
            () => {
              if (marked("input")) return;
              if (
                !confirm(
                  "Replace the original IPA input with scoring letters? The original input will be removed from this source row.",
                )
              )
                return;
              delete row.inputOriginal;
              saveSources();
              renderRows();
            },
            {
              class: "btn btn-quiet small",
              disabled: marked("input"),
              "aria-label": `Replace IPA input for ${row.name || row.language}`,
            },
          ),
        );
      }
      const tools = el("div", { class: "actions" });
      tools.append(
        button(
          "Alternative",
          () => {
            state.rows.splice(index + 1, 0, alternativeSourceRow(row));
            saveSources();
            renderRows();
            schedule();
          },
          {
            class: "btn btn-quiet",
            "aria-label": `Add an alternative word for ${row.name || row.language}`,
            title:
              "Another source word of the same language. It shares the weight and contributes its largest recognition.",
          },
        ),
        button(
          "Notes",
          () => {
            notesEditing.add(sourceKey);
            renderRows();
            detailRows.get(sourceKey)?.row.querySelector("textarea")?.focus();
          },
          {
            class: "btn btn-quiet",
            "aria-label": `Edit source notes for ${row.name || row.language}`,
          },
        ),
        button(
          icon("close", "", 16),
          () => {
            state.rows.splice(index, 1);
            saveSources();
            renderRows();
            schedule();
          },
          {
            class: "btn btn-quiet btn-icon",
            "aria-label": `Remove row ${index + 1}`,
          },
        ),
      );
      const detailCell = (label: string, key: "word_ipa" | "stem" | "ipa") => {
        const input = el("input", {
          class: "field",
          "aria-label": `${label} for ${row.name || row.language}`,
          value: row[key] ?? "",
          readonly: marked(key),
          style: "width:8rem;min-height:36px",
        });
        input.addEventListener("input", () => {
          if (marked(key)) return;
          row[key] = input.value || null;
          if (key === "word_ipa") delete row.wordIpaNullOriginal;
          saveSources();
        });
        return el("td", {}, input);
      };
      tr.append(
        languageCell,
        weightCell,
        nativeCell,
        detailCell("Said", "word_ipa"),
        detailCell("Stem", "stem"),
        detailCell("Stem said", "ipa"),
        inputCell,
      );
      tbody.append(tr);
      const control = sourceControl(row);
      const details = el("td", { colspan: "7" });
      tbody.append(el("tr", {}, el("td", { colspan: "7" }, tools)));
      const showNotes =
        sourceNotes(row).length > 0 || notesEditing.has(sourceKey);
      if (showNotes) {
        const notes = field(`Source notes for ${row.name || row.language}`, {
          multiline: true,
          rows: 4,
          value: richTextToText(sourceNotes(row)),
          hint: "Review all source notes. Edit the text or drop the notes before publication.",
        });
        notes.input.addEventListener("input", () => {
          editSourceNotes(row, textToRichText(notes.input.value, false));
          row.sense = "";
          row.note = "";
          row.notesStale = false;
          staleNotes.hidden = true;
          saveSources();
        });
        details.append(
          notes.wrapper,
          staleNotes,
          button(
            "Drop source notes",
            () => {
              editSourceNotes(row, []);
              row.sense = "";
              row.note = "";
              row.notesStale = false;
              notesEditing.delete(sourceKey);
              saveSources();
              renderRows();
            },
            {
              class: "btn btn-quiet",
              "aria-label": `Drop source notes for ${row.name || row.language}`,
            },
          ),
        );
        const aiRecord = draft.ai?.records.findLast(
          (r) => r.key === sourceKey && r.state === "accepted",
        );
        if (aiRecord) {
          const logButton = button(
            "How the assistant decided",
            () => inferenceLog(aiRecord, draft),
            {
              class: "btn btn-quiet small",
            },
          );
          const unsubscribe = visibility.bind(logButton);
          rowCleanups.push(unsubscribe);
          details.append(logButton);
        }
      }
      const review = sourceReviewMarks(row);
      if (review.length) {
        const reviewBox = el("section", {
          class: "notice source-review",
          "aria-label": `Retained source evidence for ${row.name || row.language}`,
        });
        reviewBox.append(
          p(
            "The source word changed. Keep or clear each retained value before publication.",
            "small",
          ),
        );
        const labels = {
          word_ipa: "Said",
          stem: "Stem",
          ipa: "Stem said",
          input: "Letters",
          notes: "Notes paragraph",
        };
        review.forEach((mark, markIndex) => {
          const label = `${labels[mark.field]}${mark.field === "notes" ? ` ${(mark.index ?? 0) + 1}` : ""}`;
          const value =
            mark.field === "notes"
              ? richTextToText([mark.value as RichText[number]])
              : typeof mark.value === "string"
                ? mark.value
                : JSON.stringify(mark.value);
          const line = el(
            "div",
            { class: "source-review-item" },
            p(`${label}: earlier word "${mark.word}"`, "meta"),
            el("pre", { text: value }),
          );
          for (const choice of ["keep", "clear"] as const)
            line.append(
              button(
                choice === "keep" ? "Keep" : "Clear",
                () => {
                  resolveSourceReview(row, markIndex, choice);
                  saveSources();
                  renderRows();
                  schedule();
                },
                {
                  class: "btn btn-quiet",
                  "aria-label": `${choice === "keep" ? "Keep" : "Clear"} ${label} for ${row.name || row.language}`,
                },
              ),
            );
          reviewBox.append(line);
        });
        details.append(reviewBox);
      }
      details.append(control);
      const detailRow = el("tr", { class: "source-row-details" }, details);
      detailRows.set(sourceKey, {
        row: detailRow,
        notes: showNotes || review.length > 0,
        control,
      });
      tbody.append(detailRow);
    });
    table.append(tbody);
    rowsBox.append(table);
    rowButtons.replaceChildren();
    if (!preset)
      rowButtons.append(
        button(
          "Add a language",
          () => {
            state.rows.push({
              id: sourceRowId(),
              language: "",
              name: "",
              word: "",
              aiNoteGroup: [],
              input: "",
              weight: { numerator: "1", denominator: "1" },
            });
            saveSources();
            renderRows();
            schedule();
          },
          { class: "btn btn-quiet" },
        ),
      );
    rowButtons.append(
      p(
        "Zero-weight rows stay visible and contribute nothing. An unfinished row gets no invented word or weight, and the generator waits for it.",
        "meta",
      ),
    );
    syncSourceVisibility();
  };
  const chosen = (): GismuCandidate | null => {
    if (!result) return null;
    if (state.selected) {
      const found =
        result.candidates.find((c) => c.form === state.selected) ??
        (result.manual?.form === state.selected ? result.manual : null);
      if (found) return found;
    }
    return null;
  };
  const conflictKey = (
    candidate: GismuCandidate,
    c: { word: string; rule: string },
  ) => rootConflictKey(candidate.form, c, inventory.snapshot);
  const renderCandidates = () => {
    candidatesBox.replaceChildren();
    more.replaceChildren();
    candidatesHead.replaceChildren(text("Candidates"));
    if (pendingLetters()) {
      status.textContent = lettersReviewMessage;
      return;
    }
    if (failure) {
      status.textContent = failure;
      return;
    }
    if (!result) {
      status.textContent = complete()
        ? "Calculating…"
        : "Fill in every scoring input before the generator runs.";
      return;
    }
    status.textContent = `${result.considered} candidate forms were scored completely. Equal scores share a rank. Generation rank never becomes editorial rank.`;
    candidatesHead.append(
      text(
        ` ${Math.min(state.window, result.candidates.length)} of ${result.considered}`,
        "meta",
      ),
    );
    const table = el("table", { class: "small", style: "min-width:460px" });
    table.append(
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", { scope: "col", text: "Rank" }),
          el("th", { scope: "col", text: "Form" }),
          el("th", { scope: "col", class: "right", text: "Score" }),
          el("th", { scope: "col", text: "Conflicts" }),
          el("th", { scope: "col", text: "" }),
        ),
      ),
    );
    const tbody = el("tbody");
    const rowFor = (candidate: GismuCandidate, manual: boolean) => {
      const tr = el("tr", {
        style:
          candidate.form === state.selected
            ? "background:var(--accent-soft)"
            : undefined,
      });
      const conflicts = el("td");
      for (const c of candidate.conflicts)
        conflicts.append(
          el("span", {
            class: "warn",
            text:
              c.rule === "identical"
                ? `identical to ${c.spelling}`
                : c.rule === "final-vowel"
                  ? `last vowel: ${c.spelling}`
                  : `too close to ${c.spelling}`,
          }),
          text(" "),
        );
      if (candidate.rafsi_conflicts.length)
        conflicts.append(
          text(
            `rafsi ${[...new Set(candidate.rafsi_conflicts.map((r) => r.rafsi))].join(", ")} claimed`,
            "meta",
          ),
        );
      tr.append(
        el("td", {
          class: "meta",
          text:
            candidate.rank === null
              ? manual
                ? "no rank"
                : ""
              : String(candidate.rank),
        }),
        el("td", {
          lang: "jbo",
          style: "font-weight:650",
          text: candidate.form,
        }),
        el("td", {
          class: "right num",
          title: `${candidate.score.numerator}/${candidate.score.denominator}`,
          text: decimal(candidate.score),
        }),
        conflicts,
        el(
          "td",
          { class: "right" },
          candidate.form === state.selected
            ? text("chosen", "meta")
            : button(
                "Choose",
                () => {
                  if (state.selected !== candidate.form) {
                    state.acknowledged = [];
                    draft.publishAcknowledged = [];
                  }
                  state.selected = candidate.form;
                  saver.touch();
                  renderCandidates();
                  renderSelected();
                },
                {
                  class: "btn btn-quiet",
                  "aria-label": `Choose ${candidate.form}`,
                },
              ),
        ),
      );
      return tr;
    };
    for (const candidate of result.candidates.slice(0, state.window))
      tbody.append(rowFor(candidate, false));
    if (
      result.manual &&
      !result.candidates
        .slice(0, state.window)
        .some((c) => c.form === result!.manual!.form)
    )
      tbody.append(rowFor(result.manual, true));
    table.append(tbody);
    candidatesBox.append(table);
    if (result.candidates.length > state.window)
      more.append(
        button(
          "More candidates",
          () => {
            state.window = Math.min(512, state.window + 12);
            saver.touch();
            schedule();
          },
          { class: "btn btn-quiet" },
        ),
      );
    for (const line of result.diagnostics) more.append(p(line, "meta"));
  };
  const renderSelected = () => {
    selectedCard.replaceChildren();
    const candidate = chosen();
    if (!candidate) {
      selectedCard.append(
        p("No form chosen yet. Choose a candidate or type a form.", "small"),
      );
      refreshPrimary();
      return;
    }
    selectedCard.append(
      el("h2", {
        id: "sel-h",
        lang: "jbo",
        class: "builder-form",
        text: candidate.form,
      }),
    );
    selectedCard.append(
      p(
        `${decimal(candidate.score)} (exactly ${candidate.score.numerator}/${candidate.score.denominator}) · ${candidate.rank === null ? "no rank: outside the generated letters" : `rank ${candidate.rank} of ${result?.considered ?? "?"}`}`,
        "meta",
      ),
    );
    const list = el("ul", {
      style:
        "list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;font-size:14px",
      "aria-label": "Contributions by language",
    });
    for (const contribution of candidate.contributions) {
      const language = result?.languages.find(
        (l) => l.language === contribution.language,
      );
      const normalized = language ? decimal(language.normalized, 3) : "?";
      const weighted = decimal(contribution.weighted, 3);
      const share =
        language && Number(language.normalized.numerator)
          ? Number(contribution.weighted.numerator) /
            Number(contribution.weighted.denominator) /
            (Number(language.normalized.numerator) /
              Number(language.normalized.denominator))
          : 0;
      const item = el("li");
      item.append(
        el(
          "div",
          { style: "display:flex;justify-content:space-between;gap:8px" },
          el(
            "span",
            {},
            text(
              `${state.rows.find((r) => r.language === contribution.language)?.name || contribution.language} `,
            ),
            text(contribution.input, "meta"),
          ),
          el("span", { class: "num", text: `${weighted} of ${normalized}` }),
        ),
        el(
          "div",
          {
            "aria-hidden": "true",
            style: "height:5px;border-radius:3px;background:var(--sunk)",
          },
          el("div", {
            style: `width:${Math.round(Math.min(1, share) * 100)}%;height:5px;border-radius:3px;background:var(--accent)`,
          }),
        ),
        p(
          `${contribution.matched} of ${contribution.length} letters recognized`,
          "meta",
        ),
      );
      list.append(item);
    }
    selectedCard.append(list);
    selectedCard.append(
      p(
        `Possible short rafsi: ${candidate.short_rafsi.join(", ") || "none"}. A possible rafsi is not an assigned rafsi. Claims are separate signed actions.`,
        "meta",
      ),
    );
    if (inventory.snapshot)
      selectedCard.append(
        p(
          `Root inventory: local package of snapshot ${inventory.snapshot.slice(7, 19)}….`,
          "meta",
        ),
      );
    const coverage = inventoryCoverage(inventory);
    selectedCard.append(p(coverage, "meta"));
    if (candidate.conflicts.length) {
      const box = el("div", {
        class: "notice",
        role: "group",
        "aria-label": "Root conflicts",
      });
      box.append(
        p(
          "Known root conflicts. Acknowledge each one to keep this form. A refreshed snapshot clears the acknowledgment.",
          "small",
        ),
      );
      for (const conflict of candidate.conflicts) {
        const key = conflictKey(candidate, conflict);
        const input = el("input", { type: "checkbox" });
        input.checked = state.acknowledged.includes(key);
        input.addEventListener("change", () => {
          state.acknowledged = input.checked
            ? [...new Set([...state.acknowledged, key])]
            : state.acknowledged.filter((k) => k !== key);
          saver.touch();
          refreshPrimary();
        });
        box.append(
          el(
            "label",
            { class: "check" },
            input,
            el(
              "span",
              { class: "acknowledgment-text" },
              text(
                `${conflict.rule === "identical" ? "identical to" : conflict.rule === "final-vowel" ? "differs only in the last vowel from" : "too close to"} `,
              ),
              link(
                conflict.spelling,
                `/word/${encodeURIComponent(conflict.spelling)}`,
                { lang: "jbo", class: "touch-link" },
              ),
              text(` (${conflict.rule}). I keep this form.`),
            ),
          ),
        );
      }
      selectedCard.append(box);
    }
    if (candidate.rafsi_conflicts.length) {
      const list2 = el("ul", { class: "small" });
      for (const r of candidate.rafsi_conflicts)
        list2.append(
          el(
            "li",
            {},
            text(`${r.rafsi} is claimed by `),
            link(r.spelling, `/word/${encodeURIComponent(r.spelling)}`, {
              lang: "jbo",
              class: "touch-link",
            }),
          ),
        );
      selectedCard.append(
        p(
          "Competing rafsi claims for the possible short rafsi, across every word type:",
          "small",
        ),
        list2,
      );
    }
    const reason = field("Why this form", {
      multiline: true,
      rows: 2,
      value: state.reason,
      hint: "Optional. Pronunciation, a preferred rafsi, or another reason. Saved as the selection reason.",
    });
    reason.input.addEventListener("input", () => {
      state.reason = reason.input.value;
      saver.touch();
    });
    selectedCard.append(reason.wrapper);
    refreshPrimary();
  };
  const run = () => {
    if (!context.live()) return;
    clearTimeout(timer);
    timer = undefined;
    failure = null;
    if (pendingLetters()) {
      renderCandidates();
      if (!result) renderSelected();
      else refreshPrimary();
      return;
    }
    result = null;
    resultFingerprint = null;
    if (!complete()) {
      renderCandidates();
      renderSelected();
      return;
    }
    try {
      const fingerprint = generationFingerprint();
      result = generateGismu({
        sources: state.rows.map((r) => ({
          language: r.language.trim(),
          word: r.word,
          input: r.input,
          weight: r.weight,
        })),
        candidates: state.candidates,
        inventory: {
          snapshot: inventory.snapshot,
          gismu: inventory.gismu,
          claims: inventory.claims,
        },
        window: Math.max(state.window, 32),
        manual: state.manual.trim() || null,
        limits: { work: 60_000_000 },
      });
      resultFingerprint = fingerprint;
    } catch (error) {
      failure =
        error instanceof BuilderError
          ? `The generator stopped: ${error.message}`
          : describe(error);
    }
    if (result && state.selected && !chosen()) state.selected = null;
    renderRows();
    renderCandidates();
    renderSelected();
  };
  const schedule = () => {
    clearTimeout(timer);
    failure = null;
    status.textContent = pendingLetters()
      ? lettersReviewMessage
      : "Calculating…";
    refreshPrimary();
    timer = setTimeout(run, 250);
  };
  let bar: HTMLElement;
  const unacknowledged = (candidate: GismuCandidate) =>
    candidate.conflicts.filter(
      (c) => !state.acknowledged.includes(conflictKey(candidate, c)),
    );
  /**
   * The form to use: the chosen candidate, or the manual form as the run
   * scored it. A manual form that no run checked has unknown conflicts and
   * cannot be used from here.
   */
  const usable = (): {
    candidate: GismuCandidate | null;
    reason: string;
  } => {
    if (pendingLetters())
      return {
        candidate: null,
        reason: lettersReviewMessage,
      };
    if (result && resultFingerprint !== generationFingerprint())
      return {
        candidate: null,
        reason: "Wait for the current scoring inputs to be checked.",
      };
    const candidate = chosen();
    if (candidate) return { candidate, reason: "" };
    const manual = state.manual.trim();
    if (!manual) return { candidate: null, reason: "" };
    if (result?.manual?.form === manual)
      return { candidate: result.manual, reason: "" };
    return {
      candidate: null,
      reason:
        "The manual form is checked for conflicts under the run. Complete the source rows so the run can score it, or use Enter without generation.",
    };
  };
  const refreshPrimary = () => {
    const primary = bar?.querySelector<HTMLButtonElement>(".btn-primary");
    if (!primary) return;
    const { candidate, reason } = usable();
    primary.textContent = `Use ${candidate?.form ?? (state.manual.trim() || "this form")}`;
    primary.disabled = !candidate || unacknowledged(candidate).length > 0;
    primary.title = candidate
      ? unacknowledged(candidate).length
        ? "Acknowledge every known conflict first, or choose another form."
        : ""
      : reason;
    manualNote.textContent = reason;
  };
  bar = actionBar(saver, {
    back: { label: "Back", href: "/new/type" },
    extra: [
      link("Enter without generation", "/new/form?manual=1", {
        class: "btn btn-quiet",
      }),
    ],
    primary: {
      label: "Use this form",
      disabled: true,
      action: async () => {
        if (!result || resultFingerprint !== generationFingerprint()) {
          schedule();
          return;
        }
        const { candidate } = usable();
        if (candidate && result) {
          if (unacknowledged(candidate).length) return;
          if (
            draft.compound &&
            !confirm(
              "Use this gismu and remove the previous compound evidence? The prose and annotations stay.",
            )
          )
            return;
          draft.compound = null;
          if (draft.spelling !== candidate.form) draft.publishAcknowledged = [];
          draft.spelling = candidate.form;
          draft.evidenceForm = candidate.form;
          const preset = presets.find((pr) => pr.id === state.preset) ?? null;
          draft.formation = formationMetadata({
            result,
            candidate,
            rows: state.rows,
            preset,
            acknowledged: candidate.conflicts
              .filter((c) =>
                state.acknowledged.includes(conflictKey(candidate, c)),
              )
              .map((c) => ({
                word: c.word,
                rule: c.rule as
                  | "identical"
                  | "final-vowel"
                  | "similar-consonant",
                snapshot: inventory.snapshot ?? "",
              }))
              .filter((c) => c.snapshot),
            reason: state.reason,
          });
        } else return;
        draft.step = Math.max(draft.step, 4) as Draft["step"];
        if (!(await saver.flush())) return;
        navigate("/new/places");
      },
    },
  });
  main.append(bar);
  const unsubscribeSources = visibility.subscribe(syncSourceVisibility);
  context.signal.addEventListener("abort", unsubscribeSources, { once: true });
  renderRows();
  run();
}
