/**
 * Rafsi lookup and the standalone claim flow. `/rafsi/<spelling>` lists the
 * known assignments of a rafsi across words from this server's version 2
 * search package. `/claim/<word>` signs a claim with its pair blessing.
 */
import {
  rafsiPairId,
  stripAcuteAccents,
  wordId as deriveWordId,
} from "../../../../packages/core/src/browser.ts";
import { el, p, text, link, button, field, describe } from "../lib/dom.ts";
import {
  navigate,
  routes,
  type RenderContext,
  type Route,
} from "../app/router.ts";
import type { App } from "../app/context.ts";
import { downloadPackage, isV2, type CachedPackage } from "../data/search.ts";
import { getWord, loadRecord } from "../data/api.ts";
import type { PackageEntryV2, RafsiBody } from "../model/types.ts";
import { identityLink } from "../components/attribution.ts";
import { viewScores } from "../components/localview.ts";
import { judgmentControl, scoreDetails } from "../components/judgment.ts";
import { renderRichText } from "../model/richtext.ts";

/** Loads the version 2 package for a language, from cache or the server. */
async function packageFor(
  app: App,
  language: string,
  signal: AbortSignal,
): Promise<CachedPackage | null> {
  // Prefer the server's current package so new claims appear. Fall back to the cache.
  try {
    const fresh = await downloadPackage(language, { signal });
    if (fresh.version === 2) {
      if (app.session.storageAvailable)
        await app.store.put("packages", language, fresh).catch(() => {});
      return fresh;
    }
  } catch {}
  if (!app.session.storageAvailable) return null;
  const cached =
    (await app.store
      .get<CachedPackage>("packages", language)
      .catch(() => null)) ?? null;
  return cached?.version === 2 ? cached : null;
}
/** Words whose retained claims use this rafsi spelling, from version 2 package rows. */
export async function wordsWithRafsi(
  app: App,
  rafsi: string,
  signal: AbortSignal,
): Promise<{ spelling: string; language: string }[]> {
  const languages = new Set<string>([
    app.session.preferences.definitionLanguage,
  ]);
  if (app.session.storageAvailable)
    for (const key of await app.store.keys("packages").catch(() => []))
      languages.add(key);
  const found = new Map<string, { spelling: string; language: string }>();
  for (const language of languages) {
    const pkg = await packageFor(app, language, signal);
    if (!pkg) continue;
    for (const entry of pkg.entries)
      if (isV2(entry) && (entry as PackageEntryV2).rafsi.includes(rafsi))
        found.set(deriveWordId(entry.word), {
          spelling: entry.word.spelling,
          language,
        });
  }
  return [...found.values()].sort((a, b) =>
    a.spelling.localeCompare(b.spelling),
  );
}
/** One word's card for a rafsi: the pair status, the judgment control, and the retained claims. */
async function pairCard(
  app: App,
  context: RenderContext,
  w: { spelling: string; language: string },
  rafsi: string,
): Promise<HTMLElement> {
  const id = deriveWordId({ language: "jbo", spelling: w.spelling });
  const pair = rafsiPairId(id, rafsi);
  const card = el("section", {
    class: "definition",
    "aria-label": `${rafsi} for ${w.spelling}`,
  });
  card.append(
    el(
      "p",
      { class: "prose" },
      link(w.spelling, routes.word(w.spelling, w.language), {
        lang: "jbo",
        class: "touch-link",
      }),
      text(` with rafsi ${rafsi}`, "meta"),
    ),
  );
  try {
    const word = await getWord(id, { signal: context.signal });
    if (!context.live()) return card;
    const assignment = word.assignments.find((a) => a.id === pair);
    const view = await viewScores(app, id, word);
    if (!context.live()) return card;
    const score = view.scores.find((s) => s.target === pair) ?? null;
    const byline = el("div", { class: "byline" });
    byline.append(
      text(
        assignment
          ? `${assignment.status === "eligible" ? "Eligible pair" : assignment.status === "inactive" ? "Inactive pair" : "Pair status unknown"} · ${assignment.claims.length} claim${assignment.claims.length === 1 ? "" : "s"}`
          : "No claim in the selected view",
        "meta",
      ),
      el("span", { class: "spacer" }),
    );
    const target = {
      id: pair,
      word: id,
      describe: (value: string) =>
        `${value === "bless" ? "Endorsing" : value === "curse" ? "Opposing" : "Clearing your judgment on"} rafsi ${rafsi} for ${w.spelling}`,
    };
    const options = {
      score,
      unavailable:
        !assignment ||
        assignment.status !== "eligible" ||
        view.unavailable_scores.includes(pair) ||
        !score,
      personal: view.personal,
      reason: view.reason ?? undefined,
      calculation: view.calculation,
      large: true,
      // The card joins the document after the claim records load.
      signal: context.signal,
    };
    byline.append(
      judgmentControl(app, target, options),
      scoreDetails(app, target, options),
    );
    card.append(byline);
    for (const claim of assignment?.claims ?? []) {
      try {
        const record = await loadRecord<RafsiBody>(claim, word.snapshot);
        const row = el("div", {
          class: "small claim-source",
          style: "margin-top:8px",
        });
        row.append(
          text("Claimed by "),
          identityLink(record.envelope.header.issuer),
          text(" · "),
          link("record", routes.definition(claim)),
        );
        if (record.body?.rationale.length)
          row.append(
            renderRichText(record.body.rationale, { placeHref: null }),
          );
        card.append(row);
      } catch {}
    }
  } catch (error) {
    card.append(
      p(
        `This server did not answer for ${w.spelling}: ${describe(error)}`,
        "meta",
      ),
    );
  }
  return card;
}
export async function rafsiPage(
  route: Route,
  context: RenderContext,
  app: App,
) {
  const { main } = context;
  main.className = "surface-word";
  const rafsi = (route.segments[1] ?? "").normalize("NFC");
  context.title(`Rafsi ${rafsi}`);
  main.append(
    el(
      "div",
      { class: "word-head" },
      el("h1", { lang: "jbo" }, el("span", { class: "rafsi", text: rafsi })),
      text("rafsi", "meta"),
    ),
  );
  if (!rafsi) {
    main.append(p("This link names no rafsi.", "notice"));
    return;
  }
  const words = await wordsWithRafsi(app, rafsi, context.signal);
  if (!context.live()) return;
  if (!words.length) {
    main.append(
      p(
        `No retained claim assigns ${rafsi} to a word in this server's search packages. Coverage is limited to retained claim bodies.`,
        "small",
      ),
    );
    return;
  }
  const relation = el("p", { class: "muted", style: "margin-top:6px" });
  words.forEach((w, i) => {
    if (i) relation.append(text(" · "));
    relation.append(
      text(`${rafsi} ← `),
      link(w.spelling, routes.word(w.spelling, w.language), {
        lang: "jbo",
        class: "touch-link",
      }),
    );
  });
  main.append(relation);
  if (words.length > 1)
    main.append(
      p(
        `${words.length} words claim this rafsi. The assignment is unresolved until the selected view prefers one.`,
        "notice",
      ),
    );
  for (const w of words) main.append(await pairCard(app, context, w, rafsi));
  main.append(
    p(
      "A rafsi is not reserved by the first server that receives a claim. Judgments on a pair apply across all its publishers.",
      "meta",
    ),
  );
}
/** The standalone claim flow for one word. */
export async function claimPage(
  route: Route,
  context: RenderContext,
  app: App,
) {
  const { main } = context;
  main.className = "";
  const spelling = (route.segments[1] ?? "").normalize("NFC");
  context.title(`Claim a rafsi for ${spelling}`);
  main.append(
    el("h1", { class: "page", text: "Assign a rafsi" }),
    el(
      "p",
      { class: "muted", style: "margin-top:6px" },
      text("for "),
      link(spelling, routes.word(spelling), {
        lang: "jbo",
        class: "touch-link",
      }),
    ),
  );
  if (!spelling) {
    main.append(p("This link names no word.", "notice"));
    return;
  }
  const id = deriveWordId({ language: "jbo", spelling });
  const form = el("form", { class: "card", style: "margin-top:16px" });
  const rafsi = field("Rafsi spelling", {
    lang: "jbo",
    spellcheck: false,
    required: true,
    hint: "NFC spelling, at most 64 bytes. Syntax analysis is an attributed tool result, not an admission rule.",
  });
  const rationale = field("Rationale", {
    multiline: true,
    rows: 3,
    hint: "Optional. Why this assignment.",
  });
  const competition = el("div", {
    "aria-live": "polite",
    style: "margin:8px 0",
  });
  const submit = el("button", {
    type: "submit",
    class: "btn btn-primary",
    text: "Check claims and preview",
  });
  form.append(
    rafsi.wrapper,
    rationale.wrapper,
    competition,
    el(
      "div",
      { class: "actions" },
      submit,
      link("Cancel", routes.word(spelling), { class: "btn btn-quiet" }),
    ),
  );
  main.append(form);
  const previewBox = el("div");
  main.append(previewBox);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = rafsi.input.value.trim().normalize("NFC");
    if (!value) return;
    if (stripAcuteAccents(value) !== value) {
      app.announce("Rafsi claims require a spelling without acute accents.");
      return;
    }
    if (new TextEncoder().encode(value).length > 64) {
      app.announce("The rafsi exceeds 64 bytes.");
      return;
    }
    submit.disabled = true;
    competition.replaceChildren(p("Checking retained claims…", "meta"));
    try {
      const others = (await wordsWithRafsi(app, value, context.signal)).filter(
        (w) => deriveWordId({ language: "jbo", spelling: w.spelling }) !== id,
      );
      if (!context.live()) return;
      competition.replaceChildren();
      if (others.length) {
        const note = el("div", { class: "notice" });
        note.append(text(`Conflict: ${value} is already claimed for `));
        others.forEach((w, i) => {
          if (i) note.append(text(", "));
          note.append(
            link(w.spelling, routes.word(w.spelling, w.language), {
              lang: "jbo",
              class: "touch-link",
            }),
          );
        });
        note.append(
          text(
            ". A conflict is permitted. Readers see both claims, and a judgment applies to each pair separately.",
          ),
        );
        competition.append(note);
      } else
        competition.append(
          p(
            `No retained claim of ${value} for another word in this server's packages. Coverage is limited to retained claim bodies.`,
            "small",
          ),
        );
      const pair = rafsiPairId(id, value);
      previewBox.replaceChildren();
      const preview = el("div", { class: "card", style: "margin-top:12px" });
      preview.append(
        el("h2", { class: "section", style: "margin-top:0", text: "Preview" }),
        el(
          "p",
          { class: "small" },
          text(`Claim ${value} for `),
          link(spelling, routes.word(spelling), {
            lang: "jbo",
            class: "touch-link",
          }),
          text(`. Pair ${pair}`, "fingerprint"),
        ),
        p(
          "Publishing signs the claim and a separate blessing of this word and rafsi pair. One judgment applies to the pair across all its publishers. A claim does not reserve the rafsi.",
          "meta",
        ),
      );
      const go = button(
        "Sign and publish the claim",
        async () => {
          go.disabled = true;
          try {
            await app.session.requireUnlocked(
              `Claiming ${value} for ${spelling}`,
              async () => {
                if (!(await app.session.firstSignatureDisclosure())) return;
                const body: RafsiBody = {
                  word: {
                    language: "jbo",
                    spelling: stripAcuteAccents(spelling),
                  },
                  rafsi: value,
                  rationale: rationale.input.value.trim()
                    ? [[rationale.input.value.trim()]]
                    : [],
                  sources: [],
                  legacy: null,
                };
                const results = await app.signer.publish([
                  {
                    action: {
                      kind: "rafsi.publish",
                      word: id,
                      assignment: pair,
                      origin: "native",
                    },
                    body,
                  },
                  {
                    action: {
                      kind: "judgment.set",
                      target: pair,
                      value: "bless",
                    },
                    body: null,
                  },
                ]);
                app.own.invalidate();
                const done = results.every((item) =>
                  Object.values(item.peers).every(
                    (peer) => peer.state === "accepted",
                  ),
                );
                navigate(`${routes.word(spelling)}?fresh=1`);
                app.announce(
                  done
                    ? `Published the claim ${value} for ${spelling} with your endorsement.`
                    : "The claim is signed and saved here. Delivery is not finished. See Not delivered.",
                );
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
      preview.append(el("div", { class: "actions" }, go));
      previewBox.append(preview);
    } catch (error) {
      competition.replaceChildren(p(describe(error), "notice"));
    } finally {
      submit.disabled = false;
    }
  });
}

/** A pair ID names a word and a rafsi, but the ID alone does not spell them. The local packages resolve it. */
async function resolvePair(
  app: App,
  pair: string,
  signal: AbortSignal,
): Promise<{ spelling: string; language: string; rafsi: string } | null> {
  const languages = new Set<string>([
    app.session.preferences.definitionLanguage,
  ]);
  if (app.session.storageAvailable)
    for (const key of await app.store.keys("packages").catch(() => []))
      languages.add(key);
  for (const language of languages) {
    const pkg = await packageFor(app, language, signal);
    if (!pkg) continue;
    for (const entry of pkg.entries) {
      if (!isV2(entry)) continue;
      const id = deriveWordId(entry.word);
      for (const rafsi of (entry as PackageEntryV2).rafsi)
        if (rafsiPairId(id, rafsi) === pair)
          return { spelling: entry.word.spelling, language, rafsi };
    }
  }
  return null;
}
/** `/rafsi-pair/<pair ID>`: the word and rafsi of one pair, with its judgment control. */
export async function rafsiPairPage(
  route: Route,
  context: RenderContext,
  app: App,
) {
  const { main } = context;
  main.className = "surface-word";
  const pair = (route.segments[1] ?? "").trim();
  context.title("Rafsi pair");
  if (!/^jvr1:[0-9a-f]{64}$/.test(pair)) {
    main.append(
      el("h1", { class: "page", text: "Rafsi pair unavailable" }),
      p("This link does not name a rafsi pair ID.", "notice"),
    );
    return;
  }
  const found = await resolvePair(app, pair, context.signal);
  if (!context.live()) return;
  if (!found) {
    main.append(
      el("h1", { class: "page", text: "Rafsi pair unavailable" }),
      p(
        "A pair ID names a word and a rafsi, but the ID alone does not spell them. No retained claim in this server's search packages matches this pair, so the word and the rafsi are unknown here. Coverage is limited to retained claim bodies.",
        "notice",
      ),
      el("p", { class: "fingerprint", text: pair }),
    );
    return;
  }
  context.title(`Rafsi ${found.rafsi} for ${found.spelling}`);
  main.append(
    el(
      "div",
      { class: "word-head" },
      el(
        "h1",
        { lang: "jbo" },
        el("span", { class: "rafsi", text: found.rafsi }),
      ),
      text("rafsi pair", "meta"),
    ),
    el(
      "p",
      { class: "muted", style: "margin-top:6px" },
      text(`${found.rafsi} ← `),
      link(found.spelling, routes.word(found.spelling, found.language), {
        lang: "jbo",
        class: "touch-link",
      }),
      text(" · "),
      link(`all words with ${found.rafsi}`, routes.rafsi(found.rafsi), {
        class: "touch-link",
      }),
    ),
    await pairCard(app, context, found, found.rafsi),
    el("p", { class: "fingerprint", text: pair }),
  );
}
