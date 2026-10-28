type JsonObject = Record<string, any>;

/** Serialize JSON data without a call stack proportional to provider nesting. */
export function* jsonParts(value: unknown): Generator<string> {
  type Frame = {
    value: JsonObject | unknown[];
    keys: string[] | null;
    index: number;
    emitted: number;
  };
  type Part = { scalar: unknown } | Frame;
  const stack: Part[] = [{ scalar: value }];
  function* stringParts(text: string): Generator<string> {
    yield '"';
    for (let index = 0; index < text.length; ) {
      let end = Math.min(text.length, index + 1024);
      const last = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      if (
        end < text.length &&
        last >= 0xd800 &&
        last <= 0xdbff &&
        next >= 0xdc00 &&
        next <= 0xdfff
      )
        end--;
      const encoded = JSON.stringify(text.slice(index, end));
      yield encoded.slice(1, -1);
      index = end;
    }
    yield '"';
  }
  while (stack.length) {
    const part = stack.pop()!;
    if ("scalar" in part) {
      const node = part.scalar;
      if (typeof node === "string") {
        yield* stringParts(node);
      } else if (typeof node !== "object" || node === null) {
        yield JSON.stringify(node) ?? "null";
      } else {
        const array = Array.isArray(node);
        yield array ? "[" : "{";
        stack.push({
          value: node,
          keys: array ? null : Object.keys(node),
          index: 0,
          emitted: 0,
        });
      }
      continue;
    }
    const length = part.keys?.length ?? (part.value as unknown[]).length;
    if (part.index >= length) {
      yield part.keys ? "}" : "]";
      continue;
    }
    const name = part.keys ? part.keys[part.index] : part.index;
    const child = (part.value as JsonObject)[name];
    part.index++;
    stack.push(part);
    if (part.keys && ["undefined", "function", "symbol"].includes(typeof child))
      continue;
    if (part.emitted++) yield ",";
    if (part.keys) {
      yield* stringParts(String(name));
      yield ":";
    }
    stack.push({ scalar: child });
  }
}
export const compactJson = (value: unknown): string =>
  Array.from(jsonParts(value)).join("");
