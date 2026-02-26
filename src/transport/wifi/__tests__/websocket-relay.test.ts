import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketRelay } from '../websocket-relay.js';
import { MockWebSocket, createTestEnvelope } from './test-helpers.js';

describe('WebSocketRelay', () => {
  let createdSockets: MockWebSocket[];

  beforeEach(() => {
    createdSockets = [];
    vi.stubGlobal('WebSocket', class extends MockWebSocket {
      constructor(url: string) {
        super(url);
        createdSockets.push(this);
      }

      // Expose static constants so readyState comparisons work
      static override CONNECTING = 0;
      static override OPEN = 1;
      static override CLOSING = 2;
      static override CLOSED = 3;
    });

    // Also stub the WebSocket constants at instance level for checks
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
    it('connects to the configured URL', () => {
      const relay = new WebSocketRelay({ url: 'ws://192.168.1.50:4117' });
      relay.listen(() => {});

      expect(createdSockets).toHaveLength(1);
      expect(createdSockets[0].url).toBe('ws://192.168.1.50:4117');

      relay.close();
    });

    it('delivers valid EventEnvelopes to the listener', () => {
      const relay = new WebSocketRelay({ url: 'ws://test:4117' });
      const received: unknown[] = [];

      relay.listen((envelope) => received.push(envelope));

      const ws = createdSockets[0];
      ws.simulateOpen();

      const envelope = createTestEnvelope();
      ws.simulateMessage(JSON.stringify(envelope));

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(envelope);

      relay.close();
    });

    it('silently ignores malformed messages', () => {
      const relay = new WebSocketRelay({ url: 'ws://test:4117' });
      const received: unknown[] = [];

      relay.listen((envelope) => received.push(envelope));

      const ws = createdSockets[0];
      ws.simulateOpen();

      ws.simulateMessage('garbage');
      ws.simulateMessage(JSON.stringify({ not: 'an envelope' }));
      ws.simulateMessage('');

      expect(received).toHaveLength(0);

      relay.close();
    });

    it('replaces previous listener and reconnects', () => {
      const relay = new WebSocketRelay({ url: 'ws://test:4117' });
      const received1: unknown[] = [];
      const received2: unknown[] = [];

      relay.listen((e) => received1.push(e));
      const ws1 = createdSockets[0];
      ws1.simulateOpen();

      relay.listen((e) => received2.push(e));
      const ws2 = createdSockets[createdSockets.length - 1];
      ws2.simulateOpen();

      const envelope = createTestEnvelope();
      ws2.simulateMessage(JSON.stringify(envelope));

      expect(received1).toHaveLength(0);
      expect(received2).toHaveLength(1);

      relay.close();
    });
  });

  describe('publish()', () => {
    it('sends serialized envelope over the WebSocket', async () => {
      const relay = new WebSocketRelay({ url: 'ws://test:4117' });
      relay.listen(() => {});

      const ws = createdSockets[0];
      ws.simulateOpen();

      const envelope = createTestEnvelope();
      await relay.publish(envelope);

      expect(ws.sentMessages).toHaveLength(1);
      expect(JSON.parse(ws.sentMessages[0])).toEqual(envelope);

      relay.close();
    });

    it('throws when not connected', async () => {
      const relay = new WebSocketRelay({ url: 'ws://test:4117' });

      await expect(relay.publish(createTestEnvelope())).rejects.toThrow(
        'WebSocket relay not connected',
      );

      relay.close();
    });
  });

  describe('isAvailable()', () => {
    it('returns false before connection', () => {
      const relay = new WebSocketRelay({ url: 'ws://test:4117' });
      expect(relay.isAvailable()).toBe(false);
    });

    it('returns true when connected', () => {
      const relay = new WebSocketRelay({ url: 'ws://test:4117' });
      relay.listen(() => {});

      const ws = createdSockets[0];
      ws.simulateOpen();

      expect(relay.isAvailable()).toBe(true);

      relay.close();
    });

    it('returns false after disconnect', () => {
      const relay = new WebSocketRelay({ url: 'ws://test:4117' });
      relay.listen(() => {});

      const ws = createdSockets[0];
      ws.simulateOpen();
      expect(relay.isAvailable()).toBe(true);

      relay.close();
      expect(relay.isAvailable()).toBe(false);
    });
  });

  describe('getConnectionState()', () => {
    it('transitions through disconnected → connecting → connected', () => {
      const relay = new WebSocketRelay({ url: 'ws://test:4117' });

      expect(relay.getConnectionState()).toBe('disconnected');

      relay.listen(() => {});
      expect(relay.getConnectionState()).toBe('connecting');

      const ws = createdSockets[0];
      ws.simulateOpen();
      expect(relay.getConnectionState()).toBe('connected');

      relay.close();
      expect(relay.getConnectionState()).toBe('disconnected');
    });
  });

  describe('reconnection', () => {
    it('reconnects with exponential backoff after disconnect', () => {
      const relay = new WebSocketRelay({
        url: 'ws://test:4117',
        reconnectDelay: 100,
      });

      relay.listen(() => {});
      const ws1 = createdSockets[0];
      ws1.simulateOpen();
      ws1.simulateClose();

      expect(relay.getConnectionState()).toBe('disconnected');

      // First reconnect at 100ms
      vi.advanceTimersByTime(100);
      expect(createdSockets).toHaveLength(2);

      // Simulate another failure
      createdSockets[1].simulateClose();

      // Second reconnect at 200ms (doubled)
      vi.advanceTimersByTime(100);
      expect(createdSockets).toHaveLength(2); // not yet
      vi.advanceTimersByTime(100);
      expect(createdSockets).toHaveLength(3);

      relay.close();
    });

    it('stops reconnecting after maxReconnectAttempts', () => {
      const relay = new WebSocketRelay({
        url: 'ws://test:4117',
        reconnectDelay: 100,
        maxReconnectAttempts: 2,
      });

      relay.listen(() => {});
      createdSockets[0].simulateClose();

      // Attempt 1
      vi.advanceTimersByTime(100);
      expect(createdSockets).toHaveLength(2);
      createdSockets[1].simulateClose();

      // Attempt 2
      vi.advanceTimersByTime(200);
      expect(createdSockets).toHaveLength(3);
      createdSockets[2].simulateClose();

      // No more attempts
      vi.advanceTimersByTime(10000);
      expect(createdSockets).toHaveLength(3);

      relay.close();
    });

    it('does not reconnect after close()', () => {
      const relay = new WebSocketRelay({
        url: 'ws://test:4117',
        reconnectDelay: 100,
      });

      relay.listen(() => {});
      createdSockets[0].simulateOpen();

      relay.close();

      vi.advanceTimersByTime(10000);
      expect(createdSockets).toHaveLength(1);
    });
  });

  describe('setUrl()', () => {
    it('reconnects to new URL when listening', () => {
      const relay = new WebSocketRelay({ url: 'ws://old:4117' });
      relay.listen(() => {});
      createdSockets[0].simulateOpen();

      relay.setUrl('ws://new:4117');

      const latest = createdSockets[createdSockets.length - 1];
      expect(latest.url).toBe('ws://new:4117');

      relay.close();
    });
  });

  describe('no URL configured', () => {
    it('stays disconnected if no URL is provided', () => {
      const relay = new WebSocketRelay();
      relay.listen(() => {});

      expect(relay.getConnectionState()).toBe('disconnected');
      expect(relay.isAvailable()).toBe(false);
      expect(createdSockets).toHaveLength(0);

      relay.close();
    });
  });
});
