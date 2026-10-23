/**
 * The word page: headword, composition, rafsi line, language tabs, and one
 * block per definition in layer order under the selected view.
 */
import { wordId } from "../../../../packages/core/src/index.ts";
import {
  el,
  link,
  p,
  text,
  button,
  describe,
  icon,
  disclosure,
} from "../lib/dom.ts";
import { languageName, plural } from "../lib/format.ts";
import {
  navigate,
  routes,
  type RenderContext,
  type Route,
} from "../app/router.ts";
import type { App } from "../app/context.ts";
import {
  getWord,
  loadDefinition,
  loadRecord,
  RequestError,
  type LoadedRecord,
} from "../data/api.ts";
import {
  wordIdValid,
  type DefinitionBody,
  type RafsiBody,
  type WordResponse,
} from "../model/types.ts";
import { definitionBlock } from "../components/definition.ts";
import { judgmentControl, scoreDetails } from "../components/judgment.ts";
import { identityLink } from "../components/attribution.ts";
import { renderRichText } from "../model/richtext.ts";
import { zbalermorna } from "../lib/zbalermorna.ts";
import {
  calculationPanel,
  provenanceLine,
  viewScores,
} from "../components/localview.ts";
import { recomputePanel } from "../components/recompute.ts";
import { describeProfile } from "../model/profiles.ts";

