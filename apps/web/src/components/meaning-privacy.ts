import type { App } from "../app/context.ts";
import { button, el, p } from "../lib/dom.ts";
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
  const refresh = () => {
    node.replaceChildren();
    const remembered = app.session.preferences.aiConsents.some((consent) =>
      consent.tasks.includes(meaningSearchTask),
    );
    if (meaningSearchEnabled(app) || remembered) {
      node.append(
        p(
          meaningSearchEnabled(app)
            ? "Meaning search sends each query to the dictionary server and provider only with applicable consent and an available profile."
            : "Meaning search sends queries only with applicable consent. Older consent is saved in this browser.",
          "meta",
        ),
        button("Turn off meaning search", async () => {
          await app.session.setPreferences({
            aiConsents: app.session.preferences.aiConsents
              .map((consent) => ({
                ...consent,
                tasks: consent.tasks.filter(
                  (task) => task !== meaningSearchTask,
                ),
              }))
              .filter((consent) => consent.tasks.length > 0),
          });
          navigate(location.pathname + location.search, { replace: true });
        }),
      );
    } else if (local)
      node.append(
        p(
          "Queries stay in this browser. Meaning search sends queries only after you allow it.",
          "meta",
        ),
      );
  };
  refresh();
  const unsubscribe = app.session.subscribe(() => {
    if (node.isConnected) refresh();
    else unsubscribe();
  });
  return node;
}
