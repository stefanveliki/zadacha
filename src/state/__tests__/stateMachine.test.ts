import { describe, it, expect, beforeEach } from 'vitest';
import { EventKind } from '../../shared/types.js';
import { StateMachine } from '../stateMachine.js';
import {
  generateKeypair,
  buildEnvelope,
  buildTripEnvelope,
  buildNeedEnvelope,
  buildMatchEnvelope,
  MockLog,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const runner = generateKeypair();
const requester = generateKeypair();
const anotherRunner = generateKeypair();
const anotherRequester = generateKeypair();

const NOW = Math.floor(Date.now() / 1000);

function tripContent(overrides?: Record<string, unknown>) {
  return {
    destination: 'Town market',
    departs_at: NOW + 3600,
    capacity: {
      seats: 3,
      cargo: 'half a trunk',
      time_budget: 60,
      physical_assistance: true,
    },
    max_range: '5 km',
    ...overrides,
  };
}

function needContent(overrides?: Record<string, unknown>) {
  return {
    what: 'Heart medication from pharmacy',
    by_when: NOW + 7200,
    location: 'Village center',
    resource_footprint: {
      seat: true,
      cargo: 'small box',
      time_on_location: 15,
      physical_assistance: false,
    },
    ...overrides,
  };
}

/** Helper: set up a log + state machine pair, already init'd. */
function setup() {
  const log = new MockLog();
  const sm = new StateMachine(log);
  sm.init();
  return { log, sm };
}

/** Helper: announce a trip, returns its envelope. */
function announceTrip(
  log: MockLog,
  privkey: string,
  content?: object,
  ts?: number,
) {
  const env = buildTripEnvelope(privkey, content ?? tripContent(), {
    created_at: ts ?? NOW,
  });
  log.receive(env);
  return env;
}

/** Helper: submit a need, returns its envelope. */
function submitNeed(
  log: MockLog,
  privkey: string,
  content?: object,
  ts?: number,
) {
  const env = buildNeedEnvelope(privkey, content ?? needContent(), {
    created_at: ts ?? NOW + 1,
  });
  log.receive(env);
  return env;
}

/** Helper: accept a need onto a trip, returns match envelope. */
function acceptNeed(
  log: MockLog,
  runnerPrivkey: string,
  tripId: string,
  needId: string,
  ts?: number,
) {
  const env = buildMatchEnvelope(runnerPrivkey, tripId, needId, {
    created_at: ts ?? NOW + 2,
  });
  log.receive(env);
  return env;
}

/** Helper: fulfill a match. */
function fulfillMatch(
  log: MockLog,
  runnerPrivkey: string,
  matchId: string,
  tripId: string,
  needId: string,
  ts?: number,
) {
  const env = buildEnvelope(
    runnerPrivkey,
    EventKind.MATCH_FULFILL,
    { match_id: matchId, trip_id: tripId, need_id: needId },
    { created_at: ts ?? NOW + 3 },
  );
  log.receive(env);
  return env;
}

/** Helper: confirm fulfillment. */
function confirmMatch(
  log: MockLog,
  requesterPrivkey: string,
  matchId: string,
  tripId: string,
  needId: string,
  ts?: number,
) {
  const env = buildEnvelope(
    requesterPrivkey,
    EventKind.MATCH_CONFIRM,
    { match_id: matchId, trip_id: tripId, need_id: needId },
    { created_at: ts ?? NOW + 4 },
  );
  log.receive(env);
  return env;
}

/** Helper: release a slot. */
function releaseSlot(
  log: MockLog,
  requesterPrivkey: string,
  matchId: string,
  tripId: string,
  needId: string,
  reason?: string,
  ts?: number,
) {
  const env = buildEnvelope(
    requesterPrivkey,
    EventKind.SLOT_RELEASE,
    { match_id: matchId, trip_id: tripId, need_id: needId, reason },
    { created_at: ts ?? NOW + 5 },
  );
  log.receive(env);
  return env;
}

/** Helper: ack a slot release. */
function ackSlotRelease(
  log: MockLog,
  runnerPrivkey: string,
  matchId: string,
  tripId: string,
  needId: string,
  ts?: number,
) {
  const env = buildEnvelope(
    runnerPrivkey,
    EventKind.SLOT_RELEASE_ACK,
    { match_id: matchId, trip_id: tripId, need_id: needId },
    { created_at: ts ?? NOW + 6 },
  );
  log.receive(env);
  return env;
}

/** Helper: close a trip. */
function closeTrip(
  log: MockLog,
  runnerPrivkey: string,
  tripId: string,
  ts?: number,
) {
  const env = buildEnvelope(
    runnerPrivkey,
    EventKind.TRIP_CLOSE,
    { trip_id: tripId },
    { created_at: ts ?? NOW + 10 },
  );
  log.receive(env);
  return env;
}

/** Helper: cancel a trip. */
function cancelTrip(
  log: MockLog,
  runnerPrivkey: string,
  tripId: string,
  ts?: number,
) {
  const env = buildEnvelope(
    runnerPrivkey,
    EventKind.TRIP_CANCEL,
    { trip_id: tripId },
    { created_at: ts ?? NOW + 10 },
  );
  log.receive(env);
  return env;
}

// ===========================================================================
// Tests
// ===========================================================================

describe('StateMachine — Trip Announce (Kind 1)', () => {
  it('creates a TripState on TRIP_ANNOUNCE', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);

    const ts = sm.getTripState(trip.id);
    expect(ts).toBeDefined();
    expect(ts!.trip.id).toBe(trip.id);
    expect(ts!.status).toBe('open');
    expect(ts!.attachedNeeds).toHaveLength(0);
  });

  it('sets remaining capacity from declared capacity', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);

    const ts = sm.getTripState(trip.id)!;
    expect(ts.remaining.seats).toBe(3);
    expect(ts.remaining.cargo).toBe('half a trunk');
    expect(ts.remaining.time_budget).toBe(60);
    expect(ts.remaining.physical_assistance).toBe(true);
  });

  it('appears in getActiveTrips()', () => {
    const { log, sm } = setup();
    announceTrip(log, runner.privkey);

    expect(sm.getActiveTrips()).toHaveLength(1);
  });

  it('handles multiple trips', () => {
    const { log, sm } = setup();
    announceTrip(log, runner.privkey, tripContent(), NOW);
    announceTrip(log, anotherRunner.privkey, tripContent(), NOW + 1);

    expect(sm.getActiveTrips()).toHaveLength(2);
  });
});

