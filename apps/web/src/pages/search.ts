import { meaningSearchGroup } from "../components/meaning-search.ts";
import {
  matchGroup,
  type SearchGroup,
} from "../../../../packages/search/src/index.ts";
import { naturalLanguageNote } from "../../../../packages/search/src/pattern.ts";
import {
  searchPackage,
  PackageValidationError,
  type PackageSearchResult,
} from "../data/package-search.ts";
import { kindLabel } from "../model/types.ts";
import { isPatternQuery } from "../../../../packages/search/src/index.ts";
/**
 * Search results. The header holds the query. The page shows a count line,
 * the definition-language select, and compact three-line rows.
 */
import {
  el,
  link,
  p,
  text,
  button,
  checkbox,
  describe,
  append,
} from "../lib/dom.ts";
import { languageName, placeGlyph, plural } from "../lib/format.ts";
import {
  navigate,
  rememberState,
  routes,
  type RenderContext,
  type Route,
} from "../app/router.ts";
import type { App } from "../app/context.ts";
import {
  downloadPackage,
  isV2,
  type CachedPackage,
  type LocalHit,
} from "../data/search.ts";
import {
  getManifest,
  getPreferredView,
  getWord,
  loadDefinition,
  remoteSearch,
  selfPeer,
  TransportError,
} from "../data/api.ts";
import type {
  DefinitionBody,
  SearchHit,
  WordResponse,
} from "../model/types.ts";
import { calculationPanel, viewScores } from "../components/localview.ts";
import { judgmentControl, scoreDetails } from "../components/judgment.ts";
import {
  attribution,
  identityLink,
  sourceDate,
} from "../components/attribution.ts";
import { zbalermorna } from "../lib/zbalermorna.ts";
import { placeMarker } from "../model/richtext.ts";
import { appendReadRetry } from "../components/readretry.ts";

const PAGE_SIZE = 20;
const RESULT_LIMIT = 1000;
const disclosedSearchSessions = new WeakSet<App["session"]>();
interface SearchState {
  query: string;
  language: string;
  source: "local" | "remote";
  snapshot: string;
  view: string | null;
  /**
   * The reader's view choice when the results were fetched: a signed view ID,
   * or null for the server's view. Results are restored only under the same
   * choice. Older saved state without this field is not restored.
   */
  choice?: string | null;
  groups: Record<
    SearchGroup,
    { hits: SearchHit[]; next: string | null; cursors: string[] }
  >;
  allLojban: boolean;
  complete: boolean;
  segmentation?: "complete" | "limited";
}
/**
 * Appends plain text with the query highlighted. Every character stays
 * literal. A circled numeral in plain text is text, because plain text cannot
 * say whether it was a place reference. Markers come from the signed body.
 */
function appendHighlighted(node: HTMLElement, value: string, query: string) {
  const q = query.toLocaleLowerCase("en");
  for (const part of [value]) {
    if (!part) continue;
    const lower = part.toLocaleLowerCase("en");
    let index = 0;
    for (;;) {
      const found = q ? lower.indexOf(q, index) : -1;
      if (found === -1) break;
      if (found > index)
        node.append(el("bdi", { text: part.slice(index, found) }));
      node.append(el("mark", { text: part.slice(found, found + q.length) }));
      index = found + q.length;
    }
    if (index < part.length)
      node.append(el("bdi", { text: part.slice(index) }));
  }
}
/** A preview from plain text. Literal, with the query highlighted. */
function previewText(value: string, query: string): HTMLElement {
  const node = el("p", { class: "text" });
  appendHighlighted(node, value, query);
  return node;
}
/**
 * A preview from the signed rich text. Only a structured place node becomes
 * a marker. Links, code, and operands show their text without markup.
 */
