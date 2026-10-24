/** Source numbers keep their exact token until the import records their meaning. */
export class SourceNumber {
  constructor(readonly token: string) {}
}
const sourceKeyOrder = new WeakMap<object, string[]>();
export type SourceValue =
  | null
  | boolean
  | string
  | SourceNumber
  | SourceValue[]
  | { [key: string]: SourceValue };

/** Parse source JSON without losing decimal tokens or duplicate object members. */
export function parseSourceJson(text: string): SourceValue {
  let position = 0;
  const whitespace = () => {
    while (/[\t\n\r ]/.test(text[position] ?? "\0")) position++;
  };
  const fail = (): never => {
    throw new Error(`Invalid source JSON at position ${position}.`);
  };
  function string(): string {
    const start = position++;
    while (position < text.length) {
      if (text[position] === "\\") {
        position += 2;
        continue;
      }
      if (text[position++] === '"')
        return JSON.parse(text.slice(start, position));
    }
    return fail();
  }
  function value(depth: number): SourceValue {
    if (depth > 128) throw new Error("Source JSON exceeds 128 nested values.");
    whitespace();
    const char = text[position];
    if (char === '"') return string();
    if (char === "{") {
      position++;
      const object: Record<string, SourceValue> = Object.create(null);
      const keys: string[] = [];
      sourceKeyOrder.set(object, keys);
      whitespace();
      if (text[position] === "}") {
        position++;
        return object;
      }
      while (true) {
        whitespace();
        if (text[position] !== '"') return fail();
        const key = string();
        if (Object.hasOwn(object, key))
          throw new Error(`Duplicate source key: ${key}`);
        keys.push(key);
        whitespace();
        if (text[position++] !== ":") return fail();
        object[key] = value(depth + 1);
        whitespace();
        const separator = text[position++];
        if (separator === "}") return object;
        if (separator !== ",") return fail();
      }
    }
    if (char === "[") {
      position++;
      const array: SourceValue[] = [];
      whitespace();
      if (text[position] === "]") {
        position++;
        return array;
      }
      while (true) {
        array.push(value(depth + 1));
        whitespace();
        const separator = text[position++];
        if (separator === "]") return array;
        if (separator !== ",") return fail();
      }
    }
    for (const [literal, result] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(literal, position)) {
        position += literal.length;
        return result;
      }
    }
    const token = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      text.slice(position),
    )?.[0];
    if (token === undefined) return fail();
    position += token.length;
    return new SourceNumber(token);
  }
  const result = value(0);
  whitespace();
  if (position !== text.length) return fail();
  return result;
}

export function encodeOriginal(value: SourceValue): unknown {
  if (value instanceof SourceNumber) return { $source_number: value.token };
  if (Array.isArray(value)) return value.map(encodeOriginal);
  if (value !== null && typeof value === "object") {
    const keys = sourceKeyOrder.get(value) ?? Object.keys(value);
    const pairs = keys.map((key) => [key, encodeOriginal(value[key])]);
    if (
      Object.hasOwn(value, "$source_number") ||
      Object.hasOwn(value, "$source_object")
    )
      return { $source_object: pairs };
    return Object.fromEntries(pairs);
  }
  return value;
}

export function sourceObject(value: SourceValue): Record<string, SourceValue> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof SourceNumber
  ) {
    throw new Error("The source value must be an object.");
  }
  return value;
}

export function sourceInteger(value: SourceValue | undefined): number {
  if (!(value instanceof SourceNumber) || !/^[1-9][0-9]*$/.test(value.token))
    throw new Error("The source ID must be a positive integer token.");
  const result = Number(value.token);
  if (!Number.isSafeInteger(result))
    throw new Error("The source ID exceeds the safe integer range.");
  return result;
}
