import { createHmac, timingSafeEqual } from 'node:crypto';
import { base32Encode } from './base32.js';

export type OtpAlgorithm = 'sha1' | 'sha256' | 'sha512';

export interface TotpOptions {
  /** Seconds per step. Authenticator apps assume 30. */
  period?: number;
  digits?: number;
  /** Authenticator apps assume SHA-1, which is still sound inside HMAC. */
  algorithm?: OtpAlgorithm;
}

const DEFAULTS = {
  period: 30,
  digits: 6,
  algorithm: 'sha1',
} as const satisfies Required<TotpOptions>;

/** HOTP (RFC 4226): a one-time code for a counter value. */
export function hotp(
  secret: Uint8Array,
  counter: number,
  digits: number = DEFAULTS.digits,
  algorithm: OtpAlgorithm = DEFAULTS.algorithm,
): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, secret).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The TOTP time step (RFC 6238) for a moment. */
export function totpStep(timeMs: number, period: number = DEFAULTS.period): number {
  return Math.floor(timeMs / 1000 / period);
}

/** The TOTP code for a moment. */
export function totp(secret: Uint8Array, timeMs = Date.now(), options: TotpOptions = {}): string {
  const { period, digits, algorithm } = { ...DEFAULTS, ...options };
  return hotp(secret, totpStep(timeMs, period), digits, algorithm);
}

export interface VerifyTotpOptions extends TotpOptions {
  timeMs?: number;
  /** Steps accepted either side of the current one, for clock drift. */
  window?: number;
}

/**
 * Checks a code against the current step and `window` steps either side. Returns the matching
 * step, which callers store to refuse the same code twice, or null.
 */
export function verifyTotp(
  secret: Uint8Array,
  code: string,
  options: VerifyTotpOptions = {},
): number | null {
  const { period, digits, algorithm } = { ...DEFAULTS, ...options };
  const window = options.window ?? 1;
  if (code.length !== digits || !/^\d+$/.test(code)) return null;
  const current = totpStep(options.timeMs ?? Date.now(), period);
  const given = Buffer.from(code);
  for (let step = current - window; step <= current + window; step++) {
    if (step < 0) continue;
    if (timingSafeEqual(Buffer.from(hotp(secret, step, digits, algorithm)), given)) return step;
  }
  return null;
}

/** The otpauth:// URI that authenticator apps read from a QR code. */
export function otpauthUri(params: {
  secret: Uint8Array;
  issuer: string;
  account: string;
  options?: TotpOptions;
}): string {
  const { period, digits, algorithm } = { ...DEFAULTS, ...params.options };
  const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.account)}`;
  const query = new URLSearchParams({
    secret: base32Encode(params.secret),
    issuer: params.issuer,
    algorithm: algorithm.toUpperCase(),
    digits: String(digits),
    period: String(period),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