function previewRich(
  node: HTMLElement,
  paragraphs: DefinitionBody["text"],
  query: string,
) {
  node.replaceChildren();
  paragraphs.forEach((paragraph, index) => {
    if (index) node.append(text(" "));
    for (const item of paragraph) {
      if (typeof item === "string") appendHighlighted(node, item, query);
      else if (typeof item === "number") node.append(placeMarker(item, null));
      else if ("label" in item) appendHighlighted(node, item.label, query);
      else if ("code" in item) node.append(el("code", { text: item.code }));
      else if ("operand" in item)
        node.append(el("span", { class: "operand", text: item.operand }));
    }
  });
}
export async function searchPage(
  route: Route,
  context: RenderContext,
  app: App,
) {
  const { main } = context;
  const query = route.params.get("q") ?? "";
  const language =
    route.params.get("lang") ??
    route.params.get("language") ??
    app.session.preferences.definitionLanguage;
  const includeRetired = route.params.get("retired") === "1";
  context.title(query ? `Search: ${query}` : "Search");
  main.className = "surface-search";
  main.append(
    el("h1", { class: "sr", text: query ? `Search: ${query}` : "Search" }),
  );
  const countLine = el("div", { class: "count-line" });
  const count = el("p", { class: "count", "aria-live": "polite", text: "" });
  const languageSelect = el("select", {
    class: "inline-select",
    "aria-label": "Definition language",
  });
  countLine.append(
    count,
    el(
      "label",
      {},
      el("span", { class: "sr", text: "Definition language" }),
      languageSelect,
    ),
  );
  const results = el("section", { "aria-label": "Search results" });
  const missing = el("div", { class: "missing-line" });
  main.append(countLine);
  // In the personal view the rows score from the local calculation. Its
  // state and its refresh action stay visible beside the results.
  if (app.session.preferences.viewMode === "personal")
    main.append(
      calculationPanel(app, {
        mode: "personal",
        context,
        label: "Personal view",
        onRefresh: () =>
          navigate(location.pathname + location.search, { replace: true }),
      }),
    );
  main.append(results, missing);
  // Language options come from the manifest and the cached packages.
  const languages = new Set<string>([language, "en"]);
  const packageKeys = app.session.storageAvailable
    ? await app.store.keys("packages").catch(() => [])
    : [];
  for (const key of packageKeys) languages.add(key);
  const fillLanguages = () => {
    languageSelect.replaceChildren();
    for (const tag of [...languages].sort())
      languageSelect.append(
        el("option", {
          value: tag,
          text: languageName(tag),
          selected: tag === language,
        }),
      );
  };
  fillLanguages();
  let languageRequest = 0;
  languageSelect.addEventListener("change", async () => {
    const request = ++languageRequest;
    const value = languageSelect.value;
    try {
      await app.session.setPreferences({
        definitionLanguage: value,
      });
    } catch {
      if (context.live() && request === languageRequest)
        languageSelect.value = app.session.preferences.definitionLanguage;
      return;
    }
    if (context.live() && request === languageRequest)
      navigate(routes.search(query, value));
  });
  const punctuationNote = naturalLanguageNote(query);
  if (punctuationNote) main.append(p(punctuationNote, "meta"));
  // Search source: the downloaded package in local mode, otherwise this server.
  let cached: CachedPackage | undefined;
  let initialLocal: PackageSearchResult | undefined;
  if (
    app.session.preferences.searchMode === "local" &&
    app.session.storageAvailable
  ) {
    cached = await app.store
      .get<CachedPackage>("packages", language)
      .catch(() => undefined);
  }
  if (cached) {
    try {
      initialLocal = await searchPackage(
        cached,
        language,
        query ? [query] : [],
        {
          signal: context.signal,
          ...(query && isPatternQuery(query)
            ? { group: "lojban" as const }
            : { grouped: true }),
        },
      );
    } catch (error) {
      if (!context.live()) return;
      if (error instanceof PackageValidationError) {
        cached = undefined;
        app.announce(describe(error));
      } else {
        results.append(p(describe(error), "notice"));
        return;
      }
    }
  }
  if (!context.live()) return;
  if (query && isPatternQuery(query))
    results.before(
      p(
        cached && cached.version !== 2
          ? "This package has no rafsi data. Pattern results cover headwords only."
          : "Pattern results match headwords first, then retained rafsi claims. Each word lists at most 64 rafsi.",
        "meta",
      ),
    );
  if (!cached)
    getManifest({ signal: context.signal })
      .then((manifest) => {
        if (!context.live()) return;
        for (const pkg of manifest.packages) languages.add(pkg.language);
        fillLanguages();
      })
      .catch(() => {});
  if (!query) {
    count.textContent = "Type a word or a meaning to search.";
    if (app.session.preferences.searchMode === "local" && !cached) {
      const note = p(
        `No downloaded search package for ${languageName(language)}. Searches use this server until one is downloaded in Settings.`,
        "small",
      );
      results.append(note);
    } else if (cached)
      results.append(
        p(
          `Local search package from snapshot ${cached.snapshot.slice(7, 19)}…. Queries stay in this browser.`,
          "meta",
        ),
      );
    missing.append(
      p("Missing a word for this?"),
      link("Add it", routes.add, { class: "btn" }),
    );
    return;
  }
  results.setAttribute("aria-busy", "true");
  const remoteSource = p(`Searched on ${selfPeer.label}.`, "meta");
  if (!cached) results.before(remoteSource);
  let disclosed =
    app.session.preferences.remoteSearchDisclosed ||
    disclosedSearchSessions.has(app.session);
  const discloseRemote = async () => {
    if (disclosed) return;
    remoteSource.textContent = `Search sends this query to ${selfPeer.label}.`;
    // Let the visible statement reach the screen before the first query leaves.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    if (!context.live()) return;
    disclosed = true;
    disclosedSearchSessions.add(app.session);
    if (app.session.storageAvailable) {
      try {
        await app.session.setPreferences({ remoteSearchDisclosed: true });
      } catch {
        // Reading stays available when this preference cannot be saved.
      }
    }
  };
  let snapshot = cached?.snapshot ?? "";
  let view: string | null = null;
  let allLojban = initialLocal?.allLojban ?? false;
  let segmentation = initialLocal?.segmentation;
  let expanding = false;
  const pattern = isPatternQuery(query);
  const segmentationNote = p(
    "Word segmentation reached a limit. Some sequence matches or word cards can be missing. Ordinary text matching remains available.",
    "notice",
  );
  segmentationNote.hidden = true;
  results.before(segmentationNote);
  const groups = {} as Record<
    SearchGroup,
    {
      node: HTMLElement;
      rows: HTMLElement;
      status: HTMLElement;
      end: HTMLElement;
      hits: SearchHit[];
      next: string | null;
      cursors: Set<string>;
      stopped: boolean;
      total: number;
      initial: LocalHit[];
      loaded: boolean;
    }
  >;
  for (const [index, key] of (["lojban", "definitions"] as const).entries()) {
    const label = key === "lojban" ? "Lojban words" : "Definitions";
    const heading = el("h2", {
      id: `search-${key}`,
      class: "section",
      text: label,
    });
    const status = el("p", {
      class: "count",
      "aria-live": "polite",
    });
    const rows = el("div");
    const end = el("div", { class: "end-line" });
    const node = el(
      "section",
      { "aria-labelledby": heading.id },
      heading,
      status,
      rows,
      end,
    );
    node.hidden = pattern && key === "definitions";
    groups[key] = {
      node,
      rows,
      status,
      end,
      hits: [],
      next: null,
      cursors: new Set(),
      stopped: false,
      total: initialLocal?.totals[index] ?? 0,
      initial: initialLocal?.hits[index] ?? [],
      loaded: false,
    };
  }
  const remember = () => {
    if (!context.live()) return;
    const state: SearchState = {
      query,
      language,
      source: cached ? "local" : "remote",
      snapshot,
      view,
      choice: getPreferredView(),
      segmentation,
      allLojban,
      complete: groups.lojban.loaded && (pattern || groups.definitions.loaded),
      groups: Object.fromEntries(
        Object.entries(groups).map(([key, group]) => [
          key,
          {
            hits: group.hits,
            next: group.next,
            cursors: [...group.cursors],
          },
        ]),
      ) as SearchState["groups"],
    };
    rememberState({ dictionarySearch: state });
  };
  const provenance = el(
    "details",
    { class: "disclosure small" },
    el("summary", { text: "Search source and snapshot" }),
    el("div", { class: "body", style: "overflow-wrap:anywhere" }),
  );
  results.before(provenance);
  const appendHits = (key: SearchGroup, hits: SearchHit[]) => {
    const group = groups[key];
    group.loaded = true;
    for (const hit of hits) {
      group.hits.push(hit);
      group.rows.append(
        hitRow(
          app,
          hit,
          query,
          language,
          cached ? null : { snapshot, view: view! },
          context,
        ),
      );
    }
  };
  const refresh = () => {
    provenance
      .querySelector(".body")!
      .replaceChildren(
        p(
          cached
            ? `Source: the downloaded ${languageName(language)} package in this browser.`
            : `Source: ${location.host || "this server"}.`,
          "meta",
        ),
        p(`Snapshot: ${snapshot || "unknown"}`, "meta"),
        p(
          `View: ${cached ? "not evaluated in the local index" : (view ?? "unknown")}`,
          "meta",
        ),
      );
    segmentationNote.hidden = segmentation !== "limited";
    const ordered =
      allLojban || pattern
        ? [groups.lojban, groups.definitions]
        : [groups.definitions, groups.lojban];
    // Keep the DOM order equal to the reading and keyboard order.
    const before = results.firstElementChild;
    if (before !== ordered[0].node)
      results.prepend(...ordered.map((group) => group.node));
    const total = Object.values(groups).reduce(
      (sum, group) => sum + (cached ? group.total : group.hits.length),
      0,
    );
    const activeGroups = pattern ? [groups.lojban] : Object.values(groups);
    count.textContent = activeGroups.every((group) => !group.loaded)
      ? "Search results are unavailable."
      : `${total}${!cached && activeGroups.some((group) => !group.loaded || group.next) ? " or more" : ""} ${pattern ? "Lojban" : "word and definition"} ${total === 1 ? "result" : "results"}`;
    for (const [key, group] of Object.entries(groups) as [
      SearchGroup,
      typeof groups.lojban,
    ][]) {
      const remaining = cached
        ? group.total - group.hits.length
        : group.next
          ? null
          : 0;
      group.status.textContent = !group.loaded
        ? "Results are unavailable."
        : `${group.hits.length}${remaining === null ? " or more" : ""} ${key === "lojban" ? "Lojban" : "definition"} ${group.hits.length === 1 && remaining !== null ? "result" : "results"} shown.`;
      group.end.replaceChildren();
      if (remaining === null || remaining > 0) {
        group.end.append(
          text(remaining === null ? "More results… " : `${remaining} more… `),
        );
        for (const [label, all] of [
          ["Show more", false],
          ["show all", true],
        ] as const) {
          const more = button(
            label,
            async () => {
              if (expanding || group.stopped || !context.live()) return;
              const firstNew = group.hits.length;
              expanding = true;
              refresh();
              try {
                do {
                  await loadNext(key, all && !!cached);
                } while (
                  all &&
                  !cached &&
                  context.live() &&
                  !group.stopped &&
                  group.next &&
                  group.hits.length < RESULT_LIMIT
                );
              } catch (error) {
                if (context.live()) showError(key, error);
              } finally {
                expanding = false;
                if (context.live()) {
                  refresh();
                  group.rows
                    .querySelectorAll<HTMLElement>("article .hw")
                    [firstNew]?.focus();
                }
              }
            },
            { class: "btn btn-quiet" },
          );
          more.disabled =
            expanding || group.stopped || group.hits.length >= RESULT_LIMIT;
          group.end.append(more);
        }
        if (group.hits.length >= RESULT_LIMIT)
          group.end.append(
            p("The browser limit is reached. Refine your search.", "meta"),
          );
      }
    }
    for (const control of results.querySelectorAll<HTMLButtonElement>(
      "section[aria-labelledby=meaning-heading] .end-line button",
    ))
      control.disabled = expanding;
  };
  const retry = el("div");
  results.before(retry);
  const showError = (key: SearchGroup, error: unknown) => {
    const group = groups[key];
    group.rows.append(
      p(
        error instanceof TransportError && !cached
          ? `${error.message} Download a search package in Settings to search without a connection.`
          : describe(error),
        "notice",
      ),
    );
    if (!retry.querySelector("button")) {
      retry.replaceChildren();
      appendReadRetry(retry, error, context, app.announce);
    }
  };
  const loadNext = async (key: SearchGroup, all = false) => {
    const group = groups[key];
    if (!context.live() || group.stopped || group.hits.length >= RESULT_LIMIT)
      return;
    const limit = Math.min(
      all ? RESULT_LIMIT : PAGE_SIZE,
      RESULT_LIMIT - group.hits.length,
      cached ? Math.max(0, group.total - group.hits.length) : RESULT_LIMIT,
    );
    if (cached) {
      let hits = group.initial;
      if (group.hits.length || limit > hits.length) {
        const page = await searchPackage(cached, language, [query], {
          group: key,
          offset: group.hits.length,
          limit,
          signal: context.signal,
        });
        if (!context.live()) return;
        hits = page.hits[0];
        group.total = page.totals[0];
        if (page.segmentation === "limited") segmentation = "limited";
      }
      appendHits(key, hits.slice(0, limit));
    } else {
      await discloseRemote();
      if (!context.live()) return;
      const page = await remoteSearch(
        query,
        language,
        limit,
        snapshot ? { snapshot, view: view! } : null,
        group.next,
        { signal: context.signal, retired: includeRetired, group: key },
      );
      if (!context.live()) return;
      if (page.hits.length > limit) {
        group.stopped = true;
        throw new Error(
          "Search pagination returned too many results. Start a new search to retry.",
        );
      }
      if (
        (page.next !== null &&
          (group.cursors.has(page.next) || !page.hits.length)) ||
        page.hits.some(
          (hit, index) =>
            group.hits.some((prior) => prior.word_id === hit.word_id) ||
            page.hits
              .slice(0, index)
              .some((prior) => prior.word_id === hit.word_id),
        )
      ) {
        group.stopped = true;
        throw new Error(
          "Search pagination repeated a cursor or result. Start a new search to retry.",
        );
      }
      if (
        page.next &&
        page.hits.every((hit) => matchGroup(hit.match) !== key)
      ) {
        group.stopped = true;
        throw new Error(
          "Search pagination returned no matches for this group. Start a new search to retry.",
        );
      }
      remoteSource.textContent = `Searched on ${selfPeer.label}.`;
      snapshot = page.snapshot;
      view = page.view;
      group.next = page.next;
      allLojban = page.all_lojban ?? allLojban;
      if (page.segmentation === "limited") segmentation = "limited";
      if (group.next) group.cursors.add(group.next);
      appendHits(
        key,
        page.hits.filter((hit) => matchGroup(hit.match) === key),
      );
    }
    remember();
    refresh();
  };
  const saved = history.state?.dictionarySearch as SearchState | undefined;
  const restorable =
    !context.readRetryAttempt &&
    saved &&
    saved.complete === true &&
    saved.query === query &&
    saved.language === language &&
    saved.source === (cached ? "local" : "remote") &&
    "choice" in saved &&
    (saved.choice ?? null) === getPreferredView() &&
    saved.groups &&
    (["lojban", "definitions"] as const).every((key) => {
      const group = saved.groups[key];
      return (
        group &&
        Array.isArray(group.hits) &&
        group.hits.length <= RESULT_LIMIT &&
        Array.isArray(group.cursors) &&
        group.cursors.length <= RESULT_LIMIT
      );
    }) &&
    (cached
      ? saved.snapshot === cached.snapshot
      : /^sha256:[0-9a-f]{64}$/.test(saved.snapshot) &&
        typeof saved.view === "string");
  if (restorable) {
    snapshot = saved.snapshot;
    view = saved.view;
    allLojban = cached ? (initialLocal?.allLojban ?? false) : saved.allLojban;
    segmentation = cached ? initialLocal?.segmentation : saved.segmentation;
    for (const key of pattern
      ? (["lojban"] as const)
      : (["lojban", "definitions"] as const)) {
      const group = groups[key];
      group.next = saved.groups[key].next;
      group.cursors = new Set(saved.groups[key].cursors);
      try {
        if (cached) {
          const page = await searchPackage(cached, language, [query], {
            group: key,
            limit: saved.groups[key].hits.length,
            signal: context.signal,
          });
          if (!context.live()) return;
          group.total = page.totals[0];
          appendHits(key, page.hits[0]);
        } else appendHits(key, saved.groups[key].hits);
      } catch (error) {
        if (context.live()) showError(key, error);
      }
    }
  } else {
    for (const key of pattern
      ? (["lojban"] as const)
      : (["lojban", "definitions"] as const)) {
      try {
        await loadNext(key);
      } catch (error) {
        if (context.live()) showError(key, error);
        // The first remote page must establish one snapshot before other groups read it.
        if (!cached && !snapshot) break;
      }
      if (!context.live()) return;
    }
  }
  if (!context.live()) return;
  results.setAttribute("aria-busy", "false");
  refresh();
  for (const group of Object.values(groups)) {
    if (
      group.loaded &&
      !group.hits.length &&
      !group.rows.querySelector(".notice")
    )
      group.rows.append(p("No matches in this group.", "small"));
  }
  if (!pattern)
    void meaningSearchGroup(
      results,
      query,
      language,
      cached || !snapshot || !view ? null : { snapshot, view },
      app,
      context,
      (hit, source) => hitRow(app, hit, query, language, source, context),
      {
        busy: () => expanding,
        async run(work) {
          if (expanding || !context.live()) return;
          expanding = true;
          refresh();
          try {
            await work();
          } finally {
            expanding = false;
            if (context.live()) refresh();
          }
        },
      },
    );
  const retired = el("span", { class: "meta" });
  if (!cached)
    retired.append(
      checkbox("Include retired results", includeRetired, (checked) => {
        const params = new URLSearchParams(route.params);
        if (checked) params.set("retired", "1");
        else params.delete("retired");
        navigate(`/search?${params}`);
      }),
    );
  missing.append(
    p("Missing a word for this?"),
    link(
      "Add it",
      `${routes.add}?meaning=${encodeURIComponent(query)}&lang=${encodeURIComponent(language)}`,
      { class: "btn" },
    ),
    retired,
  );
  if (cached)
    missing.append(
      p(
        "Local results include every retained publication. Their current status is unavailable in this index.",
        "meta",
      ),
    );
}

