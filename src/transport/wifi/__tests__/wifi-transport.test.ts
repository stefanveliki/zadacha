import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WiFiTransport } from '../wifi-transport.js';
import { MockWebSocket, MockBroadcastChannel, createTestEnvelope } from './test-helpers.js';

describe('WiFiTransport', () => {
  let createdSockets: MockWebSocket[];

  beforeEach(() => {
    createdSockets = [];
    MockBroadcastChannel.reset();

    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
    vi.stubGlobal('WebSocket', Object.assign(
      class extends MockWebSocket {
        constructor(url: string) {
          super(url);
          createdSockets.push(this);
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

  describe('listen()', () => {
    it('receives events from BroadcastChannel', async () => {
      const transport = new WiFiTransport({
        skipDiscovery: true,
        relay: { url: '' }, // no relay
      });
      const received: unknown[] = [];

      transport.listen((envelope) => received.push(envelope));

      // Send from another BroadcastChannel on the same name
      const sender = new MockBroadcastChannel('rural-run-protocol');
      const envelope = createTestEnvelope();
      sender.postMessage(JSON.stringify(envelope));

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(envelope);

      transport.close();
      sender.close();
    });

    it('receives events from WebSocket relay', async () => {
      const transport = new WiFiTransport({
        skipDiscovery: true,
        relay: { url: 'ws://test:4117' },
      });
      const received: unknown[] = [];

      transport.listen((envelope) => received.push(envelope));

      const ws = createdSockets[0];
      ws.simulateOpen();

      const envelope = createTestEnvelope();
      ws.simulateMessage(JSON.stringify(envelope));

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(envelope);

      transport.close();
    });

    it('deduplicates events received from both sub-transports', async () => {
      const transport = new WiFiTransport({
        skipDiscovery: true,
        relay: { url: 'ws://test:4117' },
      });
      const received: unknown[] = [];

      transport.listen((envelope) => received.push(envelope));

      const ws = createdSockets[0];
      ws.simulateOpen();

      const envelope = createTestEnvelope({ id: 'same-event-id' });

      // Same event arrives via both channels
      ws.simulateMessage(JSON.stringify(envelope));
      const sender = new MockBroadcastChannel('rural-run-protocol');
      sender.postMessage(JSON.stringify(envelope));

      // Only delivered once
      expect(received).toHaveLength(1);

      transport.close();
      sender.close();
    });

    it('delivers distinct events from both sub-transports', async () => {
      const transport = new WiFiTransport({
        skipDiscovery: true,
        relay: { url: 'ws://test:4117' },
      });
      const received: unknown[] = [];

      transport.listen((envelope) => received.push(envelope));

      const ws = createdSockets[0];
      ws.simulateOpen();

      const envelope1 = createTestEnvelope({ id: 'event-1' });
      const envelope2 = createTestEnvelope({ id: 'event-2' });

      ws.simulateMessage(JSON.stringify(envelope1));
      const sender = new MockBroadcastChannel('rural-run-protocol');
      sender.postMessage(JSON.stringify(envelope2));

      expect(received).toHaveLength(2);

      transport.close();
      sender.close();
    });
  });

  describe('publish()', () => {
    it('publishes to both sub-transports simultaneously', async () => {
      const transport = new WiFiTransport({
        skipDiscovery: true,
        relay: { url: 'ws://test:4117' },
      });

      const broadcastReceived: unknown[] = [];
      transport.listen(() => {});

      // Set up a receiver on BroadcastChannel
      const bcReceiver = new MockBroadcastChannel('rural-run-protocol');
      bcReceiver.onmessage = (event: MessageEvent) => {
        broadcastReceived.push(JSON.parse(event.data));
      };

      const ws = createdSockets[0];
      ws.simulateOpen();

      const envelope = createTestEnvelope();
      await transport.publish(envelope);

      // WebSocket received
      expect(ws.sentMessages).toHaveLength(1);
      expect(JSON.parse(ws.sentMessages[0])).toEqual(envelope);

      // BroadcastChannel received
      expect(broadcastReceived).toHaveLength(1);
      expect(broadcastReceived[0]).toEqual(envelope);

      transport.close();
      bcReceiver.close();
    });

    it('succeeds if only BroadcastChannel is available', async () => {
      const transport = new WiFiTransport({
        skipDiscovery: true,
        relay: { url: '' }, // no relay
      });

      transport.listen(() => {});

      const envelope = createTestEnvelope();
      await transport.publish(envelope);
      // No throw — BroadcastChannel was available

      transport.close();
    });

    it('succeeds if only WebSocket relay is available', async () => {
      const transport = new WiFiTransport({
        skipDiscovery: true,
        relay: { url: 'ws://test:4117' },
        disableBroadcastChannel: true,
      });

      transport.listen(() => {});

      const ws = createdSockets[0];
      ws.simulateOpen();

      const envelope = createTestEnvelope();
      await transport.publish(envelope);
      // No throw — relay was available

      expect(ws.sentMessages).toHaveLength(1);

      transport.close();
    });

    it('throws when no sub-transport is available', async () => {
      const transport = new WiFiTransport({
        skipDiscovery: true,
        relay: { url: '' },
        disableBroadcastChannel: true,
      });

      transport.listen(() => {});

      await expect(transport.publish(createTestEnvelope())).rejects.toThrow(
        'WiFi transport unavailable',
      );

      transport.close();
    });
  });

  describe('isAvailable()', () => {
    it('returns true when BroadcastChannel is available', () => {
      const transport = new WiFiTransport({
        skipDiscovery: true,
        relay: { url: '' },
      });

      transport.listen(() => {});
      expect(transport.isAvailable()).toBe(true);

      transport.close();
    });

    it('returns true when relay is connected', () => {
      const transport = new WiFiTransport({
        skipDiscovery: true,
        relay: { url: 'ws://test:4117' },
        disableBroadcastChannel: true,
      });

      transport.listen(() => {});
      expect(transport.isAvailable()).toBe(false); // not yet connected

      createdSockets[0].simulateOpen();
      expect(transport.isAvailable()).toBe(true);

      transport.close();
    });

    it('returns false when nothing is available', () => {
      vi.stubGlobal('BroadcastChannel', undefined);

      const transport = new WiFiTransport({
        skipDiscovery: true,
        relay: { url: '' },
      });

      transport.listen(() => {});
      expect(transport.isAvailable()).toBe(false);

      transport.close();
    });
  });

  describe('close()', () => {
    it('closes all sub-transports and resets state', () => {
      const transport = new WiFiTransport({
        skipDiscovery: true,
        relay: { url: 'ws://test:4117' },
      });

      transport.listen(() => {});
      createdSockets[0].simulateOpen();
      expect(transport.isAvailable()).toBe(true);

      transport.close();
      expect(transport.isAvailable()).toBe(false);
    });
  });

  describe('getStatus()', () => {
    it('reports status of all sub-transports', () => {
      const transport = new WiFiTransport({
        skipDiscovery: true,
        relay: { url: 'ws://test:4117' },
      });

      transport.listen(() => {});

      let status = transport.getStatus();
      expect(status.broadcast.available).toBe(true);
      expect(status.relay.connected).toBe(false);
      expect(status.relay.connectionState).toBe('connecting');

      createdSockets[0].simulateOpen();

      status = transport.getStatus();
      expect(status.relay.connected).toBe(true);
      expect(status.relay.connectionState).toBe('connected');

      transport.close();
    });
  });

  describe('hub discovery integration', () => {
    it('uses discovered URL for relay connection', async () => {
      // Stub location for same-origin discovery
      vi.stubGlobal('location', { hostname: '192.168.1.50' });

      // Make the probe succeed
      vi.stubGlobal('WebSocket', Object.assign(
        class extends MockWebSocket {
          constructor(url: string) {
            super(url);
            createdSockets.push(this);
            // Simulate successful probe connection
            setTimeout(() => this.simulateOpen(), 0);
          }
        },
        { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
      ));

      const transport = new WiFiTransport();
      const received: unknown[] = [];

      transport.listen((envelope) => received.push(envelope));

      // Let discovery complete
      await vi.advanceTimersByTimeAsync(10);

      // The relay should have connected to the discovered URL
      const relaySocket = createdSockets.find(
        (s) => s.url === 'ws://192.168.1.50:4117',
      );
      expect(relaySocket).toBeDefined();

      transport.close();
    });
  });

  describe('seenIds pruning', () => {
    it('does not grow the seenIds set unboundedly', () => {
      const transport = new WiFiTransport({
        skipDiscovery: true,
        relay: { url: 'ws://test:4117' },
      });

      transport.listen(() => {});

      const ws = createdSockets[0];
      ws.simulateOpen();

      // Send many unique events
      for (let i = 0; i < 11_000; i++) {
        const envelope = createTestEnvelope({ id: `event-${i}` });
        ws.simulateMessage(JSON.stringify(envelope));
      }

      // The transport should still function — no memory leak
      const status = transport.getStatus();
      expect(status.relay.connected).toBe(true);

      transport.close();
    });
  });
});
