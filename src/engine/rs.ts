/**
 * Reed-Solomon over GF(2^8), systematic, with Berlekamp-Massey + Chien +
 * Forney decoding. Corrects up to floor(parity/2) corrupted bytes per block at
 * unknown positions.
 *
 * Sized for the 5% budget: RS(255, 243) spends 12 parity bytes per 243 data
 * bytes = 4.94% overhead and repairs any 6 bad bytes in a 255-byte block.
 *
 * Field: GF(256), primitive polynomial 0x11d, generator 2.
 *
 * Conventions, since mixing them is the classic way to get a decoder that
 * almost works:
 *   - A block is `data || parity`, and as a polynomial its FIRST byte is the
 *     highest-degree term: C(x) = c[0]x^(n-1) + ... + c[n-1].
 *   - Syndromes are S_i = C(a^i) for i in [0, nsym).
 *   - An error at block index p has locator X = a^(n-1-p).
 *   - Decoder polynomials (lambda, omega) are little-endian: p[i] is the
 *     coefficient of x^i.
 */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a: number, b: number): number =>
  a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];

const div = (a: number, b: number): number => {
  if (b === 0) throw new Error('rs: divide by zero');
  return a === 0 ? 0 : EXP[LOG[a] + 255 - LOG[b]];
};

/** a^(-i), for any non-negative i. */
const expNeg = (i: number): number => EXP[(255 - (i % 255)) % 255];

/** Evaluate a little-endian polynomial at x. */
function evalLE(p: ArrayLike<number>, x: number): number {
  let y = 0;
  for (let i = p.length - 1; i >= 0; i--) y = mul(y, x) ^ p[i];
  return y;
}

/** Convolution; works for either endianness so long as inputs agree. */
function polyMul(a: ArrayLike<number>, b: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(a.length + b.length - 1);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === 0) continue;
    const la = LOG[a[i]];
    for (let j = 0; j < b.length; j++) {
      if (b[j] !== 0) out[i + j] ^= EXP[la + LOG[b[j]]];
    }
  }
  return out;
}

/** Generator polynomial prod(x - a^i), i in [0, nsym), highest degree first. */
function generator(nsym: number): Uint8Array {
  let g: ArrayLike<number> = new Uint8Array([1]);
  for (let i = 0; i < nsym; i++) g = polyMul(g, new Uint8Array([1, EXP[i]]));
  return g as Uint8Array;
}

const GEN_CACHE = new Map<number, Uint8Array>();
function gen(nsym: number): Uint8Array {
  let g = GEN_CACHE.get(nsym);
  if (!g) { g = generator(nsym); GEN_CACHE.set(nsym, g); }
  return g;
}

/** Compute `nsym` parity bytes for one data block (synthetic division). */
export function rsEncode(data: Uint8Array, nsym: number): Uint8Array {
  const g = gen(nsym);
  const parity = new Uint8Array(nsym);

  for (let i = 0; i < data.length; i++) {
    const coef = data[i] ^ parity[0];
    parity.copyWithin(0, 1);
    parity[nsym - 1] = 0;
    if (coef !== 0) {
      const lc = LOG[coef];
      for (let j = 1; j < g.length; j++) {
        if (g[j] !== 0) parity[j - 1] ^= EXP[lc + LOG[g[j]]];
      }
    }
  }
  return parity;
}

/** S_i = C(a^i). Block is big-endian as a polynomial. */
function syndromes(block: Uint8Array, nsym: number): Uint8Array {
  const s = new Uint8Array(nsym);
  for (let i = 0; i < nsym; i++) {
    const x = EXP[i];
    let y = block[0];
    for (let k = 1; k < block.length; k++) y = mul(y, x) ^ block[k];
    s[i] = y;
  }
  return s;
}

/** Berlekamp-Massey. Returns lambda, little-endian, lambda[0] === 1. */
function berlekampMassey(S: Uint8Array, nsym: number): number[] {
  let lambda = [1];
  let B = [1];
  let L = 0;
  let m = 1;
  let b = 1;

  for (let n = 0; n < nsym; n++) {
    let d = S[n];
    for (let i = 1; i <= L; i++) d ^= mul(lambda[i], S[n - i]);

    if (d === 0) {
      m++;
    } else if (2 * L <= n) {
      const T = [...lambda];
      const scale = div(d, b);
      while (lambda.length < m + B.length) lambda.push(0);
      for (let j = 0; j < B.length; j++) lambda[m + j] ^= mul(scale, B[j]);
      L = n + 1 - L;
      B = T;
      b = d;
      m = 1;
    } else {
      const scale = div(d, b);
      while (lambda.length < m + B.length) lambda.push(0);
      for (let j = 0; j < B.length; j++) lambda[m + j] ^= mul(scale, B[j]);
      m++;
    }
  }

  while (lambda.length > 1 && lambda[lambda.length - 1] === 0) lambda.pop();
  return lambda;
}

export class RsUncorrectableError extends Error {
  constructor(message = 'rs: too many errors to correct') {
    super(message);
    this.name = 'RsUncorrectableError';
  }
}

/**
 * Verify and repair one `data || parity` block in place.
 * Returns the number of bytes corrected. Throws if beyond the code's reach.
 */
export function rsDecodeBlock(block: Uint8Array, nsym: number): number {
  const n = block.length;
  const S = syndromes(block, nsym);
  if (S.every((v) => v === 0)) return 0;

  const lambda = berlekampMassey(S, nsym);
  const nerr = lambda.length - 1;
  if (nerr <= 0 || nerr > nsym >> 1) throw new RsUncorrectableError();

  // Chien search: lambda(a^-i) == 0 means an error at block index n-1-i.
  const positions: number[] = [];
  const locatorExp: number[] = [];
  for (let i = 0; i < n; i++) {
    if (evalLE(lambda, expNeg(i)) === 0) {
      positions.push(n - 1 - i);
      locatorExp.push(i);
    }
  }
  if (positions.length !== nerr) throw new RsUncorrectableError();

  // omega(x) = S(x) * lambda(x) mod x^nsym, both little-endian.
  const omega = polyMul(S, Uint8Array.from(lambda)).subarray(0, nsym);

  // lambda'(x): over GF(2) only odd-degree terms survive differentiation.
  const dLen = Math.max(0, lambda.length - 1);
  const lambdaPrime = new Uint8Array(dLen);
  for (let j = 1; j < lambda.length; j++) {
    if (j % 2 === 1) lambdaPrime[j - 1] = lambda[j];
  }

  // Forney: Y = X * omega(X^-1) / lambda'(X^-1), with first root a^0.
  for (let k = 0; k < positions.length; k++) {
    const i = locatorExp[k];
    const X = EXP[i % 255];
    const Xinv = expNeg(i);

    const num = evalLE(omega, Xinv);
    const den = evalLE(lambdaPrime, Xinv);
    if (den === 0) throw new RsUncorrectableError();

    block[positions[k]] ^= mul(X, div(num, den));
  }

  // Re-derive the syndromes. A decoder can converge on a valid but wrong
  // codeword when corruption exceeds the correction radius; this catches it.
  if (syndromes(block, nsym).some((v) => v !== 0)) throw new RsUncorrectableError();

  return positions.length;
}
