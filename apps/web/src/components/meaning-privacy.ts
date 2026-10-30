import type { App } from "../app/context.ts";
import { button, describe, el, p } from "../lib/dom.ts";
import { navigate } from "../app/router.ts";

export const meaningSearchDataScope = [
  "search query",
  "definition language",
  "snapshot",
  "view",
  "profile",
  "result limit",
];
export const meaningSearchTask = "meaning-search";

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
export function meaningPrivacy(app: App, local: boolean): HTMLElement {
  const node = el("div", { class: "meta" });
  let failure = "";
  let saving = false;
  const refresh = () => {
    node.replaceChildren();
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
        (() => {
          const off = button(
            enabled ? "Turn off meaning search" : "Turn on meaning search",
            async () => {
              if (saving) return;
              const restoreFocus = node.contains(document.activeElement);
              saving = true;
              off.disabled = true;
              try {
                await app.session.setPreferences({
                  useMeaningSearch: !enabled,
                });
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
  };
  refresh();
  const unsubscribe = app.session.subscribe(() => {
    if (node.isConnected) refresh();
    else unsubscribe();
  });
  return node;
}
