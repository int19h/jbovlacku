import { kindLabel } from "../model/types.ts";
/**
 * The word page: headword, composition, rafsi line, language tabs, and one
 * block per definition in layer order under the selected view.
 */
import { wordId } from "../../../../packages/core/src/browser.ts";
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
import {
  listedLanguage,
  languageName,
  plural,
  rationalSign,
} from "../lib/format.ts";
import { nullOnSpellingRefusal } from "../lib/core-error.ts";
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
  hasPendingMaterialization,
  MaterializationPendingError,
  type LoadedRecord,
} from "../data/api.ts";
import {
  wordIdValid,
  type DefinitionBody,
  type RafsiBody,
  type WordResponse,
} from "../model/types.ts";
import {
  definitionBlock,
  updateDefinitionScore,
} from "../components/definition.ts";
import {
  personalReasonText,
  scoreSlot,
  type ScoreSlot,
} from "../components/judgment.ts";
import { identityLink } from "../components/attribution.ts";
import { renderRichText } from "../model/richtext.ts";
import { zbalermorna } from "../lib/zbalermorna.ts";
import {
  calculationPanel,
  provenanceLine,
  staleReason,
  viewScores,
  type ViewScores,
} from "../components/localview.ts";
import { recomputePanel } from "../components/recompute.ts";
import { describeProfile } from "../model/profiles.ts";
import { appendReadRetry } from "../components/readretry.ts";
import { onDisconnect } from "../lib/lifetime.ts";

