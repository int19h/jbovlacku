import { parse, SyntaxError, type ParseNode } from "./generated-parser.js";
import { BuilderError, requireLimit, resource } from "./errors.ts";
import type { Reading } from "./legacy-recognize.ts";
import { asciiLower, trimWord, utf8Length } from "./phonotactics.ts";
import { gismuShape, isShortRafsiForm } from "./rafsi.ts";
import type { MorphologyWord, RecoveredPart, WordAnalysis } from "./types.ts";

export const CGV_WARNING =
  "This form is not valid under the current BPFK morphology.";
export const PEG_WORK_LIMIT = 50_000;
const morphology = {
  id: "https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#extended-lujvo",
  version: "4",
};
function hasCgv(node: ParseNode): boolean {
  return node.rule === "cgv_onset" || node.children.some(hasCgv);
}

/** Read all words once. The tracer counts cached calls and failed branches. */
export function recognizeWords(input: string, limit = PEG_WORK_LIMIT) {
  requireLimit("word bytes", utf8Length(input), 128);
  let spent = 0;
  let nodes: ParseNode[] = [];
  try {
    nodes = parse(input, {
      tracer: {
        trace(event) {
          if (event.type === "rule.enter" && ++spent > limit)
            resource("recognition work", spent, limit);
        },
      },
    });
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const words: MorphologyWord[] = nodes.map((node) => {
    const text = input.slice(node.start, node.end);
    return {
      text,
      kind: node.rule as MorphologyWord["kind"],
      start: node.start,
      end: node.end,
      diagnostics: hasCgv(node) ? [CGV_WARNING] : [],
    };
  });
  return { words, nodes, spent };
}

/** Recover the component spans from the same Peggy parse. */
export function componentTokens(node: ParseNode, input: string): string[] {
  const form = input.slice(node.start, node.end);
  if (
    [
      "y_rafsi",
      "stressed_y_rafsi",
      "hy_rafsi",
      "stressed_hy_rafsi",
      "fuhivla_rafsi",
      "stressed_fuhivla_rafsi",
    ].includes(node.rule)
  ) {
    const join = form.match(/'?y'?$/)![0];
    return [form.slice(0, -join.length), join];
  }
  if (["CVV_rafsi", "stressed_CVV_rafsi"].includes(node.rule)) {
    const join = node.children.find((child) => child.rule === "r_hyphen");
    return join
      ? [input.slice(node.start, join.start), input.slice(join.start, join.end)]
      : [form];
  }
  if (
    [
      "gismu",
      "fuhivla",
      "short_final_rafsi",
      "CVV_final_rafsi",
      "CVC_rafsi",
      "CCV_rafsi",
      "stressed_CVC_rafsi",
      "stressed_CCV_rafsi",
    ].includes(node.rule)
  )
    return [form];
  return node.children.flatMap((child) => componentTokens(child, input));
}

export function parsePeggyMetered(
  input: string,
  limit = PEG_WORK_LIMIT,
): { reading: Reading; spent: number } {
  const { nodes, spent } = recognizeWords(input, limit);
  const node = nodes.length === 1 ? nodes[0] : undefined;
  return {
    reading: {
      kind: node ? (node.rule as Reading["kind"]) : "unknown",
      tokens: node?.rule === "lujvo" ? componentTokens(node, input) : [],
    },
    spent,
  };
}

/** The offsets in words refer to the normalized input. */
export function analyzePeggyWord(original: string): WordAnalysis {
  const analysis: WordAnalysis = {
    original,
    normalized: null,
    kind: "unknown",
    readings: [],
    words: [],
    diagnostics: [],
    morphology: { ...morphology },
  };
  try {
    requireLimit("word bytes", utf8Length(original), 128);
    const input = asciiLower(trimWord(original))
      .replaceAll("’", "'")
      .replaceAll("h", "'")
      .replaceAll(",", "");
    if (!input || /[^a-z'.\t\n\r?! ]/.test(input)) {
      analysis.diagnostics.push(
        "The spelling uses characters outside Lojban letters, apostrophes, commas, and word separators.",
      );
      return analysis;
    }
    analysis.normalized = input.replace(/^\.|\.$/g, "");
    const { nodes, words } = recognizeWords(analysis.normalized);
    analysis.words = words;
    analysis.diagnostics = [
      ...new Set(words.flatMap((word) => word.diagnostics)),
    ];
    if (words.length === 1 && words[0].text === analysis.normalized) {
      analysis.kind = words[0].kind;
      if (analysis.kind === "lujvo") {
        const tokens = componentTokens(nodes[0], analysis.normalized);
        const parts = tokens.filter(
          (token) => !["y", "y'", "'y", "'y'", "r", "n"].includes(token),
        );
        let index = 0;
        let join: string | null = null;
        const reading: RecoveredPart[] = [];
        for (const token of tokens) {
          if (["y", "y'", "'y", "'y'", "r", "n"].includes(token)) {
            join = (join ?? "") + token;
          } else {
            const final = ++index === parts.length;
            const rafsi =
              /[bcdfgjklmnprstvxz]$/.test(token) ||
              isShortRafsiForm(token) ||
              (final && gismuShape(token) !== null);
            reading.push({
              text: token,
              kind: rafsi ? "rafsi" : "core",
              join_before: join,
            });
            join = null;
          }
        }
        analysis.readings = [reading];
      }
    } else if (
      words.length > 1 &&
      words.every((word) => word.kind === "cmavo")
    ) {
      analysis.kind = "compound";
    } else {
      analysis.diagnostics.push(
        "The form is not one word or a compound cmavo under the selected profile.",
      );
    }
  } catch (error) {
    if (!(error instanceof BuilderError)) throw error;
    analysis.kind = "unknown";
    analysis.readings = [];
    analysis.words = [];
    analysis.diagnostics = [error.message];
  }
  return analysis;
}
