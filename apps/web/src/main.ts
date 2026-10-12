import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import { initializeCore } from "../../../packages/core/src/index.ts";
import { LocalStore } from "./data/store.ts";
import { DeliveryEngine } from "./data/delivery.ts";
import { Session } from "./app/session.ts";
import { Signer } from "./app/actions.ts";
import { buildShell, syncSearchField } from "./app/shell.ts";
import {
  currentRoute,
  installRouter,
  navigate,
  onNavigate,
  type RenderContext,
  type Route,
} from "./app/router.ts";
import { OwnState, type App } from "./app/context.ts";
import { applyTheme } from "./app/theme.ts";
import { el, p, link, describe } from "./lib/dom.ts";
import { searchPage } from "./pages/search.ts";
import { wordPage } from "./pages/word.ts";
import { definitionPage } from "./pages/definition.ts";
import { identityPage } from "./pages/identity.ts";
import { personPage } from "./pages/person.ts";
import { outboxPage } from "./pages/outbox.ts";
import { preferencesPage } from "./pages/preferences.ts";
import { aboutPage } from "./pages/about.ts";
import { trustPage } from "./pages/trust.ts";
import { meaningPage } from "./pages/wizard/meaning.ts";
import { typePage } from "./pages/wizard/type.ts";
import { formPage } from "./pages/wizard/form.ts";
import { lujvoPage } from "./pages/wizard/lujvo.ts";
import { gismuPage } from "./pages/wizard/gismu.ts";
import { placesPage } from "./pages/wizard/places.ts";
import { publishPage } from "./pages/wizard/publish.ts";
import { claimPage, rafsiPage } from "./pages/rafsi.ts";
import { flushPendingDraft } from "./pages/wizard/common.ts";
import { PersonalCalculator } from "./data/personal.ts";
import type { TrustScope } from "./model/types.ts";

const root = document.querySelector<HTMLDivElement>("#app")!;
type Page = (
  route: Route,
  context: RenderContext,
  app: App,
) => Promise<void> | void;
function unavailable(title: string, message: string): Page {
  return (_route, context) => {
    context.title(title);
    context.main.className = "";
    context.main.append(
      el("h1", { class: "page", text: title }),
      p(message, "notice"),
    );
  };
}
async function start() {
  const store = new LocalStore();
  const session = new Session(store);
  const delivery = new DeliveryEngine(store);
  const offlineSigning = { value: false };
  const signer = new Signer(session, delivery, () => offlineSigning.value);
  let coreError: string | null = null;
  try {
    await initializeCore();
  } catch (error) {
    coreError = describe(error);
  }
  await session.load();
  applyTheme(session.preferences.theme);
  const shell = buildShell(root, session, delivery);
  const own = new OwnState(store, session, () => offlineSigning.value);
  const personal = new PersonalCalculator(store, async () => {
    const registers = await own.registers().catch(() => null);
    const shuns: { identity: string; scope: TrustScope }[] = [];
    for (const [key, state] of registers?.trust ?? []) {
      if (!state.known || state.value !== "shun") continue;
      const [identity, kind, word, language] = key.split("|");
      shuns.push({ identity, scope: { kind, word, language } as TrustScope });
    }
    return { identity: session.identity ?? null, shuns };
  });
  store.onOverlayChange = () => personal.invalidate();
  own.subscribe(() => personal.invalidate());
  const app: App = {
    store,
    personal,
    session,
    delivery,
    signer,
    shell,
    own,
    offlineSigning,
    announce: (message) => shell.announce(message),
  };
  shell.setViewLabel(
    session.preferences.viewMode === "personal"
      ? "Trust: personal view"
      : "Trust: site view",
  );
  if (!session.storageAvailable) {
    const warning = el("p", {
      class: "notice",
      role: "alert",
      style: "max-width:64rem;margin:12px auto 0;padding:12px 20px",
    });
    warning.textContent =
      "Browser storage is unavailable. You can read online. Drafts, keys, signing, and downloaded search are disabled. Restore storage access and reload this page.";
    shell.main.before(warning);
  } else delivery.start();
  const pages: Record<string, Page> = {
    "": searchPage,
    search: searchPage,
    word: wordPage,
    words: wordPage,
    definition: definitionPage,
    definitions: definitionPage,
    outbox: outboxPage,
    preferences: preferencesPage,
    about: aboutPage,
    trust: trustPage,
    rafsi: rafsiPage,
    claim: claimPage,
    review: unavailable("Review queue", "This server has no review queue."),
  };
  let revision = 0;
  let controller = new AbortController();
  const render = async (route: Route, options: { focusHeading: boolean }) => {
    const current = ++revision;
    controller.abort();
    controller = new AbortController();
    const signal = controller.signal;
    shell.announce("");
    syncSearchField(shell, route);
    if (session.storageAvailable) {
      void delivery.invalidate();
      await flushPendingDraft();
    }
    const main = shell.main;
    main.replaceChildren();
    main.className = "";
    const context: RenderContext = {
      main,
      live: () => current === revision,
      signal,
      title: (value) => {
        if (current === revision) document.title = `${value} · jbovlacku`;
      },
    };
    try {
      if (coreError) {
        context.title("Core unavailable");
        main.append(
          el("h1", { class: "page", text: "Shared core unavailable" }),
          p(`The WebAssembly core did not load: ${coreError}`, "notice"),
        );
        return;
      }
      const head = route.segments[0] ?? "";
      let page = pages[head];
      if (head === "new" || head === "draft") {
        const step = route.segments[1] ?? "meaning";
        page =
          step === "type"
            ? typePage
            : step === "form"
              ? formPage
              : step === "lujvo"
                ? lujvoPage
                : step === "gismu"
                  ? gismuPage
                  : step === "places" || step === "editor"
                    ? placesPage
                    : step === "publish"
                      ? publishPage
                      : meaningPage;
        if (route.segments.length === 1 && route.params.has("revise")) {
          navigate(
            `/new/editor?revise=${encodeURIComponent(route.params.get("revise")!)}`,
            { replace: true },
          );
          return;
        }
      }
      if (head === "identity")
        page =
          route.segments.length > 1
            ? route.segments[1] === "transfer" ||
              route.segments[1] === "compromise"
              ? unavailable(
                  route.segments[1] === "transfer"
                    ? "Move to a new key"
                    : "Report a stolen key",
                  "This lifecycle flow is being implemented in a later stage of this build. No handover or notice can be signed here yet.",
                )
              : personPage
            : identityPage;
      if (!page)
        page = unavailable(
          "Page unavailable",
          "Use the search field or the links above to return to the dictionary.",
        );
      if (
        !session.storageAvailable &&
        ["identity", "outbox", "new", "draft"].includes(head) &&
        route.segments.length === 1
      ) {
        context.title("Browser storage unavailable");
        main.append(
          el("h1", { class: "page", text: "Browser storage unavailable" }),
          p(
            "Restore browser storage access and reload before using drafts, keys, or delivery.",
            "notice",
          ),
          link("Back to search", "/"),
        );
        return;
      }
      await page(route, context, app);
    } catch (error) {
      if (current === revision) {
        main.append(p(describe(error), "notice"));
      }
    } finally {
      if (current === revision && options.focusHeading) {
        const heading = main.querySelector<HTMLElement>("h1");
        if (heading) {
          heading.tabIndex = -1;
          heading.focus({ preventScroll: false });
        }
      }
    }
  };
  onNavigate((route, options) => void render(route, options));
  installRouter();
  await render(currentRoute(), { focusHeading: false });
}
void start();
