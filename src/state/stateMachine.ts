import type { EventEnvelope, LogFilter } from '../shared/types.js';
import { EventKind } from '../shared/types.js';

// ---------------------------------------------------------------------------
// Interfaces — matches InterfaceContracts v0.1 §5
// ---------------------------------------------------------------------------

export interface CapacityRemaining {
  seats: number;
  cargo: string;
  time_budget: number; // minutes remaining
  physical_assistance: boolean;
}

export interface NeedState {
  need: EventEnvelope; // the original NEED_SUBMIT event
  status: 'unmatched' | 'accepted' | 'fulfilled' | 'confirmed' | 'released';
  matchId?: string; // present if status is not 'unmatched'
}

export interface TripState {
  trip: EventEnvelope; // the original TRIP_ANNOUNCE event
  remaining: CapacityRemaining; // calculated remaining capacity
  attachedNeeds: NeedState[]; // needs currently matched to this trip
  status: 'open' | 'closed' | 'cancelled' | 'completed';
}

export interface MatchFilter {
  tripId?: string;
  needId?: string;
  status?: 'accepted' | 'fulfilled' | 'confirmed';
  runnerPubkey?: string;
  requesterPubkey?: string;
}

export interface MatchState {
  matchId: string; // the event id of the MATCH_ACCEPT event
  tripId: string;
  needId: string;
  runnerPubkey: string;
  requesterPubkey: string;
  status: 'accepted' | 'fulfilled' | 'confirmed';
}

// ---------------------------------------------------------------------------
// Log interface — the subset of Log that StateMachine consumes
// ---------------------------------------------------------------------------

export interface LogReader {
  query(filter: LogFilter): EventEnvelope[];
  subscribe(
    filter: LogFilter,
    callback: (envelope: EventEnvelope) => void,
  ): () => void;
}

// ---------------------------------------------------------------------------
// Content payload types (parsed from EventEnvelope.content)
// ---------------------------------------------------------------------------

interface TripContent {
  destination: string;
  departs_at: number;
  returns_by?: number;
  route?: string;
  display_name?: string;
  capacity: {
    seats: number;
    cargo: string;
    time_budget: number;
    physical_assistance: boolean;
  };
  max_range: string;
}

interface NeedContent {
  what: string;
  by_when: number;
  location: string;
  display_name?: string;
  resource_footprint: {
    seat: boolean;
    cargo: string;
    time_on_location: number;
    physical_assistance: boolean;
  };
}

interface MatchAcceptContent {
  trip_id: string;
  need_id: string;
}

interface MatchFulfillContent {
  trip_id: string;
  need_id: string;
  match_id: string;
}

interface MatchConfirmContent {
  trip_id: string;
  need_id: string;
  match_id: string;
}

interface SlotReleaseContent {
  match_id: string;
  trip_id: string;
  need_id: string;
  reason?: string;
}

interface SlotReleaseAckContent {
  match_id: string;
  trip_id: string;
  need_id: string;
}

interface TripCloseContent {
  trip_id: string;
}

interface TripCancelContent {
  trip_id: string;
}

// ---------------------------------------------------------------------------
// StateMachine
// ---------------------------------------------------------------------------

export class StateMachine {
  // Primary state maps
  private readonly trips = new Map<string, TripState>();
  private readonly needs = new Map<string, NeedState>();
  private readonly matches = new Map<string, MatchState>();

  // Reverse lookup: tripId -> set of matchIds
  private readonly tripMatches = new Map<string, Set<string>>();

  // Track processed event ids to avoid double-processing
  private readonly processedEvents = new Set<string>();

  private unsubscribe: (() => void) | null = null;

  constructor(private readonly log: LogReader) {}

  // -- Lifecycle -------------------------------------------------------------

