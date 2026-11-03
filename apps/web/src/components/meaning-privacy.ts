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

export function meaningSearchScope(server: string, profile: string): string {
  return JSON.stringify({ server, profile, task: "search-meaning-v1" });
}

export function meaningSearchConsented(
  app: App,
  provider: string,
  scope: string,
): boolean {
  return app.session.preferences.aiConsents.some(
    (consent) =>
      consent.provider === provider &&
      consent.scope === scope &&
      consent.tasks.includes(meaningSearchTask) &&
      meaningSearchDataScope.every((field) =>
        consent.dataScope.includes(field),
      ),
  );
}

/** Keep the saved meaning choice beside search, including the empty page. */
export function meaningPrivacy(
  app: App,
  language: string,
  context: RenderContext,
): HTMLElement {
  const node = el("div", { class: "meaning-privacy meta" });
  let failure = "";
  let saving = false;
  let available = false;
  let discovering = false;
  let current: { provider: string; scope: string } | null = null;
  const discover = async () => {
    if (
      discovering ||
      app.session.preferences.useAiAssistance === false ||
      (app.session.preferences.useMeaningSearch !== false &&
        !app.session.preferences.aiConsents.some((consent) =>
          consent.tasks.includes(meaningSearchTask),
        ))
    )
      return;
    discovering = true;
    try {
      const options = { signal: context.signal };
      const capabilities = await getCapabilities(options);
      if (!context.live() || !capabilities.features.semantic_search) return;
      const profiles = await embeddingProfiles(null, language, options);
      const profile = profiles.find(
        (profile) =>
          profile.query_available &&
          capabilities.embedding_profiles.includes(profile.id),
      );
      available = Boolean(profile);
      current = profile
        ? {
            provider: profile.label,
            scope: meaningSearchScope(capabilities.server_id, profile.id),
          }
        : null;
    } catch {
      available = false;
    } finally {
      if (context.live()) refresh();
    }
  };
  const refresh = () => {
    node.replaceChildren();
    node.hidden = true;
    if (app.session.preferences.useAiAssistance === false) return;
    const enabled = app.session.preferences.useMeaningSearch !== false;
    const applicable =
      current && meaningSearchConsented(app, current.provider, current.scope);
    const remembered = app.session.preferences.aiConsents.some((consent) =>
      consent.tasks.includes(meaningSearchTask),
    );
    if (!enabled || applicable || remembered) {
      node.hidden = false;
      node.append(
        el("span", {
          text: !enabled
            ? "Meaning search off"
            : applicable
              ? "Meaning search on"
              : "Meaning search needs consent",
        }),
      );
      if (enabled || available)
        node.append(
          el("span", { text: "·", "aria-hidden": "true" }),
          (() => {
            const off = button(
              enabled ? "Turn off" : "Turn on",
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
                  if (!context.live()) return;
                  failure = `The saved meaning search choice is unchanged. This browser did not save the change. ${describe(error)}`;
                  app.announce(failure);
                } finally {
                  saving = false;
                  if (context.live() && node.isConnected) {
                    refresh();
                    if (restoreFocus)
                      node.querySelector<HTMLElement>("button")?.focus();
                  }
                }
              },
              {
                class: "btn btn-quiet",
                "aria-label": enabled
                  ? "Turn off meaning search"
                  : "Turn on meaning search",
              },
            );
            off.disabled = saving;
            return off;
          })(),
        );
    }
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
