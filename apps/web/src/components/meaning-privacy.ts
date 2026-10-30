import type { App } from "../app/context.ts";
import { button, describe, el, p } from "../lib/dom.ts";
import { navigate } from "../app/router.ts";
import type { RenderContext } from "../app/router.ts";
import { getCapabilities } from "../data/api.ts";
import { embeddingProfiles } from "../data/semantic-search.ts";

export const meaningSearchDataScope = [
  "search query",
  "definition language",
  "snapshot",
  "view",
  "profile",
  "result limit",
];
export const meaningSearchTask = "meaning-search";

const offWrites = new WeakMap<
  AbortSignal,
  { pending: number; listeners: Set<(pending: boolean) => void> }
>();
function meaningOffWrites(context: RenderContext) {
  let state = offWrites.get(context.signal);
  if (!state) {
    state = { pending: 0, listeners: new Set() };
    offWrites.set(context.signal, state);
  }
  return state;
}

/** Stop pending consent actions before either off control waits for storage. */
export function onMeaningSearchOff(
  context: RenderContext,
  listener: (pending: boolean) => void,
) {
  const state = meaningOffWrites(context);
  state.listeners.add(listener);
  listener(state.pending > 0);
  return () => state.listeners.delete(listener);
}
export async function saveMeaningSearchOff(app: App, context: RenderContext) {
  const state = meaningOffWrites(context);
  state.pending++;
  for (const listener of state.listeners) listener(true);
  try {
    await app.session.setPreferences({ useMeaningSearch: false });
  } finally {
    state.pending--;
    for (const listener of state.listeners) listener(state.pending > 0);
  }
}

export function meaningSearchEnabled(app: App): boolean {
  return (
    app.session.preferences.useAiAssistance !== false &&
    app.session.preferences.useMeaningSearch !== false &&
    app.session.preferences.aiConsents.some(
      (consent) =>
        consent.tasks.includes(meaningSearchTask) &&
        meaningSearchDataScope.every((field) =>
          consent.dataScope.includes(field),
        ),
    )
  );
}

/** Keep the upload notice beside search, including the empty search page. */
export function meaningPrivacy(
  app: App,
  local: boolean,
  language: string,
  context: RenderContext,
): HTMLElement {
  const node = el("div", { class: "meta" });
  let failure = "";
  let saving = false;
  let available = false;
  let discovering = false;
  const discover = async () => {
    if (
      discovering ||
      app.session.preferences.useAiAssistance === false ||
      app.session.preferences.useMeaningSearch !== false
    )
      return;
    discovering = true;
    try {
      const options = { signal: context.signal };
      const capabilities = await getCapabilities(options);
      if (!context.live() || !capabilities.features.semantic_search) return;
      const profiles = await embeddingProfiles(null, language, options);
      available = profiles.some(
        (profile) =>
          profile.query_available &&
          capabilities.embedding_profiles.includes(profile.id),
      );
    } catch {
      available = false;
    } finally {
      if (context.live()) refresh();
    }
  };
  const refresh = () => {
    node.replaceChildren();
    if (app.session.preferences.useAiAssistance === false) return;
    const enabled = app.session.preferences.useMeaningSearch !== false;
    const remembered = app.session.preferences.aiConsents.some((consent) =>
      consent.tasks.includes(meaningSearchTask),
    );
    if (!enabled || meaningSearchEnabled(app) || remembered) {
      node.append(
        p(
          !enabled
            ? local
              ? "Meaning search is off. Queries stay in this browser."
              : "Meaning search is off. Word and definition searches remain available."
            : meaningSearchEnabled(app)
              ? "Meaning search sends each query to the dictionary server and provider. This needs applicable consent and an available profile."
              : "Meaning search sends queries only with applicable consent. Older consent is saved in this browser.",
          "meta",
        ),
      );
      if (enabled || available)
        node.append(
          (() => {
            const off = button(
              enabled ? "Turn off meaning search" : "Turn on meaning search",
              async () => {
                if (saving) return;
                const restoreFocus = node.contains(document.activeElement);
                saving = true;
                off.disabled = true;
                try {
                  if (enabled) await saveMeaningSearchOff(app, context);
                  else
                    await app.session.setPreferences({
                      useMeaningSearch: true,
                    });
                  if (context.live())
                    navigate(location.pathname + location.search, {
                      replace: true,
                    });
                } catch (error) {
                  failure = `The saved meaning search choice is unchanged. This browser did not save the change. ${describe(error)}`;
                  app.announce(failure);
                } finally {
                  saving = false;
                  if (node.isConnected) {
                    refresh();
                    if (restoreFocus)
                      node.querySelector<HTMLElement>("button")?.focus();
                  }
                }
              },
            );
            off.disabled = saving;
            return off;
          })(),
        );
    } else if (local)
      node.append(
        p(
          "Queries stay in this browser. Meaning search sends queries only after you allow it.",
          "meta",
        ),
      );
    if (failure) node.append(p(failure, "notice"));
    void discover();
  };
  refresh();
  const unsubscribe = app.session.subscribe(() => {
    if (node.isConnected) refresh();
    else unsubscribe();
  });
  context.signal.addEventListener("abort", unsubscribe, { once: true });
  return node;
}
