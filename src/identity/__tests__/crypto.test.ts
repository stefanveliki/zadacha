/**
 * Tests for crypto.ts — key generation, event id derivation, signing, verification.
 */

import { describe, it, expect } from 'vitest';
import {
  generateKeypair,
  derivePublicKey,
  computeEventId,
  signEventId,
  verifySignature,
  verifyEnvelope,
  bytesToHex,
  hexToBytes,
} from '../crypto.js';
import { EventKind } from '../types.js';
import type { EventEnvelope } from '../types.js';

describe('generateKeypair', () => {
  it('produces a 32-byte private key and a 64-char hex public key', () => {
    const kp = generateKeypair();
    expect(kp.privateKey).toBeInstanceOf(Uint8Array);
    expect(kp.privateKey.byteLength).toBe(32);
    expect(typeof kp.publicKey).toBe('string');
    expect(kp.publicKey).toHaveLength(64); // 32 bytes x-only hex
    expect(kp.publicKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different keypairs each call', () => {
    const a = generateKeypair();
    const b = generateKeypair();
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(bytesToHex(a.privateKey)).not.toBe(bytesToHex(b.privateKey));
  });
});

describe('derivePublicKey', () => {
  it('derives the same pubkey that generateKeypair returns', () => {
    const kp = generateKeypair();
    const derived = derivePublicKey(kp.privateKey);
    expect(derived).toBe(kp.publicKey);
  });
});

describe('computeEventId', () => {
  it('returns a 64-char hex string', () => {
    const id = computeEventId('aabbcc', 1_700_000_000, EventKind.TRIP_ANNOUNCE, '{}');
    expect(id).toHaveLength(64);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same inputs produce same id', () => {
    const id1 = computeEventId('aabbcc', 1_700_000_000, 1, '{"x":1}');
    const id2 = computeEventId('aabbcc', 1_700_000_000, 1, '{"x":1}');
    expect(id1).toBe(id2);
  });

  it('changes if any input changes', () => {
    const base = computeEventId('aabbcc', 1_700_000_000, 1, '{}');
    expect(computeEventId('aabbdd', 1_700_000_000, 1, '{}')).not.toBe(base);
    expect(computeEventId('aabbcc', 1_700_000_001, 1, '{}')).not.toBe(base);
    expect(computeEventId('aabbcc', 1_700_000_000, 2, '{}')).not.toBe(base);
    expect(computeEventId('aabbcc', 1_700_000_000, 1, '{"a":1}')).not.toBe(base);
  });

  it('matches the canonical serialisation [0, pubkey, created_at, kind, content]', () => {
    // Manually compute expected SHA-256 to validate the serialisation
    import('@noble/hashes/sha2.js').then(({ sha256 }) => {
      import('@noble/hashes/utils.js').then(({ utf8ToBytes, bytesToHex: bth }) => {
        const pubkey     = 'deadbeef';
        const created_at = 1_000_000;
        const kind       = 1;
        const content    = '{"foo":"bar"}';
        const canonical  = JSON.stringify([0, pubkey, created_at, kind, content]);
        const expected   = bth(sha256(utf8ToBytes(canonical)));
        const actual     = computeEventId(pubkey, created_at, kind, content);
        expect(actual).toBe(expected);
      });
    });
  });
});

describe('signEventId / verifySignature', () => {
  it('produces a valid Schnorr signature that verifies', () => {
    const kp  = generateKeypair();
    const id  = computeEventId(kp.publicKey, 1_700_000_000, 1, '{}');
    const sig = signEventId(id, kp.privateKey);

    expect(sig).toHaveLength(128); // 64 bytes hex
    expect(verifySignature(id, sig, kp.publicKey)).toBe(true);
  });

  it('fails verification with a different pubkey', () => {
    const kp   = generateKeypair();
    const kp2  = generateKeypair();
    const id   = computeEventId(kp.publicKey, 1_700_000_000, 1, '{}');
    const sig  = signEventId(id, kp.privateKey);
    expect(verifySignature(id, sig, kp2.publicKey)).toBe(false);
  });

  it('fails verification if the event id is tampered', () => {
    const kp  = generateKeypair();
    const id  = computeEventId(kp.publicKey, 1_700_000_000, 1, '{}');
    const sig = signEventId(id, kp.privateKey);
    // Flip the last character of the id
    const tampered = id.slice(0, -1) + (id.endsWith('0') ? '1' : '0');
    expect(verifySignature(tampered, sig, kp.publicKey)).toBe(false);
  });

  it('returns false on malformed hex rather than throwing', () => {
    expect(verifySignature('not-hex', 'not-hex', 'not-hex')).toBe(false);
  });
});

describe('verifyEnvelope', () => {
  function buildValidEnvelope(): EventEnvelope {
    const kp         = generateKeypair();
    const created_at = Math.floor(Date.now() / 1000);
    const kind       = EventKind.NEED_SUBMIT;
    const content    = JSON.stringify({ what: 'milk' });
    const id         = computeEventId(kp.publicKey, created_at, kind, content);
    const sig        = signEventId(id, kp.privateKey);
    return { id, kind, pubkey: kp.publicKey, created_at, content, sig };
  }

  it('returns true for a validly constructed envelope', () => {
    const env = buildValidEnvelope();
    expect(verifyEnvelope(env)).toBe(true);
  });

  it('returns false if id does not match recomputed id', () => {
    const env = buildValidEnvelope();
    expect(verifyEnvelope({ ...env, id: 'a'.repeat(64) })).toBe(false);
  });

  it('returns false if sig is invalid', () => {
    const env = buildValidEnvelope();
    const badSig = '0'.repeat(128);
    expect(verifyEnvelope({ ...env, sig: badSig })).toBe(false);
  });

  it('returns false if content is tampered after signing', () => {
    const env = buildValidEnvelope();
    expect(verifyEnvelope({ ...env, content: '{"tampered":true}' })).toBe(false);
  });
});