describe('StateMachine — Need Submit (Kind 2)', () => {
  it('creates a NeedState on NEED_SUBMIT', () => {
    const { log, sm } = setup();
    const need = submitNeed(log, requester.privkey);

    const ns = sm.getNeedState(need.id);
    expect(ns).toBeDefined();
    expect(ns!.need.id).toBe(need.id);
    expect(ns!.status).toBe('unmatched');
    expect(ns!.matchId).toBeUndefined();
  });

  it('appears in getUnmatchedNeeds()', () => {
    const { log, sm } = setup();
    submitNeed(log, requester.privkey);

    expect(sm.getUnmatchedNeeds()).toHaveLength(1);
  });

  it('handles multiple needs', () => {
    const { log, sm } = setup();
    submitNeed(log, requester.privkey, needContent(), NOW);
    submitNeed(log, anotherRequester.privkey, needContent(), NOW + 1);

    expect(sm.getUnmatchedNeeds()).toHaveLength(2);
  });
});

describe('StateMachine — Match Accept (Kind 3)', () => {
  it('links need to trip on MATCH_ACCEPT', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    const need = submitNeed(log, requester.privkey);
    const match = acceptNeed(log, runner.privkey, trip.id, need.id);

    const ns = sm.getNeedState(need.id)!;
    expect(ns.status).toBe('accepted');
    expect(ns.matchId).toBe(match.id);

    const ts = sm.getTripState(trip.id)!;
    expect(ts.attachedNeeds).toHaveLength(1);
    expect(ts.attachedNeeds[0]!.need.id).toBe(need.id);
  });

  it('need no longer appears in getUnmatchedNeeds()', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    const need = submitNeed(log, requester.privkey);
    acceptNeed(log, runner.privkey, trip.id, need.id);

    expect(sm.getUnmatchedNeeds()).toHaveLength(0);
  });

  it('creates a MatchState', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    const need = submitNeed(log, requester.privkey);
    const match = acceptNeed(log, runner.privkey, trip.id, need.id);

    const matches = sm.getMatches();
    expect(matches).toHaveLength(1);
    expect(matches[0]!.matchId).toBe(match.id);
    expect(matches[0]!.tripId).toBe(trip.id);
    expect(matches[0]!.needId).toBe(need.id);
    expect(matches[0]!.status).toBe('accepted');
  });

  it('decrements remaining capacity', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    const need = submitNeed(log, requester.privkey); // seat: true, time: 15
    acceptNeed(log, runner.privkey, trip.id, need.id);

    const ts = sm.getTripState(trip.id)!;
    expect(ts.remaining.seats).toBe(2); // 3 - 1
    expect(ts.remaining.time_budget).toBe(45); // 60 - 15
  });

  it('rejects accept from non-runner', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    const need = submitNeed(log, requester.privkey);
    // requester tries to accept — should be ignored
    acceptNeed(log, requester.privkey, trip.id, need.id);

    expect(sm.getNeedState(need.id)!.status).toBe('unmatched');
    expect(sm.getMatches()).toHaveLength(0);
  });

  it('rejects accept for already-matched need', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    const need = submitNeed(log, requester.privkey);
    acceptNeed(log, runner.privkey, trip.id, need.id, NOW + 2);
    // try to accept the same need again
    acceptNeed(log, runner.privkey, trip.id, need.id, NOW + 3);

    expect(sm.getMatches()).toHaveLength(1);
  });

  it('handles multiple needs accepted onto one trip', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    const need1 = submitNeed(log, requester.privkey, needContent(), NOW + 1);
    const need2 = submitNeed(
      log,
      anotherRequester.privkey,
      needContent({ resource_footprint: { seat: true, cargo: 'bag', time_on_location: 10, physical_assistance: true } }),
      NOW + 2,
    );
    acceptNeed(log, runner.privkey, trip.id, need1.id, NOW + 3);
    acceptNeed(log, runner.privkey, trip.id, need2.id, NOW + 4);

    const ts = sm.getTripState(trip.id)!;
    expect(ts.attachedNeeds).toHaveLength(2);
    expect(ts.remaining.seats).toBe(1); // 3 - 1 - 1
    expect(ts.remaining.time_budget).toBe(35); // 60 - 15 - 10
    expect(ts.remaining.physical_assistance).toBe(false); // second need required it
  });
});

