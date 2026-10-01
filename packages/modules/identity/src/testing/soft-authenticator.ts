import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';

/** A passkey a {@link SoftAuthenticator} holds. */
interface HeldPasskey {
  id: string;
  rpId: string;
  /** Base64url, as the site gave it. */
  userHandle: string;
  privateKey: KeyObject;
  counter: number;
}

// Authenticator data's flags (WebAuthn § 6.1).
const USER_PRESENT = 0x01;
const USER_VERIFIED = 0x04;
const BACKUP_ELIGIBLE = 0x08;
const BACKED_UP = 0x10;
const ATTESTED = 0x40;

const sha256 = (data: Uint8Array | string): Buffer => createHash('sha256').update(data).digest();
const bytes = (buffer: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(buffer);

/**
 * A platform authenticator in software, for tests: it makes ES256 passkeys the way
 * `navigator.credentials.create()` answers a site, and signs with them as
 * `navigator.credentials.get()` does, its user verified unless told otherwise. Synced passkeys
 * keep no counter, as password managers' don't.
 */
export class SoftAuthenticator {
  private readonly held: HeldPasskey[] = [];

  constructor(
    /** The page's origin, as the browser would put it in the client data. */
    readonly origin: string,
    private readonly settings: { synced?: boolean; verifiesUser?: boolean } = {},
  ) {}

  /** The IDs of the passkeys it holds, base64url, the oldest first. */
  get passkeyIds(): string[] {
    return this.held.map((passkey) => passkey.id);
  }

  /** A new passkey for the site's options, with "none" attestation. */
  create(
    options: PublicKeyCredentialCreationOptionsJSON,
    origin = this.origin,
  ): RegistrationResponseJSON {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const id = randomBytes(16);
    const passkey: HeldPasskey = {
      id: isoBase64URL.fromBuffer(bytes(id)),
      rpId: options.rp.id!,
      userHandle: options.user.id,
      privateKey,
      counter: 0,
    };
    this.held.push(passkey);
    // Its public key as COSE: EC2, ES256, P-256, x and y.
    const cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, isoBase64URL.toBuffer(jwk.x!)],
        [-3, isoBase64URL.toBuffer(jwk.y!)],
      ]),
    );
    const length = Buffer.alloc(2);
    length.writeUInt16BE(id.length);
    const authData = Buffer.concat([
      this.authenticatorData(passkey, ATTESTED),
      Buffer.alloc(16), // No AAGUID, as "none" attestation may leave out.
      length,
      id,
      cose,
    ]);
    const statement = new Map<string, string>();
    const attestationObject = isoCBOR.encode(
      new Map<string, string | Uint8Array | Map<string, string>>([
        ['fmt', 'none'],
        ['attStmt', statement],
        ['authData', bytes(authData)],
      ]),
    );
    return {
      id: passkey.id,
      rawId: passkey.id,
      type: 'public-key',
      response: {
        clientDataJSON: clientData('webauthn.create', options.challenge, origin),
        attestationObject: isoBase64URL.fromBuffer(attestationObject),
        transports: ['internal', 'hybrid'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /**
   * Signs the site's challenge with a passkey it holds for the site: `passkeyId`, or the first
   * the options allow, any of the site's when they name none.
   */
  get(
    options: PublicKeyCredentialRequestOptionsJSON,
    origin = this.origin,
    passkeyId?: string,
  ): AuthenticationResponseJSON {
    const allowed = new Set((options.allowCredentials ?? []).map((credential) => credential.id));
    const passkey = this.held.find(
      (key) =>
        key.rpId === options.rpId &&
        (passkeyId ? key.id === passkeyId : allowed.size === 0 || allowed.has(key.id)),
    );
    if (!passkey) throw new Error(`No passkey for ${options.rpId}`);
    if (!this.settings.synced) passkey.counter += 1;
    const authenticatorData = this.authenticatorData(passkey, 0);
    const clientDataJSON = clientData('webauthn.get', options.challenge, origin);
    const signature = sign(
      'sha256',
      Buffer.concat([authenticatorData, sha256(isoBase64URL.toBuffer(clientDataJSON))]),
      passkey.privateKey,
    );
    return {
      id: passkey.id,
      rawId: passkey.id,
      type: 'public-key',
      response: {
        clientDataJSON,
        authenticatorData: isoBase64URL.fromBuffer(bytes(authenticatorData)),
        signature: isoBase64URL.fromBuffer(bytes(signature)),
        userHandle: passkey.userHandle,
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  private authenticatorData(passkey: HeldPasskey, flags: number): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(passkey.counter);
    const verified = this.settings.verifiesUser === false ? 0 : USER_VERIFIED;
    const synced = this.settings.synced ? BACKUP_ELIGIBLE | BACKED_UP : 0;
    return Buffer.concat([
      sha256(passkey.rpId),
      Buffer.from([USER_PRESENT | verified | synced | flags]),
      counter,
    ]);
  }
}

function clientData(type: string, challenge: string, origin: string): string {
  return isoBase64URL.fromUTF8String(
    JSON.stringify({ type, challenge, origin, crossOrigin: false }),
  );
}
