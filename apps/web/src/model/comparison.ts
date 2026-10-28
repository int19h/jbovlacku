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
  let start = 0;
  while (start < a.length && start < b.length && sameValue(a[start], b[start]))
    start++;
  let endA = a.length,
    endB = b.length;
  while (endA > start && endB > start && sameValue(a[endA - 1], b[endB - 1])) {
    endA--;
    endB--;
  }
  a = a.slice(start, endA);
  b = b.slice(start, endB);
  let anchors: [number, number][] = [];
  // Myers alignment handles distant sparse edits in long lists. Bound both
  // edit distance and equality checks before the fallback compares in order.
  if (a.length * b.length > 40_000) {
    anchors = sparseAnchors(a, b) ?? [];
    if (!anchors.length) {
      const result: [T | undefined, T | undefined][] = [];
      for (let i = 0; i < Math.max(a.length, b.length); i++)
        if (!sameValue(a[i], b[i])) result.push([a[i], b[i]]);
      return result;
    }
  } else {
    align(a, b, 0, 0);
  }
  function lengths(left: T[], right: T[]) {
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
  }
  function align(left: T[], right: T[], ai: number, bi: number) {
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
  }
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

/** Return matching positions when the shortest edit path fits the budget. */
function sparseAnchors<T>(a: T[], b: T[]): [number, number][] | null {
  const frontier = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  let checks = 0;
  const predecessor = (row: Map<number, number>, d: number, k: number) =>
    k === -d || (k !== d && row.get(k - 1)! < row.get(k + 1)!) ? k + 1 : k - 1;
  for (let distance = 0; distance <= 64; distance++) {
    trace.push(new Map(frontier));
    for (let k = -distance; k <= distance; k += 2) {
      const previous = predecessor(frontier, distance, k);
      let x = frontier.get(previous)! + (previous === k - 1 ? 1 : 0);
      let y = x - k;
      while (x < a.length && y < b.length) {
        if (++checks > 40_000) return null;
        if (!sameValue(a[x], b[y])) break;
        x++;
        y++;
      }
      frontier.set(k, x);
      if (x < a.length || y < b.length) continue;
      const anchors: [number, number][] = [];
      for (let d = distance; d >= 0; d--) {
        const row = trace[d];
        const previous = predecessor(row, d, x - y);
        const previousX = row.get(previous)!;
        const previousY = previousX - previous;
        while (x > previousX && y > previousY) anchors.push([--x, --y]);
        x = previousX;
        y = previousY;
      }
      return anchors.reverse();
    }
  }
  return null;
}
