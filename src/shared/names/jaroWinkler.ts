/** Jaro-Winkler similarity (prefix scale 0.1, prefix up to 4) over Unicode code points, and best token-set alignment. */

export function jaro(a: string, b: string): number {
  if (a === b) return 1;
  const s1 = Array.from(a);
  const s2 = Array.from(b);
  const n1 = s1.length;
  const n2 = s2.length;
  if (n1 === 0 || n2 === 0) return 0;
  const window = Math.max(0, Math.floor(Math.max(n1, n2) / 2) - 1);
  const m1 = new Array<boolean>(n1).fill(false);
  const m2 = new Array<boolean>(n2).fill(false);
  let matches = 0;
  for (let i = 0; i < n1; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(n2 - 1, i + window);
    for (let j = lo; j <= hi; j++) {
      if (m2[j] || s1[i] !== s2[j]) continue;
      m1[i] = true;
      m2[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < n1; i++) {
    if (!m1[i]) continue;
    while (!m2[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  const t = transpositions / 2;
  return (matches / n1 + matches / n2 + (matches - t) / matches) / 3;
}

export function jaroWinkler(a: string, b: string): number {
  const j = jaro(a, b);
  const s1 = Array.from(a);
  const s2 = Array.from(b);
  let prefix = 0;
  const max = Math.min(4, s1.length, s2.length);
  while (prefix < max && s1[prefix] === s2[prefix]) prefix++;
  return j + prefix * 0.1 * (1 - j);
}

const DP_LIMIT = 10;

/**
 * Best one-to-one alignment of two token multisets maximising the summed Jaro-Winkler score, normalised by the larger
 * set size (unmatched tokens score 0). Order of tokens is irrelevant. Exact (bitmask DP) up to 10 tokens on the larger
 * side, greedy beyond. Both empty => 1; one empty => 0.
 */
export function tokenSetJaroWinkler(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const [small, large] = a.length <= b.length ? [a, b] : [b, a];
  const sim = small.map((x) => large.map((y) => jaroWinkler(x, y)));
  const n = small.length;
  const m = large.length;
  let best: number;
  if (m <= DP_LIMIT) {
    // dp[mask] = best score after assigning the first popcount(mask) small tokens to the large tokens in mask.
    const size = 1 << m;
    const dp = new Float64Array(size).fill(-1);
    dp[0] = 0;
    best = 0;
    for (let mask = 0; mask < size; mask++) {
      const cur = dp[mask] ?? -1;
      if (cur < 0) continue;
      const i = popcount(mask);
      if (i === n) {
        if (cur > best) best = cur;
        continue;
      }
      const row = sim[i] ?? [];
      for (let j = 0; j < m; j++) {
        if (mask & (1 << j)) continue;
        const nm = mask | (1 << j);
        const v = cur + (row[j] ?? 0);
        if (v > (dp[nm] ?? -1)) dp[nm] = v;
      }
    }
  } else {
    const pairs: [number, number, number][] = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) pairs.push([sim[i]?.[j] ?? 0, i, j]);
    pairs.sort((x, y) => y[0] - x[0]);
    const usedI = new Set<number>();
    const usedJ = new Set<number>();
    best = 0;
    for (const [s, i, j] of pairs) {
      if (usedI.has(i) || usedJ.has(j)) continue;
      usedI.add(i);
      usedJ.add(j);
      best += s;
    }
  }
  return best / m;
}

function popcount(x: number): number {
  let c = 0;
  let v = x;
  while (v) {
    v &= v - 1;
    c++;
  }
  return c;
}
