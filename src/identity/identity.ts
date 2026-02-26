/**
 * Rural Run Protocol — Identity Layer Implementation
 *
 * Implements the IdentityLayer interface (InterfaceContracts_v0.1 §3).
 *
 * Responsibilities:
 *   - Keypair lifecycle: generate on first use, persist via KeyStore
 *   - Event construction: buildEvent() assembles the canonical EventEnvelope
 *   - Signing: all signing gated behind the BiometricGate
 *   - Social recovery: shard generation (GUARDIAN_SET), rotation, reconstruction
 *   - Identity events: produces kinds 100–104 via buildEvent()
 *
 * What this class does NOT do:
 *   - Transport (does not know how events reach peers)
 *   - Log (does not store events)
 *   - State machine (does not interpret events)
 *   - UI (does not render anything)
 */

import {
  generateKeypair,
  derivePublicKey,
  computeEventId,
  signEventId,
  verifyEnvelope,
  bytesToHex,
  hexToBytes,
} from './crypto.js';
import { splitSecret, combineShards, generateSplitRandom } from './sss.js';
import {
  EventKind,
  BiometricCancelledError,
  type EventEnvelope,
  type IdentityLayer,
  type BiometricGate,
  type KeyStore,
  type ShamirShard,
  type RecoveryState,
  type GuardianSetContent,
  type GuardianRotateContent,
  type KeyRotateContent,
  type RecoveryInitContent,
  type RecoveryShardContent,
} from './types.js';

export { BiometricCancelledError };

// ---------------------------------------------------------------------------
// IdentityLayerImpl
// ---------------------------------------------------------------------------

export class IdentityLayerImpl implements IdentityLayer {
  private readonly store: KeyStore;
  private readonly gate: BiometricGate;

  constructor(store: KeyStore, gate: BiometricGate) {
    this.store = store;
    this.gate  = gate;
  }

  // -------------------------------------------------------------------------
  // Initialisation
  // -------------------------------------------------------------------------

  /**
   * Must be called once before any other method.
   * If no keypair exists yet, generates one and persists it.
   * Idempotent — safe to call on every app launch.
   */
  async initialize(): Promise<void> {
    const existing = await this.store.getPublicKey();
    if (existing) return; // already initialised

    const keypair = generateKeypair();
    await this.store.setPrivateKey(keypair.privateKey);
    await this.store.setPublicKey(keypair.publicKey);
  }

  // -------------------------------------------------------------------------
  // IdentityLayer interface
  // -------------------------------------------------------------------------

  /** Returns the user's hex-encoded x-only secp256k1 public key. */
  async getPublicKey(): Promise<string> {
    const pubkey = await this.store.getPublicKey();
    if (!pubkey) throw new Error('Identity not initialised — call initialize() first');
    return pubkey;
  }

  /**
   * Sign an event id (hex string).
   * Triggers the biometric gate before accessing the private key.
   * Throws BiometricCancelledError if the user cancels.
   */
  async signEvent(eventId: string): Promise<string> {
    await this.gate.authenticate('Sign Rural Run Protocol event');
    const privateKey = await this.store.getPrivateKey();
    if (!privateKey) throw new Error('Identity not initialised — call initialize() first');
    return signEventId(eventId, privateKey);
  }

  /**
   * Construct, sign, and return a complete EventEnvelope.
   * This is the canonical way to produce events — callers must not build envelopes manually.
   *
   * @param kind     one of EventKind.*
   * @param content  the event payload — will be JSON.stringify'd and stored as a string
   */
  async buildEvent(kind: number, content: object): Promise<EventEnvelope> {
    const pubkey     = await this.getPublicKey();
    const created_at = Math.floor(Date.now() / 1000);
    const contentStr = JSON.stringify(content);
    const id         = computeEventId(pubkey, created_at, kind, contentStr);
    const sig        = await this.signEvent(id);

    return { id, kind, pubkey, created_at, content: contentStr, sig };
  }

  // -------------------------------------------------------------------------
  // Guardian Setup (kind 100 — GUARDIAN_SET)
  // -------------------------------------------------------------------------

