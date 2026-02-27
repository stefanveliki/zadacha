/**
 * Shared test utilities for Nostr transport tests.
 */

import type { EventEnvelope } from '../../../shared/types.js';
import { EventKind } from '../../../shared/types.js';
import type { NostrEvent } from '../nostr-crypto.js';
import { RURAL_RUN_NOSTR_KIND, RURAL_RUN_TAG, RURAL_RUN_TAG_VALUE } from '../event-bridge.js';

/**
 * Create a valid-shaped EventEnvelope for testing.
 * Not cryptographically valid — signature verification is the Log layer's job.
 */
export function createTestEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: overrides.id ?? 'abc123def456',
    kind: overrides.kind ?? EventKind.TRIP_ANNOUNCE,
    pubkey: overrides.pubkey ?? 'deadbeef01234567890abcdef01234567890abcdef01234567890abcdef012345',
    created_at: overrides.created_at ?? Math.floor(Date.now() / 1000),
    content: overrides.content ?? JSON.stringify({ destination: 'Town center' }),
    sig: overrides.sig ?? 'facecafe01234567890abcdef01234567890abcdef01234567890abcdef012345',
  };
}

/**
 * Create a mock Nostr event wrapping an EventEnvelope.
 */
export function createWrappedNostrEvent(
  envelope?: EventEnvelope,
  overrides: Partial<NostrEvent> = {},
): NostrEvent {
  const inner = envelope ?? createTestEnvelope();
  return {
    id: overrides.id ?? 'nostr-event-id-001',
    pubkey: overrides.pubkey ?? 'transport-pubkey-hex',
    created_at: overrides.created_at ?? Math.floor(Date.now() / 1000),
    kind: overrides.kind ?? RURAL_RUN_NOSTR_KIND,
    tags: overrides.tags ?? [
      [RURAL_RUN_TAG, RURAL_RUN_TAG_VALUE],
      ['k', String(inner.kind)],
      ['e', inner.id],
    ],
    content: overrides.content ?? JSON.stringify(inner),
    sig: overrides.sig ?? 'nostr-sig-hex',
  };
}

/**
 * Minimal mock WebSocket for testing relay connections.
 */
export class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  sentMessages: string[] = [];
  url: string;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose(new Event('close') as CloseEvent);
    }
  }

  // Test helpers

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    if (this.onopen) {
      this.onopen(new Event('open'));
    }
  }

  simulateMessage(data: string): void {
    if (this.onmessage) {
      this.onmessage({ data } as MessageEvent);
    }
  }

  simulateError(): void {
    if (this.onerror) {
      this.onerror(new Event('error'));
    }
  }

  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose(new Event('close') as CloseEvent);
    }
  }
}

/**
 * Minimal localStorage mock for testing.
 */
export function createMockLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    get length() { return store.size; },
    key: (index: number) => [...store.keys()][index] ?? null,
  };
}
