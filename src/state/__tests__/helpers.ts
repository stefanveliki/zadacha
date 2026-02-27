/**
 * Test helpers for the State Machine tests.
 *
 * Re-exports crypto helpers from the log test helpers and provides
 * a MockLog that implements the LogReader interface for isolated testing.
 */
export {
  generateKeypair,
  buildEnvelope,
  buildTripEnvelope,
  buildNeedEnvelope,
  buildMatchEnvelope,
} from '../../log/__tests__/helpers.js';

import type { EventEnvelope, LogFilter } from '../../shared/types.js';
import type { LogReader } from '../stateMachine.js';

interface Subscription {
  filter: LogFilter;
  cb: (envelope: EventEnvelope) => void;
}

/**
 * In-memory mock Log that satisfies the LogReader interface.
 * Allows tests to inject events directly without crypto overhead from the real Log.
 */
export class MockLog implements LogReader {
  private readonly events: EventEnvelope[] = [];
  private readonly subs: Subscription[] = [];

  /** Inject an event — stored and subscribers notified. */
  receive(envelope: EventEnvelope): void {
    this.events.push(envelope);
    for (const sub of this.subs) {
      if (this.matches(envelope, sub.filter)) {
        sub.cb(envelope);
      }
    }
  }

  query(filter: LogFilter): EventEnvelope[] {
    return this.events
      .filter((e) => this.matches(e, filter))
      .sort((a, b) => a.created_at - b.created_at);
  }

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

  private matches(envelope: EventEnvelope, filter: LogFilter): boolean {
    if (filter.kinds && !filter.kinds.includes(envelope.kind)) return false;
    if (filter.pubkeys && !filter.pubkeys.includes(envelope.pubkey)) return false;
    if (filter.since !== undefined && envelope.created_at < filter.since) return false;
    if (filter.until !== undefined && envelope.created_at > filter.until) return false;
    return true;
  }
}
