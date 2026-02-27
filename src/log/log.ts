import type { EventEnvelope, LogFilter } from '../shared/types.js';
import type { StorageHandle } from './storage.js';
import { openStorage } from './storage.js';
import { validateEnvelope } from './validation.js';

interface Subscription {
  filter: LogFilter;
  cb: (envelope: EventEnvelope) => void;
}

/**
 * Local-first, append-only event log.
 *
 * - Validates every inbound event (id hash + sig + clock skew)
 * - Deduplicates by id — first arrival wins
 * - Persists to IndexedDB asynchronously
 * - Supports synchronous query() and push-based subscribe()
 */
export class Log {
  private readonly byId = new Map<string, EventEnvelope>();
  private readonly tripIndex = new Map<string, Set<string>>();
  private readonly needIndex = new Map<string, Set<string>>();
  private readonly subs: Subscription[] = [];

  constructor(private readonly storage: StorageHandle) {}

  // -- Public API (matches InterfaceContracts v0.1 §4) -----------------------

  /** Receive an event from any transport — validates and stores if new. */
  receive(envelope: EventEnvelope): void {
    if (!validateEnvelope(envelope)) return;
    if (this.byId.has(envelope.id)) return;

    this.byId.set(envelope.id, envelope);
    this.indexContent(envelope);

    // Persist async — fire and forget
    this.storage.put(envelope).catch(() => {});

    // Notify matching subscriptions
    for (const sub of this.subs) {
      if (this.matches(envelope, sub.filter)) {
        sub.cb(envelope);
      }
    }
  }

  /** Query stored events. Results ordered by created_at ascending. */
  query(filter: LogFilter): EventEnvelope[] {
    let candidates: Iterable<EventEnvelope>;

    // Use secondary index when filtering by trip_id or need_id
    if (filter.trip_id !== undefined) {
      const ids = this.tripIndex.get(filter.trip_id);
      candidates = ids
        ? Array.from(ids).map((id) => this.byId.get(id)!)
        : [];
    } else if (filter.need_id !== undefined) {
      const ids = this.needIndex.get(filter.need_id);
      candidates = ids
        ? Array.from(ids).map((id) => this.byId.get(id)!)
        : [];
    } else {
      candidates = this.byId.values();
    }

    const results = Array.from(candidates)
      .filter((e) => this.matches(e, filter))
      .sort((a, b) => a.created_at - b.created_at);

    return filter.limit !== undefined ? results.slice(0, filter.limit) : results;
  }

  /** Subscribe to new events matching a filter. Returns unsubscribe function. */
  subscribe(
    filter: LogFilter,
    callback: (envelope: EventEnvelope) => void,
  ): () => void {
    const sub: Subscription = { filter, cb: callback };
    this.subs.push(sub);
    return () => {
      const idx = this.subs.indexOf(sub);
      if (idx !== -1) this.subs.splice(idx, 1);
    };
  }

  /** Close underlying storage. */
  close(): void {
    this.storage.close();
  }

  // -- Internal ---------------------------------------------------------------

  /** Load a pre-validated event from storage into memory (no validation, no persistence, no notify). */
  _loadFromStorage(envelope: EventEnvelope): void {
    if (this.byId.has(envelope.id)) return;
    this.byId.set(envelope.id, envelope);
    this.indexContent(envelope);
  }

  /** Extract trip_id / need_id from content and index them. */
  private indexContent(envelope: EventEnvelope): void {
    try {
      const parsed = JSON.parse(envelope.content) as Record<string, unknown>;
      if (typeof parsed.trip_id === 'string') {
        let set = this.tripIndex.get(parsed.trip_id);
        if (!set) {
          set = new Set();
          this.tripIndex.set(parsed.trip_id, set);
        }
        set.add(envelope.id);
      }
      if (typeof parsed.need_id === 'string') {
        let set = this.needIndex.get(parsed.need_id);
        if (!set) {
          set = new Set();
          this.needIndex.set(parsed.need_id, set);
        }
        set.add(envelope.id);
      }
    } catch {
      // content is not JSON — no trip_id/need_id to index
    }
  }

  /** Check if an envelope matches all filter criteria. */
  private matches(envelope: EventEnvelope, filter: LogFilter): boolean {
    if (filter.kinds && !filter.kinds.includes(envelope.kind)) return false;
    if (filter.pubkeys && !filter.pubkeys.includes(envelope.pubkey)) return false;
    if (filter.since !== undefined && envelope.created_at < filter.since) return false;
    if (filter.until !== undefined && envelope.created_at > filter.until) return false;
    if (filter.trip_id !== undefined) {
      const ids = this.tripIndex.get(filter.trip_id);
      if (!ids?.has(envelope.id)) return false;
    }
    if (filter.need_id !== undefined) {
      const ids = this.needIndex.get(filter.need_id);
      if (!ids?.has(envelope.id)) return false;
    }
    return true;
  }
}

/** Open a persistent Log backed by IndexedDB. */
export async function openLog(dbName = 'rural-run-log'): Promise<Log> {
  const storage = await openStorage(dbName);
  const log = new Log(storage);

  const persisted = await storage.getAll();
  for (const e of persisted) {
    log._loadFromStorage(e);
  }

  return log;
}
