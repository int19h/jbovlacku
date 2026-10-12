/**
 * Step 3A: the lujvo builder. Ordered component rows with rafsi choices and
 * locks, the scored candidates of the shared morphology core, recovered parts,
 * complete rafsi conflicts from the local package, and the preserved meaning.
 */
import {
  analyzeWord,
  buildLujvo,
  BuilderError,
  rafsiPairId,
  wordId,
  type LujvoCandidate,
  type LujvoResult,
  type MorphologyProfile,
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
import { getWord, RequestError } from "../../data/api.ts";
import type { Draft } from "../../model/draft.ts";
import { localSearch, type CachedPackage } from "../../data/search.ts";
import { isV2 } from "../../data/search.ts";
import {
  cachedPackage,
  componentId,
  compoundMetadata,
  inventoryFromPackage,
  newLujvoState,
  type LujvoComponentState,
  type PackageInventory,
} from "../../model/builders.ts";
import { actionBar, DraftSaver, loadDraft, stepBar } from "./common.ts";
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
    draft.kind = "lujvo";
    saver.touch();
  }
  const state = (draft.lujvo ??= newLujvoState());
  const cached = await cachedPackage(app.store);
  if (!context.live()) return;
  const inventory: PackageInventory = inventoryFromPackage(cached);
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
  // Profile.
  const profileGroup = el("div", {
    class: "seg",
    role: "radiogroup",
    "aria-label": "Morphology profile",
  });
  for (const [value, label] of [
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
  section.append(
    p(
      "Component suggestions and lujvo suggestions by AI are not configured on this server.",
      "meta",
    ),
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
      p(
        "A rewrite for the chosen form by AI is not configured on this server.",
        "meta",
      ),
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
            style: "min-height:36px",
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
            style: "min-height:36px",
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
    return (
      result.candidates.find((c) => c.spelling === state.selected) ??
      result.candidates[0]
    );
  };
  const conflictKeys = (candidate: LujvoCandidate) =>
    candidate.conflicts.map((c) => `${c.rafsi}|${c.pair}`);
  const renderRows = () => {
    list.replaceChildren();
    state.components.forEach((component, index) => {
      const row = result?.rows.find((r) => r.id === component.id);
      const item = el("li", {
        class: "card part",
        style:
          "padding:14px 16px;display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center",
      });
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
          style: "min-height:28px",
        }),
        button(icon("down", "", 16), () => move(1), {
          class: "btn btn-quiet btn-icon",
          "aria-label": `Move ${component.spelling} down`,
          disabled: index === state.components.length - 1 ? true : undefined,
          style: "min-height:28px",
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
          style: "min-height:32px;max-width:100%",
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
      if (component.locked && row && !row.lock_valid)
        chips.append(
          choiceChip(
            component.locked,
            component.locked,
            "This lock is not among the choices.",
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
      known.input.style.minHeight = "36px";
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
  const renderResult = () => {
    resultCard.replaceChildren();
    alternatives.replaceChildren();
    if (failure) {
      resultCard.append(p(failure, "notice"));
      return;
    }
    if (!result) {
      resultCard.append(p("Add at least two parts to build a lujvo.", "small"));
      return;
    }
    for (const line of result.diagnostics) resultCard.append(p(line, "small"));
    const candidate = chosenCandidate();
    if (!candidate) {
      resultCard.append(
        p("No valid lujvo comes from these parts and choices.", "small"),
      );
      for (const r of result.rejected.slice(0, 6))
        resultCard.append(p(`${r.spelling}: ${r.reason}`, "meta"));
      refreshPrimary();
      return;
    }
    const headline = el("div", {
      class: "hw",
      lang: "jbo",
      style:
        "font-size:44px;line-height:1.1;letter-spacing:-0.025em;font-weight:680",
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
    void getWord(wordId({ language: "jbo", spelling: checked }), {
      signal: context.signal,
    })
      .then((word) => {
        if (!context.live() || chosenCandidate()?.spelling !== checked) return;
        // A word response without definitions means the server knows no definition of this spelling.
        availability.textContent += word.definitions.length
          ? ` The server defines ${checked} in snapshot ${word.snapshot.slice(7, 19)}….`
          : ` The server has no definition of ${checked} in snapshot ${word.snapshot.slice(7, 19)}….`;
      })
      .catch((error: unknown) => {
        if (!context.live() || chosenCandidate()?.spelling !== checked) return;
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
    const coverage = inventory.snapshot
      ? inventory.hasClaims
        ? `Conflicts come from the local package of snapshot ${inventory.snapshot.slice(7, 19)}…. They cover retained claims in that package only.`
        : "The local package carries no rafsi claims, so conflict coverage is unknown."
      : "No local package is downloaded, so conflict coverage is unknown.";
    resultCard.append(p(coverage, "meta"));
    if (candidate.conflicts.length) {
      const box = el("div", {
        class: "notice",
        role: "group",
        "aria-label": "Competing rafsi claims",
      });
      box.append(
        p(
          "Competing claims for the selected rafsi. Every known claim is listed, whatever its standing. Acknowledge each one to keep this form, choose another form, or change the parts.",
          "small",
        ),
      );
      for (const conflict of candidate.conflicts) {
        const key = `${conflict.rafsi}|${conflict.pair}`;
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
            text(` ${conflict.rafsi} is also claimed by `),
            link(
              conflict.spelling,
              `/word/${encodeURIComponent(conflict.spelling)}`,
              { lang: "jbo" },
            ),
            text(". I keep this form."),
          ),
        );
      }
      resultCard.append(box);
    }
    // Alternatives.
    if (result.candidates.length > 1) {
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
            other.spelling === candidate.spelling
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
            other.spelling === candidate.spelling
              ? text("chosen", "meta")
              : button(
                  "Use",
                  () => {
                    state.selected = other.spelling;
                    saver.touch();
                    renderResult();
                  },
                  {
                    class: "btn btn-quiet",
                    style: "min-height:36px",
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
    refreshPrimary();
  };
  const rebuild = () => {
    failure = null;
    result = null;
    if (state.components.length >= 2) {
      try {
        result = buildLujvo({
          profile: state.profile,
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
    if (
      result &&
      state.selected &&
      !result.candidates.some((c) => c.spelling === state.selected)
    )
      state.selected = null;
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
    primary.disabled = !candidate || unacknowledged(candidate).length > 0;
    primary.title =
      candidate && unacknowledged(candidate).length
        ? "Acknowledge every competing claim first, or choose another form."
        : "";
  };
  bar = actionBar(saver, {
    back: { label: "Back", href: "/new/type" },
    extra: [
      link("Type the spelling yourself", "/new/form?manual=1", {
        class: "btn btn-quiet",
      }),
    ],
    primary: {
      label: "Use this form",
      disabled: true,
      action: async () => {
        const candidate = chosenCandidate();
        if (!candidate || !result || unacknowledged(candidate).length) return;
        draft.spelling = candidate.spelling;
        draft.evidenceForm = candidate.spelling;
        draft.compound = compoundMetadata(
          result,
          candidate,
          state.components,
          "",
        );
        state.selected = candidate.spelling;
        draft.step = Math.max(draft.step, 4) as Draft["step"];
        if (!(await saver.flush())) return;
        navigate("/new/places");
      },
    },
  });
  main.append(bar);
  rebuild();
}
