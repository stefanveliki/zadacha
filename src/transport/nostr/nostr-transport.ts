/**
 * NostrTransport — TransportAdapter implementation for Nostr relays.
 *
 * Priority 4 transport (internet fallback). Publishes EventEnvelopes
 * to all configured Nostr relays simultaneously and subscribes for
 * inbound events matching the Rural Run protocol filter.
 *
 * EventEnvelopes are wrapped in Nostr-native events for relay
 * compatibility — the wrapper is signed with an ephemeral transport
 * keypair. The real protocol signatures live inside the envelope.
 */

import type { EventEnvelope, TransportAdapter } from '../../shared/types.js';
import { generatePrivateKey, type NostrEvent } from './nostr-crypto.js';
import { wrapEnvelope, unwrapEnvelope, buildRuralRunFilter, RURAL_RUN_NOSTR_KIND } from './event-bridge.js';
import { RelayPool, type RelayPoolConfig } from './relay-pool.js';
import { RelayListManager, type RelayListConfig } from './relay-list.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface NostrTransportConfig {
  /** Relay list configuration (IPFS CID, gateway, defaults). */
  relayList?: RelayListConfig;

  /** Relay pool configuration (reconnect delays, dedup limits). */
  pool?: RelayPoolConfig;

  /** Custom Nostr kind for Rural Run events (default: 4333). */
  nostrKind?: number;

  /** Inner envelope kinds to subscribe to (default: all Rural Run kinds). */
  subscriptionKinds?: number[];

  /** Subscribe to events created after this unix timestamp. */
  subscribeSince?: number;
}

export interface NostrTransportStatus {
  available: boolean;
  connectedRelays: number;
  totalRelays: number;
  relays: Array<{ url: string; state: string }>;
}

// ---------------------------------------------------------------------------
// NostrTransport
// ---------------------------------------------------------------------------

const SUBSCRIPTION_ID = 'rural-run-main';

export class NostrTransport implements TransportAdapter {
  private pool: RelayPool;
  private relayListManager: RelayListManager;
  private privateKey: Uint8Array;
  private nostrKind: number;
  private config: NostrTransportConfig;
  private listener: ((envelope: EventEnvelope) => void) | null = null;
  private initialized = false;

  constructor(config: NostrTransportConfig = {}) {
    this.config = config;
    this.nostrKind = config.nostrKind ?? RURAL_RUN_NOSTR_KIND;
    this.privateKey = generatePrivateKey();
    this.pool = new RelayPool([], config.pool);
    this.relayListManager = new RelayListManager(config.relayList);
  }

  /**
   * Start listening for inbound EventEnvelopes from Nostr relays.
   *
   * Fetches the relay list, connects the pool, and subscribes for
   * Rural Run events. Incoming Nostr events are unwrapped and
   * delivered as EventEnvelopes.
   */
  listen(onEvent: (envelope: EventEnvelope) => void): void {
    this.listener = onEvent;

    // Set up event handler — unwrap Nostr events into EventEnvelopes
    this.pool.onEvent((nostrEvent: NostrEvent) => {
      const envelope = unwrapEnvelope(nostrEvent, this.nostrKind);
      if (envelope && this.listener) {
        this.listener(envelope);
      }
    });

    // Initialize relay connections asynchronously
    this.initializeRelays();
  }

  /**
   * Publish an EventEnvelope to all connected Nostr relays.
   *
   * The envelope is wrapped in a Nostr event signed with the
   * ephemeral transport keypair.
   */
  async publish(envelope: EventEnvelope): Promise<void> {
    if (!this.initialized) {
      await this.initializeRelays();
    }

    const nostrEvent = wrapEnvelope(envelope, this.privateKey, this.nostrKind);
    await this.pool.publish(nostrEvent);
  }

  /**
   * Returns true if internet appears available and at least one relay
   * is connected.
   */
  isAvailable(): boolean {
    const online = typeof navigator !== 'undefined' ? navigator.onLine : true;
    return online && this.pool.isConnected();
  }

  /** Add a community relay at runtime. Connects immediately if pool is active. */
  addRelay(url: string): void {
    this.relayListManager.addCommunityRelay(url);
    this.pool.addRelay(url);
    if (this.initialized) {
      // The pool's connect is idempotent per-relay, but we need to
      // trigger connection for the newly added relay
      this.pool.connect();
    }
  }

  /** Remove a relay at runtime. */
  removeRelay(url: string): void {
    this.relayListManager.removeCommunityRelay(url);
    this.pool.removeRelay(url);
  }

  /** Disconnect all relays and clean up. */
  close(): void {
    this.pool.close();
    this.listener = null;
    this.initialized = false;
  }

  /** Get diagnostic status for UI transport indicators. */
  getStatus(): NostrTransportStatus {
    const statuses = this.pool.getRelayStatuses();
    return {
      available: this.isAvailable(),
      connectedRelays: this.pool.getConnectedCount(),
      totalRelays: statuses.length,
      relays: statuses,
    };
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async initializeRelays(): Promise<void> {
    if (this.initialized) return;

    const relayUrls = await this.relayListManager.getRelays();

    for (const url of relayUrls) {
      this.pool.addRelay(url);
    }

    this.pool.connect();

    // Subscribe for Rural Run events
    const filter = buildRuralRunFilter(
      this.nostrKind,
      this.config.subscriptionKinds,
      this.config.subscribeSince,
    );
    this.pool.subscribe(SUBSCRIPTION_ID, filter);

    this.initialized = true;
  }
}