function hitRow(
  app: App,
  hit: SearchHit,
  query: string,
  language: string,
  remote: { snapshot: string; view: string } | null,
  context: RenderContext,
): HTMLElement {
  const row = el("article", { class: "hit" });
  const line1 = el("div", { class: "line1" });
  const headword = link(
    hit.word.spelling,
    routes.word(hit.word.spelling, language),
    { class: "hw", lang: "jbo" },
  );
  if (hit.match === "rafsi-pattern" && !isPatternQuery(query))
    line1.append(text(`${query} ← `, "meta"));
  line1.append(headword);
  const zb =
    app.session.preferences.orthography === "zbalermorna"
      ? zbalermorna(hit.word.spelling)
      : null;
  if (zb)
    line1.append(
      el("span", { class: "zbalermorna", "aria-hidden": "true", text: zb }),
    );
  const kind = hit.preview?.word_kind;
  const rafsiSpan = el("span", { class: "rafsi", lang: "jbo" });
  rafsiSpan.hidden = true;
  line1.append(rafsiSpan);
  if (kind && kind !== "unknown") line1.append(text(kindLabel(kind), "meta"));
  if (hit.preview && hit.preview.status !== "active")
    line1.append(
      el("span", {
        class: "meta",
        text: `status: ${hit.preview.status}`,
        title:
          "The status of this publication in the selected snapshot and view.",
      }),
    );
  const selmaho = el("span", { class: "meta", lang: "jbo" });
  selmaho.hidden = true;
  line1.append(selmaho);
  row.append(line1);
  const previewId = hit.preview?.event ?? hit.definitions[0];
  const textNode = hit.preview
    ? previewText(hit.preview.plain_text, query)
    : p("Preview unavailable.", "small");
  textNode.lang = language;
  row.append(textNode);
  const line3 = el("div", { class: "line3" });
  const meta = el("span", { class: "meta attribution-line" });
  const also = el("span", { class: "meta" });
  const spacer = el("span", { class: "spacer" });
  const controlSlot = el("span");
  line3.append(meta, also, spacer, controlSlot);
  row.append(line3);
  if (hit.definitions.length > 1) {
    const others = hit.definitions.length - 1;
    also.append(
      link(
        `also: ${plural(others, "other matching definition")}`,
        routes.word(hit.word.spelling, language),
      ),
    );
  }
  const target = {
    id: previewId,
    word: hit.word_id,
    describe: (value: string) =>
      `${value === "bless" ? "Endorsing" : value === "curse" ? "Opposing" : "Clearing your judgment on"} ${hit.word.spelling}`,
  };
  // Scores and attribution need the word response and the definition envelope.
  if (remote) {
    void (async () => {
      let word: WordResponse | null = null;
      try {
        word = await getWord(hit.word_id, {
          snapshot: remote.snapshot,
          view: remote.view,
          signal: context.signal,
        });
      } catch {}
      if (!context.live()) return;
      const view = word ? await viewScores(app, hit.word_id, word) : null;
      if (!context.live()) return;
      const score = view?.scores.find((s) => s.target === previewId) ?? null;
      const unavailable =
        !view ||
        view.calculation === null ||
        view.unavailable_scores.includes(previewId) ||
        !score;
      const judgmentOptions = {
        score,
        unavailable,
        personal: view?.personal,
        reason: view?.reason ?? undefined,
        calculation: view?.calculation,
      };
      controlSlot.replaceChildren(
        judgmentControl(app, target, judgmentOptions),
        scoreDetails(app, target, judgmentOptions),
      );
      if (word?.assignments.length) {
        void loadRafsiSpellings(word, remote.snapshot, context).then(
          (spellings) => {
            if (!context.live() || !spellings.length) return;
            rafsiSpan.textContent = spellings.join(", ");
            rafsiSpan.hidden = false;
          },
        );
      }
      try {
        const record = await loadDefinition(previewId, remote.snapshot);
        if (!context.live()) return;
        if (record.body) previewRich(textNode, record.body.text, query);
        const attributed = attribution(record.envelope, record.body);
        meta.replaceChildren(attributed.node);
        if (attributed.date) meta.append(text(` · ${attributed.date}`));
        if (record.body?.notes.length)
          meta.append(
            text(" · "),
            link("notes", `${routes.definition(previewId)}#notes`),
          );
        if (record.body?.classification.selmaho.length) {
          selmaho.textContent = record.body.classification.selmaho.join(", ");
          selmaho.hidden = false;
        }
      } catch {
        meta.textContent = "";
      }
    })();
  } else {
    controlSlot.replaceChildren(
      judgmentControl(app, target, { score: null, unavailable: true }),
    );
    const entry = (hit as LocalHit).entries?.find((e) => e.event === previewId);
    if (entry && isV2(entry)) {
      if (entry.attribution) {
        const author = entry.attribution.author;
        meta.append(
          author
            ? el("bdi", {
                text: author,
                title: `${entry.attribution.source} source author`,
              })
            : text(`${entry.attribution.source} author unknown`),
        );
        meta.append(
          text(" · imported by "),
          identityLink(entry.issuer, null, { resolve: false }),
        );
        const date = sourceDate({
          legacy: { attribution: { dates: entry.attribution.dates } },
        } as never);
        if (date) meta.append(text(` · ${date}`));
      } else meta.append(identityLink(entry.issuer, null, { resolve: false }));
      if (entry.notes)
        meta.append(
          text(" · "),
          link("notes", `${routes.definition(previewId)}#notes`),
        );
      meta.append(text(" · score unavailable in local search", "meta"));
      if (entry.rafsi.length) {
        rafsiSpan.textContent = entry.rafsi.join(", ");
        rafsiSpan.hidden = false;
      }
    } else
      meta.append(text("Author and score are unavailable in local search"));
    if (entry?.classification.selmaho.length) {
      selmaho.textContent = entry.classification.selmaho.join(", ");
      selmaho.hidden = false;
    }
  }
  void placeGlyph;
  void append;
  return row;
}
const rafsiCache = new Map<string, Promise<string[]>>();
export function loadRafsiSpellings(
  word: WordResponse,
  snapshot: string,
  context: RenderContext,
): Promise<string[]> {
  const key = `${snapshot}|${word.assignments.map((a) => a.id).join(",")}`;
  let pending = rafsiCache.get(key);
  if (!pending) {
    pending = (async () => {
      const spellings = new Set<string>();
      for (const assignment of word.assignments) {
        if (assignment.status === "inactive") continue;
        for (const claim of assignment.claims.slice(0, 1)) {
          try {
            const record = await loadDefinition(claim, snapshot);
            const body = record.body as unknown as { rafsi?: string } | null;
            if (body?.rafsi) spellings.add(body.rafsi);
          } catch {}
        }
      }
      return [...spellings].sort();
    })();
    rafsiCache.set(key, pending);
  }
  void context;
  return pending;
}
