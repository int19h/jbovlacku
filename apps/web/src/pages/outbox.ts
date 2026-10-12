/** Not delivered: unfinished records, retries, stop, export, and resume. */
import {
  el,
  p,
  link,
  text,
  button,
  describe,
  disclosure,
  download,
} from "../lib/dom.ts";
import { clockTime, dayMonth, inDuration, plural } from "../lib/format.ts";
import type { RenderContext, Route } from "../app/router.ts";
import type { App } from "../app/context.ts";
import {
  describePeer,
  isActive,
  isFinished,
  recipientLabel,
} from "../data/delivery.ts";
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
  main.append(el("h1", { class: "page", text: "Not delivered" }));
  const intro = el("p", { class: "muted", style: "margin:6px 0 20px" });
  const list = el("ol", { "aria-label": "Unfinished records" });
  const empty = el("p", { class: "small" });
  const exportLine = el("p", { class: "small", style: "margin-top:16px" });
  main.append(intro, list, empty, exportLine);
  const retained = el("div", { style: "margin-top:24px" });
  main.append(retained);
  const render = (items: OutboxItem[]) => {
    if (!context.live()) return;
    const active = items.filter(isActive);
    const stopped = items.filter((item) => item.stopped && !isFinished(item));
    const kinds = new Set(
      active.flatMap((item) =>
        Object.values(item.peers).map((peer) => peer.state),
      ),
    );
    intro.textContent = active.length
      ? `${kinds.has("refused") ? "A server refused some of these records. " : "The server could not be reached, or its answer is unknown, for these records. "}They are kept in this browser${kinds.has("refused") && kinds.size === 1 ? "" : " and sent again automatically while this page is open"}. This list clears when everything has arrived.`
      : "Nothing is waiting. Signed records that reached their servers are kept here with their receipts.";
    list.replaceChildren();
    for (const item of active) list.append(row(app, item));
    empty.textContent = active.length ? "" : "No unfinished records.";
    exportLine.replaceChildren();
    if (active.length) {
      exportLine.append(
        text("Clearing browser data would lose these. "),
        button(
          "Save them as a file",
          async () =>
            download(
              `jbovlacku-undelivered-${Date.now()}.jsonl`,
              await app.delivery.exportLines(active),
              "application/x-ndjson",
            ),
          { class: "btn btn-quiet", style: "min-height:32px" },
        ),
        text(
          " to send from another device. A closed browser does not deliver in the background.",
        ),
      );
    }
    retained.replaceChildren();
    const delivered = items.filter(isFinished);
    retained.append(
      disclosure(
        `Retained records (${stopped.length} stopped, ${delivered.length} delivered)`,
        () => {
          const nodes: Node[] = [];
          if (stopped.length) {
            nodes.push(
              p(
                "Stopped records keep their signed bytes and receipts. Resume uses the same bytes and recipients after a receipt lookup.",
                "small",
              ),
            );
            const ol = el("ol");
            for (const item of stopped) ol.append(row(app, item, true));
            nodes.push(ol);
          }
          if (delivered.length) {
            const ol = el("ol", { class: "small" });
            for (const item of delivered.slice(-50).reverse()) {
              const li = el("li", { class: "row" });
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
                link("open", item.label.href, { class: "small" }),
              );
              ol.append(li);
            }
            nodes.push(ol);
          }
          nodes.push(
            el(
              "div",
              { class: "actions", style: "margin-top:8px" },
              button(
                "Export every retained record",
                async () =>
                  download(
                    `jbovlacku-records-${Date.now()}.jsonl`,
                    await app.delivery.exportLines(items),
                    "application/x-ndjson",
                  ),
                { class: "btn btn-quiet" },
              ),
            ),
          );
          if (!items.length)
            nodes.push(p("No signed records in this browser.", "small"));
          return nodes;
        },
      ),
    );
  };
  const unsubscribe = app.delivery.subscribe(render);
  context.signal.addEventListener("abort", () => unsubscribe());
}
function row(app: App, item: OutboxItem, stoppedView = false): HTMLElement {
  const li = el("li", { class: "row" });
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
    parts.push(describePeer(peer));
    if (
      !item.stopped &&
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
  li.append(info);
  if (stoppedView) {
    li.append(
      button(
        "Resume delivery",
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
        { class: "btn", style: "min-height:40px" },
      ),
      button(
        "Export",
        () =>
          download(
            `jbovlacku-record-${item.id.slice(5, 17)}.jsonl`,
            item.transport + "\n",
            "application/x-ndjson",
          ),
        { class: "btn btn-quiet", style: "min-height:40px" },
      ),
    );
    return li;
  }
  const tryNow = button(
    "Try now",
    async () => {
      tryNow.disabled = true;
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
        tryNow.disabled = false;
      }
    },
    { class: "btn", style: "min-height:40px" },
  );
  const stop = button(
    "Stop retrying",
    async () => {
      await app.delivery.stop(item.id);
      app.announce(
        "Stopped. The signed record and its receipts stay in this browser. This does not retract a public record or cancel a request already in flight.",
      );
    },
    { class: "btn btn-quiet", style: "min-height:40px" },
  );
  li.append(tryNow, stop);
  return li;
}