export async function wordPage(route: Route, context: RenderContext, app: App) {
  const { main } = context;
  main.className = "surface-word";
  const key: string = route.segments[1] ?? "";
  const isId: boolean = /^jvw1:[0-9a-f]{64}$/.test(key);
  const id = isId
    ? key
    : wordId({ language: "jbo", spelling: key.normalize("NFC") });
  const spellingHint = isId ? null : key.normalize("NFC");
  const requestedLanguage =
    route.params.get("lang") ?? app.session.preferences.definitionLanguage;
  context.title(spellingHint ?? "Word");
  let word: WordResponse;
  try {
    word = await getWord(id, {
      signal: context.signal,
      fresh: route.params.has("fresh"),
    });
  } catch (error) {
    if (!context.live()) return;
    main.append(
      el("h1", { class: "page", text: spellingHint ?? "Word" }),
      p(describe(error), "notice"),
    );
    if (spellingHint)
      main.append(
        p(
          "No definitions are available for this spelling on this server.",
          "small",
        ),
        link(
          "Add a definition",
          `${routes.add}?word=${encodeURIComponent(spellingHint)}`,
          { class: "btn" },
        ),
      );
    return;
  }
  if (!context.live()) return;
  const spelling = word.word?.spelling ?? spellingHint ?? "Word unavailable";
  context.title(spelling);
  const head = el("div", { class: "word-head" });
  const h1 = el("h1", { lang: "jbo", text: spelling });
  head.append(h1);
  const zb =
    app.session.preferences.orthography === "zbalermorna"
      ? zbalermorna(spelling)
      : null;
  if (zb)
    head.append(
      el("span", { class: "zbalermorna", "aria-hidden": "true", text: zb }),
    );
  const kindTag = el("span", { class: "meta", style: "font-size:15px" });
  head.append(kindTag);
  head.append(
    button(
      icon("copy", "", 17),
      async () => {
        try {
          await navigator.clipboard.writeText(spelling);
          app.announce(`Copied ${spelling}.`);
        } catch {
          app.announce("The browser did not allow copying.");
        }
      },
      {
        class: "btn btn-quiet btn-icon",
        "aria-label": `Copy ${spelling}`,
        title: "Copy the Latin spelling",
      },
    ),
  );
  main.append(head);
  const composition = el("p", { class: "muted", style: "margin-top:6px" });
  const rafsiLine = el("p", {
    class: "muted rafsi-line",
    style: "margin-top:4px",
  });
  main.append(composition, rafsiLine);
  if (!word.word && !word.definitions.length) {
    main.append(
      p(
        "No definitions are available for this word in the selected view.",
        "small",
      ),
    );
    if (spellingHint)
      main.append(
        link(
          "Add a definition",
          `${routes.add}?word=${encodeURIComponent(spellingHint)}`,
          { class: "btn", style: "margin-top:12px" },
        ),
      );
    return;
  }
  // Load every definition record. Group by language.
  const records = new Map<string, LoadedRecord<DefinitionBody>>();
  const failures = new Map<string, string>();
  await Promise.all(
    word.definitions.map(async (definition) => {
      try {
        records.set(
          definition,
          await loadDefinition(definition, word.snapshot),
        );
      } catch (error) {
        failures.set(definition, describe(error));
      }
    }),
  );
  if (!context.live()) return;
  const byLanguage = new Map<string, string[]>();
  for (const [definitionId, record] of records) {
    const language =
      record.body?.language ??
      (record.envelope.header.action.language as string) ??
      "und";
    byLanguage.set(language, [
      ...(byLanguage.get(language) ?? []),
      definitionId,
    ]);
  }
  const kinds = new Set(
    [...records.values()]
      .map((r) => r.body?.classification.kind)
      .filter(Boolean),
  );
  kindTag.textContent = [...kinds]
    .map((k) => (k === "fuivla" ? "fu'ivla" : k))
    .join(" · ");
  // Composition line from any compound evidence.
  const compound = [...records.values()]
    .map((r) => r.body?.etymology.compound)
    .find(Boolean);
  if (compound) {
    const words = compound.components
      .map((c, i) => [
        i ? text(" + ") : null,
        link(c.word.spelling, routes.word(c.word.spelling), { lang: "jbo" }),
      ])
      .flat()
      .filter(Boolean) as Node[];
    composition.append(
      ...words,
      text(` · ${compound.components.map((c) => c.rafsi).join(" + ")}`),
    );
  } else composition.hidden = true;
  // Rafsi line from claims.
  const claims: {
    assignment: string;
    status: string;
    claims: LoadedRecord<RafsiBody>[];
  }[] = [];
  for (const assignment of word.assignments) {
    const loaded: LoadedRecord<RafsiBody>[] = [];
    for (const claim of assignment.claims) {
      try {
        loaded.push(await loadRecord<RafsiBody>(claim, word.snapshot));
      } catch {}
    }
    claims.push({
      assignment: assignment.id,
      status: assignment.status,
      claims: loaded,
    });
  }
  if (!context.live()) return;
  rafsiLine.append(text("rafsi: "));
  if (!claims.length) rafsiLine.append(text("none yet", "meta"));
  else
    claims.forEach((entry, index) => {
      if (index) rafsiLine.append(text(", "));
      const spellingText =
        entry.claims.map((c) => c.body?.rafsi).find(Boolean) ??
        "unidentified claim";
      rafsiLine.append(
        link(spellingText, routes.rafsi(spellingText), {
          lang: "jbo",
          class: "rafsi",
        }),
      );
      if (entry.status !== "eligible")
        rafsiLine.append(text(` (${entry.status})`, "meta"));
    });
  rafsiLine.append(
    text(" · "),
    link("claim one", routes.claim(spelling), {
      style: "font-size:14px",
    }),
  );
  // Language tabs.
  const languages = [...byLanguage.keys()].sort();
  const active = languages.includes(requestedLanguage)
    ? requestedLanguage
    : "all";
  const tabs = el("nav", {
    class: "tabs",
    "aria-label": "Definition language",
  });
  for (const language of languages)
    tabs.append(
      link(null, routes.word(spelling, language), {
        class: "tab",
        "aria-current": active === language ? "true" : undefined,
      }),
    );
  for (const [index, language] of languages.entries())
    tabs.children[index].append(
      text(languageName(language)),
      text(String(byLanguage.get(language)!.length), "meta"),
    );
  const allTab = link(null, `${routes.word(spelling)}?lang=all`, {
    class: "tab",
    "aria-current": active === "all" ? "true" : undefined,
  });
  allTab.append(text("All"), text(String(word.definitions.length), "meta"));
  tabs.append(allTab);
  main.append(tabs);
  const personal = app.session.preferences.viewMode === "personal";
  // A refreshed calculation names the latest snapshot. The page then
  // fetches the word again, so content and scores come from one snapshot.
  const rerender = () => {
    const url = new URL(location.href);
    url.searchParams.set("fresh", "1");
    navigate(url.pathname + url.search, { replace: true });
  };
  if (personal)
    main.append(
      calculationPanel(app, {
        mode: "personal",
        label: "Personal view",
        onRefresh: rerender,
      }),
    );
  // Scores under the selected view. The personal view waits for the local calculation.
  const view = await viewScores(app, id, word);
  if (!context.live()) return;
  const own = app.session.preferences.myJudgmentsFirst
    ? await app.own.registers()
    : null;
  if (!context.live()) return;
  const myJudgmentsFirst = Boolean(own);
  if (view.personal && view.reason) {
    const note = p(
      `Personal scores are unavailable: ${view.reason} ${myJudgmentsFirst ? "Your judgments appear first, followed by event order." : "Definitions appear in event order."} No numeric score is assumed.`,
      "small",
    );
    if (view.stale)
      note.append(
        text(" "),
        button(
          "Recompute for this snapshot",
          () => {
            void app.personal
              .ensure({ mode: "personal", refresh: true })
              .then((status) => {
                if (status.state === "ready") rerender();
              });
          },
          { class: "btn btn-quiet" },
        ),
      );
    main.append(note);
  }
  main.append(provenanceLine(view));
  if (!personal) main.append(recomputePanel(app, id, word));
  // Definition order follows layers. Unranked definitions follow.
  const visible = new Set(
    active === "all" ? records.keys() : (byLanguage.get(active) ?? []),
  );
  const shown = new Set<string>();
  const ordered: { id: string; layer: number | null }[] = [];
  // Without a calculation the server makes no ranking claim. A calculation
  // from a profile this client does not know makes none that this client can
  // show. In both cases definitions follow event order.
  const unknownProfile =
    view.calculation !== null &&
    !describeProfile(view.calculation.algorithm).known;
  const rankedLayers =
    view.calculation === null || unknownProfile ? [] : view.layers;
  if (unknownProfile)
    main.append(
      p(
        `Scores and order from the calculation profile ${view.calculation!.algorithm} are not shown. This client does not know its route rule. ${myJudgmentsFirst ? "Your judgments appear first, followed by event order." : "Definitions appear in event order."}`,
        "small",
      ),
    );
  for (const [index, layer] of rankedLayers.entries())
    for (const definition of layer)
      if (visible.has(definition) && !shown.has(definition)) {
        shown.add(definition);
        ordered.push({ id: definition, layer: index });
      }
  for (const definition of word.definitions)
    if (visible.has(definition) && !shown.has(definition))
      ordered.push({ id: definition, layer: null });
  if (app.session.preferences.myJudgmentsFirst) {
    if (own) {
      const hasJudgment = (definition: string): boolean => {
        const state = own?.judgments.get(definition);
        return Boolean(
          state?.known &&
          (state.conflicted || (state.value && state.value !== "clear")),
        );
      };
      ordered.sort(
        (a, b) =>
          (a.layer ?? rankedLayers.length) - (b.layer ?? rankedLayers.length) ||
          Number(hasJudgment(b.id)) - Number(hasJudgment(a.id)),
      );
      main.append(
        p(
          "Definitions with your judgments appear first within each ranking layer and within the unranked group. Scores and ranking layers stay the same.",
          "meta",
        ),
      );
    } else {
      main.append(
        p(
          "Your judgments could not be loaded. Definitions follow ranking layers, then event order.",
          "meta",
        ),
      );
    }
  }
  const allRecords = [...records.values()];
  const statusOf = (definition: string) =>
    word.statuses.find((s) => s?.event === definition)?.state;
  if (
    word.definitions.length &&
    word.definitions.every((d) => statusOf(d) === "deprecated")
  )
    main.append(p("No active definitions in this snapshot.", "small"));
  const refresh = () => {
    void (async () => {
      try {
        await getWord(id, { fresh: true });
      } catch {}
    })();
  };
  let lastLayer: number | null = -1;
  for (const { id: definition, layer } of ordered) {
    const record = records.get(definition)!;
    const score = view.scores.find((s) => s.target === definition) ?? null;
    const unavailable =
      view.calculation === null ||
      view.unavailable_scores.includes(definition) ||
      !score;
    if (
      layer !== null &&
      layer !== lastLayer &&
      rankedLayers[layer].filter((d) => visible.has(d)).length > 1
    ) {
      const size = rankedLayers[layer].filter((d) => visible.has(d)).length;
      main.append(
        p(
          `${plural(size, "alternative")} with unresolved order. ${myJudgmentsFirst ? "Your judgments appear first within this layer." : "Presentation order follows event IDs."}`,
          "meta",
        ),
      );
    }
    lastLayer = layer;
    main.append(
      definitionBlock(app, record, {
        score,
        unavailable,
        personal: view.personal,
        reason: view.reason ?? undefined,
        status: statusOf(definition),
        calculation: view.calculation,
        secondary: layer !== null && layer > 0,
        revisions: allRecords,
        word,
        onChange: refresh,
      }),
    );
    if (layer === null && !(view.personal && view.reason) && !unknownProfile)
      main.lastElementChild!.append(
        p(
          `No ranking position is available for this definition in the ${view.personal ? "personal view layers" : "server layers"}.`,
          "meta",
        ),
      );
  }
  for (const [definition, failure] of failures)
    main.append(
      el(
        "div",
        { class: "definition" },
        p(
          `Definition ${definition.slice(0, 20)}… is unavailable: ${failure}`,
          "notice",
        ),
      ),
    );
  const after = el("div", { class: "after-definitions" });
  after.append(
    text("Know this word better?"),
    link(
      "Add a definition",
      `${routes.add}?word=${encodeURIComponent(spelling)}&lang=${encodeURIComponent(active === "all" ? app.session.preferences.definitionLanguage : active)}`,
      { class: "btn" },
    ),
    link(
      "Add a translation",
      `${routes.add}?word=${encodeURIComponent(spelling)}&translate=1`,
      { class: "btn btn-quiet" },
    ),
  );
  main.append(after);
  // Rafsi claims section.
  if (claims.length) {
    const section = el("section", { "aria-labelledby": "rafsi-h" });
    section.append(
      el("h2", { id: "rafsi-h", class: "section", text: "Rafsi claims" }),
    );
    for (const entry of claims) {
      const card = el("div", { class: "definition" });
      const rafsiSpelling =
        entry.claims.map((c) => c.body?.rafsi).find(Boolean) ?? "unidentified";
      card.append(
        el(
          "p",
          { class: "prose" },
          el("span", { lang: "jbo", class: "rafsi", text: rafsiSpelling }),
          text(` for ${spelling}`, "meta"),
        ),
      );
      const score =
        view.scores.find((s) => s.target === entry.assignment) ?? null;
      const unavailable =
        entry.status !== "eligible" ||
        view.unavailable_scores.includes(entry.assignment) ||
        !score;
      const byline = el("div", { class: "byline" });
      byline.append(
        text(
          `${entry.status === "eligible" ? "Eligible pair" : entry.status === "inactive" ? "Inactive pair" : "Pair status unknown"} · ${plural(entry.claims.length, "claim")}`,
          "meta",
        ),
        el("span", { class: "spacer" }),
      );
      const target = {
        id: entry.assignment,
        word: id,
        describe: (value: string) =>
          `${value === "bless" ? "Endorsing" : value === "curse" ? "Opposing" : "Clearing your judgment on"} rafsi ${rafsiSpelling} for ${spelling}`,
      };
      const judgmentOptions = {
        score,
        unavailable,
        personal: view.personal,
        reason: view.reason ?? undefined,
        calculation: view.calculation,
        large: true,
        onChange: refresh,
      };
      byline.append(
        judgmentControl(app, target, judgmentOptions),
        scoreDetails(app, target, judgmentOptions),
      );
      card.append(byline);
      card.append(
        p(
          "One judgment applies to this word and rafsi pair across all its publishers.",
          "meta",
        ),
      );
      for (const claim of entry.claims) {
        const row = el("div", {
          class: "small claim-source",
          style: "margin-top:8px",
        });
        row.append(
          text("Claimed by "),
          identityLink(claim.envelope.header.issuer),
          text(" · "),
          link("record", routes.definition(claim.envelope.id), {
            class: "touch-link",
          }),
        );
        if (claim.body?.rationale.length)
          row.append(renderRichText(claim.body.rationale, { placeHref: null }));
        card.append(row);
      }
      section.append(card);
    }
    main.append(section);
  }
  // See also: component words and derivation sources.
  const related = new Set<string>();
  for (const record of allRecords) {
    for (const component of record.body?.etymology.compound?.components ?? [])
      related.add(component.word.spelling);
    for (const place of record.body?.frame?.places ?? [])
      for (const d of place.derivation) related.add(d.word.spelling);
    for (const paragraph of record.body?.text ?? [])
      for (const node of paragraph)
        if (typeof node === "object" && node && "word" in node)
          related.add(node.word.spelling);
  }
  related.delete(spelling);
  if (related.size) {
    const section = el("section", {
      "aria-labelledby": "rel-h",
      style: "padding-top:20px",
    });
    section.append(
      el("h2", {
        id: "rel-h",
        class: "section",
        style: "margin-top:0",
        text: "See also",
      }),
    );
    const line = el("p", { class: "muted" });
    [...related].sort().forEach((s, i) => {
      if (i) line.append(text(" · "));
      line.append(link(s, routes.word(s), { lang: "jbo" }));
    });
    section.append(line);
    main.append(section);
  }
  void disclosure;
  void RequestError;
}
