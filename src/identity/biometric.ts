/**
 * Rural Run Protocol — Biometric Gate
 *
 * Wraps the WebAuthn (Web Authentication) API to gate access to signing.
 * On iOS/Android, WebAuthn calls down into the platform's secure hardware:
 *   iOS  → Secure Enclave (Face ID / Touch ID)
 *   Android → StrongBox / TEE (fingerprint / face)
 *
 * The credential produced here is used ONLY as a biometric barrier —
 * the actual signing key is a separate secp256k1 keypair. WebAuthn
 * provides the "prove you're the device owner" step before we use it.
 *
 * Design:
 *   setup()        → navigator.credentials.create()  — registers a resident credential
 *   authenticate() → navigator.credentials.get()     — challenges the credential
 *
 * Implements the BiometricGate interface from types.ts.
 *
 * Graceful degradation: if WebAuthn is unavailable (older browser, desktop
 * test environment), isAvailable() returns false and authenticate() throws
 * BiometricUnavailableError. Callers that need testing can inject a
 * NoOpBiometricGate.
 */

import { BiometricCancelledError, BiometricUnavailableError } from './types.js';
import type { BiometricGate } from './types.js';

const RP_ID_DEFAULT = 'localhost';
const RP_NAME = 'Rural Run Protocol';
const CREDENTIAL_KEY = 'rrp-webauthn-credential-id';

// ---------------------------------------------------------------------------
// WebAuthn BiometricGate
// ---------------------------------------------------------------------------

export class WebAuthnBiometricGate implements BiometricGate {
  private rpId: string;

  constructor(rpId: string = RP_ID_DEFAULT) {
    this.rpId = rpId;
  }

  async isAvailable(): Promise<boolean> {
    if (typeof navigator === 'undefined') return false;
    if (!navigator.credentials || !window.PublicKeyCredential) return false;
    try {
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch {
      return false;
    }
  }

  /**
   * First-time setup: create a platform authenticator credential.
   * The credentialId is persisted to localStorage for subsequent authenticate() calls.
   *
   * @param userId  the user's public key hex — used as the user handle
   */
  async setup(userId: string): Promise<void> {
    if (!(await this.isAvailable())) {
      throw new BiometricUnavailableError('Platform authenticator not available');
    }

    const userIdBytes = new TextEncoder().encode(userId.slice(0, 64));
    const challenge = globalThis.crypto.getRandomValues(new Uint8Array(32));

    const options: PublicKeyCredentialCreationOptions = {
      challenge,
      rp: { id: this.rpId, name: RP_NAME },
      user: {
        id: userIdBytes,
        name: 'RRP User',
        displayName: 'Rural Run Protocol User',
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },   // ES256 (P-256)
        { type: 'public-key', alg: -257 },  // RS256 fallback
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      timeout: 60_000,
    };

    let credential: Credential | null;
    try {
      credential = await navigator.credentials.create({ publicKey: options });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        throw new BiometricCancelledError();
      }
      throw err;
    }

    if (!credential) throw new BiometricUnavailableError('Credential creation returned null');

    // Persist the credential ID so authenticate() can find it
    const credId = (credential as PublicKeyCredential).rawId;
    localStorage.setItem(CREDENTIAL_KEY, bufferToBase64(credId));
  }

  /**
   * Prompt the user for biometric authentication.
   * Requires setup() to have been called first.
   *
   * @param reason  human-readable string for the system prompt (not shown on all platforms)
   */
  async authenticate(_reason: string): Promise<boolean> {
    if (!(await this.isAvailable())) {
      throw new BiometricUnavailableError();
    }

    const storedId = localStorage.getItem(CREDENTIAL_KEY);
    if (!storedId) {
      throw new BiometricUnavailableError('No credential registered — call setup() first');
    }

    const challenge = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const credId = base64ToBuffer(storedId);

    const options: PublicKeyCredentialRequestOptions = {
      challenge,
      rpId: this.rpId,
      allowCredentials: [{ type: 'public-key', id: credId }],
      userVerification: 'required',
      timeout: 60_000,
    };

    try {
      const assertion = await navigator.credentials.get({ publicKey: options });
      return assertion !== null;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        throw new BiometricCancelledError();
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// NoOp BiometricGate — for test environments and explicit opt-out
// ---------------------------------------------------------------------------

/**
 * A BiometricGate that always succeeds without prompting.
 * Use in test environments or when the caller explicitly wants no biometric gate.
 */
export class NoOpBiometricGate implements BiometricGate {
  async isAvailable(): Promise<boolean> {
    return true;
  }

  async authenticate(_reason: string): Promise<boolean> {
    return true;
  }

  async setup(_userId: string): Promise<void> {
    // nothing to do
  }
}

/**
 * A BiometricGate that always throws BiometricCancelledError.
 * Use in tests that verify cancellation handling.
 */
export class CancellingBiometricGate implements BiometricGate {
  async isAvailable(): Promise<boolean> {
    return true;
  }

  async authenticate(_reason: string): Promise<boolean> {
    throw new BiometricCancelledError();
  }

  async setup(_userId: string): Promise<void> {
    // nothing to do
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Returns a WebAuthnBiometricGate in browser environments,
 * NoOpBiometricGate in Node.js/test environments.
 */
export function createBiometricGate(rpId?: string): BiometricGate {
  if (typeof navigator !== 'undefined' && typeof window !== 'undefined') {
    return new WebAuthnBiometricGate(rpId);
  }
  return new NoOpBiometricGate();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let str = '';
  for (const byte of bytes) str += String.fromCharCode(byte);
  return btoa(str);
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const str = atob(b64);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes.buffer;
}
