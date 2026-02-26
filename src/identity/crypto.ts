/**
 * Rural Run Protocol — Cryptographic Primitives
 *
 * secp256k1 Schnorr signatures (BIP-340 style) via @noble/curves.
 * SHA-256 via @noble/hashes.
 *
 * All functions in this module are pure — no side effects, no I/O.
 * The private key is passed in explicitly; storage and biometric gating
 * live in other modules.
 */

import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import type { EventEnvelope } from './types.js';

// ---------------------------------------------------------------------------
// Keypair generation
// ---------------------------------------------------------------------------

export interface Keypair {
  privateKey: Uint8Array;  // 32 bytes
  publicKey: string;       // hex-encoded 32-byte x-only public key (BIP-340)
}

/**
 * Generate a new secp256k1 keypair.
 * Uses the platform's CSPRNG (crypto.getRandomValues in browser, crypto.randomBytes in Node).
 */
export function generateKeypair(): Keypair {
  const privateKey = schnorr.utils.randomPrivateKey();
  const publicKey = bytesToHex(schnorr.getPublicKey(privateKey));
  return { privateKey, publicKey };
}

/**
 * Derive the x-only public key (hex) from a raw 32-byte private key.
 */
export function derivePublicKey(privateKey: Uint8Array): string {
  return bytesToHex(schnorr.getPublicKey(privateKey));
}

// ---------------------------------------------------------------------------
// Event ID derivation  (InterfaceContracts_v0.1 §1)
// ---------------------------------------------------------------------------

/**
 * Compute the canonical event id.
 * id = SHA-256 of JSON.stringify([0, pubkey, created_at, kind, content])
 *
 * The content argument must already be a JSON string (stored opaquely).
 */
export function computeEventId(
  pubkey: string,
  created_at: number,
  kind: number,
  content: string,
): string {
  const canonical = JSON.stringify([0, pubkey, created_at, kind, content]);
  const hash = sha256(utf8ToBytes(canonical));
  return bytesToHex(hash);
}

// ---------------------------------------------------------------------------
// Signing and verification
// ---------------------------------------------------------------------------

/**
 * Sign an event id (hex string) with a secp256k1 private key.
 * Uses BIP-340 Schnorr signatures.
 * Returns hex-encoded 64-byte signature.
 */
export function signEventId(eventId: string, privateKey: Uint8Array): string {
  const msgBytes = hexToBytes(eventId);
  const sig = schnorr.sign(msgBytes, privateKey);
  return bytesToHex(sig);
}

/**
 * Verify a Schnorr signature over an event id.
 * Returns true if the signature is valid for the given pubkey.
 */
export function verifySignature(
  eventId: string,
  sig: string,
  pubkey: string,
): boolean {
  try {
    return schnorr.verify(hexToBytes(sig), hexToBytes(eventId), hexToBytes(pubkey));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Full envelope verification
// ---------------------------------------------------------------------------

/**
 * Verify an EventEnvelope end-to-end:
 * 1. Recompute id from (pubkey, created_at, kind, content) and check it matches.
 * 2. Verify sig over id using pubkey.
 *
 * Returns true only if both checks pass.
 * Silently returns false on any malformed input (mirrors the log's drop-silently rule).
 */
export function verifyEnvelope(envelope: EventEnvelope): boolean {
  try {
    const expectedId = computeEventId(
      envelope.pubkey,
      envelope.created_at,
      envelope.kind,
      envelope.content,
    );
    if (expectedId !== envelope.id) return false;
    return verifySignature(envelope.id, envelope.sig, envelope.pubkey);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Hex / byte utilities  (re-exported for other modules)
// ---------------------------------------------------------------------------

export { bytesToHex, hexToBytes };
