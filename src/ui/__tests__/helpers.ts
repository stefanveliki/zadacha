/**
 * Test helpers for the UI layer tests.
 *
 * Provides mock implementations of IdentityLayer, TransportAdapter,
 * and StateReader so UIActionsImpl can be tested in isolation.
 */

import type { EventEnvelope, TransportAdapter } from '../../shared/types.js';
import type {
  IdentityLayer,
  StateReader,
  TripState,
  NeedState,
  MatchState,
  MatchFilter,
} from '../actions.js';

// ---------------------------------------------------------------------------
// MockIdentityLayer
// ---------------------------------------------------------------------------

export class MockIdentityLayer implements IdentityLayer {
  readonly builtEvents: Array<{ kind: number; content: object }> = [];
  pubkey = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';
  private eventCounter = 0;

  async getPublicKey(): Promise<string> {
    return this.pubkey;
  }

  async signEvent(eventId: string): Promise<string> {
    return `sig-for-${eventId}`;
  }

  async buildEvent(kind: number, content: object): Promise<EventEnvelope> {
    this.builtEvents.push({ kind, content });
    this.eventCounter++;
    const id = `event-${this.eventCounter}`;
    return {
      id,
      kind,
      pubkey: this.pubkey,
      created_at: Math.floor(Date.now() / 1000),
      content: JSON.stringify(content),
      sig: `sig-${id}`,
    };
  }
}

// ---------------------------------------------------------------------------
// MockTransport
// ---------------------------------------------------------------------------

export class MockTransport implements TransportAdapter {
  readonly published: EventEnvelope[] = [];
  available = true;

  listen(_onEvent: (envelope: EventEnvelope) => void): void {
    // no-op for UI tests
  }

  async publish(envelope: EventEnvelope): Promise<void> {
    this.published.push(envelope);
  }

  isAvailable(): boolean {
    return this.available;
  }
}

// ---------------------------------------------------------------------------
// MockStateReader
// ---------------------------------------------------------------------------

export class MockStateReader implements StateReader {
  private trips: TripState[] = [];
  private needs: NeedState[] = [];
  private matches: MatchState[] = [];

  setTrips(trips: TripState[]): void {
    this.trips = trips;
  }

  setNeeds(needs: NeedState[]): void {
    this.needs = needs;
  }

  setMatches(matches: MatchState[]): void {
    this.matches = matches;
  }

  getActiveTrips(): TripState[] {
    return this.trips.filter((t) => t.status === 'open');
  }

  getUnmatchedNeeds(): NeedState[] {
    return this.needs.filter((n) => n.status === 'unmatched');
  }

  getMatches(filter?: MatchFilter): MatchState[] {
    if (!filter) return [...this.matches];
    return this.matches.filter((m) => {
      if (filter.tripId !== undefined && m.tripId !== filter.tripId) return false;
      if (filter.needId !== undefined && m.needId !== filter.needId) return false;
      if (filter.status !== undefined && m.status !== filter.status) return false;
      if (filter.runnerPubkey !== undefined && m.runnerPubkey !== filter.runnerPubkey)
        return false;
      if (
        filter.requesterPubkey !== undefined &&
        m.requesterPubkey !== filter.requesterPubkey
      )
        return false;
      return true;
    });
  }

  getTripState(tripId: string): TripState | undefined {
    return this.trips.find((t) => t.trip.id === tripId);
  }

  getNeedState(needId: string): NeedState | undefined {
    return this.needs.find((n) => n.need.id === needId);
  }
}
