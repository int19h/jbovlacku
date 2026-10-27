/**
 * Client routing. Every route preserves browser history. Query changes while
 * typing use replace-state and a stable navigation state when selected.
 */
export interface Route {
  path: string;
  params: URLSearchParams;
  /** Named path segments. */
  segments: string[];
}
export type PageRenderer = (
  route: Route,
  context: RenderContext,
) => Promise<void> | void;
export interface RenderContext {
  /** Container for the page. The shell replaces its children before each render. */
  main: HTMLElement;
  /** True while this render is still the current one. */
  live: () => boolean;
  signal: AbortSignal;
  /** Focuses a connected page control and preserves it when this render finishes.
   * Returns false for an old render, a reader's focus choice, or an open dialog.
   */
  focus: (target: HTMLElement, options?: FocusOptions) => boolean;
  /** Sets the document title. */
  title: (value: string) => void;
}
export function currentRoute(): Route {
  const url = new URL(location.href);
  return {
    path: url.pathname,
    params: url.searchParams,
    segments: url.pathname.split("/").filter(Boolean).map(decodeURIComponent),
  };
}
type Listener = (route: Route, options: { focusHeading: boolean }) => void;
const listeners = new Set<Listener>();
/**
 * A guard runs before the page changes. It receives the target URL and
 * returns false to keep the current page. The wizard uses it to keep
 * unsaved edits on screen when a draft save fails or conflicts.
 */
export type NavigationGuard = (target: string) => Promise<boolean> | boolean;
let guard: NavigationGuard | null = null;
export function setNavigationGuard(next: NavigationGuard | null) {
  guard = next;
}
/** The last location the page showed, so a refused history move can be undone. */
let shown = { href: location.href, state: history.state as unknown };
/** Only the latest navigation can commit after an asynchronous guard. */
let navigation = 0;
function track() {
  shown = { href: location.href, state: history.state as unknown };
}
/**
 * Runs the guard. A synchronous verdict keeps navigation synchronous. A
 * guard that fails keeps the current page, because the guard exists to
 * protect it. A full page load still leaves.
 */
function allowed(target: string): boolean | Promise<boolean> {
  if (!guard) return true;
  try {
    const verdict = guard(target);
    return typeof verdict === "boolean"
      ? verdict
      : verdict.catch((error: unknown) => {
          console.error("The navigation guard failed.", error);
          return false;
        });
  } catch (error) {
    console.error("The navigation guard failed.", error);
    return false;
  }
}
export function onNavigate(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function emit(focusHeading: boolean) {
  track();
  const route = currentRoute();
  for (const listener of listeners) listener(route, { focusHeading });
}
export function navigate(
  href: string,
  options: { replace?: boolean; state?: unknown } = {},
) {
  const url = new URL(href, location.href);
  if (url.origin !== location.origin) {
    location.assign(url.href);
    return;
  }
  const source = location.href;
  const current = ++navigation;
  const commit = () => {
    if (current !== navigation || location.href !== source) return;
    if (options.replace)
      history.replaceState(
        options.state ?? history.state,
        "",
        url.pathname + url.search + url.hash,
      );
    else
      history.pushState(
        options.state ?? null,
        "",
        url.pathname + url.search + url.hash,
      );
    emit(true);
  };
  const verdict = allowed(url.href);
  if (verdict === true) commit();
  else if (verdict !== false)
    void verdict.then((ok) => {
      if (ok) commit();
    });
}
/** Updates the query string without a new history entry or a render. */
export function replaceQuery(params: URLSearchParams) {
  const url = new URL(location.href);
  url.search = params.toString();
  history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  track();
}
export function rememberState(patch: Record<string, unknown>) {
  history.replaceState(
    { ...(history.state ?? {}), ...patch },
    "",
    location.href,
  );
  track();
}
export function installRouter() {
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const anchor = target?.closest<HTMLAnchorElement>("a[href]");
    if (
      !anchor ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      anchor.hasAttribute("download") ||
      anchor.target
    )
      return;
    const url = new URL(anchor.href);
    if (url.origin !== location.origin) return;
    if (
      url.pathname === location.pathname &&
      url.search === location.search &&
      url.hash
    )
      return;
    event.preventDefault();
    navigate(url.pathname + url.search + url.hash);
  });
  window.addEventListener("popstate", () => {
    // The browser already moved. A refused move puts the shown page back.
    const target = location.href;
    const previous = shown;
    const current = ++navigation;
    const settle = (ok: boolean) => {
      if (current !== navigation || location.href !== target) return;
      if (ok) emit(true);
      else {
        history.pushState(previous.state, "", previous.href);
        track();
      }
    };
    const verdict = allowed(target);
    if (typeof verdict === "boolean") settle(verdict);
    else void verdict.then(settle);
  });
  track();
}
export const routes = {
  search: (query: string, language?: string) => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (language) params.set("lang", language);
    return `/search${params.size ? `?${params}` : ""}`;
  },
  word: (spellingOrId: string, language?: string) =>
    `/word/${encodeURIComponent(spellingOrId)}${language ? `?lang=${encodeURIComponent(language)}` : ""}`,
  definition: (id: string) => `/definition/${encodeURIComponent(id)}`,
  rafsi: (spelling: string) => `/rafsi/${encodeURIComponent(spelling)}`,
  identity: (key: string) => `/identity/${encodeURIComponent(key)}`,
  localIdentity: "/identity",
  trust: "/trust",
  outbox: "/outbox",
  preferences: "/preferences",
  about: "/about",
  add: "/new/meaning",
  revise: (id: string) => `/new/editor?revise=${encodeURIComponent(id)}`,
  claim: (spelling: string) => `/claim/${encodeURIComponent(spelling)}`,
};
