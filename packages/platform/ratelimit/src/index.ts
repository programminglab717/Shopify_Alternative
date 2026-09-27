import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

export interface RateLimit {
  /** Stable name, part of the Redis key, e.g. "sign-in:email". */
  name: string;
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Time until the window resets; send it as Retry-After when refusing. */
  retryAfterMs: number;
}

// Increment and set the expiry atomically, so a crash between the two cannot leave a key that
// never expires.
const HIT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

/**
 * Fixed-window counters in Redis. Subjects (emails, IPs, phone numbers) are hashed before they
 * become keys, so Redis never holds personal data.
 */
export class RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'rl',
  ) {}

  /** Counts one attempt for `subject` and says whether it is within the limit. */
  async hit(limit: RateLimit, subject: string): Promise<RateLimitResult> {
    const [count, ttl] = (await this.redis.eval(
      HIT,
      1,
      this.key(limit, subject),
      limit.windowMs,
    )) as [number, number];
    return {
      allowed: count <= limit.limit,
      remaining: Math.max(0, limit.limit - count),
      retryAfterMs: count <= limit.limit ? 0 : ttl,
    };
  }

  /** Forgets attempts, e.g. after a successful sign-in. */
  async reset(limit: RateLimit, subject: string): Promise<void> {
    await this.redis.del(this.key(limit, subject));
  }

  private key(limit: RateLimit, subject: string): string {
    const digest = createHash('sha256').update(subject.toLowerCase()).digest('base64url');
    return `${this.prefix}:${limit.name}:${digest.slice(0, 22)}`;
  }
}
