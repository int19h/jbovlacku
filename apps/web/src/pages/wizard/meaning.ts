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
import { remoteSearch } from "../../data/api.ts";
import { placeholderCount, type Draft } from "../../model/draft.ts";
import { placeMarker } from "../../model/richtext.ts";
import {
  actionBar,
  DraftSaver,
  loadDraft,
  startDraft,
  stepBar,
  discardDraft,
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
    (draft.text.trim() || draft.meaning.trim());
  if (
    !draft ||
    (!conflict &&
      requestedWord &&
      !draft.spelling &&
      !draft.text.trim() &&
      !draft.meaning.trim())
  ) {
    draft = await startDraft(app, {
      spelling: requestedWord ?? "",
      meaning: requestedMeaning ?? "",
      language: requestedLanguage ?? app.session.preferences.definitionLanguage,
      step: 1,
    });
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
          `/new/${["meaning", "type", "form", "places", "publish"][draft.step - 1]}`,
          { class: "btn btn-primary" },
        ),
        button(
          `Start "${requestedWord}" instead`,
          async () => {
            await startDraft(app, {
              spelling: requestedWord,
              meaning: requestedMeaning ?? "",
              language:
                requestedLanguage ?? app.session.preferences.definitionLanguage,
            });
            navigate("/new/meaning");
          },
          { class: "btn" },
        ),
      ),
    );
    return;
  }
  if (!context.live()) return;
  const saver = new DraftSaver(app, draft);
  main.append(stepBar(draft, 1));
  const columns = el("div", { class: "two-col", style: "gap:32px 48px" });
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
      "margin-top:16px;display:flex;flex-wrap:wrap;gap:12px 16px;align-items:flex-end",
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
      if (draft.glosses.length || draft.text.trim())
        draft.review = [...new Set([...draft.review, "language"])];
      draft.language = tag;
    }
    saver.touch();
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
  let remoteConsent = false;
  const renderMode = () => {
    modeLabel.replaceChildren();
    if (cached) modeLabel.append(text("by words, from the downloaded package"));
    else {
      modeLabel.append(text("no local package · "));
      modeLabel.append(
        button(
          remoteConsent ? "searching this server" : "search this server",
          async () => {
            if (!remoteConsent) {
              remoteConsent = confirm(
                `Searching this server sends the text you typed here to ${location.host}. Continue?`,
              );
              if (!remoteConsent) return;
              renderMode();
              await nearby();
            }
          },
          {
            class: "btn btn-quiet",
            style: "min-height:32px;padding:0 6px;font-size:13px",
          },
        ),
      );
    }
    modeLabel.append(
      text(" · "),
      link("by meaning: not configured", routes.preferences, { class: "meta" }),
    );
  };
  renderMode();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleNearby = () => {
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
            style: "min-height:38px",
          }),
          link(
            "Revise this one",
            `/new/editor?revise=${encodeURIComponent(hit.preview?.event ?? hit.definitions[0])}`,
            { class: "btn btn-quiet", style: "min-height:38px" },
          ),
        );
      } else
        actions.append(
          button("Use this word", () => useWord(hit.word.spelling), {
            class: "btn btn-quiet",
            style: "min-height:38px",
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
    const query = meaning.input.value
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 2 && !/^_+$/.test(w))
      .slice(0, 6)
      .join(" ");
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
    if (!remoteConsent) {
      note.textContent =
        "Download a search package in Settings for local nearby search, or allow a search on this server.";
      return;
    }
    try {
      const result = await remoteSearch(
        words0(query),
        draft.language,
        10,
        null,
        null,
        { signal: context.signal },
      );
      if (context.live()) renderHits(result.hits, "remote");
    } catch (error) {
      if (context.live()) note.textContent = describe(error);
    }
  };
  const words0 = (query: string) => query.split(" ")[0];
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
            await discardDraft(app);
            navigate("/");
          },
          { class: "btn btn-quiet" },
        ),
      ],
    }),
  );
  void highlightPlaceholders;
}
