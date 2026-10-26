export interface ParseNode {
  rule: string;
  start: number;
  end: number;
  children: ParseNode[];
}
export function parse(
  input: string,
  options: { tracer: { trace(event: { type: string }): void } },
): ParseNode[];
export class SyntaxError extends Error {}
