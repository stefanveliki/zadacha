/**
 * Nostr crypto primitives for the transport wrapper layer.
 *
 * This handles Nostr-level event id computation and signing for the
 * *wrapper* events that carry Rural Run EventEnvelopes through Nostr
 * relays. This is transport infrastructure — not protocol identity.
 * The protocol's own crypto lives in the Identity layer (Agent A).
 *
 * Uses @noble/curves for secp256k1 schnorr signing (BIP-340 / NIP-01).
 */

import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

// ---------------------------------------------------------------------------
// Nostr event types (NIP-01)
// ---------------------------------------------------------------------------

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  [tagFilter: `#${string}`]: string[] | undefined;
}

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

/** Generate a random secp256k1 private key for transport-level signing. */
export function generatePrivateKey(): Uint8Array {
  return schnorr.utils.randomSecretKey();
}

/** Derive the x-only public key (hex) from a private key. */
export function getPublicKey(privateKey: Uint8Array): string {
  return bytesToHex(schnorr.getPublicKey(privateKey));
}

// ---------------------------------------------------------------------------
// Event construction
// ---------------------------------------------------------------------------

/** Compute a Nostr event id per NIP-01: sha256 of canonical serialization. */
export function computeEventId(
  pubkey: string,
  createdAt: number,
  kind: number,
  tags: string[][],
  content: string,
): string {
  const serialized = JSON.stringify([0, pubkey, createdAt, kind, tags, content]);
  const hash = sha256(new TextEncoder().encode(serialized));
  return bytesToHex(hash);
}

/** Sign an event id with a private key (schnorr / BIP-340). */
export function signEventId(eventId: string, privateKey: Uint8Array): string {
  const msgBytes = hexToBytes(eventId);
  const sig = schnorr.sign(msgBytes, privateKey);
  return bytesToHex(sig);
}

/** Verify a Nostr event's signature. */
export function verifyEventSignature(event: NostrEvent): boolean {
  try {
    const msgBytes = hexToBytes(event.id);
    const sigBytes = hexToBytes(event.sig);
    const pubkeyBytes = hexToBytes(event.pubkey);
    return schnorr.verify(sigBytes, msgBytes, pubkeyBytes);
  } catch {
    return false;
  }
}

/**
 * Build a complete, signed Nostr event.
 *
 * This is the only function callers need — it handles id computation
 * and signing in one step.
 */
export function buildSignedEvent(
  privateKey: Uint8Array,
  kind: number,
  content: string,
  tags: string[][] = [],
): NostrEvent {
  const pubkey = getPublicKey(privateKey);
  const created_at = Math.floor(Date.now() / 1000);
  const id = computeEventId(pubkey, created_at, kind, tags, content);
  const sig = signEventId(id, privateKey);
  return { id, pubkey, created_at, kind, tags, content, sig };
}
