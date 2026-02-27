import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RelayListManager } from '../relay-list.js';
import { createMockLocalStorage } from './test-helpers.js';

describe('RelayListManager', () => {
  let mockStorage: Storage;

  beforeEach(() => {
    mockStorage = createMockLocalStorage();
    vi.stubGlobal('localStorage', mockStorage);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getRelays() — defaults', () => {
    it('returns hardcoded defaults when no IPFS CID configured', async () => {
      const manager = new RelayListManager();
      const relays = await manager.getRelays();

      expect(relays).toContain('wss://relay.damus.io');
      expect(relays).toContain('wss://nos.lol');
      expect(relays).toContain('wss://relay.nostr.band');
    });

    it('returns custom defaults when provided', async () => {
      const manager = new RelayListManager({
        defaultRelays: ['wss://custom.test'],
      });
      const relays = await manager.getRelays();

      expect(relays).toEqual(['wss://custom.test']);
    });
  });

  describe('getRelays() — IPFS fetch', () => {
    it('fetches relay list from IPFS when CID is configured', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(['wss://ipfs-relay-1.test', 'wss://ipfs-relay-2.test']),
      });
      vi.stubGlobal('fetch', mockFetch);

      const manager = new RelayListManager({
        ipfsCid: 'QmTestCid123',
        ipfsGateway: 'https://gateway.test/ipfs/{cid}',
      });
      const relays = await manager.getRelays();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://gateway.test/ipfs/QmTestCid123',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(relays).toContain('wss://ipfs-relay-1.test');
      expect(relays).toContain('wss://ipfs-relay-2.test');
    });

    it('caches IPFS result in localStorage', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(['wss://cached.test']),
      }));

      const manager = new RelayListManager({ ipfsCid: 'QmTest' });
      await manager.getRelays();

      const cached = JSON.parse(mockStorage.getItem('rural-run-relay-list')!);
      expect(cached.relays).toEqual(['wss://cached.test']);
      expect(typeof cached.fetchedAt).toBe('number');
    });

    it('falls back to cache when IPFS fetch fails', async () => {
      // Pre-populate cache
      mockStorage.setItem('rural-run-relay-list', JSON.stringify({
        relays: ['wss://from-cache.test'],
        fetchedAt: Date.now(),
      }));

      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

      const manager = new RelayListManager({ ipfsCid: 'QmTest' });
      const relays = await manager.getRelays();

      expect(relays).toContain('wss://from-cache.test');
    });

    it('falls back to defaults when IPFS fails and cache is expired', async () => {
      // Pre-populate expired cache
      mockStorage.setItem('rural-run-relay-list', JSON.stringify({
        relays: ['wss://expired.test'],
        fetchedAt: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
      }));

      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

      const manager = new RelayListManager({
        ipfsCid: 'QmTest',
        defaultRelays: ['wss://fallback.test'],
      });
      const relays = await manager.getRelays();

      expect(relays).toEqual(['wss://fallback.test']);
    });

    it('falls back to defaults when IPFS returns non-OK response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }));

      const manager = new RelayListManager({
        ipfsCid: 'QmTest',
        defaultRelays: ['wss://default.test'],
      });
      const relays = await manager.getRelays();

      expect(relays).toEqual(['wss://default.test']);
    });

    it('filters out non-wss URLs from IPFS response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([
          'wss://good.test',
          'http://not-wss.test',
          42,
          null,
          'wss://also-good.test',
        ]),
      }));

      const manager = new RelayListManager({ ipfsCid: 'QmTest' });
      const relays = await manager.getRelays();

      expect(relays).toEqual(['wss://good.test', 'wss://also-good.test']);
    });

    it('only fetches IPFS once across multiple getRelays calls', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(['wss://once.test']),
      });
      vi.stubGlobal('fetch', mockFetch);

      const manager = new RelayListManager({ ipfsCid: 'QmTest' });
      await manager.getRelays();
      await manager.getRelays();
      await manager.getRelays();

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('community relays', () => {
    it('adds community relays with highest priority', async () => {
      const manager = new RelayListManager({
        defaultRelays: ['wss://default.test'],
      });

      manager.addCommunityRelay('wss://community.test');
      const relays = await manager.getRelays();

      // Community relay should be first
      expect(relays[0]).toBe('wss://community.test');
      expect(relays).toContain('wss://default.test');
    });

    it('persists community relays to localStorage', () => {
      const manager = new RelayListManager();
      manager.addCommunityRelay('wss://saved.test');

      const stored = JSON.parse(mockStorage.getItem('rural-run-community-relays')!);
      expect(stored).toContain('wss://saved.test');
    });

    it('loads community relays from localStorage on construction', async () => {
      mockStorage.setItem(
        'rural-run-community-relays',
        JSON.stringify(['wss://persisted.test']),
      );

      const manager = new RelayListManager({ defaultRelays: ['wss://default.test'] });
      const relays = await manager.getRelays();

      expect(relays).toContain('wss://persisted.test');
    });

    it('removes community relays', async () => {
      const manager = new RelayListManager({ defaultRelays: ['wss://default.test'] });
      manager.addCommunityRelay('wss://community.test');
      manager.removeCommunityRelay('wss://community.test');

      const relays = await manager.getRelays();
      expect(relays).not.toContain('wss://community.test');
    });

    it('getCommunityRelays() returns current community list', () => {
      const manager = new RelayListManager();
      manager.addCommunityRelay('wss://a.test');
      manager.addCommunityRelay('wss://b.test');

      expect(manager.getCommunityRelays()).toEqual(['wss://a.test', 'wss://b.test']);
    });

    it('deduplicates across community and default relays', async () => {
      const manager = new RelayListManager({
        defaultRelays: ['wss://shared.test', 'wss://only-default.test'],
      });
      manager.addCommunityRelay('wss://shared.test');

      const relays = await manager.getRelays();
      const sharedCount = relays.filter((r) => r === 'wss://shared.test').length;
      expect(sharedCount).toBe(1);
    });
  });

  describe('refreshFromIPFS()', () => {
    it('re-fetches relay list from IPFS', async () => {
      let callCount = 0;
      vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([`wss://fetch-${callCount}.test`]),
        });
      }));

      const manager = new RelayListManager({ ipfsCid: 'QmTest' });
      const first = await manager.getRelays();
      expect(first).toContain('wss://fetch-1.test');

      await manager.refreshFromIPFS();
      const second = await manager.getRelays();
      expect(second).toContain('wss://fetch-2.test');
    });
  });
});
