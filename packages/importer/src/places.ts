export const PLACE_CONVERSION_VERSION = "explicit-x-places-v8";
export interface PlaceMapping {
  field: string;
  start: number;
  end: number;
  place: number;
}

/** Recognized own-place candidates, including forms in protected literal text. */
export function explicitPlaceCount(source: string): number {
  return [
    ...source.matchAll(
      /(?<![a-zA-Z0-9_])x_(?:([1-9][0-9]{0,4})|\{([1-9][0-9]{0,4})\})(?![a-zA-Z0-9_])/g,
    ),
  ].filter((match) => Number(match[1] ?? match[2]) <= 65535).length;
}

const quotedUnits =
  /(`{2,})[\s\S]*?(?:\1|''|$)|`[^`]*(?:`|$)|"(?:\\.|[^"\\])*(?:"|$)|“[^”]*(?:”|$)|«[^»]*(?:»|$)|(?<![a-zA-Z])'[^'\n]+'(?![a-zA-Z])/;
const mathUnits =
  /\$\$[\s\S]*?(?:\$\$|$)|\$[^$]*(?:\$|$)|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\\[a-zA-Z]+(?:\{[^{}]*\})?/;
const marker = "(?:lo'u|la'o|zoi|lu|zo)";
const bare = (word: string) => `(?<![a-zA-Z0-9_'])${word}(?![a-zA-Z0-9_'])`;
const cjkCharacter =
  /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}]/u;

/** Only explicit parenthetical labels and marker lists count as mentions. */
function mentionEnd(text: string, start: number): number | null {
  const opening = /([（(])\s*$/u.exec(text.slice(0, start))?.[1];
  if (!opening) return null;
  const tail = text.slice(start);
  const close = tail.search(/[）)]/u);
  if (close < 0 || close > 120) return null;
  if (tail[close] !== (opening === "(" ? ")" : "）")) return null;
  const atom = `${marker}(?:\\s*[;,]\\s*(?:quote|quotation)?|\\s+(?:quote|quotation))?`;
  if (
    !new RegExp(`^${atom}(?:\\s+(?:or|and)\\s+${atom})*\\s*$`).test(
      tail.slice(0, close),
    )
  )
    return null;
  return start + close + 1;
}

