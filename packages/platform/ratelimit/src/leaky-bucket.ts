import type { Redis } from 'ioredis';

export interface BucketLimits {
  /** Points a full bucket holds. */
  maximum: number;
  /** Points it restores a second. */
  restoreRate: number;
}

export interface BucketResult {
  /** Whether the points were there to take; a refund always is. */
  allowed: boolean;
  /** Points left in the bucket after this, whole. */
  available: number;
}

// Restores what the time since the last call allows, then takes the points if they are all there,
// or gives them back when the amount is negative, in one step: two API processes taking from the
// same bucket at once cannot both spend its last points. A bucket left alone expires once it would
// have restored in full, which is the same as a bucket never used.
//
// KEYS[1] the bucket; ARGV maximum, restore rate a second, now in ms, points to take, expiry in ms.
const TAKE = `
local maximum = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local amount = tonumber(ARGV[4])
local state = redis.call('HMGET', KEYS[1], 'available', 'at')
local available = tonumber(state[1])
local at = tonumber(state[2])
if available == nil or at == nil then
  available = maximum
  at = now
else
  -- Another process's clock may run a little ahead: no time passes backwards.
  available = math.min(maximum, available + math.max(0, now - at) * rate / 1000)
  at = math.max(now, at)
end
local allowed = 0
if amount <= available then
  available = math.min(maximum, available - amount)
  allowed = 1
end
redis.call('HSET', KEYS[1], 'available', tostring(available), 'at', tostring(at))
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return { allowed, tostring(available) }
`;

/**
 * Leaky buckets of points in Redis, as Shopify meters its Admin API (ADR-576): each holds up to
 * its maximum and restores at a steady rate; a call takes what it may cost, if that much is there,
 * and gives back what it did not use. Subjects become keys as given, so they must hold no personal
 * data: IDs, not emails.
 */
export class LeakyBuckets {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'lb',
  ) {}

  /**
   * Takes `amount` points from `subject`'s bucket if it holds that many; `amount` 0 only looks.
   * `now` is the caller's clock, in milliseconds.
   */
  async take(
    name: string,
    subject: string,
    amount: number,
    limits: BucketLimits,
    now = Date.now(),
  ): Promise<BucketResult> {
    const [allowed, available] = (await this.redis.eval(
      TAKE,
      1,
      this.key(name, subject),
      limits.maximum,
      limits.restoreRate,
      now,
      amount,
      Math.ceil((limits.maximum / limits.restoreRate) * 1000) + 1000,
    )) as [number, string];
    return { allowed: allowed === 1, available: Math.floor(Number(available)) };
  }

  /** Gives `amount` points back to `subject`'s bucket, never past its maximum. */
  async refund(
    name: string,
    subject: string,
    amount: number,
    limits: BucketLimits,
    now = Date.now(),
  ): Promise<BucketResult> {
    return this.take(name, subject, -Math.max(0, amount), limits, now);
  }

  private key(name: string, subject: string): string {
    return `${this.prefix}:${name}:${subject}`;
  }
}
