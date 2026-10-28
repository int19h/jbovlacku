/**
 * The definition block used by the word page, the definition page, and the
 * publish preview. It renders interpreted fields and keeps the original signed record.
 */
import {
  inlineProse,
  el,
  link,
  p,
  text,
  disclosure,
  append,
  button,
} from "../lib/dom.ts";
import { plural, fingerprintText } from "../lib/format.ts";
import { renderRichText, plainText, visibleJson } from "../model/richtext.ts";
import type {
  DefinitionBody,
  Envelope,
  Place,
  ScoreRecord,
  Calculation,
  WordResponse,
} from "../model/types.ts";
import { attribution, identityLink } from "./attribution.ts";
import { judgmentControl, scoreDetails } from "./judgment.ts";
import type { App } from "../app/context.ts";
import { routes } from "../app/router.ts";
import { getIdentity } from "../data/api.ts";
import { isZeiCompound } from "../model/builders.ts";
import type { LoadedRecord } from "../data/api.ts";
import { stripAcuteAccents } from "../../../../packages/core/src/browser.ts";

export interface DefinitionBlockOptions {
  score: ScoreRecord | null;
  unavailable: boolean;
  personal?: boolean;
  reason?: string;
  status?: string;
  calculation?: Calculation | null;
  secondary?: boolean;
  /** Known revisions of this definition, as loaded records. */
  revisions?: LoadedRecord<DefinitionBody>[];
  word?: WordResponse | null;
  onChange?: () => void;
  /** Preview mode hides judgment and tools. */
  preview?: boolean;
  placeAnchorPrefix?: string;
}
export function placeGloss(place: Place, language: string): string | null {
  const gloss =
    place.glosses.find((g) => g.language === language) ?? place.glosses[0];
  if (gloss) return gloss.text;
  const description = plainText(place.description).trim();
  return description || null;
}
export function placeStrip(
  body: DefinitionBody,
  id: string,
  options: { revise?: string | null; prefix?: string } = {},
): HTMLElement | null {
  const frame = body.frame;
  if (!frame) return null;
  const prefix = options.prefix ?? `place-${id.slice(5, 13)}-`;
  const strip = el("div", { class: "place-strip", id: `${prefix}strip` });
  let missing = false;
  for (const place of frame.places) {
    const label = placeGloss(place, body.language);
    if (!label) missing = true;
    const item = el("span", { id: `${prefix}${place.index}` });
    const marker = el("span", {
      class: place.index > 20 ? "pl badge" : "pl",
      "aria-hidden": "true",
      text: String(place.index),
    });
    item.append(
      marker,
      el("span", { class: "sr", text: `place ${place.index}: ` }),
      text(label ?? "no description", label ? "" : "meta"),
    );
    strip.append(item);
  }
  if (frame.arity.mode === "variadic" && frame.tail)
    strip.append(
      el("span", {
        class: "meta",
        text: `places ${frame.tail.from} and on: ${plainText(frame.tail.description) || "repeated"}`,
      }),
    );
  if (frame.arity.mode === "context")
    strip.append(text("depends on context", "meta"));
  if (
    !frame.places.length &&
    frame.arity.mode === "fixed" &&
    frame.arity.count === 0
  )
    strip.append(text("no places", "meta"));
  if (missing && options.revise)
    strip.append(link("Add descriptions", options.revise, { class: "tail" }));
  return strip;
}
export function sourceDisclosureBody(
  envelope: Envelope,
  body: DefinitionBody | null,
): Node[] {
  const nodes: Node[] = [];
  const legacy = body?.legacy as Record<string, any> | null;
  if (legacy) {
    const attributionLine = legacy.attribution ?? {};
    const account = attributionLine.author_account;
    nodes.push(
      p(
        `Imported from ${legacy.source}${account && Number.isSafeInteger(account.account) ? `, account ${account.account}` : ""}. Source record ${legacy.record?.kind ?? ""} ${legacy.record?.id ?? ""}. Position ${legacy.locator ?? "unknown"}.`,
        "small",
      ),
    );
    if (typeof attributionLine.author === "string")
      nodes.push(p(`Source author: ${attributionLine.author}.`, "small"));
    if (typeof attributionLine.editor === "string")
      nodes.push(p(`Source editor: ${attributionLine.editor}.`, "small"));
    if (account?.evidence?.kind)
      nodes.push(p(`Account evidence: ${account.evidence.kind}.`, "small"));
    const dates = attributionLine.dates ?? {};
    for (const [label, value] of Object.entries(dates))
      if (typeof value === "string")
        nodes.push(p(`Source ${label}: ${value}`, "meta"));
    const original = legacy.original?.definition ?? legacy.original?.text;
    if (typeof original === "string") {
      const code = el("code", { text: original });
      nodes.push(el("p", { class: "small" }, text("Original text: "), code));
    }
    nodes.push(
      el(
        "p",
        { class: "small" },
        text("Importer: "),
        identityLink(envelope.header.issuer),
      ),
    );
    nodes.push(
      p(
        `Source snapshot ${legacy.snapshot}. Extraction ${legacy.extraction}.`,
        "meta",
      ),
    );
    nodes.push(
      disclosure("Original source author, account, and import evidence", () =>
        el("pre", { class: "json", text: visibleJson(legacy) }),
      ),
    );
  } else {
    nodes.push(
      el(
        "p",
        { class: "small" },
        inlineProse(
          "The signer link is part of the native publication attribution sentence.",
          text("Native publication signed by "),
          identityLink(envelope.header.issuer),
          text("."),
        ),
      ),
    );
  }
  if (body) {
    nodes.push(
      p(
        `Rights: ${body.license.expression}${body.license.attribution ? ` · ${body.license.attribution}` : ""}`,
        "small",
      ),
    );
    if (body.license.url)
      nodes.push(
        el(
          "p",
          { class: "meta" },
          link(body.license.url, body.license.url, {
            class: "touch-link",
            rel: "noopener noreferrer",
            target: "_blank",
          }),
        ),
      );
    if (body.sources.length) {
      const list = el("ul", { class: "small" });
      for (const source of body.sources) {
        const item = el("li", {}, el("bdi", { text: source.label }));
        if (source.url)
          item.append(
            text(" "),
            link("link", source.url, {
              class: "touch-link",
              rel: "noopener noreferrer",
              target: "_blank",
            }),
          );
        if (source.event)
          item.append(
            text(" "),
            link("record", routes.definition(source.event), {
              class: "touch-link",
            }),
          );
        if (source.locator) item.append(text(` · ${source.locator}`));
        list.append(item);
      }
      nodes.push(el("p", { class: "small", text: "Sources" }), list);
    }
  }
  return nodes;
}
export function historyBody(
  envelope: Envelope,
  revisions: LoadedRecord<DefinitionBody>[] | undefined,
): Node[] {
  const nodes: Node[] = [];
  const parents =
    (envelope.header.action.parents as string[] | undefined) ?? [];
  nodes.push(
    el(
      "p",
      { class: "small" },
      text("Permanent record "),
      link(envelope.id, routes.definition(envelope.id), {
        class: "fingerprint touch-link",
      }),
    ),
  );
  if (parents.length) {
    const list = el("ul", { class: "small" });
    for (const parent of parents)
      list.append(
        el(
          "li",
          {},
          text("Revises "),
          link(parent, routes.definition(parent), {
            class: "fingerprint touch-link",
          }),
        ),
      );
    nodes.push(list);
  } else nodes.push(p("No parent revision.", "small"));
  const children = (revisions ?? []).filter((r) =>
    ((r.envelope.header.action.parents as string[]) ?? []).includes(
      envelope.id,
    ),
  );
  if (children.length) {
    const list = el("ul", { class: "small" });
    for (const child of children)
      list.append(
        el(
          "li",
          {},
          text("Revision proposed by "),
          identityLink(child.envelope.header.issuer),
          text(": "),
          link(child.envelope.id, routes.definition(child.envelope.id), {
            class: "fingerprint touch-link",
          }),
        ),
      );
    nodes.push(list);
  }
  nodes.push(
    p(
      `Issuer ${fingerprintText(envelope.header.issuer)}. Signed headers carry no creation date.`,
      "meta",
    ),
  );
  return nodes;
}
export function definitionBlock(
  app: App,
  record: LoadedRecord<DefinitionBody>,
  options: DefinitionBlockOptions,
): HTMLElement {
  const { envelope, body } = record;
  const id = envelope.id;
  const article = el("article", {
    class: `definition${options.secondary ? " secondary" : ""}`,
    "aria-labelledby": `def-${id.slice(5, 17)}`,
  });
  const prefix = options.placeAnchorPrefix ?? `place-${id.slice(5, 13)}-`;
  const author = attribution(envelope, body);
  article.append(
    el("h2", {
      id: `def-${id.slice(5, 17)}`,
      class: "sr",
      text: `Definition by ${author.node.textContent}`,
    }),
  );
  if (body) {
    if (stripAcuteAccents(body.word.spelling) !== body.word.spelling)
      article.append(p(body.word.spelling, "meta definition-spelling"));
    const prose = renderRichText(body.text, {
      language: body.language,
      className: "prose",
      placeHref: (n) => `#${prefix}${n}`,
    });
    article.append(prose);
    if (body.glosses.length) {
      const glosses = el("p", { class: "glosses" });
      for (const [index, gloss] of body.glosses.entries()) {
        if (index) glosses.append(text(", "));
        glosses.append(
          el("bdi", {
            text: gloss.sense ? `${gloss.text} (${gloss.sense})` : gloss.text,
            lang: gloss.language,
          }),
        );
      }
      article.append(glosses);
    }
  } else
    article.append(
      p(
        record.bodyError ?? "This signed header has no available body.",
        "notice",
      ),
    );
  const byline = el("div", { class: "byline" });
  const metaLine = el("span", { class: "meta", style: "font-size:14px" });
  metaLine.append(author.node);
  if (author.date) metaLine.append(text(` · ${author.date}`));
  metaLine.append(
    text(" · "),
    link("link", routes.definition(id), { title: id }),
  );
  byline.append(metaLine, el("span", { class: "spacer" }));
  if (options.status === "deprecated")
    byline.append(text("Deprecated in this snapshot", "meta"));
  if (!options.preview) {
    const target = {
      id,
      word: envelope.header.action.word as string,
      describe: (value: string) =>
        `${value === "bless" ? "Endorsing" : value === "curse" ? "Opposing" : "Clearing your judgment on"} ${body?.word.spelling ?? "this definition"}`,
    };
    const judgmentOptions = {
      score: options.score,
      unavailable: options.unavailable,
      personal: options.personal,
      reason: options.reason,
      status: options.status,
      calculation: options.calculation,
      large: true,
      onChange: options.onChange,
    };
    byline.append(
      judgmentControl(app, target, judgmentOptions),
      scoreDetails(app, target, judgmentOptions),
    );
  }
  article.append(byline);
  if (body) {
    const reviseHref = routes.revise(id);
    const strip = placeStrip(body, id, {
      revise: options.preview ? null : reviseHref,
      prefix,
    });
    if (strip) article.append(strip);
    if (
      body.frame?.places.some(
        (place) =>
          place.description.length ||
          place.type_hints.length ||
          place.defaults.length ||
          place.derivation.length ||
          place.constraints.length,
      )
    ) {
      article.append(
        disclosure("Places in detail", () => placeTable(body, prefix)),
      );
    }
    if (body.notes.length)
      article.append(
        disclosure(
          "Notes",
          () =>
            renderRichText(body.notes, {
              language: body.language,
              placeHref: (n) => `#${prefix}${n}`,
            }),
          { id: options.preview ? undefined : "notes" },
        ),
      );
    if (body.examples.length)
      article.append(
        disclosure(plural(body.examples.length, "example"), () =>
          body.examples.map((example) =>
            el(
              "div",
              { class: "small", style: "margin-bottom:8px" },
              el("p", { lang: example.language, text: example.text }),
              renderRichText(example.translation, {
                language: body.language,
                placeHref: null,
              }),
              renderRichText(example.notes, {
                language: body.language,
                placeHref: null,
              }),
            ),
          ),
        ),
      );
    if (
      body.etymology.text.length ||
      body.etymology.formation ||
      body.etymology.compound
    )
      article.append(disclosure("Etymology", () => etymologyNodes(body)));
    if (body.operands.length)
      article.append(
        disclosure("Grammatical operands", () =>
          body.operands.map((operand) =>
            el(
              "p",
              { class: "small" },
              el("code", { text: operand.id }),
              text(
                ` ${operand.category}, ${operand.cardinality.minimum} to ${operand.cardinality.maximum ?? "any"}: `,
              ),
              renderRichText(operand.description, {
                paragraph: "span",
                placeHref: null,
              }),
            ),
          ),
        ),
      );
    if (body.labels.length)
      article.append(p(`Labels: ${body.labels.join(", ")}`, "meta"));
  }
  if (!options.preview) {
    const children = (options.revisions ?? []).filter((r) =>
      ((r.envelope.header.action.parents as string[]) ?? []).includes(id),
    );
    for (const child of children) {
      const notice = el("div", { class: "revision-notice" });
      const same = child.envelope.header.issuer === envelope.header.issuer;
      const authorNote = text(same ? ", the author." : ", a different key.");
      const snapshot = options.word?.snapshot;
      if (!same && snapshot) {
        void Promise.all([
          getIdentity(envelope.header.issuer, { snapshot }),
          getIdentity(child.envelope.header.issuer, { snapshot }),
        ])
          .then(([original, revision]) => {
            if (
              original.snapshot !== snapshot ||
              revision.snapshot !== snapshot ||
              original.suspended ||
              revision.suspended
            )
              return;
            if (original.actor === revision.actor)
              authorNote.textContent =
                ", the author through accepted key continuity.";
          })
          .catch(() => {});
      }
      notice.append(
        el(
          "span",
          {},
          text("Revision proposed by "),
          identityLink(child.envelope.header.issuer),
          authorNote,
        ),
        link(
          "Compare",
          `${routes.definition(child.envelope.id)}?compare=${encodeURIComponent(id)}`,
        ),
      );
      article.append(notice);
    }
    const source = disclosure(
      "Source",
      () => sourceDisclosureBody(envelope, body),
      { id: `source-${id}` },
    );
    if (
      location.hash === `#source-${id}` ||
      location.hash === `#${encodeURIComponent(`source-${id}`)}`
    ) {
      source.open = true;
      requestAnimationFrame(() => {
        if (source.isConnected) source.scrollIntoView();
      });
    }
    const tools = el("div", { class: "tools" });
    tools.append(
      source,
      disclosure("History", () => historyBody(envelope, options.revisions)),
      disclosure("Signed record", () =>
        el("pre", {
          class: "json",
          text: visibleJson({
            envelope,
            body: record.rawBody,
          }),
        }),
      ),
    );
    if (body)
      tools.append(
        link("Revise", routes.revise(id), {
          class: "btn btn-quiet",
          style: "font-size:14px",
        }),
      );
    article.append(tools);
  }
  void button;
  void append;
  return article;
}
export function placeTable(body: DefinitionBody, prefix: string): HTMLElement {
  const table = el("table", { class: "places-table small" });
  table.append(
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        el("th", { scope: "col", text: "Place" }),
        el("th", { scope: "col", text: "Description" }),
        el("th", { scope: "col", text: "Gloss, kind, and source" }),
      ),
    ),
  );
  const tbody = el("tbody");
  for (const place of body.frame?.places ?? []) {
    const details: string[] = [];
    for (const gloss of place.glosses) details.push(gloss.text);
    for (const hint of place.type_hints)
      for (const alternative of hint.alternatives) {
        const parts = [...alternative.tags];
        if (alternative.abstractor) parts.push(alternative.abstractor);
        if (alternative.relation_arity)
          parts.push(`relation ${describeArity(alternative.relation_arity)}`);
        details.push(parts.join(" "));
      }
    for (const derivation of place.derivation)
      details.push(`from ${derivation.word.spelling} ${derivation.place}`);
    const row = el("tr", { id: `${prefix}${place.index}` });
    row.append(
      el(
        "td",
        {},
        el("span", {
          class: "pl",
          "aria-hidden": "true",
          text: String(place.index),
        }),
        el("span", { class: "sr", text: `place ${place.index}` }),
      ),
      el(
        "td",
        {},
        renderRichText(place.description, {
          language: body.language,
          paragraph: "span",
          placeHref: null,
        }),
      ),
      el("td", { class: "meta", text: details.join(" · ") }),
    );
    if (place.defaults.length)
      row.lastElementChild!.append(
        el(
          "div",
          {},
          ...place.defaults.map((d) =>
            el("p", {
              text: `${d.kind} default: ${d.value.text}${d.value.format === "prose" ? ` (${d.value.language})` : ""}${plainText(d.condition) ? ` when ${plainText(d.condition)}` : ""}${plainText(d.explanation) ? `. ${plainText(d.explanation)}` : ""}`,
            }),
          ),
        ),
      );
    if (place.constraints.length)
      row.lastElementChild!.append(
        el(
          "div",
          {},
          ...place.constraints.map((c) => el("p", { text: plainText(c) })),
        ),
      );
    tbody.append(row);
  }
  table.append(tbody);
  const wrap = el(
    "div",
    {
      class: "table-scroll",
      tabindex: "0",
      role: "region",
      "aria-label": "Place table",
    },
    table,
  );
  if (body.frame?.constraints.length)
    wrap.append(...body.frame.constraints.map((c) => p(plainText(c), "small")));
  return wrap;
}
export function describeArity(arity: {
  mode: string;
  count?: number;
  minimum?: number;
}): string {
  if (arity.mode === "fixed") return `exactly ${arity.count}`;
  if (arity.mode === "variadic") return `${arity.minimum} or more`;
  return "depends on context";
}
export function etymologyNodes(body: DefinitionBody): Node[] {
  const nodes: Node[] = [];
  const e = body.etymology;
  if (e.text.length)
    nodes.push(
      renderRichText(e.text, { language: body.language, placeHref: null }),
    );
  if (e.compound) {
    const zei = isZeiCompound(e.compound);
    const parts = e.compound.components
      .map((c) => (zei ? c.word.spelling : `${c.word.spelling} (${c.rafsi})`))
      .join(zei ? " zei " : " + ");
    nodes.push(
      p(
        `${parts}${!zei && e.compound.score !== null ? ` · score ${e.compound.score}` : ""}`,
        "small",
      ),
    );
    nodes.push(
      p(
        `Morphology ${e.compound.morphology.id} ${e.compound.morphology.version}. Scoring ${e.compound.scoring.id} ${e.compound.scoring.version}.`,
        "meta",
      ),
    );
  }
  if (e.formation) {
    const f = e.formation;
    nodes.push(
      p(
        `Formation: ${f.method}${f.generated ? `, generated ${f.generated}` : ""}${f.selected_score ? `, score ${f.selected_score.numerator}/${f.selected_score.denominator}` : ""}${f.selected_rank ? `, rank ${f.selected_rank}` : ""}.`,
        "small",
      ),
    );
    if (f.sources.length) {
      const list = el("ul", { class: "small" });
      for (const s of f.sources) {
        const source = el(
          "li",
          {},
          el("bdi", { text: `${s.language}: ${s.word}` }),
          text(
            `${s.input ? ` → ${s.input.text} (${s.input.format})` : ""}${s.weight ? ` · weight ${s.weight.numerator}/${s.weight.denominator}` : ""}`,
          ),
        );
        for (const [label, value] of [["Said", s.word_ipa]])
          if (value) source.append(p(`${label}: ${value}`, "meta"));
        if (s.notes.length) {
          const notes = renderRichText(s.notes, {
            placeHref: null,
            className: "source-notes",
          });
          notes.style.whiteSpace = "pre-wrap";
          source.append(notes);
        }
        list.append(source);
      }
      nodes.push(list);
    }
    if (f.algorithm)
      nodes.push(
        p(`Algorithm ${f.algorithm.id} ${f.algorithm.version}.`, "meta"),
      );
    else if (f.method === "algorithmic")
      nodes.push(
        p(
          "Algorithm unresolved. This run is descriptive evidence and not labeled reproducible.",
          "meta",
        ),
      );
    if (f.conflicts.length)
      nodes.push(
        p(
          `Acknowledged conflicts: ${f.conflicts.map((c) => `${c.rule} with ${c.word}`).join("; ")}.`,
          "meta",
        ),
      );
  }
  return nodes;
}
