/** Step 1: meaning, language, optional word, and nearby definitions from the local package. */
import { el, p, text, link, button, field, describe } from "../../lib/dom.ts";
import { languageName, plural } from "../../lib/format.ts";
import {
  navigate,
  routes,
  type RenderContext,
  type Route,
} from "../../app/router.ts";
import type { App } from "../../app/context.ts";
import { localSearch, type CachedPackage } from "../../data/search.ts";
import { remoteDraftSearch } from "../../data/api.ts";
import { placeholderCount, type Draft } from "../../model/draft.ts";
import { countNodes, placeMarker } from "../../model/richtext.ts";
import {
  actionBar,
  formPath,
  DraftSaver,
  loadDraft,
  startDraft,
  stepBar,
  discardDraft,
  DraftConflictError,
  convertLegacyDraft,
  exportDraft,
  pendingLegacyDraft,
  DRAFT_KEY,
} from "./common.ts";
import type { SearchHit } from "../../model/types.ts";

function highlightPlaceholders(meaning: string): HTMLElement {
  const node = el("p", { style: "margin-top:4px" });
  for (const part of meaning.split(/(_{2,})/)) {
    if (!part) continue;
    if (/^_{2,}$/.test(part))
      node.append(
        el("span", {
          class: "blank",
          "aria-label": "placeholder",
          text: "___",
        }),
      );
    else node.append(el("bdi", { text: part }));
  }
  return node;
}
export async function meaningPage(
  route: Route,
  context: RenderContext,
  app: App,
) {
  const { main } = context;
  context.title("Add a word: Meaning");
  main.className = "surface-wizard";
  if (!app.session.storageAvailable) {
    main.append(
      el("h1", { class: "page", text: "Add a word" }),
      p(
        "Browser storage is unavailable, so drafts cannot be saved. Restore storage access and reload.",
        "notice",
      ),
    );
    return;
  }
  let draft = await loadDraft(app);
  if (!context.live()) return;
  const legacy = draft ? null : pendingLegacyDraft();
  if (legacy) {
    renderLegacyDraft(app, main, route, legacy);
    return;
  }
  const params = route.params;
  const requestedWord = params.get("word")?.normalize("NFC") ?? null;
  const requestedMeaning = params.get("meaning") ?? null;
  const requestedLanguage = params.get("lang") ?? null;
  if (!context.live()) return;
  // A link that names a different word than the saved draft asks before replacing it.
  const conflict =
    draft &&
    requestedWord &&
    draft.spelling &&
    draft.spelling !== requestedWord &&
    (countNodes(draft.text) || draft.meaning.trim());
  if (
    !draft ||
    (!conflict &&
      requestedWord &&
      !draft.spelling &&
      !countNodes(draft.text) &&
      !draft.meaning.trim())
  ) {
    try {
      draft = await startDraft(
        app,
        {
          spelling: requestedWord ?? "",
          meaning: requestedMeaning ?? "",
          language:
            requestedLanguage ?? app.session.preferences.definitionLanguage,
          step: 1,
        },
        draft ? { revision: draft.revision } : "absent",
      );
    } catch (error) {
      if (!(error instanceof DraftConflictError)) throw error;
      // Another tab started or changed the draft first. Show that draft once.
      // A storage row that never loads as a draft must not reload without end.
      reloadOnce(main, route);
      return;
    }
  } else if (conflict) {
    main.append(
      el("h1", { class: "page", text: "A draft is already saved" }),
      p(
        `This browser holds a draft for "${draft.spelling}". Starting a definition for "${requestedWord}" replaces it. Export the saved draft first if you want to keep it.`,
        "small",
      ),
      el(
        "div",
        { class: "actions", style: "margin-top:14px" },
        link(
          "Continue the saved draft",
          draft.step === 3
            ? formPath(draft)
            : `/new/${["meaning", "type", "form", "places", "publish"][draft.step - 1]}`,
          { class: "btn btn-primary" },
        ),
        button(
          `Start "${requestedWord}" instead`,
          async () => {
            try {
              await startDraft(
                app,
                {
                  spelling: requestedWord,
                  meaning: requestedMeaning ?? "",
                  language:
                    requestedLanguage ??
                    app.session.preferences.definitionLanguage,
                },
                { revision: draft!.revision },
              );
            } catch (error) {
              if (!(error instanceof DraftConflictError)) throw error;
              // The saved draft changed in another tab. Ask again with the current draft.
              reloadOnce(main, route);
              return;
            }
            navigate("/new/meaning");
          },
          { class: "btn" },
        ),
      ),
    );
    return;
  }
  if (!context.live()) return;
  conflictReloads = 0;
  const saver = new DraftSaver(app, draft);
  main.append(stepBar(draft, 1));
  const columns = el("div", { class: "two-col" });
  const left = el("section", {
    "aria-labelledby": "h1",
    class: "main-col",
    style: "flex:1 1 360px",
  });
  left.append(
    el("h1", { id: "h1", class: "page", text: "What does the word mean?" }),
    el(
      "p",
      { class: "muted", style: "margin:8px 0 20px" },
      text("Plain words are fine. Use "),
      el("span", { class: "blank", text: "___" }),
      text(
        " for each thing the word talks about. Underscores stay placeholders until you approve their numbering in the Places step.",
      ),
    ),
  );
  const meaning = field("Meaning", {
    multiline: true,
    rows: 4,
    value: draft.meaning,
    labelClass: "sr",
  });
  meaning.input.style.fontSize = "18px";
  left.append(meaning.wrapper);
  const languages = new Set<string>([
    "en",
    draft.language,
    app.session.preferences.definitionLanguage,
  ]);
  for (const key of await app.store.keys("packages").catch(() => []))
    languages.add(key);
  if (!context.live()) return;
  const language = field("Language", {
    options: [...languages]
      .sort()
      .map((tag) => ({ value: tag, label: languageName(tag) })),
    value: draft.language,
    wrapperClass: "",
  });
  const custom = field("Other language tag", {
    value: languages.has(draft.language) ? "" : draft.language,
    placeholder: "for example fr",
    wrapperClass: "",
    hint: "Lowercase BCP 47 tag. It overrides the select.",
  });
  const word = field("Lojban word", {
    value: draft.spelling,
    placeholder: "if you have one",
    spellcheck: false,
    lang: "jbo",
    wrapperClass: "",
  });
  const row = el("div", {
    style:
      "margin-top:16px;display:flex;flex-wrap:wrap;gap:12px 16px;align-items:flex-start",
  });
  for (const f of [language, custom, word]) {
    f.wrapper.style.flex = "1 1 160px";
    row.append(f.wrapper);
  }
  left.append(row);
  const placeholders = el("p", { class: "meta", style: "margin-top:8px" });
  const updatePlaceholders = () => {
    const count = placeholderCount(meaning.input.value);
    placeholders.textContent = count
      ? `${plural(count, "placeholder")} found. They become numbered places only after you approve the numbering.`
      : "";
  };
  updatePlaceholders();
  left.append(placeholders);
  meaning.input.addEventListener("input", () => {
    draft.meaning = meaning.input.value;
    updatePlaceholders();
    saver.touch();
    scheduleNearby();
  });
  const syncLanguage = () => {
    const tag = custom.input.value.trim() || language.input.value;
    if (tag !== draft.language) {
      if (draft.glosses.length || countNodes(draft.text))
        draft.review = [...new Set([...draft.review, "language"])];
      draft.language = tag;
    }
    saver.touch();
    scheduleNearby();
  };
  language.input.addEventListener("change", syncLanguage);
  custom.input.addEventListener("input", syncLanguage);
  word.input.addEventListener("input", () => {
    draft.spelling = word.input.value;
    saver.touch();
  });
  // Nearby definitions from the local package. No private text leaves the browser by default.
  const right = el("section", {
    "aria-labelledby": "similar-h",
    class: "side-col",
    style: "flex:1 1 360px",
  });
  const head = el("div", {
    style:
      "display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px",
  });
  const modeLabel = el("span", { class: "meta" });
  head.append(
    el("h2", {
      id: "similar-h",
      class: "section",
      style: "margin:0",
      text: "Close in meaning",
    }),
    modeLabel,
  );
  right.append(
    head,
    p(
      "If one of these fits, add your definition to it instead of making a new word.",
      "meta",
    ),
  );
  const list = el("ol", { class: "similar" });
  const note = el("p", { class: "meta" });
  right.append(list, note);
  let cached: CachedPackage | null = null;
  try {
    cached =
      (await app.store.get<CachedPackage>("packages", draft.language)) ?? null;
  } catch {}
  if (!context.live()) return;
  // Consent covers one exact query and its definition language.
  let remoteConsent: string | null = null;
  const nearbyQuery = () =>
    meaning.input.value
      .trim()
      .split(/\s+/)
      .filter((word) => word.length > 2 && !/^_+$/.test(word))
      .slice(0, 6)
      .join(" ");
  const remoteQuery = () => nearbyQuery().split(" ")[0];
  const consentKey = () => JSON.stringify([remoteQuery(), draft.language]);
  const renderMode = () => {
    modeLabel.replaceChildren();
    if (cached) modeLabel.append(text("by words, from the downloaded package"));
    else {
      modeLabel.append(text("no local package · "));
      modeLabel.append(
        button(
          remoteConsent === consentKey()
            ? "searching this server"
            : "search this server",
          async () => {
            if (remoteConsent !== consentKey()) {
              const query = remoteQuery();
              if (!query) return;
              if (
                !confirm(
                  `Search ${location.host} for ${JSON.stringify(query)} in definition language ${JSON.stringify(draft.language)}? The request sends this query and language.`,
                )
              )
                return;
              remoteConsent = consentKey();
              renderMode();
              await nearby();
            }
          },
          {
            class: "btn btn-quiet",
            style: "padding:0 6px;font-size:13px",
          },
        ),
      );
    }
    modeLabel.append(
      text(" · "),
      link("by meaning: not configured", routes.preferences, {
        class: "meta touch-link",
      }),
    );
  };
  renderMode();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleNearby = () => {
    if (remoteConsent !== consentKey()) remoteConsent = null;
    renderMode();
    clearTimeout(timer);
    timer = setTimeout(() => void nearby(), 400);
  };
  const renderHits = (hits: SearchHit[], source: "local" | "remote") => {
    list.replaceChildren();
    if (!hits.length) {
      note.textContent = meaning.input.value.trim()
        ? "No close definitions found. A new word is fine."
        : "";
      return;
    }
    note.textContent =
      source === "local"
        ? "Similarity is a suggestion, not proof that the meaning already exists."
        : `Results from ${location.host}.`;
    hits.slice(0, 6).forEach((hit, index) => {
      const item = el("li", { class: "similar-item" });
      item.append(
        link(
          hit.word.spelling,
          routes.word(hit.word.spelling, draft.language),
          { class: "hw", lang: "jbo" },
        ),
        text(hit.preview?.word_kind ?? "", "meta"),
      );
      const preview = el("span", { style: "flex-basis:100%" });
      for (const part of (hit.preview?.plain_text ?? "").split(/([①-⑳])/u)) {
        if (!part) continue;
        const code = part.codePointAt(0)! - 0x245f;
        if (part.length === 1 && code >= 1 && code <= 20)
          preview.append(placeMarker(code, null));
        else preview.append(el("bdi", { text: part }));
      }
      item.append(preview);
      const actions = el("span", {
        style:
          "flex-basis:100%;display:flex;gap:8px;margin-top:6px;flex-wrap:wrap",
      });
      if (index === 0) {
        actions.append(
          button("Add a definition", () => useWord(hit.word.spelling), {
            class: "btn",
          }),
          link(
            "Revise this one",
            `/new/editor?revise=${encodeURIComponent(hit.preview?.event ?? hit.definitions[0])}`,
            { class: "btn btn-quiet" },
          ),
        );
      } else
        actions.append(
          button("Use this word", () => useWord(hit.word.spelling), {
            class: "btn btn-quiet",
          }),
        );
      item.append(actions);
      list.append(item);
    });
  };
  const useWord = (spelling: string) => {
    draft.spelling = spelling;
    word.input.value = spelling;
    saver.touch();
    app.announce(
      `Adding a definition to ${spelling}. Continue with the word type.`,
    );
  };
  const nearby = async () => {
    const query = nearbyQuery();
    if (!query) {
      renderHits([], "local");
      return;
    }
    if (cached) {
      // Rank by the number of matching query words.
      const words = query.toLocaleLowerCase("en").split(" ");
      const scored = new Map<string, { hit: SearchHit; score: number }>();
      for (const w of words)
        for (const hit of localSearch(cached.entries, w)) {
          const entry = scored.get(hit.word_id) ?? { hit, score: 0 };
          entry.score += 1;
          scored.set(hit.word_id, entry);
        }
      renderHits(
        [...scored.values()]
          .sort((a, b) => b.score - a.score)
          .map((s) => s.hit),
        "local",
      );
      return;
    }
    if (remoteConsent !== consentKey()) {
      note.textContent =
        "Download a search package in Settings for local nearby search, or allow a search on this server.";
      return;
    }
    try {
      const result = await remoteDraftSearch(
        remoteQuery(),
        draft.language,
        10,
        { signal: context.signal },
      );
      if (context.live()) renderHits(result.hits, "remote");
    } catch (error) {
      if (context.live()) note.textContent = describe(error);
    }
  };
  void nearby();
  columns.append(left, right);
  main.append(columns);
  main.append(
    actionBar(saver, {
      back: null,
      primary: {
        label: "New word",
        action: async () => {
          draft.step = Math.max(draft.step, 2) as Draft["step"];
          if (!(await saver.flush())) return;
          navigate("/new/type");
        },
      },
      extra: [
        button(
          "Discard draft",
          async () => {
            if (!confirm("Discard this draft? This cannot be undone.")) return;
            try {
              await discardDraft(app, draft);
            } catch (error) {
              if (!(error instanceof DraftConflictError)) throw error;
              // Another tab saved newer work. Show it, and ask again from that draft.
              saver.detach();
              navigate(route.path, { replace: true });
              app.announce(
                "The draft changed in another tab. Nothing was discarded. The newer draft is shown.",
              );
              return;
            }
            navigate("/");
          },
          { class: "btn btn-quiet" },
        ),
      ],
    }),
  );
  void highlightPlaceholders;
}

