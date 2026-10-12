/** Trust: the active view, public decisions, private overrides, and the site view detail. */
import { el, p, link, text, button, describe, disclosure } from "../lib/dom.ts";
import { fractionText, plural } from "../lib/format.ts";
import { routes, type RenderContext, type Route } from "../app/router.ts";
import type { App } from "../app/context.ts";
import { getManifest, getWord, loadRecord } from "../data/api.ts";
import { eventId, type ViewBody } from "../model/types.ts";
import { identityLink } from "../components/attribution.ts";
import { scopeKey } from "../data/history.ts";
import { renderRichText } from "../model/richtext.ts";
import { describeScope } from "../components/trustpanel.ts";

/** Loads the selected public view event of this server. */
export async function loadSiteView(
  signal?: AbortSignal,
): Promise<{ id: string; body: ViewBody | null; error: string | null }> {
  // The view ID is reported with every word response. A manifest alone does not name it,
  // so the client reads a search or word response. A zero-word request is cheapest.
  const manifest = await getManifest({ signal });
  const probe = await getWord("jvw1:" + "0".repeat(64), {
    snapshot: manifest.snapshot,
    signal,
  }).catch(() => null);
  if (!probe)
    return {
      id: "",
      body: null,
      error: "The server did not report its selected view.",
    };
  try {
    const record = await loadRecord<ViewBody>(probe.view, manifest.snapshot, {
      signal,
    });
    return { id: probe.view, body: record.body, error: record.bodyError };
  } catch (error) {
    return { id: probe.view, body: null, error: describe(error) };
  }
}
export async function trustPage(
  _route: Route,
  context: RenderContext,
  app: App,
) {
  const { main } = context;
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
      await app.session.setPreferences({ viewMode: value });
      for (const l of seg.querySelectorAll("label"))
        l.classList.toggle("on", l.querySelector("input")!.checked);
      app.shell.setViewLabel(
        value === "personal" ? "Trust: personal view" : "Trust: site view",
      );
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
  main.append(
    p(
      "The site view shows this server's scores. The personal view applies your private choices in this browser. This build cannot compute personal scores yet, so word and search pages show unavailable scores in the personal view instead of substituting site scores. Your private choices are still saved here.",
      "meta",
    ),
  );
  const overlay = await app.store.overlay().catch(() => null);
  const registers = await app.own.registers();
  if (!context.live()) return;
  // People I trust.
  main.append(el("h2", { class: "section", text: "People I trust" }));
  const trusted = el("div");
  const ignored = el("div");
  const publicRows = registers
    ? [...registers.trust.entries()].filter(
        ([, state]) =>
          state.known &&
          !state.conflicted &&
          state.value &&
          state.value !== "clear",
      )
    : [];
  const conflicts = registers
    ? [...registers.trust.entries()].filter(
        ([, state]) => state.known && state.conflicted,
      )
    : [];
  const parseKey = (key: string) => {
    const [subject, kind, word, language] = key.split("|");
    return {
      subject,
      scope: { kind: kind as "definition" | "rafsi" | "*", word, language },
    };
  };
  const undoPublic = (
    subject: string,
    scope: ReturnType<typeof parseKey>["scope"],
  ) =>
    button(
      "Undo",
      () =>
        app.session.requireUnlocked(
          `Clearing public trust for ${subject.slice(8, 16)}`,
          async () => {
            if (!(await app.session.firstSignatureDisclosure())) return;
            try {
              await app.signer.publish([
                {
                  action: { kind: "trust.set", subject, scope, value: "clear" },
                  body: null,
                },
              ]);
              app.own.invalidate();
              app.announce(
                "Signed a clear. The earlier public choice stays in history.",
              );
              rerender();
            } catch (error) {
              app.announce(describe(error));
            }
          },
        ),
      { class: "btn btn-quiet", style: "min-height:36px" },
    );
  const rerender = () => {
    if (!context.live()) return;
    main.replaceChildren();
    void trustPage(_route, context, app);
  };
  for (const [key, state] of publicRows) {
    const { subject, scope } = parseKey(key);
    if (!state.known || state.conflicted) continue;
    const row = el("div", { class: "row" });
    row.append(
      el("span", { class: "k", text: "public" }),
      el(
        "span",
        { class: "t" },
        el(
          "span",
          {},
          identityLink(subject),
          text(` ${describeScope(scope)}`, "meta"),
        ),
      ),
      undoPublic(subject, scope),
    );
    (state.value === "heed" ? trusted : ignored).append(row);
  }
  for (const [key] of conflicts) {
    const { subject, scope } = parseKey(key);
    const row = el("div", { class: "row" });
    row.append(
      el("span", { class: "k", text: "conflict" }),
      el(
        "span",
        { class: "t" },
        el(
          "span",
          {},
          identityLink(subject),
          text(
            ` ${describeScope(scope)} · your devices disagree. State the value again to resolve it.`,
            "meta",
          ),
        ),
      ),
      undoPublic(subject, scope),
    );
    trusted.append(row);
  }
  for (const rule of overlay?.trust ?? []) {
    if (rule.value === "clear") continue;
    const row = el("div", { class: "row" });
    row.append(
      el("span", { class: "k", text: "private" }),
      el(
        "span",
        { class: "t" },
        el(
          "span",
          {},
          identityLink(rule.subject),
          text(
            ` ${describeScope(rule.scope)}${rule.weight ? ` · weight ${fractionText(rule.weight)}` : ""}`,
            "meta",
          ),
        ),
      ),
      button(
        "Make public",
        () =>
          makePublic(
            app,
            rule.subject,
            rule.scope,
            rule.value === "heed" ? "heed" : "shun",
            rerender,
          ),
        { class: "btn btn-quiet", style: "min-height:36px" },
      ),
      button(
        "Remove",
        async () => {
          const current = await app.store.overlay();
          current.trust = current.trust.filter(
            (r) =>
              !(
                r.subject === rule.subject &&
                scopeKey(r.scope) === scopeKey(rule.scope)
              ),
          );
          await app.store.setOverlay(current);
          rerender();
        },
        { class: "btn btn-quiet", style: "min-height:36px" },
      ),
    );
    (rule.value === "heed" ? trusted : ignored).append(row);
  }
  for (const blocked of overlay?.blocked ?? []) {
    const row = el("div", { class: "row" });
    row.append(
      el("span", { class: "k", text: "private" }),
      el(
        "span",
        { class: "t" },
        el(
          "span",
          {},
          identityLink(blocked.identity),
          text(
            ` ${describeScope(blocked.scope)} · also blocks trust that passes through them`,
            "meta",
          ),
        ),
        blocked.reason ? el("small", { text: blocked.reason }) : null,
      ),
      button(
        "Make public",
        () =>
          makePublic(app, blocked.identity, blocked.scope, "shun", rerender),
        { class: "btn btn-quiet", style: "min-height:36px" },
      ),
      button(
        "Remove",
        async () => {
          const current = await app.store.overlay();
          current.blocked = current.blocked.filter(
            (b) =>
              !(
                b.identity === blocked.identity &&
                scopeKey(b.scope) === scopeKey(blocked.scope)
              ),
          );
          await app.store.setOverlay(current);
          rerender();
        },
        { class: "btn btn-quiet", style: "min-height:36px" },
      ),
    );
    ignored.append(row);
  }
  if (!trusted.childElementCount)
    trusted.append(
      p(
        app.session.identity
          ? registers
            ? "Nobody yet. Open an identity page and choose Trust their judgments."
            : "Your public choices are unknown because your history could not be read."
          : "Create a key to trust or ignore identities.",
        "small",
      ),
    );
  main.append(trusted, el("h2", { class: "section", text: "People I ignore" }));
  if (!ignored.childElementCount) ignored.append(p("Nobody.", "small"));
  main.append(
    ignored,
    p(
      "Public choices are signed and stay in history after you undo them. Ignoring someone is not an accusation.",
      "meta",
    ),
  );
  // Site view.
  main.append(el("h2", { class: "section", text: "Site view" }));
  const view = await loadSiteView(context.signal);
  if (!context.live()) return;
  if (!view.body) {
    main.append(
      p(view.error ?? "The site view body is unavailable.", "notice"),
    );
    if (view.id) main.append(p(`View event ${view.id}`, "fingerprint"));
    return;
  }
  const body = view.body;
  main.append(
    p(
      `${body.name}. Published by this server. Trust starts from these roots and spreads to the people they trust.`,
      "small",
    ),
  );
  if (body.description.length)
    main.append(
      renderRichText(body.description, { placeHref: null, className: "small" }),
    );
  const roots = el("p");
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
        link(view.id, routes.definition(view.id), { class: "fingerprint" }),
      );
      return [
        dl,
        p(
          "H and alpha are initial values for real-use tuning. Full transitivity remains part of the calculation.",
          "meta",
        ),
        p(
          "Pinning a version, using another view, and earlier versions need a view history endpoint that this server does not expose yet.",
          "meta",
        ),
      ];
    }),
  );
  void eventId;
}
async function makePublic(
  app: App,
  subject: string,
  scope: { kind: "definition" | "rafsi" | "*"; word: string; language: string },
  value: "heed" | "shun",
  done: () => void,
) {
  const { confirmPublicTrust } = await import("../components/trustpanel.ts");
  const ok = await confirmPublicTrust(app, subject, scope, value);
  if (!ok) return;
  await app.session.requireUnlocked(
    `Publishing ${value === "heed" ? "trust" : "ignore"} for ${subject.slice(8, 16)}`,
    async () => {
      if (!(await app.session.firstSignatureDisclosure())) return;
      try {
        await app.signer.publish([
          { action: { kind: "trust.set", subject, scope, value }, body: null },
        ]);
        app.own.invalidate();
        app.announce(
          "Signed. Others can build on it. It stays in history after you undo it.",
        );
        done();
      } catch (error) {
        app.announce(describe(error));
      }
    },
  );
}