describe('StateMachine — Match Fulfill (Kind 4)', () => {
  it('advances match and need to fulfilled', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    const need = submitNeed(log, requester.privkey);
    const match = acceptNeed(log, runner.privkey, trip.id, need.id);
    fulfillMatch(log, runner.privkey, match.id, trip.id, need.id);

    expect(sm.getNeedState(need.id)!.status).toBe('fulfilled');
    expect(sm.getMatches()[0]!.status).toBe('fulfilled');
  });

  it('rejects fulfill from non-runner', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    const need = submitNeed(log, requester.privkey);
    const match = acceptNeed(log, runner.privkey, trip.id, need.id);
    // requester tries to fulfill
    fulfillMatch(log, requester.privkey, match.id, trip.id, need.id);

    expect(sm.getMatches()[0]!.status).toBe('accepted');
  });

  it('rejects fulfill if match is not in accepted state', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    const need = submitNeed(log, requester.privkey);
    const match = acceptNeed(log, runner.privkey, trip.id, need.id);
    fulfillMatch(log, runner.privkey, match.id, trip.id, need.id, NOW + 3);
    // double-fulfill should be ignored
    fulfillMatch(log, runner.privkey, match.id, trip.id, need.id, NOW + 4);

    expect(sm.getMatches()[0]!.status).toBe('fulfilled');
  });
});

describe('StateMachine — Match Confirm (Kind 5)', () => {
  it('advances match and need to confirmed', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    const need = submitNeed(log, requester.privkey);
    const match = acceptNeed(log, runner.privkey, trip.id, need.id);
    fulfillMatch(log, runner.privkey, match.id, trip.id, need.id);
    confirmMatch(log, requester.privkey, match.id, trip.id, need.id);

    expect(sm.getNeedState(need.id)!.status).toBe('confirmed');
    expect(sm.getMatches()[0]!.status).toBe('confirmed');
  });

  it('rejects confirm from non-requester', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    const need = submitNeed(log, requester.privkey);
    const match = acceptNeed(log, runner.privkey, trip.id, need.id);
    fulfillMatch(log, runner.privkey, match.id, trip.id, need.id);
    // runner tries to confirm
    confirmMatch(log, runner.privkey, match.id, trip.id, need.id);

    expect(sm.getMatches()[0]!.status).toBe('fulfilled');
  });

  it('rejects confirm if match is not in fulfilled state', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    const need = submitNeed(log, requester.privkey);
    const match = acceptNeed(log, runner.privkey, trip.id, need.id);
    // skip fulfillment, try to confirm directly
    confirmMatch(log, requester.privkey, match.id, trip.id, need.id);

    expect(sm.getMatches()[0]!.status).toBe('accepted');
  });
});

