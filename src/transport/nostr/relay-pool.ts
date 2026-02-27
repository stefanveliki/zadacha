/**
 * RelayPool — manages WebSocket connections to multiple Nostr relays.
 *
 * Publishes to all connected relays simultaneously. Subscribes across
 * all relays and deduplicates inbound events by Nostr event id.
 * Individual relay failures are tolerated — the pool continues with
 * remaining relays.
 */

import type { NostrEvent, NostrFilter } from './nostr-crypto.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RelayConnectionState = 'disconnected' | 'connecting' | 'connected';

export interface RelayStatus {
  url: string;
  state: RelayConnectionState;
}

export interface RelayPoolConfig {
  /** Maximum reconnect delay in ms (default: 60000). */
  maxReconnectDelay?: number;
  /** Maximum number of deduplication ids to track (default: 10000). */
  maxSeenIds?: number;
}

interface RelayEntry {
  url: string;
  ws: WebSocket | null;
  state: RelayConnectionState;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempt: number;
}

interface Subscription {
  id: string;
  filter: NostrFilter;
}

// ---------------------------------------------------------------------------
// RelayPool
// ---------------------------------------------------------------------------

export class RelayPool {
  private relays: Map<string, RelayEntry> = new Map();
  private subscriptions: Map<string, Subscription> = new Map();
  private seenIds: Set<string> = new Set();
  private eventCallback: ((event: NostrEvent) => void) | null = null;
  private maxReconnectDelay: number;
  private maxSeenIds: number;

  constructor(relayUrls: string[] = [], config: RelayPoolConfig = {}) {
    this.maxReconnectDelay = config.maxReconnectDelay ?? 60_000;
    this.maxSeenIds = config.maxSeenIds ?? 10_000;

    for (const url of relayUrls) {
      this.addRelay(url);
    }
  }

  /** Register the callback for all inbound events across all relays. */
  onEvent(callback: (event: NostrEvent) => void): void {
    this.eventCallback = callback;
  }

  /** Add a relay to the pool. Does not connect until `connect()` is called. */
  addRelay(url: string): void {
    if (this.relays.has(url)) return;
    this.relays.set(url, {
      url,
      ws: null,
      state: 'disconnected',
      reconnectTimer: null,
      reconnectAttempt: 0,
    });
  }

  /** Remove a relay from the pool and disconnect it. */
  removeRelay(url: string): void {
    const relay = this.relays.get(url);
    if (!relay) return;
    this.disconnectRelay(relay);
    this.relays.delete(url);
  }

  /** Connect all relays in the pool. */
  connect(): void {
    for (const relay of this.relays.values()) {
      this.connectRelay(relay);
    }
  }

  /** Publish a Nostr event to all connected relays simultaneously. */
  async publish(event: NostrEvent): Promise<void> {
    const msg = JSON.stringify(['EVENT', event]);
    const connected = [...this.relays.values()].filter(
      (r) => r.state === 'connected' && r.ws,
    );

    if (connected.length === 0) {
      throw new Error('No relays connected');
    }

    await Promise.allSettled(
      connected.map((relay) => {
        return new Promise<void>((resolve) => {
          try {
            relay.ws!.send(msg);
          } catch {
            // Individual relay send failure — tolerated
          }
          resolve();
        });
      }),
    );
  }

  /** Send a REQ subscription to all connected relays. */
  subscribe(subscriptionId: string, filter: NostrFilter): void {
    this.subscriptions.set(subscriptionId, { id: subscriptionId, filter });

    const msg = JSON.stringify(['REQ', subscriptionId, filter]);
    for (const relay of this.relays.values()) {
      if (relay.state === 'connected' && relay.ws) {
        try {
          relay.ws.send(msg);
        } catch {
          /* relay send failed — tolerated */
        }
      }
    }
  }

  /** Close a subscription on all relays. */
  unsubscribe(subscriptionId: string): void {
    this.subscriptions.delete(subscriptionId);

    const msg = JSON.stringify(['CLOSE', subscriptionId]);
    for (const relay of this.relays.values()) {
      if (relay.state === 'connected' && relay.ws) {
        try {
          relay.ws.send(msg);
        } catch {
          /* relay send failed — tolerated */
        }
      }
    }
  }