export async function wordPage(route: Route, context: RenderContext, app: App) {
  const { main } = context;
  main.className = "surface-word";
  const key: string = route.segments[1] ?? "";
  const isId: boolean = /^jvw1:[0-9a-f]{64}$/.test(key);
  const spellingHint = isId ? null : key.normalize("NFC");
  let id: string;
  if (isId) id = key;
  else {
    // Only the core's spelling refusal names no word. Any other failure
    // from the core is rethrown and reported as itself.
    const resolved = nullOnSpellingRefusal(() =>
      wordId({ language: "jbo", spelling: spellingHint! }),
    );
    if (resolved === null) {
      main.className = "";
      context.title("Page unavailable");
      main.append(
        el("h1", { class: "page", text: "Page unavailable" }),
        p(
          "This link does not name a word. Use the search field or the links above to return to the dictionary.",
          "notice",
        ),
      );
      return;
    }
    id = resolved;
  }
  const requestedLanguage =
    route.params.get("lang") ?? app.session.preferences.definitionLanguage;
  context.title(spellingHint ?? "Word");
  const waiting = route.params.has("fresh") && hasPendingMaterialization();
  const pendingNotice = waiting
    ? p("This server stored your records. Its word view is updating.", "notice")
    : null;
  if (pendingNotice) main.append(pendingNotice);
  let word: WordResponse;
  try {
    word = await getWord(id, {
      signal: context.signal,
      fresh: route.params.has("fresh"),
    });
  } catch (error) {
    if (!context.live()) return;
    pendingNotice?.remove();
    main.append(
      el("h1", { class: "page", text: spellingHint ?? "Word" }),
      p(describe(error), "notice"),
    );
    if (error instanceof MaterializationPendingError) {
      main.append(
        button(
          "Refresh the word",
          () => {
            navigate(
              `${routes.word(spellingHint ?? id, requestedLanguage)}&fresh=1`,
            );
          },
          { class: "btn" },
        ),
      );
      return;
    }
    if (appendReadRetry(main, error, context, app.announce)) return;
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
  pendingNotice?.remove();
  if (waiting) app.own.invalidate();
  const spelling = word.word?.spelling ?? spellingHint ?? "Word unavailable";
  context.title(spelling);
  // Input from the reader since the first word controls appeared. Any of
  // it means that the reader has started to read or act, so a settled
  // calculation does not move the definitions by itself. Tracking starts
  // before the definitions load, so a press or key during that load counts.
  let input = false;
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart"])
    window.addEventListener(type, () => (input = true), {
      capture: true,
      passive: true,
      signal: context.signal,
    });
  // A press in progress. An update waits for its release, so the layout
  // under the pointer does not change before the click completes. Only a
  // primary press can start a click. A press can also end without a
  // release on the page: a context menu, or a switch to another window or
  // tab. Each of those ends the press too.
  let pressed = false;
  let released: (() => void)[] = [];
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button === 0) pressed = true;
    },
    { capture: true, signal: context.signal },
  );
  const endPress = () => {
    if (!pressed) return;
    pressed = false;
    const waiting = released;
    released = [];
    // After the click that this release completes.
    setTimeout(() => waiting.forEach((resolve) => resolve()), 0);
  };
  for (const type of ["pointerup", "pointercancel", "contextmenu"])
    window.addEventListener(type, endPress, {
      capture: true,
      signal: context.signal,
    });
  // Only the window's own blur. A blur of an element inside the page is a
  // focus move, and a press moves focus.
  window.addEventListener(
    "blur",
    (event) => {
      if (event.target === window) endPress();
    },
    { signal: context.signal },
  );
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.hidden) endPress();
    },
    { signal: context.signal },
  );
  const pressFinished = () =>
    pressed
      ? new Promise<void>((resolve) => released.push(resolve))
      : Promise.resolve();
  const head = el("div", { class: "word-head" });
  const h1 = el("h1", { lang: "jbo", text: spelling });
  head.append(h1);
  const conversion = route.params.get("conversion");
  if (conversion && ["se", "te", "ve", "xe"].includes(conversion))
    head.append(p(`${conversion} ${spelling}`, "hw"));
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
  const composition = el("p", {
    class: "muted composition-line",
    style: "margin-top:6px",
  });
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
      .filter((kind) => kind !== undefined),
  );
  kindTag.textContent = [...kinds].map(kindLabel).join(" · ");
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
  } else if (
    [...kinds].includes("lujvo") &&
    failures.size === 0 &&
    [...records.values()].every((record) => record.body)
  ) {
    // A lujvo without the structured compound field has no composition that
    // this page can show as words and rafsi. The line names only that
    // missing field. A definition's etymology text can still describe the
    // composition, so the line then points to it. A definition that did not
    // load, or has no body, could hold either, so the line then says
    // nothing.
    const described = [...records.values()].some(
      (record) =>
        record.body &&
        (record.body.etymology.text.length || record.body.etymology.formation),
    );
    composition.append(
      text(
        described
          ? "No structured composition is recorded for this lujvo. See Etymology in its definitions."
          : "No structured composition is recorded for this lujvo.",
        "meta",
      ),
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
  const languages = [...byLanguage.keys()]
    .filter((tag) => tag === requestedLanguage || listedLanguage(tag))
    .sort();
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
  // On a phone the tab strip scrolls sideways. Bring the selected tab into
  // the strip without moving the window or focus.
  const showCurrentTab = () => {
    const current = tabs.querySelector<HTMLElement>('[aria-current="true"]');
    if (!current || tabs.scrollWidth <= tabs.clientWidth) return;
    const strip = tabs.getBoundingClientRect();
    const tab = current.getBoundingClientRect();
    if (tab.left < strip.left) tabs.scrollLeft -= strip.left - tab.left;
    else if (tab.right > strip.right)
      tabs.scrollLeft += tab.right - strip.right;
  };
  showCurrentTab();
  requestAnimationFrame(showCurrentTab);
  // A resize or a rotation can turn the wrapped tabs into the one-row strip,
  // or make the strip narrower. Each time its width changes, a selected tab
  // outside the strip is brought into it again.
  let stripWidth = tabs.clientWidth;
  const stripWatch = new ResizeObserver(() => {
    if (tabs.clientWidth === stripWidth) return;
    stripWidth = tabs.clientWidth;
    showCurrentTab();
  });
  stripWatch.observe(tabs);
  onDisconnect(tabs, () => stripWatch.disconnect(), context.signal);
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
        context,
        label: "Personal view",
        includeSnapshot: false,
        expected: { snapshot: word.snapshot, view: word.view },
        onRefresh: rerender,
      }),
    );
  // Scores under the selected view. In the personal view the definitions
  // render at once while the local calculation runs. When it settles, the
  // page updates in place: every definition, control and disclosure stays,
  // and only the scores, the notes and, while the reader has not started
  // to read, the order change.
  const viewPromise = viewScores(app, id, word);
  const status = app.personal.status;
  // A cancel is settled: no automatic call restarts it, so the page shows
  // its reason with every control, as for any settled state. After any
  // other failure, viewScores has already started a new calculation, so
  // the old failure is not the current state, and the page is provisional
  // until that calculation settles.
  const cancelled =
    personal && status.state === "failed" && status.kind === "cancelled";
  const provisional = personal && status.state !== "ready" && !cancelled;
  // In both cases the page renders before viewScores settles.
  const early = provisional || cancelled;
  let view: ViewScores;
  if (early) {
    view = {
      personal: true,
      reason:
        status.state === "failed" && cancelled
          ? status.message
          : "The local calculation is not ready yet.",
      stale: false,
      snapshot: word.snapshot,
      view: word.view,
      calculation: null,
      scores: [],
      layers: [],
      unavailable_scores: [],
    };
  } else view = await viewPromise;
  if (!context.live()) return;
  const own = app.session.preferences.myJudgmentsFirst
    ? await app.own.registers()
    : null;
  if (!context.live()) return;
  // This tab has no key, but another tab can save one after this tab
  // started. Read the saved key before saying that the browser has none.
  // Null means that the read failed.
  let keySavedLater: boolean | null = false;
  if (
    app.session.preferences.myJudgmentsFirst &&
    !own &&
    !app.session.identity &&
    app.session.storageAvailable
  ) {
    try {
      keySavedLater = Boolean(await app.store.get("keys", "selected"));
    } catch {
      keySavedLater = null;
    }
    if (!context.live()) return;
  }
  const myJudgmentsFirst = Boolean(own);
  const statusOf = (definition: string) =>
    word.statuses.find((s) => s?.event === definition)?.state;
  // The part of the page that depends on scores. It is built once. A
  // settled calculation updates it in place.
  const part = el("div", { class: "word-scored" });
  main.append(part);
  // The current reason for unavailable personal scores. The page reads it
  // when it builds each score, and the note's listener keeps it current.
  const live = { reason: view.reason ?? undefined, stale: view.stale };
  let staleLine: HTMLElement | null = null;
  const staleNote =
    "The local calculation uses another snapshot or view. Recompute from records for these definitions.";
  const unavailableTitle = "Score unavailable in the personal view.";
  /** The reason that a calculation status gives, or null for a ready one for this snapshot. */
  const statusReason = (
    status: typeof app.personal.status,
  ): { reason: string; stale: boolean } | null => {
    if (status.state === "ready")
      return status.snapshot === word.snapshot && status.view === word.view
        ? null
        : { reason: staleReason(status, word), stale: true };
    if (status.state === "failed")
      return { reason: status.message, stale: false };
    return {
      reason:
        status.state === "idle"
          ? "No local calculation yet."
          : "The local calculation is not ready yet.",
      stale: false,
    };
  };
  let note: HTMLElement | null = null;
  let showNote: ((reason: string, stale: boolean) => void) | null = null;
  /**
   * Says that the calculation settled, for a note that stays while it has
   * focus: that scores are shown, or, when the page displays no score, that
   * the calculation finished.
   */
  let noteShown: ((scoresShown: boolean) => void) | null = null;
  if (view.personal && view.reason) {
    const shown = p("", "small");
    note = shown;
    const noteText = text("");
    shown.append(noteText);
    let recompute: HTMLButtonElement | null = null;
    // The note follows the live calculation state, like the panel above it.
    // A later failure, cancel, or retry replaces the reason instead of
    // leaving the first reason beside a panel that says another. The text
    // changes in place, and the recompute button, once shown, stays in the
    // document, so a reader who activated it keeps focus on it.
    showNote = (reason: string, stale: boolean) => {
      noteText.textContent = `Personal scores are unavailable: ${reason} ${myJudgmentsFirst ? "Your judgments appear first, followed by event order." : "Definitions appear in event order."} No numeric score is assumed.`;
      if (stale && !recompute) {
        recompute = button(
          "Recompute for this snapshot",
          () => {
            void app.personal
              .ensure({ mode: "personal", refresh: true })
              .then((status) => {
                if (status.state === "ready") rerender();
              });
          },
          { class: "btn btn-quiet" },
        );
        shown.append(text(" "), recompute);
      }
    };
    showNote(view.stale ? staleNote : view.reason, view.stale);
    noteShown = (scoresShown) => {
      showNote = null;
      noteText.textContent = scoresShown
        ? "Personal scores for this snapshot are shown."
        : "The personal calculation for this snapshot finished.";
    };
    part.append(shown);
    // Every place that states the reason follows the current status: the
    // note, the "Source and scores" line, and the score titles and details.
    // The first call reconciles a status that changed while the page read
    // the reader's own history. The listener ends when the note leaves the
    // page, for example when scores arrive.
    onDisconnect(
      shown,
      app.personal.subscribe((status) => {
        // A note kept for focus after the scores arrived follows no status.
        if (!context.live() || !showNote) return;
        const current = statusReason(status);
        // A ready calculation for this snapshot: the page's own read gives
        // its reason, which can be specific to this word. The settled read
        // updates the page.
        if (!current) return;
        const { reason, stale } = current;
        live.reason = reason;
        live.stale = stale;
        showNote?.(stale ? staleNote : reason, stale);
        if (staleLine) {
          staleLine.textContent = reason;
          staleLine.hidden = !stale;
        }
        for (const score of part.querySelectorAll<HTMLElement>(
          ".judgment .score.unavailable",
        ))
          if (score.title.startsWith(unavailableTitle))
            score.title = `${unavailableTitle} ${reason}`;
        // An open "Score details" disclosure keeps its place, its controls,
        // and focus. Only its reason text changes.
        for (const text of part.querySelectorAll<HTMLElement>(
          "details.judgment-details [data-personal-reason]",
        ))
          text.textContent = personalReasonText(reason);
      }),
    );
  }
  if (!view.personal && view.calculation === null)
    part.append(
      p("Ranking is unavailable for this word. No score is assumed.", "small"),
    );
  const provenance = provenanceLine(view, false);
  const sourceDetails = el(
    "details",
    { class: "disclosure word-source", "data-key": "word-source" },
    el("summary", {}, icon("chevron", "chev"), "Source and scores"),
    el(
      "div",
      { class: "body" },
      provenance,
      view.personal && view.reason
        ? (staleLine = el("p", {
            class: "small",
            text: live.stale ? (live.reason ?? "") : "",
            hidden: !live.stale,
          }))
        : null,
      personal ? null : recomputePanel(app, id, word),
    ),
  );
  const visible = new Set(
    active === "all" ? records.keys() : (byLanguage.get(active) ?? []),
  );
  // Without a calculation the server makes no ranking claim. A calculation
  // from a profile this client does not know makes none that this client can
  // show. In both cases definitions follow event order.
  const unknownProfileOf = (v: ViewScores) =>
    v.calculation !== null && !describeProfile(v.calculation.algorithm).known;
  const hasJudgment = (definition: string): boolean => {
    const state = own?.judgments.get(definition);
    return Boolean(
      state?.known &&
      (state.conflicted || (state.value && state.value !== "clear")),
    );
  };
  /** Definition order under one view: layers first, then unranked definitions. */
  const orderOf = (v: ViewScores) => {
    const unknownProfile = unknownProfileOf(v);
    const rankedLayers =
      v.calculation === null || unknownProfile ? [] : v.layers;
    const shown = new Set<string>();
    const ordered: { id: string; layer: number | null }[] = [];
    for (const [index, layer] of rankedLayers.entries())
      for (const definition of layer)
        if (visible.has(definition) && !shown.has(definition)) {
          shown.add(definition);
          ordered.push({ id: definition, layer: index });
        }
    for (const definition of word.definitions)
      if (visible.has(definition) && !shown.has(definition))
        ordered.push({ id: definition, layer: null });
    if (own)
      ordered.sort(
        (a, b) =>
          (a.layer ?? rankedLayers.length) - (b.layer ?? rankedLayers.length) ||
          Number(hasJudgment(b.id)) - Number(hasJudgment(a.id)),
      );
    return { ordered, rankedLayers, unknownProfile };
  };
  const profileNote = (v: ViewScores) =>
    p(
      `Scores and order from the calculation profile ${v.calculation!.algorithm} are not shown. This client does not know its route rule. ${myJudgmentsFirst ? "Your judgments appear first, followed by event order." : "Definitions appear in event order."}`,
      "small",
    );
  const profileSlot = el("div", { class: "word-profile-note" });
  if (unknownProfileOf(view)) profileSlot.append(profileNote(view));
  part.append(profileSlot);
  // The judgments-first note. Its last sentence describes the order on
  // screen, so it follows the view that the definitions are arranged by:
  // while the reader keeps the order from before the scores, it says event
  // order, and it names the ranking layers once they apply.
  const judgmentsNote = app.session.preferences.myJudgmentsFirst
    ? p("", "meta")
    : null;
  // Without a key there are no judgments of yours, which is not a failure.
  const judgmentsReason = own
    ? ""
    : app.session.identity ||
        !app.session.storageAvailable ||
        keySavedLater === null
      ? "Your judgments could not be loaded."
      : keySavedLater
        ? "This tab has not loaded the key that is now saved in this browser. Reload the page to put your judgments first."
        : "You have no key in this browser, so no judgments of yours change this order.";
  // The explanation and the order sentence are separate text nodes. Only
  // the order sentence changes, and only when its wording does, so a
  // selection in the explanation stays.
  const orderText = document.createTextNode("");
  if (judgmentsNote) {
    if (judgmentsReason) judgmentsNote.append(text(`${judgmentsReason} `));
    judgmentsNote.append(orderText);
  }
  const describeOrder = (v: ViewScores) => {
    if (!judgmentsNote) return;
    const ranked = v.calculation !== null && !unknownProfileOf(v);
    const sentence = own
      ? ranked
        ? "Definitions with your judgments appear first within each ranking layer and within the unranked group. Scores and ranking layers stay the same."
        : "Definitions with your judgments appear first, followed by event order."
      : ranked
        ? "Definitions follow ranking layers, then event order."
        : "Definitions appear in event order.";
    if (orderText.data !== sentence) orderText.data = sentence;
  };
  if (judgmentsNote) part.append(judgmentsNote);
  const allRecords = [...records.values()];
  if (
    word.definitions.length &&
    word.definitions.every((d) => statusOf(d) === "deprecated")
  )
    part.append(p("No active definitions in this snapshot.", "small"));
  // A note that offers the score order after the reader has started
  // reading, and the list of definitions with their layer notes.
  const orderSlot = el("div", { class: "word-order-note" });
  const list = el("div", { class: "definition-list" });
  part.append(orderSlot, list);
  const refresh = () => {
    void (async () => {
      try {
        await getWord(id, { fresh: true });
      } catch {}
    })();
  };
  const scoreFor = (v: ViewScores, target: string) => {
    const score = v.scores.find((s) => s.target === target) ?? null;
    return {
      score,
      unavailable:
        v.calculation === null ||
        v.unavailable_scores.includes(target) ||
        !score,
      calculation: v.calculation,
    };
  };
  // One block per visible definition, built once.
  const blocks = new Map<string, HTMLElement>();
  for (const { id: definition } of orderOf(view).ordered) {
    const block = definitionBlock(app, records.get(definition)!, {
      ...scoreFor(view, definition),
      personal: view.personal,
      get reason() {
        return live.reason;
      },
      status: statusOf(definition),
      revisions: allRecords,
      word,
      onChange: refresh,
      // Score details show reviewers, which a provisional render does not
      // know yet. The update adds them.
      deferScoreDetails: provisional,
    });
    block.dataset.key = definition;
    blocks.set(definition, block);
  }
  const layerNote = (
    v: ViewScores,
    rankedLayers: string[][],
    layer: number,
  ): HTMLElement | null => {
    const members = rankedLayers[layer].filter((d) => visible.has(d));
    const size = members.length;
    if (size < 2) return null;
    // The ranking puts every deprecated definition into one last layer
    // without comparing them. Other layers come from pairwise comparisons:
    // either no member is certified ahead of another, or the comparisons
    // form a cycle. This client cannot tell those two apart, so it states
    // only what holds for both.
    const deprecated = rankedLayers[layer].every(
      (d) => statusOf(d) === "deprecated",
    );
    const layerScores = members
      .map((d) => v.scores.find((s) => s.target === d))
      .filter((s) => s !== undefined);
    const allZero =
      layerScores.length === size &&
      layerScores.every(
        (s) => rationalSign(s.net[0]) === 0 && rationalSign(s.net[1]) === 0,
      );
    const why = deprecated
      ? "Deprecated definitions are not ranked against each other."
      : `The pairwise comparisons do not put the definitions in this group in one order.${allZero ? " Every score in this group is zero." : ""}`;
    return p(
      `${plural(size, "alternative")} with unresolved order. ${why} ${myJudgmentsFirst ? "Your judgments appear first within this layer." : "Presentation order follows event IDs."}`,
      "meta layer-note",
    );
  };
  const currentOrder = () =>
    [...list.children]
      .map((n) => (n as HTMLElement).dataset.key)
      .filter((key): key is string => key !== undefined);
  /**
   * Puts the definitions in the order of one view, with its layer notes.
   * Existing nodes move; none is rebuilt. The node that holds focus never
   * leaves the document: the others move around it.
   */
  const arrange = (v: ViewScores) => {
    describeOrder(v);
    const { ordered, rankedLayers, unknownProfile } = orderOf(v);
    const sequence: HTMLElement[] = [];
    let lastLayer: number | null = -1;
    for (const { id: definition, layer } of ordered) {
      if (layer !== null && layer !== lastLayer) {
        const noteNode = layerNote(v, rankedLayers, layer);
        if (noteNode) sequence.push(noteNode);
      }
      lastLayer = layer;
      const block = blocks.get(definition)!;
      block.classList.toggle("secondary", layer !== null && layer > 0);
      block.querySelector(":scope > .no-rank")?.remove();
      if (layer === null && !(v.personal && v.reason) && !unknownProfile)
        block.append(
          p(
            `No ranking position is available for this definition in the ${v.personal ? "personal view layers" : "server layers"}.`,
            "meta no-rank",
          ),
        );
      sequence.push(block);
    }
    const keep = new Set<Node>(sequence);
    for (const child of [...list.children])
      if (!keep.has(child)) child.remove();
    // No definition loaded. The list stays empty, and the failure notices
    // after it say why.
    if (!sequence.length) return;
    const focusedNode = document.activeElement;
    let at = sequence.findIndex(
      (n) => focusedNode !== null && n.contains(focusedNode),
    );
    if (at < 0) {
      at = 0;
      if (list.firstChild !== sequence[0]) list.prepend(sequence[0]);
    }
    for (let i = at - 1; i >= 0; i--)
      if (sequence[i].nextSibling !== sequence[i + 1])
        list.insertBefore(sequence[i], sequence[i + 1]);
    for (let i = at + 1; i < sequence.length; i++)
      if (sequence[i - 1].nextSibling !== sequence[i])
        list.insertBefore(sequence[i], sequence[i - 1].nextSibling);
  };
  arrange(view);
  for (const [definition, failure] of failures)
    part.append(
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
  part.append(after);
  // Rafsi claims section.
  const rafsiSlots: {
    assignment: string;
    eligible: boolean;
    slot: ScoreSlot;
  }[] = [];
  if (claims.length) {
    const section = el("section", { "aria-labelledby": "rafsi-h" });
    section.append(
      el("h2", { id: "rafsi-h", class: "section", text: "Rafsi claims" }),
    );
    for (const entry of claims) {
      const card = el("div", { class: "definition" });
      card.dataset.key = entry.assignment;
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
      const eligible = entry.status === "eligible";
      const scored = scoreFor(view, entry.assignment);
      const byline = el("div", { class: "byline" });
      byline.append(
        text(
          `${eligible ? "Eligible pair" : entry.status === "inactive" ? "Inactive pair" : "Pair status unknown"} · ${plural(entry.claims.length, "claim")}`,
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
        ...scored,
        unavailable: !eligible || scored.unavailable,
        personal: view.personal,
        get reason() {
          return live.reason;
        },
        large: true,
        onChange: refresh,
      };
      rafsiSlots.push({
        assignment: entry.assignment,
        eligible,
        // As for definitions, score details wait for known scores.
        slot: scoreSlot(app, target, judgmentOptions, byline, provisional),
      });
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
    part.append(section);
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
    const line = el("p", { class: "muted related-words" });
    [...related].sort().forEach((s, i) => {
      if (i) line.append(text(" · "));
      line.append(link(s, routes.word(s), { lang: "jbo" }));
    });
    section.append(line);
    part.append(section);
  }
  part.append(sourceDetails);
  /** Whether the reader has started to read or act in the scored part. */
  const readerStarted = () => {
    const selection = getSelection();
    return (
      input ||
      (document.activeElement !== null &&
        part.contains(document.activeElement)) ||
      Boolean(selection && selection.rangeCount && !selection.isCollapsed) ||
      part.getBoundingClientRect().top < 0
    );
  };
  if (early)
    void viewPromise.then(async (settled) => {
      if (!context.live() || !part.isConnected) return;
      // A cancel settles with the same reason. Nothing changes then.
      if (!settled.calculation && settled.reason === view.reason) return;
      await pressFinished();
      if (!context.live() || !part.isConnected) return;
      view = settled;
      let keptNote = false;
      // A read that ended without scores can be older than the status: a
      // retry may have failed differently since. The status then gives the
      // reason, as the note's listener does.
      const current = settled.calculation
        ? null
        : statusReason(app.personal.status);
      live.reason = current?.reason ?? settled.reason ?? undefined;
      live.stale = current?.stale ?? settled.stale;
      if (settled.personal && live.reason) {
        showNote?.(live.stale ? staleNote : live.reason, live.stale);
        for (const text of part.querySelectorAll<HTMLElement>(
          "details.judgment-details [data-personal-reason]",
        ))
          text.textContent = personalReasonText(live.reason);
      } else {
        // Scores are known. The note leaves the page, which ends its
        // listener.
        // A reader who has focus in it keeps the note until focus leaves.
        const done = note;
        note = null;
        // Its text changes at once, after the scores below are drawn.
        if (done?.contains(document.activeElement)) {
          keptNote = true;
          done.addEventListener("focusout", () => done.remove(), {
            once: true,
          });
        } else done?.remove();
      }
      // The line changes in place. Its leading parts keep their nodes
      // while their text is the same, so a selection in them stays.
      const kept = [...provenance.childNodes];
      const fresh = [...provenanceLine(settled, false).childNodes];
      let unchanged = 0;
      while (
        unchanged < kept.length &&
        unchanged < fresh.length &&
        kept[unchanged].isEqualNode(fresh[unchanged])
      )
        unchanged++;
      for (const node of kept.slice(unchanged)) node.remove();
      provenance.append(...fresh.slice(unchanged));
      if (staleLine) {
        staleLine.textContent = live.stale ? (live.reason ?? "") : "";
        staleLine.hidden = !live.stale;
      }
      profileSlot.replaceChildren(
        ...(unknownProfileOf(settled) ? [profileNote(settled)] : []),
      );
      // Scores change in place. Controls, focus and actions in flight stay.
      for (const [definition, block] of blocks)
        updateDefinitionScore(block, scoreFor(settled, definition));
      for (const { assignment, eligible, slot } of rafsiSlots) {
        const scored = scoreFor(settled, assignment);
        slot.update({
          ...scored,
          unavailable: !eligible || scored.unavailable,
        });
      }
      if (keptNote)
        noteShown?.(
          part.querySelector(".judgment .score:not(.unavailable)") !== null,
        );
      const order = orderOf(settled).ordered.map((o) => o.id);
      const same = order.join(" ") === currentOrder().join(" ");
      if (same || !readerStarted()) {
        arrange(settled);
        return;
      }
      // The reader has started to read. The definitions stay where they
      // are, and the reader can choose the score order.
      const offer = p("Personal scores changed the order. ", "small");
      offer.append(
        button(
          "Show in score order",
          () => {
            arrange(view);
            // The definition itself takes focus, so the focus ring is
            // visible. Its heading names it.
            const first = list.querySelector<HTMLElement>("article.definition");
            // A pointer click does not match :focus-visible, so a class
            // draws the ring after either kind of activation. Both end when
            // focus leaves the definition.
            if (first) {
              first.tabIndex = -1;
              first.classList.add("focus-ring");
              first.addEventListener(
                "blur",
                () => {
                  first.removeAttribute("tabindex");
                  first.classList.remove("focus-ring");
                },
                { once: true },
              );
              first.focus();
            }
            orderSlot.replaceChildren();
          },
          { class: "btn btn-quiet" },
        ),
      );
      orderSlot.replaceChildren(offer);
    });
  void disclosure;
  void RequestError;
}
