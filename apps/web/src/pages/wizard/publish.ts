/**
 * Step 5: preview, known conflicts, the publication panel, and the signed
 * group. The group comes from the reviewed draft alone. Conflict lookups only
 * inform the author and label their coverage. Once the group is saved, the
 * page binds to that group and offers delivery controls instead of a second
 * publication.
 */
import { rafsiPairId } from "../../../../../packages/core/src/index.ts";
import {
  el,
  p,
  text,
  link,
  button,
  describe,
  checkbox,
} from "../../lib/dom.ts";
import { fingerprintText, shortIdentity } from "../../lib/format.ts";
import {
  navigate,
  routes,
  type RenderContext,
  type Route,
} from "../../app/router.ts";
import type { App } from "../../app/context.ts";
import { draftToBody } from "../../model/draft.ts";
import { cachedPackage, inventoryFromPackage } from "../../model/builders.ts";
import { definitionBlock } from "../../components/definition.ts";
import { identityProfile, profileName } from "../../components/attribution.ts";
import { getWord, selfPeer } from "../../data/api.ts";
import { describePeer } from "../../data/delivery.ts";
import type { OutboxItem } from "../../data/store.ts";
import type { GroupItem } from "../../app/actions.ts";
import type { Envelope } from "../../model/types.ts";
import {
  actionBar,
  DraftSaver,
  discardDraft,
  loadDraft,
  stepBar,
} from "./common.ts";

