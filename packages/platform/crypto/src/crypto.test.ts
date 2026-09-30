import { describe, expect, it } from 'vitest';
import {
  SecretBox,
  SecretBoxError,
  base32Decode,
  base32Encode,
  constantTimeEqual,
  hotp,
  otpauthUri,
  secretToken,
  totp,
  verifyTotp,
} from './index.js';

const ascii = (text: string) => Buffer.from(text, 'ascii');

describe('base32 (RFC 4648 §10 vectors)', () => {
  it.each([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('%j ↔ %s', (text, encoded) => {
    expect(base32Encode(ascii(text))).toBe(encoded);
    expect(base32Decode(encoded).toString('ascii')).toBe(text);
  });

  it('decodes padded, lowercase and grouped input', () => {
    expect(base32Decode('mzxw 6ytb-oi======').toString('ascii')).toBe('foobar');
  });

  it('rejects invalid characters', () => {
    expect(() => base32Decode('MZXW1')).toThrow(RangeError);
  });
});

describe('HOTP (RFC 4226 appendix D)', () => {
  const secret = ascii('12345678901234567890');
  it.each([
    [0, '755224'],
    [1, '287082'],
    [2, '359152'],
    [3, '969429'],
    [4, '338314'],
    [5, '254676'],
    [6, '287922'],
    [7, '162583'],
    [8, '399871'],
    [9, '520489'],
  ])('counter %i → %s', (counter, code) => {
    expect(hotp(secret, counter)).toBe(code);
  });
});

describe('TOTP (RFC 6238 appendix B)', () => {
  const secrets = {
    sha1: ascii('12345678901234567890'),
    sha256: ascii('12345678901234567890123456789012'),
    sha512: ascii('1234567890123456789012345678901234567890123456789012345678901234'),
  } as const;

  it.each([
    [59, 'sha1', '94287082'],
    [59, 'sha256', '46119246'],
    [59, 'sha512', '90693936'],
    [1111111109, 'sha1', '07081804'],
    [1111111111, 'sha256', '67062674'],
    [1234567890, 'sha512', '93441116'],
    [2000000000, 'sha1', '69279037'],
    [20000000000, 'sha256', '77737706'],
  ] as const)('t=%i %s → %s', (seconds, algorithm, code) => {
    expect(totp(secrets[algorithm], seconds * 1000, { digits: 8, algorithm })).toBe(code);
  });

  it('accepts one step of clock drift and reports the matching step', () => {
    const secret = ascii('12345678901234567890');
    const now = 1_700_000_000_000;
    const current = Math.floor(now / 30_000);
    expect(verifyTotp(secret, totp(secret, now), { timeMs: now })).toBe(current);
    expect(verifyTotp(secret, totp(secret, now - 30_000), { timeMs: now })).toBe(current - 1);
    expect(verifyTotp(secret, totp(secret, now + 30_000), { timeMs: now })).toBe(current + 1);
    expect(verifyTotp(secret, totp(secret, now - 60_000), { timeMs: now })).toBeNull();
  });

  it('rejects malformed codes', () => {
    const secret = ascii('12345678901234567890');
    expect(verifyTotp(secret, '12345')).toBeNull();
    expect(verifyTotp(secret, '12345a')).toBeNull();
  });

  it('builds an otpauth URI for authenticator apps', () => {
    const uri = otpauthUri({
      secret: ascii('12345678901234567890'),
      issuer: 'Hatti',
      account: 'owner@example.pk',
    });
    expect(uri).toBe(
      'otpauth://totp/Hatti:owner%40example.pk?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' +
        '&issuer=Hatti&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('SecretBox', () => {
  const k1 = { id: 'k1', key: Buffer.alloc(32, 1) };
  const k2 = { id: 'k2', key: Buffer.alloc(32, 2) };

  it('round-trips with associated data', () => {
    const box = new SecretBox([k1]);
    const sealed = box.encrypt('totp seed', 'totp:user-1');
    expect(sealed).toMatch(/^v1\.k1\.[\w-]+\.[\w-]+$/);
    expect(box.decrypt(sealed, 'totp:user-1').toString()).toBe('totp seed');
    expect(box.encrypt('totp seed', 'totp:user-1')).not.toBe(sealed);
  });

  it('refuses a ciphertext moved to another record or altered', () => {
    const box = new SecretBox([k1]);
    const sealed = box.encrypt('secret', 'totp:user-1');
    expect(() => box.decrypt(sealed, 'totp:user-2')).toThrow(SecretBoxError);
    // A bit of the tag flipped, rather than characters of its text, whose last bits base64 ignores:
    // 'BA' changed to 'BB' at the end is the same bytes.
    const [version, key, iv, body] = sealed.split('.') as [string, string, string, string];
    const bytes = Buffer.from(body, 'base64url');
    const last = bytes.length - 1;
    bytes[last] = (bytes[last] ?? 0) ^ 1;
    const tampered = [version, key, iv, bytes.toString('base64url')].join('.');
    expect(() => box.decrypt(tampered, 'totp:user-1')).toThrow(SecretBoxError);
  });

  it('keeps old ciphertexts readable after a key rotation', () => {
    const old = new SecretBox([k1]).encrypt('secret', 'ctx');
    const rotated = new SecretBox([k2, k1]);
    expect(rotated.decrypt(old, 'ctx').toString()).toBe('secret');
    expect(rotated.needsRotation(old)).toBe(true);
    expect(rotated.needsRotation(rotated.encrypt('secret', 'ctx'))).toBe(false);
    expect(() => new SecretBox([k2]).decrypt(old, 'ctx')).toThrow('Unknown key: k1');
  });

  it('parses keys from configuration', () => {
    const spec = `new:${SecretBox.generateKey()}, old:${k1.key.toString('base64')}`;
    const box = SecretBox.fromString(spec);
    expect(box.encrypt('x', 'ctx')).toMatch(/^v1\.new\./);
    expect(() => SecretBox.fromString('bad:c2hvcnQ=')).toThrow('must be 32 bytes');
  });
});

describe('tokens', () => {
  it('creates prefixed random tokens and compares in constant time', () => {
    const token = secretToken('hsa_');
    expect(token).toMatch(/^hsa_[\w-]{43}$/);
    expect(constantTimeEqual(token, token)).toBe(true);
    expect(constantTimeEqual(token, secretToken('hsa_'))).toBe(false);
  });
});
