/**
 * Search results. The header holds the query. The page shows a count line,
 * the definition-language select, and compact three-line rows.
 */
import { el, link, p, text, button, describe, append } from "../lib/dom.ts";
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
  localSearch,
  validateCachedPackage,
  type CachedPackage,
  type LocalHit,
} from "../data/search.ts";
import {
  getManifest,
  getWord,
  loadDefinition,
  remoteSearch,
  TransportError,
} from "../data/api.ts";
import type { SearchHit, WordResponse } from "../model/types.ts";
import { judgmentControl } from "../components/judgment.ts";
import {
  attribution,
  identityLink,
  sourceDate,
} from "../components/attribution.ts";
import { placeMarker } from "../model/richtext.ts";

const PAGE_SIZE = 20;
const RESULT_LIMIT = 1000;
interface SearchState {
  query: string;
  language: string;
  source: "local" | "remote";
  snapshot: string;
  view: string | null;
  hits: SearchHit[];
  next: string | null;
  cursors: string[];
}
/** Renders plain text with circled numerals as place markers for list rows. */
function previewText(value: string, query: string): HTMLElement {
  const node = el("p", { class: "text" });
  const parts = value.split(/([①-⑳])/u);
  const q = query.toLocaleLowerCase("en");
  for (const part of parts) {
    if (!part) continue;
    const code = part.codePointAt(0)! - 0x245f;
    if (part.length === 1 && code >= 1 && code <= 20) {
      node.append(placeMarker(code, null));
      continue;
    }
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
  return node;
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
  const endLine = el("p", { class: "end-line" });
  endLine.hidden = true;
  const missing = el("div", { class: "missing-line" });
  main.append(countLine, results, endLine, missing);
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
  languageSelect.addEventListener("change", async () => {
    await app.session.setPreferences({
      definitionLanguage: languageSelect.value,
    });
    navigate(routes.search(query, languageSelect.value));
  });
  // Search source: the downloaded package in local mode, otherwise this server.
  let cached: CachedPackage | undefined;
  if (
    app.session.preferences.searchMode === "local" &&
    app.session.storageAvailable
  ) {
    cached = await app.store
      .get<CachedPackage>("packages", language)
      .catch(() => undefined);
    if (cached) {
      try {
        validateCachedPackage(cached, language);
      } catch (error) {
        cached = undefined;
        app.announce(describe(error));
      }
    }
  }
  if (!context.live()) return;
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
  const displayed: SearchHit[] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let next: string | null = null;
  let snapshot = cached?.snapshot ?? "";
  let view: string | null = null;
  let localHits: LocalHit[] = [];
  let stopped = false;
  if (cached) localHits = localSearch(cached.entries, query);
  const remember = () => {
    if (!context.live()) return;
    const state: SearchState = {
      query,
      language,
      source: cached ? "local" : "remote",
      snapshot,
      view,
      hits: displayed,
      next,
      cursors: [...cursors],
    };
    rememberState({ dictionarySearch: state });
  };
  const retired = el("span", { class: "meta" });
  const refreshCount = () => {
    const total = cached
      ? localHits.length
      : displayed.length + (next ? "+" : "");
    count.textContent = cached
      ? plural(localHits.length, "word")
      : `${displayed.length}${next ? " or more" : ""} ${displayed.length === 1 && !next ? "word" : "words"}`;
    void total;
    const remaining = cached
      ? localHits.length - displayed.length
      : next
        ? null
        : 0;
    endLine.hidden = !(remaining === null || remaining > 0);
    endLine.replaceChildren();
    if (remaining === null || remaining > 0) {
      endLine.append(
        text(remaining === null ? "More results… " : `${remaining} more… `),
      );
      const more = button(
        "show all",
        async () => {
          more.disabled = true;
          try {
            await loadNext();
          } catch (error) {
            if (context.live()) {
              results.append(p(describe(error), "notice"));
              refreshCount();
            }
          } finally {
            more.disabled = stopped;
          }
        },
        { class: "btn btn-quiet", style: "min-height:32px" },
      );
      more.disabled = stopped || displayed.length >= RESULT_LIMIT;
      endLine.append(more);
      if (displayed.length >= RESULT_LIMIT)
        endLine.append(
          text(" The browser limit is reached. Refine your search."),
        );
    }
  };
  const appendHits = (hits: SearchHit[]) => {
    for (const hit of hits) {
      seen.add(hit.word_id);
      displayed.push(hit);
      results.append(
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
  const loadNext = async () => {
    if (cached) {
      appendHits(
        localHits.slice(
          displayed.length,
          Math.min(displayed.length + PAGE_SIZE, RESULT_LIMIT),
        ),
      );
    } else {
      const page = await remoteSearch(
        query,
        language,
        PAGE_SIZE,
        snapshot ? { snapshot, view: view! } : null,
        next,
        { signal: context.signal },
      );
      if (!context.live()) return;
      if (
        (page.next !== null && (cursors.has(page.next) || !page.hits.length)) ||
        page.hits.some(
          (hit, index) =>
            seen.has(hit.word_id) ||
            page.hits
              .slice(0, index)
              .some((prior) => prior.word_id === hit.word_id),
        )
      ) {
        stopped = true;
        throw new Error(
          "Search pagination repeated a cursor or result. Start a new search to retry.",
        );
      }
      snapshot = page.snapshot;
      view = page.view;
      next = page.next;
      if (next) cursors.add(next);
      appendHits(page.hits);
    }
    remember();
    refreshCount();
  };
  // Restore a remembered page after browser Back.
  const saved = history.state?.dictionarySearch as SearchState | undefined;
  const restorable =
    saved &&
    saved.query === query &&
    saved.language === language &&
    saved.source === (cached ? "local" : "remote") &&
    Array.isArray(saved.hits) &&
    saved.hits.length <= RESULT_LIMIT;
  try {
    if (restorable && cached && saved.snapshot === cached.snapshot) {
      appendHits(localHits.slice(0, saved.hits.length));
      refreshCount();
    } else if (
      restorable &&
      !cached &&
      /^sha256:[0-9a-f]{64}$/.test(saved.snapshot) &&
      typeof saved.view === "string" &&
      Array.isArray(saved.cursors) &&
      saved.cursors.length <= 50
    ) {
      snapshot = saved.snapshot;
      view = saved.view;
      next = saved.next;
      for (const cursor of saved.cursors) cursors.add(cursor);
      appendHits(saved.hits);
      refreshCount();
    } else await loadNext();
  } catch (error) {
    if (!context.live()) return;
    if (error instanceof TransportError && !cached)
      results.append(
        p(
          `${error.message} Download a search package in Settings to search without a connection.`,
          "notice",
        ),
      );
    else results.append(p(describe(error), "notice"));
    refreshCount();
  }
  if (!context.live()) return;
  if (!displayed.length && !results.querySelector(".notice"))
    results.append(
      p(
        cached
          ? "No matching definitions in the downloaded package."
          : "No matching definitions on this server.",
        "small",
      ),
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
  line1.append(headword);
  const kind = hit.preview?.word_kind;
  const rafsiSpan = el("span", { class: "rafsi", lang: "jbo" });
  rafsiSpan.hidden = true;
  line1.append(rafsiSpan);
  if (kind && kind !== "unknown")
    line1.append(text(kind === "fuivla" ? "fu'ivla" : kind, "meta"));
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
      const score = word?.scores.find((s) => s.target === previewId) ?? null;
      const personal = app.session.preferences.viewMode === "personal";
      const unavailable =
        personal ||
        !word ||
        word.unavailable_scores.includes(previewId) ||
        !score;
      controlSlot.replaceChildren(
        judgmentControl(app, target, {
          score,
          unavailable,
          reason: personal ? "personal" : undefined,
          calculation: word?.calculation,
        }),
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
