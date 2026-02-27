/**
 * Hub discovery — locating the local WebSocket relay on the network.
 *
 * In a PWA context, we cannot use mDNS or raw UDP for service discovery.
 * Instead, hub discovery works through a prioritized list of strategies:
 *
 * 1. **Explicit configuration** — user or community admin provides the hub URL
 *    directly. This is the most reliable method.
 *
 * 2. **Same-origin** — if the PWA is served from the community Pi itself,
 *    the hub is at the same host on the relay port. Zero configuration needed.
 *
 * 3. **Well-known port probe** — try connecting to the relay port on common
 *    gateway addresses. Works on simple networks where the Pi is the router
 *    or is at a predictable address.
 *
 * Raw UDP subnet broadcast for automatic discovery requires a native app
 * wrapper — that is a future adapter, not in scope today.
 */

import { DEFAULT_RELAY_PORT } from './websocket-relay.js';

export interface DiscoveryResult {
  url: string;
  source: 'configured' | 'same-origin' | 'probe';
}

export interface HubDiscoveryConfig {
  /** Explicitly configured hub URL — highest priority */
  configuredUrl?: string;

  /** Port to use when probing. Defaults to DEFAULT_RELAY_PORT (4117) */
  port?: number;

  /** Timeout in ms for each probe attempt */
  probeTimeout?: number;

  /** Additional addresses to probe beyond the defaults */
  extraProbeAddresses?: string[];
}

/** Common gateway/hub addresses to probe on a local network */
const DEFAULT_PROBE_ADDRESSES = [
  '192.168.1.1',
  '192.168.0.1',
  '192.168.4.1',   // ESP32 / Pi hotspot default
  '10.0.0.1',
  '10.42.0.1',     // Linux hotspot default
  '172.16.0.1',
];

const DEFAULT_PROBE_TIMEOUT = 3000;

export class HubDiscovery {
  private config: HubDiscoveryConfig;

  constructor(config: HubDiscoveryConfig = {}) {
    this.config = config;
  }

  /**
   * Attempt to discover a local WebSocket relay hub.
   * Tries strategies in priority order and returns the first successful result.
   * Returns null if no hub is found.
   */
  async discover(): Promise<DiscoveryResult | null> {
    // Strategy 1: Explicit configuration
    if (this.config.configuredUrl) {
      return { url: this.config.configuredUrl, source: 'configured' };
    }

    // Strategy 2: Same-origin inference
    const sameOriginUrl = this.inferSameOrigin();
    if (sameOriginUrl) {
      const reachable = await this.probeUrl(sameOriginUrl);
      if (reachable) {
        return { url: sameOriginUrl, source: 'same-origin' };
      }
    }

    // Strategy 3: Well-known port probe
    const probed = await this.probeWellKnownAddresses();
    if (probed) {
      return probed;
    }

    return null;
  }

  /**
   * Update the configured URL. Useful when the user manually enters a hub address.
   */
  setConfiguredUrl(url: string): void {
    this.config.configuredUrl = url;
  }

  /**
   * Infer a WebSocket URL from the current page origin.
   * If the PWA is served from a local IP (not localhost, not a public domain),
   * the hub is likely at the same host on the relay port.
   */
  inferSameOrigin(): string | null {
    if (typeof globalThis.location === 'undefined') {
      return null;
    }

    const hostname = globalThis.location.hostname;

    // Only infer for local/private IP addresses
    if (!this.isPrivateAddress(hostname)) {
      return null;
    }

    const port = this.config.port ?? DEFAULT_RELAY_PORT;
    return `ws://${hostname}:${port}`;
  }

  /**
   * Probe a list of well-known local addresses for an active relay.
   * Returns the first reachable hub, or null.
   */
  async probeWellKnownAddresses(): Promise<DiscoveryResult | null> {
    const port = this.config.port ?? DEFAULT_RELAY_PORT;
    const addresses = [
      ...DEFAULT_PROBE_ADDRESSES,
      ...(this.config.extraProbeAddresses ?? []),
    ];

    const urls = addresses.map((addr) => `ws://${addr}:${port}`);

    // Probe all addresses concurrently — first success wins
    const results = await Promise.allSettled(
      urls.map(async (url) => {
        const reachable = await this.probeUrl(url);
        if (reachable) return url;
        throw new Error('unreachable');
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        return { url: result.value, source: 'probe' };
      }
    }

    return null;
  }

  /**
   * Attempt to connect to a WebSocket URL with a timeout.
   * Returns true if the connection succeeds, false otherwise.
   */
  async probeUrl(url: string): Promise<boolean> {
    const timeout = this.config.probeTimeout ?? DEFAULT_PROBE_TIMEOUT;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (result: boolean) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      const timer = setTimeout(() => {
        settle(false);
        try {
          ws.close();
        } catch {
          // ignore
        }
      }, timeout);

      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        clearTimeout(timer);
        settle(false);
        return;
      }

      ws.onopen = () => {
        clearTimeout(timer);
        ws.close();
        settle(true);
      };

      ws.onerror = () => {
        clearTimeout(timer);
        settle(false);
      };
    });
  }

  /**
   * Check if a hostname is a private/local IP address.
   */
  private isPrivateAddress(hostname: string): boolean {
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return true;
    }

    // 10.x.x.x
    if (hostname.startsWith('10.')) return true;

    // 172.16.x.x – 172.31.x.x
    if (hostname.startsWith('172.')) {
      const second = parseInt(hostname.split('.')[1], 10);
      if (second >= 16 && second <= 31) return true;
    }

    // 192.168.x.x
    if (hostname.startsWith('192.168.')) return true;

    // 169.254.x.x (link-local)
    if (hostname.startsWith('169.254.')) return true;

    return false;
  }
}
