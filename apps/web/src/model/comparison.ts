/** Compare interpreted values without depending on object key order. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => sameValue(value, b[index]))
    );
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.keys(left).every(
      (key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]),
    )
  );
}

/** Align unchanged items by sequence. Keep working memory linear in list length. */
export function changedItems<T>(
  a: T[],
  b: T[],
): [T | undefined, T | undefined][] {
  const lengths = (left: T[], right: T[]) => {
    let row = new Uint32Array(right.length + 1);
    for (const value of left) {
      const next = new Uint32Array(right.length + 1);
      for (let j = 0; j < right.length; j++)
        next[j + 1] = sameValue(value, right[j])
          ? row[j] + 1
          : Math.max(row[j + 1], next[j]);
      row = next;
    }
    return row;
  };
  const anchors: [number, number][] = [];
  const align = (left: T[], right: T[], ai: number, bi: number) => {
    if (!left.length || !right.length) return;
    if (left.length === 1) {
      const index = right.findIndex((value) => sameValue(left[0], value));
      if (index >= 0) anchors.push([ai, bi + index]);
      return;
    }
    const middle = Math.floor(left.length / 2);
    const forward = lengths(left.slice(0, middle), right);
    const backward = lengths(
      left.slice(middle).reverse(),
      [...right].reverse(),
    );
    let split = 0;
    for (let j = 1; j <= right.length; j++)
      if (
        forward[j] + backward[right.length - j] >
        forward[split] + backward[right.length - split]
      )
        split = j;
    align(left.slice(0, middle), right.slice(0, split), ai, bi);
    align(left.slice(middle), right.slice(split), ai + middle, bi + split);
  };
  align(a, b, 0, 0);
  anchors.push([a.length, b.length]);
  const result: [T | undefined, T | undefined][] = [];
  let ai = 0,
    bi = 0;
  for (const [nextA, nextB] of anchors) {
    while (ai < nextA || bi < nextB)
      result.push([
        ai < nextA ? a[ai++] : undefined,
        bi < nextB ? b[bi++] : undefined,
      ]);
    ai = nextA + 1;
    bi = nextB + 1;
  }
  return result;
}
