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
import { DraftConflictError, type ExpectedDraft } from "../../data/store.ts";
export { DraftConflictError };

export const DRAFT_KEY = "current";
export const steps = [
  { number: 1, label: "Meaning", path: "/new/meaning" },
  { number: 2, label: "Type", path: "/new/type" },
  { number: 3, label: "Form", path: "/new/form" },
  { number: 4, label: "Places", path: "/new/places" },
  { number: 5, label: "Publish", path: "/new/publish" },
] as const;
/** The step 3 page for the draft's type: a builder for lujvo and gismu, else manual entry. */
export function formPath(draft: Draft): string {
  if (draft.kind === "lujvo") return "/new/lujvo";
  if (draft.kind === "gismu") return "/new/gismu";
  return "/new/form";
}
export function stepPath(step: number): string {
  return steps.find((s) => s.number === step)?.path ?? "/new/meaning";
}
export async function loadDraft(app: App): Promise<Draft | null> {
  if (!app.session.storageAvailable) return null;
  try {
    const stored = await app.store.get<Draft>("drafts", DRAFT_KEY);
    if (stored && stored.version === 2) {
      stored.lujvo ??= null;
      stored.gismu ??= null;
      if (!stored.revision) {
        // An older draft gets a revision, so a publication can name it exactly.
        // Another tab can do the same first. Its revision wins.
        const revised = { ...stored, revision: crypto.randomUUID() };
        try {
          await app.store.saveDraft(DRAFT_KEY, revised, "unversioned");
        } catch (error) {
          if (!(error instanceof DraftConflictError)) throw error;
          return loadDraft(app);
        }
        return revised;
      }
      return stored;
    }
    return null;
  } catch {
    return null;
  }
}
let pendingSaver: DraftSaver | null = null;
/**
 * A page unload cannot be refused by the router. The browser asks before
 * it leaves while the active saver holds edits that storage did not take.
 */
window.addEventListener("beforeunload", (event) => {
  if (pendingSaver?.hasUnsaved) {
    event.preventDefault();
    event.returnValue = "";
  }
});
/**
 * The router's guard. Before the page changes, the active saver writes the
 * draft. A failed or conflicting save keeps the current page, with its
 * unsaved copy, its export control, and a choice to leave anyway.
 */
export function guardDraftNavigation(
  target: string,
): boolean | Promise<boolean> {
  const saver = pendingSaver;
  // Without a saver the verdict is synchronous, so ordinary navigation stays synchronous.
  if (!saver) return true;
  if (saver.leaving === target) {
    saver.detach();
    return true;
  }
  return saver.flush().then(
    (ok) => {
      // The flush settles the latest content. A check here covers an edit
      // that arrived in the same turn, before this page is taken down.
      if (ok && !saver.hasUnsaved) {
        saver.detach();
        return true;
      }
      saver.blocked(target);
      return false;
    },
    (error: unknown) => {
      // An unexpected failure never removes an editor with unsaved edits.
      saver.unexpected(error);
      saver.blocked(target);
      return false;
    },
  );
}
/** The fields that make two draft copies the same for saving. */
function contentKey(draft: Draft): string {
  const { revision, updatedAt, ...rest } = draft;
  void revision;
  void updatedAt;
  return JSON.stringify(rest);
}
/**
 * Saves the draft and reports the outcome through the save indicator.
 *
 * Every save names the revision it expects in storage, so a stale page never
 * replaces a newer draft and never recreates a published or discarded one.
 * The in-memory revision advances only after storage commits the save.
 */
