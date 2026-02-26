/**
 * The universal signed event wrapper.
 * Every transport carries this. Nobody modifies it in transit.
 */
export interface EventEnvelope {
  id: string;          // sha256 of canonical [0, pubkey, created_at, kind, content]
  kind: number;        // see Event Kind Registry in InterfaceContracts
  pubkey: string;      // author's public key, hex encoded
  created_at: number;  // unix timestamp, integer
  content: string;     // JSON string — opaque to transport layer
  sig: string;         // author's signature over id, hex encoded
}
