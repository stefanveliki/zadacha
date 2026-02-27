/**
 * Unit tests for BluetoothTransportAdapter.
 *
 * Web Bluetooth is not available in jsdom, so we mock the entire
 * navigator.bluetooth surface and work with `unknown` casts throughout
 * to avoid requiring DOM Bluetooth type stubs.
 */

import { BluetoothTransportAdapter } from './BluetoothTransportAdapter';
import { EventEnvelope } from '../../shared/types';

// ─── Minimal local types for mocking ─────────────────────────────────────────

interface MockChar {
  writeValueWithResponse: jest.Mock;
  startNotifications: jest.Mock;
  addEventListener: jest.Mock;
  /** Trigger all registered characteristicvaluechanged handlers */
  notify(data: DataView): void;
}

interface MockGattServer {
  connect: jest.Mock;
  disconnect: jest.Mock;
  getPrimaryService: jest.Mock;
}

interface MockDevice {
  id: string;
  gatt: MockGattServer;
  addEventListener: jest.Mock;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id:         'aabb000000000000aabb000000000000aabb000000000000aabb000000000000',
    kind:       1,
    pubkey:     'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    created_at: 1700000000,
    content:    '{"destination":"town"}',
    sig:        'cafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafe00',
    ...overrides,
  };
}

function makeChunkView(
  envelope: EventEnvelope,
  messageId: number,
  chunkIndex = 0,
  totalChunks = 1
): DataView {
  const encoded = new TextEncoder().encode(JSON.stringify(envelope));
  const packet  = new Uint8Array(4 + encoded.length);
  packet[0] = (messageId >> 8) & 0xff;
  packet[1] = messageId & 0xff;
  packet[2] = chunkIndex;
  packet[3] = totalChunks;
  packet.set(encoded, 4);
  return new DataView(packet.buffer);
}

// ─── BLE mock setup ───────────────────────────────────────────────────────────

function makeMockBluetooth(opts: { available?: boolean; ios?: boolean } = {}): {
  char: MockChar;
  device: MockDevice;
  server: MockGattServer;
} {
  const char: MockChar = {
    writeValueWithResponse: jest.fn().mockResolvedValue(undefined),
    startNotifications:     jest.fn().mockResolvedValue(undefined),
    addEventListener:       jest.fn(),
    notify(data: DataView) {
      for (const [, cb] of char.addEventListener.mock.calls) {
        cb({ target: { value: data } });
      }
    },
  };

  const service = { getCharacteristic: jest.fn().mockResolvedValue(char) };

  const server: MockGattServer = {
    connect:           jest.fn(),
    disconnect:        jest.fn(),
    getPrimaryService: jest.fn().mockResolvedValue(service),
  };
  // connect() returns itself
  server.connect.mockResolvedValue(server);

  const device: MockDevice = {
    id:               'mock-device-1',
    gatt:             server,
    addEventListener: jest.fn(),
  };

  const bluetooth = {
    getAvailability: jest.fn().mockResolvedValue(opts.available ?? true),
    requestDevice:   jest.fn().mockResolvedValue(device),
  };

  Object.defineProperty(navigator, 'bluetooth', {
    value: bluetooth, writable: true, configurable: true,
  });

  const ua = opts.ios
    ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
    : 'Mozilla/5.0 (Linux; Android 13)';
  Object.defineProperty(navigator, 'userAgent', {
    value: ua, writable: true, configurable: true,
  });

  return { char, device, server };
}

/** Inject a pre-connected peer directly into the adapter's private _peers map. */
function injectPeer(adapter: BluetoothTransportAdapter, id: string, server: unknown): void {
  (adapter as unknown as { _peers: Map<string, unknown> })._peers.set(id, server);
}

