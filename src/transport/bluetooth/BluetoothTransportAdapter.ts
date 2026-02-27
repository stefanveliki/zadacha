import { EventEnvelope, TransportAdapter } from '../../shared/types.js';

// ─── BLE constants ────────────────────────────────────────────────────────────

const SERVICE_UUID      = '12345678-1234-1234-1234-1234567890ab';
const CHAR_UUID_TX      = '12345678-1234-1234-1234-1234567890ac'; // we write here
const CHAR_UUID_RX      = '12345678-1234-1234-1234-1234567890ad'; // we notify from here

// Max BLE ATT payload is 512 bytes; we chunk larger envelopes.
const CHUNK_SIZE        = 500;
const CHUNK_HEADER_SIZE = 4; // 2 bytes: chunkIndex (uint8) + totalChunks (uint8) + messageId (uint16)

// How long we hold a seen event id before expiring it from the relay dedup set.
const RELAY_DEDUP_TTL_MS = 60_000;

// ─── Platform detection ───────────────────────────────────────────────────────

function isIOS(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    /iPad|iPhone|iPod/.test(navigator.userAgent) &&
    !(window as unknown as { MSStream?: unknown }).MSStream
  );
}

function webBluetoothSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'bluetooth' in navigator
  );
}

// ─── Chunking helpers ─────────────────────────────────────────────────────────

interface Chunk {
  messageId: number;
  chunkIndex: number;
  totalChunks: number;
  data: Uint8Array;
}

function encodeEnvelope(envelope: EventEnvelope, messageId: number): Uint8Array[] {
  const json   = JSON.stringify(envelope);
  const encoded = new TextEncoder().encode(json);
  const total  = Math.ceil(encoded.length / CHUNK_SIZE) || 1;
  const chunks: Uint8Array[] = [];

  for (let i = 0; i < total; i++) {
    const slice  = encoded.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const packet = new Uint8Array(CHUNK_HEADER_SIZE + slice.length);
    // header: [messageId_hi, messageId_lo, chunkIndex, totalChunks]
    packet[0] = (messageId >> 8) & 0xff;
    packet[1] = messageId & 0xff;
    packet[2] = i;
    packet[3] = total;
    packet.set(slice, CHUNK_HEADER_SIZE);
    chunks.push(packet);
  }
  return chunks;
}

function decodeChunk(data: DataView): Chunk {
  const messageId   = (data.getUint8(0) << 8) | data.getUint8(1);
  const chunkIndex  = data.getUint8(2);
  const totalChunks = data.getUint8(3);
  const payload     = new Uint8Array(data.buffer, data.byteOffset + CHUNK_HEADER_SIZE);
  return { messageId, chunkIndex, totalChunks, data: payload };
}

// ─── In-flight message reassembly ─────────────────────────────────────────────

interface InFlight {
  totalChunks: number;
  received: Map<number, Uint8Array>;
  lastSeen: number;
}

// ─── BluetoothTransportAdapter ────────────────────────────────────────────────

export class BluetoothTransportAdapter implements TransportAdapter {
  private _available: boolean = false;
  private _listener: ((envelope: EventEnvelope) => void) | null = null;

  // Connected GATT servers (peers we're actively linked to).
  private _peers: Map<string, BluetoothRemoteGATTServer> = new Map();

  // Reassembly buffers keyed by "deviceId:messageId".
  private _inFlight: Map<string, InFlight> = new Map();

  // Relay dedup: event ids we have already re-broadcast.
  private _relayedIds: Map<string, number> = new Map();

  // Rolling message id counter (uint16 wraps at 65535).
  private _messageId: number = 0;

