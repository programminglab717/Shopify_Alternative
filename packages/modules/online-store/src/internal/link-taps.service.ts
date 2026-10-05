import { createHash } from 'node:crypto';
import { failOne, shopProfile, type MutationResult, type TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { shopPreferencesOf } from './preferences.service.js';
import { linkTaps } from './schema.js';
import { SESSION_REPORT_LIMITS } from './session-days.service.js';

// Taps on the links of a shop's link-in-bio page (CH-07, ADR-204): each day's, in the shop's time
// zone, by where the link goes. Storefronts count them in Valkey as shoppers tap, through the
// storefront on the way to where each goes; the worker keeps each day's counts here, as it keeps
// the sessions (ADR-180).

/** Where a tapped link stands on the page now. */
export const LINK_TAP_SOURCES = ['link', 'whatsapp', 'removed'] as const;
export type LinkTapSourceValue = (typeof LINK_TAP_SOURCES)[number];

/** A link's taps over a period. */
export interface LinkTapCount {
  /** Where it goes: a path on the storefront, or an https address. */
  url: string;
  /** Its title on the page now; null for the shop's chat on WhatsApp and a link since taken off. */
  title: string | null;
  /** One of the shop's links on the page, its chat on WhatsApp, or a link since taken off. */
  source: LinkTapSourceValue;
  taps: number;
}

export interface LinkTapsReport {
  /** Every tap of the period. */
  total: number;
  /**
   * The page's links now and its chat on WhatsApp, those not tapped too, and the links since
   * taken off that were tapped: the most tapped first, then in the page's order.
   */
  links: LinkTapCount[];
}

@Injectable()
export class LinkTapsService {
  constructor(private readonly db: Database) {}

  /**
   * Keeps `day`'s taps so far, "2026-10-05" in the shop's time zone, each link's by where it goes,
   * in place of those kept before: the storefronts' counts only grow through a day.
   */
  async keep(shopId: string, day: string, taps: Readonly<Record<string, number>>): Promise<void> {
    const rows = Object.entries(taps)
      .filter(([url, count]) => url !== '' && Number.isSafeInteger(count) && count > 0)
      .map(([url, count]) => ({ shopId, day, link: linkHash(url), url, taps: count }));
    if (rows.length === 0) return;
    await this.db.tenant(shopId, (tx) =>
      tx
        .insert(linkTaps)
        .values(rows)
        .onConflictDoUpdate({
          target: [linkTaps.shopId, linkTaps.day, linkTaps.link],
          set: { taps: sql`excluded.taps`, updatedAt: sql`now()` },
        }),
    );
  }

  /**
   * A period's taps on each of the link page's links, by the day as the sessions are: the days
   * `from` and `before` fall on, in the shop's time zone, count whole.
   */
  async report(
    tenant: TenantContext,
    input: { from: Date; before: Date },
  ): Promise<MutationResult<LinkTapsReport>> {
    const span = input.before.getTime() - input.from.getTime();
    if (span <= 0) return failOne(['before'], 'INVALID', 'Before must be later than from');
    if (span > SESSION_REPORT_LIMITS.days * 86_400_000) {
      return failOne(
        ['before'],
        'INVALID',
        `A report covers at most ${SESSION_REPORT_LIMITS.days} days at a time`,
      );
    }
    const { shopId } = tenant;
    const { from, before } = input;
    return this.db.tenant(shopId, async (tx) => {
      const { timezone } = await shopProfile(tx, shopId);
      const first = sql`(${from}::timestamptz AT TIME ZONE ${timezone})::date`;
      const last = sql`((${before}::timestamptz - interval '1 microsecond') AT TIME ZONE ${timezone})::date`;
      const { rows } = await tx.execute<{ url: string; taps: number }>(sql`
        SELECT min(t.url) AS url, sum(t.taps)::int AS taps
          FROM online_store.link_taps t
         WHERE t.shop_id = ${shopId} AND t.day >= ${first} AND t.day <= ${last}
         GROUP BY t.link`);
      const counted = new Map(rows.map((row) => [row.url, row.taps]));
      const { linkPage, whatsappNumber } = await shopPreferencesOf(tx, shopId);
      // As the storefront shows them: the shop's links, then its chat on WhatsApp.
      const shown: Omit<LinkTapCount, 'taps'>[] = [
        ...linkPage.links.map((link) => ({
          url: link.url,
          title: link.title,
          source: 'link' as const,
        })),
        ...(whatsappNumber
          ? [{ url: whatsappChat(whatsappNumber), title: null, source: 'whatsapp' as const }]
          : []),
      ];
      const links = new Map<string, LinkTapCount>();
      for (const link of shown) {
        // A link on the page twice is counted once, as the first.
        if (!links.has(link.url))
          links.set(link.url, { ...link, taps: counted.get(link.url) ?? 0 });
      }
      const removed = [...counted]
        .filter(([url]) => !links.has(url))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([url, taps]): LinkTapCount => ({ url, title: null, source: 'removed', taps }));
      const all = [...links.values(), ...removed].sort((a, b) => b.taps - a.taps);
      return {
        ok: true,
        value: { total: rows.reduce((sum, row) => sum + row.taps, 0), links: all },
      };
    });
  }
}

/** The key a link's taps are kept by: SHA-256 of where it goes, in hex. */
export function linkHash(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

/** The shop's chat on WhatsApp, as its storefront's link page links it. */
function whatsappChat(number: string): string {
  return `https://wa.me/${number.replace(/\D/g, '')}`;
}
