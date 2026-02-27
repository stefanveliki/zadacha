import { describe, it, expect, beforeEach } from 'vitest';
import { EventKind } from '../../shared/types.js';
import { UIActionsImpl } from '../actions.js';
import type { TripParams, NeedParams } from '../actions.js';
import { MockIdentityLayer, MockTransport, MockStateReader } from './helpers.js';

describe('UIActionsImpl', () => {
  let identity: MockIdentityLayer;
  let transport1: MockTransport;
  let transport2: MockTransport;
  let state: MockStateReader;
  let actions: UIActionsImpl;

  beforeEach(() => {
    identity = new MockIdentityLayer();
    transport1 = new MockTransport();
    transport2 = new MockTransport();
    state = new MockStateReader();
    actions = new UIActionsImpl(identity, [transport1, transport2], state);
  });

  // =========================================================================
  // Runner actions
  // =========================================================================

  describe('announceTrip', () => {
    const params: TripParams = {
      destination: 'Town market',
      departs_at: 1700000000,
      capacity: {
        seats: 3,
        cargo: 'half a trunk',
        time_budget: 60,
        physical_assistance: true,
      },
      max_range: '5 km',
    };

    it('builds a TRIP_ANNOUNCE event and publishes to all transports', async () => {
      await actions.announceTrip(params);

      expect(identity.builtEvents).toHaveLength(1);
      expect(identity.builtEvents[0]!.kind).toBe(EventKind.TRIP_ANNOUNCE);
      expect(identity.builtEvents[0]!.content).toEqual(params);
      expect(transport1.published).toHaveLength(1);
      expect(transport2.published).toHaveLength(1);
    });

    it('includes optional fields when provided', async () => {
      const full: TripParams = {
        ...params,
        returns_by: 1700010000,
        route: 'Through the valley',
        display_name: 'Stefan',
      };
      await actions.announceTrip(full);

      expect(identity.builtEvents[0]!.content).toEqual(full);
    });
  });

  describe('acceptNeed', () => {
    it('builds a MATCH_ACCEPT event with trip_id and need_id', async () => {
      await actions.acceptNeed('trip-123', 'need-456');

      expect(identity.builtEvents).toHaveLength(1);
      expect(identity.builtEvents[0]!.kind).toBe(EventKind.MATCH_ACCEPT);
      expect(identity.builtEvents[0]!.content).toEqual({
        trip_id: 'trip-123',
        need_id: 'need-456',
      });
      expect(transport1.published).toHaveLength(1);
    });
  });

  describe('fulfillNeed', () => {
    it('looks up match and builds MATCH_FULFILL event', async () => {
      state.setMatches([
        {
          matchId: 'match-1',
          tripId: 'trip-1',
          needId: 'need-1',
          runnerPubkey: 'runner-pub',
          requesterPubkey: 'req-pub',
          status: 'accepted',
        },
      ]);

      await actions.fulfillNeed('match-1');

      expect(identity.builtEvents[0]!.kind).toBe(EventKind.MATCH_FULFILL);
      expect(identity.builtEvents[0]!.content).toEqual({
        trip_id: 'trip-1',
        need_id: 'need-1',
        match_id: 'match-1',
      });
    });

    it('throws when match is not found', async () => {
      await expect(actions.fulfillNeed('nonexistent')).rejects.toThrow(
        'Match not found: nonexistent',
      );
    });
  });

  describe('closeTrip', () => {
    it('builds a TRIP_CLOSE event', async () => {
      await actions.closeTrip('trip-789');

      expect(identity.builtEvents[0]!.kind).toBe(EventKind.TRIP_CLOSE);
      expect(identity.builtEvents[0]!.content).toEqual({ trip_id: 'trip-789' });
    });
  });

  describe('cancelTrip', () => {
    it('builds a TRIP_CANCEL event', async () => {
      await actions.cancelTrip('trip-789');

      expect(identity.builtEvents[0]!.kind).toBe(EventKind.TRIP_CANCEL);
      expect(identity.builtEvents[0]!.content).toEqual({ trip_id: 'trip-789' });
    });
  });

  // =========================================================================
  // Requester actions
  // =========================================================================

  describe('submitNeed', () => {
    const params: NeedParams = {
      what: 'Heart medication from pharmacy',
      by_when: 1700003600,
      location: 'Village center',
      resource_footprint: {
        seat: false,
        cargo: 'small box',
        time_on_location: 10,
        physical_assistance: false,
      },
    };

    it('builds a NEED_SUBMIT event and publishes', async () => {
      await actions.submitNeed(params);

      expect(identity.builtEvents[0]!.kind).toBe(EventKind.NEED_SUBMIT);
      expect(identity.builtEvents[0]!.content).toEqual(params);
      expect(transport1.published).toHaveLength(1);
      expect(transport2.published).toHaveLength(1);
    });

    it('includes optional display_name', async () => {
      const withName: NeedParams = { ...params, display_name: 'Baba Maria' };
      await actions.submitNeed(withName);

      expect(identity.builtEvents[0]!.content).toEqual(withName);
    });
  });

  describe('confirmFulfillment', () => {
    it('looks up match and builds MATCH_CONFIRM event', async () => {
      state.setMatches([
        {
          matchId: 'match-2',
          tripId: 'trip-2',
          needId: 'need-2',
          runnerPubkey: 'runner-pub',
          requesterPubkey: 'req-pub',
          status: 'fulfilled',
        },
      ]);

      await actions.confirmFulfillment('match-2');

      expect(identity.builtEvents[0]!.kind).toBe(EventKind.MATCH_CONFIRM);
      expect(identity.builtEvents[0]!.content).toEqual({
        trip_id: 'trip-2',
        need_id: 'need-2',
        match_id: 'match-2',
      });
    });

    it('throws when match is not found', async () => {
      await expect(actions.confirmFulfillment('nope')).rejects.toThrow(
        'Match not found: nope',
      );
    });
  });

  describe('releaseSlot', () => {
    beforeEach(() => {
      state.setMatches([
        {
          matchId: 'match-3',
          tripId: 'trip-3',
          needId: 'need-3',
          runnerPubkey: 'runner-pub',
          requesterPubkey: 'req-pub',
          status: 'accepted',
        },
      ]);
    });

    it('builds SLOT_RELEASE event with reason', async () => {
      await actions.releaseSlot('match-3', 'giving my spot to Baba Maria');

      expect(identity.builtEvents[0]!.kind).toBe(EventKind.SLOT_RELEASE);
      expect(identity.builtEvents[0]!.content).toEqual({
        match_id: 'match-3',
        trip_id: 'trip-3',
        need_id: 'need-3',
        reason: 'giving my spot to Baba Maria',
      });
    });

    it('builds SLOT_RELEASE event without reason when omitted', async () => {
      await actions.releaseSlot('match-3');

      const content = identity.builtEvents[0]!.content as Record<string, unknown>;
      expect(content).not.toHaveProperty('reason');
      expect(content['match_id']).toBe('match-3');
    });

    it('throws when match is not found', async () => {
      await expect(actions.releaseSlot('gone')).rejects.toThrow(
        'Match not found: gone',
      );
    });
  });

  // =========================================================================
  // Identity actions
  // =========================================================================

  describe('setupGuardians', () => {
    it('builds a GUARDIAN_SET event with threshold 2', async () => {
      await actions.setupGuardians(['guardian-1', 'guardian-2', 'guardian-3']);

      expect(identity.builtEvents[0]!.kind).toBe(EventKind.GUARDIAN_SET);
      expect(identity.builtEvents[0]!.content).toEqual({
        guardians: ['guardian-1', 'guardian-2', 'guardian-3'],
        threshold: 2,
        encrypted_shards: {},
      });
    });

    it('clamps threshold to guardian count when fewer than 2', async () => {
      await actions.setupGuardians(['single-guardian']);

      const content = identity.builtEvents[0]!.content as { threshold: number };
      expect(content.threshold).toBe(1);
    });
  });

  describe('rotateGuardians', () => {
    it('builds a GUARDIAN_ROTATE event', async () => {
      await actions.rotateGuardians(['old-1', 'old-2'], ['new-1', 'new-2', 'new-3']);

      expect(identity.builtEvents[0]!.kind).toBe(EventKind.GUARDIAN_ROTATE);
      expect(identity.builtEvents[0]!.content).toEqual({
        old_guardians: ['old-1', 'old-2'],
        new_guardians: ['new-1', 'new-2', 'new-3'],
        threshold: 2,
        old_guardian_sigs: [],
        encrypted_shards: {},
      });
    });
  });

  describe('initiateRecovery', () => {
    it('builds a RECOVERY_INIT event with the current pubkey', async () => {
      await actions.initiateRecovery();

      expect(identity.builtEvents[0]!.kind).toBe(EventKind.RECOVERY_INIT);
      const content = identity.builtEvents[0]!.content as {
        recovering_pubkey: string;
        new_device_pubkey: string;
        timestamp: number;
      };
      expect(content.recovering_pubkey).toBe(identity.pubkey);
      expect(content.new_device_pubkey).toBe(identity.pubkey);
      expect(typeof content.timestamp).toBe('number');
    });
  });

  // =========================================================================
  // Transport behavior
  // =========================================================================

  describe('transport handling', () => {
    const minTrip: TripParams = {
      destination: 'X',
      departs_at: 0,
      capacity: { seats: 1, cargo: '', time_budget: 0, physical_assistance: false },
      max_range: '1 km',
    };

    it('only publishes to available transports', async () => {
      transport2.available = false;
      await actions.announceTrip(minTrip);

      expect(transport1.published).toHaveLength(1);
      expect(transport2.published).toHaveLength(0);
    });

    it('completes without error when no transports are available', async () => {
      transport1.available = false;
      transport2.available = false;

      await expect(actions.announceTrip(minTrip)).resolves.toBeUndefined();
    });

    it('continues when one transport rejects', async () => {
      transport1.publish = async () => {
        throw new Error('network down');
      };

      await actions.announceTrip(minTrip);
      expect(transport2.published).toHaveLength(1);
    });

    it('publishes the same envelope to every transport', async () => {
      await actions.announceTrip(minTrip);

      expect(transport1.published[0]!.id).toBe(transport2.published[0]!.id);
      expect(transport1.published[0]!.sig).toBe(transport2.published[0]!.sig);
    });
  });

  // =========================================================================
  // Contract enforcement
  // =========================================================================

  describe('contract enforcement', () => {
    it('every action calls buildEvent exactly once', async () => {
      state.setMatches([
        {
          matchId: 'm',
          tripId: 't',
          needId: 'n',
          runnerPubkey: 'r',
          requesterPubkey: 'q',
          status: 'accepted',
        },
      ]);

      await actions.announceTrip({
        destination: 'X',
        departs_at: 0,
        capacity: { seats: 0, cargo: '', time_budget: 0, physical_assistance: false },
        max_range: '',
      });
      await actions.acceptNeed('t', 'n');
      await actions.fulfillNeed('m');
      await actions.closeTrip('t');
      await actions.cancelTrip('t');
      await actions.submitNeed({
        what: 'X',
        by_when: 0,
        location: '',
        resource_footprint: {
          seat: false,
          cargo: '',
          time_on_location: 0,
          physical_assistance: false,
        },
      });

      // 6 actions → 6 buildEvent calls
      expect(identity.builtEvents).toHaveLength(6);
    });

    it('never constructs envelopes manually — always delegates to identity', async () => {
      await actions.announceTrip({
        destination: 'Y',
        departs_at: 0,
        capacity: { seats: 1, cargo: '', time_budget: 0, physical_assistance: false },
        max_range: '1 km',
      });

      // The published envelope came from identity.buildEvent, not manual construction
      const published = transport1.published[0]!;
      expect(published.pubkey).toBe(identity.pubkey);
      expect(published.sig).toMatch(/^sig-/);
    });
  });
});