/** Force _available to a value. */
function setAvailable(adapter: BluetoothTransportAdapter, value: boolean): void {
  (adapter as unknown as { _available: boolean })._available = value;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('BluetoothTransportAdapter', () => {

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── isAvailable ─────────────────────────────────────────────────────────────

  describe('isAvailable()', () => {
    it('returns false on iOS regardless of Bluetooth API presence', () => {
      makeMockBluetooth({ ios: true, available: true });
      const adapter = new BluetoothTransportAdapter();
      expect(adapter.isAvailable()).toBe(false);
    });

    it('returns false when Web Bluetooth is absent from navigator', () => {
      const bt = (navigator as unknown as Record<string, unknown>).bluetooth;
      delete (navigator as unknown as Record<string, unknown>).bluetooth;
      const adapter = new BluetoothTransportAdapter();
      expect(adapter.isAvailable()).toBe(false);
      (navigator as unknown as Record<string, unknown>).bluetooth = bt;
    });

    it('returns true after getAvailability resolves true on Android', async () => {
      makeMockBluetooth({ available: true });
      const adapter = new BluetoothTransportAdapter();
      await Promise.resolve(); // flush microtask
      expect(adapter.isAvailable()).toBe(true);
    });

    it('returns false when getAvailability resolves false', async () => {
      makeMockBluetooth({ available: false });
      const adapter = new BluetoothTransportAdapter();
      await Promise.resolve();
      expect(adapter.isAvailable()).toBe(false);
    });
  });

  // ── publish ──────────────────────────────────────────────────────────────────

  describe('publish()', () => {
    it('resolves without error when adapter is unavailable', async () => {
      makeMockBluetooth({ ios: true });
      const adapter = new BluetoothTransportAdapter();
      await expect(adapter.publish(makeEnvelope())).resolves.toBeUndefined();
    });

    it('writes at least one chunk to a connected peer', async () => {
      const { char, server } = makeMockBluetooth({ available: true });
      const adapter = new BluetoothTransportAdapter();
      await Promise.resolve();

      injectPeer(adapter, 'mock-device-1', server);
      setAvailable(adapter, true);

      await adapter.publish(makeEnvelope());

      expect(char.writeValueWithResponse).toHaveBeenCalled();
    });

    it('encodes an envelope that decodes back to the original', async () => {
      const { char, server } = makeMockBluetooth({ available: true });
      const adapter = new BluetoothTransportAdapter();
      await Promise.resolve();

      injectPeer(adapter, 'mock-device-1', server);
      setAvailable(adapter, true);

      const envelope = makeEnvelope({ kind: 2 });
      await adapter.publish(envelope);

      const written = char.writeValueWithResponse.mock.calls[0][0] as Uint8Array;
      const payload = new TextDecoder().decode(written.slice(4));
      const decoded = JSON.parse(payload) as EventEnvelope;

      expect(decoded.id).toBe(envelope.id);
      expect(decoded.kind).toBe(2);
      expect(decoded.sig).toBe(envelope.sig);
    });

    it('publishes to multiple peers simultaneously', async () => {
      const mocks1 = makeMockBluetooth({ available: true });
      // Build a second peer char
      const char2: MockChar = {
        writeValueWithResponse: jest.fn().mockResolvedValue(undefined),
        startNotifications:     jest.fn().mockResolvedValue(undefined),
        addEventListener:       jest.fn(),
        notify()                { /* unused */ },
      };
      const svc2 = { getCharacteristic: jest.fn().mockResolvedValue(char2) };
      const server2 = {
        connect:           jest.fn().mockResolvedValue(undefined),
        disconnect:        jest.fn(),
        getPrimaryService: jest.fn().mockResolvedValue(svc2),
      };

      const adapter = new BluetoothTransportAdapter();
      await Promise.resolve();

      injectPeer(adapter, 'peer-1', mocks1.server);
      injectPeer(adapter, 'peer-2', server2);
      setAvailable(adapter, true);

      await adapter.publish(makeEnvelope());

      expect(mocks1.char.writeValueWithResponse).toHaveBeenCalled();
      expect(char2.writeValueWithResponse).toHaveBeenCalled();
    });
  });

  // ── listen + delivery ────────────────────────────────────────────────────────

  describe('listen() + inbound delivery', () => {
    it('delivers a received envelope to the onEvent callback', async () => {
      const { char, server } = makeMockBluetooth({ available: true });
      const adapter = new BluetoothTransportAdapter();
      await Promise.resolve();
      setAvailable(adapter, true);

      const received: EventEnvelope[] = [];
      adapter.listen((e) => received.push(e));

      injectPeer(adapter, 'mock-device-1', server);

      // Trigger the internal subscription path directly.
      await (adapter as unknown as {
        _subscribeToDevice(id: string, s: unknown): Promise<void>
      })._subscribeToDevice('mock-device-1', server);

      const envelope = makeEnvelope({ kind: 1 });
      char.notify(makeChunkView(envelope, 42));

      expect(received).toHaveLength(1);
      expect(received[0].id).toBe(envelope.id);
      expect(received[0].kind).toBe(1);
    });

    it('discards a packet with a malformed JSON body', () => {
      makeMockBluetooth({ available: true });
      const adapter = new BluetoothTransportAdapter();
      setAvailable(adapter, true);

      const received: EventEnvelope[] = [];
      adapter.listen((e) => received.push(e));

      // Header says 1 chunk but payload is garbage.
      const garbage = new Uint8Array([0, 1, 0, 1, 0xff, 0xfe, 0x00, 0xaa]);
      (adapter as unknown as {
        _handleIncoming(id: string, d: DataView): void
      })._handleIncoming('peer', new DataView(garbage.buffer));

      expect(received).toHaveLength(0);
    });

    it('discards an envelope missing required fields (id, sig, pubkey)', () => {
      makeMockBluetooth({ available: true });
      const adapter = new BluetoothTransportAdapter();
      setAvailable(adapter, true);

      const received: EventEnvelope[] = [];
      adapter.listen((e) => received.push(e));

      const bad = { kind: 1, created_at: 1, content: '{}' };
      const view = makeChunkView(bad as unknown as EventEnvelope, 5);
      (adapter as unknown as {
        _handleIncoming(id: string, d: DataView): void
      })._handleIncoming('peer', view);

      expect(received).toHaveLength(0);
    });
  });

  // ── relay ────────────────────────────────────────────────────────────────────

  describe('relay (hop-by-hop)', () => {
    it('relays an unseen envelope by calling publish', () => {
      makeMockBluetooth({ available: true });
      const adapter = new BluetoothTransportAdapter();
      setAvailable(adapter, true);

      const publishSpy = jest.spyOn(adapter, 'publish').mockResolvedValue(undefined);

      const envelope = makeEnvelope({ id: 'feed' + '0'.repeat(60) });
      (adapter as unknown as { _relay(e: EventEnvelope): void })._relay(envelope);

      expect(publishSpy).toHaveBeenCalledWith(envelope);
    });

    it('does not relay the same envelope twice', () => {
      makeMockBluetooth({ available: true });
      const adapter = new BluetoothTransportAdapter();
      setAvailable(adapter, true);

      const publishSpy = jest.spyOn(adapter, 'publish').mockResolvedValue(undefined);

      const envelope = makeEnvelope();
      const relay = (e: EventEnvelope) =>
        (adapter as unknown as { _relay(e: EventEnvelope): void })._relay(e);

      relay(envelope);
      relay(envelope);

      expect(publishSpy).toHaveBeenCalledTimes(1);
    });

    it('relays distinct envelopes independently', () => {
      makeMockBluetooth({ available: true });
      const adapter = new BluetoothTransportAdapter();
      setAvailable(adapter, true);

      const publishSpy = jest.spyOn(adapter, 'publish').mockResolvedValue(undefined);

      const relay = (e: EventEnvelope) =>
        (adapter as unknown as { _relay(e: EventEnvelope): void })._relay(e);

      relay(makeEnvelope({ id: 'aaaa' + '0'.repeat(60) }));
      relay(makeEnvelope({ id: 'bbbb' + '0'.repeat(60) }));

      expect(publishSpy).toHaveBeenCalledTimes(2);
    });
  });

  // ── chunked reassembly ────────────────────────────────────────────────────────

  describe('chunked reassembly', () => {
    it('holds a partial message until all chunks arrive', () => {
      makeMockBluetooth({ available: true });
      const adapter = new BluetoothTransportAdapter();
      setAvailable(adapter, true);

      const received: EventEnvelope[] = [];
      adapter.listen((e) => received.push(e));

      const envelope = makeEnvelope({ kind: 3 });
      const encoded  = new TextEncoder().encode(JSON.stringify(envelope));
      const mid      = 7;
      const half     = Math.ceil(encoded.length / 2);

      function rawChunk(data: Uint8Array, idx: number, total: number): DataView {
        const p = new Uint8Array(4 + data.length);
        p[0] = (mid >> 8) & 0xff; p[1] = mid & 0xff;
        p[2] = idx; p[3] = total;
        p.set(data, 4);
        return new DataView(p.buffer);
      }

      const handle = (d: DataView) =>
        (adapter as unknown as {
          _handleIncoming(id: string, d: DataView): void
        })._handleIncoming('peer-x', d);

      handle(rawChunk(encoded.slice(0, half), 0, 2));
      expect(received).toHaveLength(0); // not yet complete

      handle(rawChunk(encoded.slice(half), 1, 2));
      expect(received).toHaveLength(1);
      expect(received[0].kind).toBe(3);
    });

    it('handles a single-chunk message', () => {
      makeMockBluetooth({ available: true });
      const adapter = new BluetoothTransportAdapter();
      setAvailable(adapter, true);

      const received: EventEnvelope[] = [];
      adapter.listen((e) => received.push(e));

      const envelope = makeEnvelope({ kind: 5 });
      (adapter as unknown as {
        _handleIncoming(id: string, d: DataView): void
      })._handleIncoming('peer', makeChunkView(envelope, 1));

      expect(received).toHaveLength(1);
      expect(received[0].id).toBe(envelope.id);
    });

    it('keeps buffers for different message ids separate', () => {
      makeMockBluetooth({ available: true });
      const adapter = new BluetoothTransportAdapter();
      setAvailable(adapter, true);

      const received: EventEnvelope[] = [];
      adapter.listen((e) => received.push(e));

      const e1 = makeEnvelope({ id: 'msg1' + '0'.repeat(60), kind: 1 });
      const e2 = makeEnvelope({ id: 'msg2' + '0'.repeat(60), kind: 2 });

      const handle = (d: DataView) =>
        (adapter as unknown as {
          _handleIncoming(id: string, d: DataView): void
        })._handleIncoming('peer', d);

      handle(makeChunkView(e1, 10));
      handle(makeChunkView(e2, 11));

      expect(received).toHaveLength(2);
    });
  });

  // ── destroy ───────────────────────────────────────────────────────────────────

  describe('destroy()', () => {
    it('disconnects all peers and clears the peer map', () => {
      makeMockBluetooth({ available: true });
      const adapter = new BluetoothTransportAdapter();

      const mockServer = { disconnect: jest.fn(), connect: jest.fn(), getPrimaryService: jest.fn() };
      injectPeer(adapter, 'dev-1', mockServer);
      injectPeer(adapter, 'dev-2', mockServer);

      adapter.destroy();

      expect(mockServer.disconnect).toHaveBeenCalledTimes(2);
      expect(
        (adapter as unknown as { _peers: Map<string, unknown> })._peers.size
      ).toBe(0);
    });

    it('clears the scan loop', () => {
      makeMockBluetooth({ available: true });
      const adapter = new BluetoothTransportAdapter();

      const handle = setInterval(() => {}, 99999);
      (adapter as unknown as { _scanLoop: ReturnType<typeof setInterval> | null })
        ._scanLoop = handle;

      adapter.destroy();

      expect(
        (adapter as unknown as { _scanLoop: ReturnType<typeof setInterval> | null })
          ._scanLoop
      ).toBeNull();
    });
  });
});
