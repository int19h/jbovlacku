/** Not delivered: unfinished records, retries, stop, export, and resume. */
import { el, p, link, text, button, describe, download } from "../lib/dom.ts";
import { clockTime, dayMonth, inDuration } from "../lib/format.ts";
import type { RenderContext, Route } from "../app/router.ts";
import type { App } from "../app/context.ts";
import {
  describePeer,
  isNotDelivered,
  isFinished,
  recipientLabel,
} from "../data/delivery.ts";
import {
  ownGraph,
  dependentIds,
  requiresLifecycleDelivery,
} from "../data/outbox-graph.ts";
import type { Envelope } from "../model/types.ts";
import type { OutboxItem } from "../data/store.ts";

export async function outboxPage(
  _route: Route,
  context: RenderContext,
  app: App,
) {
  const { main } = context;
  context.title("Not delivered");
  main.className = "surface-outbox";
  if (!app.session.storageAvailable) {
    main.append(
      el("h1", { class: "page", text: "Not delivered" }),
      p(
        "Browser storage is unavailable, so no local records can be shown.",
        "notice",
      ),
    );
    return;
  }
  const heading = el("h1", {
    class: "page",
    text: "Not delivered",
    tabindex: "-1",
  });
  main.append(heading);
  const intro = el("p", { class: "muted", style: "margin:6px 0 20px" });
  const list = el("ol", { "aria-label": "Unfinished records" });
  const empty = el("p", { class: "small" });
  const exportLine = el("p", { class: "small", style: "margin-top:16px" });
  main.append(intro, list, empty, exportLine);
  let currentItems: OutboxItem[] = [];
  let currentActive: OutboxItem[] = [];
  const exportActive = button(
    "Save them as a file",
    async () =>
      download(
        `jbovlacku-undelivered-${Date.now()}.jsonl`,
        await app.delivery.exportLines(currentActive),
        "application/x-ndjson",
      ),
    { class: "btn btn-quiet" },
  );
  exportLine.append(
    text("Clearing browser data would lose these. "),
    exportActive,
    text(
      " to send from another device. A closed browser does not deliver in the background.",
    ),
  );
  const retained = el("details", {
    class: "disclosure",
    style: "margin-top:24px",
  });
  const retainedSummary = el("summary");
  const retainedBody = el("div", { class: "body" });
  const exportAll = button(
    "Export every retained record",
    async () =>
      download(
        `jbovlacku-records-${Date.now()}.jsonl`,
        await app.delivery.exportLines(currentItems),
        "application/x-ndjson",
      ),
    { class: "btn btn-quiet" },
  );
  retained.append(
    retainedSummary,
    retainedBody,
    el("div", { class: "actions", style: "margin-top:8px" }, exportAll),
  );
  main.append(retained);
  let generation = 0;
  const render = async (items: OutboxItem[]) => {
    const current = ++generation;
    const own = await app.store.list<Envelope>("ownhistory").catch(() => null);
    if (!context.live() || current !== generation) return;
    currentItems = items;
    const focused = document.activeElement as HTMLElement | null;
    const focusedRow = focused?.closest<HTMLElement>("[data-outbox-record]");
    const focusId = focusedRow?.dataset.outboxRecord;
    const focusAction = focused?.dataset.outboxAction;
    const active = items.filter((item) => isNotDelivered(item));
    currentActive = active;
    const waiting = active.filter((item) => !item.stopped);
    const stopped = active.filter((item) => item.stopped);
    const kinds = new Set(
      waiting.flatMap((item) =>
        Object.values(item.peers).map((peer) =>
          peer.failure === "unresolved" ? "unresolved" : peer.state,
        ),
      ),
    );
    const reasons: string[] = [];
    if (kinds.has("unresolved"))
      reasons.push(
        "Some records have no saved recipient address. This browser cannot send them. Export them to use another client.",
      );
    if (kinds.has("refused"))
      reasons.push(
        "A server refused some records. Refused recipients wait until you try again.",
      );
    if (kinds.has("missing-body"))
      reasons.push(
        "A server stored a signed header without its required body.",
      );
    if (kinds.has("unknown"))
      reasons.push(
        "Some delivery outcomes are unknown. The client asks for receipts before it sends the same bytes again.",
      );
    if (kinds.has("queued"))
      reasons.push(
        navigator.onLine
          ? "Some records wait for another attempt."
          : "Some records wait for a connection.",
      );
    if (waiting.length)
      reasons.push(
        "Waiting records stay in this browser. Eligible retries continue while the app is open. A closed browser does not deliver in the background.",
      );
    if (stopped.length)
      reasons.push(
        "Stopped records stay in this browser and are not sent again until you select Resume.",
      );
    intro.hidden = active.length === 0;
    intro.textContent = reasons.join(" ");
    list.replaceChildren();
    const dependencies = new Map<string, Set<string> | null>();
    for (const identity of new Set(active.map((item) => item.identity))) {
      try {
        dependencies.set(
          identity,
          own === null ? null : dependentIds(ownGraph(items, own, identity)),
        );
      } catch {
        dependencies.set(identity, null);
      }
    }
    for (const item of active) {
      const dependents = dependencies.get(item.identity);
      let discardState: "lifecycle" | "leaf" | "dependent" | "unavailable" =
        "unavailable";
      try {
        discardState = requiresLifecycleDelivery(item)
          ? "lifecycle"
          : dependents
            ? dependents.has(item.id)
              ? "dependent"
              : "leaf"
            : "unavailable";
      } catch {
        /* Keep unreadable local records available for export. */
      }
      list.append(row(app, item, discardState));
    }
    empty.textContent = active.length ? "" : "No unfinished records.";
    exportLine.hidden = active.length === 0;
    const delivered = items.filter(isFinished);
    retainedSummary.textContent = `Retained records (${delivered.length} delivered)`;
    retained.hidden = delivered.length === 0;
    const nodes: Node[] = [];
    if (delivered.length) {
      const ol = el("ol", { class: "small" });
      for (const item of delivered.slice(-50).reverse()) {
        const li = el("li", { class: "row", "data-outbox-record": item.id });
        li.append(
          el(
            "span",
            { class: "t" },
            el(
              "span",
              {},
              el("strong", { text: item.label.subject }),
              text(` ${item.label.action}`, "meta"),
            ),
            el("small", {
              text: Object.entries(item.peers)
                .map(
                  ([peerId, peer]) =>
                    `${recipientLabel(item, peerId)}: delivered${peer.receipt ? `, interpretation ${peer.receipt.interpretation}` : ""}`,
                )
                .join(" · "),
            }),
          ),
          link("open", item.label.href, {
            class: "small",
            "data-outbox-action": "open",
          }),
        );
        ol.append(li);
      }
      nodes.push(ol);
    }
    if (!items.length)
      nodes.push(p("No signed records in this browser.", "small"));
    retainedBody.replaceChildren(...nodes);
    // Keep the disclosure and restore a replaced control without moving focus
    // away from any control that survived this update.
    if (focused && !focused.isConnected && focusId) {
      const replacement = [
        ...main.querySelectorAll<HTMLElement>("[data-outbox-record]"),
      ].find((node) => node.dataset.outboxRecord === focusId);
      const control = [
        ...(replacement?.querySelectorAll<HTMLElement>(
          "[data-outbox-action]",
        ) ?? []),
      ].find((node) => node.dataset.outboxAction === focusAction);
      const nextFocus =
        control ?? replacement?.querySelector<HTMLElement>("button, a");
      (nextFocus && (!retained.contains(nextFocus) || retained.open)
        ? nextFocus
        : heading
      ).focus();
    }
  };
  const unsubscribe = app.delivery.subscribe(render);
  context.signal.addEventListener("abort", () => unsubscribe());
}
function row(
  app: App,
  item: OutboxItem,
  discardState:
    | "lifecycle"
    | "leaf"
    | "dependent"
    | "unavailable" = "unavailable",
): HTMLElement {
  const li = el("li", { class: "row", "data-outbox-record": item.id });
  const info = el("span", { class: "t" });
  const signed = item.signedAt ? new Date(item.signedAt) : null;
  const when = signed
    ? Date.now() - signed.getTime() < 20 * 3600 * 1000
      ? clockTime(signed)
      : dayMonth(signed)
    : "";
  info.append(
    el(
      "span",
      {},
      el(
        "strong",
        { style: "font-weight:650;font-size:17px" },
        el("bdi", { text: item.label.subject }),
      ),
      text(` ${item.label.action}${when ? ` · ${when}` : ""}`, "meta"),
    ),
  );
  for (const [peerId, peer] of Object.entries(item.peers)) {
    if (peer.state === "accepted" && Object.keys(item.peers).length === 1)
      continue;
    const parts: string[] = [];
    if (Object.keys(item.peers).length > 1)
      parts.push(`${recipientLabel(item, peerId)}:`);
    if (peer.lastAttempt)
      parts.push(`Last try ${clockTime(new Date(peer.lastAttempt))}.`);
    parts.push(
      !navigator.onLine &&
        peer.failure !== "unresolved" &&
        peer.state !== "accepted" &&
        peer.state !== "refused"
        ? "Waiting for a connection."
        : describePeer(peer),
    );
    if (
      !item.stopped &&
      navigator.onLine &&
      peer.nextAttempt &&
      peer.state !== "accepted" &&
      peer.state !== "refused"
    )
      parts.push(`Next try ${inDuration(peer.nextAttempt - Date.now())}.`);
    if (peer.failure === "unresolved")
      // A migrated record saved no address. Preferences never supply one.
      parts.push(
        "This browser cannot send it. Export is the only path: save the record as a file and submit it with another client, then stop retrying here.",
      );
    info.append(el("small", { text: parts.join(" ") }));
  }
  if (item.stopped) info.append(el("small", { text: "Stopped" }));
  li.append(info);
  if (item.stopped) {
    li.append(
      button(
        "Resume",
        async () => {
          try {
            await app.delivery.resume(item.id);
            app.announce(
              "Delivery resumed with the same signed bytes and recipients.",
            );
          } catch (error) {
            app.announce(describe(error));
          }
        },
        {
          class: "btn",
          "data-outbox-action": "resume",
        },
      ),
      button(
        "Save as file",
        () =>
          download(
            `jbovlacku-record-${item.id.slice(5, 17)}.jsonl`,
            item.transport + "\n",
            "application/x-ndjson",
          ),
        {
          class: "btn btn-quiet",
          "data-outbox-action": "export",
        },
      ),
    );
    if (discardState === "leaf")
      li.append(
        button(
          "Discard",
          async () => {
            if (
              !confirm(
                "Discard this local signed record and its receipts? This cannot be undone. This does not retract a copy that a server already holds.",
              )
            )
              return;
            try {
              await app.delivery.discard(item.id);
              app.own.invalidate();
              app.announce(
                "Discarded the local signed record and its receipts. Server copies stay public.",
              );
            } catch (error) {
              app.announce(describe(error));
            }
          },
          { class: "btn btn-quiet", "data-outbox-action": "discard" },
        ),
      );
    else
      info.append(
        el("small", {
          text:
            discardState === "lifecycle"
              ? "This lifecycle record must be delivered. Resume it or save it as a file."
              : discardState === "dependent"
                ? "Later records depend on this record. Resume it or save it as a file."
                : "Local history is unavailable. Resume this record or save it as a file.",
        }),
      );
    return li;
  }
  const tryNow = button(
    "Try now",
    async () => {
      if (tryNow.getAttribute("aria-disabled") === "true") return;
      tryNow.setAttribute("aria-disabled", "true");
      try {
        const result = await app.delivery.tryNow(item.id);
        const states = result
          ? Object.values(result.peers).map((peer) => peer.state)
          : [];
        app.announce(
          states.every((state) => state === "accepted")
            ? "Delivered."
            : "Still not delivered. The row shows the latest outcome.",
        );
      } catch (error) {
        app.announce(describe(error));
      } finally {
        tryNow.removeAttribute("aria-disabled");
      }
    },
    { class: "btn", "data-outbox-action": "try" },
  );
  const stop = button(
    "Stop retrying",
    async () => {
      await app.delivery.stop(item.id);
      app.announce(
        "Stopped. The signed record and its receipts stay in this browser. This does not retract a public record or cancel a request already in flight.",
      );
    },
    {
      class: "btn btn-quiet",
      "data-outbox-action": "stop",
    },
  );
  li.append(tryNow, stop);
  return li;
}
