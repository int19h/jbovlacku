/** The trust panel on a public identity page, and the public-decision preview. */
import { el, p, text, button, field, describe, append } from "../lib/dom.ts";
import { fingerprintText } from "../lib/format.ts";
import type { App } from "../app/context.ts";
import { loadSiteView } from "../data/view.ts";
import { describeProfile } from "../model/profiles.ts";
import { allScope, type TrustScope } from "../model/types.ts";
import { scopeKey } from "../data/history.ts";
import { identityLink } from "./attribution.ts";
import { deliveryAccepted } from "../data/delivery.ts";

export function describeScope(scope: TrustScope): string {
  if (scope.kind === "*" && scope.word === "*" && scope.language === "*")
    return "all judgments";
  const parts: string[] = [];
  if (scope.kind === "definition") parts.push("definitions");
  if (scope.kind === "rafsi") parts.push("rafsi claims");
  if (scope.word !== "*") parts.push(`word ${scope.word.slice(0, 13)}…`);
  if (scope.language !== "*") parts.push(`language ${scope.language}`);
  return parts.join(", ") + " only";
}
/** Said after a public trust signature: an older snapshot never includes it. */
export const PENDING_NOTE =
  " Your personal view includes it after delivery, when you recompute for the snapshot that holds it.";
type Delivered = { peers: Record<string, { state: string }> }[];
/** True when the first delivery of the signed record was accepted. */
const accepted = (results: Delivered) => deliveryAccepted(results);
/** The status after a public trust signature, by the first delivery outcome. */
export function publicTrustOutcome(results: Delivered): string {
  return (
    (accepted(results)
      ? "Signed. Others can build on it. It stays in history after you undo it."
      : "Signed and saved here. Delivery is not finished. See Not delivered. It stays in history after you undo it.") +
    PENDING_NOTE
  );
}
/** The status after a public clear, by the first delivery outcome. */
export function publicClearOutcome(results: Delivered): string {
  return (
    (accepted(results)
      ? "Signed a clear. The earlier public choice stays in history."
      : "Signed a clear and saved here. Delivery is not finished. See Not delivered. The earlier public choice stays in history.") +
    " Your personal view follows the clear after delivery, when you recompute for the snapshot that holds it. A private Ignore stays until you remove it."
  );
}
/**
 * What the public preview knows about the signed view in use: its profile when
 * the view loaded, or why it did not load. A load failure is not an unknown
 * profile.
 */