describe('StateMachine — Full lifecycle (announce → accept → fulfill → confirm)', () => {
  it('processes a complete match lifecycle end-to-end', () => {
    const { log, sm } = setup();

    // 1. Runner announces trip
    const trip = announceTrip(log, runner.privkey);
    expect(sm.getActiveTrips()).toHaveLength(1);

    // 2. Requester submits need
    const need = submitNeed(log, requester.privkey);
    expect(sm.getUnmatchedNeeds()).toHaveLength(1);

    // 3. Runner accepts need
    const match = acceptNeed(log, runner.privkey, trip.id, need.id);
    expect(sm.getUnmatchedNeeds()).toHaveLength(0);
    expect(sm.getTripState(trip.id)!.attachedNeeds).toHaveLength(1);

    // 4. Runner fulfills
    fulfillMatch(log, runner.privkey, match.id, trip.id, need.id);
    expect(sm.getNeedState(need.id)!.status).toBe('fulfilled');

    // 5. Requester confirms
    confirmMatch(log, requester.privkey, match.id, trip.id, need.id);
    expect(sm.getNeedState(need.id)!.status).toBe('confirmed');
    expect(sm.getMatches()[0]!.status).toBe('confirmed');
  });
});

describe('StateMachine — Slot Release (Kinds 6 + 7)', () => {
  it('release sets need status to released', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    const need = submitNeed(log, requester.privkey);
    const match = acceptNeed(log, runner.privkey, trip.id, need.id);
    releaseSlot(log, requester.privkey, match.id, trip.id, need.id);

    expect(sm.getNeedState(need.id)!.status).toBe('released');
  });

  it('release + ack restores capacity and resets need to unmatched', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    const need = submitNeed(log, requester.privkey); // seat: true, time: 15
    const match = acceptNeed(log, runner.privkey, trip.id, need.id);

    // Capacity after accept
    expect(sm.getTripState(trip.id)!.remaining.seats).toBe(2);
    expect(sm.getTripState(trip.id)!.remaining.time_budget).toBe(45);

    releaseSlot(log, requester.privkey, match.id, trip.id, need.id);
    ackSlotRelease(log, runner.privkey, match.id, trip.id, need.id);

    // Capacity restored
    const ts = sm.getTripState(trip.id)!;
    expect(ts.remaining.seats).toBe(3);
    expect(ts.remaining.time_budget).toBe(60);
    expect(ts.attachedNeeds).toHaveLength(0);

    // Need is back to unmatched
    const ns = sm.getNeedState(need.id)!;
    expect(ns.status).toBe('unmatched');
    expect(ns.matchId).toBeUndefined();

    // Match is removed
    expect(sm.getMatches()).toHaveLength(0);

    // Need appears in unmatched list again
    expect(sm.getUnmatchedNeeds()).toHaveLength(1);
  });

  it('rejects release from non-requester', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    const need = submitNeed(log, requester.privkey);
    const match = acceptNeed(log, runner.privkey, trip.id, need.id);
    // runner tries to release requester's slot
    releaseSlot(log, runner.privkey, match.id, trip.id, need.id);

    expect(sm.getNeedState(need.id)!.status).toBe('accepted');
  });

  it('rejects release on a fulfilled match', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    const need = submitNeed(log, requester.privkey);
    const match = acceptNeed(log, runner.privkey, trip.id, need.id);
    fulfillMatch(log, runner.privkey, match.id, trip.id, need.id);
    releaseSlot(log, requester.privkey, match.id, trip.id, need.id);

    expect(sm.getNeedState(need.id)!.status).toBe('fulfilled');
  });

  it('ack from non-runner is ignored', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    const need = submitNeed(log, requester.privkey);
    const match = acceptNeed(log, runner.privkey, trip.id, need.id);
    releaseSlot(log, requester.privkey, match.id, trip.id, need.id);
    // requester tries to ack their own release
    ackSlotRelease(log, requester.privkey, match.id, trip.id, need.id);

    expect(sm.getNeedState(need.id)!.status).toBe('released');
  });

  it('ack without prior release is ignored', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    const need = submitNeed(log, requester.privkey);
    const match = acceptNeed(log, runner.privkey, trip.id, need.id);
    // ack without release
    ackSlotRelease(log, runner.privkey, match.id, trip.id, need.id);

    expect(sm.getNeedState(need.id)!.status).toBe('accepted');
    expect(sm.getTripState(trip.id)!.attachedNeeds).toHaveLength(1);
  });
});

