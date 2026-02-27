import 'fake-indexeddb/auto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Log, openLog } from '../log.js';
import { openStorage } from '../storage.js';
import { EventKind } from '../../shared/types.js';
import { MAX_FUTURE_SKEW_SECONDS } from '../validation.js';
import {
  buildTripEnvelope,
  buildNeedEnvelope,
  buildMatchEnvelope,
  buildEnvelope,
  generateKeypair,
} from './helpers.js';

let dbCounter = 0;
function freshDbName() {
  return `test-log-${++dbCounter}-${Date.now()}`;
}

async function freshLog() {
  const name = freshDbName();
  const storage = await openStorage(name);
  return { log: new Log(storage), name, storage };
}

describe('Log.receive', () => {
  const runner = generateKeypair();
  const requester = generateKeypair();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts a valid event', async () => {
    const { log } = await freshLog();
    const env = buildTripEnvelope(runner.privkey);
    log.receive(env);
    expect(log.query({})).toHaveLength(1);
  });

  it('drops an event with invalid signature', async () => {
    const { log } = await freshLog();
    const env = buildTripEnvelope(runner.privkey);
    env.sig = 'ff'.repeat(32);
    log.receive(env);
    expect(log.query({})).toHaveLength(0);
  });

  it('drops an event with tampered id', async () => {
    const { log } = await freshLog();
    const env = buildTripEnvelope(runner.privkey);
    env.id = 'aa'.repeat(32);
    log.receive(env);
    expect(log.query({})).toHaveLength(0);
  });

  it('drops events more than 5 minutes in the future', async () => {
    const { log } = await freshLog();
    const futureTs = Math.floor(Date.now() / 1000) + MAX_FUTURE_SKEW_SECONDS + 60;
    const env = buildEnvelope(runner.privkey, EventKind.TRIP_ANNOUNCE, '{}', {
      created_at: futureTs,
    });
    log.receive(env);
    expect(log.query({})).toHaveLength(0);
  });

  it('deduplicates — same event from two transports stored once', async () => {
    const { log } = await freshLog();
    const env = buildTripEnvelope(runner.privkey);

    log.receive(env);
    log.receive(env); // same event again (different transport)

    expect(log.query({})).toHaveLength(1);
  });

  it('stores distinct events from the same author', async () => {
    const { log } = await freshLog();
    const now = Math.floor(Date.now() / 1000);
    const e1 = buildTripEnvelope(runner.privkey, undefined, { created_at: now });
    const e2 = buildNeedEnvelope(runner.privkey, undefined, { created_at: now + 1 });

    log.receive(e1);
    log.receive(e2);
    // These have different kinds/content/timestamps so different ids
    expect(log.query({})).toHaveLength(2);
  });
});

describe('Log.query', () => {
  const runner = generateKeypair();
  const requester = generateKeypair();

  it('returns all events with empty filter', async () => {
    const { log } = await freshLog();
    const e1 = buildTripEnvelope(runner.privkey);
    const e2 = buildNeedEnvelope(requester.privkey);
    log.receive(e1);
    log.receive(e2);
    expect(log.query({})).toHaveLength(2);
  });

  it('filters by kind', async () => {
    const { log } = await freshLog();
    log.receive(buildTripEnvelope(runner.privkey));
    log.receive(buildNeedEnvelope(requester.privkey));

    const trips = log.query({ kinds: [EventKind.TRIP_ANNOUNCE] });
    expect(trips).toHaveLength(1);
    expect(trips[0].kind).toBe(EventKind.TRIP_ANNOUNCE);

    const needs = log.query({ kinds: [EventKind.NEED_SUBMIT] });
    expect(needs).toHaveLength(1);
    expect(needs[0].kind).toBe(EventKind.NEED_SUBMIT);
  });

  it('filters by pubkey', async () => {
    const { log } = await freshLog();
    log.receive(buildTripEnvelope(runner.privkey));
    log.receive(buildNeedEnvelope(requester.privkey));

    const result = log.query({ pubkeys: [runner.pubkey] });
    expect(result).toHaveLength(1);
    expect(result[0].pubkey).toBe(runner.pubkey);
  });

  it('filters by since and until', async () => {
    const { log } = await freshLog();
    const now = Math.floor(Date.now() / 1000);

    log.receive(buildTripEnvelope(runner.privkey, undefined, { created_at: now - 200 }));
    log.receive(buildTripEnvelope(runner.privkey, undefined, { created_at: now - 100 }));
    log.receive(buildNeedEnvelope(requester.privkey, undefined, { created_at: now }));

    expect(log.query({ since: now - 150 })).toHaveLength(2);
    expect(log.query({ until: now - 150 })).toHaveLength(1);
    expect(log.query({ since: now - 150, until: now - 50 })).toHaveLength(1);
  });

  it('filters by trip_id', async () => {
    const { log } = await freshLog();
    const trip = buildTripEnvelope(runner.privkey);
    const need = buildNeedEnvelope(requester.privkey);
    log.receive(trip);
    log.receive(need);

    const match = buildMatchEnvelope(runner.privkey, trip.id, need.id);
    log.receive(match);

    const results = log.query({ trip_id: trip.id });
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe(EventKind.MATCH_ACCEPT);
  });

  it('filters by need_id', async () => {
    const { log } = await freshLog();
    const trip = buildTripEnvelope(runner.privkey);
    const need = buildNeedEnvelope(requester.privkey);
    log.receive(trip);
    log.receive(need);

    const match = buildMatchEnvelope(runner.privkey, trip.id, need.id);
    log.receive(match);

    const results = log.query({ need_id: need.id });
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe(EventKind.MATCH_ACCEPT);
  });

  it('respects limit', async () => {
    const { log } = await freshLog();
    const now = Math.floor(Date.now() / 1000);

    for (let i = 0; i < 5; i++) {
      log.receive(buildTripEnvelope(runner.privkey, undefined, { created_at: now + i }));
    }

    expect(log.query({ limit: 3 })).toHaveLength(3);
    expect(log.query({ limit: 10 })).toHaveLength(5);
  });

  it('returns results ordered by created_at ascending', async () => {
    const { log } = await freshLog();
    const now = Math.floor(Date.now() / 1000);

    // Insert out of order
    log.receive(buildTripEnvelope(runner.privkey, undefined, { created_at: now + 2 }));
    log.receive(buildTripEnvelope(runner.privkey, undefined, { created_at: now }));
    log.receive(buildTripEnvelope(runner.privkey, undefined, { created_at: now + 1 }));

    const results = log.query({});
    for (let i = 1; i < results.length; i++) {
      expect(results[i].created_at).toBeGreaterThanOrEqual(results[i - 1].created_at);
    }
  });

  it('combines multiple filter criteria', async () => {
    const { log } = await freshLog();
    const now = Math.floor(Date.now() / 1000);

    log.receive(buildTripEnvelope(runner.privkey, undefined, { created_at: now }));
    log.receive(buildNeedEnvelope(requester.privkey, undefined, { created_at: now + 1 }));
    log.receive(buildTripEnvelope(runner.privkey, undefined, { created_at: now + 2 }));

    const results = log.query({
      kinds: [EventKind.TRIP_ANNOUNCE],
      pubkeys: [runner.pubkey],
    });
    expect(results).toHaveLength(2);
  });
});

