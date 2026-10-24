import {
  detectWord,
  typedWord,
  typedLujvoState,
  linkedSources,
  typedLujvoRequest,
  sourceOptions,
} from "../../model/typed-headword.ts";
import { currentDraft } from "../../model/assistance.ts";
import { assistanceAction } from "../../components/assistance.ts";
/**
 * Step 3A: the lujvo builder. Ordered component rows with rafsi choices and
 * locks, the scored candidates of the shared morphology core, recovered parts,
 * complete rafsi conflicts from the local package, and the preserved meaning.
 */
import {
  analyzeWord,
  morphologyProfile,
  buildLujvo,
  BuilderError,
  rafsiPairId,
  wordId,
  type LujvoCandidate,
  type LujvoResult,
  type MorphologyProfile,
} from "../../../../../packages/core/src/browser.ts";
import {
  el,
  inlineProse,
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
import { getWord, RequestError } from "../../data/api.ts";
import type { Draft } from "../../model/draft.ts";
import { localSearch, type CachedPackage } from "../../data/search.ts";
import { isV2 } from "../../data/search.ts";
import {
  cachedPackage,
  componentId,
  compoundMetadata,
  inventoryFromPackage,
  inventoryCoverage,
  lujvoConflictKey,
  newLujvoState,
  type LujvoComponentState,
  type PackageInventory,
} from "../../model/builders.ts";
import {
  actionBar,
  confirmKindChange,
  DraftSaver,
  loadDraft,
  stepBar,
} from "./common.ts";
import { editorText, editorToRichText } from "../../model/draft.ts";

function originLabel(origin: string): string | null {
  switch (origin) {
    case "stem":
      return "stem, before another part";
    case "final":
      return "whole gismu, last part";
    case "core":
      return "whole word, extended profile";
    default:
      return null;
  }
}
export async function lujvoPage(
  _route: Route,
  context: RenderContext,
  app: App,
) {
  const { main } = context;
  context.title("Add a word: Build the lujvo");
  main.className = "surface-wizard";
  const draft = await loadDraft(app);
  if (!context.live()) return;
  if (!draft) {
    navigate("/new/meaning", { replace: true });
    return;
  }
  const saver = new DraftSaver(app, draft);
  // Changes made while opening the builder are saved like any other edit.
  if (draft.kind !== "lujvo") {
    if (!confirmKindChange(draft, "lujvo")) {
      navigate("/new/type", { replace: true });
      return;
    }
    saver.touch();
  }
  let state = (draft.lujvo ??= newLujvoState());
  const typedIdentity =
    !!draft.typedSpelling &&
    typedWord(draft.typedSpelling) === typedWord(draft.spelling);
  const retainedCompound =
    !!draft.compound && draft.evidenceForm === typedWord(draft.spelling);
  let retainedLocks = true;
  if (retainedCompound && draft.compound) {
    let hydrate = !state.components.length;
    try {
      const profile = morphologyProfile(draft.compound.morphology);
      // Ordinary rows keep the author's choices when the saved profile differs.
      // A typed version 2 record can need its original whole-word boundaries.
      hydrate ||=
        profile === "extended-v2" &&
        typedIdentity &&
        (state.components.length !== draft.compound.components.length ||
          state.components.some((component, index) => {
            const signed = draft.compound!.components[index];
            return (
              typedWord(component.spelling) !==
                typedWord(signed.word.spelling) ||
              (component.locked !== null && component.locked !== signed.rafsi)
            );
          }));
      if (state.profile !== profile) saver.touch();
      state.profile = profile;
      if (state.profile !== "extended") delete state.joins;
    } catch (error) {
      main.append(p(String(error), "notice"));
      return;
    }
    if (hydrate) {
      state.components = draft.compound.components.map((component) => ({
        id: componentId(),
        spelling: component.word.spelling,
        kind: detectWord(component.word.spelling).kind,
        definition: component.definition,
        claims: [
          {
            rafsi: component.rafsi,
            pair: rafsiPairId(wordId(component.word), component.rafsi),
          },
        ],
        locked: component.rafsi,
        gloss: "",
      }));
      saver.touch();
    }
    retainedLocks =
      state.components.length === draft.compound.components.length &&
      state.components.every(
        (component, index) =>
          component.locked !== null &&
          component.locked === draft.compound!.components[index].rafsi,
      );
    if (typedIdentity && retainedLocks) {
      state.typed = typedWord(draft.spelling);
      if (state.profile === "extended") {
        const parts = detectWord(state.typed).readings[0];
        if (
          parts?.length === state.components.length &&
          parts.every(
            (part, index) => part.text === state.components[index].locked,
          )
        )
          state.joins = parts.slice(1).map((part) => part.join_before ?? "");
      }
      saver.touch();
    }
  }
  if (
    state.typed &&
    (!typedIdentity ||
      !retainedLocks ||
      state.typed !== typedWord(draft.spelling))
  ) {
    delete state.typed;
    delete state.joins;
    delete state.typedReading;
    delete state.readingIndex;
    state.selected = null;
    saver.touch();
  }
  const cached = await cachedPackage(app.store);
  if (!context.live()) return;
  const typedAnalysis = typedIdentity ? detectWord(draft.spelling) : null;
  if (
    !retainedCompound &&
    typedAnalysis?.kind === "lujvo" &&
    state.typed !== typedWord(draft.spelling)
  ) {
    state = draft.lujvo = typedLujvoState(
      typedWord(draft.spelling),
      typedAnalysis.readings[0],
      cached,
    );
    saver.touch();
  }
  const inventory: PackageInventory = inventoryFromPackage(cached);
  const builderCurrent = () => {
    const morphology =
      result?.morphology ??
      analyzeWord(state.profile, state.components[0]?.spelling ?? "broda")
        .morphology;
    const scoring = result?.scoring ?? {
      id: `https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#${state.profile === "cll" ? "cll" : "extended"}-lujvo-scoring`,
      version: "1",
    };
    return {
      ...currentDraft(draft),
      spelling: chosenCandidate()?.spelling ?? draft.spelling,
      compound: !linkedSources(state)
        ? null
        : result && chosenCandidate()
          ? compoundMetadata(result, chosenCandidate()!, state.components, "")
          : state.components.length
            ? {
                components: state.components.map((c) => ({
                  word: { language: "jbo" as const, spelling: c.spelling },
                  definition: c.definition,
                  rafsi: c.locked ?? "",
                })),
                morphology,
                scoring,
                score: null,
                notes: [],
              }
            : null,
    };
  };
  main.append(stepBar(draft, 3));
  const columns = el("div", { class: "two-col" });
  const section = el("section", { "aria-labelledby": "h1", class: "main-col" });
  section.append(
    el("h1", { id: "h1", class: "page", text: "Build the lujvo" }),
  );
  section.append(
    el(
      "p",
      { class: "muted", style: "margin:6px 0 16px" },
      text("for "),
      el("bdi", { text: draft.meaning || "(no meaning yet)" }),
    ),
  );
  if (state.typed) {
    section.append(
      p(
        `Link the source words of ${state.typed}. Its rafsi and joins stay fixed. Fill every source to save compound metadata, or continue without it.`,
        "small",
      ),
    );
  }
  if (state.profile === "extended-v2")
    section.append(p("Saved morphology: extended version 2.", "meta"));
  // Profile.
  const profileGroup = el("div", {
    class: "seg",
    role: "radiogroup",
    "aria-label": "Morphology profile",
  });
  for (const [value, label] of [
    ...(state.profile === "extended-v2"
      ? [["extended-v2", "Extended version 2 (saved record)"]]
      : []),
    ["cll", "CLL rules"],
    ["extended", "Extended: whole-word parts"],
  ] as const) {
    const input = el("input", { type: "radio", name: "profile", value });
    input.checked = state.profile === value;
    const wrapper = el(
      "label",
      { class: input.checked ? "on" : "" },
      input,
      text(label),
    );
    input.addEventListener("change", () => {
      state.profile = value as MorphologyProfile;
      for (const l of profileGroup.querySelectorAll("label"))
        l.classList.toggle("on", l.querySelector("input")!.checked);
      saver.touch();
      rebuild();
    });
    profileGroup.append(wrapper);
  }
  section.append(
    el("div", { style: "margin-bottom:6px" }, profileGroup),
    p(
      "CLL rules use short rafsi, gismu stems, and whole gismu in the last position, with the joins of CLL 4.11 and the scores of CLL 4.12. The extended profile also joins whole brivla with 'y, y, or y' and gives a shape outside the CLL table rank zero. That extension is audited jbotci behavior, not CLL text.",
      "meta",
    ),
  );
  if (state.typed) profileGroup.closest("div")!.hidden = true;
  // Component rows.
  const list = el("ol", {
    class: "parts",
    "aria-label": "Components",
    style:
      "list-style:none;margin:12px 0 0;padding:0;display:flex;flex-direction:column;gap:10px",
  });
  section.append(list);
  const addRow = el("div", {
    style:
      "display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;margin-top:12px",
  });
  const addField = field("Add a part", {
    placeholder: "word or recognized fu'ivla",
    spellcheck: false,
    lang: "jbo",
    labelClass: "sr",
    wrapperClass: "",
  });
  addField.input.style.flex = "1 1 200px";
  const addResults = el("ul", {
    class: "similar",
    style: "list-style:none;margin:6px 0 0;padding:0",
    "aria-label": "Matching words",
  });
  addRow.append(addField.wrapper);
  section.append(addRow, addResults);
  if (state.typed) addRow.hidden = true;
  if (!state.typed)
    section.append(
      assistanceAction(app, draft, saver, context, {
        key: "components",
        label: "Suggest components",
        operation: "lujvo",
        profile: "components",
        current: builderCurrent,
      }),
      assistanceAction(app, draft, saver, context, {
        key: "lujvo",
        label: "Suggest a lujvo",
        operation: "lujvo",
        current: builderCurrent,
      }),
    );
  // Result card and alternatives.
  const resultCard = el("div", {
    class: "card",
    style: "margin-top:20px",
    "aria-live": "polite",
    role: "region",
    "aria-label": "Result",
  });
  const alternatives = el("div", { style: "margin-top:16px" });
  section.append(resultCard, alternatives);
  // Right column.
  const aside = el("aside", {
    class: "side-col",
    style: "display:flex;flex-direction:column;gap:14px",
  });
  const definitionField = field("Current definition", {
    multiline: true,
    rows: 4,
    value: editorText(draft.text, draft.structured),
    lang: draft.language,
  });
  definitionField.input.addEventListener("input", () => {
    draft.text = editorToRichText(
      definitionField.input.value,
      draft.structured,
    );
    saver.touch();
  });
  aside.append(
    el(
      "div",
      { class: "card" },
      el("h2", { class: "section", style: "margin-top:0", text: "Definition" }),
      definitionField.wrapper,
      p(
        "Your own words stay until you change them. A new form never rewrites them.",
        "meta",
      ),
    ),
    el(
      "div",
      { class: "card" },
      p("Preserved meaning", "meta"),
      el(
        "p",
        { style: "margin-top:4px" },
        el("bdi", { text: draft.meaning || "(no meaning yet)" }),
      ),
      assistanceAction(app, draft, saver, context, {
        key: "definition",
        label: "Draft definition for this form",
        operation: "definition",
        current: builderCurrent,
      }),
    ),
  );
  columns.append(section, aside);
  main.append(columns);
  // Search for parts.
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const renderSearch = () => {
    addResults.replaceChildren();
    const query = addField.input.value.trim();
    if (!query) return;
    const hits = cached ? localSearch(cached.entries, query).slice(0, 6) : [];
    for (const hit of hits) {
      const entry = hit.entries[0];
      const kind =
        (entry.classification as { kind?: string } | null)?.kind ?? "other";
      const rafsi = hit.entries.flatMap((e) => (isV2(e) ? e.rafsi : []));
      const item = el("li", { class: "similar-item" });
      item.append(
        el("span", { class: "hw", lang: "jbo", text: hit.word.spelling }),
        text(` ${kind}`, "meta"),
        text(
          ` · ${entry.glosses.map((g) => g.text).join(", ") || entry.plain_text.slice(0, 60)}`,
          "meta",
        ),
        rafsi.length
          ? text(` · rafsi ${[...new Set(rafsi)].join(", ")}`, "meta")
          : text(" · no listed rafsi", "meta"),
        button(
          "Add",
          () => {
            const id = wordId({ language: "jbo", spelling: hit.word.spelling });
            state.components.push({
              id: componentId(),
              spelling: hit.word.spelling,
              kind,
              // A specific definition is recorded only when the author chooses one below.
              definition: null,
              definitions: hit.entries.map((e) => ({
                event: e.event,
                summary:
                  e.glosses.map((g) => g.text).join(", ") ||
                  Array.from(e.plain_text).slice(0, 60).join(""),
              })),
              gloss: entry.glosses[0]?.text ?? "",
              claims: [...new Set(rafsi)].map((r) => ({
                rafsi: r,
                pair: rafsiPairId(id, r),
              })),
              locked: null,
            });
            addField.input.value = "";
            addResults.replaceChildren();
            saver.touch();
            renderRows();
            rebuild();
          },
          {
            class: "btn btn-quiet",
            "aria-label": `Add ${hit.word.spelling}`,
          },
        ),
      );
      addResults.append(item);
    }
    // A recognized form without a dictionary entry.
    const analysis = analyzeWord(state.profile, query);
    if (
      analysis.normalized &&
      !hits.some((h) => h.word.spelling === analysis.normalized)
    ) {
      const item = el("li", { class: "similar-item" });
      const kind =
        analysis.kind === "fuivla"
          ? "fuivla"
          : analysis.kind === "gismu"
            ? "gismu"
            : analysis.kind === "lujvo"
              ? "lujvo"
              : analysis.kind === "cmavo"
                ? "cmavo"
                : analysis.kind === "cmevla"
                  ? "cmevla"
                  : "other";
      item.append(
        el("span", { class: "hw", lang: "jbo", text: analysis.normalized }),
        text(` ${kind}, not in the local package`, "meta"),
        analysis.diagnostics.length
          ? text(` · ${analysis.diagnostics[0]}`, "meta")
          : text(""),
        button(
          "Add as entered",
          () => {
            state.components.push({
              id: componentId(),
              spelling: analysis.normalized!,
              kind,
              definition: null,
              gloss: "",
              claims: [],
              locked: null,
            });
            addField.input.value = "";
            addResults.replaceChildren();
            saver.touch();
            renderRows();
            rebuild();
          },
          {
            class: "btn btn-quiet",
            "aria-label": `Add ${analysis.normalized} as entered`,
          },
        ),
      );
      addResults.append(item);
    }
    if (!cached)
      addResults.append(
        el("li", {
          class: "meta",
          text: "No local package is downloaded, so word search is unavailable here. Download one on the Settings page, or add a form as entered.",
        }),
      );
  };
  addField.input.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderSearch, 200);
  });
  let result: LujvoResult | null = null;
  let failure: string | null = null;
  const chosenCandidate = (): LujvoCandidate | null => {
    if (!result?.candidates.length) return null;
    if (state.typed)
      return (
        result.candidates.find(
          (candidate) => candidate.spelling === state.typed,
        ) ?? null
      );
    return state.selected
      ? (result.candidates.find((c) => c.spelling === state.selected) ?? null)
      : result.candidates[0];
  };
  const conflictKeys = (candidate: LujvoCandidate) =>
    candidate.conflicts.map((c) =>
      lujvoConflictKey(
        candidate.spelling,
        c,
        candidate.conflicts,
        inventory.snapshot,
      ),
    );
  const renderRows = () => {
    list.replaceChildren();
    state.components.forEach((component, index) => {
      const row = result?.rows.find((r) => r.id === component.id);
      const item = el("li", {
        class: "card part",
        style:
          "padding:14px 16px;display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center",
      });
      if (state.typed) {
        const part = {
          text: component.locked ?? "",
          kind: "rafsi" as const,
          join_before: index ? (state.joins?.[index - 1] ?? "") : null,
        };
        const options = sourceOptions(part, cached);
        item.append(
          el("strong", { lang: "jbo", text: component.locked ?? "" }),
          p(
            `Exact join before this part: ${index ? JSON.stringify(state.joins?.[index - 1] ?? "") : "none"}.`,
            "meta",
          ),
        );
        if (options.length) {
          const source = field(`Source word for part ${index + 1}`, {
            options: [
              { value: "", label: "Choose a source word" },
              ...options.map((choice) => ({
                value: choice.spelling,
                label: `${choice.spelling} ${choice.gloss}`,
              })),
            ],
            value: component.unresolvedSource ? "" : component.spelling,
          });
          source.input.addEventListener("change", () => {
            const choice = options.find(
              (choice) => choice.spelling === source.input.value,
            );
            if (!choice) return;
            state.components[index] = { ...choice, id: component.id };
            saver.touch();
            rebuild();
          });
          item.append(source.wrapper);
        }
        const source = field(`Other source word for part ${index + 1}`, {
          value: options.some(
            (option) => option.spelling === component.spelling,
          )
            ? ""
            : component.spelling,
          lang: "jbo",
          spellcheck: false,
        });
        source.input.addEventListener("change", () => {
          const spelling = typedWord(source.input.value);
          component.spelling = spelling;
          component.kind = detectWord(spelling).kind;
          component.definition = null;
          component.definitions = [];
          component.claims = [];
          if (spelling) delete component.unresolvedSource;
          else
            component.unresolvedSource = "Link a source word if you know it.";
          saver.touch();
          rebuild();
        });
        item.append(source.wrapper);
        if (!options.length && !component.spelling)
          item.append(
            p(
              "No source word is linked. Enter one to record its attribution, or continue without compound metadata. The rafsi stays fixed.",
              "meta",
            ),
          );
        if (component.definitions?.length) {
          const definition = field(
            `Exact definition of ${component.spelling}`,
            {
              options: [
                { value: "", label: "no specific definition" },
                ...component.definitions.map((entry) => ({
                  value: entry.event,
                  label: entry.summary,
                })),
              ],
              value: component.definition ?? "",
            },
          );
          definition.input.addEventListener("change", () => {
            component.definition = definition.input.value || null;
            saver.touch();
            rebuild();
          });
          item.append(definition.wrapper);
        }
        list.append(item);
        return;
      }
      const moves = el("div", {
        style: "display:flex;flex-direction:column;gap:2px",
      });
      const move = (delta: number) => {
        const target = index + delta;
        if (target < 0 || target >= state.components.length) return;
        [state.components[index], state.components[target]] = [
          state.components[target],
          state.components[index],
        ];
        saver.touch();
        renderRows();
        rebuild();
      };
      moves.append(
        button(icon("up", "", 16), () => move(-1), {
          class: "btn btn-quiet btn-icon",
          "aria-label": `Move ${component.spelling} up`,
          disabled: index === 0 ? true : undefined,
        }),
        button(icon("down", "", 16), () => move(1), {
          class: "btn btn-quiet btn-icon",
          "aria-label": `Move ${component.spelling} down`,
          disabled: index === state.components.length - 1 ? true : undefined,
        }),
      );
      const name = el("span", { style: "flex:1 1 160px;min-width:0" });
      name.append(
        el("strong", {
          lang: "jbo",
          style: "font-size:18px",
          text: component.spelling,
        }),
        text(` ${component.kind}`, "meta"),
      );
      if (component.gloss) name.append(text(` ${component.gloss}`, "meta"));
      if (component.definitions?.length) {
        // The exact source definition is the author's choice, never the package order.
        const pick = el("select", {
          class: "inline-select",
          "aria-label": `Exact definition of ${component.spelling}`,
          style: "max-width:100%",
        });
        pick.append(
          el("option", {
            value: "",
            text: "no specific definition",
            selected: !component.definition,
          }),
        );
        for (const definition of component.definitions)
          pick.append(
            el("option", {
              value: definition.event,
              text: `${definition.event.slice(5, 13)}… ${definition.summary}`,
              selected: component.definition === definition.event,
            }),
          );
        pick.addEventListener("change", () => {
          component.definition = pick.value || null;
          saver.touch();
          rebuild();
        });
        name.append(el("br"), pick);
      } else if (component.definition)
        name.append(text(" · exact definition chosen", "meta"));
      const chips = el("fieldset", {
        style:
          "border:0;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:8px",
      });
      chips.append(
        el("legend", { class: "sr", text: `Rafsi for ${component.spelling}` }),
      );
      const choiceChip = (
        value: string | null,
        label: string,
        title: string | null,
      ) => {
        const input = el("input", {
          type: "radio",
          name: `choice-${component.id}`,
          value: value ?? "",
        });
        input.checked = component.locked === value;
        const wrapper = el(
          "label",
          {
            class: `chip${input.checked ? " on" : ""}`,
            lang: value ? "jbo" : undefined,
          },
          input,
          text(label),
        );
        if (title) wrapper.title = title;
        input.addEventListener("change", () => {
          component.locked = value;
          saver.touch();
          renderRows();
          rebuild();
        });
        return wrapper;
      };
      chips.append(
        choiceChip(null, "automatic", "Let the lowest score choose the form."),
      );
      for (const choice of row?.choices ?? []) {
        const label = originLabel(choice.origin);
        const chip = choiceChip(choice.form, choice.form, label);
        if (label)
          chip.append(
            text(
              ` ${choice.origin === "stem" ? "stem" : choice.origin === "final" ? "last" : "whole"}`,
              "meta",
            ),
          );
        chips.append(chip);
      }
      if (
        component.locked &&
        row &&
        !row.choices.some((choice) => choice.form === component.locked)
      )
        chips.append(
          choiceChip(
            component.locked,
            component.locked,
            ["This lock is not among the choices.", ...row.diagnostics].join(
              " ",
            ),
          ),
        );
      const known = field("Other rafsi you know", {
        value: component.claims
          .filter((c) => !inventory.claims.some((k) => k.pair === c.pair))
          .map((c) => c.rafsi)
          .join(", "),
        placeholder: "comma separated",
        labelClass: "meta",
        wrapperClass: "",
        spellcheck: false,
        lang: "jbo",
      });
      known.input.style.width = "12rem";
      known.input.addEventListener("change", () => {
        const id = wordId({ language: "jbo", spelling: component.spelling });
        const packaged = component.claims.filter((c) =>
          inventory.claims.some((k) => k.pair === c.pair),
        );
        const entered = known.input.value
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
        component.claims = [
          ...packaged,
          ...entered
            .filter((r) => !packaged.some((c) => c.rafsi === r))
            .map((r) => ({ rafsi: r, pair: rafsiPairId(id, r) })),
        ];
        saver.touch();
        rebuild();
        renderRows();
      });
      const remove = button(
        icon("close", "", 18),
        () => {
          state.components.splice(index, 1);
          saver.touch();
          renderRows();
          rebuild();
        },
        {
          class: "btn btn-quiet btn-icon",
          "aria-label": `Remove ${component.spelling}`,
        },
      );
      item.append(moves, name, chips, known.wrapper, remove);
      if (row?.diagnostics.length)
        item.append(
          el("p", {
            class: "meta",
            style: "flex-basis:100%;margin:0",
            text: row.diagnostics.join(" "),
          }),
        );
      list.append(item);
    });
    if (!state.components.length)
      list.append(
        el("li", { class: "meta", text: "No parts yet. Add at least two." }),
      );
  };
  const renderAlternatives = (candidate: LujvoCandidate | null) => {
    // Alternatives.
    if (
      result &&
      result.candidates.length &&
      (!candidate || result.candidates.length > 1)
    ) {
      const table = el("table", { class: "small" });
      table.append(
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            el("th", { scope: "col", text: "Form" }),
            el("th", { scope: "col", text: "Parts" }),
            el("th", { scope: "col", class: "right", text: "Score" }),
            el("th", { scope: "col", text: "" }),
          ),
        ),
      );
      const tbody = el("tbody");
      for (const other of result.candidates) {
        const row = el("tr", {
          style:
            other.spelling === candidate?.spelling
              ? "background:var(--accent-soft)"
              : undefined,
        });
        row.append(
          el("td", {
            lang: "jbo",
            style: "font-weight:650",
            text: other.spelling,
          }),
          el("td", { lang: "jbo", text: other.tokens.join(" + ") }),
          el("td", { class: "right num", text: String(other.score) }),
          el(
            "td",
            { class: "right" },
            other.spelling === candidate?.spelling
              ? text("chosen", "meta")
              : button(
                  "Use",
                  () => {
                    if (state.selected !== other.spelling) {
                      state.acknowledged = [];
                      draft.publishAcknowledged = [];
                    }
                    state.selected = other.spelling;
                    saver.touch();
                    renderResult();
                  },
                  {
                    class: "btn btn-quiet",
                    "aria-label": `Use ${other.spelling}`,
                  },
                ),
          ),
        );
        tbody.append(row);
      }
      table.append(tbody);
      alternatives.append(
        el("h2", { class: "section", text: "Other forms from these parts" }),
        el(
          "div",
          {
            class: "table-scroll",
            tabindex: "0",
            role: "region",
            "aria-label": "Other forms",
          },
          table,
        ),
      );
      if (result.candidates.length >= 64)
        alternatives.append(p("Only the first 64 forms are listed.", "meta"));
    }
  };
  const renderResult = () => {
    resultCard.replaceChildren();
    alternatives.replaceChildren();
    if (state.selected && !chosenCandidate())
      resultCard.append(
        p(
          `${state.selected} is no longer a candidate. Choose a current form before you continue.`,
          "notice",
        ),
      );
    if (failure) {
      refreshPrimary();
      resultCard.append(p(failure, "notice"));
      return;
    }
    if (!result) {
      resultCard.append(p("Add at least two parts to build a lujvo.", "small"));
      refreshPrimary();
      return;
    }
    for (const line of result.diagnostics) resultCard.append(p(line, "small"));
    const candidate = chosenCandidate();
    if (!candidate) {
      if (!result.candidates.length)
        resultCard.append(
          p("No valid lujvo comes from these parts and choices.", "small"),
        );
      for (const r of result.rejected.slice(0, 6))
        resultCard.append(p(`${r.spelling}: ${r.reason}`, "meta"));
      renderAlternatives(null);
      refreshPrimary();
      return;
    }
    const headline = el("div", {
      class: "hw builder-form",
      lang: "jbo",
      "aria-label": `Form ${candidate.spelling}`,
    });
    for (const token of candidate.tokens)
      headline.append(
        el("span", {
          style: candidate.parts.some((pt) => pt.form === token)
            ? "text-decoration:underline;text-underline-offset:6px;text-decoration-thickness:2px"
            : "opacity:.6",
          text: token,
        }),
      );
    resultCard.append(headline);
    resultCard.append(
      p(
        `Construction score ${candidate.score} under ${state.profile === "cll" ? "CLL 4.12" : "the extended scorer"}. A lower score reads more easily. It says nothing about who endorses a rafsi.`,
        "meta",
      ),
      p(
        `Recovered parts: ${candidate.recovered.map((r) => (r.join_before ? `${r.join_before} + ` : "") + r.text).join(" + ")}. The form reads as one word and gives back the intended sequence.`,
        "small",
      ),
    );
    // Whether the spelling is taken is separate from rafsi conflicts. The
    // local package answers for its snapshot, and the server for the current one.
    const availability = el("p", { class: "small", role: "status" });
    const taken = cached?.entries.some(
      (e) => e.word.spelling === candidate.spelling,
    );
    availability.textContent = cached
      ? taken
        ? `Taken: ${candidate.spelling} is defined in the local package of snapshot ${cached.snapshot.slice(7, 19)}….`
        : `Not in the local package of snapshot ${cached.snapshot.slice(7, 19)}…. The package covers retained definitions in its language only.`
      : "Availability in the local package is unknown: no package is downloaded.";
    resultCard.append(availability);
    const checked = candidate.spelling;
    if (!state.typed)
      void getWord(wordId({ language: "jbo", spelling: checked }), {
        signal: context.signal,
      })
        .then((word) => {
          if (!context.live() || chosenCandidate()?.spelling !== checked)
            return;
          // A word response without definitions means the server knows no definition of this spelling.
          availability.textContent += word.definitions.length
            ? ` The server defines ${checked} in snapshot ${word.snapshot.slice(7, 19)}….`
            : ` The server has no definition of ${checked} in snapshot ${word.snapshot.slice(7, 19)}….`;
        })
        .catch((error: unknown) => {
          if (!context.live() || chosenCandidate()?.spelling !== checked)
            return;
          availability.textContent +=
            error instanceof RequestError && error.status === 404
              ? ` The server has no definition of ${checked} now.`
              : ` The server could not be asked: ${describe(error)}.`;
        });
    if (candidate.unlisted.length)
      resultCard.append(
        p(
          `Rafsi ${candidate.unlisted.join(", ")} are not listed in the local package${inventory.snapshot ? ` of snapshot ${inventory.snapshot.slice(7, 19)}…` : ""}. They are claims you entered or claims the package does not carry.`,
          "small",
        ),
      );
    const coverage = inventoryCoverage(inventory);
    resultCard.append(p(coverage, "meta"));
    if (candidate.conflicts.length) {
      const box = el("div", {
        class: "notice",
        role: "group",
        "aria-label": "Competing rafsi claims",
      });
      box.append(
        p(
          "Competing claims for the selected rafsi. Every retained claim in the package is listed, whatever its standing. Acknowledge each one to keep this form, choose another form, or change the parts.",
          "small",
        ),
      );
      const displayedClaims = new Set<string>();
      for (const conflict of candidate.conflicts) {
        const key = lujvoConflictKey(
          candidate.spelling,
          conflict,
          candidate.conflicts,
          inventory.snapshot,
        );
        // Several parts can share one retained claim and acknowledgment.
        if (displayedClaims.has(key)) continue;
        displayedClaims.add(key);
        const box2 = el("input", {
          type: "checkbox",
          id: `ack-${key.replace(/[^a-z0-9]/gi, "")}`,
        });
        box2.checked = state.acknowledged.includes(key);
        box2.addEventListener("change", () => {
          state.acknowledged = box2.checked
            ? [...new Set([...state.acknowledged, key])]
            : state.acknowledged.filter((k) => k !== key);
          saver.touch();
          refreshPrimary();
        });
        box.append(
          el(
            "label",
            { class: "check", for: box2.id },
            box2,
            inlineProse(
              "The claimant link is part of the rafsi acknowledgment sentence.",
              text(`${conflict.rafsi} is also claimed by `),
              link(
                conflict.spelling,
                `/word/${encodeURIComponent(conflict.spelling)}`,
                { lang: "jbo" },
              ),
              text(". I keep this form."),
            ),
          ),
        );
      }
      resultCard.append(box);
    }
    renderAlternatives(candidate);
    refreshPrimary();
  };
  const rebuild = () => {
    failure = null;
    result = null;
    if (state.components.length >= 2) {
      try {
        result = buildLujvo({
          ...typedLujvoRequest(state),
          components: state.components.map((c) => ({
            id: c.id,
            spelling: c.spelling,
            kind: c.kind,
            definition: c.definition,
            claims: c.claims,
            locked: c.locked,
          })),
          inventory: { snapshot: inventory.snapshot, claims: inventory.claims },
          limits: { choice_product: 20000, results: 64 },
        });
      } catch (error) {
        failure =
          error instanceof BuilderError
            ? `The builder stopped: ${error.message}`
            : describe(error);
      }
    }
    renderRows();
    renderResult();
  };
  let bar: HTMLElement;
  const unacknowledged = (candidate: LujvoCandidate) =>
    conflictKeys(candidate).filter((k) => !state.acknowledged.includes(k));
  const refreshPrimary = () => {
    const primary = bar?.querySelector<HTMLButtonElement>(".btn-primary");
    if (!primary) return;
    const candidate = chosenCandidate();
    primary.textContent = `Use ${candidate?.spelling ?? "this form"}`;
    primary.disabled =
      !candidate ||
      unacknowledged(candidate).length > 0 ||
      !linkedSources(state);
    primary.title =
      candidate && unacknowledged(candidate).length
        ? "Acknowledge every competing claim first, or choose another form."
        : "";
  };
  const useCandidate = async (withMetadata: boolean) => {
    const candidate = chosenCandidate();
    if (
      !candidate ||
      !result ||
      (withMetadata &&
        (unacknowledged(candidate).length || !linkedSources(state)))
    )
      return;
    if (
      draft.formation &&
      !confirm(
        "Use this lujvo and remove the previous generation evidence? The prose and annotations stay.",
      )
    )
      return;
    if (
      draft.typedSpelling &&
      typedWord(draft.spelling) !== candidate.spelling &&
      !confirm(
        `Replace the typed spelling "${draft.spelling}" with "${candidate.spelling}"?`,
      )
    )
      return;
    draft.formation = null;
    if (draft.spelling !== candidate.spelling) draft.publishAcknowledged = [];
    draft.spelling = candidate.spelling;
    draft.typedSpelling = state.typed ? typedWord(candidate.spelling) : null;
    draft.evidenceForm = withMetadata ? candidate.spelling : null;
    draft.compound = withMetadata
      ? compoundMetadata(result, candidate, state.components, "")
      : null;
    state.selected = candidate.spelling;
    draft.step = Math.max(draft.step, 4) as Draft["step"];
    if (!(await saver.flush())) return;
    navigate("/new/places");
  };
  bar = actionBar(saver, {
    back: { label: "Back", href: "/new/type" },
    extra: [
      ...(state.typed
        ? [
            button(
              "Continue without compound metadata",
              () => useCandidate(false),
              { class: "btn btn-quiet" },
            ),
          ]
        : []),
      link("Type the spelling yourself", "/new/form?manual=1", {
        class: "btn btn-quiet",
      }),
    ],
    primary: {
      label: "Use this form",
      disabled: true,
      action: () => useCandidate(true),
    },
  });
  main.append(bar);
  rebuild();
}