describe('StateMachine — Trip Close (Kind 8)', () => {
  it('marks trip as closed', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    closeTrip(log, runner.privkey, trip.id);

    expect(sm.getTripState(trip.id)!.status).toBe('closed');
  });

  it('closed trip no longer appears in getActiveTrips()', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    closeTrip(log, runner.privkey, trip.id);

    expect(sm.getActiveTrips()).toHaveLength(0);
  });

  it('rejects close from non-runner', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    closeTrip(log, requester.privkey, trip.id);

    expect(sm.getTripState(trip.id)!.status).toBe('open');
  });

  it('rejects close on already closed trip', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    closeTrip(log, runner.privkey, trip.id, NOW + 10);
    // close again — should be a no-op
    closeTrip(log, runner.privkey, trip.id, NOW + 11);

    expect(sm.getTripState(trip.id)!.status).toBe('closed');
  });
});

describe('StateMachine — Trip Cancel (Kind 9)', () => {
  it('marks trip as cancelled', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    cancelTrip(log, runner.privkey, trip.id);

    expect(sm.getTripState(trip.id)!.status).toBe('cancelled');
  });

  it('cancelled trip no longer appears in getActiveTrips()', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    cancelTrip(log, runner.privkey, trip.id);

    expect(sm.getActiveTrips()).toHaveLength(0);
  });

  it('can cancel a closed trip', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    closeTrip(log, runner.privkey, trip.id, NOW + 10);
    cancelTrip(log, runner.privkey, trip.id, NOW + 11);

    expect(sm.getTripState(trip.id)!.status).toBe('cancelled');
  });

  it('rejects cancel from non-runner', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    cancelTrip(log, requester.privkey, trip.id);

    expect(sm.getTripState(trip.id)!.status).toBe('open');
  });
});

describe('StateMachine — Trip Completed (derived status)', () => {
  it('trip becomes completed when closed and all needs confirmed', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    const need = submitNeed(log, requester.privkey);
    const match = acceptNeed(log, runner.privkey, trip.id, need.id);
    fulfillMatch(log, runner.privkey, match.id, trip.id, need.id);

    // Close the trip before confirming
    closeTrip(log, runner.privkey, trip.id, NOW + 3.5);
    expect(sm.getTripState(trip.id)!.status).toBe('closed');

    // Requester confirms
    confirmMatch(log, requester.privkey, match.id, trip.id, need.id);
    expect(sm.getTripState(trip.id)!.status).toBe('completed');
  });

  it('trip stays closed if not all needs confirmed', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    const need1 = submitNeed(log, requester.privkey, needContent(), NOW + 1);
    const need2 = submitNeed(log, anotherRequester.privkey, needContent(), NOW + 2);
    const match1 = acceptNeed(log, runner.privkey, trip.id, need1.id, NOW + 3);
    const match2 = acceptNeed(log, runner.privkey, trip.id, need2.id, NOW + 4);
    fulfillMatch(log, runner.privkey, match1.id, trip.id, need1.id, NOW + 5);
    fulfillMatch(log, runner.privkey, match2.id, trip.id, need2.id, NOW + 6);
    closeTrip(log, runner.privkey, trip.id, NOW + 7);

    // Only first requester confirms
    confirmMatch(log, requester.privkey, match1.id, trip.id, need1.id, NOW + 8);
    expect(sm.getTripState(trip.id)!.status).toBe('closed');

    // Second requester confirms -> now completed
    confirmMatch(log, anotherRequester.privkey, match2.id, trip.id, need2.id, NOW + 9);
    expect(sm.getTripState(trip.id)!.status).toBe('completed');
  });

  it('open trip with all confirmed needs stays open', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    const need = submitNeed(log, requester.privkey);
    const match = acceptNeed(log, runner.privkey, trip.id, need.id);
    fulfillMatch(log, runner.privkey, match.id, trip.id, need.id);
    confirmMatch(log, requester.privkey, match.id, trip.id, need.id);

    // Trip is still open (not closed) so should not be completed
    expect(sm.getTripState(trip.id)!.status).toBe('open');
  });
});

