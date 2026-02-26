# Rural Run Protocol — Interface Contracts v0.1

---

## Overview

Four interface boundaries exist in the system. Every agent building any layer must respect these contracts exactly. No layer may make assumptions about the internal implementation of another layer — only the contract at the boundary matters.

```
Identity
    ↓  signs
Event Envelope
    ↓  carried by
Transport Adapters
    ↓  deliver to
Log
    ↓  feeds
State Machine
    ↓  drives
UI
```

---

## 1. The Event Envelope

The universal wrapper for every event in the system. Every transport carries it. The log stores it. The state machine reads it.

```json
{
  "id":         "<sha256 hash of canonical event content>",
  "kind":       "<integer — see Event Kind Registry below>",
  "pubkey":     "<author's public key — hex encoded>",
  "created_at": "<unix timestamp — integer>",
  "content":    "<JSON string — the event payload>",
  "sig":        "<author's signature over id — hex encoded>"
}
```

### Rules
- `id` is derived — it is the sha256 hash of the canonical serialization of `[0, pubkey, created_at, kind, content]`
- `sig` is the author's private key signature over `id` — produced by the device's secure hardware, never by the app layer directly
- `content` is always a JSON string — not an object, a string. The log stores it opaquely. The state machine parses it.
- An event with an invalid `id` or `sig` is silently dropped by any layer that receives it
- Events are immutable once published — no layer may modify a stored event

---

## 2. Event Kind Registry

The `kind` field identifies what type of event is in the envelope. All agents must use these values exactly.

| Kind | Name | Who signs | Description |
|------|------|-----------|-------------|
| `1` | `TRIP_ANNOUNCE` | Runner | A trip is announced to the network |
| `2` | `NEED_SUBMIT` | Requester | A need is broadcast to the network |
| `3` | `MATCH_ACCEPT` | Runner | Runner accepts a need onto their trip |
| `4` | `MATCH_FULFILL` | Runner | Runner marks a need as fulfilled |
| `5` | `MATCH_CONFIRM` | Requester | Requester confirms fulfillment — final, immutable |
| `6` | `SLOT_RELEASE` | Requester | Requester releases their accepted slot |
| `7` | `SLOT_RELEASE_ACK` | Runner | Runner acknowledges a slot release |
| `8` | `TRIP_CLOSE` | Runner | Runner closes a trip to new needs |
| `9` | `TRIP_CANCEL` | Runner | Runner cancels a trip entirely |
| `100` | `GUARDIAN_SET` | Key owner | Initial guardian set established |
| `101` | `GUARDIAN_ROTATE` | Key owner + quorum | Guardian set rotated |
| `102` | `KEY_ROTATE` | Key owner + quorum | Keypair rotated — links old pubkey to new |
| `103` | `RECOVERY_INIT` | Recovering user | Key recovery initiated on new device |
| `104` | `RECOVERY_SHARD` | Guardian | Guardian provides shard for recovery |

Kinds `1–99` are coordination events. Kinds `100+` are identity events. No other kind values are valid.

---

## 3. Identity → Event Interface

Before any event enters a transport, it must be signed. Signing is the only operation the Identity layer exposes.

### Interface

```typescript
interface IdentityLayer {
  // Returns the user's public key
  getPublicKey(): Promise<string>

  // Signs an event id using the device secure hardware
  // Biometric prompt is triggered here if required
  signEvent(eventId: string): Promise<string>

  // Constructs, signs, and returns a complete Event Envelope
  // Caller provides kind and content — Identity handles id and sig
  buildEvent(kind: number, content: object): Promise<EventEnvelope>
}
```

### Rules
- The private key is never exposed outside the Identity layer
- `signEvent` may trigger a biometric prompt — callers must handle async latency
- `buildEvent` is the preferred method — callers should not construct envelopes manually
- The Identity layer is stateless except for the secure key material

---

## 4. Transport → Log Interface

Every transport adapter delivers events to the log through the same interface. The log does not know or care which transport delivered an event.

### Interface

```typescript
interface TransportAdapter {
  // Start listening for inbound events — calls onEvent for each received
  listen(onEvent: (envelope: EventEnvelope) => void): void

  // Publish an event to this transport
  publish(envelope: EventEnvelope): Promise<void>

  // Returns current availability of this transport
  isAvailable(): boolean
}

interface Log {
  // Receive an event from any transport — validates and stores if new
  receive(envelope: EventEnvelope): void

  // Query stored events
  query(filter: LogFilter): EventEnvelope[]

  // Subscribe to new events matching a filter
  subscribe(filter: LogFilter, callback: (envelope: EventEnvelope) => void): () => void
}

interface LogFilter {
  kinds?:      number[]     // filter by event kind
  pubkeys?:    string[]     // filter by author
  since?:      number       // unix timestamp — events after this time
  until?:      number       // unix timestamp — events before this time
  trip_id?:    string       // events referencing a specific trip
  need_id?:    string       // events referencing a specific need
  limit?:      number       // max results
}
```