  /** Bootstrap state from existing log events and subscribe to new ones. */
  init(): void {
    // Replay all coordination events from the log in created_at order
    const events = this.log.query({
      kinds: [
        EventKind.TRIP_ANNOUNCE,
        EventKind.NEED_SUBMIT,
        EventKind.MATCH_ACCEPT,
        EventKind.MATCH_FULFILL,
        EventKind.MATCH_CONFIRM,
        EventKind.SLOT_RELEASE,
        EventKind.SLOT_RELEASE_ACK,
        EventKind.TRIP_CLOSE,
        EventKind.TRIP_CANCEL,
      ],
    });

    for (const event of events) {
      this.processEvent(event);
    }

    // Subscribe to new coordination events
    this.unsubscribe = this.log.subscribe(
      {
        kinds: [
          EventKind.TRIP_ANNOUNCE,
          EventKind.NEED_SUBMIT,
          EventKind.MATCH_ACCEPT,
          EventKind.MATCH_FULFILL,
          EventKind.MATCH_CONFIRM,
          EventKind.SLOT_RELEASE,
          EventKind.SLOT_RELEASE_ACK,
          EventKind.TRIP_CLOSE,
          EventKind.TRIP_CANCEL,
        ],
      },
      (envelope) => this.processEvent(envelope),
    );
  }

  /** Tear down the subscription. */
  destroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  // -- Public API (matches InterfaceContracts v0.1 §5) -----------------------

  /** Returns all active trips visible to this node (status: 'open'). */
  getActiveTrips(): TripState[] {
    const result: TripState[] = [];
    for (const ts of this.trips.values()) {
      if (ts.status === 'open') {
        result.push(ts);
      }
    }
    return result;
  }

  /** Returns all unmatched needs visible to this node. */
  getUnmatchedNeeds(): NeedState[] {
    const result: NeedState[] = [];
    for (const ns of this.needs.values()) {
      if (ns.status === 'unmatched') {
        result.push(ns);
      }
    }
    return result;
  }

  /** Returns all matches, optionally filtered. */
  getMatches(filter?: MatchFilter): MatchState[] {
    const result: MatchState[] = [];
    for (const ms of this.matches.values()) {
      if (filter) {
        if (filter.tripId !== undefined && ms.tripId !== filter.tripId) continue;
        if (filter.needId !== undefined && ms.needId !== filter.needId) continue;
        if (filter.status !== undefined && ms.status !== filter.status) continue;
        if (filter.runnerPubkey !== undefined && ms.runnerPubkey !== filter.runnerPubkey) continue;
        if (filter.requesterPubkey !== undefined && ms.requesterPubkey !== filter.requesterPubkey) continue;
      }
      result.push(ms);
    }
    return result;
  }

  /** Returns the current state of a specific trip. */
  getTripState(tripId: string): TripState | undefined {
    return this.trips.get(tripId);
  }

  /** Returns the current state of a specific need. */
  getNeedState(needId: string): NeedState | undefined {
    return this.needs.get(needId);
  }

  // -- Event processing (private) --------------------------------------------

  private processEvent(event: EventEnvelope): void {
    // Guard against double-processing (replay + subscription overlap)
    if (this.processedEvents.has(event.id)) return;
    this.processedEvents.add(event.id);

    switch (event.kind) {
      case EventKind.TRIP_ANNOUNCE:
        this.handleTripAnnounce(event);
        break;
      case EventKind.NEED_SUBMIT:
        this.handleNeedSubmit(event);
        break;
      case EventKind.MATCH_ACCEPT:
        this.handleMatchAccept(event);
        break;
      case EventKind.MATCH_FULFILL:
        this.handleMatchFulfill(event);
        break;
      case EventKind.MATCH_CONFIRM:
        this.handleMatchConfirm(event);
        break;
      case EventKind.SLOT_RELEASE:
        this.handleSlotRelease(event);
        break;
      case EventKind.SLOT_RELEASE_ACK:
        this.handleSlotReleaseAck(event);
        break;
      case EventKind.TRIP_CLOSE:
        this.handleTripClose(event);
        break;
      case EventKind.TRIP_CANCEL:
        this.handleTripCancel(event);
        break;
    }
  }

  // -- Kind 1: TRIP_ANNOUNCE -------------------------------------------------

  private handleTripAnnounce(event: EventEnvelope): void {
    const content = this.parseContent<TripContent>(event);
    if (!content) return;

    const remaining: CapacityRemaining = {
      seats: content.capacity.seats,
      cargo: content.capacity.cargo,
      time_budget: content.capacity.time_budget,
      physical_assistance: content.capacity.physical_assistance,
    };

    this.trips.set(event.id, {
      trip: event,
      remaining,
      attachedNeeds: [],
      status: 'open',
    });
  }