  // Scan loop handle.
  private _scanLoop: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this._checkAvailability();
  }

  // ── availability ────────────────────────────────────────────────────────────

  isAvailable(): boolean {
    return this._available;
  }

  private _checkAvailability(): void {
    if (isIOS()) {
      // iOS Safari does not support Web Bluetooth background mesh.
      this._available = false;
      return;
    }
    if (!webBluetoothSupported()) {
      this._available = false;
      return;
    }
    // Web Bluetooth availability can be checked asynchronously.
    navigator.bluetooth.getAvailability().then((available) => {
      this._available = available;
    }).catch(() => {
      this._available = false;
    });

    // React to adapter state changes if the browser supports it.
    if ('onavailabilitychanged' in navigator.bluetooth) {
      (navigator.bluetooth as unknown as EventTarget).addEventListener(
        'availabilitychanged',
        (event: Event) => {
          this._available = (event as unknown as { value: boolean }).value;
        }
      );
    }
  }

  // ── listen ──────────────────────────────────────────────────────────────────

  /**
   * Start listening for inbound events.
   * Kicks off a scan loop that discovers nearby peers and subscribes to their
   * RX characteristic notifications.
   */
  listen(onEvent: (envelope: EventEnvelope) => void): void {
    this._listener = onEvent;

    if (!this._available) return;

    // Scan for peers every 10 s and subscribe to any we haven't seen yet.
    this._scanLoop = setInterval(() => this._scanAndConnect(), 10_000);
    // Immediate first scan.
    this._scanAndConnect();
  }

  private async _scanAndConnect(): Promise<void> {
    if (!this._available) return;

    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [SERVICE_UUID] }],
        optionalServices: [SERVICE_UUID],
      });

      if (this._peers.has(device.id)) return; // already connected

      device.addEventListener('gattserverdisconnected', () => {
        this._peers.delete(device.id);
      });

      const server = await device.gatt!.connect();
      this._peers.set(device.id, server);
      await this._subscribeToDevice(device.id, server);
    } catch {
      // User dismissed the picker or no device found — not an error.
    }
  }

  private async _subscribeToDevice(
    deviceId: string,
    server: BluetoothRemoteGATTServer
  ): Promise<void> {
    try {
      const service = await server.getPrimaryService(SERVICE_UUID);
      const rxChar  = await service.getCharacteristic(CHAR_UUID_RX);
      await rxChar.startNotifications();

      rxChar.addEventListener('characteristicvaluechanged', (event: Event) => {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value!;
        this._handleIncoming(deviceId, value);
      });
    } catch {
      // Device disconnected or service unavailable — clean up.
      this._peers.delete(deviceId);
    }
  }

  // ── publish ──────────────────────────────────────────────────────────────────

  /**
   * Send an envelope to all currently connected BLE peers.
   */
  async publish(envelope: EventEnvelope): Promise<void> {
    if (!this._available) return;

    const mid    = this._nextMessageId();
    const chunks = encodeEnvelope(envelope, mid);

    const sends = Array.from(this._peers.entries()).map(([deviceId, server]) =>
      this._sendChunks(deviceId, server, chunks)
    );

    await Promise.allSettled(sends);

    // Mark as relayed so we don't echo it back to ourselves.
    this._markRelayed(envelope.id);
  }

  private async _sendChunks(
    deviceId: string,
    server: BluetoothRemoteGATTServer,
    chunks: Uint8Array[]
  ): Promise<void> {
    try {
      const service = await server.getPrimaryService(SERVICE_UUID);
      const txChar  = await service.getCharacteristic(CHAR_UUID_TX);

      for (const chunk of chunks) {
        await txChar.writeValueWithResponse(chunk);
      }
    } catch {
      // Peer disconnected mid-send — remove it.
      this._peers.delete(deviceId);
    }
  }

  // ── incoming + reassembly ────────────────────────────────────────────────────

  private _handleIncoming(deviceId: string, data: DataView): void {
    const chunk = decodeChunk(data);
    const key   = `${deviceId}:${chunk.messageId}`;

    let buf = this._inFlight.get(key);
    if (!buf) {
      buf = { totalChunks: chunk.totalChunks, received: new Map(), lastSeen: Date.now() };
      this._inFlight.set(key, buf);
    }

    buf.received.set(chunk.chunkIndex, chunk.data);
    buf.lastSeen = Date.now();

    if (buf.received.size === buf.totalChunks) {
      this._inFlight.delete(key);
      this._reassembleAndDeliver(buf);
    }

    this._pruneInFlight();
  }

  private _reassembleAndDeliver(buf: InFlight): void {
    const parts: Uint8Array[] = [];
    for (let i = 0; i < buf.totalChunks; i++) {
      const part = buf.received.get(i);
      if (!part) return; // incomplete — discard
      parts.push(part);
    }

    const total = parts.reduce((acc, p) => acc + p.length, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      joined.set(p, offset);
      offset += p.length;
    }

    let envelope: EventEnvelope;
    try {
      envelope = JSON.parse(new TextDecoder().decode(joined));
    } catch {
      return; // malformed — discard silently
    }

    // Validate shape minimally — full sig/id validation is the Log's job.
    if (!envelope.id || !envelope.sig || !envelope.pubkey) return;

    // Deliver to the log.
    if (this._listener) {
      this._listener(envelope);
    }

    // Hop-by-hop relay: re-broadcast to other peers so it travels further.
    this._relay(envelope);
  }

  // ── relay ────────────────────────────────────────────────────────────────────

  /**
   * Re-broadcast a received event to all peers except the one it came from.
   * This is what makes it a mesh: A → B → C even if A and C can't see each other.
   */
  private _relay(envelope: EventEnvelope): void {
    if (this._hasRelayed(envelope.id)) return;
    this._markRelayed(envelope.id);

    // Fire-and-forget — relay failures don't need to surface.
    this.publish(envelope).catch(() => {});
  }

  // ── dedup helpers ─────────────────────────────────────────────────────────────

  private _hasRelayed(id: string): boolean {
    return this._relayedIds.has(id);
  }

  private _markRelayed(id: string): void {
    this._relayedIds.set(id, Date.now());
    this._pruneRelayed();
  }

  private _pruneRelayed(): void {
    const cutoff = Date.now() - RELAY_DEDUP_TTL_MS;
    for (const [id, ts] of this._relayedIds) {
      if (ts < cutoff) this._relayedIds.delete(id);
    }
  }

  private _pruneInFlight(): void {
    // Drop stale reassembly buffers (30 s timeout).
    const cutoff = Date.now() - 30_000;
    for (const [key, buf] of this._inFlight) {
      if (buf.lastSeen < cutoff) this._inFlight.delete(key);
    }
  }

  // ── utilities ─────────────────────────────────────────────────────────────────

  private _nextMessageId(): number {
    this._messageId = (this._messageId + 1) & 0xffff;
    return this._messageId;
  }

  /**
   * Stop the scan loop and disconnect all peers.
   * Call when the app is torn down.
   */
  destroy(): void {
    if (this._scanLoop !== null) {
      clearInterval(this._scanLoop);
      this._scanLoop = null;
    }
    for (const server of this._peers.values()) {
      server.disconnect();
    }
    this._peers.clear();
  }
}
