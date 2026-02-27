import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { EventEnvelope, EventKindValue } from '../shared/types.js';
import { EventKind } from '../shared/types.js';

const VALID_KINDS = new Set<number>(
  Object.values(EventKind) as EventKindValue[],
);

/** Maximum allowed future clock skew: 5 minutes */
export const MAX_FUTURE_SKEW_SECONDS = 300;

/**
 * Compute the canonical event id.
 * id = sha256(JSON.stringify([0, pubkey, created_at, kind, content]))
 */
export function computeEventId(
  pubkey: string,
  created_at: number,
  kind: number,
  content: string,
): string {
  const canonical = JSON.stringify([0, pubkey, created_at, kind, content]);
  return bytesToHex(sha256(utf8ToBytes(canonical)));
}

/**
 * Validate an EventEnvelope:
 *  1. kind must be in the Event Kind Registry
 *  2. created_at must not be >5 min in the future
 *  3. id must match canonical sha256 hash
 *  4. sig must verify against id using pubkey (secp256k1 Schnorr)
 *
 * Returns false on any failure — never throws.
 */
export function validateEnvelope(envelope: EventEnvelope): boolean {
  try {
    if (!VALID_KINDS.has(envelope.kind)) return false;

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (envelope.created_at > nowSeconds + MAX_FUTURE_SKEW_SECONDS) return false;

    const expectedId = computeEventId(
      envelope.pubkey,
      envelope.created_at,
      envelope.kind,
      envelope.content,
    );
    if (expectedId !== envelope.id) return false;

    return schnorr.verify(
      hexToBytes(envelope.sig),
      hexToBytes(envelope.id),
      hexToBytes(envelope.pubkey),
    );
  } catch {
    return false;
  }
}
