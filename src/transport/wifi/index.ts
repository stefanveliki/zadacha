/**
 * WiFi Transport — TransportAdapter for local WiFi communication.
 *
 * Primary: WebSocket relay via a local hub (community Pi on the LAN).
 * Secondary: BroadcastChannel for same-device / same-origin communication.
 *
 * Raw UDP broadcast requires a native app wrapper and is a future adapter.
 */

export { WiFiTransport, type WiFiTransportConfig, type WiFiTransportStatus } from './wifi-transport.js';
export { WebSocketRelay, type WebSocketRelayConfig, type ConnectionState, DEFAULT_RELAY_PORT } from './websocket-relay.js';
export { BroadcastChannelAdapter } from './broadcast-channel.js';
export { HubDiscovery, type HubDiscoveryConfig, type DiscoveryResult } from './hub-discovery.js';
