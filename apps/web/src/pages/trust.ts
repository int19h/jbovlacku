/** Trust: the active view, public decisions, private overrides, and the site view detail. */
import { el, p, link, text, button, describe, disclosure } from "../lib/dom.ts";
import { fractionText, plural } from "../lib/format.ts";
import {
  navigate,
  routes,
  type RenderContext,
  type Route,
} from "../app/router.ts";
import type { App } from "../app/context.ts";
import { calculationPanel } from "../components/localview.ts";
import { onDisconnect } from "../lib/lifetime.ts";
import { getManifest, loadRecord } from "../data/api.ts";
import { loadSiteView } from "../data/view.ts";
import { eventId, type ViewBody } from "../model/types.ts";
import { identityLink } from "../components/attribution.ts";
import { loadOwnHistory, scopeKey } from "../data/history.ts";
import type { Overlay } from "../data/store.ts";
import { renderRichText } from "../model/richtext.ts";
import { describeScope } from "../components/trustpanel.ts";
import { scopeError } from "../data/scope.ts";
import { describeProfile } from "../model/profiles.ts";

export { loadSiteView };
/**
 * Reads the rules again on the Trust page that is open now, if any. A signed
 * or removed choice refreshes the page that the reader is on, also when the
 * action started on an earlier visit.
 */
