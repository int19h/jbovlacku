/**
 * The shared shell: header with search, "Add a word", the delivery marker,
 * and the identity link; the footer; and the status region.
 */
import { el, link, icon, sr, text, append } from "../lib/dom.ts";
import { navigate, replaceQuery, routes, type Route } from "./router.ts";
import type { Session } from "./session.ts";
import type { DeliveryEngine } from "../data/delivery.ts";
import { isActive } from "../data/delivery.ts";
import { shortIdentity } from "../lib/format.ts";
import type { OutboxItem } from "../data/store.ts";

export interface Shell {
  main: HTMLElement;
  status: HTMLElement;
  announce: (message: string) => void;
  searchInput: HTMLInputElement;
  setViewLabel: (label: string) => void;
  /** Called when the search query changes while typing. */
  onQuery: (handler: ((query: string) => void) | null) => void;
}
export function buildShell(
  root: HTMLElement,
  session: Session,
  delivery: DeliveryEngine,
): Shell {
  const header = el("header", { class: "header" });
  const inner = el("div", { class: "header-inner" });
  const wordmark = link("jbovlacku", "/", { class: "wordmark" });
  const form = el("form", {
    role: "search",
    class: "search-form",
    action: "/search",
  });
  const searchInput = el("input", {
    id: "q",
    name: "q",
    type: "search",
    class: "search-input",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "Search words and meanings",
  });
  const clear = el(
    "button",
    {
      type: "button",
      class: "btn btn-quiet search-clear",
      "aria-label": "Clear search",
    },
    icon("close", "", 18),
  );
  clear.hidden = true;
  append(
    form,
    el("label", { for: "q", class: "sr", text: "Search words and meanings" }),
    icon("search", "search-icon", 20),
    searchInput,
    clear,
  );
  let queryHandler: ((query: string) => void) | null = null;
  let typingTimer: ReturnType<typeof setTimeout> | undefined;
  searchInput.addEventListener("input", () => {
    clear.hidden = !searchInput.value;
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      if (location.pathname === "/search" || location.pathname === "/") {
        const params = new URLSearchParams(location.search);
        if (searchInput.value) params.set("q", searchInput.value);
        else params.delete("q");
        replaceQuery(params);
        queryHandler?.(searchInput.value);
      }
    }, 250);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    clearTimeout(typingTimer);
    navigate(
      routes.search(searchInput.value, session.preferences.definitionLanguage),
    );
  });
  clear.addEventListener("click", () => {
    searchInput.value = "";
    clear.hidden = true;
    searchInput.focus();
    if (location.pathname === "/search" || location.pathname === "/") {
      navigate(routes.search("", session.preferences.definitionLanguage), {
        replace: true,
      });
    }
  });
  const tools = el("div", { class: "header-tools" });
  const add = link(null, routes.add, { class: "btn btn-primary" });
  append(add, icon("plus", "", 18), text("Add a word"));
  const marker = link(null, routes.outbox, { class: "id-link undelivered" });
  marker.hidden = true;
  const identityLink = link(null, routes.localIdentity, { class: "id-link" });
  append(tools, add, marker, identityLink);
  append(inner, wordmark, form, tools);
  header.append(inner);
  const main = el("main", { id: "main" });
  const status = el("div", {
    class: "status",
    role: "status",
    "aria-live": "polite",
  });
  const footer = el("footer", { class: "footer" });
  const viewLink = link("Trust: site view", routes.trust);
  const footerInner = el(
    "div",
    { class: "footer-inner" },
    viewLink,
    link("Settings", routes.preferences),
    link("About", routes.about),
    link("Source", "https://github.com/int19h/jbovlacku", {
      rel: "noopener noreferrer",
      target: "_blank",
    }),
  );
  footer.append(footerInner);
  root.replaceChildren(header, main, status, footer);

  const renderIdentity = () => {
    identityLink.replaceChildren();
    if (session.backup) {
      const unlocked = session.unlocked;
      identityLink.append(
        icon(unlocked ? "unlock" : "lock", "", 18),
        el("bdi", { text: shortIdentity(session.backup.identity) }),
        sr(unlocked ? ", key unlocked" : ", key locked"),
      );
      identityLink.title = `${session.backup.identity}. Key ${unlocked ? "unlocked" : "locked"}.`;
    } else {
      identityLink.append(text("Your key"));
      identityLink.title = "Create or import a signing key";
    }
  };
  session.subscribe(renderIdentity);
  renderIdentity();
  const renderMarker = (items: OutboxItem[]) => {
    const count = items.filter(isActive).length;
    marker.hidden = count === 0;
    marker.replaceChildren(
      icon("warn", "", 20),
      el("span", { class: "count", text: String(count) }),
    );
    marker.setAttribute("aria-label", `${count} not delivered`);
    marker.title = `${count} not delivered`;
  };
  delivery.subscribe(renderMarker);
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  return {
    main,
    status,
    searchInput,
    announce(message: string) {
      status.textContent = message;
      clearTimeout(statusTimer);
      if (message)
        statusTimer = setTimeout(() => (status.textContent = ""), 8000);
    },
    setViewLabel(label: string) {
      viewLink.textContent = label;
    },
    onQuery(handler) {
      queryHandler = handler;
    },
  };
}
export function syncSearchField(shell: Shell, route: Route) {
  const query =
    route.path === "/search" || route.path === "/"
      ? (route.params.get("q") ?? "")
      : "";
  if (
    shell.searchInput.value !== query &&
    document.activeElement !== shell.searchInput
  )
    shell.searchInput.value = query;
  shell.searchInput.nextElementSibling!.toggleAttribute(
    "hidden",
    !shell.searchInput.value,
  );
}
