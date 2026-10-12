/**
 * The judgment control: Endorse arrow, net score, Oppose arrow, and a
 * keyboard-accessible breakdown. Pressed state reflects known own judgments only.
 */
import { el, icon, sr, button, append, p, describe, text } from "../lib/dom.ts";
import {
  fractionText,
  intervalIsExact,
  scoreHeadline,
  plural,
} from "../lib/format.ts";
import type { App } from "../app/context.ts";
import type {
  JudgmentValue,
  ScoreRecord,
  Calculation,
} from "../model/types.ts";
import type { RegisterState } from "../data/history.ts";
import type { OutboxItem } from "../data/store.ts";
import { isActive } from "../data/delivery.ts";
import { getWord } from "../data/api.ts";
import { identityLink } from "./attribution.ts";
import { onDisconnect } from "../lib/lifetime.ts";

export interface JudgmentTarget {
  /** Definition event ID or rafsi pair ID. */
  id: string;
  /** Word ID for cache refresh. */
  word: string | null;
  /** Short description for the unlock prompt, such as "Endorsing cukta". */
  describe: (value: JudgmentValue) => string;
}
export interface JudgmentOptions {
  score: ScoreRecord | null | undefined;
  /** Unavailable means the server could not compute the score. */
  unavailable: boolean;
  /** True when the score comes from the local personal calculation. */
  personal?: boolean;
  /** Why no score is shown in the personal view, when the local calculation has none. */
  reason?: string;
  /** Deprecated or other status, when known. */
  status?: string;
  calculation?: Calculation | null;
  /** Large control for the word page. */
  large?: boolean;
  /** Called after a judgment is signed and the first delivery attempt finished. */
  onChange?: () => void;
}
function ownValue(
  app: App,
  id: string,
  pending: OutboxItem[],
): Promise<{
  state: RegisterState<JudgmentValue>;
  pending: OutboxItem | null;
}> {
  const pendingItem =
    pending
      .filter(
        (item) =>
          item.label &&
          isActive(item) &&
          item.identity === app.session.identity,
      )
      .map((item) => ({
        item,
        action: JSON.parse(item.transport).envelope.header.action,
      }))
      .filter(
        ({ action }) => action.kind === "judgment.set" && action.target === id,
      )
      .map(({ item }) => item)
      .at(-1) ?? null;
  return app.own.registers().then((registers) => {
    // A register that the authenticated history does not name is a known
    // absence only when that history is complete. History saved in this
    // browser alone never proves completeness against the server.
    const found = registers?.judgments.get(id);
    const complete = Boolean(registers?.complete) && !app.offlineSigning.value;
    return {
      state: found
        ? found
        : registers && complete
          ? { known: true, value: null, conflicted: false, events: [] }
          : { known: false },
      pending: pendingItem,
    };
  });
}
export function judgmentControl(
  app: App,
  target: JudgmentTarget,
  options: JudgmentOptions,
): HTMLElement {
  const wrapper = el("div", {
    class: "judgment-wrap",
    style: "display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap",
  });
  const group = el("div", {
    class: "judgment",
    role: "group",
    "aria-label": "Your judgment",
  });
  const headline = scoreHeadline(options.unavailable ? null : options.score);
  const endorse = el(
    "button",
    { type: "button", "aria-label": "Endorse" },
    icon("up", "", options.large ? 22 : 20),
  );
  const oppose = el(
    "button",
    { type: "button", "aria-label": "Oppose" },
    icon("down", "", options.large ? 22 : 20),
  );
  const score = el("span", {
    class: `score${headline.unavailable ? " unavailable" : ""}`,
    title: headline.title,
    "aria-label": headline.label,
    role: "img",
    text: headline.text,
  });
  if (options.personal && !headline.unavailable) {
    score.title = `${headline.title} In your personal view.`;
    score.setAttribute(
      "aria-label",
      `${headline.label}, in your personal view`,
    );
  }
  if (options.personal && headline.unavailable) {
    score.title = `Score unavailable in the personal view. ${options.reason ?? "No numeric score is assumed."}`;
    score.setAttribute("aria-label", "Score unavailable in the personal view");
  }
  if (options.status === "deprecated") {
    score.title = "Deprecated. Its judgments are inactive.";
    score.setAttribute(
      "aria-label",
      "Deprecated definition. Judgments are inactive.",
    );
  }
  if (!app.session.storageAvailable) {
    // Nothing can be signed or kept without browser storage.
    endorse.disabled = oppose.disabled = true;
    endorse.title = oppose.title =
      "Browser storage is unavailable, so judgments cannot be signed or kept.";
  }
  group.append(endorse, score, oppose);
  const ownNote = el("span", { class: "meta own-judgment" });
  wrapper.append(group, ownNote);
  const applyOwn = async () => {
    try {
      const items = await app.delivery.items();
      const { state, pending } = await ownValue(app, target.id, items);
      for (const node of [endorse, oppose]) {
        node.removeAttribute("aria-pressed");
        node.classList.remove("pending");
        node.removeAttribute("aria-describedby");
      }
      ownNote.textContent = "";
      if (pending) {
        const value = JSON.parse(pending.transport).envelope.header.action
          .value;
        const node =
          value === "bless" ? endorse : value === "curse" ? oppose : null;
        node?.classList.add("pending");
        ownNote.textContent =
          value === "clear"
            ? "Your clear is not delivered yet"
            : `Your ${value === "bless" ? "endorsement" : "opposition"} is not delivered yet`;
        return;
      }
      if (!state.known) {
        ownNote.textContent = app.session.identity
          ? "Your judgment is unknown here"
          : "";
        return;
      }
      if (state.conflicted) {
        ownNote.textContent = "Your judgment conflicts between devices";
        return;
      }
      endorse.setAttribute("aria-pressed", String(state.value === "bless"));
      oppose.setAttribute("aria-pressed", String(state.value === "curse"));
    } catch (error) {
      ownNote.textContent = describe(error);
    }
  };
  void applyOwn();
  // The subscription lasts while the control is in the document.
  onDisconnect(
    wrapper,
    app.own.subscribe(() => void applyOwn()),
  );
  const act = (arrow: "bless" | "curse") => async () => {
    const pressed =
      (arrow === "bless" ? endorse : oppose).getAttribute("aria-pressed") ===
      "true";
    const value: JudgmentValue = pressed ? "clear" : arrow;
    await app.session.requireUnlocked(target.describe(value), async () => {
      if (!(await app.session.firstSignatureDisclosure())) return;
      endorse.disabled = oppose.disabled = true;
      try {
        const results = await app.signer.publish([
          {
            action: { kind: "judgment.set", target: target.id, value },
            body: null,
          },
        ]);
        app.own.invalidate();
        const peer = results[0]?.peers.self;
        if (peer?.state === "accepted")
          app.announce(
            value === "clear"
              ? "Your judgment is cleared."
              : value === "bless"
                ? "Your endorsement is published."
                : "Your opposition is published.",
          );
        else
          app.announce(
            "Your judgment is signed and saved here. Delivery is not finished. See Not delivered.",
          );
        options.onChange?.();
      } catch (error) {
        app.announce(describe(error));
      } finally {
        endorse.disabled = oppose.disabled = !app.session.storageAvailable;
        void applyOwn();
      }
    });
  };
  endorse.addEventListener("click", act("bless"));
  oppose.addEventListener("click", act("curse"));
  return wrapper;
}
/** The reviewer disclosure. It states the aggregate evidence that the server supplies. */
export function scoreDetails(
  app: App,
  target: JudgmentTarget,
  options: JudgmentOptions,
): HTMLElement {
  const score = options.unavailable ? null : options.score;
  const summaryText = score
    ? plural(score.direct_reviewers, "reviewer")
    : "Score details";
  const details = el("details", { class: "judgment-details" });
  const summary = el(
    "summary",
    {},
    el("span", { text: summaryText }),
    icon("chevron", "chev", 14),
  );
  const body = el("div", { class: "body", style: "padding:4px 0 8px" });
  details.append(summary, body);
  details.addEventListener("toggle", async () => {
    if (!details.open) return;
    body.replaceChildren();
    if (options.personal && !score) {
      body.append(
        p(
          `Your personal view applies private choices from this browser. ${options.reason ?? "The local calculation has no score for this item."} No numeric score is assumed. The site view scores are available after switching the view on the Trust page.`,
          "small",
        ),
        el(
          "p",
          { class: "meta" },
          el("a", { href: "/trust", text: "Open the Trust page" }),
        ),
      );
      return;
    }
    if (!score) {
      body.append(
        p(
          "Unavailable. The server could not compute this score. No numeric score is assumed.",
          "small",
        ),
      );
      if (options.calculation === null)
        body.append(
          p("Ranking for this word is unavailable in this snapshot.", "meta"),
        );
      return;
    }
    const exact = scoreHeadline(score).exact;
    const dl = el("dl", { class: "kv" });
    const row = (k: string, v: string) =>
      dl.append(el("div", {}, el("dt", { text: k }), el("dd", { text: v })));
    row(
      "Support",
      exact
        ? fractionText(score.support[0])
        : `${fractionText(score.support[0])} to ${fractionText(score.support[1])}`,
    );
    row(
      "Opposition",
      exact
        ? fractionText(score.opposition[0])
        : `${fractionText(score.opposition[0])} to ${fractionText(score.opposition[1])}`,
    );
    row(
      "Net",
      exact
        ? fractionText(score.net[0])
        : `${fractionText(score.net[0])} to ${fractionText(score.net[1])}`,
    );
    row("Direct reviewers", String(score.direct_reviewers));
    row(
      "Calculation",
      exact ? "Exact" : "Bounded. Order unresolved where intervals overlap.",
    );
    body.append(dl);
    if (score.direct_reviewers === 0)
      body.append(p("No judgments yet.", "small"));
    else if (target.word) {
      const slot = el(
        "div",
        { "aria-live": "polite" },
        p("Loading reviewers…", "meta"),
      );
      body.append(slot);
      void (async () => {
        try {
          const detailed = score.reviewers
            ? score
            : (
                await getWord(target.word!, {
                  reviewers: true,
                  snapshot: options.calculation?.inventory,
                })
              ).scores.find((s) => s.target === target.id);
          slot.replaceChildren();
          if (!detailed?.reviewers) {
            slot.append(
              p("This server does not supply reviewer details.", "meta"),
            );
            return;
          }
          const table = el("table", { class: "small" });
          table.append(
            el(
              "thead",
              {},
              el(
                "tr",
                {},
                el("th", { scope: "col", text: "Reviewer" }),
                el("th", { scope: "col", text: "Route in your view" }),
                el("th", { scope: "col", class: "right", text: "Influence" }),
              ),
            ),
          );
          const tbody = el("tbody");
          for (const reviewer of detailed.reviewers) {
            const route: string[] = [];
            if (reviewer.root)
              route.push(`root of the view (q=${fractionText(reviewer.root)})`);
            if (reviewer.incoming.length)
              route.push(
                `trusted by ${reviewer.incoming.length === 1 ? "" : `${reviewer.incoming_count} identities, including `}`,
              );
            if (reviewer.blocked) route.push("blocked in this view");
            const routeCell = el("td", { class: "meta" });
            if (reviewer.root) routeCell.append(text(route[0]));
            if (reviewer.incoming.length) {
              if (reviewer.root) routeCell.append(text("; "));
              routeCell.append(
                text(
                  reviewer.incoming_count === 1
                    ? "trusted by "
                    : `trusted by ${reviewer.incoming_count} identities, including `,
                ),
              );
              reviewer.incoming.slice(0, 3).forEach((from, i) => {
                if (i) routeCell.append(text(", "));
                routeCell.append(identityLink(from));
              });
              if (!reviewer.incoming_complete)
                routeCell.append(text(" and more"));
            }
            if (!reviewer.root && !reviewer.incoming.length)
              routeCell.append(
                text(
                  reviewer.blocked
                    ? "blocked in this view"
                    : "no route in this view",
                ),
              );
            if (reviewer.multiple_routes)
              routeCell.append(text(" · several routes contribute", "meta"));
            const weight = reviewer.weight
              ? intervalIsExact(reviewer.weight)
                ? fractionText(reviewer.weight[0])
                : `${fractionText(reviewer.weight[0])} to ${fractionText(reviewer.weight[1])}`
              : "unavailable";
            tbody.append(
              el(
                "tr",
                {},
                el(
                  "td",
                  {},
                  identityLink(reviewer.identity),
                  text(
                    reviewer.verdict === "bless" ? " endorses" : " opposes",
                    "meta",
                  ),
                ),
                routeCell,
                el("td", {
                  class: "right num",
                  text: `${reviewer.verdict === "curse" ? "−" : "+"}${weight}`,
                }),
              ),
            );
          }
          table.append(tbody);
          slot.append(
            el(
              "div",
              {
                class: "table-scroll",
                tabindex: "0",
                role: "region",
                "aria-label": "Reviewers",
              },
              table,
            ),
          );
          if (!detailed.reviewers_complete)
            slot.append(
              p(
                `Only the first ${detailed.reviewers.length} of ${detailed.direct_reviewers} reviewers are listed.`,
                "meta",
              ),
            );
          const you = app.session.identity;
          if (you && !detailed.reviewers.some((r) => r.identity === you))
            slot.append(p("You: not in this view yet.", "meta"));
          slot.append(
            p(
              "Route shares are not shown. The bounded calculation certifies totals, not per-route amounts.",
              "meta",
            ),
          );
        } catch (error) {
          slot.replaceChildren(
            p(`Reviewer details are unavailable: ${describe(error)}`, "meta"),
          );
        }
      })();
    }
    body.append(
      el(
        "p",
        { class: "meta" },
        options.personal
          ? "The score adds the weight of each reviewer in your personal view, calculated in this browser from the downloaded records. "
          : "The score adds the weight of each reviewer in the site view. ",
        el("a", { href: "/trust", text: "Trust page" }),
        ".",
      ),
    );
    if (options.calculation) {
      const c = options.calculation;
      body.append(
        p(
          `${c.algorithm}. Work ${c.completed} of ${c.budget}. ${c.exact ? "Every graph completed exactly." : "Some graphs stopped at the budget."}`,
          "meta",
        ),
      );
      if (c.incomplete_identities.length)
        body.append(
          p(
            `${plural(c.incomplete_identities.length, "identity", "identities")} with incomplete history.`,
            "meta",
          ),
        );
    }
    const own = await app.own.registers();
    const state = own?.judgments.get(target.id);
    if (state?.known && state.value && state.value !== "clear")
      body.append(
        el(
          "div",
          { class: "actions", style: "margin-top:8px" },
          button(
            "Clear my judgment",
            () =>
              app.session.requireUnlocked(
                target.describe("clear"),
                async () => {
                  if (!(await app.session.firstSignatureDisclosure())) return;
                  try {
                    await app.signer.publish([
                      {
                        action: {
                          kind: "judgment.set",
                          target: target.id,
                          value: "clear",
                        },
                        body: null,
                      },
                    ]);
                    app.own.invalidate();
                    app.announce(
                      "Your judgment is cleared. The earlier public record stays in history.",
                    );
                    options.onChange?.();
                  } catch (error) {
                    app.announce(describe(error));
                  }
                },
              ),
            { class: "btn btn-quiet" },
          ),
        ),
      );
  });
  append(details);
  void sr;
  return details;
}