/** A Chinese continuation is not part of a preceding ASCII quoted token. */
function zoEnd(text: string, after: number): number | null {
  const separator = /^(?:\s|\.)+/.exec(text.slice(after));
  if (!separator) return null;
  const start = after + separator[0].length;
  if (start === text.length) return null;
  let end = start;
  const ascii = /[a-zA-Z]/.test(text[start]);
  for (const char of text.slice(start)) {
    if (/\s/u.test(char)) break;
    if (
      ascii &&
      (cjkCharacter.test(char) || !/[\p{L}\p{M}\p{N}_']/u.test(char))
    )
      break;
    end += char.length;
  }
  return end > start ? end : null;
}

/** Resolve supported nested lu and zo; leave other nested quote syntax opaque. */
function quotationEnd(text: string, after: number, opener: string) {
  const tokens = new RegExp(
    `${quotedUnits.source}|${mathUnits.source}|${bare("(?:lo'u|la'o|li'u|le'u|zoi|lu|zo)")}`,
    "g",
  );
  tokens.lastIndex = after;
  let depth = 1;
  let token: RegExpExecArray | null;
  while ((token = tokens.exec(text))) {
    const word = token[0];
    if (word === "zo") {
      const end = zoEnd(text, tokens.lastIndex);
      if (end === null) break;
      tokens.lastIndex = end;
    } else if (opener === "lu" && word === "lu") {
      depth++;
    } else if (word === (opener === "lu" ? "li'u" : "le'u")) {
      if (--depth === 0) return { end: tokens.lastIndex, uncertain: false };
    } else if (
      ["zoi", "la'o"].includes(word) ||
      (opener === "lu" && word === "lo'u")
    ) {
      break;
    }
  }
  return { end: text.length, uncertain: true };
}

/** This recipe annotates only the definition's own, explicit x-place forms. */
export function convertPlaces(source: string | null, field: string) {
  const text = source ?? "";
  const nodes: (string | number)[] = [];
  const mappings: PlaceMapping[] = [];
  const unresolved: Record<string, number> = {};
  const quotationWarnings: string[] = [];
  // Treat each delimited expression as one unit. Never rewrite part of an equation.
  const units = new RegExp(
    `${quotedUnits.source}|${bare(marker)}|${mathUnits.source}|(?<![a-zA-Z0-9])[a-zA-Z][a-zA-Z0-9]*_(?:\\{[^{}]*\\}|[a-zA-Z0-9]+)|\\bx[0-9]+\\b|\\$[\\s\\S]*$|\\\\[([][\\s\\S]*$`,
    "g",
  );
  let end = 0;
  let scalarEnd = 0;
  const nesting: string[] = [];
  const scanGap = (gap: string) => {
    for (const char of gap) {
      if ("([{".includes(char)) nesting.push(char);
      else if (")]}".includes(char)) {
        const expected = { ")": "(", "]": "[", "}": "{" }[char];
        if (nesting.at(-1) === expected) nesting.pop();
        else if (nesting.length) nesting.push("?");
      }
    }
  };
  const literal = (value: string) => {
    if (!value) return;
    if (typeof nodes.at(-1) === "string")
      nodes[nodes.length - 1] = String(nodes.at(-1)) + value;
    else nodes.push(value);
  };
  let unit: RegExpExecArray | null;
  while ((unit = units.exec(text))) {
    const start = unit.index!;
    const gap = text.slice(end, start);
    scanGap(gap);
    literal(gap);
    const scalarStart = scalarEnd + [...gap].length;
    let raw = unit[0];
    if (["lu", "lo'u", "zo", "zoi", "la'o"].includes(raw)) {
      const mention = mentionEnd(text, start);
      let end: number;
      if (mention !== null) {
        end = mention;
        scanGap(text.slice(start, end));
      } else if (raw === "lu" || raw === "lo'u") {
        const boundary = quotationEnd(text, units.lastIndex, raw);
        end = boundary.end;
        if (boundary.uncertain)
          quotationWarnings.push(
            "The Lojban quotation boundary is unresolved. The uncertain remainder stays literal.",
          );
      } else if (raw === "zo") {
        const quotedEnd = zoEnd(text, units.lastIndex);
        end = quotedEnd ?? text.length;
        if (quotedEnd === null)
          quotationWarnings.push(
            "The zo token boundary is unresolved. The uncertain remainder stays literal.",
          );
      } else {
        end = text.length;
      }
      raw = text.slice(start, end);
      units.lastIndex = end;
    }
    const stripped =
      raw.startsWith("$$") && raw.endsWith("$$")
        ? raw.slice(2, -2).trim()
        : raw.startsWith("$") && raw.endsWith("$") && raw.length > 1
          ? raw.slice(1, -1).trim()
          : (raw.startsWith("\\(") && raw.endsWith("\\)")) ||
              (raw.startsWith("\\[") && raw.endsWith("\\]"))
            ? raw.slice(2, -2).trim()
            : raw;
    const match = /^x_(?:([1-9][0-9]{0,4})|\{([1-9][0-9]{0,4})\})$/.exec(
      stripped,
    );
    const place = match ? Number(match[1] ?? match[2]) : 0;
    const delimited = stripped !== raw;
    const before = text.slice(0, start);
    const after = text.slice(start + raw.length);
    const left = [...before.slice(-2)].at(-1) ?? "";
    const right = [...after.slice(0, 2)][0] ?? "";
    const cjk = (char: string) => delimited && cjkCharacter.test(char);
    const boundary =
      !/[\p{N}_\\{]/u.test(left) &&
      !/[\p{N}_{}^]/u.test(right) &&
      (!/[\p{L}\p{M}]/u.test(left) || cjk(left)) &&
      (!/[\p{L}\p{M}]/u.test(right) || cjk(right));
    const malformedNeighbor =
      /^\$|^\\[)\]]/.test(after) || (!delimited && before.endsWith("$"));
    // Finished delimiters separate a place from prose brackets and suffixes.
    // Keep mathematical operators visible across those brackets.
    const equationBefore = delimited
      ? before.replace(/(?:[([{]\s*)+$/u, "")
      : before;
    const equationAfter = delimited
      ? after.replace(/^(?:\s*[)\]}])+/u, "")
      : after;
    const equation =
      /[\p{L}\p{N}_](?:\(\s*)+$/u.test(before) ||
      /(?:[\p{Sm}\p{Pd}*/^·:]|\\[a-zA-Z]+)\s*$/u.test(equationBefore) ||
      /^\s*(?:[\p{Sm}*/^·:]|\\[a-zA-Z]+)/u.test(equationAfter) ||
      (delimited
        ? /^\s*\p{Pd}\s*(?:[$\\([{\p{N}\p{Sm}\p{Pd}*/^·:]|\p{L}[\p{L}\p{M}\p{N}]*_|\p{L}\p{M}*\p{N}*(?![\p{L}\p{M}\p{N}_]))/u.test(
            equationAfter,
          )
        : /^\s*\p{Pd}/u.test(equationAfter));
    if (
      place > 0 &&
      place <= 65535 &&
      boundary &&
      !equation &&
      !malformedNeighbor &&
      (delimited || nesting.length === 0) &&
      !(raw.startsWith("$") && before.endsWith("$"))
    ) {
      nodes.push(place);
      mappings.push({
        field,
        start: scalarStart,
        end: scalarStart + [...raw].length,
        place,
      });
    } else {
      literal(raw);
      if (/[a-zA-Z]_|\bx[0-9]+\b/.test(raw)) {
        const points = [...raw];
        const pattern =
          points.length > 80 ? points.slice(0, 77).join("") + "..." : raw;
        unresolved[pattern] = (unresolved[pattern] ?? 0) + 1;
      }
    }
    end = start + raw.length;
    scalarEnd = scalarStart + [...raw].length;
  }
  literal(text.slice(end));
  const indices = [...new Set(mappings.map((mapping) => mapping.place))].sort(
    (a, b) => a - b,
  );
  return {
    text: nodes.length ? [nodes] : [],
    frame: indices.length
      ? {
          role: "predicate",
          arity: { mode: "context" },
          places: indices.map((index) => ({ index })),
        }
      : null,
    conversion: {
      method: mappings.length ? "heuristic" : "literal",
      tool: "jbovlacku-lensisku-import",
      version: PLACE_CONVERSION_VERSION,
      model: null,
      review: "unreviewed",
      mappings,
      warnings: [
        ...(Object.keys(unresolved).length
          ? [
              "Unconverted variable patterns remain literal. Notes, etymology, examples, and source history receive no place annotations.",
              ...Object.entries(unresolved).map(
                ([pattern, count]) =>
                  `Unconverted pattern ${JSON.stringify(pattern)} (${count} ${count === 1 ? "occurrence" : "occurrences"}).`,
              ),
            ]
          : []),
        ...quotationWarnings,
      ],
    },
    unresolved,
  };
}
