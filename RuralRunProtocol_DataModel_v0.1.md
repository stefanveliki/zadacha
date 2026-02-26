# Rural Run Protocol — Data Model v0.1

---

## Overview

Three event types exist in the log: **Need**, **Trip**, and **Match**.
Everything else in the system is derived from these three.

All events are signed by their author. All events are immutable once published. All events are visible to the local network.

---

## Need

A Need is a request submitted by anyone in the community. It is broadcast to the entire local network and remains unmatched until a runner accepts it.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | string (content hash) | yes | Derived from the event contents |
| `pubkey` | string | yes | Requester's public key — their identity |
| `display_name` | string | no | Optional human name — "Baba Maria", "Stefan from the hill" |
| `what` | string | yes | Free text — no constraints. "Heart medication from the pharmacy in town." |
| `by_when` | timestamp | yes | Deadline — when the need expires |
| `location` | string | yes | Requester's choice — GPS, neighborhood, description, whatever they give |
| `resource_footprint` | object | yes | What resources this need consumes (see below) |
| `created_at` | timestamp | yes | When the event was created |
| `sig` | string | yes | Requester's signature over all fields |

### Resource Footprint
The Need declares what it costs for a runner to fulfill it. The runner uses this to evaluate fit against their remaining capacity.

| Field | Type | Notes |
|-------|------|-------|
| `seat` | boolean | Does this need a seat in a vehicle? |
| `cargo` | string | Estimated size/weight — "2 gallons of milk", "small box" |
| `time_on_location` | integer (minutes) | Time the runner needs to spend on location |
| `physical_assistance` | boolean | Does this require carrying, helping, physical effort? |

---

## Trip

A Trip is announced by the runner. It declares what they have available and what they are willing to do. Only the runner can accept needs onto their trip.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | string (content hash) | yes | Derived from the event contents |
| `pubkey` | string | yes | Runner's public key |
| `display_name` | string | no | Optional human name |
| `destination` | string | yes | Where they are going — free text |
| `route` | string | no | Rough route description or waypoints |
| `departs_at` | timestamp | yes | When they are leaving |
| `returns_by` | timestamp | no | Estimated return window |
| `capacity` | object | yes | What the runner has available (see below) |
| `max_range` | string | yes | How far off route the runner is willing to go |
| `created_at` | timestamp | yes | When the event was created |
| `sig` | string | yes | Runner's signature over all fields |

### Capacity
The runner is the only authority on their own capacity. They declare what they have and evaluate each incoming need against it themselves. The protocol does not automate this decision.

| Field | Type | Notes |
|-------|------|-------|
| `seats` | integer | Number of passenger seats available |
| `cargo` | string | Available cargo space description — "half a trunk", "backpack only" |
| `time_budget` | integer (minutes) | Total extra time the runner is willing to spend on needs |
| `physical_assistance` | boolean | Whether the runner can help physically |

---

## Match

A Match is the record of a Need being accepted onto a Trip, fulfilled, and confirmed. It is the only event that requires two signatures — one from each party. Both must sign for the match to be valid.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | string (content hash) | yes | Derived from the event contents |
| `trip_id` | string | yes | Reference to the Trip |
| `need_id` | string | yes | Reference to the Need |
| `runner_pubkey` | string | yes | Runner's public key |
| `requester_pubkey` | string | yes | Requester's public key |
| `runner_sig` | string | yes | Runner's signature — acceptance |
| `requester_sig` | string | yes | Requester's signature — acknowledgment |
| `status` | enum | yes | `accepted` → `fulfilled` → `confirmed` |
| `settlement` | object | no | Optional — token, cash note, favor, nothing |
| `created_at` | timestamp | yes | When the match was created |

### Match Status Flow
```
runner signs acceptance     → status: accepted
runner signs fulfillment    → status: fulfilled
requester signs confirmation → status: confirmed  [final, immutable]
```

A match is not final until the requester confirms. Only the requester can move it to `confirmed`. Nobody can sign on behalf of someone else.

---

## Slot Release

A special event that allows a requester to voluntarily release their accepted slot back to the trip — for example, to let a higher-priority need take their place.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `match_id` | string | yes | The match being released |
| `requester_sig` | string | yes | Only the requester can release their own slot |
| `reason` | string | no | Optional — "giving my spot to Baba Maria" |

The runner co-signs to acknowledge. The released capacity is reflected in the trip log. The community sees both the release and the reason.

---

## Design Principles

- **The runner is the capacity oracle.** Only the runner evaluates fit between a Need's footprint and their remaining capacity. The protocol provides the information, the human makes the decision.
- **No constraints on free text fields.** What a need is, where a location is, what a route looks like — the protocol records whatever the human gives it.
- **Display names are opt-in.** Identity is a keypair. A human name is a choice.
- **Settlement is a field, not a requirement.** A match is valid with or without settlement recorded.
- **Resource footprint is multi-dimensional.** A seat, cargo space, time, and physical effort are all distinct resources. A trip can be full on seats but empty on cargo. A need consumes one or more dimensions.

---

*Version 0.1 — core data model. All three event types defined. Feeds directly into state machine and transport layer specs.*