let refreshOpenTrustPage: (() => Promise<void>) | null = null;
const refreshTrust = () => refreshOpenTrustPage?.();
export async function trustPage(
  _route: Route,
  context: RenderContext,
  app: App,
) {
  const { main } = context;
  const live = () => context.live();
  context.title("Trust");
  main.className = "";
  main.append(
    el("h1", { class: "page", text: "Trust" }),
    p("Whose judgments order the definitions you see.", "muted"),
  );
  const prefs = app.session.preferences;
  const seg = el("div", {
    class: "seg",
    role: "radiogroup",
    "aria-label": "Active view",
  });
  let modeRequest = 0;
  // The radios and the panel follow the saved preference, also after a
  // change in another tab.
  const syncMode = (byReader: boolean) => {
    const saved = app.session.preferences.viewMode;
    for (const radio of seg.querySelectorAll("input"))
      radio.checked = radio.value === saved;
    for (const l of seg.querySelectorAll("label"))
      l.classList.toggle("on", l.querySelector("input")!.checked);
    showMode(byReader);
  };
  let modeSaving = 0;
  for (const [value, label] of [
    ["personal", "Mine: site view + my choices"],
    ["site", "Site view only"],
  ] as const) {
    const input = el("input", { type: "radio", name: "view-mode", value });
    input.checked = prefs.viewMode === value;
    const wrapper = el(
      "label",
      { class: input.checked ? "on" : "" },
      input,
      text(label),
    );
    input.addEventListener("change", async () => {
      const request = ++modeRequest;
      modeSaving++;
      try {
        await app.session.setPreferences({ viewMode: value });
      } catch {
      } finally {
        modeSaving--;
      }
      if (!live() || request !== modeRequest) return;
      syncMode(true);
    });
    seg.append(wrapper);
  }
  main.append(
    el(
      "fieldset",
      { style: "border:0;margin:14px 0 0;padding:0" },
      el("legend", { class: "sr", text: "Active view" }),
      seg,
    ),
  );
  // The calculation panel belongs to the personal view. The site view uses
  // the server's scores and needs no local calculation, but a download that
  // is still running keeps its panel and Cancel until it ends.
  const modeSlot = el("div");
  let shown: "personal" | "busy" | "site" | null = null;
  let busy = false;
  // `byReader` marks a swap that the reader's own action caused: a radio
  // change or Cancel. A swap that another tab or the end of a run causes
  // never takes the reader's focus away. While focus is in the panel, such a
  // swap waits until focus leaves it.
  const showMode = (byReader: boolean) => {
    const want =
      app.session.preferences.viewMode === "personal"
        ? "personal"
        : busy
          ? "busy"
          : "site";
    if (want === shown) return;
    const focused = document.activeElement;
    const focusInside = Boolean(focused && modeSlot.contains(focused));
    if (focusInside && !byReader) return;
    shown = want;
    modeSlot.replaceChildren(
      want !== "site"
        ? calculationPanel(app, {
            mode: "personal",
            context,
            label: "Local calculation",
            idleText:
              "No local calculation yet. It starts when a page needs personal scores, or now with Recompute from records.",
          })
        : p(
            "The site view shows this server's scores. It needs no calculation in this browser.",
            "small",
          ),
    );
    // The reader's own swap removed the focused control, so focus goes to
    // the view choice that now decides this part of the page.
    if (focusInside)
      seg.querySelector<HTMLInputElement>("input:checked")?.focus();
  };
  modeSlot.addEventListener("focusout", (event) => {
    if (!modeSlot.contains(event.relatedTarget as Node | null))
      queueMicrotask(() => showMode(false));
  });
  main.append(
    modeSlot,
    disclosure("How the two views work", () => [
      p(
        "The site view shows this server's scores for the signed view below. The personal view downloads the snapshot's records, verifies them in this browser, and applies your private choices from this browser. It adds your identity as a root with allocation 1 only if its continuity group has no allocation or private root change. A zero allocation or removal also prevents that addition.",
        "small",
      ),
      p(
        "The personal view applies your own effective public shuns as local blocks, as the format specifies: the core resolves their scopes and identity continuity in the calculation's snapshot, so a narrower public heed or a public clear can lift such a block. A private Trust rule does not cancel that block. A private Ignore stays until you remove it, also after a public clear.",
        "small",
      ),
      p(
        "When the local calculation cannot finish, word and search pages show unavailable scores instead of substituting site scores.",
        "small",
      ),
      p(
        "A private Ignore or a personal block removes that person and every route through them in your view only. A public shun is a signed declaration. Its effect on routes follows the calculation profile of the signed view, shown below, and it does not remove every influence of that person in every reader's view.",
        "small",
      ),
    ]),
  );
  const rules = trustRules(app, context);
  main.append(rules.node);
  refreshOpenTrustPage = () => (live() ? rules.refresh() : Promise.resolve());
  // A background update changes the panel and the rules in place. When such
  // an area is above the viewport, the content that the reader sees stays
  // where it is: the page scrolls by the height change. The check runs after
  // every listener of the change, and a browser that already kept the place
  // measures no change.
  const keepPlace = () => {
    const above = [rules.node, modeSlot].find(
      (area) => area.isConnected && area.getBoundingClientRect().bottom <= 0,
    );
    const below = above?.nextElementSibling;
    if (!below) return;
    const top = below.getBoundingClientRect().top;
    queueMicrotask(() => {
      if (!below.isConnected) return;
      const moved = below.getBoundingClientRect().top - top;
      if (Math.abs(moved) >= 0.5)
        window.scrollBy({ top: moved, behavior: "instant" });
    });
  };
  // The private rule reasons name the loaded calculation. When a calculation
  // ends, is cancelled, or fails, they follow it in place, whichever panel
  // started it.
  onDisconnect(
    modeSlot,
    app.personal.subscribe((status) => {
      keepPlace();
      busy = status.state === "downloading" || status.state === "evaluating";
      // Only the panel's Cancel button cancels a calculation.
      showMode(status.state === "failed" && status.kind === "cancelled");
      if (!busy) rules.followCalculation();
    }),
    context.signal,
  );
  onDisconnect(
    modeSlot,
    app.session.subscribe(() => {
      keepPlace();
      if (!modeSaving) syncMode(false);
    }),
    context.signal,
  );
  await rules.refresh();
  if (!live()) return;
  // Site view.
  main.append(el("h2", { class: "section", text: "Site view" }));
  const view = await loadSiteView(context.signal);
  if (!live()) return;
  main.append(viewChooser(app, view.id, context));
  if (!view.body) {
    main.append(
      p(view.error ?? "The site view body is unavailable.", "notice"),
    );
    if (view.id) main.append(p(`View event ${view.id}`, "fingerprint"));
    return;
  }
  const body = view.body;
  if (view.issuer) {
    const publisher = identityLink(view.issuer);
    publisher.classList.add("touch-link");
    main.append(el("p", { class: "small" }, text("Published by "), publisher));
  }
  const profile = describeProfile(body.calculation);
  main.append(
    p(
      `${body.name}. ${prefs.view ? "Chosen by you by its event ID." : "Selected by this server."} Trust starts from these roots and spreads to the people they trust.`,
      "small",
    ),
    p(
      profile.known
        ? `Calculation profile ${body.calculation}: ${profile.shunRule}`
        : `Calculation profile ${body.calculation}: ${profile.shunRule} Scores under this view are unavailable in this client.`,
      "small",
    ),
  );
  if (body.description.length)
    main.append(
      renderRichText(body.description, { placeHref: null, className: "small" }),
    );
  const roots = el("p", { class: "trust-roots" });
  if (!body.roots.length)
    roots.append(
      text(
        "No roots. Every score in this view is zero until the operator configures roots.",
        "small",
      ),
    );
  body.roots.forEach((root, index) => {
    if (index) roots.append(text(" · "));
    roots.append(
      identityLink(root.identity),
      text(` q=${fractionText(root.q)}`, "meta"),
    );
  });
  main.append(roots);
  main.append(
    disclosure("Settings and history", () => {
      const dl = el("dl", { class: "kv" });
      const row = (k: string, v: Node | string) =>
        dl.append(
          el(
            "div",
            {},
            el("dt", { text: k }),
            el("dd", {}, typeof v === "string" ? text(v) : v),
          ),
        );
      row(
        "Outward allowance (H)",
        `${fractionText(body.H)} · an outward multiplier, not a route depth limit`,
      );
      row("Passed on (alpha)", fractionText(body.alpha));
      row("Rafsi threshold", fractionText(body.rafsi_threshold));
      row("Work budget", String(body.work));
      row("Calculation", body.calculation);
      row(
        "Excluded",
        body.excluded.length
          ? el(
              "span",
              {},
              ...(body.excluded
                .flatMap((e, i) => [
                  i ? text(", ") : null,
                  identityLink(e.identity),
                  text(
                    ` (${plural(e.evidence.length, "evidence record")})`,
                    "meta",
                  ),
                ])
                .filter(Boolean) as Node[]),
            )
          : "none",
      );
      row(
        "Imports and selections",
        body.import_sets.length
          ? body.import_sets
              .map(
                (s) =>
                  `${s.source} by ${s.importer.slice(0, 16)}… selection ${s.selection.slice(0, 19)}…`,
              )
              .join("; ")
          : "none",
      );
      row("Account authority", body.account_authority ? "on" : "off");
      row(
        "Witnesses",
        body.account_witnesses.length
          ? el(
              "span",
              {},
              ...(body.account_witnesses
                .flatMap((w, i) => [i ? text(", ") : null, identityLink(w)])
                .filter(Boolean) as Node[]),
            )
          : "none",
      );
      row(
        "View event",
        link(view.id, routes.definition(view.id), {
          class: "fingerprint touch-link",
        }),
      );
      return [
        dl,
        p(
          "H and alpha are initial values for real-use tuning. Full transitivity remains part of the calculation.",
          "meta",
        ),
        p(
          "You can use another retained signed view by its exact event ID in the chooser above. That choice pins that version. Browsing the earlier versions of a view and following the later changes of another view need a view history endpoint that this server does not expose yet.",
          "meta",
        ),
      ];
    }),
  );
  void eventId;
}
type TrustScope = {
  kind: "definition" | "rafsi" | "*";
  word: string;
  language: string;
};
/** One listed rule: its node stays while the rule stays, and only its text changes. */
interface RuleRow {
  node: HTMLElement;
  detail: HTMLElement;
}
/**
 * The public and private rules of the Trust page. `refresh` reads the saved
 * rules again after an action. `followCalculation` updates the private rule
 * reasons for the calculation that is loaded now. Both update the existing
 * rows in place and move a row between sections when its section changes, so
 * the rest of the page, the reader's focus, and the scroll position stay.
 */
