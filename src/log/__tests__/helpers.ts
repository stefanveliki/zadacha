import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { EventEnvelope } from '../../shared/types.js';
import { EventKind } from '../../shared/types.js';

/** Generate a random secp256k1 keypair (hex strings). */
export function generateKeypair(): { privkey: string; pubkey: string } {
  const privBytes = schnorr.utils.randomSecretKey();
  const pubBytes = schnorr.getPublicKey(privBytes);
  return {
    privkey: bytesToHex(privBytes),
    pubkey: bytesToHex(pubBytes),
  };
}

/** Build a fully valid, signed EventEnvelope. */
export function buildEnvelope(
  privkey: string,
  kind: number,
  content: string | object,
  overrides?: Partial<EventEnvelope>,
): EventEnvelope {
  const pubBytes = schnorr.getPublicKey(hexToBytes(privkey));
  const pubkey = overrides?.pubkey ?? bytesToHex(pubBytes);
  const created_at = overrides?.created_at ?? Math.floor(Date.now() / 1000);
  const contentStr = typeof content === 'string' ? content : JSON.stringify(content);

  const canonical = JSON.stringify([0, pubkey, created_at, kind, contentStr]);
  const id = overrides?.id ?? bytesToHex(sha256(utf8ToBytes(canonical)));

  const sig = overrides?.sig ?? bytesToHex(
    schnorr.sign(hexToBytes(id), hexToBytes(privkey)),
  );

  return { id, kind, pubkey, created_at, content: contentStr, sig };
}

/** Convenience: build a TRIP_ANNOUNCE envelope. */
export function buildTripEnvelope(
  privkey: string,
  tripContent?: object,
  overrides?: Partial<EventEnvelope>,
): EventEnvelope {
  return buildEnvelope(
    privkey,
    EventKind.TRIP_ANNOUNCE,
    tripContent ?? {
      destination: 'Town market',
      departs_at: Math.floor(Date.now() / 1000) + 3600,
      capacity: { seats: 3, cargo: 'half a trunk', time_budget: 60, physical_assistance: true },
      max_range: '5 km',
    },
    overrides,
  );
}

/** Convenience: build a NEED_SUBMIT envelope. */
export function buildNeedEnvelope(
  privkey: string,
  needContent?: object,
  overrides?: Partial<EventEnvelope>,
): EventEnvelope {
  return buildEnvelope(
    privkey,
    EventKind.NEED_SUBMIT,
    needContent ?? {
      what: 'Heart medication from pharmacy',
      by_when: Math.floor(Date.now() / 1000) + 7200,
      location: 'Village center',
      resource_footprint: { seat: false, cargo: 'small box', time_on_location: 10, physical_assistance: false },
    },
    overrides,
  );
}

/** Convenience: build a MATCH_ACCEPT envelope with trip_id and need_id in content. */
export function buildMatchEnvelope(
  privkey: string,
  tripId: string,
  needId: string,
  overrides?: Partial<EventEnvelope>,
): EventEnvelope {
  return buildEnvelope(
    privkey,
    EventKind.MATCH_ACCEPT,
    { trip_id: tripId, need_id: needId },
    overrides,
  );
}
