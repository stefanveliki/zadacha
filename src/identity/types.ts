/**
 * Rural Run Protocol — Identity Layer Types
 *
 * Canonical types for the Event Envelope and IdentityLayer interface.
 * Defined in InterfaceContracts_v0.1. No other layer may deviate from these shapes.
 */

// ---------------------------------------------------------------------------
// Event Envelope
// ---------------------------------------------------------------------------

/**
 * The universal wrapper for every event in the system.
 * id   = sha256 of canonical serialization [0, pubkey, created_at, kind, content]
 * sig  = Schnorr signature over id (secp256k1), hex-encoded
 */
export interface EventEnvelope {
  id: string;          // sha256 hash, hex-encoded
  kind: number;        // EventKind value
  pubkey: string;      // author's public key, hex-encoded
  created_at: number;  // unix timestamp (seconds)
  content: string;     // JSON string — stored opaquely by the log
  sig: string;         // Schnorr signature over id, hex-encoded
}

// ---------------------------------------------------------------------------
// Event Kind Registry
// ---------------------------------------------------------------------------

export const EventKind = {
  // Coordination events (1–99)
  TRIP_ANNOUNCE:    1,
  NEED_SUBMIT:      2,
  MATCH_ACCEPT:     3,
  MATCH_FULFILL:    4,
  MATCH_CONFIRM:    5,
  SLOT_RELEASE:     6,
  SLOT_RELEASE_ACK: 7,
  TRIP_CLOSE:       8,
  TRIP_CANCEL:      9,

  // Identity events (100–104)
  GUARDIAN_SET:     100,
  GUARDIAN_ROTATE:  101,
  KEY_ROTATE:       102,
  RECOVERY_INIT:    103,
  RECOVERY_SHARD:   104,
} as const;

export type EventKindValue = (typeof EventKind)[keyof typeof EventKind];

// ---------------------------------------------------------------------------
// IdentityLayer Interface  (InterfaceContracts_v0.1 §3)
// ---------------------------------------------------------------------------

export interface IdentityLayer {
  /** Returns the user's public key (hex-encoded secp256k1 x-only pubkey). */
  getPublicKey(): Promise<string>;

  /**
   * Signs an event id using the device secure hardware.
   * A biometric prompt is triggered here if required.
   * Returns hex-encoded Schnorr signature.
   */
  signEvent(eventId: string): Promise<string>;

  /**
   * Constructs, signs, and returns a complete EventEnvelope.
   * Caller provides kind and content object.
   * Identity handles id derivation and sig.
   * This is the preferred method — callers must not construct envelopes manually.
   */
  buildEvent(kind: number, content: object): Promise<EventEnvelope>;
}

// ---------------------------------------------------------------------------
// Social Recovery Types
// ---------------------------------------------------------------------------

/** A single Shamir shard: share index (1-based) + 32 share bytes. */
export interface ShamirShard {
  index: number;        // 1-based share index
  data: Uint8Array;     // 32 bytes — one GF(2^8) share per private key byte
}

/** The recovery state persisted alongside the keypair. */
export interface RecoveryState {
  guardians: string[];       // guardian pubkeys (hex)
  threshold: number;         // minimum shards to reconstruct (default 2)
  /** Encrypted shard per guardian. Key = guardian pubkey hex. */
  encryptedShards: Record<string, string>;  // guardian pubkey → base64 encrypted shard
}

// ---------------------------------------------------------------------------
// Identity Event Content Types
// ---------------------------------------------------------------------------

/** kind 100 — GUARDIAN_SET: initial guardian set established. */
export interface GuardianSetContent {
  guardians: string[];                        // guardian pubkeys, hex
  threshold: number;                          // 2
  encrypted_shards: Record<string, string>;   // guardian pubkey → base64(encrypted shard)
}

/** kind 101 — GUARDIAN_ROTATE: guardian set rotated with old quorum approval. */
export interface GuardianRotateContent {
  old_guardians: string[];
  new_guardians: string[];
  threshold: number;
  old_guardian_sigs: string[];               // signatures from old quorum over rotation payload
  encrypted_shards: Record<string, string>;  // new guardian pubkey → base64(encrypted shard)
  reason?: string;
}

/** kind 102 — KEY_ROTATE: keypair rotated. Links old pubkey to new. */
export interface KeyRotateContent {
  old_pubkey: string;
  new_pubkey: string;
  guardian_sigs: string[];  // quorum signatures over [old_pubkey, new_pubkey]
}

/** kind 103 — RECOVERY_INIT: key recovery initiated on a new device. */
export interface RecoveryInitContent {
  recovering_pubkey: string;   // the pubkey being recovered
  new_device_pubkey: string;   // pubkey generated on the new device (temporary)
  timestamp: number;           // unix timestamp
}

/** kind 104 — RECOVERY_SHARD: guardian provides encrypted shard for recovery. */
export interface RecoveryShardContent {
  recovery_event_id: string;   // id of the RECOVERY_INIT event
  guardian_pubkey: string;     // this guardian's pubkey
  encrypted_shard: string;     // base64 encoded shard, encrypted to new_device_pubkey
  shard_index: number;         // 1-based index of this shard
}

// ---------------------------------------------------------------------------
// BiometricGate Interface
// ---------------------------------------------------------------------------

export interface BiometricGate {
  /** True if the platform supports biometric authentication. */
  isAvailable(): Promise<boolean>;
  /**
   * Prompt the user for biometric / PIN authentication.
   * Returns true on success.
   * Throws BiometricCancelledError if the user cancels.
   * Throws BiometricUnavailableError if the platform cannot authenticate.
   */
  authenticate(reason: string): Promise<boolean>;
  /** Register a biometric credential (first-time setup). */
  setup(userId: string): Promise<void>;
}

export class BiometricCancelledError extends Error {
  constructor() { super('Biometric authentication cancelled by user'); }
}

export class BiometricUnavailableError extends Error {
  constructor(reason?: string) {
    super(reason ?? 'Biometric authentication is not available on this device');
  }
}

// ---------------------------------------------------------------------------
// KeyStore Interface
// ---------------------------------------------------------------------------

export interface KeyStore {
  getPrivateKey(): Promise<Uint8Array | null>;
  setPrivateKey(key: Uint8Array): Promise<void>;
  getPublicKey(): Promise<string | null>;
  setPublicKey(pubkey: string): Promise<void>;
  getRecoveryState(): Promise<RecoveryState | null>;
  setRecoveryState(state: RecoveryState): Promise<void>;
  clear(): Promise<void>;
}
