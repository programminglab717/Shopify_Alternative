import type { Redis } from 'ioredis';
import { ACTIVITY_STEPS, StorefrontKeys, type ActivityStep } from './keys.js';

// What shoppers do on a shop's storefront, counted as Shopify's analytics count it (ANL-02,
// ADR-180): each day's sessions, in the shop's time zone, and those of them that added to the
// cart, reached checkout and placed an order; and who saw a page in the last five minutes. A
// day's counts are HyperLogLogs of its sessions' IDs, kept in Valkey a few days, until the core's
// worker keeps them in Postgres; they are estimates, within about 1%, and exact for few. Each
// day's taps on the links of the shop's link page are counted beside them, exactly (ADR-204).

export const ACTIVITY = {
  /** How long a visitor counts as on the storefront after the last page they saw. */
  liveMinutes: 5,
  /** How long a day's counts stay in Valkey, for the worker to keep them. */
  keepDays: 3,
} as const;

/** A day's sessions, and those of them that took each step. */
export type ActivityCounts = Record<ActivityStep, number>;

/** The time zone a shop's days fall in when its document names none. */
const DEFAULT_TIME_ZONE = 'Asia/Karachi';

const formats = new Map<string, Intl.DateTimeFormat>();

/** The day `at` falls on in `timeZone`, as "2026-10-05"; in Pakistan's for a zone not known. */
export function localDay(at: Date, timeZone: string): string {
  let format = formats.get(timeZone);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    } catch {
      return localDay(at, DEFAULT_TIME_ZONE);
    }
    formats.set(timeZone, format);
  }
  const parts = format.formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * Counts what shoppers do on shops' storefronts, for the storefront that sees it, and reads the
 * counts, for the core (ADR-180).
 */
export class StorefrontActivity {
  constructor(
    private readonly redis: Redis,
    private readonly keys = new StorefrontKeys(),
  ) {}

  /** A page `session` saw at `at`: one of its day's sessions, and on the storefront now. */
  async visited(shopId: string, timeZone: string, session: string, at = new Date()): Promise<void> {
    const live = this.keys.live(shopId);
    const pipeline = this.#counted(shopId, localDay(at, timeZone), ['sessions'], session)
      .zadd(live, at.getTime(), session)
      .zremrangebyscore(live, '-inf', `(${at.getTime() - ACTIVITY.liveMinutes * 60_000}`)
      .expire(live, ACTIVITY.liveMinutes * 60 * 2);
    await exec(pipeline);
  }

  /**
   * `session` took `step` at `at`: counted among that day's sessions too, whatever its pages
   * said, so no step counts more sessions than the day has.
   */
  async reached(
    shopId: string,
    timeZone: string,
    session: string,
    step: Exclude<ActivityStep, 'sessions'>,
    at = new Date(),
  ): Promise<void> {
    await exec(this.#counted(shopId, localDay(at, timeZone), ['sessions', step], session));
  }

  /**
   * A tap at `at` on the link of the shop's link page that goes to `url` (ADR-204): one more of
   * that day's on it, and the day marked changed, for the worker to keep.
   */
  async tapped(shopId: string, timeZone: string, url: string, at = new Date()): Promise<void> {
    const day = localDay(at, timeZone);
    const key = this.keys.linkTaps(shopId, day);
    await exec(
      this.redis
        .pipeline()
        .hincrby(key, url, 1)
        .expire(key, ACTIVITY.keepDays * 24 * 60 * 60)
        .sadd(this.keys.activityChanged(), `${shopId} ${day}`),
    );
  }

  /** A day's taps so far on the links of the shop's link page, by the address each goes to. */
  async linkTaps(shopId: string, day: string): Promise<Record<string, number>> {
    const counted = await this.redis.hgetall(this.keys.linkTaps(shopId, day));
    return Object.fromEntries(Object.entries(counted).map(([url, taps]) => [url, Number(taps)]));
  }

  /** How many sessions saw a page in the five minutes to `at`. */
  async liveVisitors(shopId: string, at = new Date()): Promise<number> {
    const since = at.getTime() - ACTIVITY.liveMinutes * 60_000;
    return this.redis.zcount(this.keys.live(shopId), since, '+inf');
  }

  /** A day's counts so far, "2026-10-05" in the shop's time zone. */
  async counts(shopId: string, day: string): Promise<ActivityCounts> {
    const pipeline = this.redis.pipeline();
    for (const step of ACTIVITY_STEPS) pipeline.pfcount(this.keys.activity(shopId, day, step));
    const results = await exec(pipeline);
    return Object.fromEntries(
      ACTIVITY_STEPS.map((step, index) => [step, Number(results[index] ?? 0)]),
    ) as ActivityCounts;
  }

  /**
   * Up to `count` shops' days whose counts changed since they were last taken, for the worker to
   * keep; {@link giveBack} those it could not.
   */
  async takeChanged(count: number): Promise<{ shopId: string; day: string }[]> {
    const taken = await this.redis.spop(this.keys.activityChanged(), count);
    return taken.flatMap((member) => {
      const [shopId, day] = member.split(' ');
      return shopId && day ? [{ shopId, day }] : [];
    });
  }

  async giveBack(changed: readonly { shopId: string; day: string }[]): Promise<void> {
    if (changed.length === 0) return;
    await this.redis.sadd(
      this.keys.activityChanged(),
      ...changed.map(({ shopId, day }) => `${shopId} ${day}`),
    );
  }

  /** `session` among the day's `steps`, kept a few days, and the day marked changed. */
  #counted(shopId: string, day: string, steps: readonly ActivityStep[], session: string) {
    const pipeline = this.redis.pipeline();
    for (const step of steps) {
      const key = this.keys.activity(shopId, day, step);
      pipeline.pfadd(key, session).expire(key, ACTIVITY.keepDays * 24 * 60 * 60);
    }
    return pipeline.sadd(this.keys.activityChanged(), `${shopId} ${day}`);
  }
}

/** Runs `pipeline`, failing as its first command that failed did: each command's answer. */
async function exec(pipeline: ReturnType<Redis['pipeline']>): Promise<unknown[]> {
  const results = (await pipeline.exec()) ?? [];
  const failed = results.find(([error]) => error);
  if (failed) throw failed[0];
  return results.map(([, result]) => result);
}
