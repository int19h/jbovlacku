import type { Evaluation } from "../../core/src/index.ts";
import type { SearchEntry } from "./packages.ts";

/** Scan each entry once and retain the public lexical match tiers and order. */
export function lexicalSearch(
  entries: Iterable<SearchEntry>,
  query: string,
  language: string,
  evaluation: Evaluation,
  includeRetired = false,
) {
  const q = query.toLocaleLowerCase("en");
  const kinds = [
    "headword",
    "gloss",
    "headword-prefix",
    "gloss-prefix",
    "token",
  ];
  const hits = new Map<
    string,
    {
      word: unknown;
      word_id: string;
      match: string;
      definitions: string[];
      preview: {
        event: string;
        word_kind: string;
        plain_text: string;
        status: string;
      };
    }
  >();
  for (const entry of entries) {
    const publication = evaluation.publications[entry.event];
    if (
      entry.language !== language ||
      !publication ||
      evaluation.receipts[entry.event]?.interpretation !== "effective" ||
      publication.eligible !== "eligible" ||
      (publication.status !== "active" && !includeRetired)
    )
      continue;
    const spelling = entry.word.spelling.toLocaleLowerCase("en");
    const glosses = entry.glosses.map((g) => g.text.toLocaleLowerCase("en"));
    const match =
      spelling === q
        ? "headword"
        : glosses.includes(q)
          ? "gloss"
          : spelling.startsWith(q)
            ? "headword-prefix"
            : glosses.some((g) => g.startsWith(q))
              ? "gloss-prefix"
              : entry.plain_text.toLocaleLowerCase("en").includes(q)
                ? "token"
                : null;
    if (!match) continue;
    const wordId = publication.word;
    const classification = entry.classification as {
      kind?: unknown;
    } | null;
    const plainText = entry.plain_text.replace(/\s+/gu, " ").trim();
    const characters = Array.from(plainText);
    const preview = {
      event: entry.event,
      word_kind:
        typeof classification?.kind === "string"
          ? classification.kind
          : "unknown",
      plain_text:
        characters.length > 240
          ? characters.slice(0, 239).join("") + "…"
          : plainText,
      status: publication.status,
    };
    const old = hits.get(wordId);
    if (old) {
      old.definitions.push(entry.event);
      if (
        kinds.indexOf(match) < kinds.indexOf(old.match) ||
        (match === old.match && entry.event < old.preview.event)
      ) {
        old.match = match;
        old.preview = preview;
      }
    } else
      hits.set(wordId, {
        word: entry.word,
        word_id: wordId,
        match,
        definitions: [entry.event],
        preview,
      });
  }
  const ordered = [...hits.values()].sort(
    (a, b) =>
      kinds.indexOf(a.match) - kinds.indexOf(b.match) ||
      a.word_id.localeCompare(b.word_id),
  );

  return ordered;
}
