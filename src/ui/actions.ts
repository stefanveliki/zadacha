/**
 * Rural Run Protocol — UI Actions
 *
 * Implements the UIActions interface from InterfaceContracts v0.1 §6.
 * Every action builds a signed event via IdentityLayer.buildEvent()
 * and publishes it to all available transports.
 */

import type { EventEnvelope, TransportAdapter } from '../shared/types.js';
import { EventKind } from '../shared/types.js';

// ---------------------------------------------------------------------------
// Dependency interfaces — match InterfaceContracts v0.1
// The UI consumes these through injection, never through direct imports
// of implementation modules.
// ---------------------------------------------------------------------------

/** Identity layer contract (InterfaceContracts §3). */
export interface IdentityLayer {
  getPublicKey(): Promise<string>;
  signEvent(eventId: string): Promise<string>;
  buildEvent(kind: number, content: object): Promise<EventEnvelope>;
}

/** State machine reader contract (InterfaceContracts §5) — subset the UI needs. */
export interface StateReader {
  getActiveTrips(): TripState[];
  getUnmatchedNeeds(): NeedState[];
  getMatches(filter?: MatchFilter): MatchState[];
  getTripState(tripId: string): TripState | undefined;
  getNeedState(needId: string): NeedState | undefined;
}

// ---------------------------------------------------------------------------
// State types — mirror InterfaceContracts v0.1 §5
// ---------------------------------------------------------------------------

export interface CapacityRemaining {
  seats: number;
  cargo: string;
  time_budget: number;
  physical_assistance: boolean;
}

export interface NeedState {
  need: EventEnvelope;
  status: 'unmatched' | 'accepted' | 'fulfilled' | 'confirmed' | 'released';
  matchId?: string;
}

export interface TripState {
  trip: EventEnvelope;
  remaining: CapacityRemaining;
  attachedNeeds: NeedState[];
  status: 'open' | 'closed' | 'cancelled' | 'completed';
}

export interface MatchState {
  matchId: string;
  tripId: string;
  needId: string;
  runnerPubkey: string;
  requesterPubkey: string;
  status: 'accepted' | 'fulfilled' | 'confirmed';
}

export interface MatchFilter {
  tripId?: string;
  needId?: string;
  status?: 'accepted' | 'fulfilled' | 'confirmed';
  runnerPubkey?: string;
  requesterPubkey?: string;
}

// ---------------------------------------------------------------------------
// Action parameter types — derived from DataModel v0.1
// ---------------------------------------------------------------------------

export interface TripParams {
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

export interface NeedParams {
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

// ---------------------------------------------------------------------------
// UIActions interface — InterfaceContracts v0.1 §6
// ---------------------------------------------------------------------------

export interface UIActions {
  // Runner actions
  announceTrip(params: TripParams): Promise<void>;
  acceptNeed(tripId: string, needId: string): Promise<void>;
  fulfillNeed(matchId: string): Promise<void>;
  closeTrip(tripId: string): Promise<void>;
  cancelTrip(tripId: string): Promise<void>;

  // Requester actions
  submitNeed(params: NeedParams): Promise<void>;
  confirmFulfillment(matchId: string): Promise<void>;
  releaseSlot(matchId: string, reason?: string): Promise<void>;