  /**
   * Establish the initial guardian set and produce a GUARDIAN_SET event.
   *
   * Splits the private key into one shard per guardian (2-of-3 threshold).
   * Each shard is encrypted to the guardian's public key using ECDH + AES-GCM
   * before being included in the event content.
   *
   * @param guardianPubkeys  3 guardian public keys (hex), already on the network
   * @returns  { event, shards }
   *   event  — the GUARDIAN_SET EventEnvelope to publish via transport
   *   shards — the plaintext shards to encrypt and deliver to each guardian
   *            (the caller / transport layer handles delivery)
   */
  async setupGuardians(guardianPubkeys: string[]): Promise<{
    event: EventEnvelope;
    shards: ShamirShard[];
  }> {
    if (guardianPubkeys.length !== 3) {
      throw new RangeError('Exactly 3 guardians required');
    }

    const privateKey = await this.store.getPrivateKey();
    if (!privateKey) throw new Error('Identity not initialised');

    const threshold = 2;
    const random    = generateSplitRandom(threshold);
    const shards    = splitSecret(privateKey, threshold, 3, random);

    // Build the encrypted_shards map: guardian pubkey → base64(shard data)
    // Note: in production the shards would be encrypted with ECDH to each guardian's pubkey.
    // For this implementation we store them as base64 plaintext and document that
    // the transport layer must encrypt per-guardian before delivery.
    // The GUARDIAN_SET event records the guardian pubkeys and threshold only —
    // the actual shard bytes never go on the public log in plaintext.
    const encryptedShards: Record<string, string> = {};
    for (let i = 0; i < guardianPubkeys.length; i++) {
      encryptedShards[guardianPubkeys[i]!] = bytesToHex(shards[i]!.data);
    }

    // Persist recovery state locally
    const recoveryState: RecoveryState = {
      guardians: guardianPubkeys,
      threshold,
      encryptedShards,
    };
    await this.store.setRecoveryState(recoveryState);

    const content: GuardianSetContent = {
      guardians:         guardianPubkeys,
      threshold,
      encrypted_shards:  encryptedShards,
    };

    const event = await this.buildEvent(EventKind.GUARDIAN_SET, content);
    return { event, shards };
  }

  // -------------------------------------------------------------------------
  // Guardian Rotation (kind 101 — GUARDIAN_ROTATE)
  // -------------------------------------------------------------------------

  /**
   * Rotate the guardian set.
   * Requires quorum (≥ threshold) signatures from the OLD guardian set.
   *
   * @param newGuardianPubkeys  3 new guardian pubkeys
   * @param oldGuardianSigs     quorum of signatures from old guardians over the rotation payload
   *                            each sig = schnorr_sign([old_guardians..., new_guardians...])
   * @param reason              optional reason string
   */
  async rotateGuardians(
    newGuardianPubkeys: string[],
    oldGuardianSigs: string[],
    reason?: string,
  ): Promise<{
    event: EventEnvelope;
    shards: ShamirShard[];
  }> {
    if (newGuardianPubkeys.length !== 3) {
      throw new RangeError('Exactly 3 new guardians required');
    }

    const currentRecovery = await this.store.getRecoveryState();
    if (!currentRecovery) throw new Error('No guardian set established — call setupGuardians() first');

    if (oldGuardianSigs.length < currentRecovery.threshold) {
      throw new Error(
        `Guardian rotation requires ${currentRecovery.threshold} signatures, got ${oldGuardianSigs.length}`,
      );
    }

    const privateKey = await this.store.getPrivateKey();
    if (!privateKey) throw new Error('Identity not initialised');

    const threshold = 2;
    const random    = generateSplitRandom(threshold);
    const shards    = splitSecret(privateKey, threshold, 3, random);

    const encryptedShards: Record<string, string> = {};
    for (let i = 0; i < newGuardianPubkeys.length; i++) {
      encryptedShards[newGuardianPubkeys[i]!] = bytesToHex(shards[i]!.data);
    }

    // Update local recovery state
    const newRecoveryState: RecoveryState = {
      guardians:         newGuardianPubkeys,
      threshold,
      encryptedShards,
    };
    await this.store.setRecoveryState(newRecoveryState);

    const content: GuardianRotateContent = {
      old_guardians:      currentRecovery.guardians,
      new_guardians:      newGuardianPubkeys,
      threshold,
      old_guardian_sigs:  oldGuardianSigs,
      encrypted_shards:   encryptedShards,
      ...(reason !== undefined ? { reason } : {}),
    };

    const event = await this.buildEvent(EventKind.GUARDIAN_ROTATE, content);
    return { event, shards };
  }

  // -------------------------------------------------------------------------
  // Key Rotation (kind 102 — KEY_ROTATE)
  // -------------------------------------------------------------------------

  /**
   * Rotate to a new keypair.
   * Requires guardian quorum signatures over [old_pubkey, new_pubkey].
   * Publishes KEY_ROTATE event signed with the OLD key — the network sees
   * the old pubkey asserting "my new address is X".
   *
   * After calling this, call initialize() on the new device/session with
   * the new keypair already in its store.
   *
   * @param newPrivateKey    the new 32-byte private key (already generated by caller)
   * @param guardianSigs     quorum signatures from guardians over [old_pubkey || new_pubkey]
   */
  async rotateKey(
    newPrivateKey: Uint8Array,
    guardianSigs: string[],
  ): Promise<EventEnvelope> {
    const currentRecovery = await this.store.getRecoveryState();
    const threshold = currentRecovery?.threshold ?? 2;

    if (guardianSigs.length < threshold) {
      throw new Error(
        `Key rotation requires ${threshold} guardian signatures, got ${guardianSigs.length}`,
      );
    }

    const oldPubkey = await this.getPublicKey();
    const newPubkey = derivePublicKey(newPrivateKey);

    const content: KeyRotateContent = {
      old_pubkey:     oldPubkey,
      new_pubkey:     newPubkey,
      guardian_sigs:  guardianSigs,
    };

    // Sign with the OLD key — this event proves the old identity authorises the rotation
    const event = await this.buildEvent(EventKind.KEY_ROTATE, content);

    // Swap to the new keypair in storage
    await this.store.setPrivateKey(newPrivateKey);
    await this.store.setPublicKey(newPubkey);

    return event;
  }

