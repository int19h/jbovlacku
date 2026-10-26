import { checkbox, el } from "../lib/dom.ts";
import {
  isExperimental,
  setExperimental,
  wordFormFeedback,
} from "../model/word-form.ts";
import type { Draft } from "../model/draft.ts";
/** Show immediate morphology feedback and an explicit experimental choice. */
export function wordFormStatus(draft: Draft, changed: () => void) {
  const status = el("p", {
    class: "small",
    role: "status",
    "aria-live": "polite",
    "aria-label": "Word form",
  });
  const experimental = checkbox(
    "Experimental classification",
    isExperimental(draft.labels),
    (enabled) => {
      setExperimental(draft, enabled);
      refresh();
      changed();
    },
  );
  const wrapper = el("div", {}, status, experimental);
  function refresh() {
    const feedback = wordFormFeedback(draft);
    status.textContent = feedback.text;
    status.classList.toggle("notice", feedback.blocking);
    experimental.querySelector("input")!.checked = isExperimental(draft.labels);
  }
  refresh();
  return { wrapper, status, refresh };
}