describe('StateMachine — Capacity computation', () => {
  it('tracks seat decrement correctly', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    const need = submitNeed(log, requester.privkey, needContent({
      resource_footprint: { seat: true, cargo: 'bag', time_on_location: 0, physical_assistance: false },
    }));
    acceptNeed(log, runner.privkey, trip.id, need.id);

    expect(sm.getTripState(trip.id)!.remaining.seats).toBe(2);
  });

  it('does not decrement seats when need has seat: false', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    const need = submitNeed(log, requester.privkey, needContent({
      resource_footprint: { seat: false, cargo: 'parcel', time_on_location: 5, physical_assistance: false },
    }));
    acceptNeed(log, runner.privkey, trip.id, need.id);

    expect(sm.getTripState(trip.id)!.remaining.seats).toBe(3);
    expect(sm.getTripState(trip.id)!.remaining.time_budget).toBe(55);
  });

  it('physical_assistance becomes false when consumed', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    const need = submitNeed(log, requester.privkey, needContent({
      resource_footprint: { seat: false, cargo: 'box', time_on_location: 0, physical_assistance: true },
    }));
    acceptNeed(log, runner.privkey, trip.id, need.id);

    expect(sm.getTripState(trip.id)!.remaining.physical_assistance).toBe(false);
  });

  it('seats cannot go below zero', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey, tripContent({
      capacity: { seats: 1, cargo: 'small', time_budget: 120, physical_assistance: false },
    }));
    const need1 = submitNeed(log, requester.privkey, needContent({
      resource_footprint: { seat: true, cargo: 'x', time_on_location: 0, physical_assistance: false },
    }), NOW + 1);
    const need2 = submitNeed(log, anotherRequester.privkey, needContent({
      resource_footprint: { seat: true, cargo: 'y', time_on_location: 0, physical_assistance: false },
    }), NOW + 2);

    acceptNeed(log, runner.privkey, trip.id, need1.id, NOW + 3);
    acceptNeed(log, runner.privkey, trip.id, need2.id, NOW + 4);

    // Runner can still accept (runner is the authority), but seats floor at 0
    expect(sm.getTripState(trip.id)!.remaining.seats).toBe(0);
  });

  it('time_budget cannot go below zero', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey, tripContent({
      capacity: { seats: 10, cargo: 'big', time_budget: 10, physical_assistance: false },
    }));
    const need = submitNeed(log, requester.privkey, needContent({
      resource_footprint: { seat: false, cargo: 'x', time_on_location: 20, physical_assistance: false },
    }));
    acceptNeed(log, runner.privkey, trip.id, need.id);

    expect(sm.getTripState(trip.id)!.remaining.time_budget).toBe(0);
  });
});

