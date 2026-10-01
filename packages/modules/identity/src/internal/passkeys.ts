import { decodeClientDataJSON } from '@simplewebauthn/server/helpers';
import { z } from 'zod';

/** Where staff sign in with passkeys: the relying party WebAuthn binds each one to (ADR-100). */
export interface PasskeySettings {
  /** The domain passkeys belong to, the admin's own or a parent of it: "hatti.pk". */
  rpId: string;
  /** Shown by browsers and authenticators beside the account: "Hatti". */
  rpName: string;
  /** The exact origins the admin's pages are served from: "https://admin.hatti.pk". */
  origins: string[];
}

export const PASSKEY_LIMITS = {
  /** A user's passkeys at most. */
  perUser: 10,
  /** Characters in a passkey's name. */
  name: 60,
} as const;

/** A passkey, as its owner sees it in their account. */
export interface PasskeyInfo {
  /** Public id, e.g. psk_… */
  id: string;
  name: string;
  /** Synced across its owner's devices, as a password manager's are. */
  multiDevice: boolean;
  backedUp: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/**
 * The user handle WebAuthn keeps with a user's passkeys: their UUID's 16 bytes, which a passkey
 * signing in alone gives back to say whose it is. Nothing personal, as WebAuthn asks.
 */
export function userHandleOf(userId: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(Buffer.from(userId.replace(/-/g, ''), 'hex'));
}

/** The challenge a response answers, read from its client data; null when it can't be read. */
export function challengeOf(response: { response: { clientDataJSON: string } }): string | null {
  try {
    const { challenge } = decodeClientDataJSON(response.response.clientDataJSON);
    return typeof challenge === 'string' && /^[A-Za-z0-9_-]{16,512}$/.test(challenge)
      ? challenge
      : null;
  } catch {
    return null;
  }
}

const base64url = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/, 'Expected base64url');

const credential = {
  id: base64url(1_366),
  rawId: base64url(1_366),
  type: z.literal('public-key'),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).nullish(),
};

/** What `navigator.credentials.create()` gave, as `PublicKeyCredential.toJSON()` writes it. */
export const registrationResponseSchema = z.object({
  ...credential,
  response: z.object({
    clientDataJSON: base64url(4_096),
    attestationObject: base64url(65_536),
    transports: z.array(z.string().max(32)).max(10).optional(),
  }),
});

/** What `navigator.credentials.get()` gave, as `PublicKeyCredential.toJSON()` writes it. */
export const authenticationResponseSchema = z.object({
  ...credential,
  response: z.object({
    clientDataJSON: base64url(4_096),
    authenticatorData: base64url(4_096),
    signature: base64url(1_024),
    userHandle: base64url(512).nullish(),
  }),
});

export type PasskeyAuthenticationResponse = z.output<typeof authenticationResponseSchema>;
