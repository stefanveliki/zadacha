import 'fake-indexeddb/auto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { validateEnvelope, computeEventId, MAX_FUTURE_SKEW_SECONDS } from '../validation.js';
import { EventKind } from '../../shared/types.js';
import { buildEnvelope, buildTripEnvelope, generateKeypair } from './helpers.js';

describe('computeEventId', () => {
  it('produces a deterministic 64-char hex hash', () => {
    const id = computeEventId('aabbcc', 1000, 1, '{}');
    expect(id).toHaveLength(64);
    expect(id).toBe(computeEventId('aabbcc', 1000, 1, '{}'));
  });

  it('changes when any input differs', () => {
    const base = computeEventId('aabb', 1000, 1, '{}');
    expect(computeEventId('aabb', 1001, 1, '{}')).not.toBe(base);
    expect(computeEventId('aabb', 1000, 2, '{}')).not.toBe(base);
    expect(computeEventId('aabb', 1000, 1, '{"x":1}')).not.toBe(base);
    expect(computeEventId('ccdd', 1000, 1, '{}')).not.toBe(base);
  });
});

describe('validateEnvelope', () => {
  const { privkey } = generateKeypair();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts a valid TRIP_ANNOUNCE envelope', () => {
    const env = buildTripEnvelope(privkey);
    expect(validateEnvelope(env)).toBe(true);
  });

  it('accepts all valid event kinds', () => {
    for (const kind of Object.values(EventKind)) {
      const env = buildEnvelope(privkey, kind, '{}');
      expect(validateEnvelope(env)).toBe(true);
    }
  });

  it('rejects an unknown kind', () => {
    const env = buildEnvelope(privkey, 999, '{}');
    expect(validateEnvelope(env)).toBe(false);
  });

  it('rejects when id is tampered', () => {
    const env = buildTripEnvelope(privkey);
    env.id = 'ff'.repeat(32);
    expect(validateEnvelope(env)).toBe(false);
  });

  it('rejects when sig is tampered', () => {
    const env = buildTripEnvelope(privkey);
    env.sig = 'ff'.repeat(32);
    expect(validateEnvelope(env)).toBe(false);
  });

  it('rejects when content is tampered', () => {
    const env = buildTripEnvelope(privkey);
    env.content = '{"tampered":true}';
    expect(validateEnvelope(env)).toBe(false);
  });

  it('rejects events more than 5 minutes in the future', () => {
    const futureTs = Math.floor(Date.now() / 1000) + MAX_FUTURE_SKEW_SECONDS + 60;
    const env = buildEnvelope(privkey, EventKind.TRIP_ANNOUNCE, '{}', {
      created_at: futureTs,
    });
    expect(validateEnvelope(env)).toBe(false);
  });

  it('accepts events within 5 minutes in the future', () => {
    const nearFuture = Math.floor(Date.now() / 1000) + MAX_FUTURE_SKEW_SECONDS - 10;
    const env = buildEnvelope(privkey, EventKind.TRIP_ANNOUNCE, '{}', {
      created_at: nearFuture,
    });
    expect(validateEnvelope(env)).toBe(true);
  });

  it('accepts events from the past', () => {
    const past = Math.floor(Date.now() / 1000) - 86400;
    const env = buildEnvelope(privkey, EventKind.TRIP_ANNOUNCE, '{}', {
      created_at: past,
    });
    expect(validateEnvelope(env)).toBe(true);
  });

  it('returns false on malformed hex (never throws)', () => {
    const env = buildTripEnvelope(privkey);
    env.pubkey = 'not-hex';
    expect(validateEnvelope(env)).toBe(false);
  });
});
