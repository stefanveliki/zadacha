/**
 * Tests for sss.ts — Shamir's Secret Sharing over GF(2^8).
 */

import { describe, it, expect } from 'vitest';
import { splitSecret, combineShards } from '../sss.js';
import { generateKeypair, bytesToHex } from '../crypto.js';
import type { ShamirShard } from '../types.js';

// Fixed random bytes for deterministic tests
function fixedRandom(seed: number, length: number): Uint8Array {
  const buf = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    buf[i] = (seed * 37 + i * 13) & 0xff;
  }
  return buf;
}

describe('splitSecret / combineShards', () => {
  it('round-trips a 32-byte secret with 2-of-3', () => {
    const secret = new Uint8Array(32).fill(0xab);
    const random = fixedRandom(1, 32); // (threshold-1) * 32 = 1 * 32
    const shards = splitSecret(secret, 2, 3, random);

    expect(shards).toHaveLength(3);
    shards.forEach((s, i) => {
      expect(s.index).toBe(i + 1);
      expect(s.data).toHaveLength(32);
    });

    // All 3 shards
    expect(bytesToHex(combineShards(shards))).toBe(bytesToHex(secret));
  });

  it('reconstructs with any 2 of 3 shards', () => {
    const secret = new Uint8Array(32);
    globalThis.crypto.getRandomValues(secret);
    const random = fixedRandom(42, 32);
    const shards = splitSecret(secret, 2, 3, random);

    const pairs: [ShamirShard, ShamirShard][] = [
      [shards[0]!, shards[1]!],
      [shards[0]!, shards[2]!],
      [shards[1]!, shards[2]!],
    ];

    for (const pair of pairs) {
      const reconstructed = combineShards(pair);
      expect(bytesToHex(reconstructed)).toBe(bytesToHex(secret));
    }
  });

  it('1 shard is NOT sufficient to reconstruct', () => {
    const secret = new Uint8Array(32).fill(0x55);
    const random = fixedRandom(7, 32);
    const shards = splitSecret(secret, 2, 3, random);

    // 1 shard should throw
    expect(() => combineShards([shards[0]!])).toThrow();
  });

  it('works with a real secp256k1 private key', async () => {
    const { privateKey, publicKey } = generateKeypair();
    const random = fixedRandom(99, 32);
    const shards = splitSecret(privateKey, 2, 3, random);

    const reconstructed = combineShards([shards[0]!, shards[2]!]);
    expect(bytesToHex(reconstructed)).toBe(bytesToHex(privateKey));

    // Double-check the reconstructed key derives the same public key
    const { derivePublicKey } = await import('../crypto.js');
    expect(derivePublicKey(reconstructed)).toBe(publicKey);
  });

  it('different random bytes produce different shards for the same secret', () => {
    const secret = new Uint8Array(32).fill(0x11);
    const shardsA = splitSecret(secret, 2, 3, fixedRandom(1, 32));
    const shardsB = splitSecret(secret, 2, 3, fixedRandom(2, 32));
    // Shards differ
    expect(bytesToHex(shardsA[0]!.data)).not.toBe(bytesToHex(shardsB[0]!.data));
    // Both reconstruct to the same secret
    expect(bytesToHex(combineShards([shardsA[0]!, shardsA[1]!]))).toBe(bytesToHex(secret));
    expect(bytesToHex(combineShards([shardsB[0]!, shardsB[1]!]))).toBe(bytesToHex(secret));
  });

  it('rejects secrets that are not 32 bytes', () => {
    const random = fixedRandom(1, 32);
    expect(() => splitSecret(new Uint8Array(16), 2, 3, random)).toThrow('32 bytes');
    expect(() => splitSecret(new Uint8Array(33), 2, 3, random)).toThrow('32 bytes');
  });

  it('rejects threshold < 2', () => {
    const secret = new Uint8Array(32);
    expect(() => splitSecret(secret, 1, 3, fixedRandom(1, 32))).toThrow('threshold');
  });

  it('rejects n < threshold', () => {
    const secret = new Uint8Array(32);
    expect(() => splitSecret(secret, 3, 2, fixedRandom(1, 64))).toThrow();
  });

  it('rejects duplicate shard indices in combineShards', () => {
    const secret = new Uint8Array(32).fill(0x77);
    const shards = splitSecret(secret, 2, 3, fixedRandom(5, 32));
    // Duplicate shard 1
    expect(() => combineShards([shards[0]!, shards[0]!])).toThrow('Duplicate');
  });
});