  // -- Kind 2: NEED_SUBMIT --------------------------------------------------

  private handleNeedSubmit(event: EventEnvelope): void {
    this.needs.set(event.id, {
      need: event,
      status: 'unmatched',
    });
  }

  // -- Kind 3: MATCH_ACCEPT --------------------------------------------------

  private handleMatchAccept(event: EventEnvelope): void {
    const content = this.parseContent<MatchAcceptContent>(event);
    if (!content) return;

    const { trip_id, need_id } = content;
    const tripState = this.trips.get(trip_id);
    const needState = this.needs.get(need_id);

    if (!tripState || !needState) return;
    // Only the trip's runner can accept needs
    if (event.pubkey !== tripState.trip.pubkey) return;
    // Need must be unmatched to be accepted
    if (needState.status !== 'unmatched') return;

    const matchId = event.id;

    // Create match state
    const matchState: MatchState = {
      matchId,
      tripId: trip_id,
      needId: need_id,
      runnerPubkey: event.pubkey,
      requesterPubkey: needState.need.pubkey,
      status: 'accepted',
    };
    this.matches.set(matchId, matchState);

    // Update need state
    needState.status = 'accepted';
    needState.matchId = matchId;

    // Attach need to trip
    tripState.attachedNeeds.push(needState);

    // Track match under the trip
    let matchSet = this.tripMatches.get(trip_id);
    if (!matchSet) {
      matchSet = new Set();
      this.tripMatches.set(trip_id, matchSet);
    }
    matchSet.add(matchId);

    // Decrement remaining capacity based on the need's resource footprint
    this.decrementCapacity(tripState, needState);
  }

  // -- Kind 4: MATCH_FULFILL -------------------------------------------------

  private handleMatchFulfill(event: EventEnvelope): void {
    const content = this.parseContent<MatchFulfillContent>(event);
    if (!content) return;

    const matchState = this.matches.get(content.match_id);
    if (!matchState) return;
    // Only the runner can mark fulfillment
    if (event.pubkey !== matchState.runnerPubkey) return;
    // Must be in accepted state
    if (matchState.status !== 'accepted') return;

    matchState.status = 'fulfilled';

    // Update the corresponding need state
    const needState = this.needs.get(matchState.needId);
    if (needState) {
      needState.status = 'fulfilled';
    }
  }

  // -- Kind 5: MATCH_CONFIRM ------------------------------------------------

  private handleMatchConfirm(event: EventEnvelope): void {
    const content = this.parseContent<MatchConfirmContent>(event);
    if (!content) return;

    const matchState = this.matches.get(content.match_id);
    if (!matchState) return;
    // Only the requester can confirm
    if (event.pubkey !== matchState.requesterPubkey) return;
    // Must be in fulfilled state
    if (matchState.status !== 'fulfilled') return;

    matchState.status = 'confirmed';

    // Update the corresponding need state
    const needState = this.needs.get(matchState.needId);
    if (needState) {
      needState.status = 'confirmed';
    }

    // Check if all attached needs on this trip are confirmed
    this.checkTripCompleted(matchState.tripId);
  }

  // -- Kind 6: SLOT_RELEASE --------------------------------------------------

  private handleSlotRelease(event: EventEnvelope): void {
    const content = this.parseContent<SlotReleaseContent>(event);
    if (!content) return;

    const matchState = this.matches.get(content.match_id);
    if (!matchState) return;
    // Only the requester can release their slot
    if (event.pubkey !== matchState.requesterPubkey) return;
    // Can only release an accepted (not yet fulfilled/confirmed) match
    if (matchState.status !== 'accepted') return;

    // Update need state to released
    const needState = this.needs.get(matchState.needId);
    if (needState) {
      needState.status = 'released';
    }
  }

  // -- Kind 7: SLOT_RELEASE_ACK ----------------------------------------------

