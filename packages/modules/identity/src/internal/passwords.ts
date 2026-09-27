import { createHash } from 'node:crypto';
import { hash, parseOptions, verify } from '@node-rs/argon2';

export const PASSWORD_MIN_LENGTH = 10;
/** argon2 cost grows with input length; cap it so a huge password cannot tie up a CPU. */
export const PASSWORD_MAX_LENGTH = 128;

// argon2id with 19 MiB, 2 passes, 1 lane: the OWASP minimum, and @node-rs/argon2's defaults.
const POLICY = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, POLICY);
}

export function verifyPassword(stored: string, password: string): Promise<boolean> {
  return verify(stored, password).catch(() => false);
}

/** True when a stored hash was made with weaker settings than today's policy. */
export function needsRehash(stored: string): boolean {
  try {
    const options = parseOptions(stored);
    return (
      options.memoryCost < POLICY.memoryCost ||
      options.timeCost < POLICY.timeCost ||
      options.parallelism !== POLICY.parallelism
    );
  } catch {
    return true;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns the same time as checking a real password, so response times do not reveal whether an
 * email address has an account.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword('not a real password, only a timing decoy');
  await verifyPassword(await dummyHash, password);
  return false;
}

/** Checks passwords against known breaches. Implementations must not send the password. */
export interface BreachedPasswordChecker {
  isBreached(password: string): Promise<boolean>;
}

export const noBreachCheck: BreachedPasswordChecker = { isBreached: async () => false };

export interface HaveIBeenPwnedOptions {
  timeoutMs?: number;
  onError?: (error: unknown) => void;
  fetch?: typeof fetch;
}

/**
 * Pwned Passwords range API (k-anonymity): only the first 5 hex characters of the password's
 * SHA-1 leave the server. Fails open, so an outage of the service never blocks sign-ups.
 */
export class HaveIBeenPwnedChecker implements BreachedPasswordChecker {
  constructor(private readonly options: HaveIBeenPwnedOptions = {}) {}

  async isBreached(password: string): Promise<boolean> {
    const digest = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = digest.slice(0, 5);
    const suffix = digest.slice(5);
    try {
      const response = await (this.options.fetch ?? fetch)(
        `https://api.pwnedpasswords.com/range/${prefix}`,
        {
          headers: { 'Add-Padding': 'true', 'User-Agent': 'hatti-identity' },
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 2_000),
        },
      );
      if (!response.ok) throw new Error(`Pwned Passwords responded ${response.status}`);
      const body = await response.text();
      return body.split('\n').some((line) => {
        const [hashSuffix, count] = line.trim().split(':');
        return hashSuffix === suffix && Number(count) > 0;
      });
    } catch (error) {
      this.options.onError?.(error);
      return false;
    }
  }
}

/** Why a new password is unacceptable, or null. */
export async function passwordProblem(
  password: string,
  context: { email: string },
  breaches: BreachedPasswordChecker,
): Promise<string | null> {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Use at most ${PASSWORD_MAX_LENGTH} characters`;
  }
  const lower = password.toLowerCase();
  const localPart = context.email.split('@')[0] ?? '';
  if (lower === context.email || (localPart.length >= 4 && lower.includes(localPart))) {
    return 'Do not use your email address in your password';
  }
  if (await breaches.isBreached(password)) {
    return 'This password has appeared in a data breach. Choose another one';
  }
  return null;
}
