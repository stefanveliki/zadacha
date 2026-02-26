# Rural Run Protocol — Foundations v0.3

---

## The Primitive

**A trip** is any intentional movement with spare capacity — physical, time, or skill.
A trip could be walking to a neighbor's house to fix a light bulb, or driving to the hospital to pick up someone's grandmother.

**A need** is anything unmet that could be resolved by attaching it to a trip.

**A match** is the atomic unit of the protocol — a need successfully attached to a trip before the window closes.

The protocol has one job: **attach unmet needs to trips before the window closes.**

Everything else is infrastructure serving that function.

---

## Hard Rules

1. **No servers you own.**
   If it requires you to keep something running, it is a liability and a killswitch.

2. **No accounts.**
   Your keys are your identity. You exist on the network the moment you generate a keypair — nothing to register, nothing to delete.

3. **Connectivity is optional, not assumed.**
   The protocol degrades gracefully. A match made over LoRa radio is as valid as one made over the internet.

4. **The match is the atomic unit.**
   Every feature exists in service of completing a match. Nothing else.

5. **Open data, private people.**
   Trip routes, item prices, service needs — visible to the network.
   Who is traveling, who is asking — protected by default.

6. **Forkable and exits.**
   The protocol is a spec, not a product. Anyone can implement it, run it, or fork it. No permission needed.

7. **Settlement is optional.**
   Neighbors helping neighbors don't need tokens. The token layer exists for when strangers or recurring runners need incentive alignment — it is an enhancement, not a requirement.

8. **Least centralized to most centralized — always.**
   Transports are used in order of decentralization. Local and infrastructure-free first, internet last. The internet is a fallback, not a default.

---

## Transport Layer

The protocol is transport-agnostic. A match is a signed message blob — it does not care how it travels.

Transports are used simultaneously in this order, from least to most centralized:

| Priority | Transport | Range | Infrastructure needed |
|----------|-----------|-------|----------------------|
| 1 | Bluetooth mesh | ~100m hops | None |
| 2 | Local WiFi | LAN / hotspot | WiFi network (no internet required) |
| 3 | LoRa / Meshtastic | 2–20km mesh | $35 hardware per node |
| 4 | Internet (Nostr) | Global | Cell signal or broadband |

**All available transports fire simultaneously.** The app does not pick one — it uses everything it has.

### Platform notes
- Android is a full citizen on all four transports.
- iPhone is a full citizen on WiFi, LoRa, and internet. Bluetooth background mesh is restricted by iOS — the recommended workaround is a community Pi acting as a local WiFi hub.
- A Raspberry Pi plugged in at a central community location (church, shop, someone's porch) makes all devices equal on the local mesh with no internet required.

### Transport adapter interface
Any transport that can **send and receive a signed message blob** qualifies as a valid adapter. The protocol ships four adapters (above) but the interface is open. Third parties can build adapters for SMS, ham radio, or any future transport — no permission needed. The protocol stays stable, the transport list grows forever.

---

## The Log

The protocol is a **public, append-only, signed event log**.

- Events are immutable once published.
- Nobody owns the log.
- Anyone can read it.
- Only the keyholder can write to their own slice of it.

The log is the memory of the network. The app is the human face of the network. They are two separate things that work together.

### Event types
Only three event types exist in the log:

| Event | Who signs it | What it records |
|-------|-------------|-----------------|
| **Trip** | Runner | A trip announced — destination, window, capacity |
| **Need** | Requester | A need submitted — what is needed, by when |
| **Match** | Both parties | A need accepted onto a trip, and later confirmed fulfilled |

Everything else in the system is derived from these three.

---

## The State Machine (Human Consensus)

A match is not a single event — it is a sequence of signed steps. Each step is signed by the party who has the authority to sign it. Nobody can sign on behalf of someone else.

```
Runner announces Trip
    ↓
Requester submits Need  [visible to entire local network]
    ↓
Runner signs Acceptance  [capacity decrements, network notified]
    ↓
Runner signs Fulfillment
    ↓
Requester signs Confirmation  [match is final, recorded in log]
```

This is human-to-human consensus with cryptographic memory. No validators. No mining. Two people agreeing, step by step, that something happened — and the log remembering it forever.

---

## Capacity and Social Coordination

The runner is the authority on their own trip. Only the runner can accept or reject needs. When the runner stops signing acceptances, the trip is full.

**All unmatched needs are visible to the entire local network** — not just the runner. This is intentional. A neighbor who sees grandma's unmatched need for heart medication can voluntarily release their own slot. The protocol records the release. The runner co-signs the swap. The log reflects what the community decided.

The protocol does not make social decisions. It makes sure the information is visible and every decision is recorded.

### Why this scales
The network shards itself by geography automatically. A community's log contains only that community's trips, needs, and matches. There is no global mempool. The load ceiling is human capacity — a person makes a handful of trips per day and a handful of needs per day. The cryptographic overhead is negligible on any modern phone. Millions of communities can use the protocol simultaneously with no community feeling the weight of the others.

---

## The UI

The app is a file — a PWA (Progressive Web App) delivered as a single HTML file. It can be:
- Shared over Bluetooth, WiFi, USB, or QR code
- Pinned to IPFS and addressed by content hash
- Opened directly from device storage

Once opened once, it works fully offline. No app store, no domain, no hosting bill. It spreads like a file, not like a product.

---

## What This Is Not

- Not a platform
- Not a company
- Not an app you download from a store
- Not dependent on any single person, server, or country staying online

---

*Version 0.3 — foundations + transport layer + log + state machine + capacity model. All architecture decisions must trace back to the primitive and the hard rules.*
