/**
 * Rural Run Protocol — Shamir's Secret Sharing
 *
 * 2-of-3 threshold secret splitting over GF(2^8).
 *
 * The private key (32 bytes) is treated as 32 independent secrets, one per byte.
 * Each byte is split with a degree-(threshold-1) polynomial over GF(2^8):
 *
 *   f(x) = secret + a1*x  (for threshold=2, one random coefficient)
 *
 * Share i = (i, f(i)) for i = 1..n.
 * Reconstruction uses Lagrange interpolation over GF(2^8).
 *
 * GF(2^8) uses the AES irreducible polynomial: x^8 + x^4 + x^3 + x + 1 (0x11B).
 *
 * All functions are pure — no I/O, no side effects.
 * Random bytes come from the caller so this module is fully testable.
 */

import type { ShamirShard } from './types.js';

// ---------------------------------------------------------------------------
// GF(2^8) arithmetic
// ---------------------------------------------------------------------------

const GF_POLY = 0x11b; // x^8 + x^4 + x^3 + x + 1

/** GF(2^8) addition is XOR. */
function gfAdd(a: number, b: number): number {
  return a ^ b;
}

/** GF(2^8) multiplication using the Russian peasant algorithm. */
function gfMul(a: number, b: number): number {
  let p = 0;
  let hi: number;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    hi = a & 0x80;
    a = (a << 1) & 0xff;
    if (hi) a ^= (GF_POLY & 0xff); // reduce modulo the polynomial
    b >>= 1;
  }
  return p & 0xff;
}

/** GF(2^8) multiplicative inverse using extended Euclidean algorithm. */
function gfInv(a: number): number {
  if (a === 0) throw new RangeError('GF inverse of zero is undefined');
  // Brute-force lookup is acceptable for a 256-element field used only at key recovery time.
  // Could precompute a table, but this is simpler and not on the hot path.
  for (let i = 1; i < 256; i++) {
    if (gfMul(a, i) === 1) return i;
  }
  throw new Error('GF inverse not found — this should never happen');
}

/** GF(2^8) division. */
function gfDiv(a: number, b: number): number {
  return gfMul(a, gfInv(b));
}

// ---------------------------------------------------------------------------
// Polynomial evaluation over GF(2^8)
// ---------------------------------------------------------------------------

/**
 * Evaluate polynomial f(x) = coeffs[0] + coeffs[1]*x + coeffs[2]*x^2 + ...
 * at point x, entirely in GF(2^8).
 */