describe('StateMachine — getMatches filter', () => {
  it('filters by tripId', () => {
    const { log, sm } = setup();
    const trip1 = announceTrip(log, runner.privkey, tripContent(), NOW);
    const trip2 = announceTrip(log, anotherRunner.privkey, tripContent(), NOW + 1);
    const need1 = submitNeed(log, requester.privkey, needContent(), NOW + 2);
    const need2 = submitNeed(log, anotherRequester.privkey, needContent(), NOW + 3);
    acceptNeed(log, runner.privkey, trip1.id, need1.id, NOW + 4);
    acceptNeed(log, anotherRunner.privkey, trip2.id, need2.id, NOW + 5);

    expect(sm.getMatches({ tripId: trip1.id })).toHaveLength(1);
    expect(sm.getMatches({ tripId: trip2.id })).toHaveLength(1);
  });

  it('filters by needId', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    const need1 = submitNeed(log, requester.privkey, needContent(), NOW + 1);
    const need2 = submitNeed(log, anotherRequester.privkey, needContent(), NOW + 2);
    acceptNeed(log, runner.privkey, trip.id, need1.id, NOW + 3);
    acceptNeed(log, runner.privkey, trip.id, need2.id, NOW + 4);

    expect(sm.getMatches({ needId: need1.id })).toHaveLength(1);
  });

  it('filters by status', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    const need1 = submitNeed(log, requester.privkey, needContent(), NOW + 1);
    const need2 = submitNeed(log, anotherRequester.privkey, needContent(), NOW + 2);
    const match1 = acceptNeed(log, runner.privkey, trip.id, need1.id, NOW + 3);
    acceptNeed(log, runner.privkey, trip.id, need2.id, NOW + 4);
    fulfillMatch(log, runner.privkey, match1.id, trip.id, need1.id, NOW + 5);

    expect(sm.getMatches({ status: 'accepted' })).toHaveLength(1);
    expect(sm.getMatches({ status: 'fulfilled' })).toHaveLength(1);
  });

  it('filters by runnerPubkey', () => {
    const { log, sm } = setup();
    const trip1 = announceTrip(log, runner.privkey, tripContent(), NOW);
    const trip2 = announceTrip(log, anotherRunner.privkey, tripContent(), NOW + 1);
    const need1 = submitNeed(log, requester.privkey, needContent(), NOW + 2);
    const need2 = submitNeed(log, anotherRequester.privkey, needContent(), NOW + 3);
    acceptNeed(log, runner.privkey, trip1.id, need1.id, NOW + 4);
    acceptNeed(log, anotherRunner.privkey, trip2.id, need2.id, NOW + 5);

    expect(sm.getMatches({ runnerPubkey: runner.pubkey })).toHaveLength(1);
  });

  it('filters by requesterPubkey', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    const need1 = submitNeed(log, requester.privkey, needContent(), NOW + 1);
    const need2 = submitNeed(log, anotherRequester.privkey, needContent(), NOW + 2);
    acceptNeed(log, runner.privkey, trip.id, need1.id, NOW + 3);
    acceptNeed(log, runner.privkey, trip.id, need2.id, NOW + 4);

    expect(sm.getMatches({ requesterPubkey: requester.pubkey })).toHaveLength(1);
  });

  it('returns all matches with no filter', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    const need1 = submitNeed(log, requester.privkey, needContent(), NOW + 1);
    const need2 = submitNeed(log, anotherRequester.privkey, needContent(), NOW + 2);
    acceptNeed(log, runner.privkey, trip.id, need1.id, NOW + 3);
    acceptNeed(log, runner.privkey, trip.id, need2.id, NOW + 4);

    expect(sm.getMatches()).toHaveLength(2);
  });
});

describe('StateMachine — Replay from log (reconstructibility)', () => {
  it('produces identical state when rebuilt from scratch', () => {
    // First instance: events arrive in real time
    const log1 = new MockLog();
    const sm1 = new StateMachine(log1);
    sm1.init();

    const trip = announceTrip(log1, runner.privkey);
    const need = submitNeed(log1, requester.privkey);
    const match = acceptNeed(log1, runner.privkey, trip.id, need.id);
    fulfillMatch(log1, runner.privkey, match.id, trip.id, need.id);
    closeTrip(log1, runner.privkey, trip.id, NOW + 3.5);
    confirmMatch(log1, requester.privkey, match.id, trip.id, need.id);

    // Second instance: all events pre-loaded in log before init
    const log2 = new MockLog();
    // Pre-load all events that were in log1
    for (const kind of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      for (const e of log1.query({ kinds: [kind] })) {
        log2.receive(e);
      }
    }

    const sm2 = new StateMachine(log2);
    sm2.init();

    // Compare states
    const ts1 = sm1.getTripState(trip.id)!;
    const ts2 = sm2.getTripState(trip.id)!;
    expect(ts2.status).toBe(ts1.status);
    expect(ts2.remaining.seats).toBe(ts1.remaining.seats);
    expect(ts2.remaining.time_budget).toBe(ts1.remaining.time_budget);
    expect(ts2.attachedNeeds).toHaveLength(ts1.attachedNeeds.length);

    expect(sm2.getNeedState(need.id)!.status).toBe(sm1.getNeedState(need.id)!.status);
    expect(sm2.getMatches()[0]!.status).toBe(sm1.getMatches()[0]!.status);

    sm1.destroy();
    sm2.destroy();
  });
});

