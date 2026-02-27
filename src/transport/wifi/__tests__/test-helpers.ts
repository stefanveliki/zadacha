/**
 * Shared test utilities for WiFi transport tests.
 */

import type { EventEnvelope } from '../../../shared/types.js';
import { EventKind } from '../../../shared/types.js';

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
 * Create a minimal mock WebSocket for testing.
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
 * Create a minimal mock BroadcastChannel for testing.
 */
export class MockBroadcastChannel {
  static channels: Map<string, MockBroadcastChannel[]> = new Map();

  name: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  closed = false;

  constructor(name: string) {
    this.name = name;
    const group = MockBroadcastChannel.channels.get(name) ?? [];
    group.push(this);
    MockBroadcastChannel.channels.set(name, group);
  }

  postMessage(data: unknown): void {
    if (this.closed) throw new Error('BroadcastChannel is closed');

    const group = MockBroadcastChannel.channels.get(this.name) ?? [];
    for (const channel of group) {
      if (channel !== this && !channel.closed && channel.onmessage) {
        channel.onmessage({ data } as MessageEvent);
      }
    }
  }

  close(): void {
    this.closed = true;
    const group = MockBroadcastChannel.channels.get(this.name) ?? [];
    const idx = group.indexOf(this);
    if (idx !== -1) group.splice(idx, 1);
  }

  static reset(): void {
    MockBroadcastChannel.channels.clear();
  }
}
