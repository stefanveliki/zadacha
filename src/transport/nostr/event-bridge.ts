/**
 * Event Bridge — wraps/unwraps Rural Run EventEnvelopes for Nostr relay transit.
 *
 * Our protocol's EventEnvelope id is computed as sha256([0, pubkey, created_at, kind, content])
 * while Nostr NIP-01 computes id as sha256([0, pubkey, created_at, kind, tags, content]).
 * These are different hashes, so our events aren't valid Nostr events.
 *
 * Solution: wrap the EventEnvelope as the `content` of a proper Nostr event,
 * signed with an ephemeral transport keypair. The real protocol signature
 * lives inside the envelope; the wrapper signature just satisfies relay validation.
 */

import type { EventEnvelope } from '../../shared/types.js';
import { buildSignedEvent, type NostrEvent, type NostrFilter } from './nostr-crypto.js';

/**
 * Custom Nostr kind for Rural Run protocol events.
 * Kind 4333 — regular event (stored by relays, not replaceable).
 * Configurable via NostrTransportConfig if communities need a different kind.
 */
export const RURAL_RUN_NOSTR_KIND = 4333;

/** Tag key used to identify Rural Run events on Nostr. */
export const RURAL_RUN_TAG = 't';
export const RURAL_RUN_TAG_VALUE = 'rural-run';

/** Tag key for the inner envelope's event kind (enables relay-side filtering). */
export const KIND_TAG = 'k';

/**
 * Wrap an EventEnvelope in a signed Nostr event for relay transport.
 */
export function wrapEnvelope(
  envelope: EventEnvelope,
  privateKey: Uint8Array,
  nostrKind: number = RURAL_RUN_NOSTR_KIND,
): NostrEvent {
  const tags: string[][] = [
    [RURAL_RUN_TAG, RURAL_RUN_TAG_VALUE],
    [KIND_TAG, String(envelope.kind)],
    ['e', envelope.id],
  ];

  return buildSignedEvent(privateKey, nostrKind, JSON.stringify(envelope), tags);
}

/**
 * Unwrap an EventEnvelope from a Nostr event's content.
 * Returns null if the event doesn't contain a valid EventEnvelope.
 */
export function unwrapEnvelope(
  nostrEvent: NostrEvent,
  nostrKind: number = RURAL_RUN_NOSTR_KIND,
): EventEnvelope | null {
  if (nostrEvent.kind !== nostrKind) return null;

  try {
    const parsed = JSON.parse(nostrEvent.content);

    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.kind !== 'number' ||
      typeof parsed.pubkey !== 'string' ||
      typeof parsed.created_at !== 'number' ||
      typeof parsed.content !== 'string' ||
      typeof parsed.sig !== 'string'
    ) {
      return null;
    }

    return {
      id: parsed.id,
      kind: parsed.kind,
      pubkey: parsed.pubkey,
      created_at: parsed.created_at,
      content: parsed.content,
      sig: parsed.sig,
    };
  } catch {
    return null;
  }
}

/**
 * Build a Nostr subscription filter that matches Rural Run events.
 *
 * @param kinds - Optional list of inner envelope kinds to filter by
 * @param since - Optional unix timestamp to filter events after
 */
export function buildRuralRunFilter(
  nostrKind: number = RURAL_RUN_NOSTR_KIND,
  kinds?: number[],
  since?: number,
): NostrFilter {
  const filter: NostrFilter = {
    kinds: [nostrKind],
    '#t': [RURAL_RUN_TAG_VALUE],
  };

  if (kinds && kinds.length > 0) {
    filter['#k'] = kinds.map(String);
  }

  if (since !== undefined) {
    filter.since = since;
  }

  return filter;
}
