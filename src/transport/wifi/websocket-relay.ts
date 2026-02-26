/**
 * WebSocket relay client — cross-device LAN communication via a local hub.
 *
 * Connects to a WebSocket relay server running on the local network (typically
 * a Raspberry Pi at a known location — church, shop, someone's porch). The
 * relay is a simple message broker: it receives EventEnvelopes and broadcasts
 * them to all connected clients.
 *
 * This is the primary cross-device transport for the WiFi layer in a PWA
 * context. Raw UDP broadcast is not available in browsers — that requires a
 * native app wrapper and is a future adapter, not in scope today.
 *
 * The relay protocol is minimal:
 * - Client connects via WebSocket to ws://<hub-ip>:<port>
 * - Client sends JSON-serialized EventEnvelopes
 * - Hub broadcasts received envelopes to all other connected clients
 * - No authentication at the transport layer (events are self-authenticating
 *   via their signatures — the Log layer validates)
 */

import type { EventEnvelope } from '../../shared/types.js';

/** Default port for the Rural Run local WiFi relay */
export const DEFAULT_RELAY_PORT = 4117;

export interface WebSocketRelayConfig {
  /** Full WebSocket URL, e.g. "ws://192.168.1.50:4117" */
  url?: string;

  /** Reconnection delay in ms — doubles on each failure, capped at maxReconnectDelay */
  reconnectDelay?: number;

  /** Maximum reconnection delay in ms */
  maxReconnectDelay?: number;

  /** Maximum number of reconnection attempts before giving up. 0 = infinite. */
  maxReconnectAttempts?: number;
}

const DEFAULT_CONFIG: Required<WebSocketRelayConfig> = {
  url: '',
  reconnectDelay: 1000,
  maxReconnectDelay: 30000,
  maxReconnectAttempts: 0,
};

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export class WebSocketRelay {
  private config: Required<WebSocketRelayConfig>;
  private ws: WebSocket | null = null;
  private listener: ((envelope: EventEnvelope) => void) | null = null;
  private connectionState: ConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentReconnectDelay: number;
  private closed = false;

  constructor(config: WebSocketRelayConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.currentReconnectDelay = this.config.reconnectDelay;
  }

  /**
   * Connect to the relay and start listening for inbound events.
   * Calling listen() again replaces the previous listener and reconnects.
   */
  listen(onEvent: (envelope: EventEnvelope) => void): void {
    this.close();
    this.closed = false;
    this.listener = onEvent;
    this.reconnectAttempts = 0;
    this.currentReconnectDelay = this.config.reconnectDelay;
    this.connect();
  }

  /**
   * Publish an event to all other clients via the relay.
   * Throws if not connected.
   */
  async publish(envelope: EventEnvelope): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket relay not connected');
    }

    this.ws.send(JSON.stringify(envelope));
  }

  /**
   * Returns true if connected to the relay and ready to send/receive.
   */
  isAvailable(): boolean {
    return this.connectionState === 'connected';
  }

  /**
   * Returns the current connection state.
   */
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Update the relay URL. Triggers a reconnect if currently listening.
   */
  setUrl(url: string): void {
    this.config.url = url;
    if (this.listener && !this.closed) {
      this.reconnectAttempts = 0;
      this.currentReconnectDelay = this.config.reconnectDelay;
      this.disconnect();
      this.connect();
    }
  }

  /**
   * Close the connection and stop reconnecting.
   */
  close(): void {
    this.closed = true;
    this.clearReconnectTimer();
    this.disconnect();
    this.listener = null;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private connect(): void {
    if (!this.config.url || this.closed) {
      this.connectionState = 'disconnected';
      return;
    }

    this.connectionState = 'connecting';

    try {
      this.ws = new WebSocket(this.config.url);
    } catch {
      this.connectionState = 'disconnected';
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.connectionState = 'connected';
      this.reconnectAttempts = 0;
      this.currentReconnectDelay = this.config.reconnectDelay;
    };

    this.ws.onmessage = (event: MessageEvent) => {
      const envelope = this.parseEnvelope(event.data);
      if (envelope && this.listener) {
        this.listener(envelope);
      }
    };

    this.ws.onclose = () => {
      this.connectionState = 'disconnected';
      this.ws = null;
      if (!this.closed) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror — reconnect is handled there
    };
  }

  private disconnect(): void {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;

      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close();
      }

      this.ws = null;
    }
    this.connectionState = 'disconnected';
  }

  private scheduleReconnect(): void {
    if (this.closed) return;

    if (
      this.config.maxReconnectAttempts > 0 &&
      this.reconnectAttempts >= this.config.maxReconnectAttempts
    ) {
      this.connectionState = 'disconnected';
      return;
    }

    this.clearReconnectTimer();

    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.currentReconnectDelay = Math.min(
        this.currentReconnectDelay * 2,
        this.config.maxReconnectDelay,
      );
      this.connect();
    }, this.currentReconnectDelay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private parseEnvelope(data: unknown): EventEnvelope | null {
    try {
      const raw = typeof data === 'string' ? data : String(data);
      const parsed = JSON.parse(raw);

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
