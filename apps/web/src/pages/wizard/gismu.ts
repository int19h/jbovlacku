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
import type { CachedPackage } from "../../data/search.ts";
import {
  cachedPackage,
  decimal,
  formationMetadata,
  inventoryFromPackage,
  manualFormation,
  newGismuState,
  type GismuRowState,
  type PackageInventory,
} from "../../model/builders.ts";
import { actionBar, DraftSaver, loadDraft, stepBar } from "./common.ts";

function presetRows(
  preset: BuilderPreset,
  previous: GismuRowState[],
): GismuRowState[] {
  return preset.languages.map((language) => {
    const old = previous.find((r) => r.language === language.language);
    return {
      language: language.language,
      name: language.name,
      word: old?.word ?? "",
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
    draft.kind = "gismu";
    saver.touch();
  }
  const state = (draft.gismu ??= newGismuState());
  const presets = builderPresets();
  if (state.preset === null && !state.rows.length) {
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
  presetField.input.style.minHeight = "40px";
  presetField.input.addEventListener("change", () => {
    const chosen =
      presets.find((pr) => pr.id === presetField.input.value) ?? null;
    state.preset = chosen?.id ?? null;
    if (chosen) state.rows = presetRows(chosen, state.rows);
    state.acknowledged = [];
    saver.touch();
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
  section.append(
    presetNote,
    rowsBox,
    rowButtons,
    p(
      "Source word suggestions by AI are not configured on this server.",
      "meta",
    ),
  );
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
  let failure: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const complete = () =>
    state.rows.length > 0 &&
    state.rows.every((r) => r.input.trim() && r.weight && r.language.trim());
  const renderRows = () => {
    const preset = presets.find((pr) => pr.id === state.preset) ?? null;
    presetNote.replaceChildren();
    if (preset) {
      presetNote.append(
        text(`${preset.description} Source: `),
        link(preset.source_url, preset.source_url, { rel: "noreferrer" }),
      );
      if (preset.reference_url)
        presetNote.append(
          text(" · reference: "),
          link(preset.reference_url, preset.reference_url, {
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
    const table = el("table", { class: "small", style: "min-width:680px" });
    table.append(
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", { scope: "col", text: "Language" }),
          el("th", { scope: "col", class: "right", text: "Weight" }),
          el("th", { scope: "col", text: "Native word" }),
          el("th", { scope: "col", text: "Scoring letters" }),
          el("th", { scope: "col", text: "" }),
        ),
      ),
    );
    const tbody = el("tbody");
    state.rows.forEach((row, index) => {
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
          style: "width:6rem;min-height:36px",
        });
        code.addEventListener("change", () => {
          row.language = code.value.trim();
          row.name = row.language;
          saver.touch();
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
          style: "width:4rem;min-height:36px",
        });
        const d = el("input", {
          class: "field",
          "aria-label": `Weight denominator of row ${index + 1}`,
          value: row.weight?.denominator ?? "1",
          inputmode: "numeric",
          style: "width:4rem;min-height:36px",
        });
        const update = () => {
          const numerator = n.value.trim();
          const denominator = d.value.trim() || "1";
          row.weight =
            /^\d+$/.test(numerator) && /^[1-9]\d*$/.test(denominator)
              ? { numerator, denominator }
              : null;
          saver.touch();
          schedule();
        };
        n.addEventListener("change", update);
        d.addEventListener("change", update);
        weightCell.append(n, text(" / "), d);
      }
      const nativeCell = el("td", { class: "native" });
      const native = el("input", {
        class: "field",
        "aria-label": `Native word for ${row.name || row.language}`,
        value: row.word,
        style: "min-width:8rem;min-height:36px",
      });
      native.addEventListener("input", () => {
        row.word = native.value;
        saver.touch();
      });
      nativeCell.append(native);
      const inputCell = el("td");
      const input = el("input", {
        class: "field",
        "aria-label": `Scoring letters for ${row.name || row.language}`,
        value: row.input,
        spellcheck: "false",
        lang: "jbo",
        style: "width:9rem;min-height:36px",
      });
      input.addEventListener("input", () => {
        row.input = input.value;
        saver.touch();
        schedule();
      });
      inputCell.append(input);
      const tools = el("td", { class: "right", style: "white-space:nowrap" });
      tools.append(
        button(
          "Alternative",
          () => {
            state.rows.splice(index + 1, 0, { ...row, word: "", input: "" });
            saver.touch();
            renderRows();
          },
          {
            class: "btn btn-quiet",
            style: "min-height:36px",
            "aria-label": `Add an alternative word for ${row.name || row.language}`,
            title:
              "Another source word of the same language. It shares the weight and contributes its largest recognition.",
          },
        ),
        button(
          icon("close", "", 16),
          () => {
            state.rows.splice(index, 1);
            saver.touch();
            renderRows();
            schedule();
          },
          {
            class: "btn btn-quiet btn-icon",
            "aria-label": `Remove row ${index + 1}`,
          },
        ),
      );
      tr.append(languageCell, weightCell, nativeCell, inputCell, tools);
      tbody.append(tr);
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
              language: "",
              name: "",
              word: "",
              input: "",
              weight: { numerator: "1", denominator: "1" },
            });
            saver.touch();
            renderRows();
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
  const conflictKey = (c: { word: string; rule: string }) =>
    `${c.word}|${c.rule}|${inventory.snapshot ?? "none"}`;
  const renderCandidates = () => {
    candidatesBox.replaceChildren();
    more.replaceChildren();
    candidatesHead.replaceChildren(text("Candidates"));
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
                  state.selected = candidate.form;
                  saver.touch();
                  renderCandidates();
                  renderSelected();
                },
                {
                  class: "btn btn-quiet",
                  style: "min-height:36px",
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
          { class: "btn btn-quiet", style: "min-height:36px" },
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
        style:
          "margin:0;font-size:40px;line-height:1.1;font-weight:680;letter-spacing:-0.02em",
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
    const coverage = inventory.snapshot
      ? `Conflicts come from the local package of snapshot ${inventory.snapshot.slice(7, 19)}…${inventory.hasClaims ? "" : ", which carries no rafsi claims"}.`
      : "No local package is downloaded, so conflict coverage is unknown.";
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
        const key = conflictKey(conflict);
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
            text(
              ` ${conflict.rule === "identical" ? "identical to" : conflict.rule === "final-vowel" ? "differs only in the last vowel from" : "too close to"} `,
            ),
            link(
              conflict.spelling,
              `/word/${encodeURIComponent(conflict.spelling)}`,
              { lang: "jbo" },
            ),
            text(` (${conflict.rule}). I keep this form.`),
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
    failure = null;
    result = null;
    if (!complete()) {
      renderCandidates();
      renderSelected();
      return;
    }
    try {
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
    status.textContent = complete() ? "Calculating…" : status.textContent;
    timer = setTimeout(run, 250);
  };
  let bar: HTMLElement;
  const unacknowledged = (candidate: GismuCandidate) =>
    candidate.conflicts.filter(
      (c) => !state.acknowledged.includes(conflictKey(c)),
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
        const { candidate } = usable();
        if (candidate && result) {
          if (unacknowledged(candidate).length) return;
          draft.spelling = candidate.form;
          draft.evidenceForm = candidate.form;
          const preset = presets.find((pr) => pr.id === state.preset) ?? null;
          draft.formation = formationMetadata({
            result,
            candidate,
            rows: state.rows,
            preset,
            acknowledged: candidate.conflicts
              .filter((c) => state.acknowledged.includes(conflictKey(c)))
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
  renderRows();
  run();
}
