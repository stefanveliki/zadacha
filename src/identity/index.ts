/**
 * Rural Run Protocol — Identity Layer
 *
 * Public exports for the Identity Layer.
 * Other layers consume this module only through the IdentityLayer interface.
 */

// Interface contract (other layers import types from here)
export type {
  EventEnvelope,
  IdentityLayer,
  BiometricGate,
  KeyStore,
  ShamirShard,
  RecoveryState,
  GuardianSetContent,
  GuardianRotateContent,
  KeyRotateContent,
  RecoveryInitContent,
  RecoveryShardContent,
} from './types.js';

export {
  EventKind,
  BiometricCancelledError,
  BiometricUnavailableError,
} from './types.js';

// Implementation
export { IdentityLayerImpl } from './identity.js';
export { NoOpBiometricGate, CancellingBiometricGate, createBiometricGate } from './biometric.js';
export { MemoryKeyStore, IdbKeyStore, createKeyStore } from './storage.js';

// Crypto utilities (useful for other layers verifying envelopes)
export { verifyEnvelope, verifySignature } from './crypto.js';
