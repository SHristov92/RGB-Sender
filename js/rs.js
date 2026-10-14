// Reed–Solomon over GF(2^8).
// Field: primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D), alpha = 2.
// Code: systematic, generator g(x) = prod_{i=0}^{nsym-1} (x - alpha^i)  (fcr = 0).
// Byte arrays are high-degree-first: data[0] is the first byte sent.

const PRIM = 0x11d;
export const EXP = new Uint8Array(512);
export const LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= PRIM;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

export function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

export function gfDiv(a, b) {
  if (b === 0) throw new Error('GF division by zero');
  return a === 0 ? 0 : EXP[(LOG[a] + 255 - LOG[b]) % 255];
}

// alpha^p for any integer p (negative allowed).
function alphaPow(p) {
  return EXP[((p % 255) + 255) % 255];
}

const generatorCache = new Map();

export function generator(nsym) {
  let g = generatorCache.get(nsym);
  if (g) return g;
  let poly = [1];
  for (let i = 0; i < nsym; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  g = Uint8Array.from(poly);
  generatorCache.set(nsym, g);
  return g;
}

// Returns data followed by nsym parity bytes.
export function rsEncode(data, nsym) {
  if (data.length + nsym > 255) throw new Error('RS codeword longer than 255 bytes');
  const out = new Uint8Array(data.length + nsym);
  out.set(data);
  if (nsym === 0) return out;
  const g = generator(nsym);
  for (let i = 0; i < data.length; i++) {
    const coef = out[i];
    if (coef === 0) continue;
    for (let j = 1; j < g.length; j++) out[i + j] ^= gfMul(g[j], coef);
  }
  out.set(data);
  return out;
}

function syndromes(r, nsym) {
  const s = new Uint8Array(nsym);
  for (let i = 0; i < nsym; i++) {
    const a = EXP[i];
    let acc = 0;
    for (let j = 0; j < r.length; j++) acc = gfMul(acc, a) ^ r[j];
    s[i] = acc;
  }
  return s;
}

// Errors-only decoding (Berlekamp–Massey, Chien search, Forney).
// Returns { data, corrected } or null when the codeword is uncorrectable.
export function rsDecode(codeword, nsym) {
  const n = codeword.length;
  const r = Uint8Array.from(codeword);
  if (nsym === 0) return { data: r, corrected: 0 };

  const S = syndromes(r, nsym);
  if (S.every((v) => v === 0)) return { data: r.slice(0, n - nsym), corrected: 0 };

  // Berlekamp–Massey; polynomials here are low-degree-first.
  let C = [1];
  let B = [1];
  let L = 0;
  let m = 1;
  let b = 1;
  for (let k = 0; k < nsym; k++) {
    let d = S[k];
    for (let i = 1; i <= L; i++) d ^= gfMul(C[i] || 0, S[k - i]);
    if (d === 0) {
      m++;
      continue;
    }
    const coef = gfDiv(d, b);
    const prevC = C.slice();
    while (C.length < B.length + m) C.push(0);
    for (let i = 0; i < B.length; i++) C[i + m] ^= gfMul(coef, B[i]);
    if (2 * L <= k) {
      L = k + 1 - L;
      B = prevC;
      b = d;
      m = 1;
    } else {
      m++;
    }
  }
  if (2 * L > nsym) return null;

  // Chien search over the (possibly shortened) codeword positions.
  const positions = [];
  for (let j = 0; j < n; j++) {
    const xInv = alphaPow(-(n - 1 - j));
    let v = 0;
    for (let i = C.length - 1; i >= 0; i--) v = gfMul(v, xInv) ^ C[i];
    if (v === 0) positions.push(j);
  }
  if (positions.length !== L) return null;

  // Error evaluator Omega(x) = S(x) * Lambda(x) mod x^nsym.
  const omega = new Array(nsym).fill(0);
  for (let i = 0; i < nsym; i++) {
    for (let j = 0; j < C.length && i + j < nsym; j++) omega[i + j] ^= gfMul(S[i], C[j]);
  }

  // Forney (fcr = 0): e = X * Omega(X^-1) / Lambda'(X^-1).
  for (const j of positions) {
    const p = n - 1 - j;
    const xInv = alphaPow(-p);
    let om = 0;
    for (let i = nsym - 1; i >= 0; i--) om = gfMul(om, xInv) ^ omega[i];
    let dl = 0;
    for (let i = 1; i < C.length; i += 2) dl ^= gfMul(C[i], alphaPow(-p * (i - 1)));
    if (dl === 0) return null;
    r[j] ^= gfMul(alphaPow(p), gfDiv(om, dl));
  }

  if (!syndromes(r, nsym).every((v) => v === 0)) return null;
  return { data: r.slice(0, n - nsym), corrected: positions.length };
}
