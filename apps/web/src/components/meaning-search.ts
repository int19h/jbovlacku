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
  type EmbeddingProfile,
  type SemanticResult,
} from "../data/semantic-search.ts";
import { button, describe, el, link, p } from "../lib/dom.ts";
import { richTextToText } from "../model/richtext.ts";
import {
  eventId,
  hashId,
  wordIdValid,
  type SearchHit,
} from "../model/types.ts";
import { wordId } from "../../../../packages/core/src/browser.ts";
import { appendReadRetry } from "./readretry.ts";

import {
  meaningSearchDataScope as dataScope,
  meaningSearchTask as task,
} from "./meaning-privacy.ts";
interface SavedMeaning {
  query: string;
  language: string;
  snapshot: string;
  view: string;
  choice: string | null;
  profile: string;
  profileInfo: EmbeddingProfile;
  provider: string;
  scope: string;
  result: SemanticResult;
  count: number;
  displayed: { position: number; hit: SearchHit }[];
}
function savedMeaning(query: string, language: string): SavedMeaning | null {
  const saved = history.state?.dictionaryMeaning as SavedMeaning | undefined;
  if (
    !saved ||
    saved.query !== query ||
    saved.language !== language ||
    saved.choice !== getPreferredView() ||
    !hashId(saved.snapshot) ||
    !eventId(saved.view) ||
    !hashId(saved.profile) ||
    saved.profileInfo?.id !== saved.profile ||
    typeof saved.provider !== "string" ||
    typeof saved.scope !== "string" ||
    !saved.result ||
    saved.result.snapshot !== saved.snapshot ||
    saved.result.view !== saved.view ||
    saved.result.profile !== saved.profile ||
    !Array.isArray(saved.result.hits) ||
    saved.result.hits.length > 100 ||
    !Number.isSafeInteger(saved.count) ||
    saved.count < 0 ||
    saved.count > saved.result.hits.length ||
    !Array.isArray(saved.displayed) ||
    saved.displayed.length > saved.count ||
    saved.displayed.some(
      (row, index) =>
        !Number.isSafeInteger(row.position) ||
        row.position < 0 ||
        row.position >= saved.count ||
        saved.displayed
          .slice(0, index)
          .some((prior) => prior.position === row.position) ||
        !wordIdValid(row.hit?.word_id) ||
        row.hit.word_id !== saved.result.hits[row.position]?.word ||
        row.hit.definitions?.[0] !== saved.result.hits[row.position]?.event,
    )
  )
    return null;
  return saved;
}

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
    changed: () => void;
    summary: (message: string) => void;
  },
) {
  if (
    !context.live() ||
    app.session.preferences.useAiAssistance === false ||
    app.session.preferences.useMeaningSearch === false
  )
    return;
  const group = el("section", { "aria-labelledby": "meaning-heading" });
  group.hidden = true;
  host.append(group);
  const canceled = new AbortController();
  const signal = AbortSignal.any([context.signal, canceled.signal]);
  const live = () => context.live() && !signal.aborted;
  const unsubscribe = app.session.subscribe(() => {
    if (
      app.session.preferences.useAiAssistance === false ||
      app.session.preferences.useMeaningSearch === false
    ) {
      canceled.abort();
      group.remove();
      expansion.summary("");
      expansion.changed();
    }
  });
  context.signal.addEventListener("abort", unsubscribe, { once: true });
  try {
    let saved =
      context.restoringHistory || context.readRetryAttempt
        ? savedMeaning(query, language)
        : null;
    const consented = (provider: string, scope: string) =>
      app.session.preferences.aiConsents.some(
        (consent) =>
          consent.provider === provider &&
          consent.scope === scope &&
          consent.tasks.includes(task) &&
          dataScope.every((field) => consent.dataScope.includes(field)),
      );
    if (saved && !consented(saved.provider, saved.scope)) saved = null;
    let source: SemanticContext;
    let profile: EmbeddingProfile;
    let provider: string;
    let scope: string;
    let server: string;
    if (saved) {
      source = { snapshot: saved.snapshot, view: saved.view };
      profile = saved.profileInfo;
      provider = saved.provider;
      scope = saved.scope;
      server = selfPeer.label;
    } else {
      const capabilities = await getCapabilities({ signal });
      if (!live() || !capabilities.features.semantic_search) return;
      if (pinned) source = pinned;
      else {
        const manifest = await getManifest({ signal });
        const view = getPreferredView() ?? manifest.view;
        if (!view || !eventId(view)) return;
        source = { snapshot: manifest.snapshot, view };
      }
      const profiles = await embeddingProfiles(source, language, { signal });
      const available = profiles.find(
        (item) =>
          item.query_available &&
          capabilities.embedding_profiles.includes(item.id),
      );
      if (!live() || !available) return;
      profile = available;
      provider = profile.label;
      scope = JSON.stringify({
        server: capabilities.server_id,
        profile: profile.id,
        task: "search-meaning-v1",
      });
      server = `${selfPeer.label} (${capabilities.server_id})`;
    }
    if (!live()) return;
    const status = el("p", { class: "count", tabindex: "-1" });
    const body = el("div");
    group.append(
      el("h2", {
        id: "meaning-heading",
        class: "section",
        text: "Similar in meaning",
      }),
      status,
      body,
    );
    group.hidden = false;
    const setStatus = (message: string, summary = message) => {
      if (status.textContent !== message) status.textContent = message;
      expansion.summary(summary);
    };
    const allowed = () => consented(provider, scope);
    const run = async (focusAfter = false) => {
      if (!live() || !allowed()) return;
      body.replaceChildren(
        p(
          `Profile: ${profile.label}. Similarity is a suggestion, not an editorial score.`,
          "meta",
        ),
        el("p", {
          class: "meta",
          style: "overflow-wrap:anywhere",
          text: `Meaning snapshot: ${source.snapshot}. View: ${source.view}.`,
        }),
        el(
          "details",
          { class: "disclosure small" },
          el("summary", { text: "Meaning search profile" }),
          el(
            "div",
            { class: "body", style: "overflow-wrap:anywhere" },
            p(`Profile: ${profile.id}`),
            ...profile.limitations.map((limitation) => p(limitation)),
          ),
        ),
      );
      setStatus("Searching for similar meanings.");
      try {
        const result =
          saved?.result ??
          (await semanticSearch(query, language, source, profile.id, {
            signal,
          }));
        if (!live()) return;
        if (result.coverage.pending || result.coverage.failed)
          body.append(
            p(
              `${result.coverage.indexed} of ${result.coverage.eligible} definitions are indexed. ${result.coverage.pending} ${result.coverage.pending === 1 ? "is" : "are"} pending indexing. ${result.coverage.failed} failed indexing.`,
              "meta",
            ),
          );
        const rows = el("div");
        const controls = el("div", { class: "end-line" });
        body.append(rows, controls);
        const displayed = new Map<number, SearchHit>(
          saved?.displayed.map((row) => [row.position, row.hit]),
        );
        let offset = 0;
        let loading = false;
        const remember = () =>
          rememberState({
            dictionaryMeaning: {
              query,
              language,
              ...source,
              choice: getPreferredView(),
              profile: profile.id,
              profileInfo: profile,
              provider,
              scope,
              result,
              count: offset,
              displayed: [...displayed].map(([position, hit]) => ({
                position,
                hit,
              })),
            } satisfies SavedMeaning,
          });
        const refresh = () => {
          group.setAttribute("aria-busy", String(loading));
          setStatus(
            `${displayed.size} meaning ${displayed.size === 1 ? "result" : "results"} shown${offset > displayed.size ? `, ${offset - displayed.size} unavailable` : ""}.`,
            `${displayed.size} meaning ${displayed.size === 1 ? "result" : "results"}${offset > displayed.size ? `, ${offset - displayed.size} unavailable` : ""}.`,
          );
          controls.replaceChildren();
          if (offset < result.hits.length) {
            controls.append(
              p(`${result.hits.length - offset} more meaning results.`, "meta"),
            );
            for (const [label, limit] of [
              ["Show more", 20],
              ["show all", 100],
            ] as const)
              controls.append(
                button(label, () => {
                  const moveFocus = controls.contains(document.activeElement);
                  void expansion.run(() => reveal(limit, moveFocus));
                }),
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
        const renderRow = (hit: SearchHit) => {
          const row = renderHit(hit, source);
          const permanent = link(
            "Matched definition",
            routes.definition(hit.definitions[0]),
            { class: "meta" },
          );
          const metadata = row.querySelector(".line3");
          if (metadata)
            metadata.insertBefore(permanent, metadata.querySelector(".spacer"));
          else row.append(permanent);
          return row;
        };
        const readRow = async (position: number, slot: HTMLElement) => {
          const hit = result.hits[position];
          try {
            let retained = displayed.get(position);
            if (!retained) {
              const record = await loadDefinition(hit.event, source.snapshot, {
                signal,
              });
              if (!live()) return;
              if (
                !record.body ||
                record.body.language !== language ||
                wordId(record.body.word) !== hit.word
              )
                throw new Error("Meaning result definition is unavailable.");
              retained = {
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
              };
              displayed.set(position, retained);
            }
            slot.replaceChildren(renderRow(retained));
          } catch (error) {
            if (!live()) return;
            const notice = p(
              `Meaning result unavailable: ${describe(error)}`,
              "notice",
            );
            const retry = button("Retry reading", async () => {
              if (loading || expansion.busy() || !live()) return;
              retry.disabled = true;
              await expansion.run(async () => {
                await readRow(position, slot);
                if (!live()) return;
                remember();
                refresh();
                (
                  slot.querySelector<HTMLElement>(".hw,button") ?? status
                ).focus();
              });
            });
            slot.replaceChildren(notice, retry);
          }
        };
        const reveal = async (limit: number, moveFocus = false) => {
          if (loading || !live()) return;
          const firstNew = offset;
          loading = true;
          refresh();
          try {
            const end = Math.min(result.hits.length, offset + limit);
            for (; offset < end; offset++) {
              const slot = el("div");
              rows.append(slot);
              await readRow(offset, slot);
              if (!live()) return;
            }
          } finally {
            loading = false;
            if (live()) {
              remember();
              refresh();
              if (moveFocus)
                (
                  rows.children[firstNew]?.querySelector<HTMLElement>(
                    ".hw,button",
                  ) ??
                  controls.querySelector<HTMLElement>(
                    "button:not(:disabled)",
                  ) ??
                  status
                ).focus();
              expansion.changed();
            }
          }
        };
        const count = saved?.count ?? 20;
        saved = null;
        await reveal(count);
        if (!result.hits.length)
          rows.append(p("No similar meanings in this index.", "small"));
      } catch (error) {
        if (!live()) return;
        saved = null;
        setStatus(`Meaning search failed. ${describe(error)}`);
        appendReadRetry(body, error, context, app.announce);
        body.append(button("Try meaning search again", () => void run(true)));
      } finally {
        if (live()) {
          expansion.changed();
          if (focusAfter && document.activeElement === document.body)
            (body.querySelector<HTMLElement>(".hw,button") ?? status).focus();
        }
      }
    };
    const consent = (focus = false) => {
      setStatus("Meaning search needs your permission.", "");
      const notice = el("div", {
        class: "notice",
        role: "group",
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
          if (live()) await run(true);
        } catch (error) {
          if (live()) {
            setStatus(describe(error));
            accept.disabled = false;
            expansion.changed();
          }
        }
      });
      notice.append(
        p(`Server: ${server}. Provider: ${provider}.`),
        p(`Profile: ${profile.id}`, "meta"),
        p(
          "Task: find similar meanings. Dictionary fields sent: search query, definition language, snapshot, view, profile, and result limit of 100.",
        ),
        p(
          "The provider receives the search query for embedding. This browser remembers consent for this provider and scope for future search queries.",
        ),
        p(
          "Turn off meaning search beside the search box, or turn off AI assistance in Settings. Lojban and definition searches remain available.",
        ),
        accept,
        button("Not now", () => {
          setStatus("Meaning search is off for this page.");
          const enable = button("Enable meaning search", () => consent(true));
          body.replaceChildren(enable);
          enable.focus();
          expansion.changed();
        }),
      );
      body.replaceChildren(notice);
      if (focus) accept.focus();
    };
    if (allowed()) await run();
    else consent();
  } catch {
    group.remove();
  } finally {
    if (group.hidden) group.remove();
  }
}
