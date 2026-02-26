/**
 * Minimal Web Bluetooth API type declarations.
 * TypeScript's bundled lib.dom.d.ts does not always include these; this shim
 * covers the subset used by BluetoothTransportAdapter.
 */

interface BluetoothRemoteGATTCharacteristic extends EventTarget {
  readonly value: DataView | null;
  writeValueWithResponse(value: ArrayBuffer | ArrayBufferView): Promise<void>;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
}

interface BluetoothRemoteGATTService {
  getCharacteristic(uuid: string): Promise<BluetoothRemoteGATTCharacteristic>;
}

interface BluetoothRemoteGATTServer {
  readonly connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<BluetoothRemoteGATTService>;
}

interface BluetoothDevice extends EventTarget {
  readonly id: string;
  readonly gatt: BluetoothRemoteGATTServer | undefined;
}

interface RequestDeviceOptions {
  filters?: Array<{ services?: string[] }>;
  optionalServices?: string[];
}

interface Bluetooth extends EventTarget {
  getAvailability(): Promise<boolean>;
  requestDevice(options: RequestDeviceOptions): Promise<BluetoothDevice>;
}

interface Navigator {
  readonly bluetooth: Bluetooth;
}
