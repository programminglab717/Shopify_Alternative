/**
 * A passkey made in the browser from the options the core gives, as JSON both ways: the core's
 * options name their binary parts in base64url, as WebAuthn's JSON forms do, and it takes the
 * new credential back so.
 */

const fromBase64url = (text: string): ArrayBuffer => {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  return bytes.buffer;
};

const toBase64url = (buffer: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

interface CreationOptionsJSON {
  challenge: string;
  user: { id: string; name: string; displayName: string };
  excludeCredentials?: { id: string; type: 'public-key'; transports?: string[] }[];
  [option: string]: unknown;
}

/** Whether this browser makes passkeys at all. */
export const passkeysWork = () =>
  typeof window !== 'undefined' &&
  'PublicKeyCredential' in window &&
  typeof navigator.credentials?.create === 'function';

/** Makes a passkey as `navigator.credentials.create()` does, from and to WebAuthn's JSON. */
export async function createPasskey(
  options: CreationOptionsJSON,
): Promise<Record<string, unknown>> {
  const publicKey = {
    ...options,
    challenge: fromBase64url(options.challenge),
    user: { ...options.user, id: fromBase64url(options.user.id) },
    excludeCredentials: (options.excludeCredentials ?? []).map((each) => ({
      ...each,
      id: fromBase64url(each.id),
    })),
  } as unknown as PublicKeyCredentialCreationOptions;
  const credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential;
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toBase64url(response.clientDataJSON),
      attestationObject: toBase64url(response.attestationObject),
      transports: response.getTransports?.() ?? [],
    },
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
  };
}