  // Identity actions
  setupGuardians(guardianPubkeys: string[]): Promise<void>;
  rotateGuardians(oldGuardians: string[], newGuardians: string[]): Promise<void>;
  initiateRecovery(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class UIActionsImpl implements UIActions {
  constructor(
    private readonly identity: IdentityLayer,
    private readonly transports: TransportAdapter[],
    private readonly state: StateReader,
  ) {}

  // -- Runner actions -------------------------------------------------------

  async announceTrip(params: TripParams): Promise<void> {
    const envelope = await this.identity.buildEvent(EventKind.TRIP_ANNOUNCE, params);
    await this.publishToAll(envelope);
  }

  async acceptNeed(tripId: string, needId: string): Promise<void> {
    const envelope = await this.identity.buildEvent(EventKind.MATCH_ACCEPT, {
      trip_id: tripId,
      need_id: needId,
    });
    await this.publishToAll(envelope);
  }

  async fulfillNeed(matchId: string): Promise<void> {
    const match = this.findMatch(matchId);
    const envelope = await this.identity.buildEvent(EventKind.MATCH_FULFILL, {
      trip_id: match.tripId,
      need_id: match.needId,
      match_id: matchId,
    });
    await this.publishToAll(envelope);
  }

  async closeTrip(tripId: string): Promise<void> {
    const envelope = await this.identity.buildEvent(EventKind.TRIP_CLOSE, {
      trip_id: tripId,
    });
    await this.publishToAll(envelope);
  }

  async cancelTrip(tripId: string): Promise<void> {
    const envelope = await this.identity.buildEvent(EventKind.TRIP_CANCEL, {
      trip_id: tripId,
    });
    await this.publishToAll(envelope);
  }

  // -- Requester actions ----------------------------------------------------

  async submitNeed(params: NeedParams): Promise<void> {
    const envelope = await this.identity.buildEvent(EventKind.NEED_SUBMIT, params);
    await this.publishToAll(envelope);
  }

  async confirmFulfillment(matchId: string): Promise<void> {
    const match = this.findMatch(matchId);
    const envelope = await this.identity.buildEvent(EventKind.MATCH_CONFIRM, {
      trip_id: match.tripId,
      need_id: match.needId,
      match_id: matchId,
    });
    await this.publishToAll(envelope);
  }

  async releaseSlot(matchId: string, reason?: string): Promise<void> {
    const match = this.findMatch(matchId);
    const content: Record<string, unknown> = {
      match_id: matchId,
      trip_id: match.tripId,
      need_id: match.needId,
    };
    if (reason !== undefined) {
      content['reason'] = reason;
    }
    const envelope = await this.identity.buildEvent(EventKind.SLOT_RELEASE, content);
    await this.publishToAll(envelope);
  }

  // -- Identity actions -----------------------------------------------------

  async setupGuardians(guardianPubkeys: string[]): Promise<void> {
    const envelope = await this.identity.buildEvent(EventKind.GUARDIAN_SET, {
      guardians: guardianPubkeys,
      threshold: Math.min(2, guardianPubkeys.length),
      encrypted_shards: {},
    });
    await this.publishToAll(envelope);
  }

  async rotateGuardians(oldGuardians: string[], newGuardians: string[]): Promise<void> {
    const envelope = await this.identity.buildEvent(EventKind.GUARDIAN_ROTATE, {
      old_guardians: oldGuardians,
      new_guardians: newGuardians,
      threshold: Math.min(2, newGuardians.length),
      old_guardian_sigs: [],
      encrypted_shards: {},
    });
    await this.publishToAll(envelope);
  }

  async initiateRecovery(): Promise<void> {
    const pubkey = await this.identity.getPublicKey();
    const envelope = await this.identity.buildEvent(EventKind.RECOVERY_INIT, {
      recovering_pubkey: pubkey,
      new_device_pubkey: pubkey,
      timestamp: Math.floor(Date.now() / 1000),
    });
    await this.publishToAll(envelope);
  }

  // -- Private helpers ------------------------------------------------------

  private findMatch(matchId: string): MatchState {
    const matches = this.state.getMatches();
    const match = matches.find((m) => m.matchId === matchId);
    if (!match) {
      throw new Error(`Match not found: ${matchId}`);
    }
    return match;
  }

  private async publishToAll(envelope: EventEnvelope): Promise<void> {
    const available = this.transports.filter((t) => t.isAvailable());
    if (available.length === 0) {
      return;
    }
    await Promise.allSettled(available.map((t) => t.publish(envelope)));
  }
}