describe('Log.subscribe', () => {
  const runner = generateKeypair();
  const requester = generateKeypair();

  it('calls back on new matching events', async () => {
    const { log } = await freshLog();
    const received: string[] = [];
    log.subscribe({ kinds: [EventKind.TRIP_ANNOUNCE] }, (e) => received.push(e.id));

    const trip = buildTripEnvelope(runner.privkey);
    log.receive(trip);

    expect(received).toEqual([trip.id]);
  });

  it('does not call back for non-matching events', async () => {
    const { log } = await freshLog();
    const received: string[] = [];
    log.subscribe({ kinds: [EventKind.NEED_SUBMIT] }, (e) => received.push(e.id));

    log.receive(buildTripEnvelope(runner.privkey));
    expect(received).toHaveLength(0);
  });

  it('does not call back for invalid events', async () => {
    const { log } = await freshLog();
    const received: string[] = [];
    log.subscribe({}, (e) => received.push(e.id));

    const env = buildTripEnvelope(runner.privkey);
    env.sig = 'ff'.repeat(32);
    log.receive(env);

    expect(received).toHaveLength(0);
  });

  it('does not call back for duplicate events', async () => {
    const { log } = await freshLog();
    const received: string[] = [];
    log.subscribe({}, (e) => received.push(e.id));

    const trip = buildTripEnvelope(runner.privkey);
    log.receive(trip);
    log.receive(trip);

    expect(received).toHaveLength(1);
  });

  it('unsubscribe stops delivery', async () => {
    const { log } = await freshLog();
    const received: string[] = [];
    const unsub = log.subscribe({}, (e) => received.push(e.id));

    log.receive(buildTripEnvelope(runner.privkey));
    expect(received).toHaveLength(1);

    unsub();

    log.receive(buildNeedEnvelope(requester.privkey));
    expect(received).toHaveLength(1); // still 1
  });

  it('subscription with trip_id filter works', async () => {
    const { log } = await freshLog();
    const trip = buildTripEnvelope(runner.privkey);
    const need = buildNeedEnvelope(requester.privkey);
    log.receive(trip);
    log.receive(need);

    const received: string[] = [];
    log.subscribe({ trip_id: trip.id }, (e) => received.push(e.id));

    const match = buildMatchEnvelope(runner.privkey, trip.id, need.id);
    log.receive(match);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(match.id);
  });
});

describe('Log persistence', () => {
  const runner = generateKeypair();

  it('survives close and reopen via openLog', async () => {
    const dbName = freshDbName();

    const log1 = await openLog(dbName);
    const trip = buildTripEnvelope(runner.privkey);
    log1.receive(trip);

    // Give IndexedDB write time to complete
    await new Promise((r) => setTimeout(r, 50));
    log1.close();

    const log2 = await openLog(dbName);
    const results = log2.query({});

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(trip.id);
    log2.close();
  });
});

describe('Log — append-only enforcement', () => {
  it('has no delete or update methods', () => {
    expect(typeof Log.prototype).toBe('object');
    expect('delete' in Log.prototype).toBe(false);
    expect('update' in Log.prototype).toBe(false);
    expect('remove' in Log.prototype).toBe(false);
  });
});
