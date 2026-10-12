/** One immutable definition revision, with its receipt and an optional comparison. */
import { el, p, link, text, describe } from "../lib/dom.ts";
import { routes, type RenderContext, type Route } from "../app/router.ts";
import type { App } from "../app/context.ts";
import {
  getReceipt,
  getWord,
  loadDefinition,
  loadRecord,
  RequestError,
  type LoadedRecord,
} from "../data/api.ts";
import {
  eventId,
  type DefinitionBody,
  type RafsiBody,
  type WordResponse,
} from "../model/types.ts";
import { definitionBlock, describeArity } from "../components/definition.ts";
import { plainText, renderRichText } from "../model/richtext.ts";
import { identityLink } from "../components/attribution.ts";

export async function definitionPage(
  route: Route,
  context: RenderContext,
  app: App,
) {
  const { main } = context;
  main.className = "surface-word";
  const id = route.segments[1] ?? "";
  context.title("Definition");
  if (!eventId(id)) {
    main.append(
      el("h1", { class: "page", text: "Record unavailable" }),
      p("This link does not name a signed event.", "notice"),
    );
    return;
  }
  let record: LoadedRecord;
  try {
    record = await loadRecord(id);
  } catch (error) {
    if (!context.live()) return;
    main.append(
      el("h1", { class: "page", text: "Record unavailable" }),
      p(describe(error), "notice"),
    );
    return;
  }
  if (!context.live()) return;
  const kind = record.envelope.header.action.kind;
  if (kind !== "definition.publish") {
    main.append(el("h1", { class: "page", text: `Signed ${kind} record` }));
    main.append(
      el(
        "p",
        { class: "small" },
        text("Signed by "),
        identityLink(record.envelope.header.issuer),
      ),
    );
    if (kind === "rafsi.publish" && record.body) {
      const body = record.body as RafsiBody;
      main.append(
        p(`Rafsi ${body.rafsi} claimed for ${body.word.spelling}.`, "small"),
        renderRichText(body.rafsi ? body.rationale : [], { placeHref: null }),
      );
      main.append(
        link(`Open ${body.word.spelling}`, routes.word(body.word.spelling), {
          class: "btn",
        }),
      );
    } else
      main.append(
        el("pre", {
          class: "json",
          text: JSON.stringify(record.envelope.header.action, null, 2),
        }),
      );
    return;
  }
  const definition = record as LoadedRecord<DefinitionBody>;
  const spelling = definition.body?.word.spelling;
  context.title(spelling ? `Definition: ${spelling}` : "Definition");
  const head = el("div", { class: "word-head" });
  head.append(el("h1", { lang: "jbo", text: spelling ?? "Definition" }));
  if (spelling)
    head.append(
      link("All definitions", routes.word(spelling), { class: "small" }),
    );
  main.append(
    head,
    p(
      "One immutable revision. Its exact event ID identifies this publication.",
      "meta",
    ),
  );
  let word: WordResponse | null = null;
  const wordKey = definition.envelope.header.action.word as string;
  try {
    word = await getWord(wordKey, { signal: context.signal });
  } catch {}
  if (!context.live()) return;
  const siblings: LoadedRecord<DefinitionBody>[] = [];
  if (word)
    await Promise.all(
      word.definitions.map(async (sibling) => {
        try {
          siblings.push(await loadDefinition(sibling, word!.snapshot));
        } catch {}
      }),
    );
  if (!context.live()) return;
  const score = word?.scores.find((s) => s.target === id) ?? null;
  const inWord = word?.definitions.includes(id) ?? false;
  main.append(
    definitionBlock(app, definition, {
      score,
      unavailable:
        !word ||
        word.calculation === null ||
        !inWord ||
        word.unavailable_scores.includes(id) ||
        !score,
      status: word?.statuses.find((s) => s?.event === id)?.state,
      calculation: word?.calculation,
      revisions: siblings,
      word,
    }),
  );
  if (word && !inWord)
    main.append(
      p(
        "This revision is not among the definitions that the selected view shows for its word.",
        "small",
      ),
    );
  const compareTo = route.params.get("compare");
  if (compareTo && eventId(compareTo)) {
    try {
      const parent = await loadDefinition(compareTo);
      if (!context.live()) return;
      main.append(comparison(parent, definition));
    } catch (error) {
      if (context.live())
        main.append(p(`Comparison unavailable: ${describe(error)}`, "notice"));
    }
  }
  try {
    const receipt = await getReceipt(id, { signal: context.signal });
    if (!context.live()) return;
    main.append(
      p(
        `This server: admission ${receipt.admission}, interpretation ${receipt.interpretation}, body ${receipt.body_status}${receipt.reasons.length ? ` (${receipt.reasons.join(", ")})` : ""}.`,
        "meta",
      ),
    );
  } catch (error) {
    if (!context.live()) return;
    main.append(
      p(
        error instanceof RequestError && error.status === 404
          ? "This server has no receipt for this record."
          : describe(error),
        "meta",
      ),
    );
  }
}
/** Side-by-side comparison of two revisions' changed fields. */
export function comparison(
  parent: LoadedRecord<DefinitionBody>,
  child: LoadedRecord<DefinitionBody>,
): HTMLElement {
  const section = el("section", {
    "aria-labelledby": "cmp-h",
    style: "margin-top:24px",
  });
  section.append(
    el("h2", {
      id: "cmp-h",
      class: "section",
      text: "Compare with the parent revision",
    }),
  );
  const a = parent.body;
  const b = child.body;
  if (!a || !b) {
    section.append(
      p(
        "One of the two bodies is unavailable, so the comparison cannot show changed fields.",
        "notice",
      ),
    );
    return section;
  }
  const rows: [string, string, string][] = [];
  const add = (label: string, before: string, after: string) => {
    if (before !== after) rows.push([label, before, after]);
  };
  add("Definition", plainText(a.text), plainText(b.text));
  add(
    "Glosses",
    a.glosses.map((g) => g.text).join(", "),
    b.glosses.map((g) => g.text).join(", "),
  );
  add("Language", a.language, b.language);
  add(
    "Type",
    `${a.classification.kind} ${a.classification.selmaho.join(" ")}`.trim(),
    `${b.classification.kind} ${b.classification.selmaho.join(" ")}`.trim(),
  );
  const frameText = (body: DefinitionBody) =>
    body.frame
      ? `${describeArity(body.frame.arity)}: ${body.frame.places
          .map((pl) => {
            const gloss = pl.glosses.map((g) => g.text).join("/");
            const description = plainText(pl.description).trim();
            const extras = [
              pl.defaults.length
                ? `defaults ${pl.defaults.map((d) => d.value.text).join("; ")}`
                : null,
              pl.derivation.length
                ? `from ${pl.derivation.map((d) => `${d.word.spelling} ${d.place}`).join(", ")}`
                : null,
            ].filter(Boolean);
            return `${pl.index} ${gloss || "—"}${description ? ` (${description})` : ""}${extras.length ? ` [${extras.join("; ")}]` : ""}`;
          })
          .join(" · ")}`
      : "no frame";
  add("Places", frameText(a), frameText(b));
  add("Notes", plainText(a.notes), plainText(b.notes));
  add("Etymology", plainText(a.etymology.text), plainText(b.etymology.text));
  add(
    "Examples",
    a.examples.map((e) => e.text).join(" | "),
    b.examples.map((e) => e.text).join(" | "),
  );
  add(
    "Sources",
    a.sources.map((s) => s.label).join(" | "),
    b.sources.map((s) => s.label).join(" | "),
  );
  add("Labels", a.labels.join(", "), b.labels.join(", "));
  add(
    "Rights",
    `${a.license.expression} ${a.license.attribution}`.trim(),
    `${b.license.expression} ${b.license.attribution}`.trim(),
  );
  if (!rows.length) {
    section.append(
      p("The two revisions have identical content fields.", "small"),
    );
    return section;
  }
  const table = el("table", { class: "small" });
  table.append(
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        el("th", { scope: "col", text: "Field" }),
        el("th", { scope: "col", text: "Parent" }),
        el("th", { scope: "col", text: "This revision" }),
      ),
    ),
  );
  const body = el("tbody");
  for (const [label, before, after] of rows)
    body.append(
      el(
        "tr",
        {},
        el("th", { scope: "row", text: label }),
        el("td", {}, el("bdi", { text: before || "—" })),
        el("td", {}, el("bdi", { text: after || "—" })),
      ),
    );
  table.append(body);
  section.append(
    el(
      "div",
      {
        class: "table-scroll",
        tabindex: "0",
        role: "region",
        "aria-label": "Changed fields",
      },
      table,
    ),
  );
  section.append(
    el(
      "p",
      { class: "meta" },
      text("Parent "),
      link(parent.envelope.id, routes.definition(parent.envelope.id), {
        class: "fingerprint",
      }),
    ),
  );
  return section;
}
