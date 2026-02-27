/**
 * Rural Run Protocol — Shared Types
 *
 * Canonical type definitions derived from InterfaceContracts v0.1.
 * All layers import from here. No layer redefines these types.
 */

// ---------------------------------------------------------------------------
// Event Envelope — the universal wrapper for every event in the system
// ---------------------------------------------------------------------------

export interface EventEnvelope {
  /** sha256 hash of canonical serialization: [0, pubkey, created_at, kind, content] */
  id: string;

  /** Event kind — see EventKind enum */
  kind: number;

  /** Author's public key, hex-encoded */
  pubkey: string;

  /** Unix timestamp (seconds) */
  created_at: number;

  /** JSON string payload — opaque to transport and log, parsed by state machine */
  content: string;

  /** Author's signature over id, hex-encoded */
  sig: string;
}

// ---------------------------------------------------------------------------
// Event Kind Registry
// ---------------------------------------------------------------------------

export const EventKind = {
  // Coordination events (1–99)
  TRIP_ANNOUNCE: 1,
  NEED_SUBMIT: 2,
  MATCH_ACCEPT: 3,
  MATCH_FULFILL: 4,
  MATCH_CONFIRM: 5,
  SLOT_RELEASE: 6,
  SLOT_RELEASE_ACK: 7,
  TRIP_CLOSE: 8,
  TRIP_CANCEL: 9,

  // Identity events (100+)
  GUARDIAN_SET: 100,
  GUARDIAN_ROTATE: 101,
  KEY_ROTATE: 102,
  RECOVERY_INIT: 103,
  RECOVERY_SHARD: 104,
} as const;

export type EventKindValue = (typeof EventKind)[keyof typeof EventKind];

// ---------------------------------------------------------------------------
// Transport Adapter — the interface every transport implements
// ---------------------------------------------------------------------------

export interface TransportAdapter {
  /** Start listening for inbound events — calls onEvent for each received */
  listen(onEvent: (envelope: EventEnvelope) => void): void;

  /** Publish an event to this transport */
  publish(envelope: EventEnvelope): Promise<void>;

  /** Returns current availability of this transport */
  isAvailable(): boolean;
}

// ---------------------------------------------------------------------------
// Log Filter — used by the Log interface for queries and subscriptions
// ---------------------------------------------------------------------------

export interface LogFilter {
  kinds?: number[];
  pubkeys?: string[];
  since?: number;
  until?: number;
  trip_id?: string;
  need_id?: string;
  limit?: number;
}
