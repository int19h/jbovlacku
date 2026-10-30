import { button, describe, el, p } from "../lib/dom.ts";

/** A stale or interrupted editor chunk needs a fresh page load. */
export function editorLoadError(error: unknown, page = false) {
  return el(
    "section",
    { class: "notice", role: "alert" },
    el(page ? "h1" : "h2", {
      class: page ? "page" : "section",
      text: page ? "This page did not load" : "This editor did not load",
    }),
    p(
      "The editor did not load. Your saved drafts are safe in this browser. Reload this page to try again.",
    ),
    p(describe(error), "small"),
    button("Reload", () => location.reload(), { class: "btn" }),
  );
}
