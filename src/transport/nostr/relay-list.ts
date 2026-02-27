/**
 * RelayListManager — manages the list of Nostr relay URLs.
 *
 * Sources (merged in priority order):
 * 1. Community-added relays (highest priority — always included)
 * 2. IPFS-published relay list (fetched at startup, cached locally)
 * 3. Hardcoded defaults (fallback when IPFS is unreachable and no cache)
 *
 * The relay list on IPFS allows communities to update their relay
 * configuration without app changes — just publish a new list to IPFS
 * and share the CID.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RelayListConfig {
  /** IPFS CID for the community relay list. */
  ipfsCid?: string;

  /** IPFS gateway URL template. `{cid}` is replaced with the CID. */
  ipfsGateway?: string;

  /** Cache TTL in milliseconds (default: 1 hour). */
  cacheTtlMs?: number;

  /** Override hardcoded defaults (useful for testing). */
  defaultRelays?: string[];

  /** Fetch timeout in milliseconds (default: 10000). */
  fetchTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_RELAYS: string[] = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

const DEFAULT_IPFS_GATEWAY = 'https://ipfs.io/ipfs/{cid}';
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const CACHE_KEY = 'rural-run-relay-list';
const COMMUNITY_KEY = 'rural-run-community-relays';

// ---------------------------------------------------------------------------
// Cache shape
// ---------------------------------------------------------------------------

interface CachedRelayList {
  relays: string[];
  fetchedAt: number;
}

// ---------------------------------------------------------------------------
// RelayListManager
// ---------------------------------------------------------------------------

export class RelayListManager {
  private config: Required<
    Pick<RelayListConfig, 'ipfsGateway' | 'cacheTtlMs' | 'defaultRelays' | 'fetchTimeoutMs'>
  > & Pick<RelayListConfig, 'ipfsCid'>;

  private communityRelays: Set<string> = new Set();
  private ipfsRelays: string[] = [];
  private loaded = false;

  constructor(config: RelayListConfig = {}) {
    this.config = {
      ipfsCid: config.ipfsCid,
      ipfsGateway: config.ipfsGateway ?? DEFAULT_IPFS_GATEWAY,
      cacheTtlMs: config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
      defaultRelays: config.defaultRelays ?? DEFAULT_RELAYS,
      fetchTimeoutMs: config.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    };

    this.loadCommunityRelaysFromCache();
  }

  /**
   * Get the full merged relay list.
   * On first call, attempts to fetch from IPFS (falls back to cache/defaults).
   */
  async getRelays(): Promise<string[]> {
    if (!this.loaded) {
      await this.loadIPFSRelays();
      this.loaded = true;
    }
    return this.mergeRelays();
  }

  /** Add a community-specific relay. Persisted to local cache. */
  addCommunityRelay(url: string): void {
    this.communityRelays.add(url);
    this.saveCommunityRelaysToCache();
  }

  /** Remove a community relay. */
  removeCommunityRelay(url: string): void {
    this.communityRelays.delete(url);
    this.saveCommunityRelaysToCache();
  }

  /** Returns the current community-added relay URLs. */
  getCommunityRelays(): string[] {
    return [...this.communityRelays];
  }

  /** Force a re-fetch of the IPFS relay list. */
  async refreshFromIPFS(): Promise<void> {
    this.loaded = false;
    await this.loadIPFSRelays();
    this.loaded = true;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private mergeRelays(): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    // Community relays first (highest priority)
    for (const url of this.communityRelays) {
      if (!seen.has(url)) {
        seen.add(url);
        result.push(url);
      }
    }

    // IPFS relays (or defaults if IPFS unavailable)
    const ipfsOrDefaults =
      this.ipfsRelays.length > 0 ? this.ipfsRelays : this.config.defaultRelays;
    for (const url of ipfsOrDefaults) {
      if (!seen.has(url)) {
        seen.add(url);
        result.push(url);
      }
    }

    return result;
  }

  private async loadIPFSRelays(): Promise<void> {
    // Try fetching from IPFS if a CID is configured
    if (this.config.ipfsCid) {
      const fetched = await this.fetchFromIPFS(this.config.ipfsCid);
      if (fetched) {
        this.ipfsRelays = fetched;
        this.cacheIPFSRelays(fetched);
        return;
      }
    }

    // Fall back to cached IPFS list
    const cached = this.loadCachedIPFSRelays();
    if (cached) {
      this.ipfsRelays = cached;
      return;
    }

    // No IPFS relays available — defaults will be used in mergeRelays()
    this.ipfsRelays = [];
  }

  private async fetchFromIPFS(cid: string): Promise<string[] | null> {
    const url = this.config.ipfsGateway.replace('{cid}', cid);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.config.fetchTimeoutMs,
      );

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) return null;

      const data: unknown = await response.json();
      if (!Array.isArray(data)) return null;

      const relays = data.filter(
        (item): item is string =>
          typeof item === 'string' && item.startsWith('wss://'),
      );

      return relays.length > 0 ? relays : null;
    } catch {
      return null; // Network error, timeout, parse error — all fall back
    }
  }

  private cacheIPFSRelays(relays: string[]): void {
    try {
      const cached: CachedRelayList = {
        relays,
        fetchedAt: Date.now(),
      };
      localStorage.setItem(CACHE_KEY, JSON.stringify(cached));
    } catch {
      // localStorage unavailable — tolerated
    }
  }

  private loadCachedIPFSRelays(): string[] | null {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;

      const cached: CachedRelayList = JSON.parse(raw);
      const age = Date.now() - cached.fetchedAt;

      if (age > this.config.cacheTtlMs) return null; // expired
      if (!Array.isArray(cached.relays) || cached.relays.length === 0) return null;

      return cached.relays;
    } catch {
      return null;
    }
  }

  private saveCommunityRelaysToCache(): void {
    try {
      localStorage.setItem(
        COMMUNITY_KEY,
        JSON.stringify([...this.communityRelays]),
      );
    } catch {
      // localStorage unavailable — tolerated
    }
  }

  private loadCommunityRelaysFromCache(): void {
    try {
      const raw = localStorage.getItem(COMMUNITY_KEY);
      if (!raw) return;

      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;

      for (const url of parsed) {
        if (typeof url === 'string') {
          this.communityRelays.add(url);
        }
      }
    } catch {
      // localStorage unavailable — tolerated
    }
  }
}
