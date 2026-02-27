/**
 * BroadcastChannel adapter — same-device / same-origin communication.
 *
 * Uses the browser BroadcastChannel API to exchange EventEnvelopes between
 * tabs, windows, or service workers on the same origin. This is the
 * zero-infrastructure fallback: it works even if no WiFi hub is reachable,
 * as long as multiple protocol instances share the same origin.
 *
 * Limitations:
 * - Same origin only — cannot cross devices.
 * - For cross-device LAN communication, see websocket-relay.ts.
 */

import type { EventEnvelope } from '../../shared/types.js';

const CHANNEL_NAME = 'rural-run-protocol';

export class BroadcastChannelAdapter {
  private channel: BroadcastChannel | null = null;
  private listener: ((envelope: EventEnvelope) => void) | null = null;
  private available: boolean = false;

  /**
   * Start listening for inbound events on the BroadcastChannel.
   * Calling listen() again replaces the previous listener.
   */
  listen(onEvent: (envelope: EventEnvelope) => void): void {
    this.close();
    this.listener = onEvent;

    try {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.available = true;

      this.channel.onmessage = (event: MessageEvent) => {
        const envelope = this.parseEnvelope(event.data);
        if (envelope && this.listener) {
          this.listener(envelope);
        }
      };

      this.channel.onmessageerror = () => {
        // Malformed message — silently ignore per protocol rules
      };
    } catch {
      // BroadcastChannel not supported in this environment
      this.available = false;
    }
  }

  /**
   * Publish an event to all other tabs/windows on the same origin.
   */
  async publish(envelope: EventEnvelope): Promise<void> {
    if (!this.channel) {
      throw new Error('BroadcastChannel not initialized — call listen() first');
    }

    this.channel.postMessage(JSON.stringify(envelope));
  }

  /**
   * Returns true if the BroadcastChannel API is available in this environment.
   */
  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Close the channel and clean up resources.
   */
  close(): void {
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
    this.available = false;
    this.listener = null;
  }

  /**
   * Parse and validate an incoming message as an EventEnvelope.
   * Returns null for anything that doesn't look like a valid envelope.
   */
  private parseEnvelope(data: unknown): EventEnvelope | null {
    try {
      const parsed = typeof data === 'string' ? JSON.parse(data) : data;

      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof parsed.id === 'string' &&
        typeof parsed.kind === 'number' &&
        typeof parsed.pubkey === 'string' &&
        typeof parsed.created_at === 'number' &&
        typeof parsed.content === 'string' &&
        typeof parsed.sig === 'string'
      ) {
        return parsed as EventEnvelope;
      }

      return null;
    } catch {
      return null;
    }
  }
}