export interface PreviewProfile {
  profile: string | null;
  loadError: string | null;
}
export function previewProfile(
  view: { body: { calculation: string } | null; error: string | null } | null,
): PreviewProfile {
  if (view?.body) return { profile: view.body.calculation, loadError: null };
  return {
    profile: null,
    loadError: view?.error ?? "The signed view in use did not load.",
  };
}
function shunRuleText(source: PreviewProfile): string {
  if (source.profile)
    return `In the calculation profile of the signed view in use, ${source.profile}: ${describeProfile(source.profile).shunRule}`;
  return `The signed view in use did not load, so its route rule is unavailable: ${source.loadError}`;
}
/** Previews the exact subject and scope before a public signature. */
export function confirmPublicTrust(
  app: App,
  subject: string,
  scope: TrustScope,
  value: "heed" | "shun" | "clear",
  source: PreviewProfile,
): Promise<boolean> {
  return new Promise((resolve) => {
    const opener = document.activeElement as HTMLElement | null;
    const dialog = el("dialog", {
      class: "sheet",
      "aria-labelledby": "trust-preview-title",
    });
    const verb =
      value === "heed"
        ? "Trust"
        : value === "shun"
          ? "Ignore publicly"
          : "Clear";
    const proceed = button(verb, () => dialog.close("ok"), {
      class: "btn btn-primary",
    });
    const cancel = button("Cancel", () => dialog.close("cancel"), {
      class: "btn btn-quiet",
    });
    append(
      dialog,
      el("h2", {
        id: "trust-preview-title",
        text: `${verb}: public signed record`,
      }),
      el(
        "div",
        { class: "stack small" },
        el(
          "p",
          {},
          text("Subject: "),
          identityLink(subject),
          text(` · ${fingerprintText(subject)}`, "fingerprint"),
        ),
        p(`Scope: ${describeScope(scope)}.`),
        p(
          value === "heed"
            ? "Their judgments count for you, and so do the people they trust within this scope."
            : value === "shun"
              ? `Your public refusal to heed. ${shunRuleText(source)} In your own personal view it also acts as a block. Other readers see it as your choice, not a universal veto or an accusation.`
              : "Clears your earlier public choice.",
        ),
        p(
          "Signed. Others can build on it. It stays in history after you undo it.",
        ),
      ),
      el(
        "div",
        { class: "actions", style: "margin-top:14px" },
        proceed,
        cancel,
      ),
    );
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "ok");
      dialog.remove();
      opener?.focus();
    });
    document.body.append(dialog);
    dialog.showModal();
    proceed.focus();
  });
}
export interface TrustPanelOptions {
  subject: string;
  name: string | null;
  mode: "trust" | "ignore";
  onDone: () => void;
}
/** Just for me or Publicly, with a default all-judgments scope and a narrower scope choice. */
export function trustPanel(app: App, options: TrustPanelOptions): HTMLElement {
  const { subject, mode } = options;
  const panel = el("section", {
    class: "card",
    "aria-labelledby": "tp-h",
    style: "margin-top:12px",
  });
  const label = options.name ?? subject.slice(8, 16);
  panel.append(
    el("h2", {
      id: "tp-h",
      class: "section",
      style: "margin-top:0",
      text: `${mode === "trust" ? "Trust" : "Ignore"} ${label}`,
    }),
    p(
      mode === "trust"
        ? "Their endorsements count for you, and so do the people they trust."
        : "Their judgments stop counting for you. Ignoring is not an accusation.",
      "small",
    ),
  );
  const visibility = el("fieldset", {
    style:
      "border:0;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px",
  });
  visibility.append(el("legend", { class: "sr", text: "Visibility" }));
  let chosen: "private" | "public" = "private";
  const cards: HTMLLabelElement[] = [];
  for (const [value, title, hint] of [
    [
      "private",
      "Just for me",
      mode === "trust"
        ? "Stays in this browser as a private rule. It does not cancel a block from your own public shun."
        : "Stays in this browser. Also blocks trust that passes through them in your personal view. A later public clear does not remove it.",
    ],
    [
      "public",
      "Publicly",
      "Signed. Others can build on it. It stays in history after you undo it.",
    ],
  ] as const) {
    const input = el("input", { type: "radio", name: "visibility", value });
    input.checked = value === "private";
    const card = el(
      "label",
      { class: `opt${input.checked ? " on" : ""}` },
      input,
      el(
        "span",
        {},
        el("span", { style: "display:block;font-weight:650", text: title }),
        el("span", { class: "small", style: "display:block", text: hint }),
      ),
    );
    input.addEventListener("change", () => {
      chosen = value;
      for (const c of cards)
        c.classList.toggle("on", c.querySelector("input")!.checked);
    });
    cards.push(card);
    visibility.append(card);
  }
  panel.append(visibility);
  let scope: TrustScope = { ...allScope };
  const scopeLine = el("p", { class: "small", style: "margin-top:12px" });
  const scopeForm = el("div", {
    style: "display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end",
  });
  scopeForm.hidden = true;
  const kind = field("Kind", {
    options: [
      { value: "*", label: "Definitions and rafsi claims" },
      { value: "definition", label: "Definitions only" },
      { value: "rafsi", label: "Rafsi claims only" },
    ],
    value: "*",
    wrapperClass: "",
  });
  const language = field("Definition language", {
    value: "",
    placeholder: "any",
    wrapperClass: "",
    hint: "A rafsi scope has no language.",
  });
  const word = field("Word ID", {
    value: "",
    placeholder: "any",
    wrapperClass: "",
  });
  scopeForm.append(kind.wrapper, language.wrapper, word.wrapper);
  const updateScope = () => {
    scope = {
      kind: kind.input.value as TrustScope["kind"],
      word: word.input.value.trim() || "*",
      language:
        kind.input.value === "rafsi" ? "*" : language.input.value.trim() || "*",
    };
    scopeLine.replaceChildren(text(`For ${describeScope(scope)} · `));
    scopeLine.append(
      button(
        scopeForm.hidden
          ? "limit by language, word, or rafsi"
          : "hide scope fields",
        () => {
          scopeForm.hidden = !scopeForm.hidden;
          updateScope();
        },
        { class: "btn btn-quiet", style: "min-height:32px;padding:0 6px" },
      ),
    );
  };
  for (const input of [kind.input, language.input, word.input])
    input.addEventListener("input", updateScope);
  updateScope();
  panel.append(scopeLine, scopeForm);
  const actions = el("div", { class: "actions", style: "margin-top:14px" });
  const go = button(
    mode === "trust" ? "Trust" : "Ignore",
    async () => {
      go.disabled = true;
      try {
        if (chosen === "private") {
          const overlay = await app.store.overlay();
          if (mode === "trust") {
            overlay.trust = overlay.trust.filter(
              (r) =>
                !(
                  r.subject === subject && scopeKey(r.scope) === scopeKey(scope)
                ),
            );
            overlay.trust.push({
              issuer: app.session.identity ?? "local",
              subject,
              scope,
              value: "heed",
              weight: null,
            });
          } else {
            overlay.blocked = overlay.blocked.filter(
              (b) =>
                !(
                  b.identity === subject &&
                  scopeKey(b.scope) === scopeKey(scope)
                ),
            );
            overlay.blocked.push({ identity: subject, scope });
          }
          await app.store.setOverlay(overlay);
          app.announce(
            mode === "trust"
              ? "Saved as a private rule in this browser."
              : "Saved as a private block in this browser. It removes this identity and routes through it from your personal view.",
          );
          options.onDone();
          return;
        }
        const value = mode === "trust" ? "heed" : "shun";
        // A load that throws, such as a failed manifest request, keeps its
        // reason for the preview.
        const site = await loadSiteView().catch((error) => ({
          id: "",
          body: null,
          error: describe(error),
        }));
        if (
          !(await confirmPublicTrust(
            app,
            subject,
            scope,
            value,
            previewProfile(site),
          ))
        )
          return;
        await app.session.requireUnlocked(
          `${mode === "trust" ? "Trusting" : "Ignoring"} ${label} publicly`,
          async () => {
            if (!(await app.session.firstSignatureDisclosure())) return;
            const results = await app.signer.publish([
              {
                action: { kind: "trust.set", subject, scope, value },
                body: null,
              },
            ]);
            app.own.invalidate();
            app.announce(publicTrustOutcome(results));
            options.onDone();
          },
        );
      } catch (error) {
        app.announce(describe(error));
      } finally {
        go.disabled = false;
      }
    },
    { class: "btn btn-primary" },
  );
  actions.append(
    go,
    button("Cancel", () => options.onDone(), { class: "btn btn-quiet" }),
  );
  panel.append(actions);
  return panel;
}