/** A requested rafsi claim with its pair ID and the competing claims known locally. */
interface RequestedClaim {
  rafsi: string;
  pair: string;
  rationale: string;
  competitors: { word: string; spelling: string }[];
}
export async function publishPage(
  _route: Route,
  context: RenderContext,
  app: App,
) {
  const { main } = context;
  context.title("Add a word: Publish");
  main.className = "surface-publish";
  const draft = await loadDraft(app);
  if (!context.live()) return;
  if (!draft) {
    navigate("/new/meaning", { replace: true });
    return;
  }
  const saver = new DraftSaver(app, draft);
  main.append(stepBar(draft, 5));
  const { body, problems, wordId } = draftToBody(draft);
  const blocking = problems.filter((pr) => pr.blocking);
  const columns = el("div", { class: "two-col" });
  const left = el("section", {
    "aria-labelledby": "prev-h",
    class: "main-col",
    style: "flex:999 1 460px",
  });
  left.append(el("h1", { id: "prev-h", class: "sr", text: "Preview" }));
  if (body) {
    const envelope: Envelope = {
      id: "jve1:" + "0".repeat(64),
      header: {
        version: 1,
        issuer: app.session.identity ?? "ed25519:" + "0".repeat(64),
        previous: [],
        nonce: "0".repeat(32),
        action: {
          kind: "definition.publish",
          word: wordId ?? "",
          language: body.language,
          parents: draft.parents,
          origin: "native",
        },
        content: null,
      },
      signature: "",
    };
    const card = el("div", { class: "card preview-card" });
    card.append(
      el(
        "div",
        {
          style:
            "display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 12px",
        },
        el("p", {
          style:
            "font-size:38px;line-height:1.1;font-weight:680;letter-spacing:-0.02em",
          lang: "jbo",
          text: body.word.spelling,
        }),
        text(
          `${body.classification.kind === "fuivla" ? "fu'ivla" : body.classification.kind}${body.classification.selmaho.length ? ` ${body.classification.selmaho.join(", ")}` : ""} · ${body.language}`,
          "meta",
        ),
      ),
      definitionBlock(
        app,
        { envelope, body, bodyError: null },
        {
          score: null,
          unavailable: true,
          preview: true,
          placeAnchorPrefix: "preview-place-",
        },
      ),
    );
    left.append(card);
  } else
    left.append(
      p(
        "The draft cannot be previewed until its problems are fixed.",
        "notice",
      ),
    );
  const problemList = el("div", { style: "margin-top:10px" });
  if (problems.length) {
    const ul = el("ul", {
      class: "small",
      style: "padding-left:1.2em;list-style:disc",
    });
    for (const problem of problems)
      ul.append(
        el("li", {
          class: problem.blocking ? "" : "meta",
          text: `${problem.blocking ? "" : "Warning: "}${problem.message}`,
        }),
      );
    problemList.append(ul);
  }
  problemList.append(
    el(
      "p",
      { class: "small", style: "margin-top:6px" },
      link("Edit", draft.parents.length ? "/new/editor" : "/new/places"),
      text(" returns to the retained draft."),
    ),
  );
  left.append(problemList);
  // The requested claims come from the reviewed draft alone. No lookup can remove one.
  const claims: RequestedClaim[] = [];
  if (wordId)
    for (const claim of draft.rafsiClaims) {
      const rafsi = claim.rafsi.trim().normalize("NFC");
      if (!rafsi || claims.some((c) => c.rafsi === rafsi)) continue;
      claims.push({
        rafsi,
        pair: rafsiPairId(wordId, rafsi),
        rationale: claim.rationale.trim(),
        competitors: [],
      });
    }
  // Known conflicts: the local package's claim inventory across every word, and this server's definitions.
  const conflicts = el("div", {
    class: "small",
    style: "margin-top:10px",
    role: "region",
    "aria-label": "Known conflicts",
  });
  left.append(conflicts);
  const inventory = inventoryFromPackage(await cachedPackage(app.store));
  if (!context.live()) return;
  for (const claim of claims)
    for (const known of inventory.claims)
      if (known.rafsi === claim.rafsi && known.word !== wordId)
        claim.competitors.push({ word: known.word, spelling: known.spelling });
  const collisions = claims.filter((c) => c.competitors.length);
  if (claims.length) {
    const coverage = inventory.snapshot
      ? inventory.hasClaims
        ? `Competing claims come from the local package of snapshot ${inventory.snapshot.slice(7, 19)}…. They cover retained claims in that package only.`
        : "The local package carries no rafsi claims, so conflict coverage is unknown."
      : "No local package is downloaded, so conflict coverage is unknown.";
    conflicts.append(
      p(
        `Rafsi claims: ${claims.map((c) => c.rafsi).join(", ")}. ${coverage}`,
        "meta",
      ),
    );
    for (const claim of collisions) {
      const line = el("p", { class: "warn" });
      line.append(text(`${claim.rafsi} is also claimed by `));
      claim.competitors.forEach((competitor, index) => {
        if (index) line.append(text(", "));
        line.append(
          link(competitor.spelling, routes.word(competitor.spelling), {
            lang: "jbo",
          }),
        );
      });
      line.append(text(". Readers judge each pair separately."));
      conflicts.append(line);
    }
  }
  const existingLine = el("p", { class: "meta" });
  conflicts.append(existingLine);
  if (wordId) {
    try {
      const existing = await getWord(wordId, { signal: context.signal });
      if (!context.live()) return;
      if (existing.definitions.length && !draft.parents.length)
        existingLine.append(
          text(
            `${existing.definitions.length} definition${existing.definitions.length === 1 ? "" : "s"} of ${body?.word.spelling} already exist in the selected view. Yours is added as an alternative. `,
          ),
          link("Open the word", routes.word(body!.word.spelling)),
        );
      else if (!existing.definitions.length)
        existingLine.append(
          text("No existing definition of this word in the selected view."),
        );
    } catch (error) {
      if (!context.live()) return;
      existingLine.append(
        text(
          `The server did not report existing definitions: ${describe(error)}. Existing-definition coverage is unknown. Publication does not depend on it.`,
        ),
      );
    }
  }
  // Publication panel.
  const aside = el("aside", {
    "aria-labelledby": "pub-h",
    class: "side-col",
    style: "flex:1 1 300px",
  });
  const panel = el("div", { class: "card" });
  const identity = app.session.identity;
  let name: string | null = null;
  if (identity) name = profileName(await identityProfile(identity));
  if (!context.live()) return;
  panel.append(
    el("h2", {
      id: "pub-h",
      class: "section",
      style: "margin:0 0 4px",
      text: identity
        ? `Publish as ${name ?? shortIdentity(identity)}`
        : "Publish",
    }),
  );
  if (identity) panel.append(p(fingerprintText(identity), "fingerprint"));
  panel.append(
    p(
      "Signed with your key, with your endorsement. Public, and kept by every server that receives it.",
      "meta",
    ),
    el(
      "p",
      { class: "small", style: "margin-top:10px" },
      text("New definitions use "),
      link("CC0 1.0", "https://creativecommons.org/publicdomain/zero/1.0/", {
        rel: "noopener noreferrer",
        target: "_blank",
      }),
      text(". By publishing, you release your contribution under CC0 1.0."),
    ),
  );
  if (draft.revisedImport)
    panel.append(
      p(
        "The imported text keeps its source rights claim and attribution through the parent link and sources. Only your contribution is released under CC0 1.0.",
        "meta",
      ),
    );
  if (!identity)
    panel.append(
      el(
        "p",
        { class: "notice", style: "margin-top:12px" },
        text("Publishing needs your key. "),
        link("Create or import a key", routes.localIdentity),
      ),
    );
  else if (!(await app.session.backupTested())) {
    if (!context.live()) return;
    panel.append(
      el(
        "div",
        { class: "notice", style: "margin-top:12px" },
        text("Your key backup is untested. "),
        link("Test it", routes.localIdentity),
        text(
          ", or publish now and test later. Losing this key without a backup makes this identity unusable.",
        ),
      ),
    );
  }
  // Known collisions need an explicit acknowledgment. Unknown coverage does not block.
  let acknowledged = collisions.length === 0;
  if (collisions.length)
    panel.append(
      el(
        "div",
        { class: "notice", style: "margin-top:12px" },
        checkbox(
          `I keep the ${collisions.length === 1 ? "claim" : "claims"} ${collisions.map((c) => c.rafsi).join(", ")} although other words claim the same rafsi.`,
          false,
          (value) => {
            acknowledged = value;
            refreshPublish();
          },
        ),
      ),
    );
  const recipients = app.session.preferences.peers;
  const outcome = el("div", { "aria-live": "polite" });
  let saved = false;
  let bar: HTMLElement | null = null;
  const refreshPublish = () => {
    const disabled =
      saved || blocking.length > 0 || !identity || !body || !acknowledged;
    publish.disabled = disabled;
    const primary = bar?.querySelector<HTMLButtonElement>(".btn-primary");
    if (primary) primary.disabled = disabled;
  };
  /** The group from the reviewed draft: definition, endorsement, every claim, and each pair endorsement. */
  const buildGroup = (): GroupItem[] => {
    const group: GroupItem[] = [
      {
        action: {
          kind: "definition.publish",
          word: wordId!,
          language: body!.language,
          parents: [...draft.parents].sort(),
          origin: "native",
        },
        body: body!,
      },
      {
        action: { kind: "judgment.set", target: "", value: "bless" },
        body: null,
        dependsOn: (ids) => ({ target: ids[0] }),
      },
    ];
    for (const claim of claims) {
      group.push({
        action: {
          kind: "rafsi.publish",
          word: wordId!,
          assignment: claim.pair,
          origin: "native",
        },
        body: {
          word: body!.word,
          rafsi: claim.rafsi,
          rationale: claim.rationale ? [[claim.rationale]] : [],
          sources: [],
          legacy: null,
        },
      });
      group.push({
        action: { kind: "judgment.set", target: claim.pair, value: "bless" },
        body: null,
      });
    }
    return group;
  };
  /** Binds the page to the saved group: delivery state and controls, no second publication. */
  const renderSaved = (items: OutboxItem[]) => {
    outcome.replaceChildren();
    const definition = items[0];
    const unfinished = items.filter((item) =>
      Object.values(item.peers).some((peer) => peer.state !== "accepted"),
    );
    const box = el("div", {
      class: "notice",
      style: "margin-top:12px",
      role: "region",
      "aria-label": "Saved publication",
    });
    box.append(
      el(
        "p",
        {},
        el("strong", {
          text: unfinished.length
            ? "Saved. Not delivered yet. "
            : "Published. ",
        }),
        text(
          unfinished.length
            ? `${unfinished.length} of ${items.length} signed records did not finish delivery. They are kept in this browser with their exact bytes and sent again automatically. Publishing again would create a second definition, so this page offers delivery of the saved records instead. `
            : `All ${items.length} signed records were accepted. `,
        ),
        link("See Not delivered", routes.outbox),
      ),
    );
    const list = el("ul", { class: "small", style: "margin:8px 0 0" });
    for (const item of items) {
      const line = el("li");
      line.append(
        text(`${item.label.action} ${item.label.subject}: `),
        text(
          Object.values(item.peers)
            .map((peer) => describePeer(peer))
            .join(" "),
          "meta",
        ),
      );
      list.append(line);
    }
    box.append(list);
    const actions = el("div", { class: "actions", style: "margin-top:8px" });
    if (unfinished.length) {
      const retry = button(
        "Try now",
        async () => {
          retry.disabled = true;
          try {
            for (const item of unfinished) await app.delivery.tryNow(item.id);
            const fresh = await app.delivery.items();
            renderSaved(
              items.map((i) => fresh.find((f) => f.id === i.id) ?? i),
            );
          } catch (error) {
            app.announce(describe(error));
          } finally {
            retry.disabled = false;
          }
        },
        { class: "btn", style: "min-height:40px" },
      );
      actions.append(retry);
    }
    actions.append(
      link("Open the record", routes.definition(definition.id), {
        class: "btn btn-quiet",
        style: "min-height:40px",
      }),
    );
    box.append(
      actions,
      p(
        "This is a local preview of your signed record. It is not the server's public state until a receipt confirms it.",
        "meta",
      ),
    );
    outcome.append(box);
  };
  const publish = button(
    "Publish",
    async () => {
      if (!body || !wordId || saved || !acknowledged) return;
      publish.disabled = true;
      try {
        await app.session.requireUnlocked(
          `Publishing ${body.word.spelling}`,
          async () => {
            if (!(await app.session.firstSignatureDisclosure())) return;
            // Persist the whole group first. From here on the page belongs to that group.
            const signed = await app.signer.sign(buildGroup());
            saved = true;
            refreshPublish();
            // The page now belongs to the saved group. The publish controls go away.
            publish.remove();
            bar?.remove();
            await discardDraft(app);
            app.own.invalidate();
            renderSaved(signed.items);
            const results: OutboxItem[] = [];
            for (const item of signed.items) {
              const delivered = await app.delivery.deliver(item.id, true);
              results.push(delivered ?? item);
            }
            if (!context.live()) return;
            const complete = results.every((item) =>
              Object.values(item.peers).every(
                (peer) => peer.state === "accepted",
              ),
            );
            if (complete) {
              navigate(
                `${routes.word(body.word.spelling, body.language)}&fresh=1`,
              );
              app.announce(
                `Published ${body.word.spelling} with your endorsement${claims.length ? ` and ${claims.length} rafsi claim${claims.length === 1 ? "" : "s"}` : ""}.`,
              );
              return;
            }
            renderSaved(results);
          },
        );
      } catch (error) {
        // Nothing was saved. Publication stays available.
        app.announce(describe(error));
        outcome.replaceChildren(p(describe(error), "notice"));
      } finally {
        refreshPublish();
      }
    },
    {
      class: "btn btn-primary",
      style: "margin-top:14px;width:100%;min-height:48px;font-size:17px",
    },
  );
  if (blocking.length)
    panel.append(
      p(
        `${blocking.length} problem${blocking.length === 1 ? "" : "s"} block signing. See the list under the preview.`,
        "notice",
      ),
    );
  panel.append(publish, outcome);
  panel.append(
    p(
      `Goes to ${recipients.map((peer) => (peer.id === "self" ? location.host || selfPeer.label : peer.label)).join(", ")}. If a server cannot be reached, the record is kept here and sent later.`,
      "meta",
    ),
  );
  const records = 2 + claims.length * 2;
  panel.append(
    p(
      `${records} signed records: the definition, your endorsement${claims.length ? `, ${claims.length} rafsi claim${claims.length === 1 ? "" : "s"}, and their pair endorsements` : ""}. All are saved in this browser before anything is sent.`,
      "meta",
    ),
  );
  aside.append(panel);
  columns.append(left, aside);
  main.append(columns);
  bar = actionBar(saver, {
    back: {
      label: "Back",
      href: draft.parents.length ? "/new/editor" : "/new/places",
    },
    primary: {
      label: "Publish",
      disabled: true,
      action: () => publish.click(),
    },
  });
  main.append(bar);
  refreshPublish();
}
