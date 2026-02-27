import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BroadcastChannelAdapter } from '../broadcast-channel.js';
import { MockBroadcastChannel, createTestEnvelope } from './test-helpers.js';

describe('BroadcastChannelAdapter', () => {
  beforeEach(() => {
    MockBroadcastChannel.reset();
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listen()', () => {
    it('receives events published by another channel on the same name', () => {
      const adapter1 = new BroadcastChannelAdapter();
      const adapter2 = new BroadcastChannelAdapter();
      const received: unknown[] = [];

      adapter1.listen((envelope) => received.push(envelope));
      adapter2.listen(() => {}); // second adapter needs to be listening to have a channel

      const testEnvelope = createTestEnvelope();
      // Simulate a message from adapter2's channel to adapter1
      const channels = MockBroadcastChannel.channels.get('rural-run-protocol')!;
      const senderChannel = channels.find((ch) => ch !== channels[0])!;
      senderChannel.postMessage(JSON.stringify(testEnvelope));

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(testEnvelope);

      adapter1.close();
      adapter2.close();
    });

    it('silently ignores malformed messages', () => {
      const adapter = new BroadcastChannelAdapter();
      const received: unknown[] = [];

      adapter.listen((envelope) => received.push(envelope));

      // Send garbage data directly
      const channels = MockBroadcastChannel.channels.get('rural-run-protocol')!;
      // We need another channel to send from
      const sender = new MockBroadcastChannel('rural-run-protocol');
      sender.postMessage('not valid json {{{');
      sender.postMessage(JSON.stringify({ incomplete: true }));
      sender.postMessage(JSON.stringify({ id: 'x', kind: 'not-a-number' }));

      expect(received).toHaveLength(0);

      adapter.close();
      sender.close();
    });

    it('replaces previous listener when called again', () => {
      const adapter = new BroadcastChannelAdapter();
      const received1: unknown[] = [];
      const received2: unknown[] = [];

      adapter.listen((e) => received1.push(e));
      adapter.listen((e) => received2.push(e));

      const sender = new MockBroadcastChannel('rural-run-protocol');
      sender.postMessage(JSON.stringify(createTestEnvelope()));

      expect(received1).toHaveLength(0);
      expect(received2).toHaveLength(1);

      adapter.close();
      sender.close();
    });
  });

  describe('publish()', () => {
    it('sends a serialized EventEnvelope to the channel', async () => {
      const adapter = new BroadcastChannelAdapter();
      const otherReceived: unknown[] = [];

      adapter.listen(() => {});

      const receiver = new MockBroadcastChannel('rural-run-protocol');
      receiver.onmessage = (event: MessageEvent) => {
        otherReceived.push(JSON.parse(event.data));
      };

      const envelope = createTestEnvelope();
      await adapter.publish(envelope);

      expect(otherReceived).toHaveLength(1);
      expect(otherReceived[0]).toEqual(envelope);

      adapter.close();
      receiver.close();
    });

    it('throws if channel not initialized', async () => {
      const adapter = new BroadcastChannelAdapter();
      const envelope = createTestEnvelope();

      await expect(adapter.publish(envelope)).rejects.toThrow(
        'BroadcastChannel not initialized',
      );
    });
  });

  describe('isAvailable()', () => {
    it('returns true after listen() when BroadcastChannel API exists', () => {
      const adapter = new BroadcastChannelAdapter();
      expect(adapter.isAvailable()).toBe(false);

      adapter.listen(() => {});
      expect(adapter.isAvailable()).toBe(true);

      adapter.close();
    });

    it('returns false after close()', () => {
      const adapter = new BroadcastChannelAdapter();
      adapter.listen(() => {});
      expect(adapter.isAvailable()).toBe(true);

      adapter.close();
      expect(adapter.isAvailable()).toBe(false);
    });

    it('returns false when BroadcastChannel API is not available', () => {
      vi.stubGlobal('BroadcastChannel', undefined);

      const adapter = new BroadcastChannelAdapter();
      adapter.listen(() => {});
      expect(adapter.isAvailable()).toBe(false);
    });
  });

  describe('close()', () => {
    it('closes the underlying channel and resets state', () => {
      const adapter = new BroadcastChannelAdapter();
      adapter.listen(() => {});
      expect(adapter.isAvailable()).toBe(true);

      adapter.close();
      expect(adapter.isAvailable()).toBe(false);
    });
  });
});
