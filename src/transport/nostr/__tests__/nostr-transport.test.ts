import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NostrTransport } from '../nostr-transport.js';
import { RURAL_RUN_NOSTR_KIND } from '../event-bridge.js';
import { MockWebSocket, createTestEnvelope, createWrappedNostrEvent, createMockLocalStorage } from './test-helpers.js';

describe('NostrTransport', () => {
  let createdSockets: MockWebSocket[];

  beforeEach(() => {
    createdSockets = [];

    vi.stubGlobal(
      'WebSocket',
      Object.assign(
        class extends MockWebSocket {
          constructor(url: string) {
            super(url);
            createdSockets.push(this);
          }
        },
        { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
      ),
    );

    vi.stubGlobal('localStorage', createMockLocalStorage());
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('No IPFS')));

    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function createTransport(overrides: Record<string, unknown> = {}) {
    return new NostrTransport({
      relayList: {
        defaultRelays: ['wss://relay-1.test', 'wss://relay-2.test', 'wss://relay-3.test'],
        ...((overrides.relayList as Record<string, unknown>) ?? {}),
      },
      ...overrides,
    });
  }

  function openAllSockets() {
    for (const ws of createdSockets) {
      if (ws.readyState === MockWebSocket.CONNECTING) {
        ws.simulateOpen();
      }
    }
  }

  describe('listen()', () => {
    it('connects to all default relays', async () => {
      const transport = createTransport();
      transport.listen(() => {});

      // Wait for async initialization
      await vi.advanceTimersByTimeAsync(0);

      expect(createdSockets).toHaveLength(3);
      expect(createdSockets.map((s) => s.url)).toEqual([
        'wss://relay-1.test',
        'wss://relay-2.test',
        'wss://relay-3.test',
      ]);

      transport.close();
    });

    it('subscribes with Rural Run filter on connected relays', async () => {
      const transport = createTransport();
      transport.listen(() => {});
      await vi.advanceTimersByTimeAsync(0);

      openAllSockets();

      // Each socket should have received a REQ message
      for (const ws of createdSockets) {
        const reqs = ws.sentMessages.filter((m) => JSON.parse(m)[0] === 'REQ');
        expect(reqs).toHaveLength(1);

        const msg = JSON.parse(reqs[0]);
        expect(msg[0]).toBe('REQ');
        expect(msg[2].kinds).toEqual([RURAL_RUN_NOSTR_KIND]);
        expect(msg[2]['#t']).toEqual(['rural-run']);
      }

      transport.close();
    });

    it('delivers unwrapped EventEnvelopes to the listener', async () => {
      const transport = createTransport();
      const received: unknown[] = [];
      transport.listen((envelope) => received.push(envelope));
      await vi.advanceTimersByTimeAsync(0);

      openAllSockets();

      // Simulate a Nostr event from a relay
      const innerEnvelope = createTestEnvelope({ id: 'test-delivery' });
      const nostrEvent = createWrappedNostrEvent(innerEnvelope);

      createdSockets[0].simulateMessage(
        JSON.stringify(['EVENT', 'rural-run-main', nostrEvent]),
      );

      expect(received).toHaveLength(1);
      expect((received[0] as { id: string }).id).toBe('test-delivery');

      transport.close();
    });

    it('ignores Nostr events with wrong kind', async () => {
      const transport = createTransport();
      const received: unknown[] = [];
      transport.listen((envelope) => received.push(envelope));
      await vi.advanceTimersByTimeAsync(0);
      openAllSockets();

      const wrongKind = createWrappedNostrEvent(undefined, { kind: 1 });
      createdSockets[0].simulateMessage(
        JSON.stringify(['EVENT', 'sub', wrongKind]),
      );

      expect(received).toHaveLength(0);

      transport.close();
    });

    it('ignores Nostr events with invalid envelope content', async () => {
      const transport = createTransport();
      const received: unknown[] = [];
      transport.listen((envelope) => received.push(envelope));
      await vi.advanceTimersByTimeAsync(0);
      openAllSockets();

      const badContent = createWrappedNostrEvent(undefined, {
        id: 'bad-1',
        content: 'not json',
      });
      createdSockets[0].simulateMessage(
        JSON.stringify(['EVENT', 'sub', badContent]),
      );

      expect(received).toHaveLength(0);

      transport.close();
    });
  });

  describe('publish()', () => {
    it('wraps envelope and publishes to all connected relays', async () => {
      const transport = createTransport();
      transport.listen(() => {});
      await vi.advanceTimersByTimeAsync(0);
      openAllSockets();

      const envelope = createTestEnvelope({ id: 'publish-test' });
      await transport.publish(envelope);

      for (const ws of createdSockets) {
        const events = ws.sentMessages
          .map((m) => JSON.parse(m))
          .filter((m) => m[0] === 'EVENT');

        expect(events).toHaveLength(1);

        const nostrEvent = events[0][1];
        expect(nostrEvent.kind).toBe(RURAL_RUN_NOSTR_KIND);

        // Verify the inner envelope is preserved
        const inner = JSON.parse(nostrEvent.content);
        expect(inner.id).toBe('publish-test');
      }

      transport.close();
    });

    it('initializes relays on first publish if listen was not called', async () => {
      // Auto-open sockets on creation so publish finds connected relays
      vi.stubGlobal(
        'WebSocket',
        Object.assign(
          class extends MockWebSocket {
            constructor(url: string) {
              super(url);
              createdSockets.push(this);
              // Simulate immediate open via microtask
              queueMicrotask(() => this.simulateOpen());
            }
          },
          { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
        ),
      );

      const transport = createTransport();

      // Publish without calling listen first — triggers initializeRelays()
      await transport.publish(createTestEnvelope());

      expect(createdSockets).toHaveLength(3);

      // Verify events were sent
      const eventMsgs = createdSockets[0].sentMessages
        .map((m) => JSON.parse(m))
        .filter((m) => m[0] === 'EVENT');
      expect(eventMsgs).toHaveLength(1);

      transport.close();
    });

    it('rejects when no relays are connected', async () => {
      const transport = createTransport();
      transport.listen(() => {});
      await vi.advanceTimersByTimeAsync(0);

      // Don't open any sockets
      await expect(transport.publish(createTestEnvelope())).rejects.toThrow(
        'No relays connected',
      );

      transport.close();
    });
  });

  describe('isAvailable()', () => {
    it('returns true when online and relays connected', async () => {
      const transport = createTransport();
      transport.listen(() => {});
      await vi.advanceTimersByTimeAsync(0);

      expect(transport.isAvailable()).toBe(false); // not connected yet

      openAllSockets();
      expect(transport.isAvailable()).toBe(true);

      transport.close();
    });

    it('returns false when navigator.onLine is false', async () => {
      const transport = createTransport();
      transport.listen(() => {});
      await vi.advanceTimersByTimeAsync(0);
      openAllSockets();

      vi.stubGlobal('navigator', { onLine: false });
      expect(transport.isAvailable()).toBe(false);

      transport.close();
    });

    it('returns false when no relays are connected', async () => {
      const transport = createTransport();
      transport.listen(() => {});
      await vi.advanceTimersByTimeAsync(0);

      // All sockets still connecting
      expect(transport.isAvailable()).toBe(false);

      transport.close();
    });
  });

  describe('addRelay() / removeRelay()', () => {
    it('adds a community relay that connects immediately', async () => {
      const transport = createTransport();
      transport.listen(() => {});
      await vi.advanceTimersByTimeAsync(0);
      openAllSockets();

      transport.addRelay('wss://community.test');
      // Pool.connect() is called, which connects the new relay
      const newSocket = createdSockets.find((s) => s.url === 'wss://community.test');
      expect(newSocket).toBeDefined();

      transport.close();
    });

    it('removes a relay', async () => {
      const transport = createTransport();
      transport.listen(() => {});
      await vi.advanceTimersByTimeAsync(0);
      openAllSockets();

      const countBefore = transport.getStatus().connectedRelays;
      transport.removeRelay('wss://relay-1.test');
      expect(transport.getStatus().connectedRelays).toBe(countBefore - 1);

      transport.close();
    });
  });

  describe('getStatus()', () => {
    it('returns diagnostic status of all relays', async () => {
      const transport = createTransport();
      transport.listen(() => {});
      await vi.advanceTimersByTimeAsync(0);

      createdSockets[0].simulateOpen();
      // relay-2 and relay-3 still connecting

      const status = transport.getStatus();
      expect(status.totalRelays).toBe(3);
      expect(status.connectedRelays).toBe(1);
      expect(status.available).toBe(true);
      expect(status.relays).toContainEqual({
        url: 'wss://relay-1.test',
        state: 'connected',
      });

      transport.close();
    });
  });

  describe('close()', () => {
    it('disconnects all relays and stops listening', async () => {
      const transport = createTransport();
      const received: unknown[] = [];
      transport.listen((envelope) => received.push(envelope));
      await vi.advanceTimersByTimeAsync(0);
      openAllSockets();

      transport.close();

      expect(transport.isAvailable()).toBe(false);
      expect(transport.getStatus().connectedRelays).toBe(0);
    });
  });

  describe('resilience', () => {
    it('continues working when one relay goes offline', async () => {
      const transport = createTransport();
      const received: unknown[] = [];
      transport.listen((envelope) => received.push(envelope));
      await vi.advanceTimersByTimeAsync(0);
      openAllSockets();

      // Take relay-1 offline
      createdSockets[0].simulateClose();

      // Events from relay-2 still arrive
      const envelope = createTestEnvelope({ id: 'resilience-test' });
      const nostrEvent = createWrappedNostrEvent(envelope);
      createdSockets[1].simulateMessage(
        JSON.stringify(['EVENT', 'sub', nostrEvent]),
      );

      expect(received).toHaveLength(1);
      expect((received[0] as { id: string }).id).toBe('resilience-test');

      transport.close();
    });

    it('publishes to remaining relays when one is down', async () => {
      const transport = createTransport();
      transport.listen(() => {});
      await vi.advanceTimersByTimeAsync(0);
      openAllSockets();

      // Take relay-1 offline
      createdSockets[0].simulateClose();

      const envelope = createTestEnvelope();
      await transport.publish(envelope);

      // relay-2 and relay-3 should have the event
      const relay2Events = createdSockets[1].sentMessages
        .map((m) => JSON.parse(m))
        .filter((m) => m[0] === 'EVENT');
      expect(relay2Events).toHaveLength(1);

      transport.close();
    });

    it('deduplicates same event received from multiple relays', async () => {
      const transport = createTransport();
      const received: unknown[] = [];
      transport.listen((envelope) => received.push(envelope));
      await vi.advanceTimersByTimeAsync(0);
      openAllSockets();

      const envelope = createTestEnvelope({ id: 'dedup-test' });
      const nostrEvent = createWrappedNostrEvent(envelope);
      const msg = JSON.stringify(['EVENT', 'sub', nostrEvent]);

      // Same event from all 3 relays
      createdSockets[0].simulateMessage(msg);
      createdSockets[1].simulateMessage(msg);
      createdSockets[2].simulateMessage(msg);

      // Only delivered once (dedup at relay pool level by Nostr event id)
      expect(received).toHaveLength(1);

      transport.close();
    });
  });
});
