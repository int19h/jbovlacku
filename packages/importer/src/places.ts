export const PLACE_CONVERSION_VERSION = "explicit-x-places-v1";
export interface PlaceMapping {
  field: string;
  start: number;
  end: number;
  place: number;
}

/** This recipe annotates only the definition's own, explicit x-place forms. */
export function convertPlaces(source: string | null, field: string) {
  const text = source ?? "";
  const nodes: (string | number)[] = [];
  const mappings: PlaceMapping[] = [];
  const unresolved: Record<string, number> = {};
  // Treat each delimited expression as one unit. Never rewrite part of an equation.
  const units =
    /`[^`]*(?:`|$)|"(?:\\.|[^"\\])*(?:"|$)|“[^”]*(?:”|$)|«[^»]*(?:»|$)|(?<![a-zA-Z])'[^'\n]+'(?![a-zA-Z])|\b(?:zoi|la'o)\b[\s\S]*$|\bzo\s+\S+|\blu\b[\s\S]*?(?:\bli'u\b|$)|\blo'u\b[\s\S]*?(?:\ble'u\b|$)|\$\$[\s\S]*?(?:\$\$|$)|\$[^$]*(?:\$|$)|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\\[a-zA-Z]+(?:\{[^{}]*\})?|(?<![a-zA-Z0-9])[a-zA-Z][a-zA-Z0-9]*_(?:\{[^{}]*\}|[a-zA-Z0-9]+)|\bx[0-9]+\b|\$[\s\S]*$|\\[([][\s\S]*$/g;
  let end = 0;
  let scalarEnd = 0;
  const nesting: string[] = [];
  const scanGap = (gap: string) => {
    for (const char of gap) {
      if ("([{".includes(char)) nesting.push(char);
      else if (")]}".includes(char)) {
        const expected = { ")": "(", "]": "[", "}": "{" }[char];
        if (nesting.at(-1) === expected) nesting.pop();
        else nesting.push("?");
      }
    }
  };
  const literal = (value: string) => {
    if (!value) return;
    if (typeof nodes.at(-1) === "string")
      nodes[nodes.length - 1] = String(nodes.at(-1)) + value;
    else nodes.push(value);
  };
  for (const unit of text.matchAll(units)) {
    const start = unit.index!;
    const gap = text.slice(end, start);
    scanGap(gap);
    literal(gap);
    const scalarStart = scalarEnd + [...gap].length;
    const raw = unit[0];
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
    const before = text.slice(0, start);
    const after = text.slice(start + raw.length);
    const boundary =
      !/[\p{L}\p{N}_\\{]$/u.test(before.slice(-2)) &&
      !/^[\p{L}\p{N}_{}^]/u.test(after.slice(0, 2));
    const equation =
      /[=+*/^<>−-]/.test(before.trimEnd().at(-1) ?? "") ||
      /[=+*/^<>−-]/.test(after.trimStart()[0] ?? "");
    if (
      place > 0 &&
      place <= 65535 &&
      boundary &&
      !equation &&
      nesting.length === 0 &&
      !(raw.startsWith("$") && (before.endsWith("$") || after.startsWith("$")))
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
      warnings: Object.keys(unresolved).length
        ? [
            "Unconverted variables or mathematics remain literal. Notes, etymology, examples, and quoted relations receive no place annotations.",
          ]
        : [],
    },
    unresolved,
  };
}
