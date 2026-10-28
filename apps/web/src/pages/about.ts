/** About: what this dictionary is and what this server offers. */
import { el, p, link, text } from "../lib/dom.ts";
import type { RenderContext, Route } from "../app/router.ts";
import type { App } from "../app/context.ts";
import { getCapabilities, selfPeer } from "../data/api.ts";

export async function aboutPage(
  _route: Route,
  context: RenderContext,
  _app: App,
) {
  const { main } = context;
  context.title("About");
  main.className = "";
  main.append(
    el("h1", { class: "page", text: "About jbovlacku" }),
    el(
      "div",
      { class: "stack", style: "margin-top:12px" },
      p(
        "Jbovlacku is a Lojban dictionary without a central editor. Contributors sign definitions, rafsi assignments, and judgments with their own keys. Readers choose whose judgments order the results they see.",
      ),
      p(
        "Independent servers exchange the same signed records. A word page shows every definition with its author and its score under the selected trust view. No definition is official by protocol.",
      ),
      p(
        "New definitions are released under CC0 1.0. Imported text keeps its original rights statement and attribution.",
      ),
    ),
  );
  main.append(el("h2", { class: "section", text: "This server" }));
  try {
    const capabilities = await getCapabilities({ signal: context.signal });
    if (!context.live()) return;
    main.append(
      p(
        `${capabilities.server_id} at ${selfPeer.label}. Format version ${capabilities.versions.join(", ")}.`,
        "small",
      ),
      el(
        "p",
        { class: "small" },
        text("Admission policy: "),
        link(capabilities.policy_url, capabilities.policy_url, {
          class: "touch-link",
          rel: "noopener noreferrer",
          target: "_blank",
        }),
      ),
      p(`Accepted body kinds: ${capabilities.body_kinds.join(", ")}.`, "meta"),
    );
  } catch {
    if (context.live())
      main.append(p("Server details are unavailable right now.", "small"));
  }
  main.append(
    el("h2", { class: "section", text: "Source and notices" }),
    el(
      "p",
      { class: "small" },
      link("Source code", "https://github.com/int19h/jbovlacku", {
        class: "touch-link",
        rel: "noopener noreferrer",
        target: "_blank",
      }),
      text(" · "),
      link("Third-party notices", "/notices/", {
        class: "touch-link",
        rel: "noopener noreferrer",
        target: "_blank",
      }),
    ),
    p("This is a local prototype. It is not a public service.", "meta"),
  );
}