export class DraftSaver {
  private timer: ReturnType<typeof setTimeout> | undefined;
  readonly indicator = el("span", {
    class: "meta",
    role: "status",
    "aria-live": "polite",
    text: "",
  });
  private failed = false;
  private detached = false;
  /** The revision this page last saw in storage. */
  private savedRevision: string;
  /** The content of the last successful save, for the unchanged check. */
  private savedContent: string;
  /** What storage held when the last save conflicted, for an explicit replacement. */
  private conflict: ExpectedDraft | null = null;
  private saving: Promise<boolean> | null = null;
  constructor(
    private app: App,
    public draft: Draft,
  ) {
    this.savedRevision = draft.revision;
    this.savedContent = contentKey(draft);
    pendingSaver?.detach();
    pendingSaver = this;
  }
  /** Schedules a save after edits settle. */
  touch() {
    if (this.detached) return;
    this.draft.updatedAt = Date.now();
    // After a conflict the message and its controls stay while edits continue.
    if (!this.conflict) this.indicator.textContent = "Saving…";
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 300);
  }
  /** The target of a navigation the user chose to make without saving. */
  leaving: string | null = null;
  /** Reports a refused navigation. The page keeps the unsaved copy. */
  blocked(target: string) {
    this.report(target);
  }
  /** Stops pending saves. The page's copy stays available for export. */
  detach() {
    this.detached = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (pendingSaver === this) pendingSaver = null;
  }
  /**
   * Writes until the current content is the stored content. Edits that
   * arrive during a write are written next. Returns true only when the
   * latest content reached storage, and false after a failure or conflict.
   */
  async flush(): Promise<boolean> {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (;;) {
      if (this.saving) {
        await this.saving;
        continue;
      }
      if (this.conflict) {
        // The page copy is stale. Only an explicit choice replaces the stored draft.
        this.report();
        return false;
      }
      if (!this.hasUnsaved) {
        // Nothing changed since the last save. Navigation writes nothing.
        if (this.indicator.textContent === "Saving…")
          this.indicator.textContent = "Saved in this browser";
        return true;
      }
      if (!(await this.run(this.write({ revision: this.savedRevision }))))
        return false;
    }
  }
  /** Tracks one write as the active save. */
  private run(write: Promise<boolean>): Promise<boolean> {
    this.saving = write.finally(() => {
      this.saving = null;
    });
    return this.saving;
  }
  /** Reports a failure outside the save itself, such as a guard error. */
  unexpected(error: unknown) {
    this.failed = true;
    this.failure = `Not saved: ${describe(error)}.`;
  }
  private async write(expected: ExpectedDraft): Promise<boolean> {
    const revision = crypto.randomUUID();
    // The write commits exactly this snapshot. Later edits stay unsaved
    // until their own write, whatever this one reports.
    const content = contentKey(this.draft);
    try {
      await this.app.store.saveDraft(
        DRAFT_KEY,
        { ...this.draft, revision },
        expected,
      );
      this.draft.revision = revision;
      this.savedRevision = revision;
      this.savedContent = content;
      this.conflict = null;
      this.failed = false;
      this.indicator.replaceChildren(
        text(this.hasUnsaved ? "Saving…" : "Saved in this browser"),
      );
      return true;
    } catch (error) {
      this.failed = true;
      if (error instanceof DraftConflictError) {
        this.conflict = error.storedRevision
          ? { revision: error.storedRevision }
          : "absent";
        this.failure = `Not saved: ${error.message}`;
      } else {
        this.failure = `Not saved: ${describe(error)}.`;
      }
      this.report();
      return false;
    }
  }
  /** The last failure message, kept while the edits stay unsaved. */
  private failure = "";
  /** Shows the failure with its recovery controls. */
  private report(blockedTarget?: string) {
    const small = { class: "btn btn-quiet", style: "font-size:14px" };
    const parts: (string | Node)[] = [text(`${this.failure} `)];
    if (blockedTarget) {
      this.leaving = null;
      parts.push(
        text(
          "Your unsaved edits stay on this page. Export this copy, retry, or ",
        ),
        button(
          "leave without saving",
          () => {
            this.leaving = blockedTarget;
            navigate(blockedTarget);
          },
          small,
        ),
        text("."),
      );
    } else if (this.conflict) {
      parts.push(text("Export this copy, or keep this copy."));
    } else {
      parts.push(text("Export the draft."));
    }
    if (this.conflict)
      parts.push(
        text(" "),
        button("keep this copy", () => void this.keepThisCopy(), small),
      );
    else if (blockedTarget)
      parts.push(
        text(" "),
        button("retry", () => void this.flush(), small),
      );
    this.indicator.replaceChildren(...parts);
  }
  /** Replaces the stored draft with this page's copy after an explicit choice. */
  async keepThisCopy(): Promise<boolean> {
    while (this.saving) await this.saving;
    const expected = this.conflict;
    if (!expected) return this.flush();
    this.conflict = null;
    if (!(await this.run(this.write(expected)))) return false;
    // Edits made while that write ran are written next.
    return this.flush();
  }
  get hasFailed() {
    return this.failed;
  }
  /**
   * Whether the current content differs from the content that storage
   * holds: before the timer runs, during a write, and after a failure.
   */
  get hasUnsaved() {
    return !this.detached && contentKey(this.draft) !== this.savedContent;
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
    const anchor = link(null, step.number === 3 ? formPath(draft) : step.path, {
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
/**
 * Starts a new draft. `expected` names the stored state this replaces: the
 * revision of the draft the user chose to replace, or "absent" for an
 * automatic start. A conflict means another tab changed the draft first.
 */
export async function startDraft(
  app: App,
  patch: Partial<Draft>,
  expected: ExpectedDraft,
): Promise<Draft> {
  pendingSaver?.detach();
  const draft = newDraft(patch);
  await app.store.saveDraft(DRAFT_KEY, draft, expected);
  return draft;
}
/**
 * Deletes the draft this page shows. Newer work that another tab saved
 * stays, and the caller shows that draft for a new choice.
 */
export async function discardDraft(app: App, draft: Draft) {
  await app.store.deleteDraft(DRAFT_KEY, { revision: draft.revision });
  pendingSaver?.detach();
}
/** Stops the active saver without touching storage, after a commit removed the draft. */
export function forgetDraft() {
  pendingSaver?.detach();
}
export function wizardTitle(route: Route): string {
  const step = steps.find((s) => s.path === route.path);
  return step ? `Add a word: ${step.label}` : "Add a word";
}
export { p, navigate, routes };
