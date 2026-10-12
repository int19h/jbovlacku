/** Public identity: fingerprint, profile when known, trust actions, and this server's evidence. */
import { el, p, link, text, button, describe } from "../lib/dom.ts";
import { fingerprintText, plural, shortIdentity } from "../lib/format.ts";
import { getActivity } from "../data/api.ts";
import {
  identityProfile,
  profileName,
  identityLink,
} from "../components/attribution.ts";
import { renderRichText } from "../model/richtext.ts";
import { routes, type RenderContext, type Route } from "../app/router.ts";
import type { App } from "../app/context.ts";
import { identityId } from "../model/types.ts";
import { trustPanel } from "../components/trustpanel.ts";
import { loadSiteView } from "./trust.ts";
import { scopeKey } from "../data/history.ts";

export async function personPage(
  route: Route,
  context: RenderContext,
  app: App,
) {
  const { main } = context;
  main.className = "";
  const identity = route.segments[1] ?? "";
  if (!identityId(identity)) {
    context.title("Identity");
    main.append(
      el("h1", { class: "page", text: "Identity unavailable" }),
      p("This link does not name an identity key.", "notice"),
    );
    return;
  }
  const isSelf = app.session.identity === identity;
  context.title(shortIdentity(identity));
  const response = await identityProfile(identity);
  if (!context.live()) return;
  const name = profileName(response);
  context.title(name ?? shortIdentity(identity));
  main.append(
    el(
      "h1",
      { style: "font-size:32px;letter-spacing:-0.02em;font-weight:680" },
      el("bdi", { text: name ?? shortIdentity(identity) }),
    ),
    el("p", {
      class: "fingerprint",
      style: "margin-top:4px",
      text: fingerprintText(identity),
    }),
  );
  if (!response)
    main.append(
      p(
        "This server did not answer the identity request. The profile and activity cannot be shown right now.",
        "notice",
      ),
    );
  else {
    const profile = response.profile;
    if (profile.state === "none")
      main.append(p("No signed profile claim is known for this key.", "small"));
    else if (profile.state === "unavailable")
      main.append(
        p(
          "The newest profile claim's body is unavailable, so no earlier profile is shown as current.",
          "notice",
        ),
      );
    else if (profile.state === "conflicted") {
      main.append(
        p(
          "This key has concurrent profile claims. Both are shown. Neither is selected as current.",
          "notice",
        ),
      );
      for (const claim of profile.claims)
        main.append(
          el(
            "div",
            { class: "card small", style: "margin-top:8px" },
            el("p", {}, el("bdi", { text: claim.body?.name ?? "unavailable" })),
            claim.body
              ? renderRichText(claim.body.bio, { placeHref: null })
              : null,
            el(
              "p",
              { class: "meta" },
              link(claim.event, routes.definition(claim.event), {
                class: "fingerprint",
              }),
            ),
          ),
        );
    } else {
      const body = profile.claims[0]?.body;
      if (body) {
        const line = el("p", { style: "margin-top:12px" });
        if (body.bio.length)
          line.append(
            renderRichText(body.bio, { placeHref: null, paragraph: "span" }),
          );
        for (const url of body.links)
          line.append(
            text(line.childElementCount ? " · " : ""),
            link(url, url, { rel: "noopener noreferrer", target: "_blank" }),
          );
        main.append(line);
      }
    }
    if (response.actor !== identity)
      main.append(
        el(
          "p",
          { class: "small" },
          text("This key belongs to the continuity group of "),
          identityLink(response.actor),
          text("."),
        ),
      );
    if (response.successor)
      main.append(
        el(
          "p",
          { class: "small" },
          text("Known successor: "),
          identityLink(response.successor),
          text(". Ordinary actions from this key are retired."),
        ),
      );
    if (response.compromised)
      main.append(
        p(
          "A compromise notice from this key limits its later history.",
          "notice",
        ),
      );
    if (response.suspended)
      main.append(
        p(
          "This identity is suspended in the selected view because part of its history is missing.",
          "notice",
        ),
      );
    const c = response.counts;
    const parts = [
      plural(c.definitions, "definition"),
      plural(c.judgments, "judgment"),
    ];
    if (c.rafsi) parts.push(plural(c.rafsi, "rafsi claim"));
    if (c.trust) parts.push(plural(c.trust, "trust choice"));
    if (c.reports) parts.push(plural(c.reports, "report"));
    main.append(p(parts.join(" · "), "meta"));
  }
  if (isSelf)
    main.append(
      el(
        "p",
        { class: "small" },
        text("This is your key. "),
        link("Manage it", routes.localIdentity),
      ),
    );
  const view = await loadSiteView(context.signal).catch(() => null);
  if (!context.live()) return;
  if (view?.body) {
    const root = view.body.roots.find((r) => r.identity === identity);
    if (root)
      main.append(
        p(
          `Root of the site's trust view with allocation ${root.q.numerator}/${root.q.denominator}. This describes the selected view only.`,
          "meta",
        ),
      );
    if (view.body.account_witnesses.includes(identity))
      main.append(p("Account witness in the site view.", "meta"));
    if (view.body.excluded.some((e) => e.identity === identity))
      main.append(
        p(
          "Excluded by the site view publisher. An exclusion is a moderation choice, not a protocol verdict.",
          "notice",
        ),
      );
  }
  const overlay = await app.store.overlay().catch(() => null);
  const registers = await app.own.registers();
  if (!context.live()) return;
  const own = registers
    ? [...registers.trust.entries()].filter(
        ([key, state]) =>
          key.startsWith(`${identity}|`) &&
          state.known &&
          !state.conflicted &&
          state.value &&
          state.value !== "clear",
      )
    : [];
  const privateRules = (overlay?.trust ?? []).filter(
    (r) => r.subject === identity && r.value !== "clear",
  );
  const blocks = (overlay?.blocked ?? []).filter(
    (b) => b.identity === identity,
  );
  if (own.length || privateRules.length || blocks.length) {
    const status = el("p", { class: "small" });
    const parts: string[] = [];
    for (const [key, state] of own)
      if (state.known && !state.conflicted)
        parts.push(
          `${state.value === "heed" ? "Trusted" : "Ignored"} publicly (${describeKey(key)})`,
        );
    for (const rule of privateRules)
      parts.push(
        `${rule.value === "heed" ? "Trusted" : "Ignored"} privately (${scopeKey(rule.scope)})`,
      );
    for (const block of blocks)
      parts.push(`Ignored privately (${scopeKey(block.scope)})`);
    status.append(
      text(`Your choices: ${parts.join("; ")}. `),
      link("Manage on the Trust page", routes.trust),
    );
    main.append(status);
  }
  if (!isSelf) {
    const actions = el("div", { class: "actions", style: "margin-top:20px" });
    const slot = el("div");
    const open = (mode: "trust" | "ignore") => () => {
      slot.replaceChildren(
        trustPanel(app, {
          subject: identity,
          name: null,
          mode,
          onDone: () => {
            slot.replaceChildren();
            trustButton.focus();
          },
        }),
      );
      trustButton.setAttribute("aria-expanded", String(mode === "trust"));
      ignoreButton.setAttribute("aria-expanded", String(mode === "ignore"));
    };
    const trustButton = button("Trust their judgments", open("trust"), {
      class: "btn",
      "aria-expanded": "false",
    });
    const ignoreButton = button("Ignore their judgments", open("ignore"), {
      class: "btn btn-quiet",
      "aria-expanded": "false",
    });
    const report = button("Report abuse", () => reportDialog(app, identity), {
      class: "btn btn-quiet",
      style: "margin-left:auto",
    });
    actions.append(trustButton, ignoreButton, report);
    main.append(actions, slot);
  }
  main.append(el("h2", { class: "section", text: "Recent" }));
  const list = el("ol", { "aria-label": "Recent activity" });
  const more = el("p", { style: "margin-top:6px" });
  main.append(list, more);
  let after: string | null = null;
  const loadMore = async () => {
    try {
      const page = await getActivity(identity, after, {
        signal: context.signal,
        limit: 20,
      });
      if (!context.live()) return;
      for (const item of page.items) list.append(activityRow(item));
      after = page.next;
      more.replaceChildren();
      if (!list.childElementCount)
        more.append(
          p(
            "No signed records from this key are retained on this server.",
            "small",
          ),
        );
      if (after)
        more.append(
          button("More activity", () => void loadMore(), {
            class: "btn btn-quiet",
            style: "min-height:36px",
          }),
        );
      else if (list.childElementCount)
        more.append(
          p(
            "Order follows event IDs, not time. Signed records carry no creation date.",
            "meta",
          ),
        );
    } catch (error) {
      if (context.live())
        more.replaceChildren(
          p(`Activity is unavailable: ${describe(error)}`, "notice"),
        );
    }
  };
  await loadMore();
}
function activityRow(
  item: import("../model/types.ts").ActivityItem,
): HTMLElement {
  const li = el("li", { class: "row", style: "padding:8px 0" });
  const action = item.action;
  const node = el("span", { class: "t" });
  const kind = action.kind;
  if (kind === "definition.publish")
    node.append(
      text(
        (action.parents as string[])?.length
          ? "Revised a definition: "
          : "Added a definition: ",
      ),
      link(item.id, routes.definition(item.id), { class: "fingerprint" }),
    );
  else if (kind === "rafsi.publish")
    node.append(
      text("Claimed a rafsi: "),
      link(item.id, routes.definition(item.id), { class: "fingerprint" }),
    );
  else if (kind === "judgment.set") {
    const value = String(action.value);
    const target = String(action.target);
    node.append(
      text(
        value === "bless"
          ? "Endorsed "
          : value === "curse"
            ? "Opposed "
            : "Cleared a judgment on ",
      ),
      link(
        target,
        target.startsWith("jve1:")
          ? routes.definition(target)
          : `/rafsi-pair/${encodeURIComponent(target)}`,
        { class: "fingerprint" },
      ),
    );
  } else if (kind === "trust.set") {
    const value = String(action.value);
    node.append(
      text(
        value === "heed"
          ? "Trusts "
          : value === "shun"
            ? "Ignores "
            : "Cleared trust for ",
      ),
      identityLink(String(action.subject)),
      text(" publicly"),
    );
  } else if (kind === "identity.profile")
    node.append(text("Updated the public profile"));
  else if (kind === "report.set")
    node.append(
      text(`Reported `),
      identityLink(String(action.subject)),
      text(` for ${String(action.category)}`),
    );
  else
    node.append(
      text(kind),
      text(" "),
      link(item.id, routes.definition(item.id), { class: "fingerprint" }),
    );
  if (item.interpretation !== "effective")
    node.append(text(` · ${item.interpretation}`, "meta"));
  li.append(node);
  if (item.seen)
    li.append(
      el("span", {
        class: "meta",
        title: `Receipt position ${item.seen} on this server`,
        text: `Seen ${item.seen.split(".").at(-1)}`,
      }),
    );
  return li;
}
function describeKey(key: string) {
  const [, kind, word, language] = key.split("|");
  if (kind === "*" && word === "*" && language === "*") return "all judgments";
  return [
    kind !== "*" ? kind : null,
    word !== "*" ? `word ${word.slice(0, 13)}…` : null,
    language !== "*" ? language : null,
  ]
    .filter(Boolean)
    .join(", ");
}
function reportDialog(app: App, subject: string) {
  const opener = document.activeElement as HTMLElement | null;
  const dialog = el("dialog", {
    class: "sheet",
    "aria-labelledby": "report-title",
  });
  const categories = [
    ["key-compromise", "Key compromise"],
    ["fabricated-identities", "Fabricated identities"],
    ["spam-flooding", "Spam flooding"],
    ["impersonation", "Impersonation"],
  ];
  const form = el("form", { method: "dialog" });
  const category = el("select", {
    class: "field",
    id: "report-category",
    required: "true",
  });
  for (const [value, label] of categories)
    category.append(el("option", { value, text: label }));
  const reason = el("textarea", {
    class: "field",
    id: "report-reason",
    rows: "4",
    required: "true",
  });
  const submit = el("button", {
    type: "submit",
    class: "btn btn-primary",
    text: "Preview the public report",
  });
  const cancel = button("Cancel", () => dialog.close("cancel"), {
    class: "btn btn-quiet",
  });
  form.append(
    el("h2", { id: "report-title", text: "Report identity abuse" }),
    p(
      "A report is a public signed allegation about a key. Linguistic disagreement is not abuse. Use Oppose on the definition instead.",
      "small",
    ),
    el(
      "div",
      { class: "field-group" },
      el("label", {
        for: "report-category",
        class: "field-label",
        text: "Category",
      }),
      category,
    ),
    el(
      "div",
      { class: "field-group" },
      el("label", {
        for: "report-reason",
        class: "field-label",
        text: "Explanation",
      }),
      reason,
    ),
    el("div", { class: "actions" }, submit, cancel),
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const explanation = reason.value.trim();
    if (!explanation) return;
    const preview = el(
      "div",
      { class: "stack small", style: "margin-top:12px" },
      p(
        `Public report about ${fingerprintText(subject)}: ${categories.find(([v]) => v === category.value)?.[1]}.`,
      ),
      el("p", {}, el("bdi", { text: explanation })),
      p(
        "Signed with your key. It does not ban anyone. It stays in history after a later clear.",
      ),
    );
    const sign = button(
      "Sign and publish the report",
      async () => {
        dialog.close("signed");
        await app.session.requireUnlocked(
          `Reporting ${subject.slice(8, 16)}`,
          async () => {
            if (!(await app.session.firstSignatureDisclosure())) return;
            try {
              await app.signer.publish([
                {
                  action: {
                    kind: "report.set",
                    subject,
                    category: category.value,
                    value: "report",
                  },
                  body: { text: [[explanation]] },
                },
              ]);
              app.own.invalidate();
              app.announce(
                "The report is signed and published as an allegation.",
              );
            } catch (error) {
              app.announce(describe(error));
            }
          },
        );
      },
      { class: "btn btn-warn" },
    );
    form.replaceChildren(
      el("h2", { id: "report-title", text: "Preview the public report" }),
      preview,
      el("div", { class: "actions", style: "margin-top:12px" }, sign, cancel),
    );
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    opener?.focus();
  });
  dialog.append(form);
  document.body.append(dialog);
  dialog.showModal();
}
