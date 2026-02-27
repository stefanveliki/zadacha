import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RelayPool } from '../relay-pool.js';
import { MockWebSocket, createWrappedNostrEvent } from './test-helpers.js';

describe('RelayPool', () => {
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

    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('connect()', () => {
    it('creates WebSocket connections for all relays', () => {
      const pool = new RelayPool(['wss://relay-a.test', 'wss://relay-b.test']);
      pool.connect();

      expect(createdSockets).toHaveLength(2);
      expect(createdSockets[0].url).toBe('wss://relay-a.test');
      expect(createdSockets[1].url).toBe('wss://relay-b.test');

      pool.close();
    });

    it('does not create duplicate connections for the same relay', () => {
      const pool = new RelayPool(['wss://relay.test']);
      pool.connect();
      pool.connect(); // second call should be a no-op

      expect(createdSockets).toHaveLength(1);

      pool.close();
    });
  });

  describe('addRelay() / removeRelay()', () => {
    it('adds a relay that connects on the next connect()', () => {
      const pool = new RelayPool();
      pool.addRelay('wss://new-relay.test');
      pool.connect();

      expect(createdSockets).toHaveLength(1);
      expect(createdSockets[0].url).toBe('wss://new-relay.test');

      pool.close();
    });

    it('removes a relay and disconnects it', () => {
      const pool = new RelayPool(['wss://relay.test']);
      pool.connect();
      createdSockets[0].simulateOpen();

      expect(pool.isConnected()).toBe(true);

      pool.removeRelay('wss://relay.test');
      expect(pool.isConnected()).toBe(false);

      pool.close();
    });

    it('ignores duplicate addRelay calls', () => {
      const pool = new RelayPool();
      pool.addRelay('wss://relay.test');
      pool.addRelay('wss://relay.test');
      pool.connect();

      expect(createdSockets).toHaveLength(1);

      pool.close();
    });
  });

  describe('isConnected() / getConnectedCount()', () => {
    it('returns false when no relays are connected', () => {
      const pool = new RelayPool(['wss://relay.test']);
      expect(pool.isConnected()).toBe(false);

      pool.connect();
      // Still connecting, not open yet
      expect(pool.isConnected()).toBe(false);

      pool.close();
    });

    it('returns true when at least one relay is connected', () => {
      const pool = new RelayPool(['wss://relay-a.test', 'wss://relay-b.test']);
      pool.connect();

      createdSockets[0].simulateOpen();

      expect(pool.isConnected()).toBe(true);
      expect(pool.getConnectedCount()).toBe(1);

      createdSockets[1].simulateOpen();
      expect(pool.getConnectedCount()).toBe(2);

      pool.close();
    });
  });

  describe('publish()', () => {
    it('sends EVENT message to all connected relays', async () => {
      const pool = new RelayPool(['wss://relay-a.test', 'wss://relay-b.test']);
      pool.connect();
      createdSockets[0].simulateOpen();
      createdSockets[1].simulateOpen();

      const nostrEvent = createWrappedNostrEvent();
      await pool.publish(nostrEvent);

      for (const ws of createdSockets) {
        expect(ws.sentMessages).toHaveLength(1);
        const msg = JSON.parse(ws.sentMessages[0]);
        expect(msg[0]).toBe('EVENT');
        expect(msg[1].id).toBe(nostrEvent.id);
      }

      pool.close();
    });

    it('skips disconnected relays without failing', async () => {
      const pool = new RelayPool(['wss://relay-a.test', 'wss://relay-b.test']);
      pool.connect();

      // Only connect the first relay
      createdSockets[0].simulateOpen();

      const nostrEvent = createWrappedNostrEvent();
      await pool.publish(nostrEvent);

      expect(createdSockets[0].sentMessages).toHaveLength(1);
      // relay-b never received anything (still connecting)

      pool.close();
    });

    it('rejects when no relays are connected', async () => {
      const pool = new RelayPool(['wss://relay.test']);
      pool.connect();
      // Don't open any sockets

      const nostrEvent = createWrappedNostrEvent();
      await expect(pool.publish(nostrEvent)).rejects.toThrow('No relays connected');

      pool.close();
    });
  });

  describe('subscribe()', () => {
    it('sends REQ message to all connected relays', () => {
      const pool = new RelayPool(['wss://relay-a.test', 'wss://relay-b.test']);
      pool.connect();
      createdSockets[0].simulateOpen();
      createdSockets[1].simulateOpen();

      pool.subscribe('sub-1', { kinds: [4333], '#t': ['rural-run'] });

      for (const ws of createdSockets) {
        expect(ws.sentMessages).toHaveLength(1);
        const msg = JSON.parse(ws.sentMessages[0]);
        expect(msg[0]).toBe('REQ');
        expect(msg[1]).toBe('sub-1');
        expect(msg[2].kinds).toEqual([4333]);
      }

      pool.close();
    });

    it('re-sends subscriptions when a relay reconnects', () => {
      const pool = new RelayPool(['wss://relay.test']);
      pool.connect();
      createdSockets[0].simulateOpen();

      pool.subscribe('sub-1', { kinds: [4333] });
      expect(createdSockets[0].sentMessages).toHaveLength(1);

      // Simulate disconnect and reconnect
      createdSockets[0].simulateClose();
      vi.advanceTimersByTime(2000); // trigger reconnect

      // New socket created
      expect(createdSockets).toHaveLength(2);
      createdSockets[1].simulateOpen();

      // Subscription re-sent on the new socket
      expect(createdSockets[1].sentMessages).toHaveLength(1);
      const msg = JSON.parse(createdSockets[1].sentMessages[0]);
      expect(msg[0]).toBe('REQ');
      expect(msg[1]).toBe('sub-1');

      pool.close();
    });
  });

  describe('unsubscribe()', () => {
    it('sends CLOSE message to all connected relays', () => {
      const pool = new RelayPool(['wss://relay.test']);
      pool.connect();
      createdSockets[0].simulateOpen();

      pool.subscribe('sub-1', { kinds: [4333] });
      pool.unsubscribe('sub-1');

      const msgs = createdSockets[0].sentMessages.map((m) => JSON.parse(m));
      expect(msgs[1][0]).toBe('CLOSE');
      expect(msgs[1][1]).toBe('sub-1');

      pool.close();
    });
  });

  describe('event reception', () => {
    it('calls onEvent callback when EVENT message received', () => {
      const pool = new RelayPool(['wss://relay.test']);
      const received: unknown[] = [];
      pool.onEvent((event) => received.push(event));

      pool.connect();
      createdSockets[0].simulateOpen();

      const nostrEvent = createWrappedNostrEvent();
      createdSockets[0].simulateMessage(
        JSON.stringify(['EVENT', 'sub-1', nostrEvent]),
      );

      expect(received).toHaveLength(1);
      expect((received[0] as { id: string }).id).toBe(nostrEvent.id);

      pool.close();
    });

    it('deduplicates events by Nostr event id across relays', () => {
      const pool = new RelayPool(['wss://relay-a.test', 'wss://relay-b.test']);
      const received: unknown[] = [];
      pool.onEvent((event) => received.push(event));

      pool.connect();
      createdSockets[0].simulateOpen();
      createdSockets[1].simulateOpen();

      const nostrEvent = createWrappedNostrEvent();
      const msg = JSON.stringify(['EVENT', 'sub-1', nostrEvent]);

      // Same event from both relays
      createdSockets[0].simulateMessage(msg);
      createdSockets[1].simulateMessage(msg);

      expect(received).toHaveLength(1); // deduplicated

      pool.close();
    });

    it('delivers different events from different relays', () => {
      const pool = new RelayPool(['wss://relay-a.test', 'wss://relay-b.test']);
      const received: unknown[] = [];
      pool.onEvent((event) => received.push(event));

      pool.connect();
      createdSockets[0].simulateOpen();
      createdSockets[1].simulateOpen();

      const event1 = createWrappedNostrEvent(undefined, { id: 'event-1' });
      const event2 = createWrappedNostrEvent(undefined, { id: 'event-2' });

      createdSockets[0].simulateMessage(JSON.stringify(['EVENT', 'sub-1', event1]));
      createdSockets[1].simulateMessage(JSON.stringify(['EVENT', 'sub-1', event2]));

      expect(received).toHaveLength(2);

      pool.close();
    });

    it('ignores malformed messages', () => {
      const pool = new RelayPool(['wss://relay.test']);
      const received: unknown[] = [];
      pool.onEvent((event) => received.push(event));

      pool.connect();
      createdSockets[0].simulateOpen();

      createdSockets[0].simulateMessage('not json');
      createdSockets[0].simulateMessage(JSON.stringify({ not: 'an array' }));
      createdSockets[0].simulateMessage(JSON.stringify(['UNKNOWN', 'data']));

      expect(received).toHaveLength(0);

      pool.close();
    });

    it('ignores EVENT messages with missing event id', () => {
      const pool = new RelayPool(['wss://relay.test']);
      const received: unknown[] = [];
      pool.onEvent((event) => received.push(event));

      pool.connect();
      createdSockets[0].simulateOpen();

      createdSockets[0].simulateMessage(
        JSON.stringify(['EVENT', 'sub-1', { kind: 4333 }]),
      );

      expect(received).toHaveLength(0);

      pool.close();
    });
  });

  describe('auto-reconnect', () => {
    it('reconnects with exponential backoff after disconnect', () => {
      const pool = new RelayPool(['wss://relay.test']);
      pool.connect();
      createdSockets[0].simulateOpen();
      createdSockets[0].simulateClose();

      // First reconnect after 1s
      expect(createdSockets).toHaveLength(1);
      vi.advanceTimersByTime(1000);
      expect(createdSockets).toHaveLength(2);

      // Second disconnect
      createdSockets[1].simulateClose();

      // Second reconnect after 2s
      vi.advanceTimersByTime(1999);
      expect(createdSockets).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(createdSockets).toHaveLength(3);

      pool.close();
    });

    it('caps reconnect delay at maxReconnectDelay', () => {
      const pool = new RelayPool(['wss://relay.test'], { maxReconnectDelay: 5000 });
      pool.connect();

      // Simulate many disconnects to push backoff high
      for (let i = 0; i < 20; i++) {
        const ws = createdSockets[createdSockets.length - 1];
        ws.simulateOpen();
        ws.simulateClose();
        vi.advanceTimersByTime(60000); // advance past any delay
      }

      // The reconnect delay should never exceed 5000ms
      const lastWs = createdSockets[createdSockets.length - 1];
      lastWs.simulateOpen();
      lastWs.simulateClose();

      const countBefore = createdSockets.length;
      vi.advanceTimersByTime(5000);
      expect(createdSockets.length).toBe(countBefore + 1);

      pool.close();
    });
  });

  describe('getRelayStatuses()', () => {
    it('returns status for each relay', () => {
      const pool = new RelayPool(['wss://relay-a.test', 'wss://relay-b.test']);
      pool.connect();

      createdSockets[0].simulateOpen();
      // relay-b stays connecting

      const statuses = pool.getRelayStatuses();
      expect(statuses).toHaveLength(2);
      expect(statuses).toContainEqual({ url: 'wss://relay-a.test', state: 'connected' });
      expect(statuses).toContainEqual({ url: 'wss://relay-b.test', state: 'connecting' });

      pool.close();
    });
  });

  describe('close()', () => {
    it('disconnects all relays and clears state', () => {
      const pool = new RelayPool(['wss://relay.test']);
      const received: unknown[] = [];
      pool.onEvent((event) => received.push(event));

      pool.connect();
      createdSockets[0].simulateOpen();

      pool.close();

      expect(pool.isConnected()).toBe(false);
      expect(pool.getConnectedCount()).toBe(0);

      pool.close();
    });
  });
});