### Rules
- The log validates `id` and `sig` on every received event — invalid events are dropped silently
- The log is append-only — no delete, no update
- The log deduplicates by `id` — receiving the same event twice has no effect
- All four transports publish simultaneously — the log deduplicates naturally
- The log is local-first — it stores events on device and syncs opportunistically

---

## 5. Log → State Machine Interface

The state machine reads from the log and maintains the current view of all trips, needs, and matches. It never writes to the log — only the Identity layer can produce new events.

### Interface

```typescript
interface StateMachine {
  // Returns all active trips visible to this node
  getActiveTrips(): Trip[]

  // Returns all unmatched needs visible to this node
  getUnmatchedNeeds(): Need[]

  // Returns all matches in any status
  getMatches(filter?: MatchFilter): Match[]

  // Returns the current state of a specific trip
  getTripState(tripId: string): TripState

  // Returns the current state of a specific need
  getNeedState(needId: string): NeedState
}

interface TripState {
  trip:             EventEnvelope       // the original TRIP_ANNOUNCE event
  remaining:        CapacityRemaining   // calculated remaining capacity
  attachedNeeds:    NeedState[]         // needs currently matched to this trip
  status:           'open' | 'closed' | 'cancelled' | 'completed'
}

interface NeedState {
  need:     EventEnvelope               // the original NEED_SUBMIT event
  status:   'unmatched' | 'accepted' | 'fulfilled' | 'confirmed' | 'released'
  matchId?: string                      // present if status is not 'unmatched'
}

interface CapacityRemaining {
  seats:               number
  cargo:               string
  time_budget:         number           // minutes remaining
  physical_assistance: boolean
}
```

### Rules
- The state machine is derived — it is always reconstructible from the log alone
- The state machine never writes events — it only reads and computes
- Capacity remaining is computed by the state machine from the trip's declared capacity minus accepted needs' footprints — but the runner's acceptance is always authoritative. The state machine's calculation is informational only.
- State machine state updates are triggered by new events arriving in the log via subscription

---

## 6. State Machine → UI Interface

The UI reads from the state machine and calls the Identity layer to produce new events. The UI never touches the log directly.

### Interface

```typescript
interface UIActions {
  // Runner actions
  announceTrip(params: TripParams): Promise<void>
  acceptNeed(tripId: string, needId: string): Promise<void>
  fulfillNeed(matchId: string): Promise<void>
  closeTrip(tripId: string): Promise<void>
  cancelTrip(tripId: string): Promise<void>

  // Requester actions
  submitNeed(params: NeedParams): Promise<void>
  confirmFulfillment(matchId: string): Promise<void>
  releaseSlot(matchId: string, reason?: string): Promise<void>

  // Identity actions
  setupGuardians(guardianPubkeys: string[]): Promise<void>
  rotateGuardians(oldGuardians: string[], newGuardians: string[]): Promise<void>
  initiateRecovery(): Promise<void>
}
```

### Rules
- Every UI action ultimately calls `IdentityLayer.buildEvent()` and publishes via all available transports
- The UI renders state from the State Machine only — it never derives state itself
- The UI must handle async biometric prompts gracefully — actions are not instant
- The UI must handle partial transport availability — if only one transport is available, the action still proceeds

---

## 7. Deduplication and Ordering

Because all transports fire simultaneously, the same event may arrive multiple times from different transports. The log handles this:

- Events are deduplicated by `id` — first arrival wins, subsequent arrivals are ignored
- Within the log, events are ordered by `created_at` timestamp
- The state machine processes events in `created_at` order
- Clock skew between devices is tolerated — events with timestamps slightly in the future are accepted, events with timestamps more than 5 minutes in the future are dropped

---

## 8. Contract Enforcement Rules for Agents

Any agent building any layer must:

1. **Consume events only through the defined interface** — no direct log access from the UI, no transport assumptions in the state machine
2. **Produce events only through `IdentityLayer.buildEvent()`** — no manually constructed envelopes
3. **Use only kind values from the Event Kind Registry** — no custom kinds without updating this document
4. **Treat the Event Envelope shape as immutable** — no additional fields, no field removal
5. **Never store or log private key material** — the Identity layer is the only place keys exist

Violations of these rules break the seams between layers and invalidate parallel work.

---

*Version 0.1 — interface contracts. Event envelope, kind registry, and all four layer boundaries defined. This document is the contract that makes parallel agent work possible. All agents read this before writing a line of code.*