  private handleSlotReleaseAck(event: EventEnvelope): void {
    const content = this.parseContent<SlotReleaseAckContent>(event);
    if (!content) return;

    const matchState = this.matches.get(content.match_id);
    if (!matchState) return;
    // Only the runner can acknowledge a release
    if (event.pubkey !== matchState.runnerPubkey) return;

    // Verify the need is in released state (slot_release must have come first)
    const needState = this.needs.get(matchState.needId);
    if (!needState || needState.status !== 'released') return;

    const tripState = this.trips.get(matchState.tripId);
    if (!tripState) return;

    // Remove need from attached list
    const idx = tripState.attachedNeeds.findIndex(
      (ns) => ns.need.id === matchState.needId,
    );
    if (idx !== -1) {
      tripState.attachedNeeds.splice(idx, 1);
    }

    // Restore capacity
    this.incrementCapacity(tripState, needState);

    // Remove match tracking
    this.matches.delete(content.match_id);
    const matchSet = this.tripMatches.get(matchState.tripId);
    if (matchSet) {
      matchSet.delete(content.match_id);
    }

    // Reset need state back to unmatched
    needState.status = 'unmatched';
    needState.matchId = undefined;
  }

  // -- Kind 8: TRIP_CLOSE ----------------------------------------------------

  private handleTripClose(event: EventEnvelope): void {
    const content = this.parseContent<TripCloseContent>(event);
    if (!content) return;

    const tripState = this.trips.get(content.trip_id);
    if (!tripState) return;
    // Only the runner can close their trip
    if (event.pubkey !== tripState.trip.pubkey) return;
    // Can only close an open trip
    if (tripState.status !== 'open') return;

    tripState.status = 'closed';
  }

  // -- Kind 9: TRIP_CANCEL ---------------------------------------------------

  private handleTripCancel(event: EventEnvelope): void {
    const content = this.parseContent<TripCancelContent>(event);
    if (!content) return;

    const tripState = this.trips.get(content.trip_id);
    if (!tripState) return;
    // Only the runner can cancel their trip
    if (event.pubkey !== tripState.trip.pubkey) return;
    // Can only cancel an open or closed trip
    if (tripState.status !== 'open' && tripState.status !== 'closed') return;

    tripState.status = 'cancelled';
  }

  // -- Capacity helpers ------------------------------------------------------

  private decrementCapacity(tripState: TripState, needState: NeedState): void {
    const needContent = this.parseContent<NeedContent>(needState.need);
    if (!needContent) return;

    const footprint = needContent.resource_footprint;

    if (footprint.seat) {
      tripState.remaining.seats = Math.max(0, tripState.remaining.seats - 1);
    }

    tripState.remaining.time_budget = Math.max(
      0,
      tripState.remaining.time_budget - footprint.time_on_location,
    );

    if (footprint.physical_assistance) {
      tripState.remaining.physical_assistance = false;
    }
  }

  private incrementCapacity(tripState: TripState, needState: NeedState): void {
    const needContent = this.parseContent<NeedContent>(needState.need);
    if (!needContent) return;

    const tripContent = this.parseContent<TripContent>(tripState.trip);
    if (!tripContent) return;

    const footprint = needContent.resource_footprint;

    if (footprint.seat) {
      tripState.remaining.seats = Math.min(
        tripContent.capacity.seats,
        tripState.remaining.seats + 1,
      );
    }

    tripState.remaining.time_budget = Math.min(
      tripContent.capacity.time_budget,
      tripState.remaining.time_budget + footprint.time_on_location,
    );

    if (footprint.physical_assistance) {
      // Restore if the original trip had it
      tripState.remaining.physical_assistance =
        tripContent.capacity.physical_assistance;
    }
  }

  /** Check if all attached needs on a trip are confirmed -> mark trip completed. */
  private checkTripCompleted(tripId: string): void {
    const tripState = this.trips.get(tripId);
    if (!tripState) return;
    if (tripState.status === 'cancelled') return;

    // A trip is completed when it's closed and all attached needs are confirmed
    if (
      tripState.status === 'closed' &&
      tripState.attachedNeeds.length > 0 &&
      tripState.attachedNeeds.every((ns) => ns.status === 'confirmed')
    ) {
      tripState.status = 'completed';
    }
  }

  // -- Utilities -------------------------------------------------------------

  private parseContent<T>(event: EventEnvelope): T | null {
    try {
      return JSON.parse(event.content) as T;
    } catch {
      return null;
    }
  }
}
