// Channel simulator: turns symbol slots into the colour segments a receiver would see.
export function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

// opts: T (ms), frameMs, errorRate (per-symbol colour substitution), jitter (fraction of T),
// dropRate (chance a symbol is lengthened by one display frame), paletteSize.
export function simulate(slots, opts, rng) {
  const { T = 50, frameMs = 16.7, errorRate = 0, jitter = 0, dropRate = 0, paletteSize = 8 } = opts;
  const seen = Array.from(slots, (c) => {
    if (rng() < errorRate) {
      let other;
      do other = Math.floor(rng() * paletteSize);
      while (other === c);
      return other;
    }
    return c;
  });
  const segments = [];
  let carry = 0;
  for (const c of seen) {
    let d = T + carry + (rng() * 2 - 1) * jitter * T;
    carry = 0;
    if (rng() < dropRate) {
      d += frameMs;
      carry = -frameMs; // the sender's clock catches up on the next symbol
    }
    const last = segments[segments.length - 1];
    if (last && last.color === c) last.duration += d;
    else segments.push({ color: c, duration: d });
  }
  return segments;
}
