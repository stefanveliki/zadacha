# Rural Run Protocol — Multi-Agent Work Breakdown v0.1

---

## Overview

This document is the lead engineer's directive. It tells each agent exactly what to build, in what order, with what inputs, and what done looks like. No agent starts work without reading this document plus the documents listed in their inputs.

All agents are Claude instances. All agents treat the interface contracts as law. No agent modifies another agent's layer without a contract change first.

---

## Document Dependency Map

Every agent reads these before anything else:

1. `RuralRunProtocol_Foundations_v0.3.md` — the rules
2. `RuralRunProtocol_InterfaceContracts_v0.1.md` — the seams

Then their specific input documents listed below.

---

## Execution Order

```
Phase 1 — Parallel
    Agent A: Identity Layer
    Agent B: Transport — Bluetooth
    Agent C: Transport — WiFi
    Agent D: Transport — Nostr (internet)

Phase 2 — Sequential (requires Phase 1)
    Agent E: Log

Phase 3 — Sequential (requires Phase 2)
    Agent F: State Machine

Phase 4 — Sequential (requires Phase 3)
    Agent G: UI  ← spun up after integration tests pass
```

---

## Agent A — Identity Layer

### Reads
- Foundations v0.3
- InterfaceContracts v0.1
- IdentityModel v0.1

### Builds
- Keypair generation using device secure hardware (Web Crypto API / platform secure enclave bridge)
- Biometric gating — fingerprint / face / PIN
- `IdentityLayer` interface as defined in InterfaceContracts v0.1
- `buildEvent()` — constructs, hashes, and signs a complete Event Envelope
- Social recovery — Shamir's Secret Sharing shard generation and distribution
- Guardian rotation — quorum-gated shard invalidation and re-issue
- Key rotation — links old pubkey to new in a signed event
- Recovery initiation and shard collection flow

### Done when
- `buildEvent()` produces valid envelopes that pass signature verification
- Biometric prompt triggers correctly and handles cancellation gracefully
- Social recovery round-trip tested: shard → distribute → collect → reconstruct → verify keypair
- Guardian rotation tested: old quorum signs off, new shards issued, old shards invalidated
- All identity event kinds (100–104) produced correctly

### Does not touch
- Transport layer
- Log
- UI

---

## Agent B — Transport: Bluetooth

### Reads
- Foundations v0.3
- InterfaceContracts v0.1

### Builds
- `TransportAdapter` interface implementation for Bluetooth mesh
- BLE advertising and scanning
- Hop-by-hop relay — receives an event and re-broadcasts to peers in range
- Background operation on Android
- Graceful degradation on iOS — detects restriction, reports `isAvailable(): false`

### Done when
- Two Android devices exchange a signed Event Envelope over Bluetooth with no internet
- Relay tested — device A → device B → device C, where A and C are not in direct range
- iOS correctly reports unavailable rather than silently failing
- `isAvailable()` reflects real-time state

### Does not touch
- Log (delivers events to it via the defined interface only)
- Other transports

---

## Agent C — Transport: WiFi

### Reads
- Foundations v0.3
- InterfaceContracts v0.1

### Builds
- `TransportAdapter` interface implementation for local WiFi broadcast
- UDP broadcast on local subnet
- Works on any WiFi network — including hotspot from another device, or community Pi
- Works on both Android and iOS
- Automatic subnet detection

### Done when
- Two devices on the same WiFi network (no internet) exchange a signed Event Envelope
- Tested on: phone hotspot, router WiFi, Raspberry Pi access point
- iOS and Android both work
- `isAvailable()` correctly reflects WiFi connectivity state

### Does not touch
- Log
- Other transports

---

## Agent D — Transport: Nostr (Internet)

### Reads
- Foundations v0.3
- InterfaceContracts v0.1

### Builds
- `TransportAdapter` interface implementation for Nostr relays
- Multi-relay publish — fires to all configured relays simultaneously
- Relay list is configurable — community can add their own
- Subscription — listens for events matching local community filters
- Handles relay unavailability gracefully — continues with remaining relays
- Relay list stored on IPFS, fetched at startup, cached locally

### Done when
- Event published to 3 relays simultaneously
- Subscription receives events from any relay
- Single relay going offline does not break publish or subscribe
- Community relay added to list and receives events correctly
- `isAvailable()` reflects internet connectivity state

