import { describe, it, expect } from 'vitest';
import {
  generatePrivateKey,
  getPublicKey,
  computeEventId,
  signEventId,
  verifyEventSignature,
  buildSignedEvent,
} from '../nostr-crypto.js';

describe('nostr-crypto', () => {
  describe('generatePrivateKey()', () => {
    it('returns a 32-byte Uint8Array', () => {
      const key = generatePrivateKey();
      expect(key).toBeInstanceOf(Uint8Array);
      expect(key.length).toBe(32);
    });

    it('generates unique keys on each call', () => {
      const key1 = generatePrivateKey();
      const key2 = generatePrivateKey();
      expect(key1).not.toEqual(key2);
    });
  });

  describe('getPublicKey()', () => {
    it('returns a 64-character hex string from a private key', () => {
      const privkey = generatePrivateKey();
      const pubkey = getPublicKey(privkey);
      expect(typeof pubkey).toBe('string');
      expect(pubkey).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns the same pubkey for the same privkey', () => {
      const privkey = generatePrivateKey();
      expect(getPublicKey(privkey)).toBe(getPublicKey(privkey));
    });
  });

  describe('computeEventId()', () => {
    it('returns a 64-character hex sha256 hash', () => {
      const id = computeEventId('pubkey', 1700000000, 1, [], 'content');
      expect(typeof id).toBe('string');
      expect(id).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces different ids for different content', () => {
      const id1 = computeEventId('pk', 1000, 1, [], 'content-a');
      const id2 = computeEventId('pk', 1000, 1, [], 'content-b');
      expect(id1).not.toBe(id2);
    });

    it('produces different ids for different kinds', () => {
      const id1 = computeEventId('pk', 1000, 1, [], 'content');
      const id2 = computeEventId('pk', 1000, 2, [], 'content');
      expect(id1).not.toBe(id2);
    });

    it('produces different ids for different tags', () => {
      const id1 = computeEventId('pk', 1000, 1, [], 'content');
      const id2 = computeEventId('pk', 1000, 1, [['t', 'test']], 'content');
      expect(id1).not.toBe(id2);
    });

    it('is deterministic for identical inputs', () => {
      const args = ['pk', 1000, 1, [['t', 'v']], 'content'] as const;
      expect(computeEventId(...args)).toBe(computeEventId(...args));
    });
  });

  describe('signEventId() + verifyEventSignature()', () => {
    it('produces a valid schnorr signature that verifies', () => {
      const privkey = generatePrivateKey();
      const pubkey = getPublicKey(privkey);
      const eventId = computeEventId(pubkey, 1000, 1, [], 'test');

      const sig = signEventId(eventId, privkey);
      expect(typeof sig).toBe('string');
      expect(sig).toMatch(/^[0-9a-f]{128}$/); // 64-byte schnorr sig = 128 hex chars

      const valid = verifyEventSignature({
        id: eventId,
        pubkey,
        created_at: 1000,
        kind: 1,
        tags: [],
        content: 'test',
        sig,
      });
      expect(valid).toBe(true);
    });

    it('rejects a signature with wrong pubkey', () => {
      const privkey1 = generatePrivateKey();
      const privkey2 = generatePrivateKey();
      const pubkey1 = getPublicKey(privkey1);
      const pubkey2 = getPublicKey(privkey2);

      const eventId = computeEventId(pubkey1, 1000, 1, [], 'test');
      const sig = signEventId(eventId, privkey1);

      const valid = verifyEventSignature({
        id: eventId,
        pubkey: pubkey2,
        created_at: 1000,
        kind: 1,
        tags: [],
        content: 'test',
        sig,
      });
      expect(valid).toBe(false);
    });

    it('rejects a tampered event id', () => {
      const privkey = generatePrivateKey();
      const pubkey = getPublicKey(privkey);
      const eventId = computeEventId(pubkey, 1000, 1, [], 'test');
      const sig = signEventId(eventId, privkey);

      const valid = verifyEventSignature({
        id: 'tampered' + eventId.slice(8),
        pubkey,
        created_at: 1000,
        kind: 1,
        tags: [],
        content: 'test',
        sig,
      });
      expect(valid).toBe(false);
    });
  });

  describe('buildSignedEvent()', () => {
    it('returns a complete Nostr event with valid id and sig', () => {
      const privkey = generatePrivateKey();
      const event = buildSignedEvent(privkey, 4333, '{"test": true}', [['t', 'rural-run']]);

      expect(event.kind).toBe(4333);
      expect(event.content).toBe('{"test": true}');
      expect(event.tags).toEqual([['t', 'rural-run']]);
      expect(event.id).toMatch(/^[0-9a-f]{64}$/);
      expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
      expect(event.pubkey).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof event.created_at).toBe('number');

      // Verify the id is correctly computed
      const expectedId = computeEventId(
        event.pubkey,
        event.created_at,
        event.kind,
        event.tags,
        event.content,
      );
      expect(event.id).toBe(expectedId);

      // Verify the signature is valid
      expect(verifyEventSignature(event)).toBe(true);
    });

    it('defaults to empty tags', () => {
      const privkey = generatePrivateKey();
      const event = buildSignedEvent(privkey, 1, 'content');
      expect(event.tags).toEqual([]);
    });
  });
});
