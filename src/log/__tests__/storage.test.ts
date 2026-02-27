import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach } from 'vitest';
import { openStorage } from '../storage.js';
import { buildTripEnvelope, buildNeedEnvelope, generateKeypair } from './helpers.js';

let dbCounter = 0;
function freshDbName() {
  return `test-storage-${++dbCounter}-${Date.now()}`;
}

describe('storage', () => {
  const { privkey } = generateKeypair();

  afterEach(() => {
    dbCounter++;
  });

  it('stores and retrieves an event', async () => {
    const s = await openStorage(freshDbName());
    const env = buildTripEnvelope(privkey);

    await s.put(env);
    const all = await s.getAll();

    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(env.id);
    expect(all[0].content).toBe(env.content);
    s.close();
  });

  it('deduplicates by id — put twice returns once', async () => {
    const s = await openStorage(freshDbName());
    const env = buildTripEnvelope(privkey);

    await s.put(env);
    await s.put(env);
    const all = await s.getAll();

    expect(all).toHaveLength(1);
    s.close();
  });

  it('returns events ordered by created_at ascending', async () => {
    const s = await openStorage(freshDbName());
    const now = Math.floor(Date.now() / 1000);

    const older = buildTripEnvelope(privkey, undefined, { created_at: now - 100 });
    const newer = buildNeedEnvelope(privkey, undefined, { created_at: now });

    // Insert in reverse order
    await s.put(newer);
    await s.put(older);

    const all = await s.getAll();
    expect(all).toHaveLength(2);
    expect(all[0].created_at).toBeLessThanOrEqual(all[1].created_at);
    s.close();
  });

  it('stores all envelope fields faithfully', async () => {
    const s = await openStorage(freshDbName());
    const env = buildTripEnvelope(privkey);

    await s.put(env);
    const [stored] = await s.getAll();

    expect(stored).toEqual(env);
    s.close();
  });

  it('persists across close and reopen', async () => {
    const name = freshDbName();
    const s1 = await openStorage(name);
    const env = buildTripEnvelope(privkey);
    await s1.put(env);
    s1.close();

    const s2 = await openStorage(name);
    const all = await s2.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(env.id);
    s2.close();
  });
});
