/**
 * Passkeys made and used in the browser from the options the core gives, as JSON both ways: the
 * core's options name their binary parts in base64url, as WebAuthn's JSON forms do, and it takes
 * the credential back so.
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

interface RequestOptionsJSON {
  challenge: string;
  allowCredentials?: { id: string; type: 'public-key'; transports?: string[] }[];
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

/** Signs with a passkey as `navigator.credentials.get()` does, from and to WebAuthn's JSON. */
export async function getPasskey(options: RequestOptionsJSON): Promise<Record<string, unknown>> {
  const publicKey = {
    ...options,
    challenge: fromBase64url(options.challenge),
    allowCredentials: (options.allowCredentials ?? []).map((each) => ({
      ...each,
      id: fromBase64url(each.id),
    })),
  } as unknown as PublicKeyCredentialRequestOptions;
  const credential = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential;
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toBase64url(response.clientDataJSON),
      authenticatorData: toBase64url(response.authenticatorData),
      signature: toBase64url(response.signature),
      ...(response.userHandle ? { userHandle: toBase64url(response.userHandle) } : {}),
    },
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
  };
}

/** Whether the person turned the browser's passkey prompt away, or it timed out. */
export const passkeyTurnedAway = (failure: unknown) =>
  failure instanceof DOMException && failure.name === 'NotAllowedError';
