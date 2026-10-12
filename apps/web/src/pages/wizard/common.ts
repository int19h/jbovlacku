/** Shared wizard pieces: draft persistence, the step bar, and the action bar. */
import {
  el,
  link,
  text,
  button,
  p,
  describe,
  download,
} from "../../lib/dom.ts";
import { navigate, routes, type Route } from "../../app/router.ts";
import type { App } from "../../app/context.ts";
import { newDraft, type Draft } from "../../model/draft.ts";

export const DRAFT_KEY = "current";
export const steps = [
  { number: 1, label: "Meaning", path: "/new/meaning" },
  { number: 2, label: "Type", path: "/new/type" },
  { number: 3, label: "Form", path: "/new/form" },
  { number: 4, label: "Places", path: "/new/places" },
  { number: 5, label: "Publish", path: "/new/publish" },
] as const;
export function stepPath(step: number): string {
  return steps.find((s) => s.number === step)?.path ?? "/new/meaning";
}
export async function loadDraft(app: App): Promise<Draft | null> {
  if (!app.session.storageAvailable) return null;
  try {
    const stored = await app.store.get<Draft>("drafts", DRAFT_KEY);
    if (stored && stored.version === 2) return stored;
    return null;
  } catch {
    return null;
  }
}
let pendingSaver: DraftSaver | null = null;
/** Flushes the active draft saver. The router awaits this before rendering the next page. */
export async function flushPendingDraft() {
  if (pendingSaver) await pendingSaver.flush();
}
/** Saves the draft and reports the outcome through the save indicator. */
export class DraftSaver {
  private timer: ReturnType<typeof setTimeout> | undefined;
  readonly indicator = el("span", {
    class: "meta",
    role: "status",
    "aria-live": "polite",
    text: "",
  });
  private failed = false;
  constructor(
    private app: App,
    public draft: Draft,
  ) {
    pendingSaver = this;
  }
  /** Schedules a save after edits settle. */
  touch() {
    this.draft.updatedAt = Date.now();
    this.indicator.textContent = "Saving…";
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 300);
  }
  async flush(): Promise<boolean> {
    clearTimeout(this.timer);
    this.timer = undefined;
    try {
      await this.app.store.put("drafts", DRAFT_KEY, { ...this.draft });
      this.indicator.textContent = "Saved in this browser";
      this.failed = false;
      return true;
    } catch (error) {
      this.failed = true;
      this.indicator.textContent = `Not saved: ${describe(error)}. Export the draft.`;
      return false;
    }
  }
  get hasFailed() {
    return this.failed;
  }
}
export function exportDraft(draft: Draft) {
  download(
    `jbovlacku-draft-${draft.spelling || "new"}-${Date.now()}.json`,
    JSON.stringify(draft, null, 2),
  );
}
/** The step bar with numbered circles, completion state, and the full editor link. */
export function stepBar(draft: Draft, current: number): HTMLElement {
  const bar = el("div", { class: "step-bar" });
  const inner = el("div", { class: "step-bar-inner" });
  const list = el("ol", { "aria-label": "Steps", class: "steps" });
  for (const step of steps) {
    const done =
      step.number < current ||
      (step.number < draft.step && step.number !== current);
    const anchor = link(null, step.path, {
      class: `step${done ? " done" : ""}`,
    });
    if (step.number === current) anchor.setAttribute("aria-current", "step");
    anchor.append(
      el("span", {
        class: "n",
        "aria-hidden": "true",
        text: String(step.number),
      }),
      text(step.label),
    );
    if (done) anchor.append(el("span", { class: "sr", text: ", completed" }));
    list.append(el("li", {}, anchor));
  }
  inner.append(
    list,
    link("Skip to the full editor", "/new/editor", { class: "meta step-skip" }),
  );
  bar.append(inner);
  return bar;
}
export interface ActionBarOptions {
  back?: { label: string; href: string } | null;
  primary: { label: string; action: () => unknown; disabled?: boolean };
  extra?: HTMLElement[];
}
/** The bottom action bar in ordinary flow, so it never hides a field. */
export function actionBar(
  saver: DraftSaver,
  options: ActionBarOptions,
): HTMLElement {
  const bar = el("div", { class: "action-bar" });
  const left = el("div", { class: "actions" });
  if (options.back)
    left.append(
      link(options.back.label, options.back.href, { class: "btn btn-quiet" }),
    );
  left.append(
    saver.indicator,
    button("Export draft", () => exportDraft(saver.draft), {
      class: "btn btn-quiet",
      style: "font-size:14px",
    }),
  );
  const right = el("div", { class: "actions" });
  if (options.extra) right.append(...options.extra);
  const primary = button(options.primary.label, options.primary.action, {
    class: "btn btn-primary",
  });
  primary.disabled = Boolean(options.primary.disabled);
  right.append(primary);
  bar.append(left, right);
  return bar;
}
/** Starts a new draft, replacing the current one after an explicit choice. */
export async function startDraft(
  app: App,
  patch: Partial<Draft>,
): Promise<Draft> {
  const draft = newDraft(patch);
  await app.store.put("drafts", DRAFT_KEY, draft);
  return draft;
}
export async function discardDraft(app: App) {
  pendingSaver = null;
  await app.store.delete("drafts", DRAFT_KEY);
}
export function wizardTitle(route: Route): string {
  const step = steps.find((s) => s.path === route.path);
  return step ? `Add a word: ${step.label}` : "Add a word";
}
export { p, navigate, routes };