function trustRules(app: App, context: RenderContext) {
  const node = el("div");
  const source = p("", "meta");
  source.hidden = true;
  const section = (title: string) => {
    const heading = el("h2", { class: "section", text: title, tabindex: -1 });
    const list = el("div");
    return { heading, list };
  };
  const trusted = section("People I trust");
  const ignored = section("People I ignore");
  const conflicted = section("Conflicting public choices");
  const inactive = section("Private rules that need attention");
  // The text in an empty list. It is in the list only while the list has no rows.
  let nobodyTrusted: HTMLElement | null = null;
  const nobodyIgnored = p("Nobody.", "small");
  node.append(
    source,
    trusted.heading,
    trusted.list,
    ignored.heading,
    ignored.list,
    p(
      "Public choices are signed and stay in history after you undo them. Ignoring someone is not an accusation.",
      "meta",
    ),
    conflicted.heading,
    conflicted.list,
    inactive.heading,
    inactive.list,
  );
  const rows = new Map<string, RuleRow>();
  let data: {
    overlay: Awaited<ReturnType<App["store"]["overlay"]>> | null;
    registers: Awaited<ReturnType<App["own"]["registers"]>>;
    history: Awaited<ReturnType<typeof loadOwnHistory>> | null;
    identity: string | null;
  } | null = null;
  let request = 0;
  let shownContinuity: string | null | undefined;
  const continuityKey = () => {
    const loaded = app.personal.loadedContinuity;
    return loaded
      ? JSON.stringify([loaded.snapshot, loaded.view, loaded.actors])
      : null;
  };
  const row = (
    key: string,
    build: () => {
      kind: string;
      subject: string;
      extra?: HTMLElement | null;
      actions: HTMLElement[];
    },
  ): RuleRow => {
    const existing = rows.get(key);
    if (existing) return existing;
    const parts = build();
    const detail = text("", "meta");
    const node = el("div", { class: "row" });
    node.append(
      el("span", { class: "k", text: parts.kind }),
      el(
        "span",
        { class: "t" },
        el("span", {}, identityLink(parts.subject), detail),
        parts.extra ?? null,
      ),
      ...parts.actions,
    );
    const created = { node, detail };
    rows.set(key, created);
    return created;
  };
  const undoPublic = (subject: string, scope: TrustScope) =>
    button(
      "Undo",
      () =>
        app.session.requireUnlocked(
          `Clearing public trust for ${subject.slice(8, 16)}`,
          async () => {
            if (!(await app.session.firstSignatureDisclosure())) return;
            try {
              const results = await app.signer.publish([
                {
                  action: { kind: "trust.set", subject, scope, value: "clear" },
                  body: null,
                },
              ]);
              app.own.invalidate();
              const { publicClearOutcome } =
                await import("../components/trustpanel.ts");
              app.announce(publicClearOutcome(results));
              await refreshTrust();
            } catch (error) {
              app.announce(describe(error));
            }
          },
        ),
      { class: "btn btn-quiet" },
    );
  const removeButton = (change: (overlay: Overlay) => void) =>
    button(
      "Remove",
      async () => {
        try {
          await app.store.updateOverlay(change);
          await refreshTrust();
        } catch (error) {
          app.announce(describe(error));
        }
      },
      { class: "btn btn-quiet" },
    );
  /** Builds the wanted rows from the read rules and the loaded calculation, then places them. */
  const place = () => {
    if (!data) return;
    const { overlay, registers, history, identity } = data;
    const continuity = app.personal.loadedContinuity;
    shownContinuity = continuityKey();
    const actor = (key: string) => continuity?.actors[key] ?? key;
    const wanted = new Map<HTMLElement, HTMLElement[]>([
      [trusted.list, []],
      [ignored.list, []],
      [conflicted.list, []],
      [inactive.list, []],
    ]);
    const put = (list: HTMLElement, entry: RuleRow, detail: string) => {
      if (entry.detail.textContent !== detail)
        entry.detail.textContent = detail;
      wanted.get(list)!.push(entry.node);
    };
    const parseKey = (key: string) => {
      const [subject, kind, word, language] = key.split("|");
      return {
        subject,
        scope: { kind: kind as TrustScope["kind"], word, language },
      };
    };
    for (const [key, state] of registers?.trust.entries() ?? []) {
      if (!state.known) continue;
      const { subject, scope } = parseKey(key);
      if (state.conflicted) {
        const values = state.events.map((id) =>
          String(history?.events.get(id)?.header.action.value ?? "unknown"),
        );
        put(
          conflicted.list,
          row(`conflict|${key}`, () => ({
            kind: "conflict",
            subject,
            actions: [undoPublic(subject, scope)],
          })),
          ` ${describeScope(scope)} · your devices disagree. Values: ${values.join(", ")}. ${values.includes("shun") ? "Under simple-routes-shun-v1, a conflict that contains shun refuses this issuer route. " : ""}State the value again to resolve it.`,
        );
      } else if (state.value && state.value !== "clear")
        put(
          state.value === "heed" ? trusted.list : ignored.list,
          row(`public|${key}|${state.value}`, () => ({
            kind: "public",
            subject,
            actions: [undoPublic(subject, scope)],
          })),
          ` ${describeScope(scope)}`,
        );
    }
    for (const rule of overlay?.trust ?? []) {
      if (rule.value === "clear") continue;
      const invalid = scopeError(rule.scope);
      const validIssuer = /^ed25519:[0-9a-f]{64}$/.test(rule.issuer);
      const sameActor = Boolean(
        identity && actor(rule.issuer) === actor(identity),
      );
      const ineffective = !validIssuer || !sameActor;
      const effect = !ineffective
        ? ""
        : rule.issuer === "local"
          ? "This rule was saved before this browser had a key. It moves to your key when you create or restore one."
          : !validIssuer
            ? "This rule has no valid issuer. Remove it or save a rule with your current key."
            : continuity
              ? "This rule does not apply in the loaded personal calculation. Its snapshot does not connect the issuer to your key."
              : "No personal calculation is loaded. This rule depends on accepted continuity in the next calculation snapshot.";
      const scope = scopeKey(rule.scope);
      put(
        invalid || ineffective
          ? inactive.list
          : rule.value === "heed"
            ? trusted.list
            : ignored.list,
        row(
          `private|${JSON.stringify([rule.issuer, rule.subject, scope, rule.value, rule.weight])}`,
          () => ({
            kind: invalid ? "invalid" : "private",
            subject: rule.subject,
            actions: [
              button(
                "Make public",
                () =>
                  makePublic(
                    app,
                    rule.subject,
                    rule.scope,
                    rule.value === "heed" ? "heed" : "shun",
                  ),
                { class: "btn btn-quiet" },
              ),
              removeButton((current) => {
                current.trust = current.trust.filter(
                  (r) =>
                    !(
                      r.issuer === rule.issuer &&
                      r.subject === rule.subject &&
                      scopeKey(r.scope) === scope
                    ),
                );
              }),
            ],
          }),
        ),
        ` ${describeScope(rule.scope)}${rule.weight ? ` · weight ${fractionText(rule.weight)}` : ""}${invalid ? ` · Invalid saved scope. ${invalid} Remove this rule to repair the personal view.` : effect ? ` · ${effect}` : ""}`,
      );
    }
    for (const blocked of overlay?.blocked ?? []) {
      const invalid = scopeError(blocked.scope);
      const scope = scopeKey(blocked.scope);
      const entry = row(
        `blocked|${JSON.stringify([blocked.identity, scope, blocked.reason ?? null])}`,
        () => ({
          kind: "private",
          subject: blocked.identity,
          extra: blocked.reason ? el("small", { text: blocked.reason }) : null,
          actions: [
            button(
              "Make public",
              () => makePublic(app, blocked.identity, blocked.scope, "shun"),
              { class: "btn btn-quiet" },
            ),
            removeButton((current) => {
              current.blocked = current.blocked.filter(
                (b) =>
                  !(
                    b.identity === blocked.identity &&
                    scopeKey(b.scope) === scope
                  ),
              );
            }),
            ...(invalid
              ? [
                  p(
                    `Invalid saved scope. ${invalid} Remove this block to repair the personal view.`,
                    "notice",
                  ),
                ]
              : []),
          ],
        }),
      );
      put(
        invalid ? inactive.list : ignored.list,
        entry,
        ` ${describeScope(blocked.scope)} · also blocks trust that passes through them`,
      );
    }
    // Place the rows. A row that keeps its place is not touched. A moved row
    // keeps the reader's focus. A removed row hands focus to its section.
    const focused = document.activeElement as HTMLElement | null;
    const focusedRow = focused?.closest<HTMLElement>(".row") ?? null;
    let lostFrom: HTMLElement | null = null;
    const keep = new Set([...wanted.values()].flat());
    for (const [key, entry] of rows)
      if (!keep.has(entry.node)) {
        if (entry.node === focusedRow) lostFrom = entry.node.parentElement;
        entry.node.remove();
        rows.delete(key);
      }
    for (const [list, nodes] of wanted)
      nodes.forEach((child, index) => {
        if (list.children[index] !== child)
          list.insertBefore(child, list.children[index] ?? null);
      });
    if (focused && focused.isConnected && document.activeElement !== focused)
      focused.focus({ preventScroll: true });
    if (lostFrom) {
      const heading = [trusted, ignored, conflicted, inactive].find(
        (entry) => entry.list === lostFrom,
      )?.heading;
      heading?.focus({ preventScroll: true });
    }
    source.hidden = !(
      continuity && overlay?.trust.some((rule) => rule.value !== "clear")
    );
    if (continuity)
      source.textContent = `Private rule labels use personal calculation snapshot ${continuity.snapshot} and view ${continuity.view}.`;
    if (wanted.get(trusted.list)!.length) nobodyTrusted?.remove();
    else {
      const empty = identity
        ? p(
            registers
              ? "Nobody yet. Open an identity page and choose Trust their judgments."
              : "Your public choices are unknown because your history could not be read.",
            "small",
          )
        : el(
            "p",
            { class: "notice" },
            text("Private trust needs a key. "),
            link("Create or restore your key", routes.localIdentity),
          );
      if (
        !nobodyTrusted?.isConnected ||
        nobodyTrusted.textContent !== empty.textContent
      ) {
        nobodyTrusted?.remove();
        nobodyTrusted = empty;
        trusted.list.append(empty);
      }
    }
    if (wanted.get(ignored.list)!.length) nobodyIgnored.remove();
    else if (!nobodyIgnored.isConnected) ignored.list.append(nobodyIgnored);
    for (const entry of [conflicted, inactive])
      entry.heading.hidden = !entry.list.childElementCount;
  };
  return {
    node,
    /** Reads the saved rules again. A read that a later read replaced writes nothing. */
    async refresh() {
      const current = ++request;
      const overlay = await app.store.overlay().catch(() => null);
      const registers = await app.own.registers();
      const identity = app.session.identity;
      const conflicts =
        registers &&
        [...registers.trust.values()].some(
          (state) => state.known && state.conflicted,
        );
      const history =
        conflicts && identity
          ? await loadOwnHistory(app.store, identity, {
              offline: app.offlineSigning.value,
            }).catch(() => null)
          : null;
      if (!context.live() || current !== request) return;
      data = { overlay, registers, history, identity: identity ?? null };
      place();
    },
    /** Updates the private rule reasons when the loaded calculation changed. */
    followCalculation() {
      if (data && continuityKey() !== shownContinuity) place();
    },
  };
}
async function makePublic(
  app: App,
  subject: string,
  scope: { kind: "definition" | "rafsi" | "*"; word: string; language: string },
  value: "heed" | "shun",
) {
  const { confirmPublicTrust, previewProfile, publicTrustOutcome } =
    await import("../components/trustpanel.ts");
  // The preview explains a shun under the profile of the signed view in use,
  // or says that the view did not load.
  const view = await loadSiteView().catch((error) => ({
    id: "",
    body: null,
    error: describe(error),
  }));
  const ok = await confirmPublicTrust(
    app,
    subject,
    scope,
    value,
    previewProfile(view),
  );
  if (!ok) return;
  await app.session.requireUnlocked(
    `Publishing ${value === "heed" ? "trust" : "ignore"} for ${subject.slice(8, 16)}`,
    async () => {
      if (!(await app.session.firstSignatureDisclosure())) return;
      try {
        const results = await app.signer.publish([
          { action: { kind: "trust.set", subject, scope, value }, body: null },
        ]);
        app.own.invalidate();
        app.announce(publicTrustOutcome(results));
        await refreshTrust();
      } catch (error) {
        app.announce(describe(error));
      }
    },
  );
}

