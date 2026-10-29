import type { App } from "../app/context.ts";
import { rememberState, routes, type RenderContext } from "../app/router.ts";
import {
  getCapabilities,
  getManifest,
  getPreferredView,
  loadDefinition,
  selfPeer,
} from "../data/api.ts";
import {
  embeddingProfiles,
  semanticSearch,
  type SemanticContext,
} from "../data/semantic-search.ts";
import { button, describe, el, link, p } from "../lib/dom.ts";
import { richTextToText } from "../model/richtext.ts";
import type { SearchHit } from "../model/types.ts";
import { wordId } from "../../../../packages/core/src/browser.ts";
import { appendReadRetry } from "./readretry.ts";

/** Meaning search has its own inline consent and never blocks lexical results. */
export async function meaningSearchGroup(
  host: HTMLElement,
  query: string,
  language: string,
  pinned: SemanticContext | null,
  app: App,
  context: RenderContext,
  renderHit: (hit: SearchHit, source: SemanticContext) => HTMLElement,
  expansion: {
    busy: () => boolean;
    run: (work: () => Promise<void>) => Promise<void>;
  },
) {
  if (app.session.preferences.useAiAssistance === false) return;
  const group = el("section", { "aria-labelledby": "meaning-heading" });
  group.hidden = true;
  host.append(group);
  const canceled = new AbortController();
  const signal = AbortSignal.any([context.signal, canceled.signal]);
  const live = () => context.live() && !signal.aborted;
  const unsubscribe = app.session.subscribe(() => {
    if (app.session.preferences.useAiAssistance === false) {
      canceled.abort();
      group.remove();
    }
  });
  context.signal.addEventListener("abort", unsubscribe, { once: true });
  try {
    const capabilities = await getCapabilities({ signal });
    if (!live() || !capabilities.features.semantic_search) return;
    let source = pinned;
    if (!source) {
      const manifest = await getManifest({ signal });
      const view = getPreferredView() ?? manifest.view;
      if (!view || !/^jve1:[0-9a-f]{64}$/.test(view)) return;
      source = { snapshot: manifest.snapshot, view };
    }
    const profiles = await embeddingProfiles(source, language, { signal });
    const profile = profiles.find(
      (item) =>
        item.query_available &&
        capabilities.embedding_profiles.includes(item.id),
    );
    if (!live() || !profile) return;
    const heading = el("h2", {
      id: "meaning-heading",
      class: "section",
      text: "Similar in meaning",
    });
    const status = el("p", {
      class: "count",
      role: "status",
      "aria-live": "polite",
    });
    const body = el("div");
    group.append(heading, status, body);
    group.hidden = false;
    const scope = JSON.stringify({
      server: capabilities.server_id,
      profile: profile.id,
      task: "search-meaning-v1",
    });
    const provider = profile.label;
    const task = "meaning-search";
    const dataScope = ["search query", "definition language"];
    const allowed = () =>
      app.session.preferences.aiConsents.some(
        (consent) =>
          consent.provider === provider &&
          consent.scope === scope &&
          consent.tasks.includes(task) &&
          dataScope.every((field) => consent.dataScope.includes(field)),
      );
    const run = async () => {
      if (!live() || !allowed()) return;
      body.replaceChildren(
        p(
          `Profile: ${profile.label}. Similarity is a suggestion, not an editorial score.`,
          "meta",
        ),
        el(
          "details",
          { class: "disclosure small" },
          el("summary", { text: "Meaning search profile" }),
          el(
            "div",
            { class: "body", style: "overflow-wrap:anywhere" },
            p(`Profile: ${profile.id}`),
            p(`Snapshot: ${source!.snapshot}`),
            p(`View: ${source!.view}`),
            ...profile.limitations.map((limitation) => p(limitation)),
          ),
        ),
      );
      status.textContent = "Searching for similar meanings.";
      try {
        const result = await semanticSearch(
          query,
          language,
          source!,
          profile.id,
          { signal },
        );
        if (!live()) return;
        const coverage = p(
          `${result.coverage.indexed} of ${result.coverage.eligible} definitions are indexed. ${result.coverage.pending} are pending indexing. ${result.coverage.failed} failed indexing.`,
          "meta",
        );
        if (result.coverage.pending || result.coverage.failed)
          body.append(coverage);
        const rows = el("div");
        const controls = el("div", { class: "end-line" });
        body.append(rows, controls);
        let offset = 0;
        let loading = false;
        let unavailable = 0;
        const refresh = () => {
          status.textContent = `${offset - unavailable} meaning ${offset - unavailable === 1 ? "result" : "results"} shown${unavailable ? `, ${unavailable} unavailable` : ""}.`;
          controls.replaceChildren();
          if (offset < result.hits.length) {
            controls.append(
              p(`${result.hits.length - offset} more meaning results.`, "meta"),
              button("Show more", () => void expansion.run(() => reveal(20))),
              button("show all", () => void expansion.run(() => reveal(100))),
            );
            for (const control of controls.querySelectorAll("button"))
              control.disabled = loading || expansion.busy();
          }
          if (offset === 100)
            controls.append(
              p(
                "Meaning search shows at most 100 definitions. Refine your search for other results.",
                "meta",
              ),
            );
        };
        const reveal = async (limit: number) => {
          if (loading || !live()) return;
          const firstNew = rows.querySelectorAll("article").length;
          const moveFocus = controls.contains(document.activeElement);
          loading = true;
          refresh();
          const end = Math.min(result.hits.length, offset + limit);
          try {
            // Fetch only the definitions that this page displays, in search order.
            for (; offset < end; offset++) {
              const hit = result.hits[offset];
              try {
                const record = await loadDefinition(
                  hit.event,
                  source!.snapshot,
                  { signal },
                );
                if (!live()) return;
                if (
                  !record.body ||
                  record.body.language !== language ||
                  wordId(record.body.word) !== hit.word
                )
                  throw new Error("Meaning result definition is unavailable.");
                const row = renderHit(
                  {
                    word: record.body.word,
                    word_id: hit.word,
                    definitions: [hit.event],
                    match: "token",
                    preview: {
                      event: hit.event,
                      word_kind: record.body.classification.kind,
                      plain_text: Array.from(richTextToText(record.body.text))
                        .slice(0, 240)
                        .join(""),
                      status: "active",
                    },
                  },
                  source!,
                );
                const permanent = link(
                  "Matched definition",
                  routes.definition(hit.event),
                  { class: "meta" },
                );
                const metadata = row.querySelector(".line3");
                if (metadata)
                  metadata.insertBefore(
                    permanent,
                    metadata.querySelector(".spacer"),
                  );
                else row.append(permanent);
                rows.append(row);
              } catch (error) {
                if (!live()) return;
                unavailable++;
                rows.append(
                  p(`Meaning result unavailable: ${describe(error)}`, "notice"),
                );
              }
            }
          } finally {
            loading = false;
            if (live()) {
              rememberState({
                dictionaryMeaning: {
                  query,
                  language,
                  snapshot: source!.snapshot,
                  view: source!.view,
                  profile: profile.id,
                  count: offset,
                },
              });
              refresh();
              if (moveFocus)
                rows
                  .querySelectorAll<HTMLElement>("article .hw")
                  [firstNew]?.focus();
            }
          }
        };
        const saved = history.state?.dictionaryMeaning;
        const retainedCount =
          saved?.query === query &&
          saved?.language === language &&
          saved?.profile === profile.id &&
          saved?.snapshot === source!.snapshot &&
          saved?.view === source!.view &&
          Number.isSafeInteger(saved.count) &&
          saved.count > 0 &&
          saved.count <= 100
            ? saved.count
            : 20;
        await reveal(retainedCount);
        if (!result.hits.length)
          rows.append(p("No similar meanings in this index.", "small"));
      } catch (error) {
        if (!live()) return;
        status.textContent = `Meaning search failed. ${describe(error)}`;
        appendReadRetry(body, error, context, app.announce);
        body.append(button("Try meaning search again", () => void run()));
      }
    };
    const consent = () => {
      status.textContent = "Meaning search needs your permission.";
      const notice = el("div", {
        class: "notice",
        "aria-label": "Meaning search consent",
      });
      const accept = button("Allow meaning search", async () => {
        accept.disabled = true;
        try {
          await app.session.setPreferences({
            aiConsents: [
              ...app.session.preferences.aiConsents,
              { provider, scope, tasks: [task], dataScope },
            ],
          });
          if (live()) await run();
        } catch (error) {
          if (live()) {
            status.textContent = describe(error);
            accept.disabled = false;
          }
        }
      });
      notice.append(
        p(
          `Server: ${selfPeer.label} (${capabilities.server_id}). Provider: ${provider}.`,
        ),
        p(`Profile: ${profile.id}`, "meta"),
        p(
          "Task: find similar meanings. Fields sent: search query and definition language.",
        ),
        p(
          "Allowing this task sends this query and future search queries to this provider. This browser remembers consent for this provider and scope.",
        ),
        p(
          "You can turn off AI assistance in Settings. Lojban and definition searches remain available.",
        ),
        accept,
        button("Not now", () => {
          status.textContent = "Meaning search is off for this page.";
          body.replaceChildren(button("Enable meaning search", consent));
        }),
      );
      body.replaceChildren(notice);
    };
    if (allowed()) await run();
    else consent();
  } catch {
    // Unavailable capability metadata leaves no empty group or page gap.
    group.remove();
  } finally {
    if (group.hidden) group.remove();
  }
}
