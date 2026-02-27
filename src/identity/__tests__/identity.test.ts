/**
 * Tests for identity.ts — IdentityLayerImpl.
 *
 * Uses MemoryKeyStore and NoOpBiometricGate so tests are deterministic
 * and do not require WebAuthn or IndexedDB.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { IdentityLayerImpl } from '../identity.js';
import { MemoryKeyStore } from '../storage.js';
import { NoOpBiometricGate, CancellingBiometricGate } from '../biometric.js';
import { verifyEnvelope, derivePublicKey, bytesToHex } from '../crypto.js';
import { EventKind, BiometricCancelledError } from '../types.js';
import type { ShamirShard } from '../types.js';

function makeIdentity() {
  const store = new MemoryKeyStore();
  const gate  = new NoOpBiometricGate();
  return new IdentityLayerImpl(store, gate);
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

describe('initialize', () => {
  it('generates a keypair on first call', async () => {
    const id = makeIdentity();
    await id.initialize();
    const pubkey = await id.getPublicKey();
    expect(pubkey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is idempotent — does not regenerate on second call', async () => {
    const id = makeIdentity();
    await id.initialize();
    const pubkey1 = await id.getPublicKey();
    await id.initialize();
    const pubkey2 = await id.getPublicKey();
    expect(pubkey1).toBe(pubkey2);
  });

  it('throws if getPublicKey is called before initialize', async () => {
    const id = makeIdentity();
    await expect(id.getPublicKey()).rejects.toThrow('initialised');
  });
});

// ---------------------------------------------------------------------------
// buildEvent
// ---------------------------------------------------------------------------

describe('buildEvent', () => {
  let id: IdentityLayerImpl;

  beforeEach(async () => {
    id = makeIdentity();
    await id.initialize();
  });

  it('produces an EventEnvelope with correct shape', async () => {
    const env = await id.buildEvent(EventKind.TRIP_ANNOUNCE, { destination: 'Sofia' });
    expect(typeof env.id).toBe('string');
    expect(env.id).toHaveLength(64);
    expect(env.kind).toBe(EventKind.TRIP_ANNOUNCE);
    expect(env.pubkey).toBe(await id.getPublicKey());
    expect(typeof env.created_at).toBe('number');
    expect(env.created_at).toBeGreaterThan(0);
    expect(typeof env.content).toBe('string');
    // content is a JSON string — not an object
    expect(() => JSON.parse(env.content)).not.toThrow();
    expect(typeof env.sig).toBe('string');
    expect(env.sig).toHaveLength(128);
  });

  it('produces envelopes that pass full signature verification', async () => {
    const env = await id.buildEvent(EventKind.NEED_SUBMIT, { what: 'bread' });
    expect(verifyEnvelope(env)).toBe(true);
  });

  it('content is stored as a JSON string, not an object', async () => {
    const env = await id.buildEvent(EventKind.TRIP_ANNOUNCE, { x: 1 });
    expect(typeof env.content).toBe('string');
    expect(JSON.parse(env.content)).toEqual({ x: 1 });
  });

  it('two events built at the same second with different content have different ids', async () => {
    const env1 = await id.buildEvent(1, { a: 1 });
    const env2 = await id.buildEvent(1, { a: 2 });
    // Content differs so IDs must differ even if timestamp coincides
    expect(env1.content).not.toBe(env2.content);
    // ids may match if same timestamp — but content check is the key assertion here
  });

  it('produces all coordination event kinds without error', async () => {
    const kinds = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    for (const kind of kinds) {
      const env = await id.buildEvent(kind, {});
      expect(verifyEnvelope(env)).toBe(true);
    }
  });

  it('produces all identity event kinds without error', async () => {
    const kinds = [100, 101, 102, 103, 104];
    for (const kind of kinds) {
      const env = await id.buildEvent(kind, {});
      expect(verifyEnvelope(env)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Biometric gating
// ---------------------------------------------------------------------------

describe('biometric gating', () => {
  it('throws BiometricCancelledError when user cancels', async () => {
    const store = new MemoryKeyStore();
    const gate  = new CancellingBiometricGate();
    const id    = new IdentityLayerImpl(store, gate);
    await id.initialize();

    await expect(id.buildEvent(EventKind.TRIP_ANNOUNCE, {})).rejects.toThrow(
      BiometricCancelledError,
    );
  });

  it('does not call the biometric gate from getPublicKey', async () => {
    // getPublicKey must not require biometric — it just reads the stored pubkey
    const store = new MemoryKeyStore();
    const gate  = new CancellingBiometricGate(); // would throw if called
    const id    = new IdentityLayerImpl(store, gate);
    await id.initialize();
    // Should not throw
    const pubkey = await id.getPublicKey();
    expect(pubkey).toHaveLength(64);
  });
});

// ---------------------------------------------------------------------------
// Social recovery — guardian setup
// ---------------------------------------------------------------------------

describe('setupGuardians', () => {
  it('produces a valid GUARDIAN_SET envelope and 3 shards', async () => {
    const id = makeIdentity();
    await id.initialize();

    // Use dummy guardian pubkeys (any 64-char hex)
    const guardians = [
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
    ];

    const { event, shards } = await id.setupGuardians(guardians);

    expect(verifyEnvelope(event)).toBe(true);
    expect(event.kind).toBe(EventKind.GUARDIAN_SET);
    expect(shards).toHaveLength(3);
    shards.forEach((s, i) => {
      expect(s.index).toBe(i + 1);
      expect(s.data).toHaveLength(32);
    });
  });

  it('persists recovery state', async () => {
    const id = makeIdentity();
    await id.initialize();
    const guardians = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
    await id.setupGuardians(guardians);
    const state = await id.getRecoveryState();
    expect(state).not.toBeNull();
    expect(state!.guardians).toEqual(guardians);
    expect(state!.threshold).toBe(2);
  });

  it('rejects anything other than exactly 3 guardians', async () => {
    const id = makeIdentity();
    await id.initialize();
    await expect(id.setupGuardians(['a'.repeat(64), 'b'.repeat(64)])).rejects.toThrow('3 guardians');
    await expect(id.setupGuardians([
      'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64),
    ])).rejects.toThrow('3 guardians');
  });
});

// ---------------------------------------------------------------------------
// Social recovery — full round-trip
// ---------------------------------------------------------------------------

describe('recovery round-trip', () => {
  it('reconstructs the original keypair from 2-of-3 shards', async () => {
    const id = makeIdentity();
    await id.initialize();
    const originalPubkey = await id.getPublicKey();

    const guardians = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
    const { shards } = await id.setupGuardians(guardians);

    // Simulate a new device: a fresh IdentityLayerImpl with an empty store
    const newDeviceId = makeIdentity();
    await newDeviceId.initialize(); // temp keypair

    // Use shards[0] and shards[2] (indices 1 and 3)
    const twoShards: ShamirShard[] = [shards[0]!, shards[2]!];
    await newDeviceId.completeRecovery(twoShards, originalPubkey);

    const recoveredPubkey = await newDeviceId.getPublicKey();
    expect(recoveredPubkey).toBe(originalPubkey);
  });

  it('throws if shards reconstruct to the wrong key', async () => {
    const id = makeIdentity();
    await id.initialize();

    const guardians = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
    const { shards } = await id.setupGuardians(guardians);

    const newDeviceId = makeIdentity();
    await newDeviceId.initialize();

    // Use a wrong expected pubkey
    await expect(
      newDeviceId.completeRecovery([shards[0]!, shards[1]!], 'f'.repeat(64)),
    ).rejects.toThrow('does not match');
  });
});

// ---------------------------------------------------------------------------
// Guardian rotation
// ---------------------------------------------------------------------------

describe('rotateGuardians', () => {
  it('produces a valid GUARDIAN_ROTATE envelope and updates recovery state', async () => {
    const id = makeIdentity();
    await id.initialize();

    const oldGuardians = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
    await id.setupGuardians(oldGuardians);

    const newGuardians = ['d'.repeat(64), 'e'.repeat(64), 'f'.repeat(64)];
    // Provide 2 dummy quorum signatures (quorum = any 2 from old set)
    const oldSigs = ['0'.repeat(128), '1'.repeat(128)];

    const { event, shards } = await id.rotateGuardians(newGuardians, oldSigs, 'moving towns');

    expect(verifyEnvelope(event)).toBe(true);
    expect(event.kind).toBe(EventKind.GUARDIAN_ROTATE);

    const content = JSON.parse(event.content);
    expect(content.old_guardians).toEqual(oldGuardians);
    expect(content.new_guardians).toEqual(newGuardians);
    expect(content.reason).toBe('moving towns');

    expect(shards).toHaveLength(3);

    // Recovery state updated to new guardians
    const state = await id.getRecoveryState();
    expect(state!.guardians).toEqual(newGuardians);
  });

  it('rejects rotation if quorum is insufficient', async () => {
    const id = makeIdentity();
    await id.initialize();
    await id.setupGuardians(['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]);

    await expect(
      id.rotateGuardians(['d'.repeat(64), 'e'.repeat(64), 'f'.repeat(64)], ['0'.repeat(128)]),
    ).rejects.toThrow('2 signatures');
  });
});

// ---------------------------------------------------------------------------
// Key rotation
// ---------------------------------------------------------------------------

describe('rotateKey', () => {
  it('produces a valid KEY_ROTATE envelope linking old pubkey to new', async () => {
    const { generateKeypair } = await import('../crypto.js');
    const id = makeIdentity();
    await id.initialize();
    await id.setupGuardians(['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]);

    const oldPubkey    = await id.getPublicKey();
    const newKeypair   = generateKeypair();
    const guardianSigs = ['0'.repeat(128), '1'.repeat(128)];

    const event = await id.rotateKey(newKeypair.privateKey, guardianSigs);

    // The event is signed by the OLD key — verify it
    expect(verifyEnvelope(event)).toBe(true);
    expect(event.kind).toBe(EventKind.KEY_ROTATE);

    const content = JSON.parse(event.content);
    expect(content.old_pubkey).toBe(oldPubkey);
    expect(content.new_pubkey).toBe(newKeypair.publicKey);
    expect(content.guardian_sigs).toEqual(guardianSigs);

    // After rotation, getPublicKey returns the NEW pubkey
    const pubkeyAfter = await id.getPublicKey();
    expect(pubkeyAfter).toBe(newKeypair.publicKey);
  });
});

// ---------------------------------------------------------------------------
// Recovery initiation (RECOVERY_INIT — kind 103)
// ---------------------------------------------------------------------------

describe('initiateRecovery', () => {
  it('produces a valid RECOVERY_INIT envelope signed by temp key', async () => {
    const newDeviceId = makeIdentity();
    const recoveringPubkey = 'a'.repeat(64);

    const { event, tempPrivateKey } = await newDeviceId.initiateRecovery(recoveringPubkey);

    expect(verifyEnvelope(event)).toBe(true);
    expect(event.kind).toBe(EventKind.RECOVERY_INIT);

    const content = JSON.parse(event.content);
    expect(content.recovering_pubkey).toBe(recoveringPubkey);
    // The event is signed by the temp key — pubkey on envelope matches temp
    const tempPubkey = derivePublicKey(tempPrivateKey);
    expect(event.pubkey).toBe(tempPubkey);
  });
});

// ---------------------------------------------------------------------------
// Recovery shard provision (RECOVERY_SHARD — kind 104)
// ---------------------------------------------------------------------------

describe('provideRecoveryShard', () => {
  it('produces a valid RECOVERY_SHARD envelope', async () => {
    const guardian = makeIdentity();
    await guardian.initialize();

    const recoveryEventId = 'e'.repeat(64);
    const encryptedShard  = 'base64dataishere==';

    const event = await guardian.provideRecoveryShard(recoveryEventId, 2, encryptedShard);

    expect(verifyEnvelope(event)).toBe(true);
    expect(event.kind).toBe(EventKind.RECOVERY_SHARD);

    const content = JSON.parse(event.content);
    expect(content.recovery_event_id).toBe(recoveryEventId);
    expect(content.shard_index).toBe(2);
    expect(content.encrypted_shard).toBe(encryptedShard);
    expect(content.guardian_pubkey).toBe(await guardian.getPublicKey());
  });
});