  /** Returns true if at least one relay is connected. */
  isConnected(): boolean {
    for (const relay of this.relays.values()) {
      if (relay.state === 'connected') return true;
    }
    return false;
  }

  /** Returns the number of currently connected relays. */
  getConnectedCount(): number {
    let count = 0;
    for (const relay of this.relays.values()) {
      if (relay.state === 'connected') count++;
    }
    return count;
  }

  /** Returns connection state for each relay in the pool. */
  getRelayStatuses(): RelayStatus[] {
    return [...this.relays.values()].map((r) => ({
      url: r.url,
      state: r.state,
    }));
  }

  /** Disconnect all relays and clean up. */
  close(): void {
    for (const relay of this.relays.values()) {
      this.disconnectRelay(relay);
    }
    this.subscriptions.clear();
    this.seenIds.clear();
    this.eventCallback = null;
  }

  // -------------------------------------------------------------------------
  // Internal — connection management
  // -------------------------------------------------------------------------

  private connectRelay(relay: RelayEntry): void {
    if (relay.state === 'connecting' || relay.state === 'connected') return;

    relay.state = 'connecting';
    try {
      const ws = new WebSocket(relay.url);
      relay.ws = ws;

      ws.onopen = () => {
        relay.state = 'connected';
        relay.reconnectAttempt = 0;
        this.resubscribeRelay(relay);
      };

      ws.onmessage = (event: MessageEvent) => {
        this.handleMessage(String(event.data));
      };

      ws.onclose = () => {
        relay.state = 'disconnected';
        relay.ws = null;
        this.scheduleReconnect(relay);
      };

      ws.onerror = () => {
        // onerror is always followed by onclose — reconnect happens there
      };
    } catch {
      relay.state = 'disconnected';
      this.scheduleReconnect(relay);
    }
  }

  private disconnectRelay(relay: RelayEntry): void {
    if (relay.reconnectTimer !== null) {
      clearTimeout(relay.reconnectTimer);
      relay.reconnectTimer = null;
    }
    if (relay.ws) {
      relay.ws.onopen = null;
      relay.ws.onmessage = null;
      relay.ws.onclose = null;
      relay.ws.onerror = null;
      relay.ws.close();
      relay.ws = null;
    }
    relay.state = 'disconnected';
    relay.reconnectAttempt = 0;
  }

  private scheduleReconnect(relay: RelayEntry): void {
    if (relay.reconnectTimer !== null) return;

    const delay = Math.min(
      1000 * Math.pow(2, relay.reconnectAttempt),
      this.maxReconnectDelay,
    );
    relay.reconnectAttempt++;

    relay.reconnectTimer = setTimeout(() => {
      relay.reconnectTimer = null;
      this.connectRelay(relay);
    }, delay);
  }

  /** Re-send all active subscriptions to a newly-connected relay. */
  private resubscribeRelay(relay: RelayEntry): void {
    if (!relay.ws || relay.state !== 'connected') return;

    for (const sub of this.subscriptions.values()) {
      const msg = JSON.stringify(['REQ', sub.id, sub.filter]);
      try {
        relay.ws.send(msg);
      } catch {
        /* relay send failed */
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal — message handling
  // -------------------------------------------------------------------------

  private handleMessage(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // malformed JSON — ignore
    }

    if (!Array.isArray(msg)) return;

    const type = msg[0];

    if (type === 'EVENT' && msg.length >= 3) {
      const event = msg[2] as NostrEvent;
      if (!event || typeof event.id !== 'string') return;

      // Deduplicate across relays
      if (this.seenIds.has(event.id)) return;
      this.seenIds.add(event.id);
      this.pruneSeenIds();

      if (this.eventCallback) {
        this.eventCallback(event);
      }
    }
    // OK, EOSE, NOTICE — informational, no action needed for transport
  }

  private pruneSeenIds(): void {
    if (this.seenIds.size > this.maxSeenIds) {
      const toRemove = this.seenIds.size - Math.floor(this.maxSeenIds / 2);
      let removed = 0;
      for (const id of this.seenIds) {
        if (removed >= toRemove) break;
        this.seenIds.delete(id);
        removed++;
      }
    }
  }
}
