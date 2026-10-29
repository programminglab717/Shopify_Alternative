import { shopProfile } from '@hatti/api';
import type { Database, Db } from '@hatti/db';
import {
  SSO_PROOF,
  recheckSsoDomain,
  ssoDomainsToRecheck,
  type SsoDomainCheck,
  type TxtLookup,
} from '@hatti/identity/public';
import type { Logger } from '@hatti/logger';
import type { MessagesService } from '@hatti/messaging/public';
import { shopTime } from './notifications.js';
import { repeat } from './repeat.js';
import { tellShop } from './shop-notices.js';

/** Domains looked up at a time, and batches at most in a sweep. */
const BATCH = 100;
const BATCHES = 10;

/** Tells a shop its domain's record is gone, and when the domain stops being proved its. */
export type SsoDomainMissingNotice = (
  shopId: string,
  domain: string,
  unprovedAt: Date,
) => Promise<void>;

/**
 * The shop told at its alerts number and its owner's email, as Hatti's notices of its domains go
 * (ADR-262): the domain, and the day it stops being proved the shop's, in the shop's time zone.
 * Once a time it goes missing, and at Hatti's cost.
 */
export function ssoDomainMissingNotice(
  database: Database,
  messages: Pick<MessagesService, 'queueIn'>,
): SsoDomainMissingNotice {
  return (shopId, domain, unprovedAt) =>
    database.tenant(shopId, async (tx) => {
      const shop = await shopProfile(tx, shopId);
      await tellShop(tx, messages, shopId, {
        kind: 'sso_domain_missing',
        dedupeKey: `sso_domain_missing:${domain}:${unprovedAt.toISOString()}`,
        variables: { shop: shop.name, domain, date: shopTime(shop.timezone, unprovedAt) },
      });
    });
}

/**
 * Looks shops' single sign-on domains up in DNS again, a day after the last (ADM-09, ADR-934),
 * a batch at a time until a batch comes back short: each through identity's own
 * `recheckSsoDomain`, which says a record gone is missing and, three days on, has the domain no
 * longer proved the shop's. The first time one is found missing, its shop is told (ADR-938). One
 * domain's failure is logged and not the others'.
 */
export class SsoDomainChecks {
  constructor(
    private readonly db: Pick<Db, 'execute'>,
    private readonly lookup: TxtLookup,
    private readonly logger?: Pick<Logger, 'warn' | 'info'>,
    private readonly tell?: SsoDomainMissingNotice,
  ) {}

  /** One sweep at `at`: how many domains came to each end. */
  async sweep(at: Date = new Date()): Promise<Record<SsoDomainCheck, number>> {
    const counts: Record<SsoDomainCheck, number> = {
      proved: 0,
      missing: 0,
      unproved: 0,
      unanswered: 0,
    };
    for (let batch = 0; batch < BATCHES; batch++) {
      const due = await ssoDomainsToRecheck(this.db, at, BATCH);
      for (const each of due) {
        try {
          const check = await recheckSsoDomain(this.db, each, this.lookup, at);
          counts[check] += 1;
          if (check === 'missing' && each.missingSince === null) {
            await this.tell?.(each.shopId, each.domain, new Date(at.getTime() + SSO_PROOF.graceMs));
          }
          if (check === 'missing' || check === 'unproved') {
            this.logger?.info({ domain: each.domain, check }, 'single sign-on domain record gone');
          }
        } catch (error) {
          this.logger?.warn(
            { err: error, domain: each.domain },
            'single sign-on domain not checked again',
          );
        }
      }
      if (due.length < BATCH) break;
    }
    return counts;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'single sign-on domain checks sweep failed'),
    );
  }
}