function polyEval(coeffs: number[], x: number): number {
  let result = 0;
  let xPow = 1; // x^0 = 1
  for (const coeff of coeffs) {
    result = gfAdd(result, gfMul(coeff, xPow));
    xPow = gfMul(xPow, x);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Split and combine — per-byte
// ---------------------------------------------------------------------------

/**
 * Split a single byte into `n` shares with `threshold` minimum.
 * Returns share values at x = 1, 2, ..., n.
 *
 * randomCoeffs must have (threshold - 1) bytes — one coefficient per random term.
 */
function splitByte(
  secret: number,
  threshold: number,
  n: number,
  randomCoeffs: number[],
): number[] {
  if (randomCoeffs.length !== threshold - 1) {
    throw new RangeError('randomCoeffs length must equal threshold - 1');
  }
  // Polynomial: f(x) = secret + r1*x + r2*x^2 + ...
  const coeffs = [secret, ...randomCoeffs];
  const shares: number[] = [];
  for (let i = 1; i <= n; i++) {
    shares.push(polyEval(coeffs, i));
  }
  return shares;
}

/**
 * Lagrange interpolation over GF(2^8).
 * Reconstructs f(0) from a set of (x, y) points — any `threshold` of them.
 */
function lagrangeAtZero(points: Array<{ x: number; y: number }>): number {
  let result = 0;
  const k = points.length;
  for (let i = 0; i < k; i++) {
    const { x: xi, y: yi } = points[i]!;
    let num = 1;
    let den = 1;
    for (let j = 0; j < k; j++) {
      if (i === j) continue;
      const xj = points[j]!.x;
      // numerator: product of (0 - xj) = xj  (in GF, 0 - x = x since -1 = 1)
      num = gfMul(num, xj);
      // denominator: product of (xi - xj) = xi XOR xj
      den = gfMul(den, gfAdd(xi, xj));
    }
    result = gfAdd(result, gfMul(yi, gfDiv(num, den)));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Split a 32-byte secret (private key) into `n` shards with `threshold` minimum.
 *
 * @param secret     32-byte Uint8Array (private key)
 * @param threshold  minimum shards required to reconstruct (default: 2)
 * @param n          total number of shards to produce (default: 3)
 * @param random     (threshold-1)*32 random bytes — injected for testability.
 *                   In production, pass crypto.getRandomValues(new Uint8Array(...)).
 * @returns          array of n ShamirShards, index 1..n
 */
export function splitSecret(
  secret: Uint8Array,
  threshold: number,
  n: number,
  random: Uint8Array,
): ShamirShard[] {
  if (secret.length !== 32) throw new RangeError('secret must be 32 bytes');
  if (threshold < 2) throw new RangeError('threshold must be at least 2');
  if (n < threshold) throw new RangeError('n must be >= threshold');
  if (n > 255) throw new RangeError('n must be <= 255 (GF(2^8) limit)');

  const numRandomCoeffs = threshold - 1; // per byte
  const requiredRandom = numRandomCoeffs * 32;
  if (random.length < requiredRandom) {
    throw new RangeError(`random must be at least ${requiredRandom} bytes`);
  }

  // Initialise n empty share buffers
  const shareData: Uint8Array[] = Array.from({ length: n }, () => new Uint8Array(32));

  for (let byteIdx = 0; byteIdx < 32; byteIdx++) {
    // Extract the (threshold-1) random coefficients for this byte
    const coeffs: number[] = [];
    for (let c = 0; c < numRandomCoeffs; c++) {
      coeffs.push(random[c * 32 + byteIdx]!);
    }
    const byteShares = splitByte(secret[byteIdx]!, threshold, n, coeffs);
    for (let shareIdx = 0; shareIdx < n; shareIdx++) {
      shareData[shareIdx]![byteIdx] = byteShares[shareIdx]!;
    }
  }

  return shareData.map((data, i) => ({ index: i + 1, data }));
}

/**
 * Reconstruct a 32-byte secret from any `threshold` shards.
 * Does NOT validate the result — the caller must verify the reconstructed
 * key produces the expected public key.
 */
export function combineShards(shards: ShamirShard[]): Uint8Array {
  if (shards.length < 2) throw new RangeError('At least 2 shards required');
  // Validate all shards have correct data length
  for (const shard of shards) {
    if (shard.data.length !== 32) {
      throw new RangeError(`Shard ${shard.index} has wrong data length`);
    }
  }
  // Check for duplicate indices
  const indices = shards.map(s => s.index);
  if (new Set(indices).size !== indices.length) {
    throw new RangeError('Duplicate shard indices');
  }

  const secret = new Uint8Array(32);
  for (let byteIdx = 0; byteIdx < 32; byteIdx++) {
    const points = shards.map(s => ({ x: s.index, y: s.data[byteIdx]! }));
    secret[byteIdx] = lagrangeAtZero(points);
  }
  return secret;
}

/**
 * Convenience: generate the required random bytes for splitSecret.
 * In browser: uses crypto.getRandomValues.
 * In Node.js: uses globalThis.crypto (Node 19+) or the crypto module.
 */
export function generateSplitRandom(threshold: number): Uint8Array {
  const numRandomCoeffs = threshold - 1;
  const buf = new Uint8Array(numRandomCoeffs * 32);
  globalThis.crypto.getRandomValues(buf);
  return buf;
}
