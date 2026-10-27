import { interpretDefinition } from "../../../../packages/core/src/browser.ts";
import { sameValue, changedItems } from "../model/comparison.ts";
import {
  readableValue,
  exactValues,
  fieldLabels,
} from "../components/comparison.ts";
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
import { definitionBlock } from "../components/definition.ts";
import { renderRichText } from "../model/richtext.ts";
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
        { class: "small identity-meta" },
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
  const rows: {
    label: string;
    field: string;
    before: unknown;
    after: unknown;
  }[] = [];
  const add = (
    label: string,
    field: string,
    before: unknown,
    after: unknown,
  ) => {
    if (!sameValue(before, after)) rows.push({ label, field, before, after });
  };
  // Defaults and all nested values decide whether a field changed. Rendering
  // never decides equality and never changes either authenticated body.
  const before = interpretDefinition(a) as unknown as DefinitionBody;
  const after = interpretDefinition(b) as unknown as DefinitionBody;
  for (const field of Object.keys(before) as (keyof DefinitionBody)[]) {
    if (field !== "frame") {
      add(fieldLabels[field] ?? field, field, before[field], after[field]);
      continue;
    }
    const { places: left = [], ...leftFrame } = before.frame ?? {};
    const { places: right = [], ...rightFrame } = after.frame ?? {};
    add(
      "Place structure",
      "frame",
      before.frame === null ? null : leftFrame,
      after.frame === null ? null : rightFrame,
    );
    const indices = [
      ...new Set([...left, ...right].map((place) => place.index)),
    ].sort((a, b) => a - b);
    for (const index of indices)
      add(
        `Place ${index}`,
        "place",
        left.find((place) => place.index === index),
        right.find((place) => place.index === index),
      );
    // Place numbers provide identity. Retain order changes separately if present.
    if (left.length === right.length && indices.length === left.length)
      add(
        "Place order",
        "order",
        left.map((place) => place.index),
        right.map((place) => place.index),
      );
  }
  if (!rows.length) {
    section.append(
      p("The two revisions have identical content fields.", "small"),
    );
    return section;
  }
  const fields = el("div", {
    role: "region",
    "aria-label": "Changed fields",
    class: "comparison-fields",
  });
  for (const { label, field, before, after } of rows) {
    const row = el(
      "section",
      { class: "comparison-field", "data-field": label },
      el("h3", { text: label }),
    );
    if (field === "legacy") {
      row.append(
        p(
          `Import evidence is ${before === null ? "absent" : "present"} in the parent and ${after === null ? "absent" : "present"} in this revision.${before !== null && after !== null ? " The evidence changed." : ""}`,
        ),
        exactValues(before, after),
      );
      fields.append(row);
      continue;
    }
    const list = [
      "glosses",
      "sources",
      "examples",
      "operands",
      "labels",
    ].includes(field);
    const changes = list
      ? changedItems(before as unknown[], after as unknown[])
      : [[before, after]];
    for (const [left, right] of changes) {
      const oldValue = readableValue(left, field);
      const newValue = readableValue(right, field);
      const pair = el(
        "div",
        { class: "comparison-pair" },
        el("div", {}, el("h4", { text: "Parent" }), oldValue),
        el("div", {}, el("h4", { text: "This revision" }), newValue),
      );
      row.append(pair);
      if (oldValue.textContent === newValue.textContent)
        row.append(
          p(
            "The structured values differ. Open Show exact values to inspect the difference.",
            "meta",
          ),
        );
      row.append(exactValues(left, right));
    }
    fields.append(row);
  }
  section.append(fields);
  section.append(
    el(
      "p",
      { class: "meta" },
      text("Parent "),
      link(parent.envelope.id, routes.definition(parent.envelope.id), {
        class: "fingerprint touch-link",
      }),
    ),
  );
  return section;
}