describe('StateMachine — never produces events', () => {
  it('StateMachine has no publish, emit, or buildEvent methods', () => {
    const proto = StateMachine.prototype;
    expect('publish' in proto).toBe(false);
    expect('emit' in proto).toBe(false);
    expect('buildEvent' in proto).toBe(false);
    expect('send' in proto).toBe(false);
    expect('broadcast' in proto).toBe(false);
  });

  it('MockLog.receive is never called by the state machine', () => {
    const log = new MockLog();
    const originalReceive = log.receive.bind(log);
    let smCalledReceive = false;

    // Wrap receive to track calls after init
    const sm = new StateMachine(log);
    sm.init();

    // Replace receive after init — any call from now on is suspicious
    log.receive = (...args: Parameters<typeof log.receive>) => {
      smCalledReceive = true;
      return originalReceive(...args);
    };

    // Feed events through the original path (simulating transport -> log -> sm)
    // We have to use the original to actually deliver to subscribers
    const trip = buildTripEnvelope(runner.privkey, tripContent(), { created_at: NOW });
    originalReceive(trip);

    const need = buildNeedEnvelope(requester.privkey, needContent(), { created_at: NOW + 1 });
    originalReceive(need);

    // The state machine should have processed via subscription, not by calling receive
    expect(smCalledReceive).toBe(false);

    sm.destroy();
  });
});

describe('StateMachine — subscription lifecycle', () => {
  it('processes events arriving after init via subscription', () => {
    const { log, sm } = setup();

    // No events yet
    expect(sm.getActiveTrips()).toHaveLength(0);

    // Event arrives after init
    const trip = announceTrip(log, runner.privkey);
    expect(sm.getActiveTrips()).toHaveLength(1);
    expect(sm.getTripState(trip.id)!.status).toBe('open');
  });

  it('destroy() stops processing new events', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    expect(sm.getActiveTrips()).toHaveLength(1);

    sm.destroy();

    // New event after destroy should not be processed
    submitNeed(log, requester.privkey);
    expect(sm.getUnmatchedNeeds()).toHaveLength(0);
  });
});

describe('StateMachine — edge cases', () => {
  it('getTripState returns undefined for unknown trip', () => {
    const { sm } = setup();
    expect(sm.getTripState('nonexistent')).toBeUndefined();
  });

  it('getNeedState returns undefined for unknown need', () => {
    const { sm } = setup();
    expect(sm.getNeedState('nonexistent')).toBeUndefined();
  });

  it('MATCH_ACCEPT for unknown trip is ignored', () => {
    const { log, sm } = setup();
    const need = submitNeed(log, requester.privkey);
    acceptNeed(log, runner.privkey, 'nonexistent-trip', need.id);

    expect(sm.getMatches()).toHaveLength(0);
    expect(sm.getNeedState(need.id)!.status).toBe('unmatched');
  });

  it('MATCH_ACCEPT for unknown need is ignored', () => {
    const { log, sm } = setup();
    const trip = announceTrip(log, runner.privkey);
    acceptNeed(log, runner.privkey, trip.id, 'nonexistent-need');

    expect(sm.getMatches()).toHaveLength(0);
    expect(sm.getTripState(trip.id)!.attachedNeeds).toHaveLength(0);
  });

  it('MATCH_FULFILL for unknown match is ignored', () => {
    const { log, sm } = setup();
    announceTrip(log, runner.privkey);
    const env = buildEnvelope(
      runner.privkey,
      EventKind.MATCH_FULFILL,
      { match_id: 'nonexistent', trip_id: 'x', need_id: 'y' },
      { created_at: NOW + 10 },
    );
    log.receive(env);

    expect(sm.getMatches()).toHaveLength(0);
  });

  it('TRIP_CLOSE for unknown trip is ignored', () => {
    const { log, sm } = setup();
    closeTrip(log, runner.privkey, 'nonexistent');

    expect(sm.getActiveTrips()).toHaveLength(0);
  });

  it('TRIP_CANCEL for unknown trip is ignored', () => {
    const { log, sm } = setup();
    cancelTrip(log, runner.privkey, 'nonexistent');

    expect(sm.getActiveTrips()).toHaveLength(0);
  });

  it('handles event with unparseable content gracefully', () => {
    const { log, sm } = setup();
    const env = buildEnvelope(
      runner.privkey,
      EventKind.TRIP_ANNOUNCE,
      'not-valid-json{{{',
      { created_at: NOW },
    );
    log.receive(env);

    // Should not crash, trip not created since content is unparseable
    expect(sm.getActiveTrips()).toHaveLength(0);
  });

  it('does not double-process the same event', () => {
    const log = new MockLog();
    const sm = new StateMachine(log);

    // Pre-load a trip event
    const trip = buildTripEnvelope(runner.privkey, tripContent(), { created_at: NOW });
    log.receive(trip);

    // init() will query it AND subscribe — but the trip was already in the log
    // before subscribe, so it should only be processed once via query
    sm.init();

    expect(sm.getActiveTrips()).toHaveLength(1);
    sm.destroy();
  });
});
