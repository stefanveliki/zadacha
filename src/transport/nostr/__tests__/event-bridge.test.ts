import { describe, it, expect } from 'vitest';
import { EventKind } from '../../../shared/types.js';
import { generatePrivateKey, verifyEventSignature } from '../nostr-crypto.js';
import {
  wrapEnvelope,
  unwrapEnvelope,
  buildRuralRunFilter,
  RURAL_RUN_NOSTR_KIND,
  RURAL_RUN_TAG_VALUE,
} from '../event-bridge.js';
import { createTestEnvelope, createWrappedNostrEvent } from './test-helpers.js';

describe('event-bridge', () => {
  const privkey = generatePrivateKey();

  describe('wrapEnvelope()', () => {
    it('wraps an EventEnvelope in a valid Nostr event', () => {
      const envelope = createTestEnvelope();
      const nostrEvent = wrapEnvelope(envelope, privkey);

      expect(nostrEvent.kind).toBe(RURAL_RUN_NOSTR_KIND);
      expect(nostrEvent.id).toMatch(/^[0-9a-f]{64}$/);
      expect(nostrEvent.sig).toMatch(/^[0-9a-f]{128}$/);
      expect(verifyEventSignature(nostrEvent)).toBe(true);
    });

    it('stores the serialized EventEnvelope as content', () => {
      const envelope = createTestEnvelope({ id: 'unique-id-123' });
      const nostrEvent = wrapEnvelope(envelope, privkey);

      const parsed = JSON.parse(nostrEvent.content);
      expect(parsed.id).toBe('unique-id-123');
      expect(parsed.kind).toBe(envelope.kind);
      expect(parsed.pubkey).toBe(envelope.pubkey);
      expect(parsed.content).toBe(envelope.content);
      expect(parsed.sig).toBe(envelope.sig);
    });

    it('includes rural-run tag and envelope kind tag', () => {
      const envelope = createTestEnvelope({ kind: EventKind.NEED_SUBMIT });
      const nostrEvent = wrapEnvelope(envelope, privkey);

      expect(nostrEvent.tags).toContainEqual(['t', 'rural-run']);
      expect(nostrEvent.tags).toContainEqual(['k', '2']); // NEED_SUBMIT = 2
      expect(nostrEvent.tags).toContainEqual(['e', envelope.id]);
    });

    it('supports custom Nostr kind', () => {
      const envelope = createTestEnvelope();
      const nostrEvent = wrapEnvelope(envelope, privkey, 9999);
      expect(nostrEvent.kind).toBe(9999);
    });
  });

  describe('unwrapEnvelope()', () => {
    it('extracts EventEnvelope from a Nostr event', () => {
      const original = createTestEnvelope({ id: 'roundtrip-test' });
      const nostrEvent = createWrappedNostrEvent(original);

      const unwrapped = unwrapEnvelope(nostrEvent);
      expect(unwrapped).not.toBeNull();
      expect(unwrapped!.id).toBe('roundtrip-test');
      expect(unwrapped!.kind).toBe(original.kind);
      expect(unwrapped!.pubkey).toBe(original.pubkey);
      expect(unwrapped!.created_at).toBe(original.created_at);
      expect(unwrapped!.content).toBe(original.content);
      expect(unwrapped!.sig).toBe(original.sig);
    });

    it('returns null for wrong Nostr kind', () => {
      const nostrEvent = createWrappedNostrEvent(undefined, { kind: 1 });
      expect(unwrapEnvelope(nostrEvent)).toBeNull();
    });

    it('returns null for malformed content', () => {
      const nostrEvent = createWrappedNostrEvent(undefined, { content: 'not json' });
      expect(unwrapEnvelope(nostrEvent)).toBeNull();
    });

    it('returns null for content missing required fields', () => {
      const nostrEvent = createWrappedNostrEvent(undefined, {
        content: JSON.stringify({ id: 'abc', kind: 1 }), // missing pubkey, created_at, content, sig
      });
      expect(unwrapEnvelope(nostrEvent)).toBeNull();
    });

    it('returns null for content with wrong field types', () => {
      const nostrEvent = createWrappedNostrEvent(undefined, {
        content: JSON.stringify({
          id: 123, // should be string
          kind: 'one', // should be number
          pubkey: 'pk',
          created_at: 1000,
          content: '{}',
          sig: 'sig',
        }),
      });
      expect(unwrapEnvelope(nostrEvent)).toBeNull();
    });

    it('supports custom Nostr kind for unwrapping', () => {
      const envelope = createTestEnvelope();
      const nostrEvent = createWrappedNostrEvent(envelope, { kind: 9999 });
      expect(unwrapEnvelope(nostrEvent, 9999)).not.toBeNull();
      expect(unwrapEnvelope(nostrEvent)).toBeNull(); // default kind won't match
    });
  });

  describe('wrap/unwrap roundtrip', () => {
    it('preserves all envelope fields through wrap and unwrap', () => {
      const original = createTestEnvelope({
        id: 'full-roundtrip',
        kind: EventKind.MATCH_ACCEPT,
        pubkey: 'aabbccdd',
        created_at: 1700000000,
        content: '{"trip_id":"t1","need_id":"n1"}',
        sig: '11223344',
      });

      const wrapped = wrapEnvelope(original, privkey);
      const unwrapped = unwrapEnvelope(wrapped);

      expect(unwrapped).toEqual(original);
    });
  });

  describe('buildRuralRunFilter()', () => {
    it('returns filter with Rural Run kind and tag', () => {
      const filter = buildRuralRunFilter();
      expect(filter.kinds).toEqual([RURAL_RUN_NOSTR_KIND]);
      expect(filter['#t']).toEqual([RURAL_RUN_TAG_VALUE]);
    });

    it('includes inner kind filter when specified', () => {
      const filter = buildRuralRunFilter(RURAL_RUN_NOSTR_KIND, [1, 2, 3]);
      expect(filter['#k']).toEqual(['1', '2', '3']);
    });

    it('does not include #k when kinds is empty', () => {
      const filter = buildRuralRunFilter(RURAL_RUN_NOSTR_KIND, []);
      expect(filter['#k']).toBeUndefined();
    });

    it('includes since when specified', () => {
      const filter = buildRuralRunFilter(RURAL_RUN_NOSTR_KIND, undefined, 1700000000);
      expect(filter.since).toBe(1700000000);
    });

    it('supports custom Nostr kind', () => {
      const filter = buildRuralRunFilter(9999);
      expect(filter.kinds).toEqual([9999]);
    });
  });
});
