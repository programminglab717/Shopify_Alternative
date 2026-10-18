// What Hatti asks TikTok's Business API of a shop's advertiser account (ADR-566), with the
// long-term token the shop gave it from TikTok's Marketing API: the account as TikTok names it,
// and each day's spend on each of its campaigns. TikTok's paths, codes and limits are here alone.
import type { AdAccountFacts, CampaignDay } from './ad-account-pull.js';
import type { TikTokApiOptions } from './tiktok-client.js';

/** The Business API's version, under TikTokApiOptions' base. */
const PATH = '/open_api/v1.3';

/** The most pages of a span's spend asked for, 1,000 campaign days each, before giving up on it. */
export const TIKTOK_REPORT_PAGES = 20;

/** Campaign days asked for a page, the most TikTok gives. */
const PAGE_SIZE = 1_000;

/** An advertiser account as TikTok shows it. */
export type TikTokAdvertiserFacts = AdAccountFacts;

/** What one campaign spent on a day, as TikTok reports it. */
export type TikTokCampaignDay = CampaignDay;

/**
 * What TikTok said: what was asked for, or why not. `token`: it refused the token, or the token
 * may not read the advertiser; `account`: it has no such advertiser; `busy`: it could not answer
 * now, or limits the token's requests for now; `other`: anything else.
 */
export type TikTokAdsResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'token' | 'account' | 'busy' | 'other'; message: string };

/**
 * Codes of the token, as best known from TikTok's return codes: no permission on the advertiser
 * (40001), or not allowed what was asked (40002); and the access token's own, 40101 to 40199:
 * empty, expired, revoked or wrong.
 */
const TOKEN = new Set([40001, 40002]);

/**
 * Codes that pass, as best known: the token's requests over their limits for now (40100, 51021),
 * and TikTok's own trouble (50000, 50002).
 */
const BUSY = new Set([40100, 50000, 50002, 51021]);

/** The ID as TikTok Ads Manager shows it, its digits; null for anything else. */
export function advertiserIdOf(value: string): string | null {
  const id = value.replace(/\s/g, '');
  return /^[0-9]{5,25}$/.test(id) ? id : null;
}

/** Reads shops' advertiser accounts from TikTok's Business API, v1.3 (ADR-566). */
export class TikTokAdsClient {
  constructor(private readonly options: TikTokApiOptions) {}

  /** The advertiser, as TikTok names it, if the token may read it. */
  async advertiser(
    advertiserId: string,
    token: string,
  ): Promise<TikTokAdsResult<TikTokAdvertiserFacts>> {
    const result = await this.#get<{ list?: unknown }>(
      'advertiser/info/',
      {
        advertiser_ids: JSON.stringify([advertiserId]),
        fields: JSON.stringify(['name', 'currency', 'timezone', 'status']),
      },
      token,
    );
    if (!result.ok) return result;
    const list = Array.isArray(result.value.list) ? result.value.list : [];
    const found = list.find(
      (each) => `${(each as Record<string, unknown> | null)?.advertiser_id}` === advertiserId,
    ) as Record<string, unknown> | undefined;
    if (!found) {
      return { ok: false, kind: 'account', message: 'TikTok has no such advertiser account' };
    }
    const { name, currency, timezone } = found;
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
      return { ok: false, kind: 'other', message: 'TikTok gave no currency for the advertiser' };
    }
    return {
      ok: true,
      value: {
        name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 200) : advertiserId,
        currency,
        timezone:
          typeof timezone === 'string' && timezone && timezone.length <= 100 ? timezone : null,
      },
    };
  }

  /**
   * What each of the advertiser's campaigns spent on each day from `since` to `until`, both
   * included, in the advertiser's time zone, page after page as TikTok gives them. Days a
   * campaign spent nothing on may be left out.
   */
  async spend(
    advertiserId: string,
    token: string,
    since: string,
    until: string,
  ): Promise<TikTokAdsResult<TikTokCampaignDay[]>> {
    const days: TikTokCampaignDay[] = [];
    let pages = 1;
    for (let page = 1; page <= pages; page++) {
      const result = await this.#get<{ list?: unknown; page_info?: { total_page?: unknown } }>(
        'report/integrated/get/',
        {
          advertiser_id: advertiserId,
          report_type: 'BASIC',
          data_level: 'AUCTION_CAMPAIGN',
          dimensions: JSON.stringify(['campaign_id', 'stat_time_day']),
          metrics: JSON.stringify(['spend', 'campaign_name']),
          start_date: since,
          end_date: until,
          page: String(page),
          page_size: String(PAGE_SIZE),
        },
        token,
      );
      if (!result.ok) return result;
      for (const row of Array.isArray(result.value.list) ? result.value.list : []) {
        const { dimensions, metrics } = (row ?? {}) as Record<string, Record<string, unknown>>;
        const time = dimensions?.stat_time_day;
        const spend = metrics?.spend;
        // "2026-10-17 00:00:00": the day, in the advertiser's time zone.
        const day = typeof time === 'string' ? time.slice(0, 10) : '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
        if (typeof spend !== 'string' && typeof spend !== 'number') continue;
        const name = metrics?.campaign_name;
        const id = dimensions?.campaign_id;
        days.push({
          day,
          // A campaign TikTok gives no name is its ID: never the platform's whole day.
          campaign:
            typeof name === 'string' && name.trim()
              ? name
              : typeof id === 'string' || typeof id === 'number'
                ? `${id}`
                : '',
          spend: `${spend}`,
        });
      }
      const total = Number(result.value.page_info?.total_page);
      pages = Number.isInteger(total) && total > page ? total : page;
      if (pages > TIKTOK_REPORT_PAGES) {
        return {
          ok: false,
          kind: 'other',
          message: `TikTok gave more than ${TIKTOK_REPORT_PAGES} pages of campaigns' days`,
        };
      }
    }
    return { ok: true, value: days };
  }

  /** GETs `path` with the token in a header, so that no log of addresses keeps it. */
  async #get<T>(
    path: string,
    query: Record<string, string>,
    token: string,
  ): Promise<TikTokAdsResult<T>> {
    const base = this.options.baseUrl.replace(/\/+$/, '');
    const url = `${base}${PATH}/${path}?${new URLSearchParams(query)}`;
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { 'access-token': token },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
    } catch (error) {
      return {
        ok: false,
        kind: 'busy',
        message: `TikTok could not be reached: ${(error as Error).message}`,
      };
    }
    const json = (await response.json().catch(() => null)) as {
      code?: unknown;
      message?: unknown;
      data?: T;
    } | null;
    const code = typeof json?.code === 'number' ? json.code : null;
    if (response.ok && code === 0) return { ok: true, value: json?.data ?? ({} as T) };
    const said = (
      typeof json?.message === 'string' && json.message.trim()
        ? json.message
        : `TikTok answered ${response.status}`
    )
      .trim()
      .slice(0, 500);
    if (code !== null && (TOKEN.has(code) || (code > 40_100 && code <= 40_199))) {
      return { ok: false, kind: 'token', message: `TikTok refused the token: ${said}` };
    }
    if ((code !== null && BUSY.has(code)) || !response.ok) {
      return { ok: false, kind: 'busy', message: `TikTok could not answer just now: ${said}` };
    }
    return { ok: false, kind: 'other', message: `TikTok refused it: ${said}` };
  }
}
