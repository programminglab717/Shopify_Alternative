import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * A random secret with a recognisable prefix, e.g. "hsa_" + 43 characters for 32 bytes. Prefixes
 * let secret scanners spot leaked tokens and tell token kinds apart.
 */
export function secretToken(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString('base64url')}`;
}

/** Tokens are stored as SHA-256 digests: enough for high-entropy secrets, and fast to look up. */
export function sha256(value: string | Uint8Array): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Compares secrets without leaking where they differ through timing. */
export function constantTimeEqual(a: string, b: string): boolean {
  // Hashing first gives equal-length inputs, which timingSafeEqual requires.
  return timingSafeEqual(sha256(a), sha256(b));
}
