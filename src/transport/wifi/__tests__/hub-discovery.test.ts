import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HubDiscovery } from '../hub-discovery.js';
import { MockWebSocket } from './test-helpers.js';

describe('HubDiscovery', () => {
  let createdSockets: MockWebSocket[];

  beforeEach(() => {
    createdSockets = [];

    vi.stubGlobal('WebSocket', Object.assign(
      class extends MockWebSocket {
        constructor(url: string) {
          super(url);
          createdSockets.push(this);
          // By default, simulate connection failure (onclose fires)
          setTimeout(() => {
            if (this.onerror) this.onerror(new Event('error'));
          }, 0);
        }
      },
      { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
    ));

    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('discover() — Strategy 1: Explicit configuration', () => {
    it('returns the configured URL immediately', async () => {
      const discovery = new HubDiscovery({
        configuredUrl: 'ws://192.168.1.100:4117',
      });

      const result = await discovery.discover();

      expect(result).toEqual({
        url: 'ws://192.168.1.100:4117',
        source: 'configured',
      });
    });

    it('does not probe if configured URL is set', async () => {
      const discovery = new HubDiscovery({
        configuredUrl: 'ws://192.168.1.100:4117',
      });

      await discovery.discover();

      expect(createdSockets).toHaveLength(0);
    });
  });

  describe('discover() — Strategy 2: Same-origin inference', () => {
    it('infers hub URL from a private IP origin', async () => {
      vi.stubGlobal('location', { hostname: '192.168.1.50' });

      // Make the probe succeed
      vi.stubGlobal('WebSocket', Object.assign(
        class extends MockWebSocket {
          constructor(url: string) {
            super(url);
            createdSockets.push(this);
            // Simulate successful connection
            setTimeout(() => this.simulateOpen(), 0);
          }
        },
        { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
      ));

      const discovery = new HubDiscovery();
      const resultPromise = discovery.discover();
      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;

      expect(result).toEqual({
        url: 'ws://192.168.1.50:4117',
        source: 'same-origin',
      });
    });

    it('does not infer from public hostnames', () => {
      vi.stubGlobal('location', { hostname: 'example.com' });

      const discovery = new HubDiscovery();
      const inferred = discovery.inferSameOrigin();

      expect(inferred).toBeNull();
    });

    it('returns null when location is not available', () => {
      // Node.js environment — no globalThis.location
      const originalLocation = globalThis.location;
      // @ts-expect-error - removing location for test
      delete globalThis.location;

      const discovery = new HubDiscovery();
      const inferred = discovery.inferSameOrigin();

      expect(inferred).toBeNull();

      // Restore
      if (originalLocation) {
        globalThis.location = originalLocation;
      }
    });
  });

  describe('discover() — Strategy 3: Well-known port probe', () => {
    it('returns first reachable address from probe list', async () => {
      vi.stubGlobal('location', { hostname: 'example.com' }); // not private, skip strategy 2

      let connectCount = 0;
      vi.stubGlobal('WebSocket', Object.assign(
        class extends MockWebSocket {
          constructor(url: string) {
            super(url);
            createdSockets.push(this);
            connectCount++;
            // Only the third socket succeeds
            if (url.includes('192.168.4.1')) {
              setTimeout(() => this.simulateOpen(), 0);
            } else {
              setTimeout(() => {
                if (this.onerror) this.onerror(new Event('error'));
              }, 0);
            }
          }
        },
        { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
      ));

      const discovery = new HubDiscovery();
      const resultPromise = discovery.discover();
      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;

      expect(result).not.toBeNull();
      expect(result!.source).toBe('probe');
      expect(result!.url).toContain('192.168.4.1');
    });

    it('returns null when no addresses are reachable', async () => {
      vi.stubGlobal('location', { hostname: 'example.com' });

      vi.stubGlobal('WebSocket', Object.assign(
        class extends MockWebSocket {
          constructor(url: string) {
            super(url);
            createdSockets.push(this);
            // All fail
            setTimeout(() => {
              if (this.onerror) this.onerror(new Event('error'));
            }, 0);
          }
        },
        { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
      ));

      const discovery = new HubDiscovery();
      const resultPromise = discovery.discover();
      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;

      expect(result).toBeNull();
    });

    it('probes extra addresses when configured', async () => {
      vi.stubGlobal('location', { hostname: 'example.com' });

      vi.stubGlobal('WebSocket', Object.assign(
        class extends MockWebSocket {
          constructor(url: string) {
            super(url);
            createdSockets.push(this);
            if (url.includes('192.168.99.1')) {
              setTimeout(() => this.simulateOpen(), 0);
            } else {
              setTimeout(() => {
                if (this.onerror) this.onerror(new Event('error'));
              }, 0);
            }
          }
        },
        { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
      ));

      const discovery = new HubDiscovery({
        extraProbeAddresses: ['192.168.99.1'],
      });
      const resultPromise = discovery.discover();
      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;

      expect(result).not.toBeNull();
      expect(result!.url).toContain('192.168.99.1');
    });
  });

  describe('setConfiguredUrl()', () => {
    it('updates the configured URL and returns it on next discover', async () => {
      const discovery = new HubDiscovery();

      discovery.setConfiguredUrl('ws://192.168.1.200:4117');
      const result = await discovery.discover();

      expect(result).toEqual({
        url: 'ws://192.168.1.200:4117',
        source: 'configured',
      });
    });

    it('overrides previous discovery strategies', async () => {
      // Start without a configured URL
      const discovery = new HubDiscovery({
        extraProbeAddresses: ['192.168.50.1'],
      });

      // Set a configured URL — should take priority
      discovery.setConfiguredUrl('ws://192.168.1.200:4117');
      const result = await discovery.discover();

      expect(result).toEqual({
        url: 'ws://192.168.1.200:4117',
        source: 'configured',
      });
    });
  });

  describe('inferSameOrigin() — private address detection', () => {
    const cases: Array<[string, boolean]> = [
      ['192.168.1.50', true],
      ['192.168.0.1', true],
      ['10.0.0.1', true],
      ['10.42.0.1', true],
      ['172.16.0.1', true],
      ['172.31.255.254', true],
      ['172.15.0.1', false],
      ['172.32.0.1', false],
      ['169.254.1.1', true],
      ['localhost', true],
      ['127.0.0.1', true],
      ['::1', true],
      ['example.com', false],
      ['8.8.8.8', false],
    ];

    for (const [hostname, isPrivate] of cases) {
      it(`${hostname} → ${isPrivate ? 'private' : 'public'}`, () => {
        vi.stubGlobal('location', { hostname });

        const discovery = new HubDiscovery();
        const result = discovery.inferSameOrigin();

        if (isPrivate) {
          expect(result).not.toBeNull();
        } else {
          expect(result).toBeNull();
        }
      });
    }
  });

  describe('probeUrl()', () => {
    it('returns true for a reachable URL', async () => {
      vi.stubGlobal('WebSocket', Object.assign(
        class extends MockWebSocket {
          constructor(url: string) {
            super(url);
            createdSockets.push(this);
            setTimeout(() => this.simulateOpen(), 0);
          }
        },
        { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
      ));

      const discovery = new HubDiscovery();
      const resultPromise = discovery.probeUrl('ws://192.168.1.1:4117');
      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;

      expect(result).toBe(true);
    });

    it('returns false for an unreachable URL', async () => {
      vi.stubGlobal('WebSocket', Object.assign(
        class extends MockWebSocket {
          constructor(url: string) {
            super(url);
            createdSockets.push(this);
            setTimeout(() => {
              if (this.onerror) this.onerror(new Event('error'));
            }, 0);
          }
        },
        { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
      ));

      const discovery = new HubDiscovery();
      const resultPromise = discovery.probeUrl('ws://192.168.1.1:4117');
      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;

      expect(result).toBe(false);
    });

    it('returns false on timeout', async () => {
      vi.stubGlobal('WebSocket', Object.assign(
        class extends MockWebSocket {
          constructor(url: string) {
            super(url);
            createdSockets.push(this);
            // Never connects — will timeout
          }
        },
        { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
      ));

      const discovery = new HubDiscovery({ probeTimeout: 500 });
      const resultPromise = discovery.probeUrl('ws://192.168.1.1:4117');
      await vi.advanceTimersByTimeAsync(600);
      const result = await resultPromise;

      expect(result).toBe(false);
    });
  });
});
