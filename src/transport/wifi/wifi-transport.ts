/**
 * WiFiTransport — TransportAdapter implementation for local WiFi.
 *
 * Combines two sub-transports behind a single TransportAdapter interface:
 *
 * 1. **WebSocket relay** — cross-device communication via a local hub
 *    (community Pi). This is the primary cross-device channel.
 *
 * 2. **BroadcastChannel** — same-device / same-origin communication between
 *    tabs, windows, and service workers. Zero infrastructure needed.
 *
 * Both fire simultaneously on publish. Both feed into the same listener on
 * receive. The Log layer deduplicates by event id — this transport does not
 * need to.
 *
 * ## What about raw UDP?
 *
 * Raw UDP broadcast on the local subnet is the ideal WiFi transport — it
 * requires no hub and reaches all devices on the LAN. However, the browser
 * WebSocket/WebRTC sandbox does not allow raw UDP. A native app wrapper
 * (Capacitor, Tauri, etc.) could expose a UDP adapter in the future. That
 * is a separate TransportAdapter implementation, not in scope here.
 */

import type { EventEnvelope, TransportAdapter } from '../../shared/types.js';
import { BroadcastChannelAdapter } from './broadcast-channel.js';
import { WebSocketRelay, type WebSocketRelayConfig } from './websocket-relay.js';
import { HubDiscovery, type HubDiscoveryConfig } from './hub-discovery.js';

export interface WiFiTransportConfig {
  /** WebSocket relay configuration */
  relay?: WebSocketRelayConfig;

  /** Hub discovery configuration */
  discovery?: HubDiscoveryConfig;

  /** If true, skip hub discovery and only use the explicitly configured relay URL */
  skipDiscovery?: boolean;

  /** If true, disable the BroadcastChannel sub-transport */
  disableBroadcastChannel?: boolean;
}

export class WiFiTransport implements TransportAdapter {
  private relay: WebSocketRelay;
  private broadcast: BroadcastChannelAdapter;
  private discovery: HubDiscovery;
  private config: WiFiTransportConfig;
  private listener: ((envelope: EventEnvelope) => void) | null = null;
  private discoveryComplete = false;
  private seenIds: Set<string> = new Set();

  constructor(config: WiFiTransportConfig = {}) {
    this.config = config;
    this.relay = new WebSocketRelay(config.relay);
    this.broadcast = new BroadcastChannelAdapter();
    this.discovery = new HubDiscovery(config.discovery);
  }

  /**
   * Start listening for inbound events from all WiFi sub-transports.
   *
   * Kicks off hub discovery (unless skipped) and begins listening on both
   * the WebSocket relay and BroadcastChannel. Events from either channel
   * are forwarded to the provided callback.
   *
   * Deduplication note: this layer performs lightweight dedup of events seen
   * within the same session to avoid delivering the same event twice to the
   * Log when both sub-transports fire. The Log also deduplicates, so this
   * is a performance optimization, not a correctness requirement.
   */
  listen(onEvent: (envelope: EventEnvelope) => void): void {
    this.listener = onEvent;
    this.seenIds.clear();

    const forward = (envelope: EventEnvelope) => {
      // Skip if we already forwarded this event in this session
      if (this.seenIds.has(envelope.id)) return;
      this.seenIds.add(envelope.id);
      this.pruneSeenIds();

      if (this.listener) {
        this.listener(envelope);
      }
    };

    // Start BroadcastChannel listener
    if (!this.config.disableBroadcastChannel) {
      this.broadcast.listen(forward);
    }

    // Start WebSocket relay — either with explicit URL or via discovery
    if (this.config.skipDiscovery && this.config.relay?.url) {
      this.relay.listen(forward);
      this.discoveryComplete = true;
    } else {
      this.startWithDiscovery(forward);
    }
  }

  /**
   * Publish an event to all available WiFi sub-transports simultaneously.
   *
   * Both channels fire in parallel. Failures on individual channels are
   * tolerated — as long as at least one channel is available, publish
   * succeeds. If no channel is available, the promise rejects.
   */
  async publish(envelope: EventEnvelope): Promise<void> {
    const promises: Promise<void>[] = [];

    if (this.relay.isAvailable()) {
      promises.push(
        this.relay.publish(envelope).catch(() => {
          // Relay publish failed — tolerated if broadcast succeeds
        }),
      );
    }

    if (!this.config.disableBroadcastChannel && this.broadcast.isAvailable()) {
      promises.push(
        this.broadcast.publish(envelope).catch(() => {
          // Broadcast publish failed — tolerated if relay succeeds
        }),
      );
    }

    if (promises.length === 0) {
      throw new Error('WiFi transport unavailable — no sub-transport is connected');
    }

    await Promise.all(promises);
  }

  /**
   * Returns true if any WiFi sub-transport is currently available.
   */
  isAvailable(): boolean {
    const relayUp = this.relay.isAvailable();
    const broadcastUp =
      !this.config.disableBroadcastChannel && this.broadcast.isAvailable();
    return relayUp || broadcastUp;
  }

  /**
   * Close all sub-transports and clean up resources.
   */
  close(): void {
    this.relay.close();
    this.broadcast.close();
    this.listener = null;
    this.seenIds.clear();
    this.discoveryComplete = false;
  }

  /**
   * Manually trigger hub re-discovery. Useful when the network changes.
   */
  async rediscover(): Promise<void> {
    if (this.listener) {
      const forward = this.buildForwarder();
      await this.startWithDiscovery(forward);
    }
  }

  /**
   * Get the current state of sub-transports for diagnostics / UI status.
   */
  getStatus(): WiFiTransportStatus {
    return {
      relay: {
        connected: this.relay.isAvailable(),
        connectionState: this.relay.getConnectionState(),
      },
      broadcast: {
        available: this.broadcast.isAvailable(),
      },
      discoveryComplete: this.discoveryComplete,
    };
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private buildForwarder(): (envelope: EventEnvelope) => void {
    return (envelope: EventEnvelope) => {
      if (this.seenIds.has(envelope.id)) return;
      this.seenIds.add(envelope.id);
      this.pruneSeenIds();

      if (this.listener) {
        this.listener(envelope);
      }
    };
  }

  private async startWithDiscovery(
    forward: (envelope: EventEnvelope) => void,
  ): Promise<void> {
    this.discoveryComplete = false;

    const result = await this.discovery.discover();
    this.discoveryComplete = true;

    if (result) {
      this.relay.setUrl(result.url);
      this.relay.listen(forward);
    }
  }

  /**
   * Prevent the seenIds set from growing unboundedly.
   * Keeps only the most recent entries. Since the Log layer also deduplicates,
   * pruning here is safe — worst case, the Log sees a duplicate it already has.
   */
  private pruneSeenIds(): void {
    const MAX_SEEN = 10_000;
    if (this.seenIds.size > MAX_SEEN) {
      // Drop the oldest half — Set iteration order is insertion order
      const toRemove = this.seenIds.size - MAX_SEEN / 2;
      let removed = 0;
      for (const id of this.seenIds) {
        if (removed >= toRemove) break;
        this.seenIds.delete(id);
        removed++;
      }
    }
  }
}

export interface WiFiTransportStatus {
  relay: {
    connected: boolean;
    connectionState: string;
  };
  broadcast: {
    available: boolean;
  };
  discoveryComplete: boolean;
}
