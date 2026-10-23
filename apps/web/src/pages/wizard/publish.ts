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
  inlineProse,
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
import {
  cachedPackage,
  inventoryFromPackage,
  inventoryCoverage,
  conflictReviewKey,
  currentRootConflicts,
  currentCompoundConflicts,
  lujvoConflictKey,
  rootConflictKey,
} from "../../model/builders.ts";
import { definitionBlock } from "../../components/definition.ts";
import { identityProfile, profileName } from "../../components/attribution.ts";
import { getWord, selfPeer } from "../../data/api.ts";
import { describePeer, isNotDelivered } from "../../data/delivery.ts";
import {
  PublicationConflictError,
  type OutboxItem,
  type PublicationRecord,
} from "../../data/store.ts";
import type { GroupItem, SignedGroup } from "../../app/actions.ts";
import type { Envelope, Formation } from "../../model/types.ts";
import {
  actionBar,
  DRAFT_KEY,
  DraftSaver,
  forgetDraft,
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
  /** Items of a committed group, from the outbox, for the recovery view. */
  const groupItems = async (record: PublicationRecord) => {
    const items = await app.delivery.items();
    return record.ids
      .map((id) => items.find((item) => item.id === id))
      .filter((item): item is OutboxItem => Boolean(item));
  };
  if (!draft) {
    // The commit removed the reviewed draft. A reload or a later failure lands here and finds the saved group.
    const last = app.session.storageAvailable
      ? await app.store.get<PublicationRecord>("drafts", "published:last")
      : undefined;
    if (!context.live()) return;
    const items = last ? await groupItems(last) : [];
    if (!last || !items.length) {
      navigate("/new/meaning", { replace: true });
      return;
    }
    main.append(
      el("h1", { class: "page", text: "Saved publication" }),
      p(
        "The reviewed draft was published and removed. Its signed records are kept in this browser with their delivery state. Start a new draft from Add a word.",
        "small",
      ),
    );
    const outcome = el("div", { "aria-live": "polite" });
    main.append(outcome);
    renderSavedGroup(app, outcome, items);
    return;
  }
  const saver = new DraftSaver(app, draft);
  main.append(stepBar(draft, 5));
  // A revision that another tab already committed shows its group, never a second Publish.
  const published = await app.store.get<PublicationRecord>(
    "drafts",
    `published:${draft.revision}`,
  );
  if (!context.live()) return;
  let { body, problems, wordId } = draftToBody(draft);
  let blocking = problems.filter((pr) => pr.blocking);
  const columns = el("div", { class: "two-col" });
  const left = el("section", {
    "aria-labelledby": "prev-h",
    class: "main-col",
    style: "flex:999 1 460px",
  });
  left.append(el("h1", { id: "prev-h", class: "sr", text: "Preview" }));
  const preview = el("div");
  const problemList = el("div", { style: "margin-top:10px" });
  left.append(preview, problemList);
  const refreshPreview = () => {
    ({ body, problems, wordId } = draftToBody(draft));
    blocking = problems.filter((pr) => pr.blocking);
    preview.replaceChildren();
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
            class: "builder-form",
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
      preview.append(card);
    } else
      preview.append(
        p(
          "The draft cannot be previewed until its problems are fixed.",
          "notice",
        ),
      );
    problemList.replaceChildren();
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
        link("Edit", draft.parents.length ? "/new/editor" : "/new/places", {
          class: "touch-link",
        }),
        text(" returns to the retained draft."),
      ),
    );
  };
  refreshPreview();
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
    const coverage = inventoryCoverage(inventory);
    conflicts.append(
      p(
        `Rafsi claims: ${claims.map((c) => c.rafsi).join(", ")}. ${coverage}`,
        "meta",
      ),
    );
    for (const claim of collisions) {
      const line = el("p", { class: "warn" });
      line.append(
        inlineProse(
          "The competing word links belong to this rafsi claim sentence.",
          text(`${claim.rafsi} is also claimed by `),
          ...claim.competitors.flatMap((competitor, index) => [
            text(index ? ", " : ""),
            link(competitor.spelling, routes.word(competitor.spelling), {
              lang: "jbo",
            }),
          ]),
          text(". Readers judge each pair separately."),
        ),
      );
      conflicts.append(line);
    }
  }
  const existingLine = el("p", { class: "meta" });
  conflicts.append(existingLine);
  // The source rows affect scores, not the root conflict rules.
  let foundRoots: ReturnType<typeof currentRootConflicts> = [];
  let newRoots: typeof foundRoots = [];
  const formationMatchesForm =
    draft.evidenceForm === body?.word.spelling &&
    (!draft.formation?.generated ||
      draft.formation.generated === body?.word.spelling);
  const rootLine = el("p", { class: "meta" });
  conflicts.append(rootLine);
  if (draft.kind === "gismu" && body) {
    if (!inventory.snapshot)
      rootLine.textContent =
        "Root conflicts were not checked again: no local package is downloaded. Coverage is unknown.";
    else
      try {
        foundRoots = currentRootConflicts(body.word.spelling, inventory);
        const recorded = formationMatchesForm
          ? (draft.formation?.conflicts ?? [])
          : [];
        newRoots = foundRoots.filter(
          (c) =>
            !recorded.some(
              (known) =>
                known.word === c.word &&
                known.rule === c.rule &&
                known.snapshot === inventory.snapshot,
            ),
        );
        rootLine.textContent = `Root conflicts were checked again against the local package of snapshot ${inventory.snapshot.slice(7, 19)}…: ${
          foundRoots.length
            ? `${foundRoots.length} known ${foundRoots.length === 1 ? "conflict" : "conflicts"}, ${newRoots.length} new since the recorded run.`
            : "no root conflict."
        }`;
        for (const c of foundRoots) {
          const line = el("p", { class: "warn" });
          line.append(
            inlineProse(
              "The word link belongs to this root conflict sentence.",
              text(
                `${newRoots.includes(c) ? "New since the recorded run: " : "Acknowledged in the recorded evidence: "}${c.rule} conflict with `,
              ),
              link(c.spelling, routes.word(c.spelling), { lang: "jbo" }),
              text("."),
            ),
          );
          conflicts.append(line);
        }
      } catch (error) {
        rootLine.textContent = `Root conflicts were not checked again: ${describe(error)}. Coverage is unknown.`;
      }
  }
  const componentConflicts = draft.compound
    ? currentCompoundConflicts(draft.compound, inventory)
    : [];
  if (draft.compound) {
    conflicts.append(
      p(
        `Component rafsi: ${inventoryCoverage(inventory)}${componentConflicts.length ? "" : " No competing claim is known in that coverage."}`,
        "meta",
      ),
    );
    for (const c of componentConflicts) {
      conflicts.append(
        el(
          "p",
          { class: "warn" },
          inlineProse(
            "The word link belongs to this component rafsi conflict sentence.",
            text(`${c.rafsi} is also claimed by `),
            link(c.spelling, routes.word(c.spelling), { lang: "jbo" }),
            text("."),
          ),
        ),
      );
    }
  }
  // Any package change during review needs a new preview before signing.
  const inventoryVersion = (value: typeof inventory) =>
    JSON.stringify([
      value.snapshot,
      value.gismu,
      value.claims,
      value.complete,
      value.hasClaims,
      value.incompleteWords,
    ]);
  const reviewedInventory = inventoryVersion(inventory);
  if (wordId) {
    try {
      const existing = await getWord(wordId, { signal: context.signal });
      if (!context.live()) return;
      if (existing.definitions.length && !draft.parents.length)
        existingLine.append(
          text(
            `${existing.definitions.length} definition${existing.definitions.length === 1 ? "" : "s"} of ${body?.word.spelling} already exist in the selected view. Yours is added as an alternative. `,
          ),
          link("Open the word", routes.word(body!.word.spelling), {
            class: "touch-link",
          }),
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
      "Signed with your key, with your endorsement. Each configured server receives a public copy. This client cannot promise what each server stores.",
      "meta",
    ),
    el(
      "p",
      { class: "small", style: "margin-top:10px" },
      inlineProse(
        "The license link is part of the contribution rights sentence.",
        text("New definitions use "),
        link("CC0 1.0", "https://creativecommons.org/publicdomain/zero/1.0/", {
          rel: "noopener noreferrer",
          target: "_blank",
        }),
        text(". By publishing, you release your contribution under CC0 1.0."),
      ),
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
        link("Create or import a key", routes.localIdentity, {
          class: "touch-link",
        }),
      ),
    );
  else if (!(await app.session.backupTested())) {
    if (!context.live()) return;
    panel.append(
      el(
        "p",
        { class: "notice", style: "margin-top:12px" },
        text("Your key backup is untested. "),
        link("Test it", routes.localIdentity),
        text(
          ", or publish now and test later. Losing this key without a backup makes this identity unusable.",
        ),
      ),
    );
  }
  // Acknowledgments stay in the private draft, bound to the exact conflict group.
  const reviewedSpelling =
    body?.word.spelling ?? draft.spelling.trim().normalize("NFC");
  const rootReview = conflictReviewKey(
    reviewedSpelling,
    inventory.snapshot,
    "publish-roots",
    foundRoots.map((c) => `${c.word}|${c.rule}`),
  );
  let rootAcknowledged =
    !foundRoots.length ||
    draft.publishAcknowledged.includes(rootReview) ||
    foundRoots.every(
      (c) =>
        draft.evidenceForm === reviewedSpelling &&
        ((formationMatchesForm &&
          draft.formation?.conflicts.some(
            (known) =>
              known.word === c.word &&
              known.rule === c.rule &&
              known.snapshot === inventory.snapshot,
          )) ||
          draft.gismu?.acknowledged.includes(
            rootConflictKey(reviewedSpelling, c, inventory.snapshot),
          )),
    );
  const claimReview = conflictReviewKey(
    reviewedSpelling,
    inventory.snapshot,
    "publish-claims",
    collisions.flatMap((c) =>
      c.competitors.map((other) => `${c.rafsi}|${other.word}`),
    ),
  );
  let acknowledged =
    !collisions.length || draft.publishAcknowledged.includes(claimReview);
  const componentReview = conflictReviewKey(
    reviewedSpelling,
    inventory.snapshot,
    "publish-components",
    componentConflicts.map((c) => `${c.rafsi}|${c.pair}`),
  );
  let componentsAcknowledged =
    !componentConflicts.length ||
    draft.publishAcknowledged.includes(componentReview) ||
    componentConflicts.every((c) =>
      draft.lujvo?.acknowledged.includes(
        lujvoConflictKey(
          reviewedSpelling,
          c,
          componentConflicts,
          inventory.snapshot,
        ),
      ),
    );
  const keepReview = (key: string, value: boolean) => {
    draft.publishAcknowledged = value
      ? [...new Set([...draft.publishAcknowledged, key])]
      : draft.publishAcknowledged.filter((known) => known !== key);
    saver.touch();
  };
  const recordRoots = (value: boolean) => {
    if (!inventory.snapshot || !foundRoots.length) return false;
    if (!value && draft.gismu) draft.gismu.acknowledged = [];
    // Removing a current review keeps the conflicts of another historical form.
    if (
      !value &&
      draft.formation?.generated &&
      draft.formation.generated !== reviewedSpelling
    )
      return false;
    const before = JSON.stringify(draft.formation);
    if (!draft.formation) return false;
    if (value) {
      for (const c of foundRoots)
        if (
          !draft.formation.conflicts.some(
            (known) =>
              known.word === c.word &&
              known.rule === c.rule &&
              known.snapshot === inventory.snapshot,
          )
        )
          draft.formation.conflicts.push({
            word: c.word,
            rule: c.rule as Formation["conflicts"][number]["rule"],
            snapshot: inventory.snapshot,
          });
    } else {
      draft.formation.conflicts = draft.formation.conflicts.filter(
        (known) =>
          !foundRoots.some(
            (c) =>
              c.word === known.word &&
              c.rule === known.rule &&
              known.snapshot === inventory.snapshot,
          ),
      );
    }
    return before !== JSON.stringify(draft.formation);
  };
  if (foundRoots.length)
    panel.append(
      el(
        "div",
        { class: "notice", style: "margin-top:12px" },
        checkbox(
          `I publish ${body?.word.spelling ?? "this form"} although the refreshed package shows ${newRoots.length ? (foundRoots.length === 1 ? "a new root conflict" : "new root conflicts") : foundRoots.length === 1 ? "a known root conflict" : "known root conflicts"} with ${foundRoots.map((c) => c.spelling).join(", ")}.`,
          rootAcknowledged,
          (value) => {
            rootAcknowledged = value;
            recordRoots(value);
            keepReview(rootReview, value);
            refreshPreview();
            refreshPublish();
          },
        ),
        p(
          draft.formation
            ? "This acknowledgment enters the signed formation evidence. It keeps the formation method already in the draft."
            : "This acknowledgment stays in your private draft. It adds no signed formation evidence.",
          "small",
        ),
      ),
    );
  if (componentConflicts.length)
    panel.append(
      el(
        "div",
        { class: "notice", style: "margin-top:12px" },
        checkbox(
          `I keep ${body?.word.spelling ?? "this form"} although other words claim its component rafsi ${[...new Set(componentConflicts.map((c) => c.rafsi))].join(", ")}.`,
          componentsAcknowledged,
          (value) => {
            componentsAcknowledged = value;
            if (!value && draft.lujvo) draft.lujvo.acknowledged = [];
            keepReview(componentReview, value);
            refreshPublish();
          },
        ),
      ),
    );
  if (collisions.length)
    panel.append(
      el(
        "div",
        { class: "notice", style: "margin-top:12px" },
        checkbox(
          `I keep the ${collisions.length === 1 ? "claim" : "claims"} ${collisions.map((c) => c.rafsi).join(", ")} although other words claim the same rafsi.`,
          acknowledged,
          (value) => {
            acknowledged = value;
            keepReview(claimReview, value);
            refreshPublish();
          },
        ),
      ),
    );
  const recipients = app.session.preferences.peers;
  const outcome = el("div", { "aria-live": "polite" });
  let saved = false;
  let bar: HTMLElement | null = null;
  /** The page now belongs to a committed group. The publish controls go away and the saver stops. */
  const bindSaved = () => {
    saved = true;
    forgetDraft();
    refreshPublish();
    publish.remove();
    bar?.remove();
  };
  const refreshPublish = () => {
    const disabled =
      saved ||
      blocking.length > 0 ||
      !identity ||
      !body ||
      !acknowledged ||
      !rootAcknowledged ||
      !componentsAcknowledged;
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
  const renderSaved = (items: OutboxItem[]) =>
    renderSavedGroup(app, outcome, items);
  const publish = button(
    "Publish",
    async () => {
      if (
        !body ||
        !wordId ||
        saved ||
        blocking.length ||
        !acknowledged ||
        !rootAcknowledged ||
        !componentsAcknowledged
      )
        return;
      publish.disabled = true;
      try {
        await app.session.requireUnlocked(
          `Publishing ${body.word.spelling}`,
          async () => {
            if (!(await app.session.firstSignatureDisclosure())) return;
            const latestInventory = inventoryFromPackage(
              await cachedPackage(app.store),
            );
            if (reviewedInventory !== inventoryVersion(latestInventory)) {
              outcome.replaceChildren(
                p(
                  "The local package changed during review. Review its current conflicts before publishing.",
                  "notice",
                ),
                link("Review updated conflicts", "/new/publish?review=1", {
                  class: "touch-link",
                }),
              );
              return;
            }
            if (recordRoots(rootAcknowledged)) saver.touch();
            if (!(await saver.flush())) return;
            // Rebuild and run the shared core checks on the saved acknowledgment state.
            refreshPreview();
            if (!body || !wordId || blocking.length) return;
            // Commit the whole group with the draft revision it publishes. The
            // same transaction removes the reviewed draft. From here on the
            // page belongs to that group, whatever fails later.
            let signed: SignedGroup;
            try {
              signed = await app.signer.sign(buildGroup(), undefined, {
                draftKey: DRAFT_KEY,
                revision: draft.revision,
              });
            } catch (error) {
              if (error instanceof PublicationConflictError) {
                if (error.kind === "already-published" && error.record) {
                  bindSaved();
                  renderSaved(await groupItems(error.record));
                  app.announce(error.message);
                  return;
                }
                if (error.kind === "newer-draft") {
                  // This page's copy is stale. It never saves again, so the
                  // newer draft loads intact. Export still works from the copy.
                  saver.detach();
                  outcome.replaceChildren(
                    el(
                      "p",
                      { class: "notice" },
                      text(`${error.message} `),
                      link("Review the newer draft", "/new/publish", {
                        class: "touch-link",
                      }),
                    ),
                  );
                  app.announce(error.message);
                  return;
                }
              }
              throw error;
            }
            bindSaved();
            app.own.invalidate();
            renderSaved(signed.items);
            const results: OutboxItem[] = [];
            for (const item of signed.items) {
              const delivered = await app.delivery.deliver(item.id, true);
              results.push(delivered ?? item);
            }
            if (!context.live()) return;
            const definitionAccepted = results.some(
              (item) =>
                item.id === signed.ids[0] &&
                Object.values(item.peers).some(
                  (peer) => peer.state === "accepted",
                ),
            );
            if (definitionAccepted) {
              navigate(
                `${routes.word(body.word.spelling, body.language)}&fresh=1`,
              );
              const unfinished = results.filter((item) =>
                Object.values(item.peers).some(
                  (peer) => peer.state !== "accepted",
                ),
              );
              app.announce(
                unfinished.length
                  ? `Published ${body.word.spelling}. ${unfinished.length} signed record${unfinished.length === 1 ? " has" : "s have"} unfinished delivery. See Not delivered.`
                  : `Published ${body.word.spelling} with your endorsement${claims.length ? ` and ${claims.length} rafsi claim${claims.length === 1 ? "" : "s"}` : ""}.`,
              );

              return;
            }
            renderSaved(results);
          },
        );
      } catch (error) {
        if (saved) {
          // The group is committed. A later failure never reports it unsaved.
          app.announce(
            `The group is saved. A later step failed: ${describe(error)}`,
          );
          outcome.append(
            p(
              `A step after saving failed: ${describe(error)}. The saved records keep their delivery path above.`,
              "notice",
            ),
          );
        } else {
          // Nothing was saved. Publication stays available.
          app.announce(describe(error));
          outcome.replaceChildren(p(describe(error), "notice"));
        }
      } finally {
        refreshPublish();
      }
    },
    {
      class: "btn btn-primary",
      style:
        "margin-top:14px;width:100%;--target-min-height:48px;font-size:17px",
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
  if (published) {
    bindSaved();
    renderSaved(await groupItems(published));
  }
}
/** The saved group: delivery state per record and the controls that use the saved bytes. */
function renderSavedGroup(app: App, outcome: HTMLElement, items: OutboxItem[]) {
  outcome.replaceChildren();
  const definition = items[0];
  const unfinished = items.filter((item) =>
    Object.values(item.peers).some((peer) => peer.state !== "accepted"),
  );
  const failed = unfinished.some((item) => isNotDelivered(item));
  const sending = unfinished.length > 0 && !failed;
  const box = el("div", {
    class: sending ? "saved-publication-progress" : "notice",
    style: "margin-top:12px",
    role: "region",
    "aria-label": "Saved publication",
  });
  box.append(
    el(
      "p",
      {},
      el("strong", {
        text: sending
          ? "Saved. Sending. "
          : unfinished.length
            ? "Saved. Not delivered yet. "
            : "Published. ",
      }),
      text(
        sending
          ? `All ${items.length} signed records are saved in this browser. Their first delivery is in progress. `
          : unfinished.length
            ? `${unfinished.length} of ${items.length} signed records did not finish delivery. They are kept in this browser with their exact bytes and sent again automatically. Publishing again would create a second definition, so this page offers delivery of the saved records instead. `
            : `All ${items.length} signed records were accepted. `,
      ),
      ...(failed
        ? [link("See Not delivered", routes.outbox, { class: "touch-link" })]
        : []),
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
  if (failed) {
    const retry = button(
      "Try now",
      async () => {
        retry.disabled = true;
        try {
          for (const item of unfinished) await app.delivery.tryNow(item.id);
          const fresh = await app.delivery.items();
          renderSavedGroup(
            app,
            outcome,
            items.map((i) => fresh.find((f) => f.id === i.id) ?? i),
          );
        } catch (error) {
          app.announce(describe(error));
        } finally {
          retry.disabled = false;
        }
      },
      { class: "btn" },
    );
    actions.append(retry);
  }
  actions.append(
    link("Open the record", routes.definition(definition.id), {
      class: "btn btn-quiet",
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
}
