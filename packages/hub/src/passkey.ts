/**
 * WebAuthn ceremony helper — thin wrapper over @simplewebauthn/server so the
 * server verifies attestations/assertions against a hub-issued, single-use
 * challenge. The hub never trusts the browser blobs beyond what this verifies.
 */
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type { StoredCredential } from "./credential-store.js";

type RegistrationResponse = Parameters<typeof verifyRegistrationResponse>[0]["response"];
type AuthenticationResponse = Parameters<typeof verifyAuthenticationResponse>[0]["response"];

export interface PasskeyConfig {
  rpID: string;
  rpName: string;
  origin: string;
}

export class Passkey {
  constructor(private readonly cfg: PasskeyConfig) {}

  async registrationOptions(name: string): Promise<{ options: unknown; challenge: string }> {
    const options = await generateRegistrationOptions({
      rpName: this.cfg.rpName,
      rpID: this.cfg.rpID,
      userName: name,
      attestationType: "none",
      authenticatorSelection: { userVerification: "preferred", residentKey: "required" },
    });
    return { options, challenge: options.challenge };
  }

  async verifyRegistration(response: unknown, expectedChallenge: string, name: string): Promise<StoredCredential | null> {
    try {
      const verification = await verifyRegistrationResponse({
        response: response as RegistrationResponse,
        expectedChallenge,
        expectedOrigin: this.cfg.origin,
        expectedRPID: this.cfg.rpID,
      });
      if (!verification.verified || !verification.registrationInfo) return null;
      const cred = verification.registrationInfo.credential;
      return {
        id: cred.id,
        publicKey: Buffer.from(cred.publicKey).toString("base64url"),
        counter: cred.counter,
        name,
        createdAt: Date.now(),
      };
    } catch {
      return null;
    }
  }

  async authenticationOptions(allowCredentialIds: string[]): Promise<{ options: unknown; challenge: string }> {
    const options = await generateAuthenticationOptions({
      rpID: this.cfg.rpID,
      allowCredentials: allowCredentialIds.map((id) => ({ id })),
      userVerification: "preferred",
    });
    return { options, challenge: options.challenge };
  }

  /** Returns the new signature counter on success, or null on any failure. */
  async verifyAuthentication(response: unknown, expectedChallenge: string, stored: StoredCredential): Promise<number | null> {
    try {
      const verification = await verifyAuthenticationResponse({
        response: response as AuthenticationResponse,
        expectedChallenge,
        expectedOrigin: this.cfg.origin,
        expectedRPID: this.cfg.rpID,
        credential: {
          id: stored.id,
          publicKey: new Uint8Array(Buffer.from(stored.publicKey, "base64url")),
          counter: stored.counter,
        },
      });
      if (!verification.verified) return null;
      return verification.authenticationInfo.newCounter;
    } catch {
      return null;
    }
  }
}

/** Extract the credential id from an authentication response blob (may be absent/garbage). */
export function responseCredentialId(response: unknown): string | null {
  if (response && typeof response === "object" && "id" in response) {
    const id = (response as { id: unknown }).id;
    return typeof id === "string" ? id : null;
  }
  return null;
}