let conflictReloads = 0;
/**
 * Shows the page again after a storage conflict, at most twice in a row.
 * A row that never loads as a draft gets an explanation instead of a loop.
 */
function reloadOnce(main: HTMLElement, route: Route) {
  if (conflictReloads++ >= 2) {
    main.replaceChildren(
      el("h1", { class: "page", text: "Add a word" }),
      p(
        "The saved draft keeps changing while this page loads. Close other tabs of this site, then reload this page.",
        "notice",
      ),
    );
    return;
  }
  navigate(`${route.path}${route.params.size ? `?${route.params}` : ""}`, {
    replace: true,
  });
}
/** The choice for a draft saved by an older build: export, convert, or discard. */
function renderLegacyDraft(
  app: App,
  main: HTMLElement,
  route: Route,
  legacy: { stored: Record<string, unknown> },
) {
  const stored = legacy.stored;
  const word = typeof stored.word === "string" ? stored.word : "";
  const preview = convertLegacyDraft(stored);
  main.append(
    el("h1", { class: "page", text: "An older draft is saved" }),
    p(
      `This browser holds a draft${word ? ` for "${word}"` : ""} from an earlier version of this site. That version saved a license and an attribution of its own. New definitions now publish under CC0 1.0 without attribution text, so those two fields are not converted. Export the old draft to keep every field, convert it into a draft for this wizard, or discard it.`,
      "small",
    ),
  );
  const details = el("dl", { class: "small" });
  for (const [label, key] of [
    ["Word", "word"],
    ["Language", "language"],
    ["Definition", "text"],
    ["Places", "places"],
    ["Gloss", "gloss"],
    ["Notes", "notes"],
    ["License", "license"],
    ["Attribution", "attribution"],
    ["Type", "kind"],
  ] as const) {
    const value = stored[key];
    if (typeof value !== "string" || !value.trim()) continue;
    details.append(
      el("dt", { text: label }),
      el("dd", {
        text: value.length > 400 ? `${value.slice(0, 400)}…` : value,
      }),
    );
  }
  main.append(details);
  const reload = () =>
    navigate(`${route.path}${route.params.size ? `?${route.params}` : ""}`, {
      replace: true,
    });
  const notice = el("div", { role: "status", "aria-live": "polite" });
  /**
   * Another tab changed the row after this page loaded it. Nothing was
   * changed here. The old copy this page shows stays available for export,
   * and the page then shows what storage holds now.
   */
  const conflict = () => {
    notice.replaceChildren(
      el(
        "p",
        { class: "notice" },
        text(
          "The saved draft changed in another tab after this page loaded the old draft. Nothing was converted or discarded. Export the old copy shown here if you want to keep it, then continue with the current draft. ",
        ),
        button("Export the old copy", () => exportDraft(preview, stored), {
          class: "btn btn-quiet",
        }),
        text(" "),
        button("Show the current draft", reload, {
          class: "btn btn-quiet",
        }),
      ),
    );
  };
  main.append(
    notice,
    el(
      "div",
      { class: "actions", style: "margin-top:14px" },
      button("Export the old draft", () => exportDraft(preview, stored), {
        class: "btn btn-quiet",
      }),
      button(
        "Convert it into a new draft",
        async () => {
          try {
            // The exact old value is compared inside the transaction, so a
            // newer draft from another tab is never replaced.
            await app.store.replaceDraft(
              DRAFT_KEY,
              convertLegacyDraft(stored),
              stored,
            );
          } catch (error) {
            if (!(error instanceof DraftConflictError)) throw error;
            conflict();
            return;
          }
          reload();
        },
        { class: "btn btn-primary" },
      ),
      button(
        "Discard the old draft",
        async () => {
          if (!confirm("Discard the old draft? This cannot be undone.")) return;
          try {
            await app.store.replaceDraft(DRAFT_KEY, null, stored);
          } catch (error) {
            if (!(error instanceof DraftConflictError)) throw error;
            conflict();
            return;
          }
          reload();
        },
        { class: "btn btn-quiet" },
      ),
    ),
  );
}
