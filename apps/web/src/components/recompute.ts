/**
 * "Recompute from records": a local site-view calculation compared with the
 * server's scores for one word. A server score is an assertion until this
 * comparison confirms it.
 */
import { el, p, button, describe, disclosure } from "../lib/dom.ts";
import { plural } from "../lib/format.ts";
import type { App } from "../app/context.ts";
import type { ScoreRecord, WordResponse } from "../model/types.ts";
import { calculationPanel } from "./localview.ts";

function sameInterval(a: ScoreRecord["net"], b: ScoreRecord["net"]) {
  return JSON.stringify(a) === JSON.stringify(b);
}
export function compareScores(
  server: WordResponse,
  local: {
    scores: ScoreRecord[];
    layers: string[][];
    unavailable_scores: string[];
  },
): string[] {
  const differences: string[] = [];
  const targets = new Set([
    ...server.scores.map((s) => s.target),
    ...local.scores.map((s) => s.target),
  ]);
  for (const target of targets) {
    const a = server.scores.find((s) => s.target === target);
    const b = local.scores.find((s) => s.target === target);
    const short = target.slice(0, 20) + "…";
    if (!a || !b)
      differences.push(
        `${short}: ${a ? "scored by the server only" : "scored locally only"}.`,
      );
    else if (
      !sameInterval(a.net, b.net) ||
      !sameInterval(a.support, b.support) ||
      !sameInterval(a.opposition, b.opposition) ||
      a.status !== b.status
    )
      differences.push(
        `${short}: the server and the local calculation disagree.`,
      );
  }
  if (JSON.stringify(server.layers) !== JSON.stringify(local.layers))
    differences.push("The ranking layers differ.");
  if (
    JSON.stringify([...server.unavailable_scores].sort()) !==
    JSON.stringify([...local.unavailable_scores].sort())
  )
    differences.push("The unavailable score lists differ.");
  return differences;
}
export function recomputePanel(
  app: App,
  wordId: string,
  word: WordResponse,
): HTMLElement {
  const body = el("div");
  const result = el("div", { "aria-live": "polite" });
  const run = button(
    "Recompute from records",
    async () => {
      run.disabled = true;
      result.replaceChildren(
        calculationPanel(app, { mode: "site", label: "Local calculation" }),
      );
      try {
        const status = await app.personal.ensure({
          mode: "site",
          refresh: true,
        });
        if (status.state !== "ready")
          throw new Error(
            status.state === "failed"
              ? status.message
              : "The local calculation did not finish.",
          );
        const local = await app.personal.rankWord(wordId, { mode: "site" });
        const differences = compareScores(word, local);
        const note = el("div", { role: "status" });
        if (local.snapshot !== word.snapshot)
          note.append(
            p(
              `The server now serves snapshot ${local.snapshot.slice(7, 19)}…, but this page shows snapshot ${word.snapshot.slice(7, 19)}…. Reload the page before comparing.`,
              "small",
            ),
          );
        else if (differences.length === 0)
          note.append(
            p(
              `The local calculation from ${plural(status.events, "verified record")} matches the server's ${plural(word.scores.length, "score")} and layers for this word.`,
              "small",
            ),
          );
        else {
          note.append(
            p(
              `The local calculation differs from the server in ${plural(differences.length, "way")}:`,
              "small",
            ),
          );
          const list = el("ul", { class: "small" });
          for (const line of differences) list.append(el("li", { text: line }));
          note.append(list);
        }
        if (local.calculation)
          note.append(
            p(
              `Local overlay ${local.calculation.overlay.slice(7, 19)}… · ${local.calculation.algorithm} · work ${local.calculation.completed} of ${local.calculation.budget}.`,
              "meta",
            ),
          );
        result.append(note);
      } catch (error) {
        result.append(
          p(
            `The local calculation did not finish: ${describe(error)}`,
            "small",
          ),
        );
      } finally {
        run.disabled = false;
      }
    },
    { class: "btn btn-quiet", style: "min-height:36px" },
  );
  body.append(
    p(
      "Server scores are assertions. This downloads the snapshot's records, verifies every signature and body in this browser, and compares a local site-view calculation with the scores above.",
      "small",
    ),
    run,
    result,
  );
  const wrap = el("div", { style: "margin-top:8px" });
  wrap.append(disclosure("Check the scores locally", () => body));
  return wrap;
}