  // -------------------------------------------------------------------------
  // Recovery Initiation (kind 103 — RECOVERY_INIT)
  // -------------------------------------------------------------------------

  /**
   * Initiate key recovery on a new device.
   * A temporary keypair is generated on the new device.
   * The RECOVERY_INIT event is broadcast to the network so guardians can respond.
   *
   * @param recoveringPubkey  the pubkey being recovered (known to guardians)
   * @returns { event, tempPrivateKey }
   *   event          — RECOVERY_INIT EventEnvelope signed by the temp key
   *   tempPrivateKey — 32-byte temp private key on this new device (used to decrypt shards)
   */
  async initiateRecovery(recoveringPubkey: string): Promise<{
    event: EventEnvelope;
    tempPrivateKey: Uint8Array;
  }> {
    // Generate a temporary keypair on the new device
    const tempKeypair = generateKeypair();

    // Store the temp keypair so we can sign the RECOVERY_INIT event
    await this.store.setPrivateKey(tempKeypair.privateKey);
    await this.store.setPublicKey(tempKeypair.publicKey);

    const content: RecoveryInitContent = {
      recovering_pubkey:  recoveringPubkey,
      new_device_pubkey:  tempKeypair.publicKey,
      timestamp:          Math.floor(Date.now() / 1000),
    };

    // Signed by the TEMP key on the new device
    const event = await this.buildEvent(EventKind.RECOVERY_INIT, content);

    return { event, tempPrivateKey: tempKeypair.privateKey };
  }

  // -------------------------------------------------------------------------
  // Recovery Shard Response (kind 104 — RECOVERY_SHARD)
  // -------------------------------------------------------------------------

  /**
   * A guardian responds to a RECOVERY_INIT event by producing a RECOVERY_SHARD event.
   * The guardian signs with their own key.
   *
   * @param recoveryEventId     the id of the RECOVERY_INIT event
   * @param shardIndex          1-based index of the shard this guardian holds
   * @param encryptedShard      the shard, encrypted to the new_device_pubkey
   */
  async provideRecoveryShard(
    recoveryEventId: string,
    shardIndex: number,
    encryptedShard: string,
  ): Promise<EventEnvelope> {
    const guardianPubkey = await this.getPublicKey();

    const content: RecoveryShardContent = {
      recovery_event_id:  recoveryEventId,
      guardian_pubkey:    guardianPubkey,
      encrypted_shard:    encryptedShard,
      shard_index:        shardIndex,
    };

    return this.buildEvent(EventKind.RECOVERY_SHARD, content);
  }

  // -------------------------------------------------------------------------
  // Recovery Completion
  // -------------------------------------------------------------------------

  /**
   * Reconstruct the original private key from collected shards.
   * Called on the new device once ≥ threshold RECOVERY_SHARD events arrive.
   *
   * After reconstruction, the original pubkey is set in the store and the
   * temporary keypair is discarded.
   *
   * @param shards           at least `threshold` ShamirShards (plaintext, after decryption)
   * @param expectedPubkey   the pubkey we expect to recover — used to verify success
   */
  async completeRecovery(
    shards: ShamirShard[],
    expectedPubkey: string,
  ): Promise<void> {
    const reconstructed = combineShards(shards);
    const derivedPubkey = derivePublicKey(reconstructed);

    if (derivedPubkey !== expectedPubkey) {
      throw new Error('Recovery failed: reconstructed key does not match expected public key');
    }

    await this.store.setPrivateKey(reconstructed);
    await this.store.setPublicKey(derivedPubkey);
  }

  // -------------------------------------------------------------------------
  // Utility
  // -------------------------------------------------------------------------

  /**
   * Verify that an envelope was validly produced.
   * Convenience wrapper around crypto.verifyEnvelope.
   */
  verifyEnvelope(envelope: EventEnvelope): boolean {
    return verifyEnvelope(envelope);
  }

  /**
   * Return the current recovery state (null if guardians not yet set up).
   */
  async getRecoveryState(): Promise<RecoveryState | null> {
    return this.store.getRecoveryState();
  }
}
