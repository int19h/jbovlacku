import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import { initializeCore } from "../../../packages/core/src/browser.ts";
import { LocalStore } from "./data/store.ts";
import { DeliveryEngine } from "./data/delivery.ts";
import { Session } from "./app/session.ts";
import { Signer } from "./app/actions.ts";
import { buildShell, syncSearchField } from "./app/shell.ts";
import {
  currentRoute,
  installRouter,
  setNavigationGuard,
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
import { handoverPage } from "./pages/handover.ts";
import { compromisePage } from "./pages/compromise.ts";
import { claimPage, rafsiPage, rafsiPairPage } from "./pages/rafsi.ts";
import {
  commitDraftNavigation,
  guardDraftNavigation,
} from "./pages/wizard/common.ts";
import { PersonalCalculator } from "./data/personal.ts";
import { classifyReceipt } from "./data/delivery.ts";
import { watchReaderFocus } from "./app/focus.ts";
import { editorLoadError } from "./components/editor-load-error.ts";
import {
  appendReadRetry,
  takeReadRetryAttempt,
} from "./components/readretry.ts";

const root = document.querySelector<HTMLDivElement>("#app")!;
type Page = (
  route: Route,
  context: RenderContext,
  app: App,
) => Promise<void> | void;
/** Authoring routes load their editors only when a reader opens them. */
function lazyPage(load: () => Promise<Page>): Page {
  return async (route, context, app) => {
    let page: Page;
    try {
      page = await load();
    } catch (error) {
      if (!context.live()) return;
      context.title("This page did not load");
      const notice = editorLoadError(error, true);
      context.main.append(notice);
      const heading = notice.querySelector("h1")!;
      heading.tabIndex = -1;
      context.focus(heading);
      return;
    }
    if (context.live()) await page(route, context, app);
  };
}
const meaningPage = lazyPage(() =>
  import("./pages/wizard/meaning.ts").then((module) => module.meaningPage),
);
const typePage = lazyPage(() =>
  import("./pages/wizard/type.ts").then((module) => module.typePage),
);
const formPage = lazyPage(() =>
  import("./pages/wizard/form.ts").then((module) => module.formPage),
);
const lujvoPage = lazyPage(() =>
  import("./pages/wizard/lujvo.ts").then((module) => module.lujvoPage),
);
const gismuPage = lazyPage(() =>
  import("./pages/wizard/gismu.ts").then((module) => module.gismuPage),
);
const placesPage = lazyPage(() =>
  import("./pages/wizard/places.ts").then((module) => module.placesPage),
);
const publishPage = lazyPage(() =>
  import("./pages/wizard/publish.ts").then((module) => module.publishPage),
);
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
  // Migrated rows count as delivered only under the full receipt rules, which need the core.
  if (!coreError)
    void (async () => {
      try {
        const changed = await store.reconcileMigrated((item, receipt) =>
          classifyReceipt(item, receipt, () =>
            Promise.reject(new Error("No variant lookup during migration.")),
          ),
        );
        if (changed) await delivery.invalidate();
      } catch {}
    })();
  await session.load();
  applyTheme(session.preferences.theme);
  const shell = buildShell(root, session, delivery);
  const own = new OwnState(store, session, () => offlineSigning.value);
  // The core resolves the current identity's effective public shuns from the
  // calculation's own snapshot. The context names that identity only.
  const personal = new PersonalCalculator(store, async () => ({
    identity: session.identity ?? null,
  }));
  store.onOverlayChange = () => personal.invalidate();
  let calculationIdentity = session.identity;
  session.subscribe(() => {
    if (session.identity !== calculationIdentity) {
      calculationIdentity = session.identity;
      personal.invalidate();
    }
  });
  let preferenceMessage: string | undefined;
  const app: App = {
    store,
    personal,
    session,
    delivery,
    signer,
    shell,
    own,
    offlineSigning,
    announce: (message) => {
      preferenceMessage = undefined;
      shell.announce(message);
    },
  };
  session.subscribePreferenceStatus((message) => {
    app.announce(message);
    preferenceMessage = message;
  });
  const updateViewLabel = () =>
    shell.setViewLabel(
      session.preferences.viewMode === "personal"
        ? "Trust: personal view"
        : "Trust: site view",
    );
  session.subscribe(updateViewLabel);
  updateViewLabel();
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
    "rafsi-pair": rafsiPairPage,
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
    // Keep save outcomes visible when a waiting navigation replaces the page.
    if (shell.status.textContent !== preferenceMessage) shell.announce("");
    syncSearchField(shell, route);
    if (session.storageAvailable) void delivery.invalidate();
    const main = shell.main;
    // The reader's focus choices during this render. It starts before the old
    // content leaves the page, and it ends with this render or on abort.
    const readerFocus = watchReaderFocus(main, signal);
    main.replaceChildren();
    main.className = "";
    const context: RenderContext = {
      main,
      live: () => current === revision,
      signal,
      readRetryAttempt: takeReadRetryAttempt(),
      focus: (target, options) =>
        current === revision && readerFocus.focus(target, options),
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
            ? route.segments[1] === "transfer"
              ? handoverPage
              : route.segments[1] === "compromise"
                ? compromisePage
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
          link("Back to search", "/", { class: "touch-link" }),
        );
        return;
      }
      await page(route, context, app);
    } catch (error) {
      if (current === revision) {
        main.append(p(describe(error), "notice"));
        appendReadRetry(main, error, context, app.announce);
      }
    } finally {
      readerFocus.stop();
      const inDialog = document.activeElement?.closest("dialog[open]");
      if (
        current === revision &&
        options.focusHeading &&
        !readerFocus.keeps() &&
        !inDialog
      ) {
        const heading = main.querySelector<HTMLElement>("h1");
        if (heading) {
          heading.tabIndex = -1;
          heading.focus({ preventScroll: false });
        }
      }
    }
  };
  onNavigate((route, options) => {
    commitDraftNavigation();
    void render(route, options);
  });
  if (session.storageAvailable)
    setNavigationGuard((target) =>
      session.preferencesSaving
        ? session.waitForPreferences().then(() => guardDraftNavigation(target))
        : guardDraftNavigation(target),
    );
  installRouter();
  await render(currentRoute(), { focusHeading: false });
}
void start();
