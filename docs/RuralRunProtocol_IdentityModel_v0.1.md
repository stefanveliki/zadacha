# Rural Run Protocol — Identity Model v0.1

---

## Overview

Your identity on the network is a keypair — a private key and a public key. Nothing else. No username, no email, no registration. You exist on the network the moment you generate a keypair.

Your public key is your address — visible to the network, used to verify your signatures.
Your private key is your authority — never shared, never leaves your device, signs every event you publish.

---

## Key Generation

When you open the app for the first time, a keypair is generated on your device. You never see it. You never touch it. It is stored in your device's secure hardware — Apple's Secure Enclave on iPhone, Android's StrongBox on Android devices.

Access to the key is gated by your device's biometric — fingerprint, face, or PIN. The biometric is the lock. The key is behind the lock. You authenticate with your face or finger and the key is available to sign events. You never handle the key directly.

This is invisible to the user. Open the app, press your finger, you're in.

---

## Display Identity

Your keypair is your cryptographic identity. Your human identity is optional.

| Field | Required | Notes |
|-------|----------|-------|
| `pubkey` | yes | Your address on the network — derived from your private key |
| `display_name` | no | A name you choose — "Stefan", "Baba Maria", "The guy with the blue truck" |
| `avatar` | no | Optional image |

The network knows you by your public key. Your neighbors know you by your display name. Both are valid simultaneously.

---

## Social Recovery

Losing your phone does not mean losing your identity — if you have set up social recovery.

### How it works

At setup, you choose 3 guardians — trusted people in your community who are already on the network. Your private key is split into 3 encrypted shards using Shamir's Secret Sharing, a proven cryptographic algorithm. One shard goes to each guardian, stored encrypted on their device.

**No single guardian has your key.** Any 2 of the 3 shards are sufficient to reconstruct it. A guardian cannot reconstruct your key alone — they can only participate in a recovery.

### Recovery flow

```
You get a new phone → open the app → initiate recovery
    ↓
App contacts your 3 guardians over any available transport
    ↓
2 guardians respond and co-sign the recovery request
    ↓
Your key is reconstructed on your new device
    ↓
Old device's key is invalidated — a key rotation event is published to the log
```

Recovery is a signed, logged event. The network sees that a recovery happened. Nobody sees the key.

### Why social recovery fits this protocol

The same people who carry your groceries also carry a piece of your identity. The trust network that coordinates trips is the same trust network that recovers your keys. No external service, no custodian, no server — just neighbors doing what neighbors do.

---

## Guardian Rotation

Your recovery network is not permanent. Life changes — you move, relationships change, guardians leave the network.

Guardian rotation is a first-class protocol operation:

```
You initiate a rotation → old guardians co-sign the handoff
    ↓
New guardians receive new shards
    ↓
Old shards are cryptographically invalidated
    ↓
Rotation event published to the log
```

You can rotate individual guardians or the entire set. The protocol enforces that a rotation requires quorum from the old guardian set before the new set is activated — preventing unauthorized rotations.

### Moving to a new community

If you move and lose your phone before establishing a new guardian set, your old guardians are still valid — they still hold your shards. Recovery can happen remotely over any available transport, because shard exchange is just a signed message. Distance does not break social recovery.

As you build trust in your new community, you rotate your guardians. Old neighbors hand off to new neighbors. Your identity is continuous.

---

## Future Recovery Methods

Social recovery is the default — it is on-brand, decentralized, and requires nothing outside the network. Additional recovery adapters will be explored as the protocol matures. All future methods must remain decentralized. No custodian, no server, no single point of failure.

Candidates for future exploration:

- **Encrypted cloud backup** — key encrypted with biometric, stored in personal cloud (iCloud / Google Drive). Slightly centralizes on Apple/Google but remains user-controlled.
- **QR code on paper** — encrypted key exported as a QR code at setup. Fully offline. User stores it physically.
- **Multi-device** — key shared across two personal devices simultaneously.

These are adapters — the interface is open, the default is social, others are opt-in.

---

## Key Rotation After Compromise

If you believe your key has been compromised, you can rotate to a new keypair. The rotation requires quorum from your guardian set to be valid. A rotation event is published to the log, linking your old public key to your new one, so your history and reputation on the network follow you.

---

## Design Principles

- **Keys never leave the device.** The secure hardware signs events. The key itself is never exposed to the app layer.
- **Biometrics gate access, not identity.** Your biometric unlocks your key. It is not your identity. You can change your biometric, replace your device, and recover your key — your identity is the keypair, not the finger.
- **Social recovery is the network eating itself.** The same trust graph that makes trips possible makes identity recovery possible. No new infrastructure required.
- **Guardian rotation is expected, not exceptional.** Communities change. The protocol treats rotation as a normal lifecycle event, not an emergency procedure.
- **Recovery is transport-agnostic.** Shard exchange is a signed message. It travels over whatever transport is available — Bluetooth, WiFi, LoRa, internet. Distance and connectivity do not block recovery.

---

*Version 0.1 — identity model. Keypair generation, biometric gating, social recovery, guardian rotation. Future recovery adapters noted. All decisions trace back to the hard rules in Foundations v0.3.*