/**
 * The signed view the reader uses, by event ID. The server's selected view is
 * the default. Another retained view can be chosen by its ID; that is the only
 * way to change the calculation profile, because a view names its profile.
 */
function viewChooser(app: App, current: string, context: RenderContext) {
  const box = el("div", { class: "card small", style: "margin:8px 0 12px" });
  const prefs = app.session.preferences;
  box.append(
    el(
      "p",
      {},
      text("Signed view in use: "),
      el("span", { class: "fingerprint", text: current || "unknown" }),
    ),
    p(
      prefs.view
        ? "You chose this view by its event ID. The server's own selected view stays available."
        : "This is the server's selected view. You can use another retained signed view by its event ID. Each signed view names its calculation profile, so this is how a profile is chosen.",
      "meta",
    ),
  );
  const input = el("input", {
    class: "field",
    "aria-label": "Signed view event ID",
    placeholder: "jve1:…",
    style: "width:100%;max-width:40rem;",
    spellcheck: "false",
  });
  const status = el("p", { class: "meta", role: "status" });
  let viewRequest = 0;
  const apply = async () => {
    const request = ++viewRequest;
    const id = input.value.trim();
    if (!eventId(id)) {
      status.textContent =
        "Enter a view event ID of the form jve1: followed by 64 hex characters.";
      return;
    }
    status.textContent = "Checking the view…";
    try {
      const manifest = await getManifest({ signal: context.signal });
      const record = await loadRecord<ViewBody>(id, manifest.snapshot, {
        signal: context.signal,
      });
      if (record.envelope.header.action.kind !== "view.publish")
        throw new Error("That record is not a signed view.");
      if (!record.body)
        throw new Error(record.bodyError ?? "The view body is unavailable.");
      const profile = describeProfile(record.body.calculation);
      if (!context.live() || request !== viewRequest) return;
      await app.session.setPreferences({ view: id });
      await app.personal.forgetView();
      if (!context.live() || request !== viewRequest) return;
      status.textContent = `Using "${record.body.name}" with calculation profile ${record.body.calculation}.${profile.known ? "" : " This client does not know that profile, so scores stay unavailable."}`;
      navigate(routes.trust, { replace: true });
    } catch (error) {
      if (!context.live() || request !== viewRequest) return;
      status.textContent = `That view cannot be used: ${describe(error)}`;
    }
  };
  const actions = el(
    "div",
    { class: "actions", style: "margin-top:6px" },
    button("Use this view", apply, { class: "btn" }),
  );
  if (prefs.view)
    actions.append(
      button(
        "Back to the server's view",
        async () => {
          const request = ++viewRequest;
          try {
            await app.session.setPreferences({ view: null });
          } catch {
            return;
          }
          await app.personal.forgetView();
          if (context.live() && request === viewRequest)
            navigate(routes.trust, { replace: true });
        },
        { class: "btn btn-quiet" },
      ),
    );
  box.append(input, actions, status);
  return box;
}
