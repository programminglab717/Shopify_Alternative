import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

const VERSION = 'v1';
const KEY_ID = /^[A-Za-z0-9]{1,16}$/;

export interface SecretBoxKey {
  /** Short identifier stored with each ciphertext, e.g. "k2026a". */
  id: string;
  /** 32 random bytes. */
  key: Buffer;
}

/**
 * Encrypts small secrets at rest (TOTP seeds, courier and gateway credentials) with AES-256-GCM.
 * Ciphertexts name their key, so after a rotation old values stay readable while new ones use
 * the first key. Associated data binds a ciphertext to its owner, e.g. "totp:<user id>", so it
 * cannot be copied onto another record.
 *
 * Production keys should come from a KMS (envelope encryption); this class is the data-key half.
 */
export class SecretBox {
  readonly #keys: ReadonlyMap<string, Buffer>;
  readonly #current: SecretBoxKey;

  constructor(keys: readonly SecretBoxKey[]) {
    const [current] = keys;
    if (!current) throw new SecretBoxError('At least one key is required');
    for (const { id, key } of keys) {
      if (!KEY_ID.test(id)) throw new SecretBoxError(`Invalid key id: ${id}`);
      if (key.length !== 32) throw new SecretBoxError(`Key ${id} must be 32 bytes`);
    }
    this.#keys = new Map(keys.map(({ id, key }) => [id, key]));
    this.#current = current;
  }

  /** Parses "id:base64key,id:base64key", newest key first. */
  static fromString(spec: string): SecretBox {
    return new SecretBox(
      spec
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          const [id = '', key = ''] = entry.split(':');
          return { id, key: Buffer.from(key, 'base64') };
        }),
    );
  }

  /** A new random key, base64-encoded for configuration. */
  static generateKey(): string {
    return randomBytes(32).toString('base64');
  }

  encrypt(plaintext: string | Buffer, associatedData: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#current.key, iv);
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    return [VERSION, this.#current.id, iv.toString('base64url'), body.toString('base64url')].join(
      '.',
    );
  }

  decrypt(payload: string, associatedData: string): Buffer {
    const [version, keyId = '', iv = '', body = ''] = payload.split('.');
    if (version !== VERSION) throw new SecretBoxError('Unsupported ciphertext version');
    const key = this.#keys.get(keyId);
    if (!key) throw new SecretBoxError(`Unknown key: ${keyId}`);
    const data = Buffer.from(body, 'base64url');
    if (data.length < 16) throw new SecretBoxError('Ciphertext is too short');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAAD(Buffer.from(associatedData, 'utf8'));
      decipher.setAuthTag(data.subarray(data.length - 16));
      return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
    } catch {
      throw new SecretBoxError('Ciphertext was tampered with or belongs to another record');
    }
  }

  /** True when a ciphertext uses an older key and should be re-encrypted. */
  needsRotation(payload: string): boolean {
    return payload.split('.')[1] !== this.#current.id;
  }
}
