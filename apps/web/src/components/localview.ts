/**
 * Scores under the selected view mode. The site mode uses the server's word
 * response. The personal mode uses the local calculation and reports why a
 * score is unavailable when that calculation cannot finish.
 */
import { el, p, text, button, link } from "../lib/dom.ts";
import { plural } from "../lib/format.ts";
import type { App } from "../app/context.ts";
import { navigate } from "../app/router.ts";
import type { PersonalStatus } from "../data/personal.ts";
import { RECORD_LIMITS } from "../data/records.ts";
import { onDisconnect } from "../lib/lifetime.ts";
import type { Calculation, ScoreRecord, WordResponse } from "../model/types.ts";

export interface ViewScores {
  personal: boolean;
  /** Why the personal calculation has no scores, when it failed or does not match this snapshot. */
  reason: string | null;
  /** True when a personal calculation exists but is for another snapshot or view than the shown content. */
  stale: boolean;
  snapshot: string;
  view: string;
  calculation: Calculation | null;
  scores: ScoreRecord[];
  layers: string[][];
  unavailable_scores: string[];
}
/** Scores for a word under the selected view mode. Never substitutes site scores in the personal view. */
export async function viewScores(
  app: App,
  wordId: string,
  word: WordResponse,
): Promise<ViewScores> {
  if (app.session.preferences.viewMode !== "personal")
    return {
      personal: false,
      reason: null,
      stale: false,
      snapshot: word.snapshot,
      view: word.view,
      calculation: word.calculation,
      scores: word.scores,
      layers: word.layers,
      unavailable_scores: word.unavailable_scores,
    };
  try {
    const ranking = await app.personal.rankWord(wordId, { mode: "personal" });
    if (ranking.snapshot !== word.snapshot || ranking.view !== word.view)
      // One snapshot and view for content, statuses, layers, and scores. A
      // calculation for another snapshot is not shown beside this content.
      return {
        personal: true,
        reason: `The local calculation is for snapshot ${ranking.snapshot.slice(7, 19)}… and view ${ranking.view.slice(5, 17)}…, but this content is from snapshot ${word.snapshot.slice(7, 19)}… and view ${word.view.slice(5, 17)}…. Recompute from records to calculate this snapshot.`,
        stale: true,
        snapshot: word.snapshot,
        view: word.view,
        calculation: null,
        scores: [],
        layers: [],
        unavailable_scores: [],
      };
    return {
      personal: true,
      reason: null,
      stale: false,
      snapshot: ranking.snapshot,
      view: ranking.view,
      calculation: ranking.calculation,
      scores: ranking.scores,
      layers: ranking.layers,
      unavailable_scores: ranking.unavailable_scores,
    };
  } catch (error) {
    return {
      personal: true,
      reason: error instanceof Error ? error.message : String(error),
      stale: false,
      snapshot: word.snapshot,
      view: word.view,
      calculation: null,
      scores: [],
      layers: [],
      unavailable_scores: [],
    };
  }
}
export function statusText(status: PersonalStatus): string {
  switch (status.state) {
    case "idle":
      return "No local calculation yet.";
    case "downloading": {
      const pr = status.progress;
      if (pr.phase === "inventory")
        return "Downloading the snapshot inventory…";
      if (pr.phase === "records")
        return `Downloading records: ${pr.loaded} of ${pr.total} verified…`;
      if (pr.phase === "bodies")
        return `Fetching bodies that became available: ${pr.loaded} of ${pr.total}…`;
      if (pr.phase === "selections")
        return `Downloading import selections: ${pr.loaded} of ${pr.total}…`;
      return "Download complete.";
    }
    case "evaluating":
      return `Calculating the ${status.mode} view from ${plural(status.events, "verified record")}…`;
    case "ready":
      return `${status.mode === "personal" ? "Personal" : "Site"} view calculated in this browser from ${plural(status.events, "verified record")} of snapshot ${status.snapshot.slice(7, 19)}…${status.available ? "" : ` The evaluation reports: ${status.reasons.join("; ")}.`}`;
    case "failed":
      return status.message;
  }
}
/**
 * A live status region for the local calculation with Cancel, Try again, and
 * the explicit switch to the site view.
 */
export function calculationPanel(
  app: App,
  options: { mode: "personal" | "site"; label: string; onRefresh?: () => void },
): HTMLElement {
  const region = el("div", {
    class: "notice",
    role: "region",
    "aria-label": options.label,
    style: "margin-top:12px",
  });
  const line = el("p", {
    class: "small",
    "aria-live": "polite",
    style: "margin:0",
  });
  const limits = el("p", {
    class: "meta",
    style: "margin:4px 0 0",
    text: `Local limits: ${RECORD_LIMITS.events} events and ${Math.round(RECORD_LIMITS.bytes / 1048576)} MiB of records per snapshot.`,
  });
  const actions = el("div", {
    style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:8px",
  });
  const cancel = button("Cancel", () => app.personal.cancel(), {
    class: "btn btn-quiet",
  });
  const retry = button(
    "Recompute from records",
    () => {
      void app.personal
        .ensure({ mode: options.mode, refresh: true })
        .then((status) => {
          // A failed refresh keeps its message. Only a ready calculation re-renders the page.
          if (status.state === "ready") options.onRefresh?.();
        });
    },
    { class: "btn btn-quiet" },
  );
  const useSite = button(
    "Use the site view",
    async () => {
      await app.session.setPreferences({ viewMode: "site" });
      app.shell.setViewLabel("Trust: site view");
      navigate(location.pathname + location.search, { replace: true });
    },
    { class: "btn" },
  );
  actions.append(cancel, retry);
  if (options.mode === "personal") actions.append(useSite);
  region.append(line, limits, actions);
  const update = (status: PersonalStatus) => {
    line.textContent = statusText(status);
    const busy =
      status.state === "downloading" || status.state === "evaluating";
    cancel.hidden = !busy;
    retry.disabled = busy;
    region.classList.toggle(
      "error",
      status.state === "failed" && status.kind !== "cancelled",
    );
  };
  onDisconnect(region, app.personal.subscribe(update));
  return region;
}
/** A short line that states where the shown scores come from. */
export function provenanceLine(view: ViewScores): HTMLElement {
  const line = el("p", { class: "meta", style: "margin-top:8px" });
  line.append(
    text(
      `Snapshot ${view.snapshot.slice(7, 19)}… · view ${view.view.slice(5, 17)}…`,
    ),
  );
  if (view.personal && !view.reason)
    line.append(
      text(
        ` · personal view calculated in this browser · overlay ${view.calculation?.overlay.slice(7, 19) ?? "unknown"}…`,
      ),
    );
  if (view.personal && view.reason)
    line.append(
      text(
        view.stale
          ? " · personal scores unavailable: the local calculation is for another snapshot"
          : " · personal scores unavailable",
        "meta",
      ),
    );
  if (!view.personal && view.calculation === null)
    line.append(
      text(
        " · ranking unavailable for this word. No score is assumed.",
        "meta",
      ),
    );
  return line;
}
export const trustLink = () => link("Trust page", "/trust");
export const noScoresNote = () => p("No numeric score is assumed.", "meta");