### Does not touch
- Log
- Other transports

---

## Agent E — Log

**Starts after Agents A, B, C, D are done.**

### Reads
- Foundations v0.3
- InterfaceContracts v0.1
- DataModel v0.1

### Builds
- `Log` interface as defined in InterfaceContracts v0.1
- Local-first storage — events stored on device using IndexedDB
- Event validation — verifies `id` hash and `sig` on every received event
- Deduplication by `id` — first arrival wins
- `receive()` — accepts events from any transport adapter
- `query()` — filters by kind, pubkey, time range, trip_id, need_id
- `subscribe()` — push notifications to state machine on new matching events
- Clock skew handling — drops events more than 5 minutes in the future
- Append-only enforcement — no delete, no update

### Done when
- Events from all four transports received, validated, deduplicated, and stored
- Same event arriving from two transports simultaneously stored exactly once
- Invalid signature dropped silently
- Query and subscribe tested with all filter combinations
- IndexedDB survives app close and reopen — log is persistent

### Does not touch
- State machine
- UI
- Transport internals

---

## Agent F — State Machine

**Starts after Agent E is done.**

### Reads
- Foundations v0.3
- InterfaceContracts v0.1
- DataModel v0.1

### Builds
- `StateMachine` interface as defined in InterfaceContracts v0.1
- Reconstructs full trip, need, and match state from log events
- `TripState` — including remaining capacity calculation
- `NeedState` — tracks status through full lifecycle
- `MatchState` — tracks two-signature flow to confirmation
- Subscribes to log for real-time state updates
- Handles all event kinds 1–9 (coordination events)
- Slot release and runner acknowledgment flow
- Trip close and cancel flows

### Done when
- Full trip lifecycle tested end-to-end from log events: announce → need attached → fulfilled → confirmed
- Slot release tested: requester releases, runner acks, capacity restored
- State machine fully reconstructible by replaying log from scratch
- Remaining capacity correctly computed and updated on each match accept
- State machine never produces events — verified by test

### Does not touch
- UI
- Transport layer
- Log internals

---

## Agent G — UI

**Starts after Agent F integration tests pass.**

### Reads
- Foundations v0.3
- InterfaceContracts v0.1
- DataModel v0.1

### Builds
- PWA — single HTML file, works offline after first load
- Runner flows: announce trip, view attached needs, accept need, mark fulfilled, close/cancel trip
- Requester flows: submit need, view trip announcements, view match status, confirm fulfillment, release slot
- Identity flows: first-time setup, biometric prompt, guardian selection, recovery initiation
- Transport status indicator — shows which transports are currently active
- Unmatched needs feed — visible to all, real-time
- Slot release UI — one tap to offer your slot to an unmatched need

### Done when
- Full runner + requester flow completable on a single device in isolation
- Full flow tested across two devices on local WiFi with no internet
- Works offline after first load
- Biometric prompt handled gracefully — including cancellation and retry
- Transport status reflects real availability in real time
- Passes on both Android Chrome and iOS Safari

### Does not touch
- Log directly
- Transport adapters directly
- State machine internals

---

## Integration Test Milestones

| Milestone | What gets tested | Agents involved |
|-----------|-----------------|-----------------|
| **IT-1** | Signed event travels from device A to device B over each transport | A, B, C, D |
| **IT-2** | Same event arrives via two transports, stored exactly once | A, B/C/D, E |
| **IT-3** | Full match lifecycle in log and state machine from raw events | E, F |
| **IT-4** | Full match lifecycle across two devices over local WiFi | A, B, C, D, E, F |
| **IT-5** | Social recovery round-trip across two devices | A, E |
| **IT-6** | Full end-to-end with UI | All |

---

## Rules for All Agents

1. Read Foundations and InterfaceContracts before writing a single line
2. Build only what is in your scope — nothing more
3. Consume other layers only through their defined interfaces
4. If a contract needs to change, flag it — do not change it unilaterally
5. Every public method has a unit test
6. Every integration milestone has a test before claiming done
7. No agent ships UI, no agent ships crypto — those are Agent G and Agent A respectively

---

*Version 0.1 — multi-agent work breakdown. Seven agents, four phases, six integration milestones. Lead engineer owns this document and resolves cross-agent conflicts.*
